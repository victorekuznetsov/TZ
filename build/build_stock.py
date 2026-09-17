#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Строит запасы, ограниченный запас и закупки по номенклатуре WK.

Источники (все — свежие выгрузки SAP из репозитория for_update):
  Остатки_*.xlsx                          — BW MM-M03, остаток по складам
  Запас с ограниченным использованием*.xlsx — позиции, которые ЕСТЬ на
                                              складе, но НЕЛЬЗЯ взять в ремонт
  Закупка ALL*.xlsx                       — заявки и заказы на поставку

Правило: ограниченный и блокированный запас ВЫЧИТАЕТСЯ из остатка и
подсвечивается отдельным статусом. Позиция, у которой весь остаток
ограничен, в разделе «Обеспеченность» считается дефицитом, а не наличием.

Все суммы — в рублях (₽), как в самой выгрузке SAP. Юани сюда не попадают.

Выход: data/stock.json

Запуск:
  python3 build/build_stock.py <ekmtr_wk.json> <stock.xlsx> \
      <restricted.xlsx> <purchase.xlsx> <out_dir>
"""
import sys, os, json
import openpyxl
from collections import defaultdict

N = lambda x: x if isinstance(x, (int, float)) else 0


def col_index(hdr, needle):
    for i, h in enumerate(hdr):
        if h and needle.lower() in str(h).lower():
            return i
    return None


def parse_stock(path, wk_codes):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb["MM-M03"]
    it = ws.iter_rows(values_only=True)
    hdr = None
    rows_total = 0
    q = defaultdict(float); v = defaultdict(float)
    by_wh = defaultdict(lambda: defaultdict(float))  # code -> warehouse -> qty
    for i, r in enumerate(it):
        if i < 11:
            continue
        if hdr is None:
            hdr = [str(c).strip() if c else "" for c in r]
            mi = col_index(hdr, "Материал")
            qi = col_index(hdr, "Склад") and len(hdr) - 1  # склад — предпоследняя перед RUB, см. ниже
            continue
        rows_total += 1
        code = r[9]  # Материал — 10-я колонка (индекс 9) по разобранной шапке
        if not code:
            continue
        code = str(code).strip()
        if code not in wk_codes:
            continue
        val = N(r[20])
        q[code] += N(r[19])
        v[code] += val
        wh = str(r[18]) if r[18] else "?"
        by_wh[code][wh] += N(r[19])
    wb.close()
    return {"rowsTotal": rows_total, "q": dict(q), "v": dict(v),
            "byWarehouse": {k: dict(v2) for k, v2 in by_wh.items()}}


def parse_restricted(path, wk_codes):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    it = ws.iter_rows(values_only=True)
    hdr = [str(c).strip() if c else "" for c in next(it)]
    mi = col_index(hdr, "Материал")
    ri = col_index(hdr, "ЗапОгрИспользования"); rv = col_index(hdr, "Ст-ть/огр")
    bl = col_index(hdr, "Блокированный запас"); blv = col_index(hdr, "Ст-ть/блок. запаса")
    qc = col_index(hdr, "Контроль качества"); qcv = col_index(hdr, "Ст-ть/контр")
    rows_total = 0
    restr_q = defaultdict(float); restr_v = defaultdict(float)
    for r in it:
        rows_total += 1
        code = r[mi]
        if not code:
            continue
        code = str(code).strip()
        if code not in wk_codes:
            continue
        rq = N(r[ri]); rv_ = N(r[rv])
        bq = N(r[bl]); bv = N(r[blv])
        qq = N(r[qc]); qv = N(r[qcv])
        restr_q[code] += rq + bq + qq
        restr_v[code] += rv_ + bv + qv
    wb.close()
    return {"rowsTotal": rows_total, "q": dict(restr_q), "v": dict(restr_v)}


def parse_purchase(path, wk_codes):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    it = ws.iter_rows(values_only=True)
    hdr = [str(c).strip() if c else "" for c in next(it)]
    ci = col_index(hdr, "Код услуги")
    li = col_index(hdr, "еще поставить")
    ti = col_index(hdr, "Количество в пути")
    vi = col_index(hdr, "Общая стоимость")
    di = col_index(hdr, "Дата поставки")
    si = col_index(hdr, "Имя поставщика")
    cu = col_index(hdr, "Валюта")
    rq = col_index(hdr, "Дата заявки")
    qn = col_index(hdr, "Количество")
    rows_total = 0
    by_code = defaultdict(lambda: {"planV": 0.0, "openQty": 0.0, "transitQty": 0.0,
                                    "qty": 0.0, "lines": 0, "suppliers": defaultdict(float),
                                    "years": defaultdict(int)})
    for r in it:
        rows_total += 1
        code = r[ci]
        if not code:
            continue
        code = str(code).strip()
        if code not in wk_codes:
            continue
        e = by_code[code]
        e["planV"] += N(r[vi])
        e["openQty"] += N(r[li])
        e["transitQty"] += N(r[ti])
        e["qty"] += N(r[qn])
        e["lines"] += 1
        if r[si]:
            e["suppliers"][str(r[si]).strip()] += N(r[vi])
        if r[di]:
            e["years"][str(r[di])[:4]] += 1
    wb.close()
    out = {}
    for code, e in by_code.items():
        out[code] = {
            "planV": round(e["planV"], 2), "openQty": e["openQty"],
            "transitQty": e["transitQty"], "qty": e["qty"], "lines": e["lines"],
            "topSupplier": max(e["suppliers"].items(), key=lambda x: x[1])[0] if e["suppliers"] else None,
            "years": dict(e["years"]),
        }
    return {"rowsTotal": rows_total, "byCode": out}


def main():
    if len(sys.argv) < 6:
        print("usage: build_stock.py <ekmtr_wk.json> <stock.xlsx> "
              "<restricted.xlsx> <purchase.xlsx> <out_dir>", file=sys.stderr)
        sys.exit(1)
    ekmtr_path, stock_path, restr_path, purch_path, out_dir = sys.argv[1:6]
    os.makedirs(out_dir, exist_ok=True)

    ekmtr_wk = json.load(open(ekmtr_path, encoding="utf-8"))
    wk_codes = {e["code"] for e in ekmtr_wk["items"]}
    name_of = {e["code"]: e["name"] for e in ekmtr_wk["items"]}
    print(f"кодов WK в НСИ: {len(wk_codes)}", file=sys.stderr)

    stock = parse_stock(stock_path, wk_codes)
    print(f"остатки: {stock['rowsTotal']} строк всего, {len(stock['q'])} кодов WK", file=sys.stderr)
    restr = parse_restricted(restr_path, wk_codes)
    print(f"огр. использование: {restr['rowsTotal']} строк всего, {len(restr['q'])} кодов WK", file=sys.stderr)
    purch = parse_purchase(purch_path, wk_codes)
    print(f"закупки: {purch['rowsTotal']} строк всего, {len(purch['byCode'])} кодов WK", file=sys.stderr)

    codes = sorted(set(stock["q"]) | set(restr["q"]) | set(purch["byCode"]))
    items = []
    full_restricted = 0
    for c in codes:
        q = stock["q"].get(c, 0.0)
        v = stock["v"].get(c, 0.0)
        rq = restr["q"].get(c, 0.0)
        rv = restr["v"].get(c, 0.0)
        avail_q = max(q - rq, 0.0)
        unit = v / q if q else 0.0
        avail_v = round(avail_q * unit, 2)
        restricted_v = round(v - avail_v, 2)
        is_fully_restricted = q > 0 and avail_q <= 0
        if is_fully_restricted:
            full_restricted += 1
        p = purch["byCode"].get(c)
        items.append({
            "code": c, "name": name_of.get(c, ""),
            "qty": round(q, 3), "value": round(v, 2),
            "restrictedQty": round(rq, 3), "restrictedValue": restricted_v,
            "availQty": round(avail_q, 3), "availValue": avail_v,
            "fullyRestricted": is_fully_restricted,
            "byWarehouse": stock["byWarehouse"].get(c, {}),
            "purchase": p,
        })

    result = {
        "meta": {
            "srcStock": os.path.basename(stock_path),
            "srcRestricted": os.path.basename(restr_path),
            "srcPurchase": os.path.basename(purch_path),
            "currency": "RUB",
            "stockRowsTotal": stock["rowsTotal"],
            "restrictedRowsTotal": restr["rowsTotal"],
            "purchaseRowsTotal": purch["rowsTotal"],
            "codesWithStock": len(stock["q"]),
            "codesWithPurchase": len(purch["byCode"]),
            "fullyRestrictedCodes": full_restricted,
            "totalValue": round(sum(stock["v"].values()), 2),
            "totalAvailValue": round(sum(i["availValue"] for i in items), 2),
            "totalRestrictedValue": round(sum(i["restrictedValue"] for i in items), 2),
            "totalPurchasePlanValue": round(sum(p["planV"] for p in purch["byCode"].values()), 2),
        },
        "items": items,
    }
    with open(os.path.join(out_dir, "stock.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    m = result["meta"]
    print(f"\nОстаток WK: {m['codesWithStock']} кодов, {m['totalValue']/1e6:.1f} млн ₽")
    print(f"  доступно:   {m['totalAvailValue']/1e6:.1f} млн ₽")
    print(f"  ограничено: {m['totalRestrictedValue']/1e6:.1f} млн ₽  (полностью — {m['fullyRestrictedCodes']} кодов)")
    print(f"Закупка WK: {m['codesWithPurchase']} кодов, {m['totalPurchasePlanValue']/1e6:.1f} млн ₽ плановых")


if __name__ == "__main__":
    main()
