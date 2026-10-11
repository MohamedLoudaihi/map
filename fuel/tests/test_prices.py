"""Meaningful parser/atomicity checks using representative offline HTML.

These do not claim the current provider HTML has been integration tested.
The live updater fails without replacing the snapshot if markup changes.
"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("refresh_prices", ROOT / "scripts/refresh_prices.py")
PRICES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PRICES)
FIXTURE = (ROOT / "tests/fixtures/gasmap_station.html").read_text(encoding="utf-8")


class PriceParserTests(unittest.TestCase):
    def test_extracts_current_quotes_excluding_averages_history_and_other_stations(self):
        station = PRICES.parse_station(FIXTURE, "20437")
        self.assertEqual(station["id"], "gasmap-20437")
        self.assertEqual(station["latitude"], 26.1983999)
        self.assertEqual(station["longitude"], 127.7123084)
        self.assertIn("上間165-6", station["address"])
        self.assertEqual(set(station["prices"]), {"regular", "premium", "diesel"})
        regular = station["prices"]["regular"][0]
        self.assertEqual(regular["yen"], 156)
        self.assertEqual(regular["reportedAt"], "2026-10-10T21:00:00+09:00")
        self.assertEqual(regular["timestampKind"], "source-update")
        self.assertEqual(regular["priceType"], "unknown")

    def test_preserves_older_fuel_specific_date_instead_of_newer_station_date(self):
        premium = PRICES.parse_station(FIXTURE, "20437")["prices"]["premium"][0]
        self.assertEqual(premium["reportedAt"], "2026-10-03T09:30:00+09:00")
        self.assertEqual(premium["timestampKind"], "reported")

    def test_rejects_price_without_published_source_date(self):
        html = FIXTURE.replace("2026/10/10 21:00", "不明")
        with self.assertRaisesRegex(ValueError, "source update"):
            PRICES.parse_station(html, "20437")

    def test_relative_fuel_age_is_preserved_without_inventing_observation_time(self):
        html = FIXTURE.replace("<time datetime=\"2026-10-03T09:30:00+09:00\">2026/10/3 09:30</time>", "62日前")
        quote = PRICES.parse_station(html, "20437")["prices"]["premium"][0]
        self.assertEqual(quote["sourceAgeDays"], 62)
        self.assertEqual(quote["timestampKind"], "source-update")
        self.assertEqual(quote["reportedAt"], "2026-10-10T21:00:00+09:00")

    def test_broken_current_section_does_not_extract_nearby_prices(self):
        html = FIXTURE.replace("現在の価格", "価格未確認")
        with self.assertRaisesRegex(ValueError, "current price"):
            PRICES.parse_station(html, "20437")

    def test_missing_quotes_emit_bounded_price_section_diagnostic(self):
        html = FIXTURE.replace("円/L", "unrecognized-unit")
        with self.assertRaises(ValueError) as failure:
            PRICES.parse_station(html, "20437")
        message = str(failure.exception)
        self.assertIn("current-price excerpt:", message)
        self.assertIn("156.0", message)
        self.assertNotIn("別店舗", message)
        self.assertLess(len(message), 380)

    def test_failed_second_station_keeps_existing_snapshot_byte_for_byte(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "prices.json"
            original = b'{"previous":"verified"}\n'
            output.write_bytes(original)
            with patch.object(PRICES, "fetch_text", side_effect=["User-agent: *\nAllow: /\nDisallow: /api/", FIXTURE, "<h1>Incomplete response</h1>"]), patch.object(PRICES.time, "sleep"):
                with self.assertRaises(ValueError):
                    PRICES.refresh(["20437", "20465"], output)
            self.assertEqual(output.read_bytes(), original)

    def test_robots_denial_prevents_detail_requests_and_file_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "prices.json"
            output.write_text("prior", encoding="utf-8")
            with patch.object(PRICES, "fetch_text", return_value="User-agent: *\nDisallow: /stations/") as fetch:
                with self.assertRaisesRegex(ValueError, "robots"):
                    PRICES.refresh(["20437"], output)
                self.assertEqual(fetch.call_count, 1)
            self.assertEqual(output.read_text(encoding="utf-8"), "prior")

    def test_excessive_station_count_rejected_before_fetch(self):
        with patch.object(PRICES, "fetch_text") as fetch:
            with self.assertRaises(ValueError):
                PRICES.refresh([str(x) for x in range(16)], Path("unused.json"))
            fetch.assert_not_called()

    def test_atomic_success_writes_valid_document(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "prices.json"
            with patch.object(PRICES, "fetch_text", side_effect=["User-agent: *\nAllow: /", FIXTURE]), patch.object(PRICES.time, "sleep"):
                PRICES.refresh(["20437"], output)
            dataset = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(dataset["coverage"], ["47"])
            self.assertEqual(len(dataset["stations"]), 1)
            self.assertEqual(list(output.parent.glob(".prices-*")), [])


if __name__ == "__main__":
    unittest.main()
