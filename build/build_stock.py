#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Строит запасы, ограниченный запас и закупки по номенклатуре WK.

Источники (все — свежие выгрузки SAP из TOPO, ветка rawdata, папка Запас-Закупка):
  Остатки_*.xlsx                          — BW MM-M03, остаток по складам
  Запас с ограниченным использованием*.xlsx — позиции, которые ЕСТЬ на
                                              складе, но НЕЛЬЗЯ взять в ремонт
  Закупка ALL*.xlsx                       — заявки и заказы на поставку

Правило: ограниченный и блокированный запас ВЫЧИТАЕТСЯ из остатка и
подсвечивается отдельным статусом. Позиция, у которой весь остаток
ограничен, в разделе «Обеспеченность» считается дефицитом, а не наличием.

Все суммы — в рублях (₽), как в самой выгрузке SAP. Юани сюда не попадают.

Площадка запаса определяется ЗАВОДОМ строки выгрузки, а не названием склада
(названия повторяются на разных заводах: «Склад МТР», «ПЛ ОХ КарьерОГОК»):
  11xx, 7101, 7106 (перевалочная база КБЕ)      -> 1100 Красноярск / Еруда
  14xx, 7104                                    -> 1400 Магадан
  12xx, 24xx, 7102, 7108 (перевалочная база ПВ) -> 2400 Сухой Лог
  13xx, 7103                                    -> 1300 Алдан
WK в Иркутской области работают только на Сухом Логе, а их заказы ТОРО
планирует завод 1200 (Вернинское), поэтому склады Вернинского и «Развитие»
Иркутские активы относятся к площадке Сухой Лог. Склад — пара «завод/код»;
справочник складов с площадкой — в meta.warehouses.

Выход: data/stock.json

Запуск:
  python3 build/build_stock.py <ekmtr_wk.json> <stock.xlsx> \
      <restricted.xlsx> <purchase.xlsx> <out_dir>
