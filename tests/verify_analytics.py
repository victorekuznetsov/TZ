# -*- coding: utf-8 -*-
"""Независимый пересчёт вкладок «Аналитика» и «Контроль отделов».

Вторая, отдельная реализация тех же правил, что в lib/analytics_core.js. Код
ядра не импортируется и не переиспользуется; витрина data/control.json для
сумм не читается:

  * суммы плана и факта заказа — из строк графика (data/schedule_*.local.js);
  * стадия, копия, вид заказа и статусы — из выгрузки статусов PM-06 TOPO
    (<TOPO>/pm06_meta/order_status), стадия выводится заново по
    PM06_STATUSES.md. Без TOPO берутся из control.json (режим записывается в
    фикстуру), суммы всё равно считаются из строк графика;
  * обеспеченность — построчно из data/provision.json (итоги заказа
    не используются), запасы — по кодам из data/stock.json, КТГ — из
    data/fleet.json.

Результат — tests/fixtures/analytics_expected.json: показатели и уровни
автовыводов для всех контекстов (весь парк, каждая площадка, модель, борт).
tests/test_analytics.mjs прогоняет ядро на тех же витринах и сверяет.

    python3 tests/verify_analytics.py [<TOPO>/pm06_meta/order_status]
"""
import collections
import datetime as dt
import glob
import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
YEARS = ["2024", "2025", "2026", "2027"]
CLOSED = {"techClosed", "accepted", "billed", "closed"}
OPEN_WORK = {"released", "inWork", "factDone"}
NOT_RELEASED = {"approving", "approved"}
GROUP_OF = {
    "noOrder": "ППР без заказа", "approving": "Согласование", "approved": "Согласование",
    "released": "Деблокирован, пусто", "inWork": "В работе", "factDone": "В работе",
    "techClosed": "Тех. закрыт", "accepted": "Тех. закрыт", "billed": "Тех. закрыт", "closed": "Закрыт",
}
# пороги — из текста правил (PM06_STATUSES.md / вкладка «Методика»)
EXEC_LOW, EXEC_HIGH, PACE_GAP = 0.90, 1.10, 0.15
RELEASED_EMPTY, APPROVING_LATE, NEXT_APPROVED = 0.05, 0.10, 0.50
COV_BAD, COV_WARN, KTG_GAP = 0.70, 0.90, 0.05
OVER_RATIO, OVER_MIN, CONCENTRATION = 1.10, 100000, 0.25
ACCURACY_TOL, UNPLANNED, CLOSE_LAG = 0.20, 0.40, 30


