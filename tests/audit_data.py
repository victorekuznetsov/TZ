#!/usr/bin/env python3
import json, re, subprocess, sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
def load(name): return json.loads((DATA / f"{name}.json").read_text(encoding="utf-8"))
def alias(v): return re.sub(r"a$", "", re.sub(r"^dk", "k", re.sub(r"^\d+-", "", str(v).lower())))
def near(a, b, tol=1e-6): return abs((a or 0) - (b or 0)) <= tol

def main():
    names = [p.stem for p in DATA.glob("*.json")]
    bundles = {n: load(n) for n in names}
    errors, warnings = [], []
    for name, payload in bundles.items():
        local = DATA / f"{name}.local.js"
        marker = f'window.__DATA__["{name}"]='
        if not local.exists() or marker not in local.read_text(encoding="utf-8"):
            errors.append(f"{name}: missing or invalid local.js")
        else:
            raw = local.read_text(encoding="utf-8").split(marker, 1)[1].strip().removesuffix(";")
            if json.loads(raw) != payload:
                errors.append(f"{name}: JSON and browser bundle differ")
    for name, key in (("catalog", "art"), ("ekmtr_wk", "code"), ("stock", "code")):
        counts = Counter(str(x.get(key, "")) for x in bundles[name]["items"])
        dup = [k for k, v in counts.items() if k and v > 1]
        if dup: errors.append(f"{name}: duplicate {key}: {dup[:10]}")
    codes = {str(x["code"]) for x in bundles["ekmtr_wk"]["items"]}
    bad = {str(x["ekmtr"]) for x in bundles["catalog"]["items"] if x.get("ekmtr") and str(x["ekmtr"]) not in codes}
    if bad: errors.append(f"catalog: unknown EKMTR: {sorted(bad)[:10]}")
    provision = bundles["provision"]
    bad_need = []
    for order in provision.get("orders", []):
        for line in order.get("lines", []):
            if line.get("qty", 0) > max(line.get("planQty", 0), 0) + 1e-9:
                bad_need.append(f'{order.get("order")}:{line.get("code")}')
    if bad_need:
        errors.append(f"provision: open qty exceeds positive plan: {bad_need[:10]}")
    stock = bundles["stock"]
    bad_stock, bad_warehouse, bad_purchase = [], [], []
    for item in stock["items"]:
        if not near(item["qty"], item["availQty"] + item["restrictedQty"]) or not near(item["value"], item["availValue"] + item["restrictedValue"], .02):
            bad_stock.append(item["code"])
        if not near(item["qty"], sum((item.get("byWarehouse") or {}).values())):
            bad_warehouse.append(item["code"])
        purchase = item.get("purchase")
        if purchase and not near(purchase["openQty"], sum((purchase.get("byMonth") or {}).values())):
            bad_purchase.append(item["code"])
    # остаток привязан к площадкам: сумма по площадкам = итог позиции,
    # каждый склад есть в справочнике и имеет площадку
    whs = stock["meta"].get("warehouses") or {}
    bad_site, no_wh, no_site = [], set(), set()
    for item in stock["items"]:
        by_site = item.get("bySite")
        if by_site is None:
            continue
        if not near(item["qty"], sum(o["qty"] for o in by_site.values()), 1e-3) \
                or not near(item["value"], sum(o["value"] for o in by_site.values()), .05) \
                or not near(item["availQty"], sum(o["availQty"] for o in by_site.values()), 1e-3):
            bad_site.append(item["code"])
        for key in item.get("byWarehouse") or {}:
            if key not in whs:
                no_wh.add(key)
            elif not whs[key].get("site"):
                no_site.add(key)
    if bad_site: errors.append(f"stock: site split does not reconcile: {bad_site[:10]}")
    if no_wh: errors.append(f"stock: warehouse missing in meta.warehouses: {sorted(no_wh)[:10]}")
    if no_site: warnings.append(f"stock: warehouse without site: {sorted(no_site)[:10]}")
    # обеспеченность: склад покрывает только свою площадку; возможность
    # перемещения не больше непокрытого к сроку и не больше остатка других
    # площадок после их собственной потребности
    sys.path.insert(0, str(ROOT / "build"))
    from sites import plant_site
    avail_site = {(str(i["code"]), st): o["availQty"] for i in stock["items"] for st, o in (i.get("bySite") or {}).items()}
    used, bad_tr = {}, []
    for order in provision.get("orders", []) + provision.get("closedOrders", []):
        own = plant_site(order.get("site")) or str(order.get("site"))
        for line in order.get("lines", []):
            tr = line.get("transferPotential", 0) or 0
            open_q = line.get("late", 0) + line.get("undated", 0) + line.get("gap", 0)
            if tr > open_q + 1e-6 or not near(tr, sum((line.get("transferFrom") or {}).values()), 1e-3) \
                    or own in (line.get("transferFrom") or {}):
                bad_tr.append(f'{order.get("order")}:{line.get("code")}')
            k = (str(line.get("code")), own)
            used[k] = used.get(k, 0) + line.get("fromStock", 0)
            for st, q in (line.get("transferFrom") or {}).items():
                used[(str(line.get("code")), st)] = used.get((str(line.get("code")), st), 0) + q
    over = [f"{c}@{st}" for (c, st), q in used.items() if avail_site and q > avail_site.get((c, st), 0) + 1e-6]
    if bad_tr: errors.append(f"provision: transfer potential inconsistent: {bad_tr[:10]}")
    if over: errors.append(f"provision: stock taken over site availability: {over[:10]}")
    if bad_stock: errors.append(f"stock: gross != available + restricted: {bad_stock[:10]}")
    if bad_warehouse: errors.append(f"stock: warehouse quantities do not reconcile: {bad_warehouse[:10]}")
    if bad_purchase: errors.append(f"purchase: schedule does not reconcile to open qty: {bad_purchase[:10]}")
    wk = provision["meta"]["wk"]
    orders = provision.get("orders", [])
    if not near(wk["value"], sum(o["value"] for o in orders), .02) or not near(wk["qty"], sum(o["qty"] for o in orders)):
        errors.append("provision: order totals do not reconcile to WK meta")
    for suffix in ("", "Qty"):
        total_key = "value" if suffix == "" else "qty"
        if not near(wk[total_key], sum(wk[k + suffix] for k in ("fromStock", "fromBuy", "late", "undated", "gap")), .05):
            errors.append(f"provision: {total_key} buckets do not reconcile")
    uso = bundles["uso_wk"]
    for key in ("planValue", "factValue", "openValue"):
        if not near(uso["meta"][key], sum(o[key] for o in uso["orders"]), .02):
            errors.append(f"uso_wk: {key} does not reconcile")
    if uso["meta"]["rows"] != sum(len(o["lines"]) for o in uso["orders"]):
        errors.append("uso_wk: line count does not reconcile")
    pages = bundles["linkome_catalog"]["pages"]
    aliases = {f'{k.split("|",1)[0].lower()}|{alias(k.split("|",1)[1])}' for k in pages}
    unresolved = []
    for key, page in pages.items():
        book = key.split("|", 1)[0].lower()
        for row in page.get("rows") or []:
            if row.get("link") and f'{book}|{alias(row["link"])}' not in aliases: unresolved.append(f'{key}->{row["link"]}')
    if unresolved: warnings.append(f"linkome: {len(unresolved)} unresolved source links: {unresolved[:10]}")
    tracked = set(subprocess.check_output(["git", "ls-tree", "-rz", "--name-only", "HEAD", "media/kb"], cwd=ROOT).decode().split("\0"))
    missing, sparse = [], 0
    for doc in bundles["kb"]["docs"]:
        raw = str(doc.get("path", "")); rel = raw[8:] if raw.startswith("rawdata/") else raw
        if not (ROOT / "media" / "kb" / rel).exists():
            if "media/kb/" + rel in tracked:
                sparse += 1
            else:
                missing.append(rel)
    if sparse: print(f"INFO: {sparse} media paths verified in Git tree only (sparse checkout); file contents not checked")
    if missing: errors.append(f"kb: {len(missing)} missing files: {missing[:5]}")
    print(f"Checked {len(names)} bundles, {len(bundles['catalog']['items'])} catalog items, {len(bundles['kb']['docs'])} documents")
    for x in warnings: print("WARNING:", x)
    for x in errors: print("ERROR:", x)
    print(f"Result: {len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0
if __name__ == "__main__": raise SystemExit(main())
