#!/usr/bin/env python3
import json, re, subprocess
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
def load(name): return json.loads((DATA / f"{name}.json").read_text(encoding="utf-8"))
def alias(v): return re.sub(r"a$", "", re.sub(r"^dk", "k", re.sub(r"^\d+-", "", str(v).lower())))

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
