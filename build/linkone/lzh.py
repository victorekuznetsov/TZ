"""Распаковка LZH («-lh5-») — тем же алгоритмом сжаты все файлы LinkOne.

LZSS с окном 8 КБ и динамическим Хаффманом: поток делится на блоки, каждый
блок несёт свои таблицы кодов (сначала вспомогательная таблица длин, затем
таблица литералов и длин совпадений, затем таблица расстояний) и число
закодированных в нём кодов. Биты читаются от старшего к младшему.

Реализация повторяет huf.c/decode.c архиватора LHA (Х. Окумура) в объёме,
нужном для чтения выгрузки; внешних зависимостей нет.
"""
class BR:
    """Чтение потока по битам, от старшего к младшему."""
    def __init__(s,data):
        s.d=data; s.pos=0; s.bit=0
    def getbit(s):
        if s.pos>=len(s.d): return 0
        b=(s.d[s.pos]>>(7-s.bit))&1
        s.bit+=1
        if s.bit==8: s.bit=0; s.pos+=1
        return b
    def getbits(s,n):
        v=0
        for _ in range(n): v=(v<<1)|s.getbit()
        return v

MAXMATCH=256; THRESHOLD=3; NC=255+MAXMATCH+2-THRESHOLD; CBIT=9; NT=19; TBIT=5

def make_table(bitlen, nsym):
    # returns decode function using canonical Huffman (MSB-first, shorter codes first)
    counts=[0]*17
    for l in bitlen:
        if l: counts[l]+=1
    code=0; firstcode=[0]*18; 
    start=[0]*18
    for l in range(1,17):
        start[l]=code
        code=(code+counts[l])<<1
    # build map (len,code)->sym
    nxt=start[:]
    table={}
    for sym,l in enumerate(bitlen):
        if l:
            table[(l,nxt[l])]=sym
            nxt[l]+=1
    return table

def hdecode(br,table,maxlen=16):
    code=0
    for l in range(1,maxlen+1):
        code=(code<<1)|br.getbit()
        if (l,code) in table: return table[(l,code)]
    raise ValueError('bad huffman code')

def read_pt_len(br,nn,nbit,i_special):
    pt_len=[0]*nn
    n=br.getbits(nbit)
    if n==0:
        c=br.getbits(nbit)
        return None,c   # constant table
    i=0
    while i<n:
        c=br.getbits(3)
        if c==7:
            while br.getbit(): c+=1
            if c>16: raise ValueError('pt len too big')
        pt_len[i]=c; i+=1
        if i==i_special:
            c=br.getbits(2)
            while c>0: 
                if i>=nn: break
                pt_len[i]=0; i+=1; c-=1
    return pt_len,None

def read_c_len(br,pt_table,pt_const):
    c_len=[0]*NC
    n=br.getbits(CBIT)
    if n==0:
        c=br.getbits(CBIT)
        return None,c
    i=0
    while i<n:
        if pt_const is not None: c=pt_const
        else: c=hdecode(br,pt_table)
        if c<=2:
            if c==0: c=1
            elif c==1: c=br.getbits(4)+3
            else: c=br.getbits(CBIT)+20
            while c>0 and i<NC:
                c_len[i]=0; i+=1; c-=1
        else:
            c_len[i]=c-2; i+=1
    return c_len,None

def decode_block(br,dicbit,np,pbit,out,raw):
    blocksize=br.getbits(16)
    pt_len,pt_const=read_pt_len(br,NT,TBIT,3)
    pt_table=make_table(pt_len,NT) if pt_len else None
    c_len,c_const=read_c_len(br,pt_table,pt_const)
    c_table=make_table(c_len,NC) if c_len else None
    p_len,p_const=read_pt_len(br,np,pbit,-1)
    p_table=make_table(p_len,np) if p_len else None
    n=0
    while n<blocksize and len(out)<raw:
        c = c_const if c_table is None else hdecode(br,c_table)
        n+=1
        if c<256:
            out.append(c)
        else:
            length=c-256+THRESHOLD
            j = p_const if p_table is None else hdecode(br,p_table)
            if j==0: dist=0
            else: dist=(1<<(j-1))|br.getbits(j-1)
            dist+=1
            if dist>len(out): raise ValueError('dist out of range %d %d'%(dist,len(out)))
            for _ in range(length):
                out.append(out[-dist])
    return blocksize

def decompress(comp, raw, dicbit=13):
    np=dicbit+1; pbit=4 if dicbit==13 else 5
    br=BR(comp); out=bytearray()
    while len(out)<raw:
        bs=decode_block(br,dicbit,np,pbit,out,raw)
        if bs==0: break
    return bytes(out)
