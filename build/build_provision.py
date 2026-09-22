#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Обеспеченность плана ТОиР 2026-2027 по номенклатуре WK: открытые строки
плана против ДОСТУПНОГО остатка и УЖЕ РАЗМЕЩЁННОЙ закупки, с привязкой к
срокам.

Метод — распределение как в MRP/ATP, в два прохода:

  проход 1  потребность, отсортированная по дате начала работ, забирает
            доступный остаток, а затем те приходы закупки, чей месяц
            поставки не позже месяца начала работ («успевает»);
  проход 2  остатками приходов закрываем то, что не успели («опоздание»).

Два прохода принципиальны: в один проход ранняя потребность забирает
поздний приход и помечает его опозданием, хотя тот же приход мог бы
вовремя закрыть более позднюю потребность. Разница на реальных данных —
почти вдвое по доле «закупка успевает».

Дальше — вопрос «можно ли ещё успеть, если заказать сейчас»: к дате
выгрузки прибавляется ФАКТИЧЕСКИЙ срок поставки позиции (медиана
«дата поставки − дата заявки» по той же выгрузке закупки, см.
build_stock.py) и сравнивается с датой начала работ.

Что сознательно НЕ делается:
  * прочая номенклатура (ГСМ, общий крепёж, общие МТР) в расчёт не
    входит — для неё нет витрины остатков, и считать её дефицитом
    было бы неправдой;
  * срок прихода закупки известен только до месяца — внутри месяца
    считаем, что приход успевает;
  * строки с фактом (a>0 или qf>0) — уже исполнены, это не потребность.
    В PM-06 план и факт одной позиции приходят РАЗНЫМИ строками
    (qp/p на одной, qf/a на другой). Сначала сливаются в зерно
    заказ × ЕО × вид работ × материал, затем remaining = max(qp − qf, 0).
    Без слияния закрытый заказ (как 1200407027) висел бы дефицитом.


Выход: data/provision.json

Запуск:
  python3 build/build_provision.py <topo_data_dir> <ekmtr_wk.json> \
      <stock.json> <out_dir>
