/* Браузерная пересборка stock.json из свежих выгрузок SAP — повторяет
   логику build/build_stock.py построчно, чтобы вкладка «Обновление
   данных» и офлайн-сборщик всегда давали одинаковый результат.

   Три файла: Остатки (лист MM-M03), Запас с ограниченным использованием,
   Закупка ALL. Столбцы находятся по подстроке в заголовке — та же
   стратегия, что в build_stock.py (col_index), не позиционные индексы,
   чтобы огрубление порядка колонок в новой выгрузке не било мимо. */

const StockPipeline = (() => {
  "use strict";

  const N = v => typeof v === "number" && !isNaN(v) ? v : 0;

  /* Дата из ячейки XLSX.

     Важно: XLSXStream не читает styles.xml, поэтому дата приходит сырым
     СЕРИЙНЫМ НОМЕРОМ Excel (46295), а не датой. Эпоха Excel — 1899-12-30
     (сдвиг на день учитывает несуществующее 29.02.1900). Диапазон
     сужен до 1954-2119, чтобы случайное число не стало датой; вызываем
     только для колонок «Дата поставки» и «Дата заявки».
     Раньше здесь брались первые 4 символа строки — на серийном номере это
     давало ключи вида «4629» вместо года. */
  const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
  function asDate(v) {
    if (v instanceof Date) return v;
    if (typeof v === "number" && v > 20000 && v < 80000)
      return new Date(EXCEL_EPOCH + Math.floor(v) * 86400000);
    if (typeof v === "string" && v.length >= 10) {
      const d = new Date(v.slice(0, 10) + "T00:00:00Z");
      return isNaN(d) ? null : d;
    }
    return null;
  }
  const iso = d => d ? d.toISOString().slice(0, 10) : "";
  const sortedObj = m => Object.fromEntries([...m.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([k, v]) => [k, Math.round(v * 1000) / 1000]));

  const median = a => {
    if (!a.length) return null;
    const b = [...a].sort((x, y) => x - y), h = b.length >> 1;
    return Math.round(b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2);
  };

  /* Имя первого листа книги — для «Запас с огр. использованием» и
     «Закупка ALL», где название листа заранее не известно (build_stock.py
     там берёт wb.active / wb.worksheets[0], а не лист по имени). */
  async function firstSheetName(zip) {
    const wb = await XLSXStream.readText(zip, "xl/workbook.xml");
    const m = /<sheet\b[^>]*\bname="([^"]*)"/.exec(wb);
    if (!m) throw new Error("Не нашёл ни одного листа в книге");
    return m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }

  function colIndex(hdr, needle) {
    const n = needle.toLowerCase();
    for (let i = 0; i < hdr.length; i++) {
      if (hdr[i] && String(hdr[i]).toLowerCase().includes(n)) return i;
    }
    return -1;
  }

  /* --- Площадка склада — по ЗАВОДУ строки, как в build_stock.py:
     11xx/7101/7106 — Красноярск, 14xx/7104 — Магадан, 12xx/24xx/7102/7108 —
     Сухой Лог (WK Иркутской области только там, заказы планирует завод 1200),
     13xx/7103 — Алдан. Склад — пара «завод/код». --- */
  const SITE_NAMES = { "1100": "Красноярск / Еруда", "1400": "Магадан", "2400": "Сухой Лог", "1300": "Алдан" };
  const PLANT_SITE = { "7101": "1100", "7106": "1100", "7104": "1400", "7102": "2400", "7108": "2400", "7103": "1300" };
  const PREFIX_SITE = { "11": "1100", "14": "1400", "12": "2400", "24": "2400", "13": "1300" };
  const TRANSIT_PLANTS = new Set(["110C", "1208", "7106", "7108"]);
  const str = x => x == null ? "" : String(x).trim();
  function plantSite(plant) {
    const p = str(plant).toUpperCase();
    return PLANT_SITE[p] || PREFIX_SITE[p.slice(0, 2)] || "";
  }
  function whKey(plant, code) { return `${str(plant)}/${str(code) || "#"}`; }
  function warehouseMeta(plant, plantName, be, code, name) {
    const p = str(plant), n = str(name) || "?";
    const kind = /консигнац/i.test(n) ? "consign" : TRANSIT_PLANTS.has(p.toUpperCase()) ? "transit" : "site";
    const site = plantSite(p);
    return { plant: p, plantName: str(plantName), be: str(be), code: str(code), name: n, site,
             siteName: SITE_NAMES[site] || "", kind };
  }

  /* --- Остатки: лист MM-M03, шапка на физической строке 12 (после 11
     строк заголовка отчёта BW), данные — фиксированные позиции колонок,
     как в build_stock.py (проверено на реальной выгрузке). --- */
  async function parseStock(zip, wkCodes, onProgress) {
    let rowsTotal = 0;
    const q = new Map(), v = new Map(), byWh = new Map(), byWhV = new Map(), warehouses = {};
    let seenHeader = false, rowCounter = -1;
    await XLSXStream.streamSheet(zip, "MM-M03", (cells) => {
      rowCounter++;
      if (rowCounter < 11) return;
      if (!seenHeader) { seenHeader = true; return; }
      rowsTotal++;
      const code = cells[9];
      if (!code) return;
      const c = String(code).trim();
      if (!wkCodes.has(c)) return;
      const qty = N(cells[19]), val = N(cells[20]);
      q.set(c, (q.get(c) || 0) + qty);
      v.set(c, (v.get(c) || 0) + val);
      // 1 — БЕ, 3/4 — завод и его имя, 17/18 — код и имя склада
      const wh = whKey(cells[3], cells[17]);
      if (!warehouses[wh]) warehouses[wh] = warehouseMeta(cells[3], cells[4], cells[2], cells[17], cells[18]);
      if (!byWh.has(c)) { byWh.set(c, new Map()); byWhV.set(c, new Map()); }
      const m = byWh.get(c), mv = byWhV.get(c);
      m.set(wh, (m.get(wh) || 0) + qty);
      mv.set(wh, (mv.get(wh) || 0) + val);
    }, onProgress);
    const byWarehouse = {}, byWarehouseValue = {};
    byWh.forEach((m, c) => { byWarehouse[c] = Object.fromEntries(m); });
    byWhV.forEach((m, c) => { byWarehouseValue[c] = Object.fromEntries(m); });
    return { rowsTotal, q: Object.fromEntries(q), v: Object.fromEntries(v), warehouses, byWarehouse, byWarehouseValue };
  }

  /* --- Запас с ограниченным использованием: шапка — первая строка. --- */
  async function parseRestricted(zip, sheetName, wkCodes, onProgress) {
    let rowsTotal = 0;
    const restrQ = new Map(), restrV = new Map(), restrWh = new Map();
    let hdr = null, mi, ri, rv, bl, blv, qc, qcv, pi, wi;
    await XLSXStream.streamSheet(zip, sheetName, (cells) => {
      if (!hdr) {
        hdr = cells;
        mi = colIndex(hdr, "Материал");
        ri = colIndex(hdr, "ЗапОгрИспользования"); rv = colIndex(hdr, "Ст-ть/огр");
        bl = colIndex(hdr, "Блокированный запас"); blv = colIndex(hdr, "Ст-ть/блок. запаса");
        qc = colIndex(hdr, "Контроль качества"); qcv = colIndex(hdr, "Ст-ть/контр");
        pi = colIndex(hdr, "Завод"); wi = colIndex(hdr, "Склад");
        return;
      }
      rowsTotal++;
      const code = cells[mi];
      if (!code) return;
      const c = String(code).trim();
      if (!wkCodes.has(c)) return;
      const rq = N(cells[ri]) + N(cells[bl]) + N(cells[qc]);
      const rv_ = N(cells[rv]) + N(cells[blv]) + N(cells[qcv]);
      restrQ.set(c, (restrQ.get(c) || 0) + rq);
      restrV.set(c, (restrV.get(c) || 0) + rv_);
      if (rq) {
        if (!restrWh.has(c)) restrWh.set(c, new Map());
        const m = restrWh.get(c), k = whKey(pi >= 0 ? cells[pi] : "", wi >= 0 ? cells[wi] : "");
        m.set(k, (m.get(k) || 0) + rq);
      }
    }, onProgress);
    const byWarehouse = {};
    restrWh.forEach((m, c) => { byWarehouse[c] = Object.fromEntries(m); });
    return { rowsTotal, q: Object.fromEntries(restrQ), v: Object.fromEntries(restrV), byWarehouse };
  }

  /* --- Закупка ALL: шапка — первая строка. --- */
  async function parsePurchase(zip, sheetName, wkCodes, onProgress) {
    let rowsTotal = 0;
    const byCode = new Map();
    let hdr = null, ci, li, ti, vi, di, si, qn, rq, doc, req, pos, reqPos, currency, unit, orderDate, actualDate, createdDate, plant, status, delivered;
    const leadAll = [];
    await XLSXStream.streamSheet(zip, sheetName, (cells) => {
      if (!hdr) {
        hdr = cells;
        ci = colIndex(hdr, "Код услуги");
        li = colIndex(hdr, "еще поставить");
        ti = colIndex(hdr, "Количество в пути");
        vi = colIndex(hdr, "Общая стоимость");
        di = colIndex(hdr, "Дата поставки");
        si = colIndex(hdr, "Имя поставщика");
        qn = colIndex(hdr, "Количество");
        rq = colIndex(hdr, "Дата заявки");
        const exact = names => names.map(n => hdr.findIndex(h => String(h || "").trim().toLowerCase() === n)).find(i => i >= 0) ?? -1;
        doc = exact(["документ закупки", "номер документа закупки", "№ документа закупки", "заказ на поставку"]);
        req = exact(["заявка", "заявка на закупку", "номер заявки", "№ заявки"]);
        pos = exact(["позиция документа закупки", "позиция заказа", "позиция"]);
        reqPos = exact(["позиция заявки"]);
        currency = exact(["валюта"]);
        orderDate = exact(["дата поставки по заказу"]);
        actualDate = exact(["фактическая дата поставки"]);
        createdDate = exact(["дата создания заказа"]);
        plant = exact(["завод"]);
        status = exact(["описание"]);
        delivered = exact(["кол-во факт поставки в базисной еи"]);
        unit = exact(["единица измерения", "еи", "е.и.", "базовая единица измерения"]);
        return;
      }
      rowsTotal++;
      const code = cells[ci];
      if (!code) return;
      const c = String(code).trim();
      if (!wkCodes.has(c)) return;
      let e = byCode.get(c);
      if (!e) {
        e = { planV: 0, openQty: 0, transitQty: 0, qty: 0, lines: 0,
              suppliers: new Map(), years: new Map(), byMonth: new Map(), lead: [], documents: [] };
        byCode.set(c, e);
      }
      e.planV += N(cells[vi]);
      e.openQty += N(cells[li]);
      e.transitQty += N(cells[ti]);
      e.qty += N(cells[qn]);
      e.lines++;
      if (cells[si]) e.suppliers.set(cells[si], (e.suppliers.get(cells[si]) || 0) + N(cells[vi]));
      // Фактический срок поставки: «дата поставки − дата заявки» по уже
      // оформленным строкам — единственный замер в выгрузке.
      const da = asDate(cells[rq]), db = asDate(cells[di]);
      const txt = i => i >= 0 && cells[i] != null ? String(cells[i]).trim() : "";
      e.documents.push({
        document: txt(doc), request: txt(req), position: txt(pos), requestPosition: txt(reqPos),
        deliveryDate: iso(asDate(cells[orderDate])) || iso(db),
        requiredDate: iso(db), orderDeliveryDate: iso(asDate(cells[orderDate])),
        actualDeliveryDate: iso(asDate(cells[actualDate])), orderCreatedDate: iso(asDate(cells[createdDate])),
        plant: txt(plant), status: txt(status), deliveredQty: delivered >= 0 ? N(cells[delivered]) : null,
        requestDate: iso(da), supplier: txt(si),
        qty: N(cells[qn]), openQty: N(cells[li]), transitQty: N(cells[ti]),
        value: N(cells[vi]), currency: txt(currency), unit: txt(unit), sourceRow: rowsTotal + 1
      });
      if (da && db) {
        const days = Math.round((db - da) / 86400000);
        if (days > 0 && days < 1500) { e.lead.push(days); leadAll.push(days); }
      }
      // years/byMonth — это ОТКРЫТОЕ КОЛИЧЕСТВО («еще поставить») по сроку
      // поставки, а не число строк: важно, сколько и когда придёт. Строки
      // без даты идут в ключ "" — срок неизвестен, обещать его нельзя.
      const left = N(cells[li]);
      if (left) {
        const d = iso(db);
        e.years.set(d.slice(0, 4), (e.years.get(d.slice(0, 4)) || 0) + left);
        e.byMonth.set(d.slice(0, 7), (e.byMonth.get(d.slice(0, 7)) || 0) + left);
      }
    }, onProgress);
    const out = {};
    byCode.forEach((e, c) => {
      let topSupplier = null, topV = -1;
      e.suppliers.forEach((v, s) => { if (v > topV) { topV = v; topSupplier = s; } });
      out[c] = {
        planV: Math.round(e.planV * 100) / 100, openQty: e.openQty, transitQty: e.transitQty,
        qty: e.qty, lines: e.lines, topSupplier, documents: e.documents,
        // Ключи сортируем — так же, как build_stock.py: иначе один и тот же
        // исходник даёт JSON с разным порядком месяцев.
        years: sortedObj(e.years), byMonth: sortedObj(e.byMonth),
        leadDays: median(e.lead), leadN: e.lead.length,
      };
    });
    return { rowsTotal, byCode: out, leadMedian: median(leadAll), leadN: leadAll.length,
             leadCodes: Object.values(out).filter(x => x.leadN).length };
  }

  /* --- Доступный остаток по складам и площадкам: ограниченный запас
     вычитается на том же складе (у склада своя цена: б/у часто 0 ₽);
     склад из файла ограничений, которого нет в остатках, — на наибольшем
     складе той же площадки, иначе на наибольшем складе кода.
     Как warehouse_split в build_stock.py. --- */
  function warehouseSplit(byq, byv, warehouses, restricted) {
    const left = { ...byq }, restr = {};
    Object.entries(restricted || {}).forEach(([key0, rq]) => {
      let key = key0;
      if (!(key in left)) {
        const site = plantSite(key.split("/")[0]);
        let same = Object.keys(left).filter(k => site && warehouses[k].site === site);
        if (!same.length) same = Object.keys(left);
        if (!same.length) return;
        key = same.reduce((a, b) => (left[b] > left[a] ? b : a));
      }
      restr[key] = (restr[key] || 0) + rq;
    });
    const avail = {}, sites = {};
    Object.entries(byq).forEach(([key, q]) => {
      const a = Math.max(q - (restr[key] || 0), 0);
      const unit = q ? (byv[key] || 0) / q : 0;
      avail[key] = Math.round(a * 1000) / 1000;
      const s = warehouses[key].site;
      const o = sites[s] || (sites[s] = { qty: 0, value: 0, availQty: 0, availValue: 0 });
      o.qty += q; o.value += byv[key] || 0; o.availQty += a; o.availValue += a * unit;
    });
    Object.values(sites).forEach(o => {
      o.restrictedQty = Math.round((o.qty - o.availQty) * 1000) / 1000;
      o.restrictedValue = Math.round((o.value - o.availValue) * 100) / 100;
      o.qty = Math.round(o.qty * 1000) / 1000; o.availQty = Math.round(o.availQty * 1000) / 1000;
      o.value = Math.round(o.value * 100) / 100; o.availValue = Math.round(o.availValue * 100) / 100;
    });
    return { avail, sites };
  }

  /* --- Сборка итогового stock.json — та же логика, что в build_stock.py main(). --- */
  function assemble(ekmtrWk, stock, restr, purch, srcNames) {
    const wkCodes = new Set(ekmtrWk.items.map(e => e.code));
    const nameOf = new Map(ekmtrWk.items.map(e => [e.code, e.name]));
    const codes = new Set([...Object.keys(stock.q), ...Object.keys(restr.q), ...Object.keys(purch.byCode)]);
    const items = [];
    let fullyRestricted = 0;
    codes.forEach(c => {
      const q = stock.q[c] || 0, v = stock.v[c] || 0;
      const rq = restr.q[c] || 0;
      const split = warehouseSplit(stock.byWarehouse[c] || {}, (stock.byWarehouseValue || {})[c] || {},
                                   stock.warehouses || {}, (restr.byWarehouse || {})[c]);
      const siteList = Object.values(split.sites);
      // доступно = сумма доступного по площадкам
      const availQ = siteList.length ? siteList.reduce((s, o) => s + o.availQty, 0) : Math.max(q - rq, 0);
      const availV = Math.round(siteList.reduce((s, o) => s + o.availValue, 0) * 100) / 100;
      const restrictedV = Math.round((v - availV) * 100) / 100;
      const isFully = q > 0 && availQ <= 0;
      if (isFully) fullyRestricted++;
      items.push({
        code: c, name: nameOf.get(c) || "",
        qty: Math.round(q * 1000) / 1000, value: Math.round(v * 100) / 100,
        restrictedQty: Math.round(rq * 1000) / 1000, restrictedValue: restrictedV,
        availQty: Math.round(availQ * 1000) / 1000, availValue: availV,
        fullyRestricted: isFully,
        byWarehouse: Object.fromEntries(Object.entries(stock.byWarehouse[c] || {}).map(([k, x]) => [k, Math.round(x * 1000) / 1000])),
        byWarehouseValue: Object.fromEntries(Object.entries((stock.byWarehouseValue || {})[c] || {}).map(([k, x]) => [k, Math.round(x * 100) / 100])),
        availByWarehouse: split.avail,
        bySite: split.sites,
        purchase: purch.byCode[c] || null,
      });
    });
    const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
    const used = new Set(items.flatMap(i => Object.keys(i.byWarehouse)));
    const sites = {};
    items.forEach(i => Object.entries(i.bySite).forEach(([st, o]) => {
      const t = sites[st] || (sites[st] = { name: SITE_NAMES[st] || "Площадка не определена", codes: 0, qty: 0, value: 0, availValue: 0, restrictedValue: 0 });
      t.codes += o.qty > 0 ? 1 : 0;
      ["qty", "value", "availValue", "restrictedValue"].forEach(k => { t[k] = Math.round((t[k] + o[k]) * 100) / 100; });
    }));
    return {
      meta: {
        srcStock: srcNames.stock, srcRestricted: srcNames.restricted, srcPurchase: srcNames.purchase,
        currency: "RUB",
        stockRowsTotal: stock.rowsTotal, restrictedRowsTotal: restr.rowsTotal, purchaseRowsTotal: purch.rowsTotal,
        codesWithStock: Object.keys(stock.q).length, codesWithPurchase: Object.keys(purch.byCode).length,
        fullyRestrictedCodes: fullyRestricted,
        totalValue: Math.round(sum(items, i => i.value) * 100) / 100,
        totalAvailValue: Math.round(sum(items, i => i.availValue) * 100) / 100,
        totalRestrictedValue: Math.round(sum(items, i => i.restrictedValue) * 100) / 100,
        totalPurchasePlanValue: Math.round(sum(Object.values(purch.byCode), p => p.planV) * 100) / 100,
        leadMedianDays: purch.leadMedian, leadMeasurements: purch.leadN,
        leadCodes: purch.leadCodes,
        siteRule: "площадка — по заводу строки: 11xx/7101/7106 — Красноярск, 14xx/7104 — Магадан, "
          + "12xx/24xx/7102/7108 — Сухой Лог, 13xx/7103 — Алдан",
        sites,
        warehouses: Object.fromEntries([...used].sort().map(k => [k, (stock.warehouses || {})[k]])),
        rebuiltInBrowser: new Date().toISOString(),
      },
      items,
    };
  }

  return { parseStock, parseRestricted, parsePurchase, assemble, colIndex, firstSheetName, plantSite, warehouseSplit, SITE_NAMES };
})();

if (typeof module !== "undefined" && module.exports) module.exports = StockPipeline;