def local_js(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    start = text.index("=", text.index("__DATA__[")) + 1
    return json.loads(text[start:].rstrip().rstrip(";"))


def load(name):
    with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as f:
        return json.load(f)


def d(s):
    return dt.date.fromisoformat(s[:10]) if s else None


def div(a, b):
    return a / b if b else None


# ---------- стадия заказа по статусам (PM06_STATUSES.md) ----------
PHASES = {0: "нет статуса", 1: "ОТКР", 2: "ДЕБЛ", 3: "ТЗКР", 4: "ЗАКР"}


def stage_from_status(phase, sys_codes, usr_codes, fact):
    """Таблица решений: первая сработавшая строка определяет стадию."""
    table = [
        (lambda: phase == 0, "noOrder"),
        (lambda: phase == 4, "closed"),
        (lambda: phase == 3 and "ВСБЕ" in usr_codes, "billed"),
        (lambda: phase == 3 and "ПРСЗ" in usr_codes, "accepted"),
        (lambda: phase == 3, "techClosed"),
        (lambda: phase == 2 and "ФХСМ" in usr_codes, "factDone"),
        (lambda: phase == 2 and (fact > 0 or "ПДТВ" in sys_codes or "ЧПДТ" in sys_codes or "ПРНТ" in usr_codes), "inWork"),
        (lambda: phase == 2, "released"),
        (lambda: "СГГС" in usr_codes, "approved"),
    ]
    for cond, stage in table:
        if cond():
            return stage
    return "approving"


def plant_site(plant):
    p = str(plant or "")
    if p.startswith("11") or p in ("7101", "7106"):
        return "1100"
    if p.startswith("14") or p == "7104":
        return "1400"
    if p.startswith("12") or p.startswith("24") or p in ("7102", "7108"):
        return "2400"
    if p.startswith("13") or p == "7103":
        return "1300"
    return p


# ---------- заказы из строк графика ----------
def orders_from_schedule(fleet):
    unit_site = {u["name"]: u["site"] for u in fleet["units"]}
    man = local_js(os.path.join(DATA, "schedule_manifest.local.js"))
    acc = {}
    for shard in man["shards"]:
        sd = local_js(os.path.join(DATA, shard + ".local.js"))
        ci = {c: i for i, c in enumerate(sd["columns"])}
        dic = sd["dictionaries"]

        def val(row, col):
            v = row[ci[col]]
            return dic[col][v] if col in dic and v is not None else v
        for row in sd["rows"]:
            y = val(row, "year")
            if y not in YEARS:
                continue
            key = (y, val(row, "order"))
            o = acc.setdefault(key, {"y": y, "order": key[1], "unit": val(row, "unit"), "model": val(row, "model"),
                                     "plant": val(row, "site"), "p": 0.0, "a": 0.0, "up": 0.0, "uf": 0.0,
                                     "starts": [], "ends": [], "work": collections.Counter(), "bad": 0})
            for k in ("p", "a", "up", "uf"):
                o[k] += val(row, k) or 0
            bad = bool(val(row, "badDate"))
            o["bad"] += bad
            if not bad:
                if val(row, "start"):
                    o["starts"].append(val(row, "start"))
                if val(row, "end"):
                    o["ends"].append(val(row, "end"))
            o["work"][val(row, "work")] += (val(row, "p") or 0) + (val(row, "up") or 0)
    out = []
    for o in acc.values():
        o["site"] = unit_site.get(o["unit"], o["plant"])
        o["start"] = min(o["starts"]) if o["starts"] else ""
        o["end"] = max(o["ends"]) if o["ends"] else ""
        out.append(o)
    return out


def attach_status(orders, status_dir, control):
    mode = "topo"
    if status_dir and os.path.isdir(status_dir):
        st = {}
        for fn in sorted(glob.glob(os.path.join(status_dir, "*.json"))):
            with open(fn, encoding="utf-8") as f:
                j = json.load(f)
            y = j["meta"]["year"]
            if y not in YEARS:
                continue
            for order, (si, ui, ki, ph, cp) in j["o"].items():
                st[(y, order)] = (ph, bool(cp), set(j["sys"][si].split()), set(j["usr"][ui].split()), j["kind"][ki])
        for o in orders:
            ph, cp, s, u, kind = st.get((o["y"], o["order"]), (1, False, set(), set(), ""))
            o["stage"] = stage_from_status(ph, s, u, o["a"] + o["uf"])
            o["copy"], o["codes"], o["kind"] = cp, s | u, kind
    else:
        mode = "control"
        cols, dic = control["columns"], control["dictionaries"]
        ix = {c: i for i, c in enumerate(cols)}
        get = lambda r, c: dic[c][r[ix[c]]] if c in dic else r[ix[c]]
        st = {(get(r, "y"), get(r, "order")): r for r in control["rows"]}
        for o in orders:
            r = st[(o["y"], o["order"])]
            o["stage"], o["copy"], o["kind"] = get(r, "stage"), bool(get(r, "copy")), get(r, "kind")
            o["codes"] = set(get(r, "flags").split())
    for o in orders:
        o["plan"] = o["p"] + o["up"]
        o["fact"] = o["a"] + o["uf"]
        o["noOrder"] = o["stage"] == "noOrder"
        o["pc"] = 0.0 if o["noOrder"] else (min(o["plan"], o["fact"]) if o["copy"] else o["plan"])
    return mode


# ---------- показатели ----------
def year_totals(rows):
    out = {}
    for y in YEARS:
        a = [r for r in rows if r["y"] == y]
        orders = [r for r in a if not r["noOrder"]]
        groups = collections.Counter()
        for r in a:
            groups[GROUP_OF.get(r["stage"], "Нет статуса")] += r["plan"]
        share = lambda r: r["pc"] / r["plan"] if r["plan"] else 0
        out[y] = {
            "plan": sum(r["pc"] for r in orders), "fact": sum(r["fact"] for r in orders),
            "mtrPlan": sum(r["p"] * share(r) for r in orders), "usoPlan": sum(r["up"] * share(r) for r in orders),
            "mtrFact": sum(r["a"] for r in orders), "usoFact": sum(r["uf"] for r in orders),
            "orders": len(orders), "noOrderPlan": sum(r["plan"] for r in a if r["noOrder"]),
            "noOrderN": sum(1 for r in a if r["noOrder"]),
            "groups": {k: groups[k] for k in sorted(groups)},
        }
        out[y]["exec"] = div(out[y]["fact"], out[y]["plan"])
    return out


def listing(rows):
    return {"n": len(rows), "plan": sum(r["pc"] for r in rows)}


def control_metrics(rows, as_of):
    today, cur = d(as_of), as_of[:4]
    nxt = str(int(cur) + 1)
    month = as_of[:7]
    cur_rows = [r for r in rows if r["y"] == cur and not r["noOrder"]]
    nxt_rows = [r for r in rows if r["y"] == nxt]
    lag = today - dt.timedelta(days=CLOSE_LAG)
    ex = {
        "releasedEmpty": listing([r for r in cur_rows if r["stage"] == "released"]),
        "closeOverdue": listing([r for r in cur_rows if r["stage"] in OPEN_WORK and r["end"] and d(r["end"]) < lag]),
        "notReleasedStarted": listing([r for r in cur_rows if r["stage"] in NOT_RELEASED and r["start"] and d(r["start"]) < today]),
        "readyToClose": listing([r for r in cur_rows if r["stage"] == "factDone"]),
        "acceptPending": listing([r for r in cur_rows if r["stage"] == "techClosed"]),
        "tails": {y: listing([r for r in rows if r["y"] == y and not r["noOrder"] and r["stage"] not in CLOSED]) for y in ("2024", "2025")},
        "dueToDate": sum(r["pc"] for r in cur_rows if r["start"][:7] <= month),
        "factDueToDate": sum(r["fact"] for r in cur_rows if r["start"][:7] <= month),
        "unplanned": {},
    }
    for y in ("2024", "2025", "2026"):
        a = [r for r in rows if r["y"] == y and not r["noOrder"]]
        f = sum(r["fact"] for r in a)
        ex["unplanned"][y] = div(sum(r["fact"] for r in a if r["kind"] == "AVS1"), f)

    def approval(r):
        if r["noOrder"]:
            return "ППР без заказа"
        if r["stage"] == "approving":
            return "ССПЛ" if "ССПЛ" in r["codes"] else "СГПЛ" if "СГПЛ" in r["codes"] else "ПЛАН"
        return "СГГС" if r["stage"] == "approved" else "Деблокирован"
    chain = collections.defaultdict(lambda: {"n": 0, "plan": 0.0})
    for r in nxt_rows:
        c = chain[approval(r)]
        c["n"] += 1
        c["plan"] += r["plan"] if r["noOrder"] else r["pc"]
    nxt_orders = [r for r in nxt_rows if not r["noOrder"]]
    app1 = [r for r in nxt_orders if r["kind"] == "APP1"]
    app1_plan = sum(r["pc"] for r in app1)
    soon = [r for r in cur_rows if r["start"] and today <= d(r["start"]) <= today + dt.timedelta(days=31)]
    soon_plan = sum(r["pc"] for r in soon)
    open_rows = [r for r in rows if r["y"] in (cur, nxt) and not r["noOrder"] and r["stage"] not in CLOSED]
    pl = {
        "chain": {k: chain[k] for k in ("ППР без заказа", "ПЛАН", "СГПЛ", "ССПЛ", "СГГС", "Деблокирован")},
        "nextPlan": sum(r["pc"] for r in nxt_orders),
        "approvedPlan": sum(r["pc"] for r in nxt_orders if r["stage"] != "approving"),
        "annual": {c: div(sum(r["pc"] for r in app1 if c in r["codes"]), app1_plan) for c in ("ГОД", "ПТОГ", "ГИП", "УТВГ", "УТВП")},
        "soon": {"n": len(soon), "plan": soon_plan},
        "operative": {c: div(sum(r["pc"] for r in soon if c in r["codes"]), soon_plan) for c in ("МЕС", "УТВМ", "НЕД", "УТВН")},
        "materials": {c: listing([r for r in open_rows if c in r["codes"]]) for c in ("МТРН", "СРОЧ", "НВСО", "ТОПЗ", "СОПЗ")},
        "accuracy": {},
    }
    pl["approvedShare"] = div(pl["approvedPlan"], pl["nextPlan"])
    for y in ("2024", "2025"):
        a = [r for r in rows if r["y"] == y and r["stage"] in CLOSED and r["pc"] > 0]
        ok = [r for r in a if abs(r["fact"] - r["pc"]) <= ACCURACY_TOL * r["pc"]]
        pl["accuracy"][y] = {"n": len(a), "ok": len(ok), "noFactN": sum(1 for r in a if r["fact"] <= 0)}

    bu = {"overrun": {}, "underrun": {}, "noPlan": {}}
    for y in ("2024", "2025", cur):
        a = [r for r in rows if r["y"] == y and not r["noOrder"]]
        ov = [r for r in a if r["pc"] > 0 and r["fact"] > OVER_RATIO * r["pc"] and r["fact"] - r["pc"] >= OVER_MIN]
        un = [r for r in a if r["stage"] in CLOSED and r["pc"] > 0 and r["fact"] < 0.5 * r["pc"]]
        npl = [r for r in a if r["pc"] <= 0 and r["fact"] > 0]
        bu["overrun"][y] = {"n": len(ov), "value": sum(r["fact"] - r["pc"] for r in ov)}
        bu["underrun"][y] = {"n": len(un), "value": sum(r["pc"] - r["fact"] for r in un)}
        bu["noPlan"][y] = {"n": len(npl), "value": sum(r["fact"] for r in npl)}
    for key, y in (("statusCur", cur), ("statusNext", nxt)):
        a = [r for r in rows if r["y"] == y and not r["noOrder"] and r["kind"] == "APP1"]
        base = sum(r["pc"] for r in a)
        bu[key] = {c: {"n": sum(1 for r in a if c in r["codes"]), "plan": sum(r["pc"] for r in a if c in r["codes"]),
                       "share": div(sum(r["pc"] for r in a if c in r["codes"]), base)}
                   for c in ("ТКБЕ", "УТВП", "СГЛБ", "ПЗТГ", "ПЗТМ", "КОРБ", "ТРКБ", "ОТКБ", "КРМТ")}
    no_fact = [r for r in cur_rows if (r["stage"] in NOT_RELEASED or r["stage"] == "released") and r["fact"] <= 0]
    due = [r for r in no_fact if r["start"] and d(r["start"]) <= today]
    bu["riskUnspent"] = sum(r["pc"] for r in due)
    bu["riskN"] = len(due)
    bu["ahead"] = sum(r["pc"] for r in no_fact) - bu["riskUnspent"]
    return ex, pl, bu


def provision_metrics(prov, ctx):
    as_of = d(prov["meta"]["asOf"])
    lead0 = prov["meta"].get("leadMedianDays") or 0
    lead = {str(i["code"]): i.get("leadDays") for i in prov.get("items", [])}
    orders = [o for o in prov["orders"] if in_ctx(o, ctx)]
    blank = lambda: dict(value=0.0, own=0.0, buy=0.0, uncovered=0.0, gap=0.0, potential=0.0)
    by_year, by_site = collections.defaultdict(blank), collections.defaultdict(blank)
    ppm = collections.defaultdict(lambda: {"value": 0.0, "uncovered": 0.0})
    moves = collections.Counter()
    feas = collections.Counter()
    for o in orders:
        y = str(o["years"][0]) if o.get("years") else (o.get("date") or "")[:4]
        for ln in o["lines"]:
            v = ln["value"] or 0
            unc = (ln["lateValue"] or 0) + (ln["undatedValue"] or 0) + (ln["gapValue"] or 0)
            for t in (by_year[y], by_site[o["site"] + "|" + y]):
                t["value"] += v
                t["own"] += ln["fromStockValue"] or 0
                t["buy"] += ln["fromBuyValue"] or 0
                t["uncovered"] += unc
                t["gap"] += ln["gapValue"] or 0
                t["potential"] += ln["transferPotentialValue"] or 0
            p = ppm[y + "|" + (ln.get("ppm") or "immediate")]
            p["value"] += v
            p["uncovered"] += unc
            tq = ln.get("transferPotential") or 0
            for src, q in (ln.get("transferFrom") or {}).items():
                if tq > 0:
                    moves[src + ">" + o["site"]] += (ln["transferPotentialValue"] or 0) * q / tq
            if (ln["gap"] or 0) + (ln["late"] or 0) + (ln["undated"] or 0) <= 0:
                continue
            start = d(ln.get("date"))
            if not start:
                k = "nodate"
            elif start < as_of:
                k = "past"
            else:
                eta = as_of + dt.timedelta(days=lead.get(str(ln["code"])) or lead0)
                k = "inTime" if eta <= start else "late3" if (eta - start).days <= 92 else "lateMore"
            feas[k] += unc
    def fin(t):
        # сегменты графика: возможность перемещения вырезается сперва из «не покрыто», потом из опозданий
        seg = {"own": t["own"], "buy": t["buy"], "pot": t["potential"], "gap": max(0.0, t["gap"] - t["potential"]),
               "late": t["uncovered"] - t["gap"] - max(0.0, t["potential"] - t["gap"])}
        return {**t, "seg": seg, "coverage": div(t["own"] + t["buy"], t["value"]),
                "coverageWithMove": div(t["own"] + t["buy"] + t["potential"], t["value"])}
    return {"byYear": {k: fin(v) for k, v in by_year.items()}, "bySite": {k: fin(v) for k, v in by_site.items()},
            "ppm": dict(ppm), "moves": dict(moves), "feasible": {k: feas[k] for k in ("inTime", "late3", "lateMore", "past", "nodate")},
            "potential": sum(v["potential"] for v in by_year.values()),
            "value": sum(v["value"] for v in by_year.values()),
            "coverage": div(sum(v["own"] + v["buy"] for v in by_year.values()), sum(v["value"] for v in by_year.values()))}


def ktg_metrics(fleet, ctx, cur):
    months = fleet["meta"]["months"]
    units = [u for u in fleet["units"] if (not ctx.get("site") or u["site"] == ctx["site"])
             and (not ctx.get("model") or u["model"] == ctx["model"]) and (not ctx.get("unit") or u["name"] == ctx["unit"])]

    def year_avg(series, y):
        v = [x for m, x in zip(months, series) if m.startswith(y) and x and x > 0]
        a = sum(v) / len(v) if v else None
        return None if a is not None and a >= 0.99999 else a
    rows = {u["name"]: {"plan": year_avg(u["ktgByMonth"], cur), "fact": year_avg(u["kioByMonth"], cur)} for u in units}
    below = sorted(n for n, r in rows.items() if r["plan"] is not None and r["fact"] is not None and r["fact"] < r["plan"] - KTG_GAP)
    return {"byUnit": rows, "below": below}


def in_ctx(o, ctx):
    return all(not ctx.get(k) or o.get(k) == ctx[k] for k in ("site", "model", "unit"))


def levels(years, ex, pl, bu, pv, ktg, cur, elapsed, units_fact):
    """Уровни автовыводов: (правило, уровень) — как в правилах вкладки."""
    nxt = str(int(cur) + 1)
    out = []
    for y in ("2024", "2025"):
        t = years[y]
        if t["plan"]:
            out.append(("exec-closed", "ok" if EXEC_LOW <= t["exec"] <= EXEC_HIGH else "warn"))
    tc = years[cur]
    if tc["plan"]:
        gap = elapsed - (tc["exec"] or 0)
        out.append(("exec-pace", "bad" if gap > PACE_GAP else "warn" if gap > PACE_GAP / 2 else "ok"))
        re = ex["releasedEmpty"]
        out.append(("exec-released-empty", "ok" if not re["n"] else "bad" if re["plan"] / tc["plan"] > RELEASED_EMPTY else "warn"))
        out.append(("exec-close-overdue", "warn" if ex["closeOverdue"]["n"] else "ok"))
        out.append(("exec-ready-close", "info" if ex["readyToClose"]["n"] else "ok"))
    out.append(("exec-tails", "warn" if any(ex["tails"][y]["n"] for y in ("2024", "2025")) else "ok"))
    if tc["plan"]:
        allg = sum(tc["groups"].values())
        share = tc["groups"].get("Согласование", 0) / allg if allg else None
        out.append(("plan-approving", "warn" if share is not None and share > APPROVING_LATE else "ok"))
    if pl["nextPlan"]:
        out.append(("plan-next-approved", "warn" if pl["approvedShare"] < NEXT_APPROVED else "ok"))
    if pl["chain"]["ППР без заказа"]["n"]:
        out.append(("plan-no-order", "info"))
    out.append(("plan-not-released-started", "warn" if ex["notReleasedStarted"]["n"] else "ok"))
    acc = pl["accuracy"]["2025"]
    if acc["n"]:
        out.append(("plan-accuracy", "warn" if acc["ok"] / acc["n"] < 0.5 else "ok"))
    if years["2025"]["fact"]:
        out.append(("plan-unplanned", "warn" if (ex["unplanned"]["2025"] or 0) > UNPLANNED else "ok"))
    out.append(("plan-materials", "warn" if pl["materials"]["МТРН"]["n"] else "ok"))
    p = pv["byYear"].get(nxt)
    if p and p["value"]:
        out.append(("supply-coverage", "bad" if p["coverage"] < COV_BAD else "warn" if p["coverage"] < COV_WARN else "ok"))
    onr = pv["ppm"].get(nxt + "|onRelease")
    if onr and onr["uncovered"] > 0:
        out.append(("supply-ppm", "bad"))
    f = pv["feasible"]
    out.append(("supply-order-now", "info" if f["inTime"] > 0 else "ok"))
    out.append(("supply-too-late", "bad" if f["late3"] + f["lateMore"] + f["past"] > 0 else "ok"))
    if pv["potential"] > 0:
        out.append(("supply-move", "info"))
    out.append(("budget-overrun", "warn" if bu["overrun"][cur]["value"] + bu["overrun"]["2025"]["value"] > 0 else "ok"))
    corr = [c for st in (bu["statusCur"], bu["statusNext"]) for k, c in st.items() if k in ("ТРКБ", "ОТКБ") and c["n"]]
    out.append(("budget-correction", "warn" if corr else "ok"))
    tk, up = bu["statusNext"]["ТКБЕ"], bu["statusNext"]["УТВП"]
    app1_next = any(v is not None for v in pl["annual"].values())
    if tk["plan"] or up["plan"] or app1_next:
        out.append(("budget-next-approved", "info" if (tk["share"] or 0) < 0.5 else "ok"))
    if tc["plan"]:
        rs = bu["riskUnspent"] / tc["plan"]
        out.append(("budget-unspent", "bad" if rs > 0.25 else "warn" if rs > 0.1 else "ok"))
    out.append(("fleet-ktg", "warn" if ktg["below"] else "ok"))
    tot = sum(units_fact.values())
    if len(units_fact) > 1 and tot:
        out.append(("fleet-concentration", "warn" if max(units_fact.values()) / tot > CONCENTRATION else "ok"))
    return sorted(out)


def fingerprint():
    h = hashlib.sha256()
    for n in ("control", "provision", "stock", "fleet"):
        with open(os.path.join(DATA, n + ".json"), "rb") as f:
            h.update(f.read())
    return h.hexdigest()[:16]


def main():
    status_dir = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TOPO_ORDER_STATUS", os.path.join(os.path.dirname(ROOT), "TOPO", "pm06_meta", "order_status"))
    fleet, prov, stock, control = load("fleet"), load("provision"), load("stock"), load("control")
    as_of = prov["meta"]["asOf"]
    cur = as_of[:4]
    y0 = dt.date(int(cur), 1, 1)
    elapsed = (d(as_of) - y0).days / (dt.date(int(cur) + 1, 1, 1) - y0).days
    orders = orders_from_schedule(fleet)
    mode = attach_status(orders, status_dir, control)

    # витрина control.json должна совпасть с независимой сборкой заказ-в-заказ
    cols, dic = control["columns"], control["dictionaries"]
    ix = {c: i for i, c in enumerate(cols)}
    get = lambda r, c: dic[c][r[ix[c]]] if c in dic else r[ix[c]]
    ctl = {(get(r, "y"), get(r, "order")): r for r in control["rows"]}
    diffs = []
    for o in orders:
        r = ctl.get((o["y"], o["order"]))
        if r is None:
            diffs.append(f"{o['y']}/{o['order']}: нет в control.json")
            continue
        for k in ("p", "a", "up", "uf"):
            if abs(get(r, k) - o[k]) > 0.02:
                diffs.append(f"{o['y']}/{o['order']}.{k}: {get(r, k)} ≠ {o[k]}")
        for k in ("stage", "site", "unit", "start", "end"):
            if get(r, k) != o[k]:
                diffs.append(f"{o['y']}/{o['order']}.{k}: {get(r, k)} ≠ {o[k]}")
        if bool(get(r, "copy")) != o["copy"]:
            diffs.append(f"{o['y']}/{o['order']}.copy")
    if len(ctl) != len(orders):
        diffs.append(f"заказов: control {len(ctl)} ≠ график {len(orders)}")

    contexts = [{}]
    contexts += [{"site": s} for s in sorted({o["site"] for o in orders})]
    contexts += [{"model": m} for m in sorted({o["model"] for o in orders})]
    contexts += [{"unit": u} for u in sorted({o["unit"] for o in orders})]
    stock_sites = collections.Counter()
    for it in stock["items"]:
        for s, v in (it.get("bySite") or {}).items():
            stock_sites[s] += v.get("value") or 0
    cases = []
    for ctx in contexts:
        rows = [o for o in orders if in_ctx(o, ctx)]
        years = year_totals(rows)
        ex, pl, bu = control_metrics(rows, as_of)
        pv = provision_metrics(prov, ctx)
        ktg = ktg_metrics(fleet, ctx, cur)
        units_fact = collections.Counter()
        for r in rows:
            if not r["noOrder"] and r["y"] in ("2024", "2025", "2026"):
                units_fact[r["unit"]] += r["fact"]
        cases.append({"ctx": ctx, "years": years, "exec": ex, "plan": pl, "budget": bu, "prov": pv, "ktg": ktg,
                      "levels": levels(years, ex, pl, bu, pv, ktg, cur, elapsed, units_fact)})
    out = {"meta": {"mode": mode, "asOf": as_of, "elapsed": elapsed, "fingerprint": fingerprint(),
                    "orders": len(orders), "controlDiffs": diffs[:50], "controlDiffCount": len(diffs),
                    "stockBySite": dict(stock_sites),
                    "note": "независимый пересчёт tests/verify_analytics.py; обновлять после пересборки витрин"},
           "cases": cases}
    path = os.path.join(ROOT, "tests", "fixtures", "analytics_expected.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"), default=list)
    print(f"режим статусов: {mode}; заказов {len(orders)}; контекстов {len(cases)}; "
          f"расхождений с control.json: {len(diffs)}")
    for x in diffs[:10]:
        print("  ", x)
    print(f"→ {os.path.relpath(path, ROOT)} ({os.path.getsize(path) / 1e3:.0f} КБ)")
    return 1 if diffs else 0


if __name__ == "__main__":
    sys.exit(main())
