#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Распаковать архивы LinkOme (ветка rawdata, rawdata/LinkOme/) в work/linkome.

Часть архивов — однофайловые .zip, часть — разрезаны на тома
(.zip.001, .zip.002, ...). Тома склеиваются подряд, как обычный zip,
разрезанный на куски, — не многотомный архив со своим оглавлением (см.
tools/unpack_rawdata.py в песочнице KOMATSU, тот же приём).

Группы томов заданы вручную — имена файлов в rawdata/LinkOme неровные
("old K1623...", "oldK1626...", "old_K1849...").

    python3 build/unpack_linkome.py <rawdata_dir> <out_dir>

<rawdata_dir> — локальная папка с уже скачанными файлами из
rawdata/LinkOme (одноимённые файлы, как в git ls-tree origin/rawdata).
"""
import glob
import os
import shutil
import subprocess
import sys

# книга → тома (без пути; порядок склейки важен)
GROUPS = {
    "K1637": ["K1637-08022908A-D-№3-6.zip"],
    "K1641": ["K1641-08024901.zip"],
    "K1839": ["K1839-WK-35-08016903-5&08017901-№4-7.zip"],
    "K1623": ["old K1623-WK-20-08016901&2-№3&№2.zip.001",
              "old K1623-WK-20-08016901&2-№3&№2.zip.002",
              "old K1623-WK-20-08016901&2-№3&№2.zip.003"],
    "K1626a": ["old K1626-08018901-2-№1-2.zip.001",
               "old K1626-08018901-2-№1-2.zip.002"],
    "K1626b": ["old K1626-WK-20-08018903-№8.zip.001",
               "old K1626-WK-20-08018903-№8.zip.002"],
    "K1626c": ["oldK1626-08018907-№1220.zip.001",
               "oldK1626-08018907-№1220.zip.002"],
    "K1849": ["old_K1849-WK-35-08022901-6-№10-12&№14-16.zip.001",
              "old_K1849-WK-35-08022901-6-№10-12&№14-16.zip.002",
              "old_K1849-WK-35-08022901-6-№10-12&№14-16.zip.003"],
    "K1861": ["каталог WK-35 для СЛ K1861.zip"],
}


def _extract_nested(dest, max_depth=3):
    """Некоторые поставки — zip внутри zip (K1861: внешний архив с
    инструкцией и парой PNG, сама книга — вложенный
    'Linkone WK-35 ... K1861-.zip'). Пока в dest нет book.bbi, ищем и
    распаковываем вложенные .zip — так же, через unzip -O GBK."""
    for _ in range(max_depth):
        if any(fn.lower() == "book.bbi" for _root, _dirs, fns in os.walk(dest) for fn in fns):
            return
        nested = [os.path.join(r, fn) for r, _dirs, fns in os.walk(dest)
                  for fn in fns if fn.lower().endswith(".zip")]
        if not nested:
            return
        for z in nested:
            subprocess.run(["unzip", "-q", "-O", "GBK", "-o", z, "-d", os.path.dirname(z)],
                            check=False)


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    rawdata_dir, out_dir = sys.argv[1:3]
    os.makedirs(out_dir, exist_ok=True)

    have = {os.path.basename(p) for p in glob.glob(os.path.join(rawdata_dir, "*"))}
    done = 0
    for group, parts in GROUPS.items():
        missing = [p for p in parts if p not in have]
        if missing:
            print(f"пропуск {group}: нет файлов {missing}", file=sys.stderr)
            continue
        dest = os.path.join(out_dir, group)
        os.makedirs(dest, exist_ok=True)
        if len(parts) == 1:
            src = os.path.join(rawdata_dir, parts[0])
        else:
            src = os.path.join(out_dir, group + ".joined.zip")
            with open(src, "wb") as out:
                for p in parts:
                    with open(os.path.join(rawdata_dir, p), "rb") as f:
                        shutil.copyfileobj(f, out)
        # System unzip, not Python's zipfile: some архивы use a compression
        # method zipfile.py doesn't implement (NotImplementedError), and the
        # исходные имена файлов — GBK (видно по BUILD_CODEPAGE=936 в самих
        # книгах); -O GBK делает восстановленные имена стабильными вместо
        # случайных сюрроgate-escape путей на несовпадении local/central.
        subprocess.run(["unzip", "-q", "-O", "GBK", "-o", src, "-d", dest],
                        check=False)
        if len(parts) > 1:
            os.remove(src)
        _extract_nested(dest)
        done += 1
        print(f"{group}: распаковано из {len(parts)} том(ов)")

    print(f"\nготово: {done} из {len(GROUPS)} групп")


if __name__ == "__main__":
    main()
