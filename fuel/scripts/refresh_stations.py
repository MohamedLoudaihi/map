#!/usr/bin/env python3
"""Refresh one Japanese prefecture's public fuel stations from OpenStreetMap.

Only standard-library Python is needed. No fuel price is inferred from map data.
The default is a single Okinawa request; use a different prefecture explicitly.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request


ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_ELEMENTS = 25000
REQUEST_TIMEOUT_SECONDS = 85
SOURCE = {
    "name": "OpenStreetMap",
    "url": "https://www.openstreetmap.org/copyright",
    "license": "ODbL",
    "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
}


def prefecture_code(value: str) -> str:
    if not value.isdigit() or not 1 <= int(value) <= 47:
        raise argparse.ArgumentTypeError("Prefecture code must be 01 through 47")
    return value.zfill(2)


def build_query(code: str) -> str:
    # Administrative area avoids including other prefectures in a rectangle.
    # A server timeout and maxsize prevent unbounded public-server work.
    return (
        f'[out:json][timeout:60][maxsize:{MAX_RESPONSE_BYTES}];'
        f'area["ISO3166-2"="JP-{code}"]["admin_level"="4"]->.pref;'
        'nwr["amenity"="fuel"](area.pref);out center tags;'
    )


def fetch_overpass(code: str) -> tuple[dict, str]:
    request_body = urllib.parse.urlencode({"data": build_query(code)}).encode()
    failures = []
    # At most two requests total; no retry loop or all-Japan scan.
    for endpoint in ENDPOINTS:
        request = urllib.request.Request(
            endpoint,
            data=request_body,
            headers={
                "User-Agent": "OkinawaFuelFinder/1.0 (GitHub Pages station snapshot)",
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ValueError("Overpass response exceeded 8 MiB")
            payload = json.loads(raw)
            # Overpass sometimes returns partial data plus a timeout remark.
            if not isinstance(payload, dict) or payload.get("remark"):
                raise ValueError("Overpass returned an incomplete result")
            if not isinstance(payload.get("elements"), list) or not payload["elements"]:
                raise ValueError("Overpass returned no station elements")
            return payload, endpoint
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            failures.append(f"{endpoint}: {error}")
    raise RuntimeError("Station refresh failed; existing snapshot retained. " + "; ".join(failures))


def clean_text(value: object, limit: int = 250) -> str:
    return " ".join(str(value).split())[:limit] if isinstance(value, str) else ""


def make_address(tags: dict) -> str:
    full = clean_text(tags.get("addr:full"))
    if full:
        return full
    parts = [
        clean_text(tags.get(key))
        for key in ("addr:province", "addr:city", "addr:suburb", "addr:street", "addr:housenumber")
    ]
    return " ".join(part for part in parts if part)


def normalise_stations(payload: dict, code: str) -> list[dict]:
    elements = payload.get("elements")
    if not isinstance(elements, list) or len(elements) > MAX_ELEMENTS:
        raise ValueError("Station payload has an invalid or excessive element count")
    stations: dict[str, dict] = {}
    for element in elements:
        if not isinstance(element, dict):
            continue
        tags = element.get("tags", {})
        if not isinstance(tags, dict) or tags.get("amenity") != "fuel":
            continue
        # Stations with explicit restricted access cannot be recommended to drivers.
        if tags.get("access") in {"no", "private", "military"}:
            continue
        if any(tags.get(key) == "yes" for key in ("disused", "abandoned", "demolished")):
            continue
        osm_type = element.get("type")
        osm_id = element.get("id")
        if osm_type not in {"node", "way", "relation"} or not isinstance(osm_id, int) or osm_id <= 0:
            continue
        centre = element if osm_type == "node" else element.get("center", {})
        if not isinstance(centre, dict):
            continue
        lat, lon = centre.get("lat"), centre.get("lon")
        if (
            isinstance(lat, bool) or isinstance(lon, bool)
            or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float))
            or not math.isfinite(lat) or not math.isfinite(lon)
            or not 20 <= lat <= 46 or not 122 <= lon <= 154
        ):
            continue
        brand = clean_text(tags.get("brand"))
        name = clean_text(tags.get("name:en")) or clean_text(tags.get("name"))
        name = name or clean_text(tags.get("operator")) or brand or "Unnamed fuel station"
        station = {
            "id": f"osm-{osm_type}-{osm_id}",
            "name": name,
            "address": make_address(tags),
            "prefectureCode": code,
            "latitude": lat,
            "longitude": lon,
            "sourceUrl": f"https://www.openstreetmap.org/{osm_type}/{osm_id}",
            "prices": {},
        }
        for output_key, osm_key in (
            ("brand", "brand"),
            ("nameJa", "name:ja"),
            ("openingHours", "opening_hours"),
            ("selfService", "self_service"),
            ("phone", "phone"),
        ):
            value = clean_text(tags.get(osm_key))
            if value:
                station[output_key] = value
        stations[station["id"]] = station
    if not stations:
        raise ValueError("No valid public station coordinates; existing snapshot retained")
    return sorted(stations.values(), key=lambda station: (station["name"], station["id"]))


def make_dataset(payload: dict, code: str, endpoint: str) -> dict:
    stations = normalise_stations(payload, code)
    return {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": {**SOURCE, "retrievedVia": endpoint},
        "coverage": {"prefectureCode": code, "kind": "mapped-stations", "complete": False},
        "stations": stations,
    }


def write_snapshot(dataset: dict, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    # Do not erase the last successful snapshot if a request or validation failed.
    fd, temporary = tempfile.mkstemp(prefix=".stations-", suffix=".json", dir=output.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(dataset, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefecture-code", type=prefecture_code, default="47")
    parser.add_argument("--output", type=Path, default=Path("public/data/stations.json"))
    parser.add_argument("--from-file", type=Path, help="Read a saved Overpass JSON response instead of requesting the network")
    args = parser.parse_args()
    try:
        if args.from_file:
            if args.from_file.stat().st_size > MAX_RESPONSE_BYTES:
                raise ValueError("Input exceeds 8 MiB")
            payload = json.loads(args.from_file.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or payload.get("remark"):
                raise ValueError("Invalid or incomplete Overpass input")
            endpoint = "saved-overpass-response"
        else:
            payload, endpoint = fetch_overpass(args.prefecture_code)
        dataset = make_dataset(payload, args.prefecture_code, endpoint)
        write_snapshot(dataset, args.output)
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f"Wrote {len(dataset['stations'])} public mapped stations to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
