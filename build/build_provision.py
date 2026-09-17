#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Обеспеченность плана 2026-2027: открытые заказы ТОиР (строки плана без
факта) по номенклатуре WK против ДОСТУПНОГО остатка (за вычетом
ограниченного и блокированного запаса, см. build_stock.py).

Выход: data/provision.json

Запуск:
  python3 build/build_provision.py <topo_data_dir> <ekmtr_wk.json> \
      <stock.json> <out_dir>
"""
import sys, os, re, glob, json
from collections import defaultdict

N = lambda x: x if isinstance(x, (int, float)) else 0
WK_RE = re.compile(r"WK-?\d", re.I)


def main():
    if len(sys.argv) < 5:
        print("usage: build_provision.py <topo_data_dir> <ekmtr_wk.json> "
              "<stock.json> <out_dir>", file=sys.stderr)
        sys.exit(1)
    topo_dir, ekmtr_path, stock_path, out_dir = sys.argv[1:5]
    os.makedirs(out_dir, exist_ok=True)

    wk_names = {e["code"]: e["name"] for e in json.load(open(ekmtr_path, encoding="utf-8"))["items"]}
    stock = {i["code"]: i for i in json.load(open(stock_path, encoding="utf-8"))["items"]}

    need = defaultdict(float); needq = defaultdict(float)
    orders = set(); lines = 0
    nocode_rows = 0; nocode_v = 0.0

    files = sorted(glob.glob(os.path.join(topo_dir, "*_202[67].json")))
    for fp in files:
        d = json.load(open(fp, encoding="utf-8"))
        wk_idx = {i for i, n in enumerate(d["e"]) if WK_RE.search(n)}
        if not wk_idx:
            continue
        for i in range(d["n"]):
            if d["ei"][i] not in wk_idx:
                continue
            if N(d["a"][i]) > 0 or N(d["qf"][i]) > 0:
                continue  # уже исполнено — не потребность
            code = d["cek"][d["ci"][i]]
            v = N(d["p"][i])
            if not code:
                nocode_rows += 1; nocode_v += v
                continue
            need[code] += v; needq[code] += N(d["qp"][i])
            orders.add(d["o"][i]); lines += 1
        del d

    # Обеспеченность считаем только по номенклатуре WK (код входит в ППЗ
    # 3.1.2.7) — только для неё построен stock.json. Прочие материалы,
    # которые единицы WK тоже расходуют (ГСМ, общепромышленный крепёж,
    # общие МТР), в этот остаток не входят — по ним статус не определяем,
    # а не считаем дефицитом.
    items = []
    full_cov = part_cov = zero_cov = 0
    full_v = part_v = zero_v = 0.0
    other_n = 0; other_v = 0.0
    for code, v in need.items():
        nq = needq[code]
        if code not in wk_names:
            other_n += 1; other_v += v
            items.append({
                "code": code, "name": "", "needValue": round(v, 2), "needQty": round(nq, 3),
                "availQty": None, "availValue": None,
                "status": "notWkPart", "restricted": False,
            })
            continue
        s = stock.get(code)
        avail_q = s["availQty"] if s else 0.0
        avail_v = s["availValue"] if s else 0.0
        restricted = s["fullyRestricted"] if s else False
        if avail_q <= 0:
            status = "none"; zero_cov += 1; zero_v += v
        elif avail_q >= nq:
            status = "full"; full_cov += 1; full_v += v
        else:
            status = "partial"; part_cov += 1; part_v += v
        items.append({
            "code": code, "name": wk_names.get(code, ""),
            "needValue": round(v, 2), "needQty": round(nq, 3),
            "availQty": avail_q, "availValue": avail_v,
            "status": status, "restricted": restricted,
        })
    items.sort(key=lambda x: -x["needValue"])

    total = sum(need.values())
    wk_total = full_v + part_v + zero_v
    result = {
        "meta": {
            "src": "TOPO data/<площадка>_<год>.json, годы 2026-2027",
            "orders": len(orders), "lines": lines,
            "positionsTotal": len(need), "needTotal": round(total, 2),
            "noCodeRows": nocode_rows, "noCodeValue": round(nocode_v, 2),
            "wkPartsTotal": round(wk_total, 2),
            "notWkParts": {"n": other_n, "value": round(other_v, 2)},
            "fullCoverage": {"n": full_cov, "value": round(full_v, 2)},
            "partialCoverage": {"n": part_cov, "value": round(part_v, 2)},
            "noCoverage": {"n": zero_cov, "value": round(zero_v, 2)},
        },
        "items": items,
    }
    with open(os.path.join(out_dir, "provision.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    m = result["meta"]
    print(f"заказов: {m['orders']}  строк: {m['lines']}  позиций всего: {m['positionsTotal']}  потребность: {total/1e6:.0f} млн ₽")
    print(f"  из них номенклатура WK: {full_cov+part_cov+zero_cov} позиций, {wk_total/1e6:.0f} млн ₽")
    print(f"    полностью: {full_cov} ({full_v/1e6:.0f} млн ₽)  частично: {part_cov} ({part_v/1e6:.0f} млн ₽)  нет: {zero_cov} ({zero_v/1e6:.0f} млн ₽)")
    print(f"  прочие материалы (не WK-номенклатура, остаток не отслеживается здесь): {other_n} поз., {other_v/1e6:.0f} млн ₽")


if __name__ == "__main__":
    main()
