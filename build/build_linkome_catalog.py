#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Разбор книг LinkOme в реальный состав узлов — не проекция по именам файлов
(build_linkome_index.py), а настоящее содержимое: строки позиций с номером
детали, наименованием (кит./рус.) и количеством.

Формат LinkOne (= LinkOme, тот же контейнер, что у Komatsu, Schramm, Cat,
Cummins) был разобран в соседней песочнице KOMATSU_PARTS_BOOK —
build/linkone/ здесь портирован оттуда (container.py, lzh.py, book.py) с
добавлением кодовой страницы 936 (GBK — китайские иероглифы; у книг WK в
том же пуле строк вперемешку живёт и кириллица, `gbk` в Python декодирует
и то, и другое). Растровые чертежи (.ilg) этим декодером НЕ читаются —
структура контейнера у поставщика WK (Тайюань) отличается от чертежей
Komatsu (переменная длина заголовка, смещение начала LZH-цепочки не
зафиксировано на 78-м байте, а само содержимое после распаковки не
собирается в валидный CCITT Group 4 ни при одном из проверенных вариантов
смещения/порядка бит/фотометрии) — см. quality.json.

    python3 build/unpack_linkome.py <rawdata_dir> work/linkome
    python3 build/build_linkome_catalog.py work/linkome data/tree.json \\
        data/catalog.json data/fleet_books.json data/
"""
import glob
import json
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from linkone import book as linkone_book
from ekmtr_match import norm


CODE_RE = re.compile(r"^(K\d{3,4})[A-Za-z]?$")


def _guess_code(work_dir, root):
    """Код книги — верхняя папка work/linkome/<код>/…, заданная
    unpack_linkome.py (K1637, K1641, ..., K1626a/b/c — три архива одной
    книги K1626 на разные борта, суффикс a/b/c отбрасывается)."""
    rel = os.path.relpath(root, work_dir)
    top = rel.split(os.sep, 1)[0]
    m = CODE_RE.match(top)
    return m.group(1) if m else top


def load_books(work_dir):
    """Разобрать все книги, отбросив дублирующие архивы (K1626 роздан по
    трём архивам на разные борта, содержимое книги одно и то же; у K1839
    в архиве встретилась двойная вложенность одной и той же книги)."""
    seen_sig = {}
    books = {}
    for bbi_path in sorted(glob.glob(os.path.join(work_dir, "**", "book.bbi"),
                                      recursive=True)):
        root = os.path.dirname(bbi_path)
        try:
            b = linkone_book.Book(root)
        except Exception as e:
            print(f"  пропуск {root}: {e}", file=sys.stderr)
            continue
        sig = (b.model, len(b.pages))
        if sig in seen_sig:
            continue
        seen_sig[sig] = root
        books[_guess_code(work_dir, root)] = b
    return books


def main():
    if len(sys.argv) != 6:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    work_dir, tree_path, catalog_path, fleet_books_path, out_dir = sys.argv[1:6]

    tree = json.load(open(tree_path, encoding="utf-8"))
    tree_nums = {norm(n["num"]) for n in tree["nodes"]}
    catalog = json.load(open(catalog_path, encoding="utf-8"))
    cat_arts = {norm(i["art"]) for i in catalog["items"]}
    fleet_rows = json.load(open(fleet_books_path, encoding="utf-8"))["rows"]
    units_by_book = defaultdict(list)
    for r in fleet_rows:
        if r.get("book"):
            units_by_book[r["book"]].append(f"{r.get('garage', '?')} ({r.get('site', '?')})")

    print("Разбор книг…")
    books = load_books(work_dir)
    print(f"  {len(books)} книг: {', '.join(sorted(books))}")

    out_books = {}
    by_part = defaultdict(list)      # normalized part -> [{book, page, ...}]
    page_ids_norm = set()
    total_pages = total_rows = fail_pages = 0

    for code, b in sorted(books.items()):
        pages_out = []
        for pg in b.pages:
            total_pages += 1
            page_ids_norm.add(norm(pg["id"]))
            try:
                full = b.page(pg["id"])
            except Exception:
                fail_pages += 1
                continue
            rows_out = []
            for r in full["rows"]:
                if not r["part"] and not r["name"]:
                    continue
                total_rows += 1
                row = {"item": r["item"], "part": r["part"], "name": r["name"],
                       "qty": r["qty"]}
                if r["sn"]:
                    row["sn"] = r["sn"]
                if r["link"]:
                    row["link"] = r["link"]
                if r["book"]:
                    row["refBook"] = r["book"]
                rows_out.append(row)
                if r["part"]:
                    by_part[norm(r["part"])].append({
                        "book": code, "page": pg["id"],
                        "pageTitle": full["title"] or pg["name"],
                        "name": r["name"], "qty": r["qty"], "raw": r["part"],
                    })
            pages_out.append({
                "id": pg["id"], "name": pg["name"], "title": pg["title"] or full["title"],
                "kids": pg["kids"], "rows": rows_out,
            })
        out_books[code] = {
            "title": b.title, "model": b.model, "codepage": b.codepage,
            "units": units_by_book.get(code, []),
            "rootPage": b.root_page, "pages": pages_out,
        }
        print(f"  {code}: {len(b.pages)} страниц, {sum(len(p['rows']) for p in pages_out)} строк")

    tree_matched = tree_nums & page_ids_norm
    part_norms = set(by_part.keys())
    tree_matched_by_part = tree_nums & part_norms
    cat_matched_by_part = cat_arts & part_norms

    result = {
        "meta": {
            "src": "rawdata/LinkOme, ветка rawdata — разбор формата LinkOne "
                   "(container.py/lzh.py/book.py портированы из песочницы "
                   "KOMATSU_PARTS_BOOK, кодовая страница 936 добавлена для WK)",
            "books": len(out_books),
            "pagesTotal": total_pages, "pagesFailed": fail_pages,
            "rowsTotal": total_rows, "distinctParts": len(part_norms),
            "treeNodesCoveredByPage": len(tree_matched), "treeNodesTotal": len(tree_nums),
            "treeNodesCoveredByPart": len(tree_matched_by_part),
            "catalogArtCoveredByPart": len(cat_matched_by_part), "catalogArtTotal": len(cat_arts),
            "note": "Реальные строки позиций (номер, наименование, количество), "
                    "не проекция по именам файлов. Растровые чертежи (.ilg) пока "
                    "не декодируются — контейнер читается, содержимое CCITT G4 "
                    "не собирается (см. quality.json).",
        },
        "books": {c: {"title": v["title"], "model": v["model"], "units": v["units"],
                       "pageCount": len(v["pages"])}
                  for c, v in out_books.items()},
        "pages": {f"{c}|{p['id']}": p for c, v in out_books.items() for p in v["pages"]},
        "byPart": dict(by_part),
    }
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "linkome_catalog.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    print(f"\nстраниц: {total_pages} (не открылось {fail_pages}), строк: {total_rows}, "
          f"уникальных номеров: {len(part_norms)}")
    print(f"дерево по номеру страницы: {len(tree_matched)}/{len(tree_nums)} "
          f"({100 * len(tree_matched) / len(tree_nums):.1f}%)")
    print(f"дерево по номеру детали в строке: {len(tree_matched_by_part)}/{len(tree_nums)} "
          f"({100 * len(tree_matched_by_part) / len(tree_nums):.1f}%)")
    print(f"каталог по номеру детали в строке: {len(cat_matched_by_part)}/{len(cat_arts)} "
          f"({100 * len(cat_matched_by_part) / len(cat_arts):.1f}%)")


if __name__ == "__main__":
    main()
