# -*- coding: utf-8 -*-
"""Метрики для презентации «Экскаваторы WK: исполнение 2024–2026 и план 2027».

Считает всё из витрин интерактивного отчёта (data/*.json, data/schedule_*.local.js)
и статусов заказов PM-06 (TOPO/pm06_meta/order_status). Правила — как в отчёте
и PM06_STATUSES.md:
  * позиции ППР без заказа SAP (фаза «нет статуса») в план не входят;
  * у оригинала БЕ, перенесённого копией в «Развитие», неисполненный план не
    считается: учитывается только факт;
  * площадка машины — по вкладке «Парк» (fleet.json).

Запуск: python3 build/build_wk_status_data.py <TOPO/pm06_meta/order_status> <out.json>
"""
import collections
import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
STATUS_DIR = sys.argv[1] if len(sys.argv) > 1 else '../TOPO/pm06_meta/order_status'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'wk_status_data.json'

YEARS = ['2024', '2025', '2026', '2027']
SITE_NAMES = {'1100': 'Красноярск / Еруда', '1400': 'Магадан', '2400': 'Сухой Лог'}
SITES = list(SITE_NAMES)


def jload(name):
    with open(os.path.join(DATA, name), encoding='utf-8') as f:
        return json.load(f)


def local_js(name):
    with open(os.path.join(DATA, name), encoding='utf-8') as f:
        t = f.read()
    return json.loads(t[t.index('=', t.index('__DATA__[')) + 1:].rstrip().rstrip(';'))


def short(unit):
    """«Экскаватор электрический WK-35 №04» → «WK-35 №04»."""
    return unit.replace('Экскаватор электрический ', '')


fleet = jload('fleet.json')
prov = jload('provision.json')
stock = jload('stock.json')
uso = jload('uso_wk.json')
cat = jload('catalog.json')
inter = jload('interchange.json')
quality = jload('quality.json')
repairs = jload('repairs.json')

unit_site = {u['name']: u['site'] for u in fleet['units']}

# ── строки истории заказов (вкладка «График · план-факт»)
man = local_js('schedule_manifest.local.js')
rows = []
for n in man['shards']:
    d = local_js(f'{n}.local.js')
    cols, dic = d['columns'], d['dictionaries']
    for v in d['rows']:
        rows.append({k: (dic[k][v[i]] if k in dic and v[i] is not None else v[i]) for i, k in enumerate(cols)})
for r in rows:
    r['fsite'] = unit_site.get(r['unit'], r['site'])

# ── статусы заказов PM-06: год → заказ → (фаза, копия-оригинал, сист., польз.)
status = collections.defaultdict(dict)
for fn in glob.glob(os.path.join(STATUS_DIR, '*.json')):
    d = json.load(open(fn, encoding='utf-8'))
    y = d['meta']['year']
    for o, (si, ui, ki, ph, cp) in d['o'].items():
        status[y][o] = (ph, cp, set(d['sys'][si].split()), set(d['usr'][ui].split()))

STAGES = [
    ('noOrder', 'Позиция ППР, заказа нет'),
    ('approving', 'Открыт, на согласовании'),
    ('approved', 'Открыт, согласован (СГГС)'),
    ('released', 'Деблокирован, без факта'),
    ('inWork', 'В работе'),
    ('factDone', 'Факт проведён (ФХСМ)'),
    ('techClosed', 'Тех. закрыт (ТЗКР)'),
    ('accepted', 'Принят СЗ (ПРСЗ)'),
    ('billed', 'Выставлен в БЕ (ВСБЕ)'),
    ('closed', 'Закрыт (ЗАКР)'),
    ('unknown', 'Нет в выгрузке статусов'),
]
GROUP = {'noOrder': 'ППР без заказа', 'approving': 'Согласование', 'approved': 'Согласование',
         'released': 'Деблокирован, пусто', 'inWork': 'В работе', 'factDone': 'В работе',
         'techClosed': 'Тех. закрыт', 'accepted': 'Тех. закрыт', 'billed': 'Тех. закрыт',
         'closed': 'Закрыт', 'unknown': 'Нет статуса'}
