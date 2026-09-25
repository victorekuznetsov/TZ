# -*- coding: utf-8 -*-
"""Независимый пересчёт «Поиска по номеру» и раздела «Эффективность».

Вторая реализация правил lib/mtr_core.js — код ядра не используется. Правила
взяты из текста вкладок:

  * номер: каталожный № прайса ДП (с учётом «Артикула обн.»), каталожный № в
    названии ЕКМТР (поле cat витрины ekmtr_wk), сам код ЕКМТР; взаимозаменяемые —
    прямые группы ведомости;
  * история: строки графика data/schedule_*.local.js, площадка — по борту
    (fleet), позиции ППР без заказа (стадия noOrder витрины control) в план не
    входят, отрицательные количества — возврат узла, не расход;
  * потребность — строки открытых заказов provision.json, склад и закупка —
    stock.json;
  * эффективность — ABC, запас без движения и избыток, индекс Ласпейреса,
    внеплановый расход, «заказать до», поставщики.

Результат — tests/fixtures/mtr_expected.json; tests/test_mtr.mjs прогоняет
ядро на тех же витринах и сверяет.

    python3 tests/verify_mtr.py
"""
import collections
import datetime as dt
import hashlib
import json
import os
import re
import statistics
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
JUMP = 5


def local_js(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return json.loads(text[text.index("=", text.index("__DATA__[")) + 1:].rstrip().rstrip(";"))


def load(name):
    with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as f:
        return json.load(f)


def norm(s):
    s = unicodedata.normalize("NFKC", "" if s is None else str(s)).lower().replace("ё", "е").upper()
    return re.sub(r"[^0-9A-ZА-ЯЁ]", "", s)


def ikey(s):
    return re.sub(r"\s+", " ", str(s or "").strip().upper())


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def qty(v):
    return max(0, num(v))


def lower_median(a):
    if not a:
        return None
    s = sorted(a)
    return s[len(s) // 2]


def decode(table):
    ci = table["columns"]
    dic = table["dictionaries"]
    out = []
    for row in table["rows"]:
        out.append({c: (dic[c][row[i]] if c in dic and row[i] is not None else row[i]) for i, c in enumerate(ci)})
    return out


# ---------- витрины ----------
fleet, stock, prov, control = load("fleet"), load("stock"), load("provision"), load("control")
catalog, ekmtr, inter = load("catalog")["items"], load("ekmtr_wk")["items"], load("interchange")
man = local_js(os.path.join(DATA, "schedule_manifest.local.js"))
ROWS = [r for sh in man["shards"] for r in decode(local_js(os.path.join(DATA, sh + ".local.js")))]
ASOF = control["meta"]["asOf"]
CUR, NEXT = ASOF[:4], str(int(ASOF[:4]) + 1)
ASOF_M = ASOF[:7]
UNIT_SITE = {u["name"]: u["site"] for u in fleet["units"]}
CTL = decode(control)
STAGE = {(r["y"], r["order"]): r["stage"] for r in CTL}
# оценка планирования «Развития» — только группы планирования ТОРО 100 Механика и 200 Энергетика
DEV = {(r["y"], r["order"]) for r in CTL if str(r.get("pg") or "").rsplit("/", 1)[-1] in ("100", "200")}
ALL_YEARS = sorted({r["year"] for r in ROWS})
for r in ROWS:
    r["_site"] = UNIT_SITE.get(r["unit"]) or r["site"]
    r["_noOrder"] = STAGE.get((r["year"], r["order"])) == "noOrder"
STOCK = {str(i["code"]): i for i in stock["items"]}
WH = stock["meta"].get("warehouses", {})


def days(a, b):
    return (dt.date.fromisoformat(b[:10]) - dt.date.fromisoformat(a[:10])).days


# ---------- поиск номера ----------
def find(q):
    qn = norm(q)
    self_arts = [i for i in catalog if norm(i["art"]) == qn or (i.get("artNew") and norm(i["artNew"]) == qn)]
    arts = {i["art"]: "self" for i in self_arts}
    codes = {}

    def add(code, rel):
        code = str(code)
        if codes.get(code) != "self":
            codes[code] = rel
    for i in self_arts:
        if i.get("ekmtr"):
            add(i["ekmtr"], "self")
    keys = {qn} | {norm(i["art"]) for i in self_arts}
    for e in ekmtr:
        if norm(e.get("cat")) and norm(e.get("cat")) in keys:
            add(e["code"], "self")
    known = set(STOCK) | {str(i["code"]) for i in prov["items"]} | {str(r["code"]) for r in ROWS if r["code"]}
    known |= {str(e["code"]) for e in ekmtr}
    if re.fullmatch(r"\d{5,8}", q.strip()) and q.strip() in known:
        add(q.strip(), "self")
        for i in catalog:
            if str(i.get("ekmtr")) == q.strip():
                arts[i["art"]] = "self"
    sel_i = {ikey(q)} | {ikey(a) for a in arts}
    sel_n = {qn} | {norm(a) for a in arts}
    analog = set()
    for g in inter["groups"]:
        if any(ikey(p) in sel_i or norm(p) in sel_n for p in g):
            analog |= {p for p in g if norm(p) not in sel_n}
    for p in analog:
        pn = norm(p)
        for i in catalog:
            if norm(i["art"]) == pn:
                arts.setdefault(i["art"], "analog")
                if i.get("ekmtr"):
                    add(i["ekmtr"], "analog")
        for e in ekmtr:
            if norm(e.get("cat")) == pn:
                add(e["code"], "analog")
    return {"self": sorted(c for c, r in codes.items() if r == "self"), "analog": sorted(c for c, r in codes.items() if r == "analog"),
            "arts": sorted(a for a in arts)}


# ---------- профиль позиции ----------
def status(x):
    unc = x["late"] + x["undated"] + x["gap"]
    if x["need"] > 0:
        if unc <= 1e-9:
            return "coveredBuy" if x["fromBuy"] > 0 else "covered"
        if x["gap"] > 0:
            return "short" if x["openQty"] > 0 else "notOrdered"
        return "late"
    if x["avail"] > 0:
        return "stock" if x["recent"] else "idle"
    return "buying" if x["openQty"] > 0 else "none"


def profile(codes, analogs):
    own, an = set(codes), set(analogs)
    by = {"self": collections.defaultdict(lambda: collections.defaultdict(float)), "analog": collections.defaultdict(lambda: collections.defaultdict(float))}
    sets = collections.defaultdict(set)
    site_y = collections.defaultdict(lambda: collections.defaultdict(float))
    last = ""
    for r in ROWS:
        c = str(r["code"] or "")
        if c not in own and c not in an:
            continue
        rel = "self" if c in own else "analog"
        t, y = by[rel][r["year"]], r["year"]
        t["lines"] += 1
        sets[(rel, y, "o")].add(r["order"])
        sets[(rel, y, "u")].add(r["unit"])
        if r["_noOrder"]:
            t["qpNoOrder"] += qty(r["qp"])
        else:
            t["qp"] += qty(r["qp"])
            t["p"] += num(r["p"])
        t["qf"] += qty(r["qf"])
        t["a"] += num(r["a"])
        if qty(r["qp"]) > 0 and num(r["p"]) > 0:
            t["pq"] += qty(r["qp"])
            t["pv"] += num(r["p"])
        if qty(r["qf"]) > 0 and num(r["a"]) > 0:
            t["fq"] += qty(r["qf"])
            t["fv"] += num(r["a"])
        if rel == "self":
            s = site_y[(r["_site"], y)]
            if not r["_noOrder"]:
                s["qp"] += qty(r["qp"])
            s["qf"] += qty(r["qf"])
            if qty(r["qf"]) > 0:
                last = max(last, r["end"] or r["start"] or "")
    hist = {}
    for y in ALL_YEARS:
        t = by["self"][y]
        hist[y] = {"qp": t["qp"], "qf": t["qf"], "p": t["p"], "a": t["a"], "qpNoOrder": t["qpNoOrder"], "lines": int(t["lines"]),
                   "orders": len(sets[("self", y, "o")]), "units": len(sets[("self", y, "u")]),
                   "pricePlan": t["pv"] / t["pq"] if t["pq"] else None, "priceFact": t["fv"] / t["fq"] if t["fq"] else None,
                   "analogQf": by["analog"][y]["qf"]}
    full = [y for y in ALL_YEARS if y < CUR][-3:]
    avg = sum(hist[y]["qf"] for y in full) / len(full) if full else 0
    recent_years = [y for y in ALL_YEARS if str(int(CUR) - 2) <= y <= CUR]
    recent = any(hist[y]["qf"] > 0 for y in recent_years)
    # потребность
    need_y = collections.defaultdict(lambda: collections.defaultdict(float))
    need_s = collections.defaultdict(lambda: collections.defaultdict(float))
    n_lines = 0
    for o in prov["orders"]:
        for l in o.get("lines") or []:
            c = str(l.get("code") or "")
            if c not in own and c not in an:
                continue
            n_lines += 1
            if c not in own:
                continue
            y = (l.get("date") or o.get("date") or "")[:4]
            s = UNIT_SITE.get(o["unit"]) or o["site"]
            for t in (need_y[y], need_s[s]):
                for k in ("qty", "value", "fromStock", "fromBuy", "late", "undated", "gap"):
                    t[k] += num(l.get(k))
                t["transfer"] += num(l.get("transferPotential"))
    tot = collections.defaultdict(float)
    for t in need_y.values():
        for k, v in t.items():
            tot[k] += v
    # склад
    st = [STOCK[c] for c in own if c in STOCK]
    sq = {k: sum(num(i.get(k)) for i in st) for k in ("qty", "availQty", "value", "availValue", "restrictedQty")}
    st_site = collections.defaultdict(lambda: collections.defaultdict(float))
    for i in st:
        for s, v in (i.get("bySite") or {}).items():
            for k in ("qty", "availQty", "value", "availValue"):
                st_site[s][k] += num(v.get(k))
    # закупка
    open_q = over_q = 0.0
    by_month = collections.defaultdict(float)
    leads, docs = [], 0
    price_docs = collections.defaultdict(lambda: [0.0, 0.0, 0])
    for c in sorted(own | an):
        i = STOCK.get(c)
        if not i or not i.get("purchase"):
            continue
        p = i["purchase"]
        if c in own:
            open_q += num(p.get("openQty"))
            for mm, q in (p.get("byMonth") or {}).items():
                by_month[mm or "без даты"] += num(q)
                if mm and mm < ASOF_M:
                    over_q += num(q)
        for d in p.get("documents") or []:
            docs += 1
            if c not in own:
                continue
            if d.get("actualDeliveryDate") and d.get("orderCreatedDate"):
                ld = days(d["orderCreatedDate"], d["actualDeliveryDate"])
                if ld >= 0:
                    leads.append(ld)
            created = d.get("orderCreatedDate") or d.get("requestDate") or ""
            if num(d.get("qty")) and created:
                k = (created[:4], d.get("currency") or "")
                price_docs[k][0] += num(d["qty"])
                price_docs[k][1] += num(d.get("value"))
                price_docs[k][2] += 1
    nxt = sorted(m for m in by_month if m != "без даты" and m >= ASOF_M)
    x = {"need": tot["qty"], "fromStock": tot["fromStock"], "fromBuy": tot["fromBuy"], "late": tot["late"], "undated": tot["undated"],
         "gap": tot["gap"], "avail": sq["availQty"], "openQty": open_q, "recent": recent}
    by_site_status = {}
    for s in sorted(set(need_s) | set(st_site)):
        n = need_s.get(s, {})
        rs = any(site_y.get((s, y), {}).get("qf", 0) > 0 for y in recent_years)
        by_site_status[s] = status({"need": n.get("qty", 0), "fromStock": n.get("fromStock", 0), "fromBuy": n.get("fromBuy", 0), "late": n.get("late", 0),
                                    "undated": n.get("undated", 0), "gap": n.get("gap", 0), "avail": st_site.get(s, {}).get("availQty", 0),
                                    "openQty": open_q, "recent": rs})
    return {
        "codes": sorted(own), "analogs": sorted(an), "years": hist, "avgQf": avg, "recentFact": recent, "lastFact": last or None,
        "bySite": {f"{s}|{y}": dict(v) for (s, y), v in site_y.items()},
        "need": {"lines": n_lines, "total": {k: tot[k] for k in ("qty", "value", "fromStock", "fromBuy", "late", "undated", "gap", "transfer")},
                 "byYear": {y: {k: v[k] for k in ("qty", "value", "gap")} for y, v in need_y.items()}},
        "stock": {**sq, "bySite": {s: dict(v) for s, v in st_site.items()}},
        "purchase": {"openQty": open_q, "overdueQty": over_q, "byMonth": dict(by_month), "docs": docs, "leadDays": lower_median(leads),
                     "leadN": len(leads), "nextDelivery": nxt[0] if nxt else None,
                     "prices": {f"{y}|{cu}": v[1] / v[0] for (y, cu), v in price_docs.items()}},
        "status": {"all": status(x), "bySite": by_site_status,
                   "monthsOfStock": sq["availQty"] / (avg / 12) if avg > 0 else None},
    }


# ---------- эффективность ----------
def in_ctx(site, model, unit, order, ctx):
    return ((not ctx.get("site") or site == ctx["site"]) and (not ctx.get("model") or model == ctx["model"])
            and (not ctx.get("unit") or unit == ctx["unit"]) and (not ctx.get("order") or ctx["order"] in str(order)))


def efficiency(ctx):
    rows = [r for r in ROWS if in_ctx(r["_site"], r["model"], r["unit"], r["order"], ctx)]
    win = [y for y in ALL_YEARS if str(int(CUR) - 2) <= y <= CUR]
    fyears = [y for y in ALL_YEARS if y <= CUR]
    no_ctx = not any(ctx.values())
    site = ctx.get("site")

    def sv(i, k):
        return num(((i.get("bySite") or {}).get(site) or {}).get(k)) if site else num(i.get(k))
    per = {}
    for r in rows:
        if not r["code"]:
            continue
        c = per.setdefault(str(r["code"]), {"a": 0.0, "qf": 0.0, "yq": collections.defaultdict(float), "ya": collections.defaultdict(float),
                                             "qp": collections.defaultdict(float), "p": collections.defaultdict(float)})
        if r["year"] in win:
            c["a"] += num(r["a"])
            c["qf"] += qty(r["qf"])
        c["yq"][r["year"]] += qty(r["qf"])
        c["ya"][r["year"]] += num(r["a"])
        if not r["_noOrder"]:
            c["qp"][r["year"]] += qty(r["qp"])
            c["p"][r["year"]] += num(r["p"])
    cons = sorted(((k, v) for k, v in per.items() if v["a"] > 0), key=lambda kv: (-kv[1]["a"], kv[0]))
    total = sum(v["a"] for _, v in cons)
    run, klass = 0.0, {}
    classes = {k: [0, 0.0] for k in "ABC"}
    for k, v in cons:
        sh = run / total
        cl = "A" if sh < 0.8 else "B" if sh < 0.95 else "C"
        run += v["a"]
        klass[k] = cl
        classes[cl][0] += 1
        classes[cl][1] += v["a"]
    need = collections.defaultdict(lambda: [0.0, 0.0])
    for o in prov["orders"]:
        s = UNIT_SITE.get(o["unit"]) or o["site"]
        if not in_ctx(s, o.get("model"), o["unit"], o["order"], ctx):
            continue
        for l in o.get("lines") or []:
            if l.get("code"):
                need[str(l["code"])][0] += num(l.get("qty"))
                need[str(l["code"])][1] += num(l.get("lateValue")) + num(l.get("undatedValue")) + num(l.get("gapValue"))
    a_codes = [k for k, _ in cons if klass[k] == "A"]
    a_no_stock = sum(1 for k in a_codes if not (k in STOCK and sv(STOCK[k], "availQty") > 0))
    top = [{"code": k, "cls": klass[k], "value": v["a"], "avail": sv(STOCK[k], "availQty") if k in STOCK else 0, "need": need[k][0] if k in need else 0}
           for k, v in cons[:15]]
    # склад
    s_cons = collections.defaultdict(float)
    for r in ROWS:
        if r["code"] and r["year"] in win and (not site or r["_site"] == site):
            s_cons[str(r["code"])] += qty(r["qf"])
    s_need = collections.defaultdict(float)
    for o in prov["orders"]:
        if site and (UNIT_SITE.get(o["unit"]) or o["site"]) != site:
            continue
        for l in o.get("lines") or []:
            if l.get("code"):
                s_need[str(l["code"])] += num(l.get("qty"))
    dead_n = excess_n = 0
    dead_v = excess_v = 0.0
    dead_site = collections.defaultdict(float)
    for i in stock["items"]:
        c, q, v = str(i["code"]), sv(i, "availQty"), sv(i, "availValue")
        if q <= 0 or v <= 0:
            continue
        cc, nn = s_cons.get(c, 0), s_need.get(c, 0)
        if cc <= 0 and nn <= 0:
            dead_n += 1
            dead_v += v
            for s, o in (i.get("bySite") or {}).items():
                if not site or s == site:
                    dead_site[s] += num(o.get("availValue"))
            continue
        keep = nn + 2 * cc / len(win)
        if q > keep + 1e-9:
            excess_n += 1
            excess_v += (q - keep) * v / q
    st_total = sum(sv(i, "availValue") for i in stock["items"])
    fact_avg = sum(num(r["a"]) for r in rows if r["year"] in win) / len(win)

    # цены
    def price(c, y):
        return c["ya"][y] / c["yq"][y] if c["yq"].get(y, 0) > 0 and c["ya"].get(y, 0) > 0 else None
    pairs = []
    for y0, y1 in zip(fyears, fyears[1:]):
        nume = den = 0.0
        n = out = 0
        for c in per.values():
            p0, p1 = price(c, y0), price(c, y1)
            if p0 is None or p1 is None:
                continue
            if p1 / p0 > JUMP or p0 / p1 > JUMP:
                out += 1
                continue
            nume += p1 * c["yq"][y0]
            den += p0 * c["yq"][y0]
            n += 1
        pairs.append({"from": y0, "to": y1, "index": nume / den if den else None, "n": n, "outliers": out})
    growth, g_out = [], 0
    for k, c in per.items():
        ys = [y for y in fyears if price(c, y) is not None]
        if len(ys) < 2 or int(ys[-1]) - int(ys[0]) < 2 or c["ya"][ys[-1]] < 50000:
            continue
        p0, p1 = price(c, ys[0]), price(c, ys[-1])
        if p1 / p0 > JUMP or p0 / p1 > JUMP:
            g_out += 1
            continue
        growth.append((-(p1 / p0 - 1), k))
    growth.sort()
    pn = pd = 0.0
    pc = 0
    for c in per.values():
        q, p = c["qp"].get(NEXT, 0), c["p"].get(NEXT, 0)
        if q <= 0 or p <= 0:
            continue
        ly = next((y for y in reversed(fyears) if price(c, y) is not None), None)
        if ly is None:
            continue
        pn += p
        pd += price(c, ly) * q
        pc += 1
    # внеплановый расход и неиспользованный план
    un = collections.defaultdict(lambda: collections.defaultdict(float))
    for r in rows:
        if (r["year"], r["order"]) not in DEV:
            continue
        t = un[r["year"]]
        t["fact"] += num(r["a"])
        if num(r["a"]) > 0 and num(r["p"]) <= 0 and qty(r["qp"]) <= 0:
            t["unplanned"] += num(r["a"])
            t["unplannedLines"] += 1
        if r["_noOrder"]:
            continue
        t["plan"] += num(r["p"])
        if r["year"] < CUR and num(r["p"]) > 0 and num(r["a"]) <= 0 and qty(r["qf"]) <= 0:
            t["unused"] += num(r["p"])
    # «заказать до»
    ob = collections.defaultdict(float)
    past_v, past_n = 0.0, 0
    for i in prov["items"]:
        v = num(i.get("gapValue")) if no_ctx else (need[str(i["code"])][1] if str(i["code"]) in need else 0)
        if v <= 0 or not i.get("orderBy"):
            continue
        ob[i["orderBy"][:7]] += v
        if i["orderBy"][:7] < ASOF_M:
            past_v += v
            past_n += 1
    # поставщики
    sup = collections.defaultdict(lambda: {"positions": 0, "open": 0, "overdue": 0, "leads": []})
    for i in stock["items"]:
        for d in ((i.get("purchase") or {}).get("documents") or []):
            t = sup[d.get("supplier") or "—"]
            t["positions"] += 1
            if num(d.get("openQty")) > 0:
                t["open"] += 1
                if d.get("deliveryDate") and d["deliveryDate"][:7] < ASOF_M:
                    t["overdue"] += 1
            if d.get("actualDeliveryDate") and d.get("orderCreatedDate"):
                ld = days(d["orderCreatedDate"], d["actualDeliveryDate"])
                if ld >= 0:
                    t["leads"].append(ld)
    sup_rows = sorted(sup.items(), key=lambda kv: (-kv[1]["open"], -kv[1]["positions"], kv[0]))
    return {
        "abc": {"total": total, "n": len(cons), "classes": {k: {"n": v[0], "value": v[1]} for k, v in classes.items()},
                "aNoStock": a_no_stock, "top": top},
        "stock": {"total": st_total, "factAvgYear": fact_avg, "deadN": dead_n, "deadV": dead_v, "deadSite": dict(dead_site),
                  "excessN": excess_n, "excessV": excess_v},
        "price": {"pairs": pairs, "growthTop": [k for _, k in growth[:12]], "growthN": len(growth), "growthOut": g_out,
                  "plan": {"index": pn / pd if pd else None, "n": pc}},
        "unplanned": {y: {k: t[k] for k in ("fact", "unplanned", "plan", "unused", "unplannedLines")} for y, t in un.items()},
        "orderBy": {"months": dict(ob), "pastV": past_v, "pastN": past_n},
        "suppliers": [{"supplier": k, "positions": v["positions"], "open": v["open"], "overdue": v["overdue"], "leadMedian": lower_median(v["leads"])}
                      for k, v in sup_rows[:12]],
    }


def main():
    # запросы: заданные номера + крупнейшие по расходу коды + каждый 40-й код склада
    queries = ["K1839.01.00", "K1601.30.04", "MB223", "976755", "1235898", "K1844.16.01.00", "K1803.07.02.00", "KA2072HA2", "GB/T3287"]
    fact = collections.Counter()
    for r in ROWS:
        if r["code"] and str(int(CUR) - 2) <= r["year"] <= CUR:
            fact[str(r["code"])] += num(r["a"])
    queries += [c for c, _ in fact.most_common(15)]
    queries += [c for c in sorted(STOCK)][::40]
    cases = []
    for q in dict.fromkeys(queries):
        f = find(q)
        cases.append({"q": q, "find": f, "profile": profile(f["self"], f["analog"]) if f["self"] else None})
    ctxs = [{}] + [{"site": s} for s in ("1100", "1400", "2400")] + [{"model": "WK-35"}, {"site": "1100", "model": "WK-20"}]
    units = sorted({u["name"] for u in fleet["units"]})
    ctxs += [{"unit": units[0]}, {"unit": units[len(units) // 2]}]
    eff = [{"ctx": c, "eff": efficiency(c)} for c in ctxs]
    h = hashlib.sha256()
    for n in ("catalog", "ekmtr_wk", "interchange", "control", "provision", "stock", "fleet"):
        with open(os.path.join(DATA, n + ".json"), "rb") as f:
            h.update(f.read())
    h.update(json.dumps(man["shards"]).encode())
    h.update(str(len(ROWS)).encode())
    out = {"meta": {"fingerprint": h.hexdigest()[:16], "asOf": ASOF, "rows": len(ROWS)}, "cases": cases, "efficiency": eff}
    path = os.path.join(ROOT, "tests", "fixtures", "mtr_expected.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"{path}: запросов {len(cases)} (с кодами {sum(1 for c in cases if c['profile'])}), контекстов эффективности {len(eff)}")


if __name__ == "__main__":
    main()
