"""Refresh interchange evidence and repair legacy undated-only verdicts.

Usage: python build/refresh_audit.py source.xlsx data/
Does not reallocate stock or change plan quantities.
"""
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
import openpyxl
from build_tree import parse_sheet, build_interchange_groups
from build_provision import as_of


def write(data_dir, name, value):
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    (data_dir / (name + ".json")).write_text(raw, encoding="utf-8")
    safe = raw.replace("</", "<\\/")
    (data_dir / (name + ".local.js")).write_text(
        'window.__DATA__=window.__DATA__||{};window.__DATA__["' + name + '"]=' + safe + ';\n', encoding="utf-8")


def main():
    source, data_dir = Path(sys.argv[1]), Path(sys.argv[2])
    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    evidence, nodes = [], {}
    for name in ("WK-20", "WK-20C", "WK-35"):
        parse_sheet(wb[name], name, nodes, evidence)
    wb.close()
    groups, candidates = build_interchange_groups(evidence)
    result = {
        "meta": {"source": source.name, "groups": len(groups),
                 "partsInGroups": len({p for g in groups for p in g}), "unmarkedRows": len(candidates)},
        "groups": groups,
        "evidence": [g for g in evidence if g["interchangeable"]],
        "sourceRows": [g for g in evidence if not g["interchangeable"]],
        "candidates": [{"parts": [p["num"] for p in g["parts"]], "note": g["note"],
                        "sheet": g["sheet"], "row": g["row"]} for g in candidates],
    }
    write(data_dir, "interchange", result)
    p = json.loads((data_dir / "provision.json").read_text())
    stock = json.loads((data_dir / "stock.json").read_text())
    today = as_of(stock["meta"])
    changed = 0
    for item in p["items"]:
        if item["verdict"] != "covered" or sum(item[k] for k in ("gap", "late", "undated")) <= 1e-9:
            continue
        fo = item.get("firstOpen")
        verdict, slip = "nodate", None
        if fo:
            start = datetime.strptime(fo[:10], "%Y-%m-%d")
            eta = today + timedelta(days=item["leadDays"])
            if start < today:
                verdict, slip = "past", (today - start).days
            elif eta <= start:
                verdict = "inTime"
            else:
                verdict, slip = "late", (eta - start).days
        item.update(verdict=verdict, slipDays=slip)
        changed += 1
    write(data_dir, "provision", p)
    print(json.dumps({"evidence": len(result["evidence"]), "sourceRows": len(result["sourceRows"]),
                      "verdictsCorrected": changed, **result["meta"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
