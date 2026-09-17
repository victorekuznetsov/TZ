#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Индекс листов LinkOme — БЕЗ декодирования формата.

Тело файлов .bli/.ilg сжато закрытым энтропийным кодером (см. quality.json
и раздел «Чертежи» плана) — это разобрано и не поддаётся стандартным
алгоритмам. Но каждая книга — обычный zip, и **имя файла внутри архива**
(например 'ck1601.03.20.00.bli') читается без декодирования тела: это и
есть номер листа/узла. Даёт точную проекцию покрытия каталога чертежами
LinkOme — то, что откроется, если маршрут A (LinkOne Viewer) или B
(разбор формата) когда-нибудь заработает, — не дожидаясь самого разбора.

Выход: data/linkome_sheets.json

Запуск (для каждой книги — путь к собранному .zip):
  python3 build/build_linkome_index.py <tree.json> <catalog.json> \
      <fleet_books.json> <out_dir> <book1=path1.zip> <book2=path2.zip> ...
"""
import sys, os, re, json, zipfile
from collections import defaultdict

NODE_RE = re.compile(r"^[a-z]?(k\d{3,4}(?:\.\d{1,3}){0,6})", re.I)


def sheet_num(name):
    base = os.path.splitext(os.path.basename(name))[0]
    m = NODE_RE.match(base)
    return m.group(1).upper() if m else None


def main():
    if len(sys.argv) < 6:
        print("usage: build_linkome_index.py <tree.json> <catalog.json> "
              "<fleet_books.json> <out_dir> <book=path.zip>...", file=sys.stderr)
        sys.exit(1)
    tree_path, catalog_path, books_path, out_dir = sys.argv[1:5]
    book_args = sys.argv[5:]
    os.makedirs(out_dir, exist_ok=True)

    tree_nums = {n["num"] for n in json.load(open(tree_path, encoding="utf-8"))["nodes"]}
    cat_arts = {i["art"] for i in json.load(open(catalog_path, encoding="utf-8"))["items"]}
    fleet_rows = json.load(open(books_path, encoding="utf-8"))["rows"]
    units_by_book = defaultdict(list)
    for r in fleet_rows:
        if r.get("book"):
            units_by_book[r["book"]].append(f"{r.get('garage','?')} ({r.get('site','?')})")

    by_book = defaultdict(set)  # книга может иметь несколько архивов (разные борта)
    all_nums = set()
    for arg in book_args:
        book, path = arg.split("=", 1)
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                if info.filename.lower().endswith((".bli", ".ilg")):
                    n = sheet_num(info.filename)
                    if n:
                        by_book[book].add(n)
        all_nums |= by_book[book]
    by_book = {b: sorted(v) for b, v in by_book.items()}

    tree_covered = sorted(n for n in tree_nums if n in all_nums)
    cat_covered = sorted(a for a in cat_arts if a in all_nums)

    result = {
        "meta": {
            "src": "rawdata/LinkOme — имена файлов внутри zip, БЕЗ декодирования тела .bli/.ilg",
            "books": len(by_book),
            "sheetsTotal": sum(len(v) for v in by_book.values()),
            "distinctNumbers": len(all_nums),
            "treeNodesCovered": len(tree_covered), "treeNodesTotal": len(tree_nums),
            "catalogArtCovered": len(cat_covered), "catalogArtTotal": len(cat_arts),
            "note": "Это ПРОЕКЦИЯ покрытия: номер числится в книге LinkOme, но сам "
                    "чертёж пока не извлекается — блокер декодирования не снят.",
        },
        "byBook": {b: {"sheets": len(v), "units": units_by_book.get(b, []), "nums": v}
                   for b, v in by_book.items()},
        "treeCovered": tree_covered, "catalogCovered": cat_covered,
    }
    with open(os.path.join(out_dir, "linkome_sheets.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    print(f"книг: {len(by_book)}  листов всего: {result['meta']['sheetsTotal']}  уникальных номеров: {len(all_nums)}")
    for b, v in sorted(by_book.items()):
        print(f"  {b}: {len(v)} листов, борта: {units_by_book.get(b, [])}")
    print(f"\nпокрытие дерева: {len(tree_covered)} из {len(tree_nums)} ({100*len(tree_covered)/len(tree_nums):.1f}%)")
    print(f"покрытие прайса: {len(cat_covered)} из {len(cat_arts)} ({100*len(cat_covered)/len(cat_arts):.1f}%)")


if __name__ == "__main__":
    main()
