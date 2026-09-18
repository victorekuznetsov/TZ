"""Книга ЗИП LinkOne: дерево разделов, страницы, строки позиций, выноски.

Внутри и `.bbi` (индекс книги), и `.bli` (страница) устроены одинаково:

    [u16 вид][u16 ?][u32 длина пула строк][пул строк через \\0]
    далее секции: [u16 тип][u16 длина записи][u32 число записей][записи]

Записи ссылаются на строки смещением в пуле; 0xFFFFFFFF — «поля нет».

Строка позиции (секция 0x69, 60 байт, пятнадцать 32-битных полей) несёт
номер на чертеже, номер детали, наименование, количество и ссылку на
другую страницу или другую книгу. Остальные колонки таблицы —
применяемость по серийным номерам, SCC, заводские цены — вынесены в
отдельную секцию 0x6a общим массивом: у каждой строки там своя порция
подряд, а сколько их и как называются, объявлено в `.bbi`.

Что в каких секциях лежит, разобрано сверкой с текстовыми отчётами сборки
(`book.rpt`, `parts.rpt`), которые пришли с тремя книгами на 730E, и с
описанием раскладки таблиц — оно лежит в самом `.bbi` в виде XML.
"""
import os
import re
import struct

from . import container

FMT = re.compile(rb'<FORMAT NAME=([A-Z0-9_]+)>')
NONE = 0xFFFFFFFF


def _pool(buf):
    """Индекс строк пула: смещение → строка (байты)."""
    out = {}
    off = 0
    for t in buf.split(b'\x00'):
        out[off] = t
        off += len(t) + 1
    return out


def _sections(d, start):
    out = {}
    p = start
    while p + 8 <= len(d):
        typ, ln = struct.unpack('<HH', d[p:p + 4])
        cnt = struct.unpack('<I', d[p + 4:p + 8])[0]
        if ln == 0 or p + 8 + ln * cnt > len(d):
            break
        out[typ] = (ln, cnt, d[p + 8:p + 8 + ln * cnt])
        p += 8 + ln * cnt
    return out


class Chunk:
    """Общая часть .bbi и .bli: пул строк и секции записей."""

    def __init__(self, path, encoding):
        meta, d = container.read(path)
        self.raw = d
        self.enc = encoding
        n = struct.unpack('<I', d[4:8])[0]
        self.pool = _pool(d[8:8 + n])
        self.order = sorted(self.pool)
        self.sec = _sections(d, 8 + n)

    def s(self, off):
        """Строка по смещению; None, если поля нет."""
        if off == NONE or off not in self.pool:
            return None
        return self.pool[off].decode(self.enc, 'replace')

    def recs(self, typ, fmt):
        ln, cnt, b = self.sec.get(typ, (0, 0, b''))
        need = struct.calcsize(fmt)
        for i in range(cnt):
            rec = b[i * ln:(i + 1) * ln]
            if len(rec) >= need:
                yield struct.unpack(fmt, rec[:need])

    def raw_recs(self, typ):
        ln, cnt, b = self.sec.get(typ, (0, 0, b''))
        for i in range(cnt):
            yield b[i * ln:(i + 1) * ln]

    def after(self, key):
        """Значение служебного поля: ключ и значение лежат в пуле подряд."""
        want = key.encode()
        prev = None
        for off in self.order:
            if prev == want:
                return self.pool[off].decode(self.enc, 'replace')
            prev = self.pool[off]
        return ''


# Дополнительные колонки таблицы хранятся отдельным массивом (секция 0x6a):
# у каждой строки там своя порция подряд. Порядок в порции постоянный —
# вот этот; какие из них у книги есть, видно по её пулу строк. У японских
# книг с прайсом их одиннадцать, у большинства остальных две, иногда одна.
EXTRA_FIELDS = (['SCC', 'PRICE_1', 'PRICE_2', 'PRICE_3']
                + ['TOKU_' + c for c in 'ABCDEF'] + ['SERIALNO'])


def _extra_names(bbi):
    have = {bbi.pool[o] for o in bbi.order}
    return [f for f in EXTRA_FIELDS if f.encode() in have]