"""
import sys, os, json, statistics, hashlib
from datetime import datetime
import openpyxl
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sites import SITE_NAMES, TRANSIT_PLANTS, plant_site  # noqa: E402

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


def warehouse_meta(plant, plant_name, be, code, name):
    plant = str(plant or "").strip()
    name = str(name or "").strip() or "?"
    kind = ("consign" if "консигнац" in name.lower() else
            "transit" if plant.upper() in TRANSIT_PLANTS else "site")
    site = plant_site(plant)
    return {"plant": plant, "plantName": str(plant_name or "").strip(), "be": str(be or "").strip(),
            "code": str(code or "").strip(), "name": name, "site": site,
            "siteName": SITE_NAMES.get(site, ""), "kind": kind}


def wh_key(plant, code):
    return f"{str(plant or '').strip()}/{str(code or '').strip() or '#'}"


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
    by_wh = defaultdict(lambda: defaultdict(float))  # code -> "завод/склад" -> qty
    by_whv = defaultdict(lambda: defaultdict(float))  # code -> "завод/склад" -> ₽
    warehouses = {}
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
        # 1 — БЕ, 3/4 — завод и его имя, 17/18 — код и имя склада
        key = wh_key(r[3], r[17])
        if key not in warehouses:
            warehouses[key] = warehouse_meta(r[3], r[4], r[2], r[17], r[18])
        by_wh[code][key] += N(r[19])
        by_whv[code][key] += val
    wb.close()
    return {"rowsTotal": rows_total, "q": dict(q), "v": dict(v), "warehouses": warehouses,
            "byWarehouse": {k: dict(v2) for k, v2 in by_wh.items()},
            "byWarehouseValue": {k: dict(v2) for k, v2 in by_whv.items()}}


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
    restr_wh = defaultdict(lambda: defaultdict(float))  # code -> "завод/склад" -> qty
    pi = col_index(hdr, "Завод")
    wi = col_index(hdr, "Склад")
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
        if rq + bq + qq:
            restr_wh[code][wh_key(r[pi], r[wi])] += rq + bq + qq
    wb.close()
    return {"rowsTotal": rows_total, "q": dict(restr_q), "v": dict(restr_v),
            "byWarehouse": {k: dict(v2) for k, v2 in restr_wh.items()}}


def warehouse_split(byq, byv, warehouses, restricted):
    """Остаток кода по складам и площадкам с вычетом ограниченного запаса.

    Ограниченный запас вычитается на ТОМ ЖЕ складе («завод/склад») — у
    склада своя цена: б/у и неисправный запас часто стоит 0 ₽, и вычитать
    его по средней цене кода нельзя. Если склада из файла ограничений нет
    в остатках, вычитаем на складе той же площадки с наибольшим остатком,
    а при неизвестной площадке — на наибольшем складе кода.
    Возвращает (доступно по складам, итоги по площадкам).
    """
    left = {k: q for k, q in byq.items()}
    restr = defaultdict(float)
    for key, rq in (restricted or {}).items():
        if key not in left:
            site = plant_site(key.split("/")[0])
            same = [k for k in left if warehouses[k]["site"] == site and site] or list(left)
            if not same:
                continue
            key = max(same, key=lambda k: left[k])
        restr[key] += rq
    avail = {}
    sites = {}
    for key, q in byq.items():
        a = max(q - restr.get(key, 0.0), 0.0)
        unit = byv.get(key, 0.0) / q if q else 0.0
        avail[key] = round(a, 3)
        o = sites.setdefault(warehouses[key]["site"], {"qty": 0.0, "value": 0.0, "availQty": 0.0, "availValue": 0.0})
        o["qty"] += q
        o["value"] += byv.get(key, 0.0)
        o["availQty"] += a
        o["availValue"] += a * unit
    for o in sites.values():
        o["restrictedQty"] = round(o["qty"] - o["availQty"], 3)
        o["restrictedValue"] = round(o["value"] - o["availValue"], 2)
        for k in ("qty", "availQty"):
            o[k] = round(o[k], 3)
        for k in ("value", "availValue"):
            o[k] = round(o[k], 2)
    return avail, sites


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
    req = exact(["заявка", "заявка на закупку", "номер заявки", "№ заявки"])
    pos = exact(["позиция документа закупки", "позиция заказа", "позиция"])
    req_pos = exact(["позиция заявки"])
    unit = exact(["единица измерения", "еи", "е.и.", "базовая единица измерения"])
    order_date = exact(["дата поставки по заказу"])
    actual_date = exact(["фактическая дата поставки"])
    created_date = exact(["дата создания заказа"])
    plant = exact(["завод"])
    status = exact(["описание"])
    delivered = exact(["кол-во факт поставки в базисной еи"])
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
        def date_cell(i):
            value = as_date(r[i]) if 0 <= i < len(r) else None
            return value.strftime("%Y-%m-%d") if value else ""
        e["documents"].append({
            "document": txt(doc), "request": txt(req), "position": txt(pos), "requestPosition": txt(req_pos),
            "deliveryDate": date_cell(order_date) or (db.strftime("%Y-%m-%d") if db else ""),
            "requiredDate": db.strftime("%Y-%m-%d") if db else "",
            "orderDeliveryDate": date_cell(order_date), "actualDeliveryDate": date_cell(actual_date),
            "orderCreatedDate": date_cell(created_date), "plant": txt(plant), "status": txt(status),
            "deliveredQty": N(r[delivered]) if delivered >= 0 else None,
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
        avail_wh, by_site = warehouse_split(stock["byWarehouse"].get(c, {}), stock["byWarehouseValue"].get(c, {}),
                                            stock["warehouses"], restr["byWarehouse"].get(c))
        # доступно = сумма доступного по площадкам: ограниченный запас одной
        # площадки не уменьшает остаток другой
        avail_q = sum(o["availQty"] for o in by_site.values()) if by_site else max(q - rq, 0.0)
        avail_v = round(sum(o["availValue"] for o in by_site.values()), 2) if by_site else 0.0
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
            "byWarehouse": {k: round(x, 3) for k, x in stock["byWarehouse"].get(c, {}).items()},
            "byWarehouseValue": {k: round(x, 2) for k, x in stock["byWarehouseValue"].get(c, {}).items()},
            "availByWarehouse": avail_wh,
            "bySite": by_site,
            "purchase": p,
        })

    used = {k for i in items for k in i["byWarehouse"]}
    sites = {}
    for i in items:
        for st, o in i["bySite"].items():
            t = sites.setdefault(st, {"name": SITE_NAMES.get(st, "Площадка не определена"), "codes": 0, "qty": 0.0,
                                      "value": 0.0, "availValue": 0.0, "restrictedValue": 0.0})
            t["codes"] += 1 if o["qty"] > 0 else 0
            for k in ("qty", "value", "availValue", "restrictedValue"):
                t[k] = round(t[k] + o[k], 2)
    with open(purch_path, "rb") as f:
        blob = f.read()
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
            "purchaseDocumentSource": "TOPO/rawdata/Запас-Закупка/" + os.path.basename(purch_path),
            "purchaseDocumentBlob": hashlib.sha1(b"blob %d\0" % len(blob) + blob).hexdigest(),
            "siteRule": "площадка — по заводу строки: 11xx/7101/7106 — Красноярск, 14xx/7104 — Магадан, "
                        "12xx/24xx/7102/7108 — Сухой Лог, 13xx/7103 — Алдан",
            "sites": sites,
            "warehouses": {k: stock["warehouses"][k] for k in sorted(used)},
        },
        "items": items,
    }
    with open(os.path.join(out_dir, "stock.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    m = result["meta"]
    print(f"\nОстаток WK: {m['codesWithStock']} кодов, {m['totalValue']/1e6:.1f} млн ₽")
    print(f"  доступно:   {m['totalAvailValue']/1e6:.1f} млн ₽")
    print(f"  ограничено: {m['totalRestrictedValue']/1e6:.1f} млн ₽  (полностью — {m['fullyRestrictedCodes']} кодов)")
    for st, t in sorted(m["sites"].items()):
        print(f"  {st or '—'} {t['name']}: {t['value']/1e6:.1f} млн ₽, доступно {t['availValue']/1e6:.1f}")
    print(f"Закупка WK: {m['codesWithPurchase']} кодов, {m['totalPurchasePlanValue']/1e6:.1f} млн ₽ плановых")
    print(f"  срок поставки: медиана {m['leadMedianDays']} дн. "
          f"({m['leadMeasurements']} замеров по {m['leadCodes']} кодам)")


if __name__ == "__main__":
    main()
