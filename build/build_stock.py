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
import sys, os, json, statistics
from datetime import datetime
import openpyxl
from collections import defaultdict

N = lambda x: x if isinstance(x, (int, float)) else 0


# Медиану округляем вверх при .5 — как Math.round в lib/stock_pipeline.js.
# Встроенный round() в Python банковский (400.5 -> 400), и на чётном числе
# замеров браузерная пересборка расходилась бы с этой на день.
def med(vals):
    return int(statistics.median(vals) + 0.5) if vals else None


def as_date(x):
    """Дата из ячейки: SAP отдаёт либо datetime, либо строку ISO."""
    if isinstance(x, datetime):
        return x
    if isinstance(x, str) and len(x) >= 10:
        try:
            return datetime.strptime(x[:10], "%Y-%m-%d")
        except ValueError:
            return None
    return None


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
    def exact(names):
        return next((i for name in names for i, h in enumerate(hdr) if h.lower() == name), -1)
    doc = exact(["документ закупки", "номер документа закупки", "№ документа закупки", "заказ на поставку"])
    req = exact(["заявка", "заявка на закупку", "номер заявки"])
    pos = exact(["позиция документа закупки", "позиция заказа", "позиция"])
    req_pos = exact(["позиция заявки"])
    unit = exact(["единица измерения", "еи", "е.и.", "базовая единица измерения"])
    rows_total = 0
    # byMonth/years — это ОТКРЫТОЕ КОЛИЧЕСТВО («еще поставить») по сроку
    # поставки, а не число строк: для обеспеченности важно, сколько и когда
    # придёт, а не сколькими строками это оформлено. Строки без даты поставки
    # идут в ключ "" — срок у них неизвестен, и обещать его нельзя.
    by_code = defaultdict(lambda: {"planV": 0.0, "openQty": 0.0, "transitQty": 0.0,
                                    "qty": 0.0, "lines": 0, "suppliers": defaultdict(float),
                                    "years": defaultdict(float), "byMonth": defaultdict(float),
                                    "lead": [], "documents": []})
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
        # Фактический срок поставки: от даты заявки до даты поставки. Берём
        # по УЖЕ ОФОРМЛЕННЫМ строкам (в том числе закрытым) — это единственный
        # в выгрузке замер того, сколько реально идёт позиция.
        da, db = as_date(r[rq]), as_date(r[di])
        def txt(i):
            return str(r[i]).strip() if 0 <= i < len(r) and r[i] is not None else ""
        e["documents"].append({
            "document": txt(doc), "request": txt(req), "position": txt(pos), "requestPosition": txt(req_pos),
            "deliveryDate": db.strftime("%Y-%m-%d") if db else "",
            "requestDate": da.strftime("%Y-%m-%d") if da else "", "supplier": txt(si),
            "qty": N(r[qn]), "openQty": N(r[li]), "transitQty": N(r[ti]), "value": N(r[vi]),
            "currency": txt(cu), "unit": txt(unit), "sourceRow": rows_total + 1,
        })
        if da and db:
            days = (db - da).days
            if 0 < days < 1500:
                e["lead"].append(days)
        left = N(r[li])
        if left:
            d = str(r[di])[:10] if r[di] else ""
            e["years"][d[:4]] += left
            e["byMonth"][d[:7]] += left
    wb.close()
    out = {}
    for code, e in by_code.items():
        out[code] = {
            "planV": round(e["planV"], 2), "openQty": e["openQty"],
            "transitQty": e["transitQty"], "qty": e["qty"], "lines": e["lines"],
            "topSupplier": max(e["suppliers"].items(), key=lambda x: x[1])[0] if e["suppliers"] else None,
            "years": {k: round(v, 3) for k, v in sorted(e["years"].items())},
            "byMonth": {k: round(v, 3) for k, v in sorted(e["byMonth"].items())},
            "documents": e["documents"],
            "leadDays": med(e["lead"]),
            "leadN": len(e["lead"]),
        }
    all_lead = [d for e in by_code.values() for d in e["lead"]]
    return {"rowsTotal": rows_total, "byCode": out,
            "leadMedian": med(all_lead),
            "leadN": len(all_lead),
            "leadCodes": sum(1 for e in by_code.values() if e["lead"])}


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
            "leadMedianDays": purch["leadMedian"],
            "leadMeasurements": purch["leadN"],
            "leadCodes": purch["leadCodes"],
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
    print(f"  срок поставки: медиана {m['leadMedianDays']} дн. "
          f"({m['leadMeasurements']} замеров по {m['leadCodes']} кодам)")


if __name__ == "__main__":
    main()
