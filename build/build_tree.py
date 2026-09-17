#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Строит дерево каталога WK из ведомости взаимозаменяемости узлов и деталей
(rawdata/АТ майнинг/Взаимозаменяемость узлов и деталей экскаваторов WK4.7.xlsx).

Источник — три листа-модели (WK-20, WK-20C, WK-35), в каждом по 2-4 блока
колонок на комплектацию (книгу): K1623/K1626, K1637/K1641, K1839/K1849/K1853/K1866.
Плюс лист «Тех парк» — связка книга → серийный № → гаражный № → площадка.

Выход:
  data/tree.json       — узлы дерева: механизм → узел → деталь, количество
  data/interchange.json — группы взаимозаменяемости между комплектациями
  data/fleet_books.json — книга (комплектация) → серийник → гаражный № → БЕ

Запуск:
  python3 build/build_tree.py <interchangeability.xlsx> data/
"""
import sys, os, re, json
import openpyxl
from collections import defaultdict

BOOK_MODEL = {
    "K1623": "WK-20", "K1626": "WK-20",
    "K1637": "WK-20C", "K1641": "WK-20C",
    "K1839": "WK-35", "K1849": "WK-35", "K1853": "WK-35", "K1866": "WK-35",
}

SITE_NAME = {"ПК": "1100", "ПМ": "1400", "СЛ": "1200"}  # уточняется на этапе связки с fleet


def find_blocks(hdr):
    """Находит начало каждого блока колонок по заголовку 'Каталожный № узла Kxxxx'."""
    blocks = []
    for i, h in enumerate(hdr):
        if not h:
            continue
        m = re.search(r"Каталожный № узла\s*(K\d{4})", str(h).replace("\n", " "))
        if m:
            blocks.append((i - 1, m.group(1)))  # -1: колонка "Каталожный № механизама" идёт перед ней
    return blocks


def find_flag_cols(hdr):
    """Колонки статуса взаимозаменяемости (может быть 1 или 2 на лист)."""
    cols = []
    for i, h in enumerate(hdr):
        if h and "Взаимозамен" in str(h):
            cols.append(i)
    return cols


def parse_sheet(ws, sheet_name, nodes, groups_raw):
    rows = list(ws.iter_rows(min_row=1, values_only=True))
    hdr = list(rows[0])
    blocks = find_blocks(hdr)
    flags = find_flag_cols(hdr)
    note_col = None
    for i, h in enumerate(hdr):
        if h and "Примечание" in str(h):
            note_col = i
    n_new = 0
    for r in rows[1:]:
        if r is None or all(v is None for v in r):
            continue
        row_entries = []  # (book, num, nameZh, nameRu, qty, mechNum, mechName, top)
        for start, book in blocks:
            top_code = r[start] if start < len(r) else None
            node_code = r[start + 1] if start + 1 < len(r) else None
            zh = r[start + 2] if start + 2 < len(r) else None
            ru = r[start + 3] if start + 3 < len(r) else None
            qty = r[start + 4] if start + 4 < len(r) else None
            mech_num = r[start + 5] if start + 5 < len(r) else None
            mech_name = r[start + 6] if start + 6 < len(r) else None
            is_top = False
            num = None
            if top_code and str(top_code).strip():
                num = str(top_code).strip().upper()
                is_top = True
            elif node_code and str(node_code).strip() and str(node_code).strip() != "*":
                num = str(node_code).strip().upper()
            if not num:
                continue
            ru = (str(ru).strip() if ru else "")
            zh = (str(zh).strip() if zh else "")
            mech_name = (str(mech_name).strip() if mech_name else "")
            mech_num = (str(mech_num).strip() if mech_num else "")
            qty_v = None
            if isinstance(qty, (int, float)):
                qty_v = qty
            key = (book, num)
            entry = nodes.get(key)
            if entry is None:
                nodes[key] = {
                    "book": book, "num": num, "model": BOOK_MODEL.get(book, ""),
                    "nameRu": ru, "nameZh": zh, "qty": qty_v,
                    "mechNum": mech_num, "mech": mech_name, "top": is_top,
                    "sheet": sheet_name,
                }
                n_new += 1
            row_entries.append((book, num))
        # статус взаимозаменяемости для этой строки
        flag_vals = []
        for fc in flags:
            v = r[fc] if fc < len(r) else None
            if v and str(v).strip():
                flag_vals.append(str(v).strip())
        note = None
        if note_col is not None and note_col < len(r) and r[note_col]:
            note = str(r[note_col]).strip()
        nums = sorted({n for _, n in row_entries})
        if len(nums) < 2:
            continue
        interchangeable = any(v in ("Да", "Идентичны") for v in flag_vals)
        # тривиальный случай: номера буквально совпадают — тоже взаимозаменяемы
        if len(set(nums)) == 1:
            interchangeable = True
        groups_raw.append({
            "sheet": sheet_name,
            "parts": [{"book": b, "num": n} for b, n in row_entries],
            "interchangeable": interchangeable,
            "flags": flag_vals,
            "note": note,
        })
    return n_new


def parse_fleet_books(ws):
    """Лист «Тех парк»: модель → № каталога → заводской № → гаражный № → БЕ.
    Модель и книга указаны только в первой строке своей группы — переносим
    вперёд на последующие строки той же группы."""
    out = []
    model = None
    book = None
    book_top = None
    for row in ws.iter_rows(min_row=3, values_only=True):
        if row is None:
            continue
        padded = (tuple(row) + (None,) * 6)[:6]
        _, mdl, bt, serial, garage, be = padded
        if mdl and str(mdl).strip():
            model = str(mdl).strip()
        if bt and str(bt).strip():
            book_top = str(bt).strip()
            m = re.match(r"(K\d{4})", book_top.upper())
            book = m.group(1) if m else None
        if not serial:
            continue
        out.append({
            "model": model,
            "book": book,
            "bookTop": str(book_top).strip() if book_top else None,
            "serial": str(serial).strip(),
            "garage": str(garage).strip() if garage else None,
            "be": str(be).strip() if be else None,
            "site": SITE_NAME.get(str(be).strip()) if be else None,
        })
    return out


def build_interchange_groups(groups_raw):
    """Union-find по помеченным взаимозаменяемым парам номеров."""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    candidates = []  # неотмеченные строки — на ручной разбор
    for g in groups_raw:
        nums = sorted({p["num"] for p in g["parts"]})
        if g["interchangeable"]:
            for n in nums[1:]:
                union(nums[0], n)
        else:
            candidates.append(g)

    groups = defaultdict(set)
    for n in parent:
        groups[find(n)].add(n)
    result = [sorted(v) for v in groups.values() if len(v) > 1]
    return result, candidates


def main():
    if len(sys.argv) < 3:
        print("usage: build_tree.py <interchangeability.xlsx> <out_dir>", file=sys.stderr)
        sys.exit(1)
    src, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    nodes = {}
    groups_raw = []
    for name in ("WK-20", "WK-20C", "WK-35"):
        n = parse_sheet(wb[name], name, nodes, groups_raw)
        print(f"  {name}: +{n} новых узлов", file=sys.stderr)
    fleet_books = parse_fleet_books(wb["Тех парк"])
    wb.close()

    groups, candidates = build_interchange_groups(groups_raw)

    mechanisms = sorted({v["mech"] for v in nodes.values() if v["mech"]})
    books = sorted({v["book"] for v in nodes.values()})

    tree = {
        "meta": {
            "src": os.path.basename(src),
            "nodesTotal": len(nodes),
            "mechanisms": len(mechanisms),
            "books": books,
        },
        "mechanisms": mechanisms,
        "books": books,
        "bookModel": BOOK_MODEL,
        "nodes": list(nodes.values()),
    }
    interchange = {
        "meta": {
            "groups": len(groups),
            "partsInGroups": sum(len(g) for g in groups),
            "unmarkedRows": len(candidates),
        },
        "groups": groups,
        "candidates": [
            {"parts": [p["num"] for p in c["parts"]], "note": c["note"]}
            for c in candidates if c["note"]
        ],
    }
    fleet = {"meta": {"rows": len(fleet_books)}, "rows": fleet_books}

    with open(os.path.join(out_dir, "tree.json"), "w", encoding="utf-8") as f:
        json.dump(tree, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(out_dir, "interchange.json"), "w", encoding="utf-8") as f:
        json.dump(interchange, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(out_dir, "fleet_books.json"), "w", encoding="utf-8") as f:
        json.dump(fleet, f, ensure_ascii=False, separators=(",", ":"))

    print(f"\nузлов: {len(nodes)}  механизмов: {len(mechanisms)}  книг: {len(books)}")
    print(f"групп взаимозаменяемости: {len(groups)} ({sum(len(g) for g in groups)} номеров)")
    print(f"строк без явной отметки (кандидаты на разбор): {len(candidates)}")
    print(f"строк борт↔книга: {len(fleet_books)}")


if __name__ == "__main__":
    main()
