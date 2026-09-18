#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Строит парк WK: борт → площадка → комплектация (книга LinkOme/дерева) →
КТГ/КИО помесячно — из витрины TOPO (ktg.json) и связки книга↔борт
(fleet_books.json, построен build_tree.py из «Тех парк»).

Дубли карточек в ktg.json (одна и та же единица с двумя записями, одна из
них без КТГ) схлопываются: берётся запись с непустым КТГ.

Выход: data/fleet.json

Запуск:
  python3 build/build_fleet.py <ktg.json> <fleet_books.json> <out_dir>
"""
import sys, os, re, json
from collections import defaultdict

WK_RE = re.compile(r"WK-?\d", re.I)

# Площадки: в ktg.json лежит только код МВЗ, названия к нему нет. Расшифровка
# взята из витрины TOPO (cube.json, поле `sites`) — она собрана из той же
# выгрузки SAP, так что коды совпадают один в один. Держим здесь, а не в
# ktg.json, чтобы не править чужую витрину.
SITES = {
    "1100": "Красноярск / Еруда",
    "1200": "Вернинское / Сухой Лог",
    "1300": "Алдан",
    "1400": "Магадан",
}


def garage_no(name):
    m = re.search(r"№\s*([0-9]+[A-ZА-Я]?)\s*$", name.strip())
    return m.group(1) if m else None


def garage_key(g):
    """Нормализует гаражный номер для сопоставления книг: снимает ведущие
    нули ('02' -> '2'), буквенный хвост оставляет как есть."""
    if g is None:
        return None
    m = re.match(r"0*([0-9]+)([A-ZА-Я]?)$", str(g).strip().upper())
    if not m:
        return str(g).strip().upper()
    return m.group(1) + m.group(2)


def main():
    if len(sys.argv) < 4:
        print("usage: build_fleet.py <ktg.json> <fleet_books.json> <out_dir>", file=sys.stderr)
        sys.exit(1)
    ktg_path, books_path, out_dir = sys.argv[1:4]
    os.makedirs(out_dir, exist_ok=True)

    ktg = json.load(open(ktg_path, encoding="utf-8"))
    books = json.load(open(books_path, encoding="utf-8"))["rows"]
    months = ktg["months"]

    wk = [e for e in ktg["eo"] if WK_RE.search(e.get("md") or "") or WK_RE.search(e.get("e") or "")]

    # схлопываем ЛИТЕРАЛЬНЫЕ дубли карточек (та же площадка + то же имя борта):
    # в ktg.json у части единиц по две записи, одна без КТГ — берём с КТГ.
    by_key = {}
    for e in wk:
        key = (e["s"], e["e"])
        cur = by_key.get(key)
        if cur is None or (cur.get("p") is None and e.get("p") is not None):
            by_key[key] = e

    book_by_key = {}
    for r in books:
        if r.get("site") and r.get("garage"):
            book_by_key[(r["site"], garage_key(r["garage"]))] = r

    units = []
    matched_books = 0
    for (site, name), e in by_key.items():
        garage = garage_no(name)
        b = book_by_key.get((site, garage_key(garage))) if garage else None
        if b:
            matched_books += 1
        units.append({
            "site": site, "siteName": SITES.get(site, site),
            "garage": garage, "model": e.get("md"),
            "name": name, "manufacturer": e.get("mk"),
            "ktg": e.get("p"), "kio": e.get("a"),
            "ktgByMonth": e.get("pm"), "kioByMonth": e.get("am"),
            "book": b["book"] if b else None,
            "serial": b["serial"] if b else None,
        })

    result = {
        "meta": {
            "src": os.path.basename(ktg_path),
            "months": months,
            "sites": SITES,
            "units": len(units),
            "matchedToBook": matched_books,
            "unmatchedToBook": len(units) - matched_books,
        },
        "units": sorted(units, key=lambda u: (u["model"], u["site"], u["garage"])),
    }
    with open(os.path.join(out_dir, "fleet.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    print(f"единиц WK: {len(units)} (после схлопывания дублей)")
    print(f"  связано с книгой комплектации: {matched_books} из {len(units)}")
    by_model = defaultdict(int)
    for u in units: by_model[u["model"]] += 1
    print("  по моделям:", dict(by_model))
    unmatched = [u for u in units if not u["book"]]
    if unmatched:
        print(f"  без книги (нет в «Тех парк» или новый борт): {[u['name'] for u in unmatched]}")


if __name__ == "__main__":
    main()
