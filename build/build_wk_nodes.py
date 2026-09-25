#!/usr/bin/env python3
"""
Заказы ТОРО на ЕО-узлах экскаваторов WK (ковш, рукоять, ЭД, редуктор, бортовой компьютер).

Отбор WK по имени ЕО не видит заказ, если он оформлен не на машину, а на ЕО-узел, смонтированную
на техместе машины. Карта берётся из БДО TOPO (pm06_meta/bdo/wk.json, все заказы PM-06 2022–2027):
заказ → машина (имя ЕО машины на этом ТМ, как в парке отчёта), код ТМ, имя и номер ЕО-узла.

  python3 build/build_wk_nodes.py <TOPO/pm06_meta/bdo/wk.json> <out_dir>
"""
import json, os, sys


def main(src, out_dir):
    w = json.load(open(src, encoding="utf-8"))
    tmf = os.path.join(os.path.dirname(src), "tm.json")          # имена узлов ТМ (если есть заказы на узел)
    tmn = json.load(open(tmf, encoding="utf-8"))["nodes"] if os.path.exists(tmf) else {}
    orders, machines = {}, {}
    for tm, m in sorted(w["machines"].items()):
        mach = sorted(((e, v) for e, v in m["eo"].items() if v["isMachine"]), key=lambda ev: -ev[1]["orders"])
        unit = mach[0][1]["name"] if mach else m["name"]
        machines[tm] = {"unit": unit, "eon": mach[0][0] if mach else "", "tmName": m["name"], "be": m["be"], "chain": [[c, (tmn.get(c) or [""])[0]] for c in m["chain"]],
                        "orders": [[o["order"], o["fy"], o["eo"], o["kind"], o["txt"], round(o["p"] + o["up"], 2), round(o["a"] + o["uf"], 2)]
                                   for o in m["componentOrders"]],
                        "eo": [[e, v["name"], v["isMachine"], v["orders"], v["years"]] for e, v in
                               sorted(m["eo"].items(), key=lambda ev: (not ev[1]["isMachine"], -ev[1]["orders"]))]}
        for o in m["componentOrders"]:
            orders[o["order"]] = [unit, o["tmn"], o["eo"], o["eon"]]
    res = {"meta": {"src": "TOPO pm06_meta/bdo/wk.json — БДО из всех заказов PM-06 2022–2027",
                    "rule": "машина заказа = ЕО с «WK» в имени; иначе — по карте orders: заказ на ЕО-узел на техместе машины",
                    "columns": ["unit", "tm", "node", "nodeEo"], "orders": len(orders), "machines": len(machines)},
           "orders": dict(sorted(orders.items())), "machines": machines}
    with open(os.path.join(out_dir, "wk_nodes.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wk_nodes.json: заказов на узлах {len(orders)}, машин {len(machines)}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
