"""Иллюстрации LinkOne (.ilg) — три разных способа хранения.

  * палитра+RLE — так сделаны книги WK (太重/Тайчжун). Заголовок 78 байт,
             сразу за ним палитра RGBQUAD на `ncol` цветов, дальше обычная
             цепочка LZH-блоков контейнера, а в ней — построчный байтовый RLE.
             Разбирается `image()`, см. подробности ниже.
  * растр  — CCITT Group 4 (тот же кодек, что у факса и у сканов TIFF),
             штриховой чертёж 1 бит на точку, около 1170×1490 точек.
             Так сделаны 26 книг Komatsu Japan / Komatsu Overseas.
  * вектор — список отрезков в координатах листа; так сделаны три книги
             Komatsu Mining на 730E (AFE69-F, AFE84-D, AFE84-K).

Номера позиций на чертеже не нарисованы — их рисует программа просмотра
по прямоугольникам-указателям из соответствующего .bli, поэтому выноски
можно наложить на чертёж своей разметкой и сделать кликабельными.

Разметка заголовка (общая для всех трёх способов):
    42  u16  ширина в точках
    44  u16  высота в точках
    46  u16  бит на точку (4 или 8 у книг WK)
    48  u16  длина строки в байтах у упакованного хранения
    50  u16  число цветов палитры (16 или 256 у книг WK, 0 у Komatsu)
    78  ...  палитра: ncol × RGBQUAD (B, G, R, 0)

Поток книг WK (после распаковки LZH) — построчный RLE, строка ровно
`ширина` точек, команды идут парами байт:
    [c>0][v]   — c точек цвета v
    [0][n>0]   — n точек подряд (literal), уложенных следом; число байт
                 под них округляется вверх до чётного
    [0][0]     — конец строки
При 8 битах на точку literal — это n байт-индексов палитры, при 4 битах
точки в literal упакованы по две в байт (старший полубайт — первая), а в
команде [c][v] индекс берётся из старшего полубайта v: палитра у таких
книг — 16 градаций серого, где цвет = индекс × 17.
"""
import io
import struct

from . import container


def info(path):
    with open(path, 'rb') as f:
        head = f.read(78)
    return header(head)


def header(head):
    """Разобрать заголовок .ilg (первые 78 байт файла)."""
    vector = struct.unpack('<I', head[38:42])[0] == 1
    w, h = struct.unpack('<HH', head[42:46])
    bpp = struct.unpack('<H', head[46:48])[0]
    stride = struct.unpack('<H', head[48:50])[0]
    ncol = struct.unpack('<H', head[50:52])[0]
    return {'vector': vector, 'w': w, 'h': h, 'bpp': bpp,
            'stride': stride, 'ncol': ncol}


def palette(d, ncol):
    """Палитра RGBQUAD сразу за заголовком: B, G, R, 0."""
    return [(d[78 + i * 4 + 2], d[78 + i * 4 + 1], d[78 + i * 4])
            for i in range(ncol)]


def _rows(pay, w, h, bpp):
    """Построчный байтовый RLE книг WK -> список строк по `w` индексов."""
    rows = []
    i, n = 0, len(pay)
    while len(rows) < h and i + 1 < n:
        row = bytearray()
        while len(row) < w and i + 1 < n:
            c, v = pay[i], pay[i + 1]
            if c:
                row += bytes([v >> 4 if bpp == 4 else v]) * c
                i += 2
                continue
            if v == 0:                      # [0][0] — конец строки
                i += 2
                break
            i += 2                          # [0][n] — n точек literal
            if bpp == 4:
                nb = (v + 1) // 2           # по две точки в байте
                px = bytearray()
                for by in pay[i:i + nb]:
                    px.append(by >> 4)
                    px.append(by & 0x0F)
                row += px[:v]
                i += nb + (nb & 1)          # длина выровнена до чётной
            else:
                row += pay[i:i + v]
                i += v + (v & 1)
        if i + 1 < n and pay[i] == 0 and pay[i + 1] == 0:
            i += 2
        rows.append(bytes(row[:w] + bytes(max(0, w - len(row)))))
    # Строки идут снизу вверх, как в обычном DIB (палитра тут тоже RGBQUAD).
    # Без разворота чертёж выходит зеркальным по вертикали — заметно только по
    # тексту: рамки выносок лежат в той же системе и «сходятся» с перевёрнутой
    # картинкой ничуть не хуже, чем с правильной.
    rows.reverse()
    return rows


def image(path):
    """Чертёж книги WK как изображение Pillow (палитра + построчный RLE)."""
    from PIL import Image
    with open(path, 'rb') as f:
        d = f.read()
    return image_from_bytes(d)


