#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_provision", ROOT / "build" / "build_provision.py")
BP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BP)


class ProvisionAllocationTest(unittest.TestCase):
    def test_partial_fact_becomes_remaining_need(self):
        payload = {
            "e": ["Экскаватор WK-20 №1"], "n": 1, "ei": [0],
            "qp": [10], "qf": [4], "p": [1000], "ci": [0],
            "cek": ["100"], "c": ["Деталь"], "o": ["77"],
            "s": "2400", "y": 2026, "od": {"77": ["2026-12-01"]},
            "orr": {"77": "ТО"}, "wi": [0], "w": ["Ремонт"],
        }
        with tempfile.TemporaryDirectory() as td:
            Path(td, "sample_2026.json").write_text(json.dumps(payload), encoding="utf-8")
            rows, _, _, _ = BP.load_need(td)
        self.assertEqual(rows[0]["qty"], 6)
        self.assertEqual(rows[0]["value"], 600)

    def test_negative_fact_without_plan_does_not_create_need(self):
        payload = {
            "e": ["Экскаватор WK-20 №1"], "n": 1, "ei": [0],
            "qp": [0], "qf": [-14], "p": [0], "a": [-693582], "ci": [0],
            "cek": ["961124"], "c": ["Коронка"], "o": ["77"],
            "s": "1400", "y": 2026, "od": {"77": ["2025-12-21"]},
            "orr": {"77": "OPEX"}, "wi": [0], "w": ["Ремонт"],
        }
        with tempfile.TemporaryDirectory() as td:
            Path(td, "sample_2026.json").write_text(json.dumps(payload), encoding="utf-8")
            rows, closed, _, _ = BP.load_need(td)
        self.assertEqual(rows, [])
        self.assertEqual(closed, [])

    def test_remaining_need_never_exceeds_positive_plan(self):
        payload = {
            "e": ["Экскаватор WK-20 №1"], "n": 1, "ei": [0],
            "qp": [10], "qf": [-2], "p": [1000], "a": [-200], "ci": [0],
            "cek": ["100"], "c": ["Деталь"], "o": ["77"],
            "s": "2400", "y": 2026, "od": {"77": ["2026-12-01"]},
            "orr": {"77": "ТО"}, "wi": [0], "w": ["Ремонт"],
        }
        with tempfile.TemporaryDirectory() as td:
            Path(td, "sample_2026.json").write_text(json.dumps(payload), encoding="utf-8")
            rows, _, _, _ = BP.load_need(td)
        self.assertEqual(rows[0]["qty"], 10)
        self.assertEqual(rows[0]["value"], 1000)

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

    def test_order_totals_reconcile_with_lines(self):
        payload = json.loads((ROOT / "data" / "provision.json").read_text(encoding="utf-8"))
        for order in payload["orders"]:
            self.assertAlmostEqual(order["value"], sum(x["value"] for x in order["lines"]), places=1)
            for key in ("fromStock", "fromBuy", "late", "undated", "gap"):
                self.assertAlmostEqual(order[key + "Qty"], sum(x[key] for x in order["lines"]), places=2)


if __name__ == "__main__":
    unittest.main()


class YearStatusTest(unittest.TestCase):
    """Статус периода: «план» / «открыт» / «закрыт» — правило TOPO."""

    @staticmethod
    def _dir(td, years):
        for name, payload in years.items():
            Path(td, name).write_text(json.dumps(payload), encoding="utf-8")
        return BP.year_status(td)

    @staticmethod
    def _year(y, plan, fact, uso_plan=0, uso_fact=0):
        return {"y": y, "s": "1100", "n": 1, "e": [], "ei": [],
                "p": [plan], "a": [fact], "up": [uso_plan], "uf": [uso_fact]}

    def test_year_without_any_fact_is_plan(self):
        with tempfile.TemporaryDirectory() as td:
            st = self._dir(td, {"1100_2026.json": self._year(2026, 100, 90),
                                "1100_2027.json": self._year(2027, 100, 0)})
        # Ненаступивший год не «сорван»: по нему просто нет факта.
        self.assertEqual(st["2027"]["status"], "план")

    def test_last_year_with_fact_below_threshold_is_open(self):
        with tempfile.TemporaryDirectory() as td:
            st = self._dir(td, {"1100_2025.json": self._year(2025, 100, 90),
                                "1100_2026.json": self._year(2026, 100, 40)})
        self.assertEqual(st["2025"]["status"], "закрыт")
        self.assertEqual(st["2026"]["status"], "открыт")

    def test_high_execution_closes_even_the_frontier_year(self):
        with tempfile.TemporaryDirectory() as td:
            st = self._dir(td, {"1100_2026.json": self._year(2026, 100, 80)})
        self.assertEqual(st["2026"]["status"], "закрыт")

    def test_earlier_year_with_low_execution_is_closed_not_open(self):
        # Низкое исполнение в прошлом году — результат, а не незавершённость.
        with tempfile.TemporaryDirectory() as td:
            st = self._dir(td, {"1100_2025.json": self._year(2025, 100, 10),
                                "1100_2026.json": self._year(2026, 100, 20)})
        self.assertEqual(st["2025"]["status"], "закрыт")
        self.assertEqual(st["2026"]["status"], "открыт")

    def test_uso_fact_alone_counts_as_execution(self):
        with tempfile.TemporaryDirectory() as td:
            st = self._dir(td, {"1100_2026.json": self._year(2026, 0, 0, 100, 90)})
        self.assertEqual(st["2026"]["status"], "закрыт")
        self.assertAlmostEqual(st["2026"]["factShare"], 0.9)


