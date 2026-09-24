#!/usr/bin/env python3
"""Распределение остатка по площадкам (build_provision.allocate).

Та же фикстура проверяется в tests/test_site_allocation.mjs для браузерной
пересборки — обе реализации обязаны давать одинаковый результат.
"""
import copy
import importlib.util
import json
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_provision", ROOT / "build" / "build_provision.py")
BP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BP)
FIX = json.loads((ROOT / "tests" / "fixtures" / "site_allocation.json").read_text(encoding="utf-8"))


class SiteAllocationTest(unittest.TestCase):
    def test_own_site_protected_within_lead_time(self):
        need = copy.deepcopy(FIX["need"])
        out = BP.allocate(need, copy.deepcopy(FIX["stock"]), datetime.strptime(FIX["today"], "%Y-%m-%d"), FIX["leadDays"])
        got = {r["id"]: r for r in out}
        for rid, exp in FIX["expected"].items():
            with self.subTest(rid):
                for k, v in exp.items():
                    self.assertEqual(got[rid][k], v, k)

    def test_plant_site_rule(self):
        cases = {"1100": "1100", "7101": "1100", "7106": "1100", "110C": "1100", "1400": "1400", "7104": "1400",
                 "1200": "2400", "1208": "2400", "2400": "2400", "7102": "2400", "7108": "2400",
                 "1300": "1300", "7103": "1300", "7100": "", "": ""}
        for plant, site in cases.items():
            self.assertEqual(BP.plant_site(plant), site, plant)


if __name__ == "__main__":
    unittest.main()