def image_from_bytes(d):
    """То же, но из уже прочитанных байт файла — чтобы не класть их на диск."""
    from PIL import Image
    m = header(d[:78])
    if not m['ncol']:
        raise ValueError('не книга WK: палитры нет (ncol=0)')
    pal = palette(d, m['ncol'])
    pay = container._unpack(d, 78 + m['ncol'] * 4)
    rows = _rows(pay, m['w'], m['h'], m['bpp'])
    im = Image.frombytes('P', (m['w'], len(rows)), b''.join(rows))
    flat = [c for rgb in pal for c in rgb]
    im.putpalette(flat + [0] * (768 - len(flat)))
    return im.convert('RGB')


def _tiff(g4, w, h):
    """Обернуть поток Group 4 в минимальный TIFF — его читает Pillow."""
    tags = [(256, 3, w), (257, 3, h), (258, 3, 1), (259, 3, 4), (262, 3, 1),
            (266, 3, 1), (273, 4, 0), (277, 3, 1), (278, 3, h), (279, 4, len(g4))]
    tags.sort()
    data_off = 8 + 2 + len(tags) * 12 + 4
    body = struct.pack('<H', len(tags))
    for tag, typ, val in tags:
        body += struct.pack('<HHII', tag, typ, 1, data_off if tag == 273 else val)
    body += struct.pack('<I', 0)
    return b'II*\x00' + struct.pack('<I', 8) + body + g4


def raster(path):
    """Чертёж-растр как чёрно-белое изображение Pillow (чёрные линии на белом)."""
    from PIL import Image, ImageOps
    with open(path, 'rb') as f:
        d = f.read()
    m = info(path)
    im = Image.open(io.BytesIO(_tiff(d[78:], m['w'], m['h'])))
    im.load()
    return ImageOps.invert(im.convert('L')).convert('1')


# Записи векторного чертежа: [u32 длина в словах][u16 код][u16 счётчик][тело].
# Цепочка начинается на 18-м байте распакованного потока; до неё — заголовок
# листа. Ломаные лежат под двумя кодами (толстая и тонкая линия), счётчик —
# число точек, дальше пары u16 в координатах листа, начало отсчёта — левый
# верхний угол. Так же, в координатах листа, лежат и рамки выносок (0x41b),
# но их берём из .bli, где к ним привязан номер позиции.
LINE_OPS = (0x0324, 0x0325)
BITMAP_OP = 0x0f43
CHAIN_START = 18


def _records(d):
    p = CHAIN_START
    while p + 8 <= len(d):
        words = struct.unpack('<I', d[p:p + 4])[0]
        if words < 4 or p + words * 2 > len(d):
            return
        op, n = struct.unpack('<HH', d[p + 4:p + 8])
        yield op, n, d[p + 8:p + words * 2]
        p += words * 2


def _dib(body):
    """Растр, вклеенный в лист: обычный DIB (заголовок как у .bmp).

    Один бит на точку, строки сверху вниз, ноль в палитре белый. Перед DIB
    лежит место на листе: высота со знаком, ширина, низ, левый край — так
    же, как у рамок выносок, снизу вверх.
    """
    from PIL import Image, ImageOps
    dh, dw, y, x = struct.unpack('<4h', body[12:20])
    size, w, h, _planes, bpp = struct.unpack('<Iii2H', body[20:36])
    if size != 40 or bpp != 1:
        return None
    stride = ((w * bpp + 31) // 32) * 4
    px = body[20 + size + 8:20 + size + 8 + stride * abs(h)]
    if len(px) < stride * abs(h):
        return None
    im = Image.frombytes('1', (stride * 8, abs(h)), px).crop((0, 0, w, abs(h)))
    box = (min(x, x + dw), min(y, y + dh), max(x, x + dw), max(y, y + dh))
    return ImageOps.invert(im.convert('L')).convert('1'), box


def sheet(path):
    """Векторный лист: (свойства, ломаные, вклеенные растры).

    Ломаная — список точек в координатах листа; растр — (картинка, место).
    """
    meta, d = container.read(path)
    lines, images = [], []
    for op, n, body in _records(d):
        if op in LINE_OPS and n >= 2 and 4 * n <= len(body):
            xy = struct.unpack('<%dH' % (2 * n), body[:4 * n])
            pts = list(zip(xy[0::2], xy[1::2]))
            pts = [pts[0]] + [b for a, b in zip(pts, pts[1:]) if a != b]
            if len(pts) > 1:
                lines.append(pts)
        elif op == BITMAP_OP and len(body) > 60:
            got = _dib(body)
            if got:
                images.append(got)
    return meta, lines, images


def strokes(path):
    """Чертёж-вектор как список ломаных [[(x, y), ...], ...]."""
    meta, lines, _images = sheet(path)
    return meta, lines