class SapStatusRulesTest(unittest.TestCase):
    """Правила статусов SAP (PM06_STATUSES.md)."""

    @staticmethod
    def _row(order, code="100", qty=4.0, value=400.0, year=2026):
        return {"order": order, "year": year, "code": code, "qty": qty, "value": value,
                "date": "2026-10-01", "site": "1100", "unit": "WK-35 №1"}

    @staticmethod
    def _meta(status, ppm=None):
        return {"status": status, "ppm": ppm or {}, "sources": []}

    @staticmethod
    def _st(phase, usr="#", sys_="#", orig=False):
        return {"phase": phase, "usr": usr, "sys": sys_, "kind": "APP1", "copyOriginal": orig}

    def test_stage_follows_phase_and_user_statuses(self):
        cases = [(self._st(0), "noOrder"), (self._st(1, "ПЛАН ГОД"), "approving"),
                 (self._st(1, "СГГС ГОД"), "approved"), (self._st(2), "released"),
                 (self._st(2, "ПРНТ"), "inWork"), (self._st(2, sys_="ДЕБЛ ЧПДТ"), "inWork"),
                 (self._st(2, "ПРНТ ФХСМ"), "factDone"), (self._st(3), "techClosed"),
                 (self._st(3, "НПСЗ"), "rejected"), (self._st(3, "ПРСЗ"), "accepted"),
                 (self._st(3, "ПРСЗ ВСБЕ"), "billed"), (self._st(4, "ВСБЕ"), "closed"),
                 (None, "unknown")]
        for st, expected in cases:
            self.assertEqual(BP.order_stage(st), expected)

    def test_released_order_with_posted_fact_is_in_work(self):
        # списание МТР или счёт УСО — работа идёт, даже без подтверждений
        self.assertEqual(BP.order_stage(self._st(2), fact=100.0), "inWork")
        self.assertEqual(BP.order_stage(self._st(2), fact=0.0), "released")

    def test_plan_position_without_order_is_dropped_entirely(self):
        meta = self._meta({("2026", "110000000001"): self._st(0)})
        need, closed, removed = BP.apply_sap_rules([self._row("110000000001")], [], meta)
        self.assertEqual((need, closed), ([], []))
        self.assertEqual(removed["planPosition"]["value"], 400.0)

    def test_order_closed_in_sap_has_no_remaining_need(self):
        meta = self._meta({("2026", "1"): self._st(3, "ПРСЗ"), ("2026", "2"): self._st(4)})
        need, closed, removed = BP.apply_sap_rules([self._row("1"), self._row("2")], [], meta)
        self.assertEqual(need, [])
        self.assertEqual([r["qty"] for r in closed], [0.0, 0.0])
        self.assertEqual(removed["closedInSap"]["orders"], 2)

    def test_migration_original_plan_is_not_counted_twice(self):
        meta = self._meta({("2026", "1"): self._st(1, "СГГС", orig=True),
                           ("2026", "2"): self._st(1, "СГГС")})
        need, closed, removed = BP.apply_sap_rules([self._row("1"), self._row("2")], [], meta)
        self.assertEqual([r["order"] for r in need], ["2"])
        self.assertEqual(closed[0]["sapReason"], "migrationCopy")
        self.assertEqual(removed["migrationCopy"]["value"], 400.0)

    def test_open_order_keeps_need_and_gets_ppm_flag(self):
        meta = self._meta({("2026", "1"): self._st(1, "СГГС")},
                          {("2026", "1", "100"): "onRelease"})
        need, _, _ = BP.apply_sap_rules([self._row("1"), self._row("1", code="200")], [], meta)
        self.assertEqual([r["ppm"] for r in need], ["onRelease", "immediate"])
        self.assertEqual(need[0]["stage"], "approved")

    def test_order_missing_from_status_export_is_kept(self):
        need, _, _ = BP.apply_sap_rules([self._row("9")], [], self._meta({}))
        self.assertEqual(len(need), 1)
        self.assertEqual(need[0]["stage"], "unknown")

    def test_never_flag_is_not_covered_by_purchase(self):
        stock = {"100": {"availQty": 1, "purchase": {"byMonth": {"2026-09": 10}}}}
        rows = [dict(self._row("1"), ppm="never"), dict(self._row("2"), ppm="immediate")]
        out = BP.allocate(rows, stock, datetime(2026, 9, 1))
        never = next(r for r in out if r["order"] == "1")
        normal = next(r for r in out if r["order"] == "2")
        self.assertEqual(never["fromBuy"] + never["late"] + never["undated"], 0)
        self.assertEqual(never["fromStock"] + never["gap"], 4)
        self.assertEqual(normal["fromBuy"], 4)

    def test_pm06_meta_files_are_read_by_year_and_order(self):
        with tempfile.TemporaryDirectory() as td:
            Path(td, "order_status").mkdir()
            Path(td, "ppm_flags").mkdir()
            Path(td, "order_status", "1100_2026.json").write_text(json.dumps({
                "meta": {"source": "M06_1100_2026"}, "sys": ["ДЕБЛ"], "usr": ["ПРНТ"],
                "kind": ["APP1"], "o": {"55": [0, 0, 0, 2, 1]}}), encoding="utf-8")
            Path(td, "ppm_flags", "1100_2026.json").write_text(json.dumps({
                "meta": {}, "o": {"55": {"100": 1}}}), encoding="utf-8")
            meta = BP.load_pm06_meta(td)
        self.assertEqual(meta["status"][("2026", "55")]["phase"], 2)
        self.assertTrue(meta["status"][("2026", "55")]["copyOriginal"])
        self.assertEqual(meta["ppm"][("2026", "55", "100")], "never")
