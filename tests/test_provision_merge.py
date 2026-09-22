#!/usr/bin/env python3
"""PM-06 plan and fact live on sibling rows; remaining is computed after merge."""
import os, sys, tempfile, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "build"))
import build_provision as bp

def test_closed_order_disappears():
    # order 1200407027 pattern: plan row qp=1 qf=0, fact row qp=0 qf=1
    d = {
        "s": "1400", "y": "2026", "n": 4,
        "o": ["1200407027"] * 4,
        "e": ["Экскаватор электрический WK-20C №6"],
        "ei": [0, 0, 0, 0],
        "c": ["Насос", "Рычаг"],
        "ci": [0, 0, 1, 1],
        "cek": ["976494", "869271"],
        "w": ["Текущий ремонт"], "wi": [0, 0, 0, 0],
        "u": ["Комб"] * 4,
        "qp": [1, 0, 1, 0],
        "qf": [0, 1, 0, 1],
        "p": [1231017, 0, 191163, 0],
        "a": [0, 1132563, 0, 265828],
        "up": [0, 0, 0, 0], "uf": [0, 0, 0, 0],
        "od": {"1200407027": ["2026-07-24", "2026-07-24"]},
        "orr": {"1200407027": "OPEX (ремонты и ТО)"},
    }
    with tempfile.TemporaryDirectory() as td:
        json.dump(d, open(os.path.join(td, "1400_2026.json"), "w"))
        need, closed, nocode, _ = bp.load_need(td)
    assert need == [], need
    assert nocode == 0
    assert len(closed) == 2
    assert {c["code"] for c in closed} == {"976494", "869271"}
    assert all(c["qty"] == 0 and c["factQty"] == 1 for c in closed)

def test_partial_keeps_open_qty():
    d = {
        "s": "1400", "y": "2026", "n": 2,
        "o": ["1", "1"],
        "e": ["Экскаватор WK-20 №1"], "ei": [0, 0],
        "c": ["Болт"], "ci": [0, 0], "cek": ["918065"],
        "w": ["ТО"], "wi": [0, 0], "u": ["ХС", "ХС"],
        "qp": [10, 0], "qf": [0, 3],
        "p": [1000, 0], "a": [0, 250],
        "up": [0, 0], "uf": [0, 0],
        "od": {"1": ["2026-10-01"]}, "orr": {"1": "OPEX"},
    }
    with tempfile.TemporaryDirectory() as td:
        json.dump(d, open(os.path.join(td, "1400_2026.json"), "w"))
        need, closed, _, _ = bp.load_need(td)
    assert len(need) == 1
    assert closed == []
    assert need[0]["qty"] == 7
    assert need[0]["planQty"] == 10
    assert need[0]["factQty"] == 3
    assert abs(need[0]["value"] - 700) < 1e-6
    assert need[0]["method"] == "ХС"

if __name__ == "__main__":
    test_closed_order_disappears()
    test_partial_keeps_open_qty()
    print("provision merge: OK")
