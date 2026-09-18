#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Обернуть каждый data/*.json в data/<имя>.local.js —
`window.__DATA__["<имя>"] = <тот же JSON>;`.

Портал грузит витрины через `<script src="data/*.local.js">`, а не через
`fetch("data/*.json")`: fetch() локального файла браузер блокирует, когда
страница открыта без сервера (`file://…`, двойной щелчок по index.html) —
тег `<script>` этому ограничению не подчиняется. Тот же приём — в TOPO,
CAT и KOMATSU_PARTS_BOOK. Официальный путь публикации (GitHub Pages /
Vercel / `python3 -m http.server`) от этого не страдает — там `<script
src>` работает точно так же, как fetch() работал бы.

    python3 build/make_local_js.py data/
"""
import json
import os
import sys


def main():
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    data_dir = sys.argv[1]
    n = 0
    for name in sorted(os.listdir(data_dir)):
        if not name.endswith(".json"):
            continue
        key = name[:-len(".json")]
        src = os.path.join(data_dir, name)
        dst = os.path.join(data_dir, key + ".local.js")
        with open(src, encoding="utf-8") as f:
            raw = f.read()  # уже компактный JSON (separators=(",",":")) — просто оборачиваем
        # </script> в строковом значении (например, в тексте документа
        # kb_text.json) иначе закрыл бы тег раньше времени — экранируем
        # везде, это безопасно и внутри, и вне строк JSON.
        raw = raw.replace("</", "<\\/")
        with open(dst, "w", encoding="utf-8") as f:
            f.write(f'window.__DATA__=window.__DATA__||{{}};window.__DATA__["{key}"]={raw};\n')
        n += 1
        print(f"  {name} -> {key}.local.js ({len(raw)} байт)")
    print(f"готово: {n} файлов")


if __name__ == "__main__":
    main()
