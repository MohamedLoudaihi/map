#!/usr/bin/env python3
"""Refresh a bounded set of public GasMap station pages for GitHub Pages.

Collects factual prices, not articles or forecasts. No private API is used.
Every station must parse successfully before the existing snapshot is replaced.
The initial snapshot was independently checked through public station pages;
the HTML parser is covered by representative offline fixtures.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone, timedelta
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import urllib.robotparser

BASE = "https://gasmap.jp"
USER_AGENT = "OkinawaFuelFinder/1.0 (bounded public station facts; GitHub Pages)"
DEFAULT_IDS = ("20437", "20465", "20414", "20433")
MAX_STATIONS = 15
MAX_BYTES = 2 * 1024 * 1024
JST = timezone(timedelta(hours=9))
FUELS = {"レギュラー": "regular", "ハイオク": "premium", "軽油": "diesel"}
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "public/data/prices.json"


class Node:
    def __init__(self, tag="", attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def text(self):
        if self.tag in {"script", "style", "noscript"}:
            return ""
        parts = [child.text() if isinstance(child, Node) else child for child in self.children]
        # Datetime attributes can establish a fuel-specific observation date.
        stamp = self.attrs.get("datetime", "") if self.tag == "time" else ""
        return " ".join([*parts, stamp]).strip()

    def nodes(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.nodes()


class Document(HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root, self.stack = Node("document"), []
        self.stack = [self.root]
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Node(tag, attrs))

    def handle_endtag(self, tag):
        for position in range(len(self.stack) - 1, 0, -1):
            if self.stack[position].tag == tag:
                del self.stack[position:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def clean(value):
    return " ".join(value.split())[:300]


def iso_timestamp(value):
    """Normalize published dates only; never substitute the download time."""
    value = value.strip()
    match = re.search(r"(20\d{2})[/-](\d{1,2})[/-](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?", value)
    if not match:
        return None
    year, month, day, hour, minute, second = match.groups()
    if hour is None:
        return datetime(int(year), int(month), int(day)).date().isoformat()
    # ISO datetimes may already carry a UTC offset.
    suffix = value[match.end():]
    offset = re.match(r"(Z|[+-]\d{2}:?\d{2})", suffix)
    zone = JST
    if offset:
        raw_offset = offset.group(1)
        if raw_offset == "Z":
            zone = timezone.utc
        else:
            digits = raw_offset[1:].replace(":", "")
            minutes = int(digits[:2]) * 60 + int(digits[2:])
            zone = timezone(timedelta(minutes=minutes * (-1 if raw_offset[0] == "-" else 1)))
    return datetime(int(year), int(month), int(day), int(hour), int(minute), int(second or 0), tzinfo=zone).isoformat(timespec="seconds")


def jsonld_objects(root):
    for node in root.nodes():
        if node.tag != "script" or node.attrs.get("type") != "application/ld+json":
            continue
        try:
            payload = json.loads("".join(child for child in node.children if isinstance(child, str)))
        except (ValueError, TypeError):
            continue
        pending = payload if isinstance(payload, list) else [payload]
        while pending:
            item = pending.pop()
            if not isinstance(item, dict):
                continue
            pending.extend(item.get("@graph", []))
            yield item


def parse_station(html, station_id):
    if not re.fullmatch(r"\d{1,9}", str(station_id)):
        raise ValueError("Invalid station ID")
    source_url = f"{BASE}/stations/{station_id}"
    root = Document(html).root
    nodes = list(root.nodes())
    headings = [node for node in nodes if node.tag == "h1"]
    if not headings or not headings[0].text():
        raise ValueError(f"{station_id}: missing station name")
    name = clean(headings[0].text())
    text = " ".join(root.text().split())
    structured = list(jsonld_objects(root))
    coords = None
    for node in nodes:
        href = node.attrs.get("href", "")
        if node.tag != "a" or "google.com/maps" not in href:
            continue
        params = urllib.parse.parse_qs(urllib.parse.urlsplit(href).query)
        coordinate_text = params.get("q", params.get("query", [""]))[0]
        match = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*", coordinate_text)
        if match:
            coords = tuple(map(float, match.groups()))
            break
    if coords is None:
        for item in structured:
            geo = item.get("geo", {})
            if isinstance(geo, dict) and "latitude" in geo and "longitude" in geo:
                coords = (float(geo["latitude"]), float(geo["longitude"]))
                break
    if not coords or not all(math.isfinite(x) for x in coords) or not (20 <= coords[0] <= 28 and 122 <= coords[1] <= 132):
        raise ValueError(f"{station_id}: missing valid Okinawa station coordinates")
    address = ""
    for item in structured:
        value = item.get("address")
        if isinstance(value, dict):
            address = clean(" ".join(str(value.get(key, "")) for key in ("addressRegion", "addressLocality", "streetAddress")))
        elif isinstance(value, str):
            address = clean(value)
        if "沖縄" in address:
            break
        address = ""
    if not address:
        match = re.search(r"📍\s*(沖縄県.*?)\s*(?:📞|電話|Google\s*マップ)", text)
        if match:
            address = clean(match.group(1))
    if not address:
        raise ValueError(f"{station_id}: missing Okinawa address")
    # Use the current-price section only: surrounding prose can contain averages,
    # historical prices, forecasts, and neighboring stations' quotes.
    match = re.search(r"現在の価格(.*?)(?=沖縄県.*?のガソリン価格|この店舗の安さ|周辺の交通|営業時間|価格推移|店舗情報)", text)
    if not match:
        raise ValueError(f"{station_id}: current price section not found")
    current = match.group(1)
    updates = re.findall(r"最終更新\s*((?:20\d{2})[/-]\d{1,2}[/-]\d{1,2}(?:[T\s]+\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)", text)
    source_update = iso_timestamp(updates[-1]) if updates else None
    if not source_update:
        raise ValueError(f"{station_id}: missing published source update date")
    matches = list(re.finditer(r"(レギュラー|ハイオク|軽油)\s*([0-9]{2,3}(?:\.[0-9]+)?)\s*円\s*/\s*[LlＬ]", current))
    prices = {}
    for index, match in enumerate(matches):
        fuel, yen = match.group(1), float(match.group(2))
        if not 20 <= yen <= 400:
            raise ValueError(f"{station_id}: implausible price")
        row = current[match.end(): matches[index + 1].start() if index + 1 < len(matches) else len(current)]
        reported = iso_timestamp(row)
        quote = {"yen": int(yen) if yen.is_integer() else yen, "reportedAt": reported or source_update,
                 "timestampKind": "reported" if reported else "source-update", "priceType": "unknown", "sourceUrl": source_url}
        # If only a fuel-specific relative age is provided, preserve it as evidence;
        # the source-update label never claims this is an observed pump timestamp.
        age = re.search(r"(\d+)\s*日前", row)
        if age and not reported:
            quote["sourceAgeDays"] = int(age.group(1))
            quote["collectedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        prices[FUELS[fuel]] = [quote]
    if not prices:
        # Bounded public price-section text helps diagnose provider markup
        # changes in Actions without logging the full page or article content.
        excerpt = current[:300]
        raise ValueError(f"{station_id}: no current fuel prices; current-price excerpt: {excerpt!r}")
    station = {"id": f"gasmap-{station_id}", "name": name, "address": address, "prefectureCode": "47",
               "latitude": coords[0], "longitude": coords[1], "sourceUrl": source_url, "prices": prices}
    return station


def fetch_text(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,text/plain"})
    with urllib.request.urlopen(request, timeout=30) as response:
        # Reject redirects outside the public provider domain.
        if urllib.parse.urlsplit(response.url).hostname not in {"gasmap.jp", "www.gasmap.jp"}:
            raise ValueError("Unexpected source redirect")
        payload = response.read(MAX_BYTES + 1)
        encoding = response.headers.get_content_charset() or "utf-8"
    if len(payload) > MAX_BYTES:
        raise ValueError("Source response exceeds 2 MiB")
    return payload.decode(encoding)


def write_snapshot(dataset, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".prices-", suffix=".json", dir=output.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(dataset, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def refresh(station_ids, output):
    if not 1 <= len(station_ids) <= MAX_STATIONS or len(set(station_ids)) != len(station_ids):
        raise ValueError("Choose 1–15 distinct station IDs")
    if any(not re.fullmatch(r"\d{1,9}", station_id) for station_id in station_ids):
        raise ValueError("Station IDs must contain digits only")
    robots = urllib.robotparser.RobotFileParser()
    robots.parse(fetch_text(f"{BASE}/robots.txt").splitlines())
    urls = [f"{BASE}/stations/{station_id}" for station_id in station_ids]
    if any(not robots.can_fetch(USER_AGENT, url) for url in urls):
        raise ValueError("Source robots policy disallows a requested page")
    delay = max(1.5, robots.crawl_delay(USER_AGENT) or robots.crawl_delay("*") or 0)
    if delay > 60:
        raise ValueError("Source crawl delay exceeds this bounded job's budget")
    stations = []
    for station_id, url in zip(station_ids, urls):
        time.sleep(delay)
        stations.append(parse_station(fetch_text(url), station_id))
    dataset = {"schemaVersion": 1, "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
               "source": {"name": "GasMap", "url": BASE, "termsUrl": f"{BASE}/terms", "kind": "public-station-price-facts",
                          "retrievedVia": "Public station HTML", "timestampNote": "Source update dates may differ from fuel observation times; payment conditions unspecified."},
               "coverage": ["47"], "stations": stations}
    write_snapshot(dataset, output)
    return dataset


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--station-ids", nargs="+", default=list(DEFAULT_IDS))
    args = parser.parse_args()
    try:
        dataset = refresh(args.station_ids, args.output)
        print(f"Updated {len(dataset['stations'])} GasMap station records: {args.output}")
        return 0
    except Exception as error:
        print(f"Price refresh failed; existing snapshot retained: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
