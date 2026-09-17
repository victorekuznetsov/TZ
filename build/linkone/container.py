"""Контейнер LinkOne / ImageLink: заголовок + цепочка LZH-блоков.

Файлы выгрузки (.bli, .ilg, .cat, .pix, .bbi) устроены одинаково:

    'ImageLink\\0' | 'BLI\\0' | '04.000\\0\\0' | 'ГГГГММДДЧЧММСС\\0\\0'
    ... поля, свои для каждого типа ...
    цепочка блоков: [u16 распакованный][u16 сжатый][u16 «есть ещё»][данные]

Сжатие — LZH («-lh5-»): LZSS с окном 8 КБ и динамическим Хаффманом,
тот же алгоритм, что в архиваторе LHA. Реализация в lzh.py.

Точка входа цепочки блоков зависит от типа файла: у BLI она на 48-м байте,
у CAT — на 54-м, у PIX — на 50-м, у BBI — на 52-м, у ILG — обычно на 78-м,
но заголовок ILG переменной длины, поэтому для него точка входа при
необходимости отыскивается перебором.
"""
import struct
from . import lzh

START = {'BLI': 48, 'CAT': 54, 'PIX': 50, 'BBI': 52, 'ILG': 78}


def _chain_ok(d, x):
    """Проверить, что с байта x начинается корректная цепочка блоков."""
    L = len(d); p = x; n = 0
    while p + 6 <= L:
        rb, cb, more = struct.unpack('<HHH', d[p:p + 6])
        if cb == 0 or p + 6 + cb > L:
            return False
        p += 6 + cb; n += 1
        if not more:
            return p == L and n > 0
        if n > 4000:
            return False
    return False


def _find_start(d, guess):
    if _chain_ok(d, guess):
        return guess
    for x in range(30, min(len(d) - 6, 4096)):
        if _chain_ok(d, x):
            return x
    raise ValueError('цепочка блоков не найдена')


def _unpack(d, x):
    L = len(d); p = x; out = bytearray()
    while p < L:
        rb, cb, more = struct.unpack('<HHH', d[p:p + 6])
        out += lzh.decompress(d[p + 6:p + 6 + cb], rb)
        p += 6 + cb
        if not more:
            break
    return bytes(out)


def _stream(d, start):
    """Одиночный поток LZH без цепочки блоков (ILG «способ 3»)."""
    comp = d[start:]
    br = lzh.BR(comp); out = bytearray()
    while br.pos < len(comp) - 1:
        if lzh.decode_block(br, 13, 14, 4, out, 1 << 40) == 0:
            break
    if br.pos < len(comp) - 2:
        raise ValueError('поток не дочитан')
    return bytes(out)


def _read_ilg(d):
    """У ILG два способа упаковки: цепочка блоков и одиночный поток.

    Заголовок ILG переменной длины, поэтому начало данных ищется перебором:
    верным считается смещение, на котором поток дочитывается до конца файла.
    У книг Komatsu заголовок обычно 78 байт: диапазон 78..100 хватает.
    У книг WK (LinkOme, другой производитель ПО) хвост заголовка длиннее и
    несёт дополнительные поля — цепочка начинается на 100+ (встречалось до
    ~150), поэтому диапазон шире.
    """
    for x in range(78, 100):
        if _chain_ok(d, x):
            return _unpack(d, x)
    for x in range(78, 100):
        try:
            return _stream(d, x)
        except Exception:
            continue
    for x in range(100, 512):
        if _chain_ok(d, x):
            return _unpack(d, x)
    for x in range(100, 512):
        try:
            return _stream(d, x)
        except Exception:
            continue
    raise ValueError('ILG: начало данных не найдено')


def read(path):
    """Вернуть (свойства, распакованные байты)."""
    with open(path, 'rb') as f:
        d = f.read()
    if d[:9] not in (b'ImageLink', b'LinkOne  '):
        raise ValueError('не файл LinkOne: ' + path)
    kind = d[10:13].decode('latin1')
    if kind not in START:
        raise ValueError('неизвестный тип ' + kind)
    meta = {'kind': kind, 'stamp': d[22:36].decode('latin1')}
    if kind == 'ILG':                      # размер листа в единицах чертежа
        meta['w'], meta['h'] = struct.unpack('<HH', d[42:46])
        return meta, _read_ilg(d)
    return meta, _unpack(d, _find_start(d, START[kind]))
