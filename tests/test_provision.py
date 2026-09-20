#!/usr/bin/env python3
import importlib.util
import json
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_provision", ROOT / "build" / "build_provision.py")
BP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BP)


class ProvisionAllocationTest(unittest.TestCase):
    def test_covered_verdict_has_no_uncovered_quantity(self):
        payload = json.loads((ROOT / "data" / "provision.json").read_text(encoding="utf-8"))
        for item in payload["items"]:
            if item["verdict"] == "covered":
                self.assertLessEqual(sum(item[k] for k in ("gap", "late", "undated")), 1e-9, item["code"])

    def test_overdue_open_purchase_is_not_on_time(self):
        need = [{"date": "2026-12-01", "code": "A", "qty": 5, "value": 500}]
        stock = {"A": {"availQty": 0, "purchase": {"byMonth": {"2026-07": 5}}}}
        row = BP.allocate(need, stock, datetime(2026, 9, 14))[0]
        self.assertEqual(row["fromBuy"], 0)
        self.assertEqual(row["undated"], 5)

    def test_quantity_reconciliation_in_published_data(self):
        payload = json.loads((ROOT / "data" / "provision.json").read_text(encoding="utf-8"))
        for item in payload["items"]:
            allocated = sum(item[k] for k in ("fromStock", "fromBuy", "late", "undated", "gap"))
            self.assertAlmostEqual(item["needQty"], allocated, places=6, msg=item["code"])

    def test_source_limits_in_published_data(self):
        payload = json.loads((ROOT / "data" / "provision.json").read_text(encoding="utf-8"))
        for item in payload["items"]:
            self.assertLessEqual(item["fromStock"], item["availQty"] + 1e-6, item["code"])
            used_purchase = item["fromBuy"] + item["late"] + item["undated"]
            self.assertLessEqual(used_purchase, item["openQty"] + 1e-6, item["code"])


if __name__ == "__main__":
    unittest.main()
