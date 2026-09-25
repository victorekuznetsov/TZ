# -*- coding: utf-8 -*-
"""Витрина контроля исполнения, планирования и бюджета: data/control.json.

Зерно — заказ ТОРО WK × год выгрузки PM-06 (2024–2027). Для каждого заказа:
план и факт МТР Полюса и МТР подрядчика (УСО), базисные сроки, вид работ,
статья затрат, вид заказа SAP, стадия по статусам PM-06 и набор статусов
планирования, бюджета и закрытия. Всё, что считает вкладки «Аналитика» и
«Контроль отделов» (lib/analytics_core.js), берётся отсюда, из provision,
stock и fleet.

Источники:
  data/schedule_*.local.js      — строки заказов WK (витрина «График · план-факт»)
  <TOPO>/pm06_meta/order_status — системный и пользовательский статус заказа
  data/fleet.json               — площадка борта (как вкладка «Парк»)

Стадия заказа — по тем же правилам, что build_provision.py и PM06_STATUSES.md:
ЗАКР > ТЗКР (ВСБЕ / ПРСЗ / без приёмки) > ДЕБЛ (ФХСМ / в работе / пусто) >
ОТКР (СГГС / на согласовании); без статуса — позиция графика ППР без заказа.

Запуск: python3 build/build_control.py <TOPO>/pm06_meta/order_status data/
"""
import collections
import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
YEARS = ("2024", "2025", "2026", "2027")

# коды, которые нужны контролю (остальные служебные — не храним)
USR_KEEP = ["ПЛАН", "СГПЛ", "ССПЛ", "СГГС",                      # согласование
            "ГОД", "ПТОГ", "ГИП", "УТВГ", "УТВП",                 # годовой план
            "МЕС", "ПТОМ", "УТВМ", "НЕД", "УТВН",                 # месяц / неделя
            "ТКБЕ", "ТРКБ", "КОРБ", "ОТКБ", "СГЛБ", "ПЗТГ", "ПЗТМ",  # бюджет
            "МТРЦ", "МТРН", "СРОЧ", "НВСО", "ТОПЗ", "СОПЗ",       # материалы
            "ПРНТ", "НПРН", "ФХСМ", "ПРСЗ", "НПСЗ", "ВСБЕ",       # приёмка и закрытие
            "КРМТ", "ПЛЗК"]
SYS_KEEP = ["ОТКР", "ДЕБЛ", "ТЗКР", "ЗАКР", "ПДТВ", "ЧПДТ"]


def local_js(path):
    with open(path, encoding="utf-8") as f:
        t = f.read()
    return json.loads(t[t.index("=", t.index("__DATA__[")) + 1:].rstrip().rstrip(";"))


def stage_of(ph, s, u, fact):
    if ph == 0:
        return "noOrder"
    if ph == 4:
        return "closed"
    if ph == 3:
        return "billed" if "ВСБЕ" in u else "accepted" if "ПРСЗ" in u else "techClosed"
    if ph == 2:
        if "ФХСМ" in u:
            return "factDone"
        if fact > 0 or s & {"ПДТВ", "ЧПДТ"} or "ПРНТ" in u:
            return "inWork"
        return "released"
    return "approved" if "СГГС" in u else "approving"