"""
import sys, os, re, glob, json, hashlib
from datetime import datetime, timedelta
from collections import defaultdict

N = lambda x: x if isinstance(x, (int, float)) else 0
WK_RE = re.compile(r"WK-?\d", re.I)
DATE_RE = re.compile(r"(\d{2})[_.-](\d{2})[_.-](\d{4})")


def cell(values, index, default=0):
    """Return a column value without assuming every source has every field.

    Older PM-06 snapshots do not contain the newer fact/cost columns.  Treating
    an absent optional column as zero keeps the historical plan usable and is
    equivalent to "fact not supplied"; malformed short columns are handled in
    the same deterministic way.
    """
    return values[index] if isinstance(values, list) and index < len(values) else default


def as_of(meta):
    """Дата, на которую верна картина, — самая поздняя из дат выгрузок.

    Анализ привязывается к снимку данных, а не к дате запуска сборки:
    иначе одни и те же исходники дают разный ответ ото дня ко дню.
    """
    best = None
    for key in ("srcStock", "srcRestricted", "srcPurchase"):
        m = DATE_RE.search(meta.get(key) or "")
        if not m:
            continue
        try:
            d = datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            continue
        if best is None or d > best:
            best = d
    return best or datetime.now()


def load_need(topo_dir):
    """Открытые строки плана ТОиР по технике WK за 2026-2027.

    PM-06 хранит план и факт отдельными строками одного заказа и материала.
    Сливаем их в зерно (заказ × ЕО × вид работ × материал) — так же, как
    build_schedule.py — и только потом считаем max(план − факт, 0).
    """
    need = []
    closed = []
    nocode_rows = 0
    nocode_v = 0.0
    for fp in sorted(glob.glob(os.path.join(topo_dir, "*_202[67].json"))):
        with open(fp, encoding="utf-8") as source:
            d = json.load(source)
        wk_idx = {i for i, n in enumerate(d["e"]) if WK_RE.search(n)}
        if not wk_idx:
            continue
        od, orr = d.get("od", {}), d.get("orr", {})
        grains = {}
        for i in range(d["n"]):
            if d["ei"][i] not in wk_idx:
                continue
            ei, ci, wi = cell(d.get("ei"), i, -1), cell(d.get("ci"), i, -1), cell(d.get("wi"), i, None)
            order = cell(d.get("o"), i, "")
            key = (order, ei, wi, ci)
            g = grains.get(key)
            if g is None:
                unit = d["e"][ei] if isinstance(ei, int) and ei < len(d["e"]) else ""
                work = d.get("w", [])[wi] if isinstance(wi, int) and wi < len(d.get("w", [])) else ""
                code = d["cek"][ci] if isinstance(ci, int) and ci < len(d.get("cek", [])) else ""
                mat = d["c"][ci] if isinstance(ci, int) and ci < len(d.get("c", [])) else ""
                g = {
                    "date": (od.get(order) or [""])[0] or "",
                    "code": code, "mat": mat, "order": order,
                    "kind": orr.get(order, ""), "site": d["s"], "year": d["y"],
                    "unit": unit, "work": work, "method": cell(d.get("u"), i, "") or "",
                    "planQty": 0.0, "factQty": 0.0, "planValue": 0.0, "factValue": 0.0,
                    "usoPlan": 0.0, "usoFact": 0.0,
                }
                grains[key] = g
            g["planQty"] += N(cell(d.get("qp"), i))
            g["factQty"] += N(cell(d.get("qf"), i))
            g["planValue"] += N(cell(d.get("p"), i))
            g["factValue"] += N(cell(d.get("a"), i))
            g["usoPlan"] += N(cell(d.get("up"), i))
            g["usoFact"] += N(cell(d.get("uf"), i))
            if cell(d.get("u"), i, ""):
                g["method"] = cell(d.get("u"), i, "")
        for g in grains.values():
            # A negative fact row is a reversal/correction, not a new material
            # requirement.  Open demand must stay between zero and the
            # positive plan; otherwise a standalone qf=-14 row becomes a
            # fictitious need of 14 and consumes ATP stock.
            plan_qty = max(g["planQty"], 0)
            remaining = max(plan_qty - max(g["factQty"], 0), 0)
            if not g["code"]:
                nocode_rows += 1
                nocode_v += g["planValue"] * remaining / g["planQty"] if g["planQty"] else 0
                continue
            g["qty"] = remaining
            g["value"] = g["planValue"] * remaining / plan_qty if plan_qty else 0
            if remaining <= 0:
                if g["planQty"] > 0 or g["factQty"] > 0:
                    closed.append(g)
                continue
            need.append(g)
        del d
    return need, closed, nocode_rows, nocode_v


def allocate(need, stock, today=None):
    """Двухпроходное распределение остатка и приходов закупки.

    Открытый приход с плановым месяцем раньше даты снимка уже просрочен.
    Его дата больше не является надёжным обещанием, поэтому такой объём
    попадает в корзину ``undated``, а не в «закупка успевает».
    """
    avail = {c: N(s.get("availQty")) for c, s in stock.items()}
    inflow = {}
    asof_month = today.strftime("%Y-%m") if today else ""
    for c, s in stock.items():
        raw = ((s.get("purchase") or {}).get("byMonth") or {})
        bm = defaultdict(float)
        for month, qty in raw.items():
            reliable_month = "" if asof_month and month and month < asof_month else month
            bm[reliable_month] += N(qty)
        bm = dict(bm)
        if bm:
            inflow[c] = bm
    need.sort(key=lambda r: (r["date"] or "9999", r["code"]))
    for r in need:
        r.update(fromStock=0.0, fromBuy=0.0, late=0.0, undated=0.0,
                 gap=0.0, left=r["qty"])

    # проход 1 — остаток и приходы, успевающие к сроку работ
    for r in need:
        c = r["code"]
        take = min(r["left"], avail.get(c, 0.0))
        if take > 0:
            avail[c] -= take
            r["fromStock"] += take
            r["left"] -= take
        month = (r["date"] or "")[:7]
        sched = inflow.get(c)
        if not sched or r["left"] <= 0 or not month:
            continue
        for m in sorted(x for x in sched if x and x <= month):
            if r["left"] <= 0:
                break
            take = min(r["left"], sched[m])
            if take <= 0:
                continue
            sched[m] -= take
            r["fromBuy"] += take
            r["left"] -= take

    # проход 2 — остатки приходов закрывают то, что не успели
    for r in need:
        sched = inflow.get(r["code"])
        if not sched or r["left"] <= 0:
            continue
        for m in sorted(sched, key=lambda x: x or "9999"):
            if r["left"] <= 0:
                break
            take = min(r["left"], sched[m])
            if take <= 0:
                continue
            sched[m] -= take
            r["undated" if not m else "late"] += take
            r["left"] -= take

    for r in need:
        r["gap"] = r["left"]
    return need


KEYS = ("fromStock", "fromBuy", "late", "undated", "gap")
val = lambda r, k: r["value"] * (r[k] / r["qty"]) if r["qty"] else 0.0


def totals(rows):
    t = {"value": round(sum(r["value"] for r in rows), 2),
         "qty": round(sum(r["qty"] for r in rows), 3),
         "lines": len(rows)}
    for k in KEYS:
        t[k] = round(sum(val(r, k) for r in rows), 2)
        t[k + "Qty"] = round(sum(r[k] for r in rows), 3)
    return t


def cut(rows, keyfn, sort_by_value=False, limit=None):
    g = defaultdict(list)
    for r in rows:
        g[keyfn(r)].append(r)
    out = [dict(key=k, **totals(v)) for k, v in g.items()]
    out.sort(key=(lambda x: -x["value"]) if sort_by_value else (lambda x: str(x["key"])))
    return out[:limit] if limit else out


def order_id(site, unit, order):
    raw = json.dumps((site, unit, str(order)), ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()[:18]


def build_orders(rows, names):
    grouped = defaultdict(list)
    for r in rows:
        grouped[(r["site"], r["unit"], str(r["order"]))].append(r)
    out = []
    for (site, unit, order), lines in grouped.items():
        t = totals(lines)
        on_time = t["fromStock"] + t["fromBuy"]
        status = "full" if t["gapQty"] + t["lateQty"] + t["undatedQty"] <= 1e-9 \
            else ("none" if t["fromStockQty"] + t["fromBuyQty"] <= 1e-9 else "partial")
        detail = []
        for r in sorted(lines, key=lambda x: (x["date"] or "9999", x["work"], x["code"])):
            detail.append({
                "date": r["date"], "work": r["work"], "code": r["code"],
                "name": names.get(r["code"], "") or r["mat"],
                "qty": round(r["qty"], 3), "value": round(r["value"], 2),
                "planQty": round(r.get("planQty") or 0, 3),
                "factQty": round(r.get("factQty") or 0, 3),
                "method": r.get("method") or "",
                "usoPlan": round(r.get("usoPlan") or 0, 2),
                "usoFact": round(r.get("usoFact") or 0, 2),
                **{k: round(r[k], 3) for k in KEYS},
                **{k + "Value": round(val(r, k), 2) for k in KEYS},
            })
        years = sorted({str(r["year"]) for r in lines})
        dates = sorted(r["date"] for r in lines if r["date"])
        model_match = re.search(r"WK-?(\d+C?)", unit or "", re.I)
        methods = sorted({r.get("method") for r in lines if r.get("method")})
        plan_value = round(sum(r.get("planValue") or 0 for r in lines), 2)
        fact_value = round(sum(r.get("factValue") or 0 for r in lines), 2)
        closed = t["qty"] <= 1e-9 and (plan_value > 0 or fact_value > 0)
        if closed:
            status = "closed"
        out.append({
            "id": order_id(site, unit, order), "site": site, "unit": unit,
            "model": "WK-" + model_match.group(1).upper() if model_match else "",
            "order": order, "years": years, "date": dates[0] if dates else "",
            "kind": next((r["kind"] for r in lines if r["kind"]), ""),
            "method": methods[0] if len(methods) == 1 else ("+".join(methods) if methods else ""),
            "status": status, "closed": closed,
            "planValue": plan_value, "factValue": fact_value,
            "coverage": 100.0 if closed else (round(100 * on_time / t["value"], 1) if t["value"] else 0),
            **t, "lines": detail,
        })
    return sorted(out, key=lambda r: (r["date"] or "9999", r["site"], r["unit"], r["order"]))


def main():
    if len(sys.argv) < 5:
        print("usage: build_provision.py <topo_data_dir> <ekmtr_wk.json> "
              "<stock.json> <out_dir>", file=sys.stderr)
        sys.exit(1)
    topo_dir, ekmtr_path, stock_path, out_dir = sys.argv[1:5]
    os.makedirs(out_dir, exist_ok=True)

    wk_names = {e["code"]: e["name"] for e in json.load(open(ekmtr_path, encoding="utf-8"))["items"]}
    sj = json.load(open(stock_path, encoding="utf-8"))
    stock = {i["code"]: i for i in sj["items"]}
    today = as_of(sj["meta"])
    lead_default = sj["meta"].get("leadMedianDays") or 0

    need, closed_rows, nocode_rows, nocode_v = load_need(topo_dir)
    need = allocate(need, stock, today)
    known = [r for r in need if r["code"] in stock]
    other = [r for r in need if r["code"] not in stock]
    wk_closed = []
    for r in closed_rows:
        if r["code"] not in wk_names:
            continue
        r.update(fromStock=0.0, fromBuy=0.0, late=0.0, undated=0.0, gap=0.0, left=0.0)
        wk_closed.append(r)

    # --- по позициям ----------------------------------------------------
    agg = defaultdict(lambda: defaultdict(float))
    first = {}
    first_open = {}
    for r in known:
        a = agg[r["code"]]
        a["needQty"] += r["qty"]
        a["needValue"] += r["value"]
        for k in KEYS:
            a[k] += r[k]
            a[k + "Value"] += val(r, k)
        d = r["date"]
        if d and (r["code"] not in first or d < first[r["code"]]):
            first[r["code"]] = d
        open_q = r["gap"] + r["late"] + r["undated"]
        if d and open_q > 0 and (r["code"] not in first_open or d < first_open[r["code"]]):
            first_open[r["code"]] = d

    # --- можно ли ещё успеть, если заказать сейчас ----------------------
    # Срочность определяется ПОСТРОЧНО, а не по позиции: у одной и той же
    # позиции часть строк может быть уже просрочена, а часть — ещё
    # закрываема заказом. Итог по позиции — сумма её строк, поэтому
    # фильтр в портале даёт ровно те же деньги, что и сводка.
    feas = defaultdict(lambda: {"value": 0.0, "qty": 0.0, "lines": 0})
    per_code = defaultdict(lambda: defaultdict(float))
    for r in known:
        g = r["gap"] + r["late"] + r["undated"]
        if g <= 0:
            continue
        lead = (stock[r["code"]].get("purchase") or {}).get("leadDays") or lead_default
        eta = today + timedelta(days=lead)
        d = r["date"]
        start = None
        if d:
            try:
                start = datetime.strptime(d[:10], "%Y-%m-%d")
            except ValueError:
                start = None
        if start is None:
            k = "nodate"
        elif start < today:
            k = "past"
        elif eta <= start:
            k = "inTime"
        elif (eta - start).days <= 92:
            k = "late3"
        else:
            k = "lateMore"
        gv = val(r, "gap") + val(r, "late") + val(r, "undated")
        b = feas[k]
        b["value"] += gv
        b["qty"] += g
        b["lines"] += 1
        c = per_code[r["code"]]
        c[k] += gv
        c[k + "Qty"] += g
    feas = {k: {"value": round(v["value"], 2), "qty": round(v["qty"], 3),
                "lines": v["lines"]} for k, v in feas.items()}

    items = []
    for code, a in agg.items():
        s = stock[code]
        p = s.get("purchase") or {}
        lead = p.get("leadDays") or lead_default
        fo = first_open.get(code) or ""
        eta = today + timedelta(days=lead)
        verdict, slip = "covered", None
        if a["gap"] + a["late"] + a["undated"] > 1e-9:
            if not fo:
                verdict = "nodate"
            else:
                start = datetime.strptime(fo[:10], "%Y-%m-%d")
                if start < today:
                    verdict = "past"
                    slip = (today - start).days
                elif eta <= start:
                    verdict = "inTime"
                else:
                    verdict = "late"
                    slip = (eta - start).days
        status = ("full" if a["gap"] + a["late"] + a["undated"] <= 1e-9
                  else ("none" if a["fromStock"] + a["fromBuy"] <= 1e-9 else "partial"))
        items.append({
            "code": code, "name": wk_names.get(code, "") or s.get("name", ""),
            "needQty": round(a["needQty"], 3), "needValue": round(a["needValue"], 2),
            "fromStock": round(a["fromStock"], 3), "fromBuy": round(a["fromBuy"], 3),
            "late": round(a["late"], 3), "undated": round(a["undated"], 3),
            "gap": round(a["gap"], 3),
            "gapValue": round(a["gapValue"] + a["lateValue"] + a["undatedValue"], 2),
            "availQty": s.get("availQty") or 0.0,
            "openQty": p.get("openQty") or 0.0,
            "restricted": bool(s.get("fullyRestricted")),
            "leadDays": lead, "leadN": p.get("leadN") or 0,
            "firstNeed": first.get(code, ""), "firstOpen": fo,
            "orderBy": (datetime.strptime(fo[:10], "%Y-%m-%d") - timedelta(days=lead)).strftime("%Y-%m-%d") if fo else "",
            "verdict": verdict, "slipDays": slip, "status": status,
            "canOrder": round(per_code[code].get("inTime", 0.0), 2),
            "tooLate": round(sum(per_code[code].get(k, 0.0)
                                 for k in ("late3", "lateMore", "past", "nodate")), 2),
        })
    items.sort(key=lambda x: -x["gapValue"])

    # --- график прихода уже размещённой закупки по позициям плана -------
    bym = defaultdict(float)
    for code in agg:
        for m, q in (((stock[code].get("purchase") or {}).get("byMonth")) or {}).items():
            bym[m or ""] += q

    all_orders = build_orders(known + wk_closed, wk_names)
    orders = [o for o in all_orders if o["qty"] > 1e-9]
    closed_orders = [o for o in all_orders if o["qty"] <= 1e-9]
    result = {
        "meta": {
            "src": "TOPO data/<площадка>_<год>.json, годы 2026-2027; план и факт слиты в зерно заказ×материал",
            "srcStock": sj["meta"].get("srcStock"),
            "srcPurchase": sj["meta"].get("srcPurchase"),
            "asOf": today.strftime("%Y-%m-%d"),
            "leadMedianDays": sj["meta"].get("leadMedianDays"),
            "leadMeasurements": sj["meta"].get("leadMeasurements"),
            "leadCodes": sj["meta"].get("leadCodes"),
            "orders": len(orders),
            "closedOrders": len(closed_orders),
            "lines": len(need),
            "positions": len(agg),
            "noCodeRows": nocode_rows, "noCodeValue": round(nocode_v, 2),
            "notWkParts": {"lines": len(other),
                           "value": round(sum(r["value"] for r in other), 2)},
            "wk": totals(known),
            "byYear": cut(known, lambda r: str(r["year"])),
            "bySite": cut(known, lambda r: str(r["site"])),
            "byHalf": cut(known, lambda r: (r["date"][:4] + (" I" if r["date"][5:7] <= "06" else " II")) if r["date"] else "без срока"),
            "byKind": cut(known, lambda r: r["kind"] or "не присвоено", sort_by_value=True, limit=8),
            "feasible": feas,
            "arrivals": [{"month": m, "qty": round(q, 3)}
                         for m, q in sorted(bym.items(), key=lambda kv: kv[0] or "9999")],
        },
        "items": items,
        "orders": orders,
        "closedOrders": closed_orders,
    }
    with open(os.path.join(out_dir, "provision.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    m = result["meta"]
    w = m["wk"]
    T = w["value"] or 1
    M = lambda x: f"{x/1e6:,.0f}".replace(",", " ")
    print(f"на {m['asOf']}: заказов {m['orders']}, закрытых {m.get('closedOrders', 0)}, строк {m['lines']}, "
          f"позиций WK {m['positions']}")
    print(f"потребность WK: {M(w['value'])} млн ₽ ({w['lines']} строк); "
          f"прочая номенклатура {M(m['notWkParts']['value'])} млн ₽ — не считаем")
    for k, label in (("fromStock", "покрыто доступным остатком"),
                     ("fromBuy", "закупка успевает к сроку"),
                     ("late", "закупка придёт позже срока"),
                     ("undated", "закупка есть, срок не проставлен"),
                     ("gap", "не покрыто ничем")):
        print(f"  {label:<36}{M(w[k]):>9} млн ₽{100*w[k]/T:>7.1f}%")
    print(f"срок поставки (медиана): {m['leadMedianDays']} дн. — заказ сегодня придёт "
          f"{(today + timedelta(days=m['leadMedianDays'] or 0)).strftime('%d.%m.%Y')}")
    for k, label in (("inTime", "успеем, если заказать сейчас"),
                     ("late3", "не успеем, опоздание до 3 мес."),
                     ("lateMore", "не успеем, опоздание больше 3 мес."),
                     ("past", "срок работ уже прошёл"),
                     ("nodate", "срок работ не проставлен")):
        b = m["feasible"].get(k)
        if b:
            print(f"  {label:<36}{M(b['value']):>9} млн ₽{b['lines']:>8} строк")


if __name__ == "__main__":
    main()
