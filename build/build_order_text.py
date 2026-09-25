# -*- coding: utf-8 -*-
"""Тексты заказов ТОРО WK: data/order_text.json.

Текст заказа (колонка «Заказ ·доп» PM-06, «ТР ходовой части WK-20 №1») не
попадает ни в витрины TOPO, ни в pm06_meta — он есть только в исходных
выгрузках ветки rawdata TOPO. Скрипт скачивает выгрузки 2024–2027 по одной,
читает их потоком (помощники из <TOPO>/pm06_meta/build_pm06_meta.py) и
оставляет тексты только заказов из data/control.json. Выгрузка удаляется
сразу после разбора: все файлы (~700 МБ) на диске одновременно не нужны.

    python3 build/build_order_text.py <TOPO>/pm06_meta data/ [рабочая_папка]

Повторный запуск продолжает с места остановки (готовые выгрузки
кэшируются в рабочей папке как <имя>.json).
"""
import json
import os
import subprocess
import sys
import time

BASE = "https://raw.githubusercontent.com/victorekuznetsov/TOPO/rawdata/"
SOURCES = {   # имя → части архива (тот же список, что pm06_meta/build_all.sh)
    **{f"1100_{y}": [f"M06_1100_{y}.zip.00{i}" for i in (1, 2, 3)] for y in (2024, 2025, 2026)},
    "1100_2027": ["M06_1100_2027.zip.001", "M06_1100_2027.zip.002"],
    "1200_2024": ["M06_1200_2024.xlsx"], "1200_2025": ["M06_1200_2025.zip.001"],
    "1200_2026": ["M06_1200_2026.zip.001"], "1200_2027": ["M06_1200_2027.xlsx"],
    "1400_2024": ["M06_1400_2024.xlsx"], "1400_2025": ["M06_1400_2025.zip.001"],
    "1400_2026": ["M06_1400_2026.zip.001", "M06_1400_2026.zip.002"], "1400_2027": ["M06_1400_2027.xlsx"],
}


def wanted_orders(data_dir):
    with open(os.path.join(data_dir, "control.json"), encoding="utf-8") as f:
        c = json.load(f)
    i = c["columns"].index("order")
    return {r[i] for r in c["rows"]}


def extract(meta, path, orders):
    z = meta._open(path)
    rows = meta._rows(z, meta._sheet(z, "PM-06"))
    hdr = None
    for r in rows:
        if any(isinstance(v, str) and v.strip() == "Заказ" for v in r.values()):
            hdr = r
            break
    if hdr is None:
        raise SystemExit("нет строки заголовка с колонкой «Заказ»")
    H = {v.strip(): k for k, v in hdr.items() if isinstance(v, str) and v.strip()}
    co, ct = H["Заказ"], H["Заказ"] + 1          # текст — соседняя колонка «Заказ ·доп»
    out = {}
    for r in rows:
        o = r.get(co)
        if o in orders and o not in out:
            t = (r.get(ct) or "").strip()
            if t and t != "#":
                out[o] = t
    return out


def main():
    meta_dir, data_dir = sys.argv[1], sys.argv[2]
    work = sys.argv[3] if len(sys.argv) > 3 else os.path.join(data_dir, "..", ".order_text_work")
    os.makedirs(work, exist_ok=True)
    sys.path.insert(0, meta_dir)
    import build_pm06_meta as meta
    orders = wanted_orders(data_dir)
    texts = {}
    for name, parts in SOURCES.items():
        cache = os.path.join(work, name + ".json")
        if not os.path.exists(cache):
            ext = "xlsx" if parts[0].endswith(".xlsx") else "zip"
            tmp = os.path.join(work, "_src." + ext)
            for attempt in range(1, 5):
                with open(tmp, "wb") as f:
                    ok = subprocess.run(["curl", "-sSfL", *[BASE + p for p in parts]], stdout=f).returncode == 0
                if ok:
                    break
                print(f"{name}: повтор {attempt}", flush=True)
                time.sleep(2 ** attempt)
            else:
                raise SystemExit(f"{name}: не скачалось")
            got = extract(meta, tmp, orders)
            os.remove(tmp)
            with open(cache, "w", encoding="utf-8") as f:
                json.dump(got, f, ensure_ascii=False)
            print(f"{name}: текстов {len(got)}", flush=True)
        with open(cache, encoding="utf-8") as f:
            texts.update(json.load(f))
    out = os.path.join(data_dir, "order_text.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"meta": {"src": "TOPO rawdata PM-06, колонка «Заказ ·доп»", "orders": len(texts),
                            "of": len(orders)}, "text": dict(sorted(texts.items()))},
                  f, ensure_ascii=False, separators=(",", ":"))
    print(f"order_text.json: {len(texts)} из {len(orders)} заказов")


if __name__ == "__main__":
    main()