GROUPS = ['Закрыт', 'Тех. закрыт', 'В работе', 'Деблокирован, пусто', 'Согласование', 'ППР без заказа', 'Нет статуса']


def stage_of(year, order, fact):
    st = status.get(year, {}).get(order)
    if not st:
        return 'unknown', 0
    ph, cp, s, u = st
    if ph == 0:
        return 'noOrder', cp
    if ph == 4:
        return 'closed', cp
    if ph == 3:
        if 'ВСБЕ' in u:
            return 'billed', cp
        if 'ПРСЗ' in u:
            return 'accepted', cp
        return 'techClosed', cp
    if ph == 2:
        if 'ФХСМ' in u:
            return 'factDone', cp
        if fact > 0 or s & {'ПДТВ', 'ЧПДТ'} or 'ПРНТ' in u:
            return 'inWork', cp
        return 'released', cp
    return ('approved' if 'СГГС' in u else 'approving'), cp


# ── заказ × год: план/факт МТР и УСО
orders = {}
for r in rows:
    if r['year'] not in YEARS:
        continue
    k = (r['year'], r['order'])
    o = orders.setdefault(k, {'year': r['year'], 'order': r['order'], 'site': r['fsite'], 'unit': short(r['unit']),
                              'model': r['model'], 'reason': r['reason'], 'works': collections.Counter(),
                              'p': 0.0, 'a': 0.0, 'up': 0.0, 'uf': 0.0})
    for f in ('p', 'a', 'up', 'uf'):
        o[f] += r[f] or 0
    o['works'][r['work']] += (r['p'] or 0) + (r['up'] or 0)
for o in orders.values():
    o['plan'] = o['p'] + o['up']
    o['fact'] = o['a'] + o['uf']
    o['stage'], o['copy'] = stage_of(o['year'], o['order'], o['fact'])
    # правило копий: у оригинала БЕ неисполненный план не учитывается
    o['planCounted'] = 0.0 if o['stage'] == 'noOrder' else (min(o['plan'], o['fact']) if o['copy'] else o['plan'])
    o['work'] = o['works'].most_common(1)[0][0] if o['works'] else ''


def blank():
    return {'plan': 0.0, 'fact': 0.0, 'mtrPlan': 0.0, 'mtrFact': 0.0, 'usoPlan': 0.0, 'usoFact': 0.0,
            'orders': 0, 'noOrderPlan': 0.0, 'noOrderN': 0, 'copyExcluded': 0.0,
            'groups': {g: 0.0 for g in GROUPS}, 'groupN': {g: 0 for g in GROUPS},
            'stages': {k: 0.0 for k, _ in STAGES}, 'stageN': {k: 0 for k, _ in STAGES},
            'closedPlan': 0.0}


def add(acc, o):
    acc['groups'][GROUP[o['stage']]] += o['plan']
    acc['groupN'][GROUP[o['stage']]] += 1
    acc['stages'][o['stage']] += o['plan']
    acc['stageN'][o['stage']] += 1
    if o['stage'] == 'noOrder':
        acc['noOrderPlan'] += o['plan']
        acc['noOrderN'] += 1
        return
    acc['orders'] += 1
    acc['plan'] += o['planCounted']
    acc['copyExcluded'] += o['plan'] - o['planCounted']
    acc['fact'] += o['fact']
    share = o['planCounted'] / o['plan'] if o['plan'] else 0
    acc['mtrPlan'] += o['p'] * share
    acc['usoPlan'] += o['up'] * share
    acc['mtrFact'] += o['a']
    acc['usoFact'] += o['uf']
    if o['stage'] in ('techClosed', 'accepted', 'billed', 'closed'):
        acc['closedPlan'] += o['planCounted']


def finish(acc):
    acc['exec'] = acc['fact'] / acc['plan'] if acc['plan'] else None
    acc['closedShare'] = acc['closedPlan'] / acc['plan'] if acc['plan'] else None
    return acc


