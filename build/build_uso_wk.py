#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Срез МТР подрядчика (УСО) по парку WK.

Источник — витрина TOPO `uso_mtr.json`, собранная из
`rawdata/УСО/МТР УСО {год} all.xlsx` (лист PM-06). Это не остаток склада
Полюса: это материалы, которые подрядчик (АО «Развитие» и субчики)
ставит в заказ ТОРО. Коды 7101–7104 — заводы подрядчика, заказчик
(балансовая единица) — Полюс.

Запуск:
  python3 build/build_uso_wk.py <uso_mtr.json> <out_dir>
"""
import json, os, re, sys
from collections import defaultdict

WK_RE = re.compile(r"WK-?\d", re.I)
N = lambda x: x if isinstance(x, (int, float)) else 0


def dec(dct, i):
    if isinstance(i, int) and 0 <= i < len(dct):
        return dct[i]
    return i


def main():
    if len(sys.argv) < 3:
        print("usage: build_uso_wk.py <uso_mtr.json> <out_dir>", file=sys.stderr)
        sys.exit(1)
    src, out_dir = sys.argv[1:3]
    os.makedirs(out_dir, exist_ok=True)
    U = json.load(open(src, encoding="utf-8"))
    D, O, R = U["dict"], U["ord"], U["row"]
    meta = U.get("meta") or {}

    wk_eo = {i for i, n in enumerate(D["eo"]) if n and WK_RE.search(str(n))}
    wk_ord = [i for i, eo in enumerate(O["eo"]) if eo in wk_eo]
    wk_set = set(wk_ord)

    by_order = defaultdict(list)
    for j, oi in enumerate(R["o"]):
        if oi not in wk_set:
            continue
        by_order[oi].append({
            "code": str(dec(D["ek"], R["ek"][j]) or ""),
            "name": dec(D["nm"], R["n"][j]) or "",
            "qp": N(R["qp"][j]), "qf": N(R["qf"][j]),
            "p": N(R["p"][j]), "a": N(R["a"][j]),
        })

    SITE_REGION = (meta.get("siteRegion") or
                   {"7101": "1100", "7102": "1200", "7103": "1300", "7104": "1400"})
    SITE_LABELS = meta.get("siteLabels") or {}

    orders = []
    for i in wk_ord:
        plant = str(dec(D["st"], O["s"][i]) or "")
        site = SITE_REGION.get(plant, plant)
        unit = dec(D["eo"], O["eo"][i]) or ""
        m = WK_RE.search(unit)
        model = ""
        if m:
            tail = re.search(r"WK-?(\d+C?)", unit, re.I)
            model = "WK-" + tail.group(1).upper() if tail else ""
        lines = by_order.get(i, [])
        open_lines = [x for x in lines if x["qp"] > x["qf"] + 1e-9]
        orders.append({
            "order": str(O["o"][i]),
            "plant": plant,
            "site": site,
            "siteName": SITE_LABELS.get(site, site),
            "year": str(dec(D["yr"], O["y"][i]) or ""),
            "unit": unit,
            "model": model,
            "method": dec(D["mu"], O["mu"][i]) or "",
            "kind": dec(D["rs"], O["rs"][i]) or "",
            "work": dec(D["wk"], O["wk"][i]) or "",
            "be": dec(D["be"], O["be"][i]) or "",
            "month": dec(D["mo"], O["mo"][i]) or "",
            "closed": len(lines) > 0 and len(open_lines) == 0,
            "planValue": round(sum(x["p"] for x in lines), 2),
            "factValue": round(sum(x["a"] for x in lines), 2),
            "openValue": round(sum(x["p"] * max(x["qp"] - x["qf"], 0) / x["qp"]
                                   for x in open_lines if x["qp"]), 2),
            "lines": lines,
        })

    result = {
        "meta": {
            "src": "TOPO uso_mtr.json ← rawdata/УСО/МТР УСО {год} all.xlsx",
            "asOf": meta.get("asOf"),
            "note": meta.get("note"),
            "siteRegion": SITE_REGION,
            "siteLabels": SITE_LABELS,
            "orders": len(orders),
            "rows": sum(len(o["lines"]) for o in orders),
            "closedOrders": sum(1 for o in orders if o["closed"]),
            "openValue": round(sum(o["openValue"] for o in orders), 2),
            "planValue": round(sum(o["planValue"] for o in orders), 2),
            "factValue": round(sum(o["factValue"] for o in orders), 2),
        },
        "orders": sorted(orders, key=lambda o: (o["month"] or "9999", o["site"], o["order"])),
    }
    out = os.path.join(out_dir, "uso_wk.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    m = result["meta"]
    print(f"УСО WK: заказов {m['orders']}, строк {m['rows']}, "
          f"закрытых {m['closedOrders']}; план {m['planValue']/1e6:.1f} млн ₽, "
          f"факт {m['factValue']/1e6:.1f} млн ₽, открыто {m['openValue']/1e6:.1f} млн ₽")


if __name__ == "__main__":
    main()
