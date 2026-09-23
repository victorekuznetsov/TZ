#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Профиль ВСЕХ колонок исходной выгрузки BW-отчёта PM-M06 (лист «PM-06»).

Нужен, чтобы видеть поля, которые конвейер TOPO (lib/pm06_pipeline.js) не
переносит в data/*.json, и следить, не поменялась ли структура выгрузки.
Результат сводится в build/pm06_fields.json и описан в PM06_FIELDS.md.

Файл читается потоком, в память, без распаковки на диск: xlsx — напрямую,
архивы из ветки rawdata (Deflate64, zipfile Python его не умеет) — через
системный unzip.

    python3 build/pm06_profile.py <выгрузка.xlsx|архив.zip> [имя] > профиль.json

Для каждой колонки: подпись (безымянная колонка «код/текст» получает имя
соседней слева с пометкой «·доп»), заполненность без «#» и пустых, доля
чисел, число уникальных значений (до 20 000), 15 самых частых значений и
число строк, где значение отличается от первой строки того же заказа
(0 — поле уровня заказа).
"""
import io
import json
import re
import subprocess
import sys
import zipfile
from collections import Counter
from xml.etree.ElementTree import iterparse

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
EMPTY = {None, "", "#"}
DISTINCT_CAP = 20000


def col_index(ref):
    n = 0
    for ch in re.match(r"([A-Z]+)", ref).group(1):
        n = n * 26 + ord(ch) - 64
    return n - 1


def open_workbook(path):
    if path.lower().endswith(".xlsx"):
        return zipfile.ZipFile(path)
    outer = zipfile.ZipFile(path)
    inner = [n for n in outer.namelist() if n.lower().endswith(".xlsx")][0]
    try:
        data = outer.read(inner)
    except NotImplementedError:   # Deflate64 — отдаём системному unzip
        data = subprocess.run(["unzip", "-p", path, inner], check=True,
                              capture_output=True).stdout
    return zipfile.ZipFile(io.BytesIO(data))


def sheet_path(z, name):
    wb = z.read("xl/workbook.xml").decode()
    rels = z.read("xl/_rels/workbook.xml.rels").decode()
    targets = {}
    for m in re.finditer(r"<Relationship [^>]*>", rels):
        a = dict(re.findall(r'(\w+)="([^"]*)"', m.group(0)))
        targets[a.get("Id")] = a.get("Target")
    for m in re.finditer(r"<sheet [^>]*>", wb):
        a = dict(re.findall(r'([\w:]+)="([^"]*)"', m.group(0)))
        if a.get("name") == name:
            return "xl/" + targets[a["r:id"]].lstrip("/").replace("xl/", "")
    raise SystemExit(f"в книге нет листа «{name}»")


def iter_rows(z, sheet):
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for _, el in iterparse(z.open("xl/sharedStrings.xml")):
            if el.tag == NS + "si":
                shared.append("".join(t.text or "" for t in el.iter(NS + "t")))
                el.clear()
    for _, el in iterparse(z.open(sheet)):
        if el.tag != NS + "row":
            continue
        row = {}
        for c in el.findall(NS + "c"):
            t, v, inline = c.get("t"), c.find(NS + "v"), c.find(NS + "is")
            if t == "s" and v is not None:
                val = shared[int(v.text)]
            elif t == "inlineStr" and inline is not None:
                val = "".join(x.text or "" for x in inline.iter(NS + "t"))
            elif v is not None:
                val = v.text
            else:
                continue
            row[col_index(c.get("r"))] = val
        yield row
        el.clear()


def profile(path, name):
    z = open_workbook(path)
    rows = iter_rows(z, sheet_path(z, "PM-06"))
    params, header = {}, None
    for r in rows:
        if any(isinstance(v, str) and v.strip() == "Заказ" for v in r.values()):
            header = r
            break
        if 1 in r and 2 in r and len(r) <= 3:
            params[r[1]] = r[2]
    if header is None:
        raise SystemExit("не найдена строка заголовка с колонкой «Заказ»")
    width = max(header) + 1
    labels, prev = {}, ""
    for i in range(width):
        h = (header.get(i) or "").strip()
        labels[i] = h if h else f"{prev} ·доп"
        prev = h or prev
    order_col = next(i for i, h in labels.items() if h == "Заказ")
    stats = {i: {"fill": 0, "num": 0, "sum": 0.0, "top": Counter(),
                 "distinct": set(), "capped": False, "mismatch": 0}
             for i in range(width)}
    first, n = {}, 0
    for r in rows:
        order = r.get(order_col)
        if order in EMPTY:
            continue
        n += 1
        for i in range(width):
            v = r.get(i)
            if v in EMPTY:
                continue
            s = stats[i]
            s["fill"] += 1
            try:
                s["sum"] += float(v)
                s["num"] += 1
            except ValueError:
                pass
            if len(s["top"]) < 5000 or v in s["top"]:
                s["top"][v] += 1
            if not s["capped"]:
                s["distinct"].add(v)
                s["capped"] = len(s["distinct"]) > DISTINCT_CAP
            key = (order, i)
            if key not in first:
                first[key] = v
            elif first[key] != v:
                s["mismatch"] += 1
    return {
        "name": name, "params": params, "rows": n,
        "orders": len({k[0] for k in first}),
        "cols": [{
            "i": i, "label": labels[i], "fill": s["fill"], "num": s["num"],
            "sum": s["sum"],
            "distinct": f">{DISTINCT_CAP}" if s["capped"] else len(s["distinct"]),
            "top": [[str(k)[:90], c] for k, c in s["top"].most_common(15)],
            "orderMismatch": s["mismatch"],
        } for i, s in stats.items()],
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    src = sys.argv[1]
    json.dump(profile(src, sys.argv[2] if len(sys.argv) > 2 else src),
              sys.stdout, ensure_ascii=False)