total_y = {y: blank() for y in YEARS}
site_y = {s: {y: blank() for y in YEARS} for s in SITES}
unit_y = collections.defaultdict(lambda: {y: blank() for y in YEARS})
model_y = collections.defaultdict(lambda: {y: blank() for y in YEARS})
work_y = collections.defaultdict(lambda: {y: [0.0, 0.0] for y in YEARS})
reason_y = collections.defaultdict(lambda: {y: [0.0, 0.0] for y in YEARS})
for o in orders.values():
    y = o['year']
    add(total_y[y], o)
    add(site_y[o['site']][y], o)
    add(unit_y[o['unit']][y], o)
    add(model_y[o['model']][y], o)
    if o['stage'] != 'noOrder':
        work_y[o['work']][y][0] += o['planCounted']
        work_y[o['work']][y][1] += o['fact']
        reason_y[o['reason']][y][0] += o['planCounted']
        reason_y[o['reason']][y][1] += o['fact']
for d in [total_y, *site_y.values(), *unit_y.values(), *model_y.values()]:
    for y in YEARS:
        finish(d[y])

# ── материалы: топ по факту 2024–2026 и по плану 2027
mat = collections.defaultdict(lambda: {'name': '', 'fact': 0.0, 'plan27': 0.0, 'qf': 0.0, 'qp27': 0.0, 'units': set()})
for r in rows:
    if r['year'] not in YEARS or not r['code']:
        continue
    st = status.get(r['year'], {}).get(r['order'])
    m = mat[r['code']]
    if r['name'] and len(r['name']) > len(m['name']):
        m['name'] = r['name']
    if r['year'] in ('2024', '2025', '2026'):
        m['fact'] += r['a'] or 0
        m['qf'] += r['qf'] or 0
    elif st and st[0] != 0:
        m['plan27'] += r['p'] or 0
        m['qp27'] += r['qp'] or 0
        m['units'].add(short(r['unit']))
top_fact = sorted(({'code': c, **{k: v for k, v in m.items() if k != 'units'}} for c, m in mat.items()),
                  key=lambda x: -x['fact'])[:12]
top_plan27 = sorted(({'code': c, 'units': len(m['units']), **{k: v for k, v in m.items() if k != 'units'}}
                     for c, m in mat.items()), key=lambda x: -x['plan27'])[:12]

# ── КТГ по годам и месяцам (вкладка «Парк»)
months = fleet['meta']['months']


def avg(vals):
    vals = [v for v in vals if v and v > 0]
    return sum(vals) / len(vals) if vals else None


ktg_unit = {}
for u in fleet['units']:
    rec = {}
    for y in ['2024', '2025', '2026']:
        idx = [i for i, m in enumerate(months) if m.startswith(y)]
        rec[y] = {'plan': avg([u['ktgByMonth'][i] for i in idx]), 'fact': avg([u['kioByMonth'][i] for i in idx])}
    ktg_unit[short(u['name'])] = rec
ktg_site_month = {}
for s in SITES:
    us = [u for u in fleet['units'] if u['site'] == s]
    ktg_site_month[s] = {'plan': [avg([u['ktgByMonth'][i] for u in us]) for i in range(len(months))],
                         'fact': [avg([u['kioByMonth'][i] for u in us]) for i in range(len(months))]}
ktg_site_year = {s: {y: {'plan': avg([v for m, v in zip(months, ktg_site_month[s]['plan']) if m.startswith(y)]),
                         'fact': avg([v for m, v in zip(months, ktg_site_month[s]['fact']) if m.startswith(y)])}
                     for y in ['2024', '2025', '2026']} for s in SITES}
ktg_fleet_month = {'plan': [avg([u['ktgByMonth'][i] for u in fleet['units']]) for i in range(len(months))],
                   'fact': [avg([u['kioByMonth'][i] for u in fleet['units']]) for i in range(len(months))]}

# ── обеспеченность 2026–2027 (вкладка «Обеспеченность»)
PV = ['fromStock', 'fromBuy', 'late', 'undated', 'gap']


def pv_blank():
    return {k: 0.0 for k in ['value', *PV]} | {'orders': 0}


