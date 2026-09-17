"""Иллюстрации LinkOne (.ilg) — два разных способа хранения.

  * растр  — CCITT Group 4 (тот же кодек, что у факса и у сканов TIFF),
             штриховой чертёж 1 бит на точку, около 1170×1490 точек.
             Так сделаны 26 книг Komatsu Japan / Komatsu Overseas.
  * вектор — список отрезков в координатах листа; так сделаны три книги
             Komatsu Mining на 730E (AFE69-F, AFE84-D, AFE84-K).

Способ виден в заголовке: у векторных первое поле равно 1, у растровых 0.
Номера позиций на чертеже не нарисованы — их рисует программа просмотра
по прямоугольникам-указателям из соответствующего .bli, поэтому выноски
можно наложить на чертёж своей разметкой и сделать кликабельными.
"""
import io
import struct

from . import container


def info(path):
    with open(path, 'rb') as f:
        head = f.read(78)
    vector = struct.unpack('<I', head[38:42])[0] == 1
    w, h = struct.unpack('<HH', head[42:46])
    stride = struct.unpack('<I', head[48:52])[0] if not vector else 0
    return {'vector': vector, 'w': w, 'h': h, 'stride': stride}


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
