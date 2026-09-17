#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Реестр чертежей WK — маршрут C из плана («Чертежи каталога: три маршрута»).

Два независимых источника номера в имени файла, БЕЗ OCR и без разбора
формата LinkOme:
  1. Предразбитые постраничные PDF каталога WK-35
     («2. Каталог/Мех», «2. Каталог/Элек») — 321 файл, имя = каталожный
     номер + № листа + № исходного чертежа.
  2. DWG-чертежи WK-35, переведённые на русский («Каталог(новый)»,
     «Конструкторская документация/Чертежи деталей WK-35») — 205 файлов,
     то же именование.

Для листов из общего каталога-скана (WK-20, WK-20C, большие PDF без
постраничного разбиения) номер не в имени файла — для них нужен OCR
штампа (build_drawings_ocr.py, отдельный шаг с проверкой качества) или
экспорт из LinkOne Viewer (маршрут A). Здесь они не разбираются.

Выход: data/drawings.json — каталожный номер -> список файлов (путь,
тип, формат), плюс покрытие относительно tree.json и catalog.json.

Запуск:
  git -C <repo> ls-tree -r -l origin/rawdata "rawdata/АТ майнинг/" \
    | python3 build/build_drawings.py <tree.json> <catalog.json> <out_dir>
"""
import sys, os, re, json
from collections import defaultdict

HEURISTIC_RE = re.compile(r"^(K\d{4}(?:\.\d{1,3}){0,6})", re.I)


def extract_num(filename, valid_nums):
    """Имя файла = <номер>-<лист>-<чертёж-ref>[_описание].<ext>, а дефис
    иногда — легитимная часть самого номера (например 'K1605.07.02.00-01').
    Без словаря это неразличимо, поэтому сперва ищем среди префиксов имени
    файла, разрезанного по дефису, САМЫЙ ДЛИННЫЙ, что есть в известных
    номерах (объединение tree.json и catalog.json) — это надёжное
    совпадение ("dict"). Если словарь молчит (там 2299+3042 номеров —
    подмножество полного состава машины, у остального BOM просто нет
    записи ни в ведомости взаимозаменяемости, ни в прайсе), берём число
    точек в номере до первого дефиса — это уже неподтверждённая, но
    вероятная деталь ("heuristic"), дефис и то, что после него, в BOM WK
    почти всегда метаданные (лист/чертёж), не часть номера."""
    base = os.path.splitext(filename)[0].strip()
    base = re.sub(r"_.*$", "", base)
    if not re.match(r"^[0-9A-ZА-Я]", base.upper()):
        return None, None
    tokens = base.split("-")
    for n in range(len(tokens), 0, -1):
        cand = "-".join(tokens[:n]).upper()
        if cand in valid_nums:
            return cand, "dict"
    m = HEURISTIC_RE.match(base.upper())
    if m:
        return m.group(1), "heuristic"
    return None, None


def main():
    if len(sys.argv) < 4:
        print("usage: git ls-tree ... | build_drawings.py <tree.json> <catalog.json> <out_dir>", file=sys.stderr)
        sys.exit(1)
    tree_path, catalog_path, out_dir = sys.argv[1:4]
    os.makedirs(out_dir, exist_ok=True)

    tree_nums = {n["num"] for n in json.load(open(tree_path, encoding="utf-8"))["nodes"]}
    cat_arts = {i["art"] for i in json.load(open(catalog_path, encoding="utf-8"))["items"]}
    valid_nums = tree_nums | cat_arts

    # источники, где номер детали — начало имени файла (проверено вручную)
    SOURCE_DIRS = (
        "2. Каталог/Мех", "2. Каталог/Элек",
        "Каталог(новый)", "Конструкторская документация/Чертежи деталей WK-35",
        "Конструкторская документация/Чертежи крупных деталей",
    )

    by_num = defaultdict(list)
    total_seen = 0
    for line in sys.stdin:
        line = line.rstrip("\n")
        parts = line.split("\t")
        if len(parts) != 2:
            continue
        meta, path = parts
        m = meta.split()
        if len(m) < 4 or m[1] != "blob":
            continue
        if not any(sd in path for sd in SOURCE_DIRS):
            continue
        ext = os.path.splitext(path)[1].lower()
        if ext not in (".pdf", ".dwg", ".dxf"):
            continue
        total_seen += 1
        base = os.path.basename(path)
        num, method = extract_num(base, valid_nums)
        if not num:
            continue
        by_num[num].append({"path": path, "ext": ext[1:], "method": method})

    tree_covered = sum(1 for n in tree_nums if n in by_num)
    cat_covered = sum(1 for a in cat_arts if a in by_num)
    n_dict = sum(1 for v in by_num.values() if any(f["method"] == "dict" for f in v))
    n_heur = len(by_num) - n_dict

    result = {
        "meta": {
            "src": "rawdata/АТ майнинг — файлы с номером в имени (без OCR)",
            "filesSeen": total_seen, "filesWithNumber": sum(len(v) for v in by_num.values()),
            "distinctNumbers": len(by_num),
            "distinctNumbersDict": n_dict, "distinctNumbersHeuristic": n_heur,
            "treeNodesCovered": tree_covered, "treeNodesTotal": len(tree_nums),
            "catalogArtCovered": cat_covered, "catalogArtTotal": len(cat_arts),
            "note": "Остальное (WK-20, WK-20C, большие сканы-каталоги) требует OCR "
                    "штампа либо экспорта из LinkOne Viewer — не входит в этот реестр.",
        },
        "byNum": {k: v for k, v in by_num.items()},
    }
    with open(os.path.join(out_dir, "drawings.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    print(f"файлов просмотрено: {total_seen}, с распознанным номером: {result['meta']['filesWithNumber']}")
    print(f"уникальных номеров: {len(by_num)}  (подтверждено словарём: {n_dict}, только эвристика: {n_heur})")
    print(f"покрытие дерева (tree.json): {tree_covered} из {len(tree_nums)} ({100*tree_covered/len(tree_nums):.1f}%)")
    print(f"покрытие прайса (catalog.json): {cat_covered} из {len(cat_arts)} ({100*cat_covered/len(cat_arts):.1f}%)")


if __name__ == "__main__":
    main()