class Book:
    """Одна книга ЗИП: паспорт, дерево страниц и разбор страницы."""

    def __init__(self, root, code=None):
        self.root = root
        self.code = code or os.path.basename(root.rstrip('/'))
        probe = Chunk(os.path.join(root, 'book.bbi'), 'latin1')
        self.codepage = probe.after('BUILD_CODEPAGE')
        # 936 — китайский GBK/GB18030 (двухбайтовые китайские иероглифы и,
        # у части книг WK, кириллица в том же пуле строк — 'gbk' в Python
        # декодирует и то, и другое); 1251 — прямая кириллица.
        self.encoding = {'932': 'cp932', '936': 'gbk',
                          '1251': 'cp1251'}.get(self.codepage, 'cp1252')
        bbi = Chunk(os.path.join(root, 'book.bbi'), self.encoding)
        self.bbi = bbi
        self.issued = bbi.after('ABOUT_THIS_BOOK')
        self.title = self._title()
        # У книг Komatsu Mining поля MODEL нет — марка читается из названия
        # книги: «730E-10 (USA)  S/N A50022-A50025» → «730E-10».
        self.model = bbi.after('MODEL') or re.split(
            r'\s*\(|\s+S/N\b', self.title)[0].strip()
        self.formats = sorted({m.group(1).decode() for m in FMT.finditer(bbi.raw)})
        self.extras = _extra_names(bbi)

        names = _pool(bbi.sec[0x19][2]) if 0x19 in bbi.sec else {}
        self.pages = []
        if 0x1a in bbi.sec:                       # книги Komatsu Japan / Overseas
            for title, ref, desc, _ff, nm in bbi.recs(0x1a, '<IIIHI'):
                self.pages.append(self._page_row(bbi, title, ref, desc,
                                                 names.get(nm, b'').decode('latin1')))
        elif 0x03 in bbi.sec:                     # книги Komatsu Mining на 730E
            for title, ref, desc, _ff, nm in bbi.recs(0x03, '<IIIH8s'):
                self.pages.append(self._page_row(bbi, title, ref, desc,
                                                 nm.split(b'\x00')[0].decode('latin1')))
        else:
            raise ValueError('в %s нет индекса страниц' % self.code)

        self.by_id = {p['id']: i for i, p in enumerate(self.pages)}
        for _order, parent, child in bbi.recs(0x0a, '<IHH'):
            if parent < len(self.pages) and child < len(self.pages):
                self.pages[parent]['kids'].append(child)
        # Разделы верхнего уровня рёбрами не привязаны — цепляем их к корню,
        # сохраняя порядок книги.
        linked = {c for p in self.pages for c in p['kids']}
        orphans = [i for i in range(1, len(self.pages)) if i not in linked]
        self.pages[0]['kids'] = orphans + self.pages[0]['kids']
        self.root_page = 0

    def _title(self):
        p = os.path.join(self.root, 'book.def')
        if os.path.exists(p):
            with open(p, 'rb') as f:
                return f.readline().decode(self.encoding, 'replace').strip()
        return self.code

    @staticmethod
    def _page_row(bbi, title, ref, desc, pid):
        return {'id': pid, 'ref': bbi.s(title) or '', 'name': bbi.s(ref) or '',
                'title': bbi.s(desc) or '', 'kids': []}

    def has_graphic(self, page_id):
        return os.path.exists(os.path.join(self.root, page_id.lower() + 'a.ilg'))

    def page(self, page_id):
        """Разобрать страницу: название, чертёж, строки позиций, выноски."""
        c = Chunk(os.path.join(self.root, page_id.lower() + '.bli'), self.encoding)
        out = {'id': page_id, 'title': '', 'ref': '', 'graphic': '',
               'w': 0, 'h': 0, 'sheets': [], 'rows': [], 'spots': []}
        for title, _fl, ref, _pid in c.recs(0x6b, '<IIII'):
            out['title'] = c.s(title) or ''
            out['ref'] = c.s(ref) or ''
        # Записей 0x67 столько же, сколько листов у страницы (a, b, c…), и
        # у каждого листа своя система координат выносок — держим все.
        for gr, _a, w, h, _d in c.recs(0x67, '<IIHHH'):
            out['sheets'].append({'graphic': c.s(gr) or '', 'w': w, 'h': h})
            out['graphic'] = c.s(gr) or ''
            out['w'], out['h'] = w, h

        extras = [c.s(o) for (o,) in c.recs(0x6a, '<I')]
        rows = list(c.recs(0x69, '<15I'))
        step = len(extras) // len(rows) if rows and extras else 0
        names = self.extras if len(self.extras) == step else []
        if step and not names:
            # Состав колонок разошёлся с объявленным — держимся за то, что
            # знаем точно: применяемость всегда последняя в порции.
            names = [''] * (step - 1) + ['SERIALNO']
        for i, r in enumerate(rows):
            add = {}
            if step:
                base = r[13]
                if base != NONE and base + step <= len(extras):
                    add = {k: v for k, v in zip(names, extras[base:base + step]) if v}
            out['rows'].append({
                # Номер на чертеже приходит как «номер|ключ»: после черты
                # внутренний ключ сортировки, он в книге не печатается.
                # Отдельной строкой он и не встречается — только у позиций
                # без номера и у NS (not shown).
                'item': (c.s(r[1]) or '').split('|')[0],
                'part': c.s(r[2]) or '',
                'name': c.s(r[3]) or '',
                'qty': None if r[11] == NONE else r[11],
                'sn': add.get('SERIALNO', ''),
                'scc': add.get('SCC', ''),
                'book': c.s(r[6]) or '',          # ссылка на другую книгу
                'link': (c.s(r[7]) or '').lstrip('|'),   # ссылка на другую страницу
                'level': r[0],
                'extra': add,
            })
        for rec in c.raw_recs(0x66):
            out['spots'].append(_spot(c, rec))
        return out


def _sane_box(b):
    """Рамка осмысленна, если это непустой прямоугольник в разумных числах."""
    return (len(b) == 4 and b[2] > b[0] and b[3] > b[1]
            and max(b) < 0x8000)


def _spot(c, rec):
    """Выноска: номер позиции, лист и прямоугольник на чертеже.

    Метка 0xFFFF есть у всех раскладок, но лежит по-разному: у книг Komatsu
    координаты идут сразу за ней, у книг WK — наоборот, перед ней (запись
    30 байт: [u32 номер][2][лист, с единицы][?][0][x1][y1][x2][y2][FFFF]…).
    Поэтому берём ту четвёрку, которая даёт непустой прямоугольник.

    Координаты — в системе листа, её размер объявлен в записи 0x67 того же
    .bli (он на пару точек больше самой картинки .ilg).
    """
    item = c.s(struct.unpack('<I', rec[:4])[0]) or ''
    words = struct.unpack('<%dH' % (len(rec) // 2), rec[:len(rec) // 2 * 2])
    box, sheet = [0, 0, 0, 0], 1
    for i, w in enumerate(words[2:], 2):
        if w != 0xFFFF:
            continue
        after = list(words[i + 1:i + 5])
        before = list(words[i - 4:i]) if i >= 6 else []
        if _sane_box(before):
            box, sheet = before, (words[3] or 1)
        elif _sane_box(after):
            box = after
        break
    return {'item': item, 'sheet': sheet, 'box': box}