prov_site = {s: {y: pv_blank() for y in ('2026', '2027')} for s in SITES}
prov_unit = collections.defaultdict(lambda: {y: pv_blank() for y in ('2026', '2027')})
for o in prov['orders']:
    s = unit_site.get(o['unit'], o['site'])
    y = o['years'][0] if o['years'] else o['date'][:4]
    for tgt in (prov_site[s][y], prov_unit[short(o['unit'])][y]):
        tgt['orders'] += 1
        for k in ['value', *PV]:
            tgt[k] += o[k]
deficit = sorted(prov['items'], key=lambda i: -(i['gapValue'] or 0))[:12]
deficit = [{k: i[k] for k in ('code', 'name', 'needQty', 'needValue', 'fromStock', 'fromBuy', 'late', 'undated',
                              'gap', 'gapValue', 'leadDays', 'firstNeed', 'orderBy', 'verdict', 'canOrder', 'tooLate')}
           for i in deficit]
order_today = sorted((i for i in prov['items'] if (i.get('canOrder') or 0) > 0), key=lambda i: -i['canOrder'])
order_today_sum = sum(i['canOrder'] for i in order_today)
order_today = [{k: i[k] for k in ('code', 'name', 'gapValue', 'canOrder', 'leadDays', 'orderBy')} for i in order_today[:10]]

# ── запасы (вкладка «Запасы»)
SITE_RE = [('1400', ('1400', 'магадан', 'янтарь')), ('2400', ('2400', 'сухой')), ('1200', ('1200', 'вернин')),
           ('1300', ('1300', 'алдан')), ('1100', ('1100', 'еруда', 'благодат', 'ожок', 'бгок', 'карьер', 'восточн', 'бывш'))]


def wh_site(name):
    w = name.lower()
    if 'консигнац' in w:
        return 'Консигнация'
    if w[:4] in ('7101', '7102', '7103', '7104'):
        return 'Склады подрядчика'
    for s, keys in SITE_RE:
        if any(w.startswith(k) if k.isdigit() else k in w for k in keys):
            return {'1100': 'Красноярск / Еруда', '1400': 'Магадан', '2400': 'Сухой Лог',
                    '1200': 'Вернинское', '1300': 'Алдан'}[s]
    return 'Не подписан'


stock_site = collections.Counter()
stock_wh = collections.Counter()
for i in stock['items']:
    tot = sum(i['byWarehouse'].values()) or 0
    if not tot:
        continue
    for wh, q in i['byWarehouse'].items():
        stock_site[wh_site(wh)] += i['value'] * q / tot
        stock_wh[wh] += i['value'] * q / tot
need_codes = {str(i['code']) for i in prov['items']}
stock_need = sum(i['availValue'] for i in stock['items'] if str(i['code']) in need_codes)
top_stock = sorted(stock['items'], key=lambda i: -i['value'])[:10]
top_stock = [{'code': i['code'], 'name': i['name'], 'qty': i['qty'], 'value': i['value'],
              'restricted': i['restrictedValue'], 'inNeed': str(i['code']) in need_codes} for i in top_stock]

# ── закупки (вкладка «Закупки»)
as_of = prov['meta']['asOf'][:7]
pur_month = collections.Counter()
pur_status = collections.Counter()
supp = collections.Counter()
cur = collections.Counter()
lead = []
overdue_v = undated_v = 0.0
pur_items = [i for i in stock['items'] if i['purchase']]
for i in pur_items:
    p = i['purchase']
    for m, q in (p.get('byMonth') or {}).items():
        pur_month[m or 'без даты'] += q
        if not m:
            undated_v += q
        elif m < as_of:
            overdue_v += q
    for d in p['documents']:
        if d['openQty'] > 0:
            pur_status[d['status'].split('\\')[0] or 'не указан'] += d['openQty']
            cur[d['currency'] or 'RUB'] += d['value']
    supp[p['topSupplier'] or 'не указан'] += p['openQty']
    if p.get('leadDays'):
        lead.append(p['leadDays'])
