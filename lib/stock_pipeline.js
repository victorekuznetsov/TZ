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

  /* --- Остатки: лист MM-M03, шапка на физической строке 12 (после 11
     строк заголовка отчёта BW), данные — фиксированные позиции колонок,
     как в build_stock.py (проверено на реальной выгрузке). --- */
  async function parseStock(zip, wkCodes, onProgress) {
    let rowsTotal = 0;
    const q = new Map(), v = new Map(), byWh = new Map();
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
      const wh = cells[18] != null ? String(cells[18]) : "?";
      if (!byWh.has(c)) byWh.set(c, new Map());
      const m = byWh.get(c);
      m.set(wh, (m.get(wh) || 0) + qty);
    }, onProgress);
    const byWarehouse = {};
    byWh.forEach((m, c) => { byWarehouse[c] = Object.fromEntries(m); });
    return { rowsTotal, q: Object.fromEntries(q), v: Object.fromEntries(v), byWarehouse };
  }

  /* --- Запас с ограниченным использованием: шапка — первая строка. --- */
  async function parseRestricted(zip, sheetName, wkCodes, onProgress) {
    let rowsTotal = 0;
    const restrQ = new Map(), restrV = new Map();
    let hdr = null, mi, ri, rv, bl, blv, qc, qcv;
    await XLSXStream.streamSheet(zip, sheetName, (cells) => {
      if (!hdr) {
        hdr = cells;
        mi = colIndex(hdr, "Материал");
        ri = colIndex(hdr, "ЗапОгрИспользования"); rv = colIndex(hdr, "Ст-ть/огр");
        bl = colIndex(hdr, "Блокированный запас"); blv = colIndex(hdr, "Ст-ть/блок. запаса");
        qc = colIndex(hdr, "Контроль качества"); qcv = colIndex(hdr, "Ст-ть/контр");
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
    }, onProgress);
    return { rowsTotal, q: Object.fromEntries(restrQ), v: Object.fromEntries(restrV) };
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

  /* --- Сборка итогового stock.json — та же логика, что в build_stock.py main(). --- */
  function assemble(ekmtrWk, stock, restr, purch, srcNames) {
    const wkCodes = new Set(ekmtrWk.items.map(e => e.code));
    const nameOf = new Map(ekmtrWk.items.map(e => [e.code, e.name]));
    const codes = new Set([...Object.keys(stock.q), ...Object.keys(restr.q), ...Object.keys(purch.byCode)]);
    const items = [];
    let fullyRestricted = 0;
    codes.forEach(c => {
      const q = stock.q[c] || 0, v = stock.v[c] || 0;
      const rq = restr.q[c] || 0, rv = restr.v[c] || 0;
      const availQ = Math.max(q - rq, 0);
      const unit = q ? v / q : 0;
      const availV = Math.round(availQ * unit * 100) / 100;
      const restrictedV = Math.round((v - availV) * 100) / 100;
      const isFully = q > 0 && availQ <= 0;
      if (isFully) fullyRestricted++;
      items.push({
        code: c, name: nameOf.get(c) || "",
        qty: Math.round(q * 1000) / 1000, value: Math.round(v * 100) / 100,
        restrictedQty: Math.round(rq * 1000) / 1000, restrictedValue: restrictedV,
        availQty: Math.round(availQ * 1000) / 1000, availValue: availV,
        fullyRestricted: isFully,
        byWarehouse: stock.byWarehouse[c] || {},
        purchase: purch.byCode[c] || null,
      });
    });
    const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
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
        rebuiltInBrowser: new Date().toISOString(),
      },
      items,
    };
  }

  return { parseStock, parseRestricted, parsePurchase, assemble, colIndex, firstSheetName };
})();

if (typeof module !== "undefined" && module.exports) module.exports = StockPipeline;
