#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Строит реестр базы знаний из документации АТ-Майнинг (ветка rawdata).
Каталоги в PDF ИСКЛЮЧЕНЫ по правилу пользователя — чертежи берутся из
LinkOme, а не из сканов; каталог PDF остаётся только там, где книги
LinkOme нет (см. data/quality.json и раздел «Чертежи» плана).

Сам список файлов читается из `git ls-tree -r -l <ref> <path>` — реальные
файлы (3,2 ГБ) не копируются в эту ветку, реестр — только метаданные
(путь, класс, модель, размер). Открытие документа — по пути в rawdata.

Выход: data/kb.json

Запуск:
  git -C <repo> ls-tree -r -l origin/rawdata "rawdata/АТ майнинг/" \
    | python3 build/build_kb.py <fleet_books.json> <out_dir>
"""
import sys, os, re, json

CLASS_RULES = [
    (r"каталог|备件|图册", "Каталог (искл. из БЗ — см. LinkOme)"),
    (r"ремонт|repair", "Руководство по ремонту"),
    (r"эксплуатац|operating|operation", "Руководство по эксплуатации"),
    (r"обслуживан|регламент|нормы|ппр|maintenance", "ТО, нормы и регламенты"),
    (r"электр|схем|circuit|diagram|原理图|elcad", "Электросхемы и электрооборудование"),
    (r"смазк|lubric|масл", "Смазка и ГСМ"),
    (r"пневмо|компрессор|осушител", "Пневмосистема и компрессор"),
    (r"пожар|detex|fire", "Противопожарная система"),
    (r"кондицион", "Кондиционирование"),
    (r"барабан", "Кабельный барабан"),
    (r"тормоз|brake|抱闸", "Тормоза"),
    (r"безопасн|safety", "Безопасность"),
    (r"монтаж|сборк|install", "Монтаж и сборка"),
    (r"взаимозаменя|комплект|футеров|вкладыш", "Взаимозаменяемость и комплекты"),
    (r"паспорт", "Паспорта машин"),
]
CAD_EXT = {".dwg", ".dxf", ".bak", ".shx"}
IMG_EXT = {".jpg", ".jpeg", ".gif", ".png"}
DATA_EXT = {".xlsx", ".xls", ".xlsm"}


def classify(path):
    base = os.path.basename(path)
    ext = os.path.splitext(base)[1].lower()
    low = (path + " " + base).lower()
    if ext in CAD_EXT:
        return "Чертежи CAD"
    if ext in IMG_EXT:
        return "Фото"
    if ext in DATA_EXT:
        return "Справочные таблицы"
    for pat, cls in CLASS_RULES:
        if re.search(pat, low):
            return cls
    return "Прочее"


def model_of(path):
    low = path
    for m in ("WK-20C", "WK-35", "WK-20"):
        if m.lower() in low.lower():
            return m
    return None


def main():
    if len(sys.argv) < 3:
        print("usage: git ls-tree -r -l <ref> <path> | build_kb.py <fleet_books.json> <out_dir>", file=sys.stderr)
        sys.exit(1)
    books_path, out_dir = sys.argv[1:3]
    os.makedirs(out_dir, exist_ok=True)

    books = json.load(open(books_path, encoding="utf-8"))["rows"]
    known_serials = {r["serial"] for r in books}

    docs = []
    skipped_catalog = 0
    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line:
            continue
        # формат: <mode> blob <sha>\t<size>\t<path>  (для -l вывод: mode type sha size\tpath)
        parts = line.split("\t")
        if len(parts) != 2:
            continue
        meta, path = parts
        m = meta.split()
        if len(m) < 4 or m[1] != "blob":
            continue
        size = int(m[3]) if m[3] != "-" else 0
        base = os.path.basename(path)
        if base.startswith("~$") or base.startswith("."):
            continue  # временные файлы Word/Excel и служебные — не документы
        cls = classify(path)
        if cls.startswith("Каталог"):
            skipped_catalog += 1
            continue
        rel = path.split("rawdata/АТ майнинг/", 1)[-1]
        docs.append({
            "path": path, "name": os.path.basename(path),
            "class": cls, "model": model_of(path),
            "sizeBytes": size,
            "serialHint": next((s for s in known_serials if s in path), None),
        })

    by_class = {}
    for d in docs:
        by_class[d["class"]] = by_class.get(d["class"], 0) + 1

    result = {
        "meta": {
            "src": "rawdata/АТ майнинг (ветка rawdata) — файлы НЕ хранятся в этой ветке, только реестр",
            "docs": len(docs),
            "skippedCatalogPdf": skipped_catalog,
            "byClass": by_class,
            "totalBytes": sum(d["sizeBytes"] for d in docs),
        },
        "docs": docs,
    }
    with open(os.path.join(out_dir, "kb.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    print(f"документов в реестре: {len(docs)}  (каталогов PDF пропущено: {skipped_catalog})")
    for c, n in sorted(by_class.items(), key=lambda x: -x[1]):
        print(f"  {n:4d}  {c}")


if __name__ == "__main__":
    main()
