#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сводка ремонтов WK 2022-2027 из детализации TOPO («заказ → единица →
материал», data/<площадка>_<год>.json). Даёт свод по единице, году,
виду работ и материалу — раздел «Ремонты» портала.

Выход: data/repairs.json

Запуск:
  python3 build/build_repairs.py <topo_data_dir> <ekmtr_wk.json> <out_dir>
"""
import sys, os, re, glob, json
from collections import defaultdict

N = lambda x: x if isinstance(x, (int, float)) else 0
WK_RE = re.compile(r"WK-?\d", re.I)


def main():
    if len(sys.argv) < 4:
        print("usage: build_repairs.py <topo_data_dir> <ekmtr_wk.json> <out_dir>", file=sys.stderr)
        sys.exit(1)
    topo_dir, ekmtr_path, out_dir = sys.argv[1:4]
    os.makedirs(out_dir, exist_ok=True)

    wk_names = {e["code"]: e["name"] for e in json.load(open(ekmtr_path, encoding="utf-8"))["items"]}

    by_site_year = defaultdict(lambda: {"p": 0.0, "a": 0.0, "qp": 0.0, "qf": 0.0, "rows": 0})
    by_unit = defaultdict(lambda: defaultdict(float))       # unit -> year -> факт
    by_work = defaultdict(float)                             # вид работ -> факт
    by_mat = defaultdict(lambda: {"v": 0.0, "n": "", "isWk": False})  # код -> сумма факта

    files = sorted(glob.glob(os.path.join(topo_dir, "*_20*.json")))
    for fp in files:
        d = json.load(open(fp, encoding="utf-8"))
        site, year = d["s"], d["y"]
        wk_idx = {i for i, n in enumerate(d["e"]) if WK_RE.search(n)}
        if not wk_idx:
            continue
        ei, ci, p, a, qp, qf, wi, w, cek = (d["ei"], d["ci"], d["p"], d["a"],
                                              d["qp"], d["qf"], d["wi"], d["w"], d["cek"])
        for i in range(d["n"]):
            if ei[i] not in wk_idx:
                continue
            key = (site, year)
            t = by_site_year[key]
            t["p"] += N(p[i]); t["a"] += N(a[i]); t["qp"] += N(qp[i]); t["qf"] += N(qf[i]); t["rows"] += 1
            by_unit[d["e"][ei[i]]][str(year)] += N(a[i])
            by_work[w[wi[i]]] += N(a[i])
            code = cek[ci[i]]
            if code:
                m = by_mat[code]
                m["v"] += N(a[i]); m["n"] = wk_names.get(code, "")
                m["isWk"] = code in wk_names
        del d

    result = {
        "meta": {
            "src": "TOPO data/<площадка>_<год>.json", "files": len(files),
            "planTotal": round(sum(t["p"] for t in by_site_year.values()), 2),
            "factTotal": round(sum(t["a"] for t in by_site_year.values()), 2),
            "rowsTotal": sum(t["rows"] for t in by_site_year.values()),
        },
        "bySiteYear": [{"site": s, "year": y, **{k: round(v, 2) if isinstance(v, float) else v
                                                  for k, v in t.items()}}
                       for (s, y), t in sorted(by_site_year.items())],
        "byUnit": [{"unit": u, "byYear": {yy: round(vv, 2) for yy, vv in ys.items()},
                    "total": round(sum(ys.values()), 2)}
                   for u, ys in sorted(by_unit.items(), key=lambda x: -sum(x[1].values()))],
        "byWork": sorted([{"work": w, "value": round(v, 2)} for w, v in by_work.items()],
                          key=lambda x: -x["value"]),
        "byMaterial": sorted([{"code": c, "name": m["n"], "value": round(m["v"], 2), "isWkPart": m["isWk"]}
                               for c, m in by_mat.items()], key=lambda x: -x["value"])[:200],
    }
    with open(os.path.join(out_dir, "repairs.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    m = result["meta"]
    print(f"файлов: {m['files']}  строк WK: {m['rowsTotal']}")
    print(f"план: {m['planTotal']/1e6:.1f} млн ₽  факт: {m['factTotal']/1e6:.1f} млн ₽")
    print(f"единиц в своде: {len(by_unit)}  материалов: {len(by_mat)}")


if __name__ == "__main__":
    main()
