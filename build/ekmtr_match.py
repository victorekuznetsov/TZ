#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Общая утилита сопоставления каталожных номеров WK с кодами ЕКМТР.
Использует mtr.json (витрина TOPO) и его группу ППЗ 3.1.2.7
«Запчасти к экскаваторам WK».

extract_wk_group(mtr) -> список {code, name, cat, mf}
build_index(wk_group) -> (by_cat, by_name_sub) для сопоставления
match(article, article2, by_cat, by_name_sub) -> (code, method) | (None, None)
"""
import re

NORM_RE = re.compile(r"[^0-9A-ZА-Я]")


def norm(s):
    return NORM_RE.sub("", str(s or "").upper())


def extract_wk_group(mtr):
    ppz, ppzi = mtr["ppz"], mtr["ppzi"]
    ek, nm, cat, mf, mfi = mtr["ek"], mtr["nm"], mtr["cat"], mtr["mf"], mtr["mfi"]
    gi = {i for i, n in enumerate(ppz) if "WK" in n}
    out = []
    for i, g in enumerate(ppzi):
        if g in gi:
            out.append({
                "code": ek[i], "name": nm[i], "cat": cat[i] or "",
                "mf": mf[mfi[i]] if mfi[i] < len(mf) else "",
            })
    return out


def build_index(wk_group):
    by_cat = {}
    by_name_sub = []  # (normalized_name, code) — для TZ-суффиксных наименований
    for e in wk_group:
        if e["cat"]:
            by_cat.setdefault(norm(e["cat"]), []).append(e["code"])
        if re.search(r"\bTZ\s*$", e["name"] or ""):
            by_name_sub.append((norm(e["name"]), e["code"]))
    return by_cat, by_name_sub


def match(article, article2, by_cat, by_name_sub):
    """Возвращает (code, method, ambiguous) или (None, None, False)."""
    candidates = []
    for art in (article, article2):
        if not art:
            continue
        na = norm(art)
        if not na:
            continue
        if na in by_cat:
            for c in by_cat[na]:
                candidates.append((c, "cat"))
        if len(na) >= 5:
            for nn, code in by_name_sub:
                if na in nn:
                    candidates.append((code, "name"))
    if not candidates:
        return None, None, False
    codes = sorted({c for c, _ in candidates})
    method = candidates[0][1]
    return codes[0], method, len(codes) > 1