lead.sort()
lead_hist = collections.Counter(min(d // 90, 5) for d in lead)

# ── УСО (МТР подрядчика)
uso_y = {s: {y: {'plan': 0.0, 'fact': 0.0, 'open': 0.0, 'orders': 0, 'closed': 0} for y in YEARS} for s in SITES}
uso_work = collections.Counter()
for o in uso['orders']:
    s = unit_site.get(o['unit'], o['site'])
    if o['year'] not in YEARS or s not in uso_y:
        continue
    t = uso_y[s][o['year']]
    t['plan'] += o['planValue']
    t['fact'] += o['factValue']
    t['open'] += o['openValue']
    t['orders'] += 1
    t['closed'] += 1 if o['closed'] else 0
    uso_work[o['work'] or 'не указан'] += o['planValue']

out = {
    'asOf': prov['meta']['asOf'],
    'siteNames': SITE_NAMES,
    'years': YEARS,
    'stages': STAGES,
    'groups': GROUPS,
    'fleet': [{'unit': short(u['name']), 'site': u['site'], 'model': u['model'], 'book': u['book'],
               'serial': u['serial'], 'ktgPlan': u['ktg'], 'ktgFact': u['kio']} for u in fleet['units']],
    'total': total_y, 'site': site_y, 'unit': dict(unit_y), 'model': dict(model_y),
    'work': {k: v for k, v in work_y.items()}, 'reason': {k: v for k, v in reason_y.items()},
    'topFact': top_fact, 'topPlan27': top_plan27,
    'ktg': {'months': months, 'unit': ktg_unit, 'siteMonth': ktg_site_month, 'siteYear': ktg_site_year,
            'fleetMonth': ktg_fleet_month},
    'prov': {'meta': {k: prov['meta'][k] for k in ('wk', 'byYear', 'byKind', 'byPpm', 'feasible', 'arrivals',
                                                     'leadMedianDays', 'positions', 'notWkParts', 'sapRemoved')},
             'site': prov_site, 'unit': dict(prov_unit), 'deficit': deficit,
             'orderToday': order_today, 'orderTodaySum': order_today_sum, 'orderTodayN': sum(1 for i in prov['items'] if (i.get('canOrder') or 0) > 0)},
    'stock': {'meta': {k: stock['meta'][k] for k in ('totalValue', 'totalAvailValue', 'totalRestrictedValue',
                                                       'totalPurchasePlanValue', 'codesWithStock', 'codesWithPurchase',
                                                       'fullyRestrictedCodes', 'leadMedianDays')},
              'bySite': dict(stock_site), 'byWarehouse': [[w, v, wh_site(w)] for w, v in stock_wh.most_common(10)], 'forNeed': stock_need, 'top': top_stock},
    'purchase': {'items': len(pur_items), 'plan': sum(i['purchase']['planV'] for i in pur_items), 'openQty': sum(i['purchase']['openQty'] for i in pur_items), 'transitQty': sum(i['purchase']['transitQty'] for i in pur_items), 'currency': dict(cur),
                 'byMonth': dict(pur_month), 'byStatus': dict(pur_status), 'overdue': overdue_v,
                 'undated': undated_v, 'needCodes': sum(1 for i in pur_items if str(i['code']) in need_codes), 'suppliers': supp.most_common(8), 'nSuppliers': len(supp),
                 'leadMedian': lead[len(lead) // 2] if lead else None, 'leadHist': dict(lead_hist), 'leadN': len(lead)},
    'uso': {'site': uso_y, 'work': uso_work.most_common(8), 'meta': {k: uso['meta'][k] for k in
                                                                       ('orders', 'closedOrders', 'planValue', 'factValue', 'openValue')}},
    'provItems': {str(i['code']): {k: i[k] for k in ('needQty', 'fromStock', 'fromBuy', 'verdict')} for i in prov['items']},
    'catalog': cat['meta'], 'interchange': inter['meta'],
    'quality': quality['issues'],
    'repairsTotals': repairs['meta'],
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=1, default=lambda x: sorted(x) if isinstance(x, set) else str(x))
print('saved', OUT)