def main():
    status_dir, out_dir = sys.argv[1], sys.argv[2]
    data = os.path.join(ROOT, "data")
    fleet = json.load(open(os.path.join(data, "fleet.json"), encoding="utf-8"))
    unit_site = {u["name"]: u["site"] for u in fleet["units"]}

    status = collections.defaultdict(dict)
    pg_text = {}
    for fn in glob.glob(os.path.join(status_dir, "*.json")):
        d = json.load(open(fn, encoding="utf-8"))
        y = d["meta"]["year"]
        if y not in YEARS:
            continue
        pg_text.update({k: v for k, v in (d.get("pgText") or {}).items() if v})
        for o, v in d["o"].items():
            si, ui, ki, ph, cp = v[:5]
            pg = d["pg"][v[5]] if len(v) > 5 and "pg" in d else ""
            status[y][o] = (ph, cp, d["sys"][si], d["usr"][ui], d["kind"][ki], d["kindText"].get(d["kind"][ki], ""), pg)

    man = local_js(os.path.join(data, "schedule_manifest.local.js"))
    orders = {}
    for n in man["shards"]:
        d = local_js(os.path.join(data, f"{n}.local.js"))
        cols, dic = d["columns"], d["dictionaries"]
        for v in d["rows"]:
            r = {k: (dic[k][v[i]] if k in dic and v[i] is not None else v[i]) for i, k in enumerate(cols)}
            if r["year"] not in YEARS:
                continue
            key = (r["year"], r["order"])
            o = orders.get(key)
            if o is None:
                o = orders[key] = {"y": r["year"], "order": r["order"], "unit": r["unit"], "model": r["model"],
                                   "site": unit_site.get(r["unit"], r["site"]), "plant": r["site"],
                                   "reason": r["reason"] or "", "p": 0.0, "a": 0.0, "up": 0.0, "uf": 0.0,
                                   "starts": [], "ends": [], "works": collections.Counter(), "lines": 0, "bad": 0}
            for k in ("p", "a", "up", "uf"):
                o[k] += r[k] or 0
            if r["start"] and not r["badDate"]:
                o["starts"].append(r["start"])
            if r["end"] and not r["badDate"]:
                o["ends"].append(r["end"])
            o["works"][r["work"]] += (r["p"] or 0) + (r["up"] or 0)
            o["lines"] += 1
            o["bad"] += 1 if r["badDate"] else 0

    missing = 0
    out = []
    for (y, order), o in sorted(orders.items()):
        st = status.get(y, {}).get(order)
        if st is None:
            missing += 1
            ph, cp, sys_s, usr_s, kind, kind_text, pg = 1, 0, "", "", "", "", ""
        else:
            ph, cp, sys_s, usr_s, kind, kind_text, pg = st
        s, u = set(sys_s.split()), set(usr_s.split())
        fact = o["a"] + o["uf"]
        flags = " ".join([c for c in SYS_KEEP if c in s] + [c for c in USR_KEEP if c in u])
        out.append({
            "y": y, "order": order, "unit": o["unit"], "model": o["model"], "site": o["site"], "plant": o["plant"],
            "kind": kind, "kindText": kind_text, "reason": o["reason"],
            "work": o["works"].most_common(1)[0][0] if o["works"] else "",
            "start": min(o["starts"]) if o["starts"] else "", "end": max(o["ends"]) if o["ends"] else "",
            "p": round(o["p"], 2), "a": round(o["a"], 2), "up": round(o["up"], 2), "uf": round(o["uf"], 2),
            "stage": "unknown" if st is None else stage_of(ph, s, u, fact), "copy": int(bool(cp)),
            "flags": flags, "lines": o["lines"], "badDates": o["bad"], "pg": pg,
        })

    cols = ["y", "order", "unit", "model", "site", "plant", "kind", "kindText", "reason", "work", "start", "end",
            "p", "a", "up", "uf", "stage", "copy", "flags", "lines", "badDates", "pg"]
    dict_cols = ["y", "unit", "model", "site", "plant", "kind", "kindText", "reason", "work", "stage", "flags", "pg"]
    dicts = {c: sorted({r[c] for r in out}) for c in dict_cols}
    idx = {c: {v: i for i, v in enumerate(dicts[c])} for c in dict_cols}
    rows = [[idx[c][r[c]] if c in idx else r[c] for c in cols] for r in out]
    prov = json.load(open(os.path.join(data, "provision.json"), encoding="utf-8"))
    result = {
        "meta": {
            "asOf": prov["meta"]["asOf"],
            "years": list(YEARS),
            "grain": "заказ ТОРО WK × год выгрузки PM-06",
            "src": "data/schedule_*.local.js (PM-06 BW) + TOPO pm06_meta/order_status",
            "orders": len(out), "missingStatus": missing,
            "usrCodes": USR_KEEP, "sysCodes": SYS_KEEP,
            "planningGroups": {k: pg_text.get(k, "") for k in sorted({r["pg"] for r in out}) if k},
            "rules": {
                "plan": "план = МТР + УСО (p + up); позиции ППР без заказа (stage noOrder) в план не входят",
                "copy": "у оригинала БЕ, перенесённого копией в «Развитие» (copy=1), неисполненный план не считается: план = min(план, факт)",
                "site": "площадка — по борту (fleet.json); №1228 — по заказу",
                "planning": "pg — группа планирования ТОРО заказа (завод/группа). Оценка планирования АО «Развитие» — только группы 100 Механика и 200 Энергетика; 300–900 — службы БЕ (заказчика)",
            },
        },
        "columns": cols, "dictionaries": dicts, "rows": rows,
    }
    path = os.path.join(out_dir, "control.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    by = collections.Counter(r["y"] for r in out)
    print(f"control.json: {len(out)} заказов {dict(sorted(by.items()))}, без статуса {missing}, "
          f"{os.path.getsize(path) / 1e6:.2f} МБ")


if __name__ == "__main__":
    main()
