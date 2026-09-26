#!/usr/bin/env python3
"""
Сводка БДО (техместа и ЕО) по всем заказам ТОРО для вкладки «Методология SAP ТОиР» → data/bdo_summary.json.

  python3 build/build_bdo_summary.py <TOPO/pm06_meta/bdo> <out_dir>

По БЕ: число ТМ на каждом уровне, узлы 2-го уровня (производства) с числом ТМ и примерами объектов,
глубина технологической позиции машин; по ЕО — типы (первое слово имени), перемонтаж; качество данных (meta).
"""
import json, os, sys, collections, re

BE = {"03": "АО «Полюс Вернинское»", "04": "АО «Полюс Алдан»", "05": "АО «Полюс Магадан»", "06": "ООО «Полюс Сухой Лог»", "11": "АО «Полюс Красноярск»"}


def main(src, out):
    tm = json.load(open(os.path.join(src, "tm.json"), encoding="utf-8"))
    eo = json.load(open(os.path.join(src, "eo.json"), encoding="utf-8"))
    nodes, meta = tm["nodes"], tm["meta"]
    be = {}
    for c, v in nodes.items():
        p = c.split("-")
        if p[0] not in BE:
            continue
        b = be.setdefault(p[0], {"name": BE[p[0]], "levels": collections.Counter(), "named": 0, "l2": {}, "orders": 0})
        if v[5]:
            b["levels"][len(p)] += 1; b["named"] += 1; b["orders"] += v[5]
        if len(p) >= 2:
            k = "-".join(p[:2])
            l2 = b["l2"].setdefault(k, {"tm": 0, "orders": 0, "samples": collections.Counter()})
            if v[5]:
                l2["tm"] += 1; l2["orders"] += v[5]
                if len(p) >= 4 and v[0]:
                    l2["samples"][re.sub(r"\s*№.*$", "", v[0]).strip()[:40]] += 1
    out_be = {}
    for k, b in sorted(be.items()):
        out_be[k] = {"name": b["name"], "tm": b["named"], "orders": b["orders"], "levels": dict(sorted(b["levels"].items())),
                     "l2": [{"code": c, "tm": x["tm"], "orders": x["orders"], "samples": [s for s, _ in x["samples"].most_common(4)]}
                            for c, x in sorted(b["l2"].items(), key=lambda kv: -kv[1]["tm"]) if x["tm"]][:12]}
    types = collections.Counter()
    for e, v in eo["eo"].items():
        types[re.split(r"[\s.]", v[0].strip())[0] or "—"] += 1
    moved = [(e, v[0], v[1]) for e, v in eo["eo"].items() if len(set(v[1].values())) > 1]
    mtypes = collections.Counter(re.split(r"[\s.]", n.strip())[0] for _, n, _ in moved)
    res = {"meta": {k: meta[k] for k in ("source", "orders", "tm", "nodes", "eo", "noObjectOrders", "noObjectKinds", "eoWithoutTm", "tmWithSeveralEo", "eoMoved", "levels", "rule")},
           "be": out_be, "eoTypes": types.most_common(20), "movedTypes": mtypes.most_common(10),
           "movedExamples": [[e, n, t] for e, n, t in moved if n.startswith(("Ковш", "ДВС", "Мотор-колесо", "ЭД"))][:8]}
    with open(os.path.join(out, "bdo_summary.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, separators=(",", ":"))
    print("bdo_summary.json:", {k: v["tm"] for k, v in out_be.items()}, "ЕО", meta["eo"])


if __name__ == "__main__":
    main(*sys.argv[1:3])
