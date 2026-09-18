#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Отрисовать чертежи книг LinkOme (.ilg) в PNG и собрать их реестр.

Формат .ilg книг WK разобран в build/linkone/ilg.py: заголовок 78 байт,
палитра RGBQUAD, дальше цепочка LZH-блоков контейнера, внутри — построчный
байтовый RLE. Здесь только обход книг и запись картинок.

Имя файла чертежа — это идентификатор страницы каталога плюс буква листа:
у страницы CK1601.03.20.00 три листа — ck1601.03.20.00a/b/c.ilg. Поэтому
реестр ключуется парой «книга|страница», а значение — список листов.

Вход — папка с распакованными книгами (build/unpack_linkome.py), причём
книги можно обрабатывать по одной: скрипт дописывает реестр, а не
перезаписывает его целиком (важно, когда на диске не помещаются все книги
сразу).

    python3 build/build_linkome_drawings.py <unpacked_dir> <media_dir> <out_dir>

Выход: <media_dir>/<книга>/<лист>.png и <out_dir>/linkome_drawings.json
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from linkone import book as book_mod  # noqa: E402
from linkone import ilg  # noqa: E402

SHEET_RE = re.compile(r'^(.*?)([a-z])$', re.I)


def page_and_sheet(stem):
    """'ck1601.03.20.00b' -> ('CK1601.03.20.00', 'b')."""
    m = SHEET_RE.match(stem)
    if not m:
        return stem.upper(), ''
    return m.group(1).upper(), m.group(2).lower()


def main():
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    unpacked_dir, media_dir, out_dir = sys.argv[1:4]
    os.makedirs(out_dir, exist_ok=True)

    out_path = os.path.join(out_dir, 'linkome_drawings.json')
    if os.path.exists(out_path):
        with open(out_path, encoding='utf-8') as f:
            reg = json.load(f)
    else:
        reg = {'meta': {}, 'byPage': {}}

    books = sorted(d for d in os.listdir(unpacked_dir)
                   if os.path.isdir(os.path.join(unpacked_dir, d)))
    for book in books:
        # K1626a/b/c — тома одной книги, в каталоге они под общим кодом
        code = re.sub(r'[a-c]$', '', book) if re.match(r'^K\d+[a-c]$', book) else book
        files = [os.path.join(r, fn)
                 for r, _dirs, fns in os.walk(os.path.join(unpacked_dir, book))
                 for fn in fns if fn.lower().endswith('.ilg')]
        if not files:
            continue
        dest = os.path.join(media_dir, code)
        os.makedirs(dest, exist_ok=True)
        # Выноски лежат в .bli рядом с .ilg: номер позиции, лист и рамка в
        # системе координат листа. Разбираем страницу один раз на все её листы.
        roots = {os.path.dirname(p) for p in files}
        pages = {}
        for r in roots:
            if not os.path.exists(os.path.join(r, 'book.bbi')):
                continue
            try:
                bk = book_mod.Book(r)
            except Exception:                            # noqa: BLE001
                continue
            for p in files:
                if os.path.dirname(p) != r:
                    continue
                page_id = page_and_sheet(os.path.splitext(os.path.basename(p))[0])[0]
                if page_id in pages:
                    continue
                try:
                    pages[page_id] = bk.page(page_id)
                except Exception:                        # noqa: BLE001
                    pages[page_id] = None
        ok = fail = spots_total = 0
        for p in sorted(files):
            stem = os.path.splitext(os.path.basename(p))[0]
            page, sheet = page_and_sheet(stem)
            rel = os.path.join(dest, stem.lower() + '.png')
            try:
                im = ilg.image(p)
                # 'P' с оптимизацией: штриховой чертёж из палитры весит ~30 КБ,
                # в RGB — в несколько раз больше без выигрыша в качестве
                im.convert('P', palette=1, colors=256).save(rel, optimize=True)
            except Exception as e:                       # noqa: BLE001
                fail += 1
                print(f'  не отрисовался {stem}: {e}', file=sys.stderr)
                continue
            item = {'sheet': sheet, 'file': rel.replace(os.sep, '/'),
                    'w': im.width, 'h': im.height}
            pg = pages.get(page)
            if pg:
                idx = ord(sheet) - ord('a') + 1 if sheet else 1
                canvas = pg['sheets'][idx - 1] if idx <= len(pg['sheets']) else None
                cw = canvas['w'] if canvas else im.width
                ch = canvas['h'] if canvas else im.height
                spots = []
                for s in pg['spots']:
                    if s['sheet'] != idx or not any(s['box']):
                        continue
                    x1, y1, x2, y2 = s['box']
                    # Рамки лежат в той же системе координат, что и строки
                    # растра в файле, а их ilg.py разворачивает (растр хранится
                    # снизу вверх). Поэтому здесь Y берётся как есть: разворот
                    # уже сделан на стороне картинки. Держим в процентах холста —
                    # накладывать на картинку любого размера можно без пересчёта.
                    spots.append({
                        'n': s['item'],
                        'x': round(100.0 * x1 / cw, 3),
                        'y': round(100.0 * y1 / ch, 3),
                        'w': round(100.0 * (x2 - x1) / cw, 3),
                        'h': round(100.0 * (y2 - y1) / ch, 3),
                    })
                if spots:
                    item['spots'] = spots
                    spots_total += len(spots)
            key = f'{code}|{page}'
            entry = reg['byPage'].setdefault(key, [])
            entry[:] = [x for x in entry if x['file'] != item['file']] + [item]
            entry.sort(key=lambda x: x['sheet'])
            ok += 1
        print(f'{book}: отрисовано {ok}, не удалось {fail}, выносок {spots_total}')

    sheets = sum(len(v) for v in reg['byPage'].values())
    reg['meta'] = {
        'pages': len(reg['byPage']),
        'sheets': sheets,
        'src': 'rawdata/LinkOme (ветка rawdata) -> build/linkone/ilg.py',
        'note': 'Чертёж страницы каталога LinkOne. У страницы бывает несколько '
                'листов (буква в имени файла). Номера позиций на чертеже '
                'нарисованы самим чертежом.',
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(reg, f, ensure_ascii=False, separators=(',', ':'))
    print(f'\nвсего в реестре: {len(reg["byPage"])} страниц, {sheets} листов')


if __name__ == '__main__':
    main()
