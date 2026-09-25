/* Ядро «Поиска по номеру» и раздела «Эффективность» — чистые расчёты без DOM.

   resolve(q, ref)          — каталожный номер / ЕКМТР / название → позиции
                              каталога, коды ЕКМТР и взаимозаменяемые номера;
   profile(src, codes, opt) — история расхода, план, цены, закупка, наличие и
                              статус по набору кодов ЕКМТР;
   efficiency(src, ctx)     — ABC расхода, запас без движения и избыток, индекс
                              цен, внеплановый расход, календарь «заказать до»,
                              поставщики.

   Входы — те же витрины, что у отчёта: строки графика (data/schedule_*),
   control (стадии заказов), provision, stock, fleet. Площадка строки — по
   борту (fleet), как в «Аналитике». Каждый расчёт повторён независимо в
   tests/verify_mtr.py и сверяется тестом tests/test_mtr.mjs. */
const MtrCore = (() => {
  "use strict";

  const N = v => (typeof v === "number" && isFinite(v) ? v : 0);
  // количество расхода: отрицательные строки — возврат демонтированного узла (−1 в заказах ХС/Комб), не расход
  const Q = v => Math.max(0, N(v));
  const r2 = v => Math.round(v * 100) / 100;
  const ratio = (a, b) => (b ? a / b : null);
  const dayMs = 86400000;
  const days = (a, b) => Math.round((Date.parse(b.slice(0, 10) + "T00:00:00Z") - Date.parse(a.slice(0, 10) + "T00:00:00Z")) / dayMs);
  const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  // как normArt отчёта: NFKC, ё→е, верхний регистр, только буквы и цифры
  const normArt = s => String(s == null ? "" : s).normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").toUpperCase().replace(/[^0-9A-ZА-ЯЁ]/g, "");
  const normText = s => String(s == null ? "" : s).normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const interKey = v => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
  const PRICE_JUMP = 5;       // цена изменилась больше чем в 5 раз — смена единицы или ошибка, в индекс не берём
  const shortUnit = u => String(u || "").replace("Экскаватор электрический ", "");

  /* ---------- поиск номера ---------- */
  /* ref: { catalog: [items], ekmtr: [{code,name,cat}], interchange: {groups}, knownCodes: Set, nameOf: Map code→name } */
  function resolve(q, ref) {
    const raw = String(q || "").trim(), qn = normArt(raw), qt = normText(raw);
    const out = { query: raw, arts: [], codes: [], suggestions: [], exact: false };
    if (!qn) return out;
    const cat = ref.catalog || [], ek = ref.ekmtr || [];
    const codes = new Map();                       // code → {code, name, rel, via:Set, arts:Set}
    const addCode = (code, rel, via, art) => {
      code = String(code); if (!code) return;
      let c = codes.get(code);
      if (!c) codes.set(code, (c = { code, name: (ref.nameOf && ref.nameOf.get(code)) || "", rel, via: new Set(), arts: new Set() }));
      if (rel === "self") c.rel = "self";
      c.via.add(via); if (art) c.arts.add(art);
    };
    const ekByCat = new Map();
    ek.forEach(e => { const k = normArt(e.cat); if (k) { if (!ekByCat.has(k)) ekByCat.set(k, []); ekByCat.get(k).push(e); } });
    const artsSelf = cat.filter(i => normArt(i.art) === qn || (i.artNew && normArt(i.artNew) === qn));
    const arts = new Map();
    const addArt = (i, rel) => { if (!arts.has(i.art) || rel === "self") arts.set(i.art, { ...i, rel }); };
    artsSelf.forEach(i => addArt(i, "self"));
    // сам номер: код каталога и коды ЕКМТР, в названии которых этот каталожный номер
    const selfKeys = new Set([qn, ...artsSelf.map(i => normArt(i.art))]);
    artsSelf.forEach(i => { if (i.ekmtr) addCode(i.ekmtr, "self", "каталог", i.art); });
    selfKeys.forEach(k => (ekByCat.get(k) || []).forEach(e => addCode(e.code, "self", "номер в названии ЕКМТР", artsSelf[0] ? artsSelf[0].art : raw)));
    if (/^\d{5,8}$/.test(raw) && ((ref.knownCodes && ref.knownCodes.has(raw)) || (ref.nameOf && ref.nameOf.has(raw)))) {
      addCode(raw, "self", "код ЕКМТР");
      cat.filter(i => String(i.ekmtr) === raw).forEach(i => addArt(i, "self"));
    }
    // взаимозаменяемые номера — прямые связи ведомости
    const groups = (ref.interchange && ref.interchange.groups) || [];
    const selfInter = new Set([raw, ...arts.keys()].map(interKey));
    const selfNorm = new Set([qn, ...[...arts.keys()].map(normArt)]);
    const analogs = new Set();
    groups.forEach(g => {
      if (!g.some(p => selfInter.has(interKey(p)) || selfNorm.has(normArt(p)))) return;
      g.forEach(p => { if (!selfNorm.has(normArt(p))) analogs.add(p); });
    });
    analogs.forEach(p => {
      const pn = normArt(p);
      const hits = cat.filter(i => normArt(i.art) === pn);
      hits.forEach(i => { if (!arts.has(i.art)) addArt(i, "analog"); if (i.ekmtr) addCode(i.ekmtr, "analog", "взаимозаменяемость", i.art); });
      if (!hits.length) arts.set(p, { art: p, nameRu: "", model: "", ekmtr: null, rel: "analog", notInCatalog: true });
      (ekByCat.get(pn) || []).forEach(e => addCode(e.code, "analog", "взаимозаменяемость", p));
    });
    out.arts = [...arts.values()].sort((a, b) => (a.rel === b.rel ? a.art.localeCompare(b.art) : a.rel === "self" ? -1 : 1));
    out.codes = [...codes.values()].map(c => ({ ...c, via: [...c.via], arts: [...c.arts] }))
      .sort((a, b) => (a.rel === b.rel ? a.code.localeCompare(b.code) : a.rel === "self" ? -1 : 1));
    out.exact = out.codes.some(c => c.rel === "self") || artsSelf.length > 0;
    // подсказки: частичное совпадение номера или названия
    if (qn.length >= 3 || qt.length >= 3) {
      const sug = [], seen = new Set();
      const push = (kind, key, name, sub, score) => { const k = kind + key; if (!seen.has(k)) { seen.add(k); sug.push({ kind, key, name, sub, score }); } };
      cat.forEach(i => {
        const a = normArt(i.art);
        if (a === qn) return;
        if (qn.length >= 3 && a.includes(qn)) push("art", i.art, i.nameRu || "", i.model || "", a.startsWith(qn) ? 0 : 1);
        else if (qt.length >= 3 && normText(i.nameRu).includes(qt)) push("art", i.art, i.nameRu || "", i.model || "", 2);
      });
      ek.forEach(e => {
        if (codes.has(String(e.code))) return;
        const a = normArt(e.cat);
        if (qn.length >= 3 && a && a !== qn && a.includes(qn)) push("code", String(e.code), e.name || "", "ЕКМТР", a.startsWith(qn) ? 0 : 1);
        else if (qt.length >= 3 && normText(e.name).includes(qt)) push("code", String(e.code), e.name || "", "ЕКМТР", 2);
      });
      out.suggestions = sug.sort((a, b) => a.score - b.score || a.key.localeCompare(b.key)).slice(0, 30);
    }
    return out;
  }

  /* ---------- общие помощники ---------- */
  function stageMap(controlRows) {
    const m = new Map();
    (controlRows || []).forEach(r => m.set(r.y + "|" + r.order, r.stage));
    return m;
  }
  function unitSites(fleet) { return new Map(((fleet && fleet.units) || []).map(u => [u.name, u.site])); }
  const siteOfRow = (us, r) => us.get(r.unit) || r.site;
  function inCtx(row, ctx) {
    if (!ctx) return true;
    if (ctx.site && row.site !== ctx.site) return false;
    if (ctx.model && row.model !== ctx.model) return false;
    if (ctx.unit && row.unit !== ctx.unit) return false;
    if (ctx.order && !String(row.order).includes(String(ctx.order))) return false;
    return true;
  }
  const lineUnc = l => N(l.late) + N(l.undated) + N(l.gap);
  const lineUncV = l => N(l.lateValue) + N(l.undatedValue) + N(l.gapValue);

  /* статус наличия: что есть, чего не хватает и что с этим делать */
  function statusOf(x) {
    // x: { need, fromStock, fromBuy, late, undated, gap, transfer, avail, openQty, recentFact, overdueQty }
    const unc = x.late + x.undated + x.gap;
    if (x.need > 0) {
      if (unc <= 1e-9) return x.fromBuy > 0
        ? { key: "coveredBuy", level: "ok", label: "Обеспечено: склад и закупка к сроку" }
        : { key: "covered", level: "ok", label: "Обеспечено складом" };
      if (x.gap > 0 && x.openQty <= 0) return { key: "notOrdered", level: "bad", label: "Дефицит: не заказано" };
      if (x.gap > 0) return { key: "short", level: "bad", label: "Дефицит: закупки не хватает" };
      return { key: "late", level: "warn", label: x.late > 0 ? "Дефицит к сроку: поставка опаздывает" : "Дефицит к сроку: поставка без даты" };
    }
    if (x.avail > 0 && !x.recentFact) return { key: "idle", level: "warn", label: "Запас без движения и без потребности" };
    if (x.avail > 0) return { key: "stock", level: "info", label: "В наличии, в плане не нужно" };
    if (x.openQty > 0) return { key: "buying", level: "info", label: "В закупке, в плане не нужно" };
    return { key: "none", level: "na", label: "Нет запаса, закупки и потребности" };
  }

  /* ---------- профиль позиции ---------- */
  /* src: { scheduleRows, controlRows, provision, stock, fleet, asOf, catalog }
     codes: [code] (свои) + opt.analogs: [code] — считаются отдельно (byRel) */
  function profile(src, codes, opt = {}) {
    const set = new Set(codes.map(String)), analogs = new Set((opt.analogs || []).map(String));
    const all = new Set([...set, ...analogs]);
    const asOf = src.asOf, cur = asOf.slice(0, 4), next = String(+cur + 1);
    const us = unitSites(src.fleet), st = stageMap(src.controlRows);
    const years = [...new Set((src.scheduleRows || []).map(r => r.year))].sort();
    const blank = () => ({ qp: 0, qf: 0, p: 0, a: 0, qpNoOrder: 0, pNoOrder: 0, lines: 0, orders: new Set(), units: new Set(), priceQp: 0, priceP: 0, priceQf: 0, priceA: 0 });
    const byRel = { self: {}, analog: {} };
    const bySite = {}, byCode = {}, unitsM = new Map(), orders = new Map();
    let lastFact = "";
    (src.scheduleRows || []).forEach(r => {
      const code = String(r.code || "");
      if (!all.has(code)) return;
      const rel = set.has(code) ? "self" : "analog", y = r.year, site = siteOfRow(us, r);
      const stage = st.get(y + "|" + r.order) || "";
      const noOrder = stage === "noOrder";
      const t = (byRel[rel][y] = byRel[rel][y] || blank());
      const s = ((bySite[site] = bySite[site] || {})[y] = bySite[site][y] || { qp: 0, qf: 0, p: 0, a: 0 });
      const c = ((byCode[code] = byCode[code] || {})[y] = byCode[code][y] || { qp: 0, qf: 0, p: 0, a: 0 });
      t.lines++; t.orders.add(r.order); t.units.add(r.unit);
      if (noOrder) { t.qpNoOrder += Q(r.qp); t.pNoOrder += N(r.p); }
      else { t.qp += Q(r.qp); t.p += N(r.p); }
      t.qf += Q(r.qf); t.a += N(r.a);
      if (Q(r.qp) > 0 && N(r.p) > 0) { t.priceQp += Q(r.qp); t.priceP += N(r.p); }
      if (Q(r.qf) > 0 && N(r.a) > 0) { t.priceQf += Q(r.qf); t.priceA += N(r.a); }
      if (rel === "self") {
        if (!noOrder) { s.qp += Q(r.qp); s.p += N(r.p); }
        s.qf += Q(r.qf); s.a += N(r.a);
      }
      if (!noOrder) { c.qp += Q(r.qp); c.p += N(r.p); }
      c.qf += Q(r.qf); c.a += N(r.a);
      if (rel === "self") {
        const u = unitsM.get(r.unit) || { unit: r.unit, site, model: r.model, qf: 0, a: 0, qp: 0, p: 0, years: new Set(), last: "" };
        u.qf += Q(r.qf); u.a += N(r.a); if (!noOrder) { u.qp += Q(r.qp); u.p += N(r.p); }
        if (Q(r.qf) > 0) { u.years.add(y); const d = r.end || r.start || ""; if (d > u.last) u.last = d; if (d > lastFact) lastFact = d; }
        unitsM.set(r.unit, u);
      }
      const ok = y + "|" + r.order + "|" + code;
      const o = orders.get(ok) || { year: y, order: r.order, unit: r.unit, site, model: r.model, work: r.work, code, rel, start: r.start || "", end: r.end || "", stage, qp: 0, qf: 0, p: 0, a: 0 };
      if (!noOrder) { o.qp += Q(r.qp); o.p += N(r.p); }
      else { o.qpNoOrder = (o.qpNoOrder || 0) + Q(r.qp); o.pNoOrder = (o.pNoOrder || 0) + N(r.p); }
      o.qf += Q(r.qf); o.a += N(r.a);
      orders.set(ok, o);
    });
    const fin = t => ({ qp: t.qp, qf: t.qf, p: r2(t.p), a: r2(t.a), qpNoOrder: t.qpNoOrder, pNoOrder: r2(t.pNoOrder), lines: t.lines,
      orders: t.orders.size, units: t.units.size, pricePlan: ratio(t.priceP, t.priceQp), priceFact: ratio(t.priceA, t.priceQf) });
    const hist = rel => Object.fromEntries(years.map(y => [y, fin(byRel[rel][y] || blank())]));
    const byYear = hist("self"), byYearAnalog = hist("analog");
    // средний годовой расход — последние три полных года
    const fullYears = years.filter(y => y < cur).slice(-3);
    const avgQf = fullYears.length ? fullYears.reduce((s, y) => s + byYear[y].qf, 0) / fullYears.length : 0;
    const recentFact = years.filter(y => y >= String(+cur - 2) && y <= cur).some(y => byYear[y].qf > 0);

    // потребность 2026–2027 (открытые заказы витрины обеспеченности)
    const needLines = [];
    const needBy = {}, needSite = {};
    const blankN = () => ({ qty: 0, value: 0, fromStock: 0, fromBuy: 0, late: 0, undated: 0, gap: 0, transfer: 0, uncValue: 0, lines: 0 });
    (src.provision.orders || []).forEach(o => (o.lines || []).forEach(l => {
      const code = String(l.code || "");
      if (!all.has(code)) return;
      const rel = set.has(code) ? "self" : "analog", site = us.get(o.unit) || o.site;
      const y = String((l.date || o.date || "").slice(0, 4));
      needLines.push({ rel, code, date: l.date || o.date || "", year: y, order: o.order, unit: o.unit, site, stage: o.stage, work: l.work,
        qty: N(l.qty), value: N(l.value), fromStock: N(l.fromStock), fromBuy: N(l.fromBuy), late: N(l.late), undated: N(l.undated), gap: N(l.gap),
        transfer: N(l.transferPotential), ppm: l.ppm || "", uncValue: lineUncV(l) });
      if (rel !== "self") return;
      for (const t of [(needBy[y] = needBy[y] || blankN()), (needSite[site] = needSite[site] || blankN())]) {
        t.qty += N(l.qty); t.value += N(l.value); t.fromStock += N(l.fromStock); t.fromBuy += N(l.fromBuy);
        t.late += N(l.late); t.undated += N(l.undated); t.gap += N(l.gap); t.transfer += N(l.transferPotential); t.uncValue += lineUncV(l); t.lines++;
      }
    }));
    needLines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order.localeCompare(b.order)));
    const needTot = Object.values(needBy).reduce((s, t) => { Object.keys(t).forEach(k => { s[k] += t[k]; }); return s; }, blankN());
    const items = (src.provision.items || []).filter(i => set.has(String(i.code)));

    // склад
    const WH = (src.stock.meta && src.stock.meta.warehouses) || {};
    const stockItems = (src.stock.items || []).filter(i => set.has(String(i.code)));
    const stockAn = (src.stock.items || []).filter(i => analogs.has(String(i.code)));
    const sumK = (a, k) => a.reduce((s, i) => s + N(i[k]), 0);
    const stockSite = {};
    stockItems.forEach(i => Object.entries(i.bySite || {}).forEach(([s, v]) => {
      const t = stockSite[s] || (stockSite[s] = { qty: 0, availQty: 0, value: 0, availValue: 0, restrictedQty: 0 });
      t.qty += N(v.qty); t.availQty += N(v.availQty); t.value += N(v.value); t.availValue += N(v.availValue); t.restrictedQty += N(v.restrictedQty);
    }));
    const warehouses = [];
    stockItems.forEach(i => Object.entries(i.byWarehouse || {}).forEach(([w, q]) => {
      const m = WH[w] || {};
      warehouses.push({ code: String(i.code), key: w, name: m.name || w, plant: m.plant || "", plantName: m.plantName || "", site: m.site || "", kind: m.kind || "",
        qty: N(q), avail: N((i.availByWarehouse || {})[w]), value: N((i.byWarehouseValue || {})[w]) });
    }));
    warehouses.sort((a, b) => b.qty - a.qty);
    const stock = { qty: sumK(stockItems, "qty"), availQty: sumK(stockItems, "availQty"), value: r2(sumK(stockItems, "value")), availValue: r2(sumK(stockItems, "availValue")),
      restrictedQty: sumK(stockItems, "restrictedQty"), restrictedValue: r2(sumK(stockItems, "restrictedValue")), bySite: stockSite, warehouses,
      analogAvailQty: sumK(stockAn, "availQty"), analogAvailValue: r2(sumK(stockAn, "availValue")) };
    stock.unitPrice = ratio(stock.value, stock.qty);

    // закупка: документы по всем кодам набора (цена — в валюте документа)
    const docs = [];
    const asOfM = asOf.slice(0, 7);
    let openQty = 0, transitQty = 0, overdueQty = 0;
    const byMonth = {}, leads = [];
    (src.stock.items || []).filter(i => all.has(String(i.code)) && i.purchase).forEach(i => {
      const rel = set.has(String(i.code)) ? "self" : "analog", p = i.purchase;
      if (rel === "self") {
        openQty += N(p.openQty); transitQty += N(p.transitQty);
        Object.entries(p.byMonth || {}).forEach(([mm, q]) => { byMonth[mm || "без даты"] = (byMonth[mm || "без даты"] || 0) + N(q); if (mm && mm < asOfM) overdueQty += N(q); });
      }
      (p.documents || []).forEach(d => {
        const lead = d.actualDeliveryDate && d.orderCreatedDate ? days(d.orderCreatedDate, d.actualDeliveryDate) : null;
        if (rel === "self" && lead != null && lead >= 0) leads.push(lead);
        docs.push({ rel, code: String(i.code), document: d.document, request: d.request, supplier: d.supplier || "", status: d.status || "",
          created: d.orderCreatedDate || d.requestDate || "", delivery: d.deliveryDate || "", actual: d.actualDeliveryDate || "", plant: d.plant || "",
          qty: N(d.qty), openQty: N(d.openQty), transitQty: N(d.transitQty), deliveredQty: N(d.deliveredQty), value: N(d.value), currency: d.currency || "",
          price: N(d.qty) ? N(d.value) / N(d.qty) : null, lead,
          overdue: N(d.openQty) > 0 && !!d.deliveryDate && d.deliveryDate.slice(0, 7) < asOfM });
      });
    });
    docs.sort((a, b) => (b.created || "").localeCompare(a.created || "") || String(a.document).localeCompare(String(b.document)));
    const selfPurch = (src.stock.items || []).filter(i => set.has(String(i.code)) && i.purchase).map(i => i.purchase);
    const sup = new Map();
    docs.filter(d => d.rel === "self").forEach(d => { const k = d.supplier || "—"; const t = sup.get(k) || { supplier: k, positions: 0, qty: 0, open: 0 }; t.positions++; t.qty += d.qty; t.open += d.openQty; sup.set(k, t); });
    const nextDelivery = Object.keys(byMonth).filter(m => m !== "без даты" && m >= asOfM).sort()[0] || null;
    const purchase = { openQty, transitQty, overdueQty, byMonth, docs, suppliers: [...sup.values()].sort((a, b) => b.positions - a.positions),
      leadDays: median(leads), leadN: leads.length, leadMedianCode: median(selfPurch.map(p => p.leadDays).filter(Boolean)), nextDelivery };

    // цены: план и факт по годам (₽), склад (₽), закупка (валюта документа), прайс ДП (¥)
    const cat = (src.catalog || []).filter(i => i.ekmtr && set.has(String(i.ekmtr)));
    const priceDocs = {};
    docs.filter(d => d.rel === "self" && d.price != null && d.created).forEach(d => {
      const k = d.created.slice(0, 4) + "|" + (d.currency || "?");
      const t = priceDocs[k] || (priceDocs[k] = { year: d.created.slice(0, 4), currency: d.currency || "", qty: 0, value: 0, n: 0 });
      t.qty += d.qty; t.value += d.value; t.n++;
    });
    const price = {
      byYear: Object.fromEntries(years.map(y => [y, { plan: byYear[y].pricePlan, fact: byYear[y].priceFact }])),
      stock: stock.unitPrice,
      purchase: Object.values(priceDocs).map(t => ({ ...t, price: t.qty ? t.value / t.qty : null })).sort((a, b) => a.year.localeCompare(b.year) || a.currency.localeCompare(b.currency)),
      catalogCNY: cat.map(i => ({ art: i.art, priceCNY: i.priceCNY, priceUsoCNY: i.priceUsoCNY })),
    };
    // «Общая стоимость» закупки — в рублях: цена документа / прайс ДП в юанях = курс пересчёта (≈ 12,48 ₽/¥)
    const cny = new Map(cat.filter(i => i.priceCNY).map(i => [String(i.ekmtr), i.priceCNY]));
    price.rateImplied = median(docs.filter(d => d.rel === "self" && d.price && cny.has(d.code)).map(d => d.price / cny.get(d.code)));
    const fy = years.filter(y => y <= cur && byYear[y].priceFact != null);
    price.factFirst = fy.length ? { year: fy[0], price: byYear[fy[0]].priceFact } : null;
    price.factLast = fy.length ? { year: fy[fy.length - 1], price: byYear[fy[fy.length - 1]].priceFact } : null;
    price.factChange = price.factFirst && price.factLast && price.factFirst.year !== price.factLast.year ? price.factLast.price / price.factFirst.price - 1 : null;
    const pn = byYear[next] && byYear[next].pricePlan;
    price.planVsFact = pn != null && price.factLast ? pn / price.factLast.price - 1 : null;

    // статус: весь парк и по площадкам
    const st0 = { need: needTot.qty, fromStock: needTot.fromStock, fromBuy: needTot.fromBuy, late: needTot.late, undated: needTot.undated, gap: needTot.gap,
      transfer: needTot.transfer, avail: stock.availQty, openQty, recentFact };
    const status = { all: { ...statusOf(st0), ...st0 }, bySite: {} };
    const sites = [...new Set([...Object.keys(needSite), ...Object.keys(stockSite)])].sort();
    sites.forEach(s => {
      const n = needSite[s] || blankN(), a = (stockSite[s] || {}).availQty || 0;
      const x = { need: n.qty, fromStock: n.fromStock, fromBuy: n.fromBuy, late: n.late, undated: n.undated, gap: n.gap, transfer: n.transfer, avail: a, openQty,
        recentFact: years.filter(y => y >= String(+cur - 2) && y <= cur).some(y => ((bySite[s] || {})[y] || {}).qf > 0) };
      status.bySite[s] = { ...statusOf(x), ...x };
    });
    const item = items[0] || null;
    status.orderBy = items.map(i => i.orderBy).filter(Boolean).sort()[0] || null;
    status.firstNeed = items.map(i => i.firstNeed).filter(Boolean).sort()[0] || (needLines.find(l => l.rel === "self" && lineUnc(l) > 0) || {}).date || null;
    status.verdict = item ? item.verdict : null;
    status.canOrder = items.reduce((s, i) => s + N(i.canOrder), 0);
    status.tooLate = items.reduce((s, i) => s + N(i.tooLate), 0);
    status.monthsOfStock = avgQf > 0 ? stock.availQty / (avgQf / 12) : null;

    return {
      codes: [...set], analogs: [...analogs], asOf, cur, next, years, fullYears,
      byYear, byYearAnalog, bySite, byCode,
      units: [...unitsM.values()].map(u => ({ ...u, unitShort: shortUnit(u.unit), years: [...u.years].sort() })).sort((a, b) => b.qf - a.qf || b.qp - a.qp),
      orders: [...orders.values()].sort((a, b) => (b.start || "").localeCompare(a.start || "") || b.year.localeCompare(a.year)),
      avgQf, recentFact, lastFact: lastFact || null,
      need: { lines: needLines, byYear: needBy, bySite: needSite, total: needTot, items },
      stock, purchase, price, status,
    };
  }

  /* ---------- эффективность ---------- */
  /* src: { scheduleRows, controlRows, provision, stock, fleet, asOf } */
  function efficiency(src, ctx) {
    ctx = ctx || {};
    const asOf = src.asOf, cur = asOf.slice(0, 4), next = String(+cur + 1), asOfM = asOf.slice(0, 7);
    const us = unitSites(src.fleet), stg = stageMap(src.controlRows);
    const rows = (src.scheduleRows || []).map(r => ({ r, site: siteOfRow(us, r) }))
      .filter(x => inCtx({ site: x.site, model: x.r.model, unit: x.r.unit, order: x.r.order }, ctx));
    const years = [...new Set((src.scheduleRows || []).map(r => r.year))].sort();
    const win = years.filter(y => y >= String(+cur - 2) && y <= cur);            // окно расхода: 3 последних года
    const factYears = years.filter(y => y <= cur);
    const noCtx = !(ctx.site || ctx.model || ctx.unit || ctx.order);

    // 1. ABC расхода (факт МТР за окно, по коду)
    const byCode = new Map();
    rows.forEach(({ r }) => {
      if (!r.code) return;
      let c = byCode.get(r.code);
      if (!c) byCode.set(r.code, (c = { code: String(r.code), name: "", a: 0, qf: 0, yq: {}, ya: {}, qp: {}, p: {} }));
      if (r.name && r.name.length > c.name.length) c.name = r.name;
      const y = r.year;
      if (win.includes(y)) { c.a += N(r.a); c.qf += Q(r.qf); }
      c.yq[y] = (c.yq[y] || 0) + Q(r.qf); c.ya[y] = (c.ya[y] || 0) + N(r.a);
      const stage = stg.get(y + "|" + r.order);
      if (stage !== "noOrder") { c.qp[y] = (c.qp[y] || 0) + Q(r.qp); c.p[y] = (c.p[y] || 0) + N(r.p); }
    });
    const cons = [...byCode.values()].filter(c => c.a > 0).sort((a, b) => b.a - a.a || a.code.localeCompare(b.code));
    const total = cons.reduce((s, c) => s + c.a, 0);
    let cum = 0;
    const cls = { A: { n: 0, value: 0 }, B: { n: 0, value: 0 }, C: { n: 0, value: 0 } };
    cons.forEach(c => {
      const before = cum; cum += c.a;
      c.cls = before / total < 0.8 ? "A" : before / total < 0.95 ? "B" : "C";
      c.cum = cum / total;
      cls[c.cls].n++; cls[c.cls].value += c.a;
    });
    const curve = [];
    const step = Math.max(1, Math.ceil(cons.length / 100));
    cons.forEach((c, i) => { if (i % step === 0 || i === cons.length - 1) curve.push([(i + 1) / cons.length, c.cum]); });

    // склад и потребность в контексте
    const stockItems = src.stock.items || [];
    const sv = (i, k) => (ctx.site ? N(((i.bySite || {})[ctx.site] || {})[k]) : N(i[k]));
    const need = new Map();         // code → {qty, value, unc, uncValue}
    (src.provision.orders || []).forEach(o => {
      const site = us.get(o.unit) || o.site;
      if (!inCtx({ site, model: o.model, unit: o.unit, order: o.order }, ctx)) return;
      (o.lines || []).forEach(l => {
        const c = String(l.code || ""); if (!c) return;
        const t = need.get(c) || { qty: 0, value: 0, unc: 0, uncValue: 0 };
        t.qty += N(l.qty); t.value += N(l.value); t.unc += lineUnc(l); t.uncValue += lineUncV(l);
        need.set(c, t);
      });
    });
    const abcTop = cons.slice(0, 15).map(c => {
      const i = stockItems.find(x => String(x.code) === c.code), n = need.get(c.code) || { qty: 0, unc: 0 };
      return { code: c.code, name: c.name, value: c.a, qf: c.qf, cls: c.cls, share: c.a / total, cum: c.cum,
        avail: i ? sv(i, "availQty") : 0, need: n.qty, unc: n.unc };
    });
    const aCodes = cons.filter(c => c.cls === "A");
    const aNoStock = aCodes.filter(c => { const i = stockItems.find(x => String(x.code) === c.code); return !(i && sv(i, "availQty") > 0); }).length;

    // 2. запас без движения и избыток (площадка — по складу; модель/борт на склад не влияют)
    const siteCons = new Map();    // расход кода на площадке контекста за окно (для площадки — по бортам площадки)
    (src.scheduleRows || []).forEach(r => {
      if (!r.code || !win.includes(r.year)) return;
      const s = siteOfRow(us, r);
      if (ctx.site && s !== ctx.site) return;
      siteCons.set(String(r.code), (siteCons.get(String(r.code)) || 0) + Q(r.qf));
    });
    const siteNeed = new Map();
    (src.provision.orders || []).forEach(o => {
      const s = us.get(o.unit) || o.site;
      if (ctx.site && s !== ctx.site) return;
      (o.lines || []).forEach(l => { const c = String(l.code || ""); if (c) siteNeed.set(c, (siteNeed.get(c) || 0) + N(l.qty)); });
    });
    const dead = [], excess = [];
    const deadSite = {};
    stockItems.forEach(i => {
      const code = String(i.code), q = sv(i, "availQty"), v = sv(i, "availValue");
      if (q <= 0 || v <= 0) return;
      const price = v / q, c = siteCons.get(code) || 0, n = siteNeed.get(code) || 0;
      if (c <= 0 && n <= 0) {
        dead.push({ code, name: i.name, qty: q, value: v });
        Object.entries(i.bySite || {}).forEach(([s, o]) => { if (!ctx.site || s === ctx.site) deadSite[s] = (deadSite[s] || 0) + N(o.availValue); });
        return;
      }
      const keep = n + 2 * (c / win.length);          // потребность плана + два года среднего расхода
      if (q > keep + 1e-9) {
        const xq = q - keep;
        excess.push({ code, name: i.name, qty: q, need: n, avgYear: c / win.length, excessQty: xq, value: xq * price });
      }
    });
    dead.sort((a, b) => b.value - a.value || a.code.localeCompare(b.code));
    excess.sort((a, b) => b.value - a.value || a.code.localeCompare(b.code));
    const stockTotal = stockItems.reduce((s, i) => s + sv(i, "availValue"), 0);
    const factAvgYear = win.length ? rows.filter(x => win.includes(x.r.year)).reduce((s, x) => s + N(x.r.a), 0) / win.length : 0;

    // 3. индекс цен списания (Ласпейрес по количеству прошлого года) и план следующего года к последней цене
    const price = (c, y) => (c.yq[y] > 0 && c.ya[y] > 0 ? c.ya[y] / c.yq[y] : null);
    const idx = [];
    for (let k = 1; k < factYears.length; k++) {
      const y0 = factYears[k - 1], y1 = factYears[k];
      let num = 0, den = 0, n = 0, out = 0;
      byCode.forEach(c => {
        const p0 = price(c, y0), p1 = price(c, y1);
        if (p0 == null || p1 == null) return;
        if (p1 / p0 > PRICE_JUMP || p0 / p1 > PRICE_JUMP) { out++; return; }   // смена единицы / ошибка цены — не инфляция
        num += p1 * c.yq[y0]; den += p0 * c.yq[y0]; n++;
      });
      idx.push({ from: y0, to: y1, index: den ? num / den : null, n, outliers: out, weight: den });
    }
    let chain = 1;
    const chainIdx = [{ year: factYears[0], value: 1 }];
    idx.forEach(x => { if (x.index != null && x.n >= 20) chain *= x.index; chainIdx.push({ year: x.to, value: x.index != null && x.n >= 20 ? chain : null, n: x.n }); });
    // рост цены: последняя цена года ≤ cur к первой известной (≥ 2 года между ними)
    const growth = [];
    let growthOut = 0;
    byCode.forEach(c => {
      const ys = factYears.filter(y => price(c, y) != null);
      if (ys.length < 2 || +ys[ys.length - 1] - +ys[0] < 2) return;
      const p0 = price(c, ys[0]), p1 = price(c, ys[ys.length - 1]);
      if (c.ya[ys[ys.length - 1]] < 50000) return;
      if (p1 / p0 > PRICE_JUMP || p0 / p1 > PRICE_JUMP) { growthOut++; return; }
      growth.push({ code: c.code, name: c.name, y0: ys[0], y1: ys[ys.length - 1], p0, p1, change: p1 / p0 - 1 });
    });
    growth.sort((a, b) => b.change - a.change || a.code.localeCompare(b.code));
    let pn = 0, pd = 0, pc = 0;
    byCode.forEach(c => {
      const q = c.qp[next] || 0, p = c.p[next] || 0;
      if (q <= 0 || p <= 0) return;
      const ly = factYears.slice().reverse().find(y => price(c, y) != null);
      if (!ly) return;
      pn += p; pd += price(c, ly) * q; pc++;
    });
    const planPrice = { index: pd ? pn / pd : null, n: pc, plan: pn, atFact: pd };

    // 4. внеплановый расход и неиспользованный план по строкам графика
    const unplanned = {};
    years.forEach(y => { unplanned[y] = { fact: 0, unplanned: 0, plan: 0, unused: 0, lines: 0, unplannedLines: 0 }; });
    rows.forEach(({ r }) => {
      const t = unplanned[r.year];
      const stage = stg.get(r.year + "|" + r.order);
      t.fact += N(r.a); t.lines++;
      if (N(r.a) > 0 && N(r.p) <= 0 && Q(r.qp) <= 0) { t.unplanned += N(r.a); t.unplannedLines++; }
      if (stage === "noOrder") return;
      t.plan += N(r.p);
      if (r.year < cur && N(r.p) > 0 && N(r.a) <= 0 && Q(r.qf) <= 0) t.unused += N(r.p);
    });
    Object.values(unplanned).forEach(t => { t.share = ratio(t.unplanned, t.fact); t.unusedShare = ratio(t.unused, t.plan); });

    // 5. календарь «заказать до»: непокрытое к сроку по месяцу крайней даты заказа
    const items = src.provision.items || [];
    const orderBy = {};
    let pastN = 0, pastV = 0, noDateV = 0;
    items.forEach(i => {
      const v = noCtx ? N(i.gapValue) : ((need.get(String(i.code)) || {}).uncValue || 0);
      if (v <= 0) return;
      if (!i.orderBy) { noDateV += v; return; }
      const mm = i.orderBy.slice(0, 7);
      const t = orderBy[mm] || (orderBy[mm] = { value: 0, n: 0 });
      t.value += v; t.n++;
      if (mm < asOfM) { pastN++; pastV += v; }
    });

    // 6. поставщики: просрочка и срок поставки (закупка общая, без контекста)
    const sup = new Map();
    stockItems.forEach(i => ((i.purchase && i.purchase.documents) || []).forEach(d => {
      const k = d.supplier || "—";
      const t = sup.get(k) || { supplier: k, positions: 0, open: 0, overdue: 0, delivered: 0, leads: [], codes: new Set() };
      t.positions++; t.codes.add(String(i.code));
      if (N(d.openQty) > 0) { t.open++; if (d.deliveryDate && d.deliveryDate.slice(0, 7) < asOfM) t.overdue++; }
      if (d.actualDeliveryDate) { t.delivered++; if (d.orderCreatedDate) { const l = days(d.orderCreatedDate, d.actualDeliveryDate); if (l >= 0) t.leads.push(l); } }
      sup.set(k, t);
    }));
    const suppliers = [...sup.values()].map(t => ({ supplier: t.supplier, positions: t.positions, open: t.open, overdue: t.overdue, delivered: t.delivered,
      codes: t.codes.size, overdueShare: ratio(t.overdue, t.open), leadMedian: median(t.leads), leadN: t.leads.length }))
      .sort((a, b) => b.open - a.open || b.positions - a.positions || a.supplier.localeCompare(b.supplier));

    return {
      asOf, cur, next, years, win, factYears,
      abc: { total, n: cons.length, classes: cls, curve, top: abcTop, aNoStock, aN: aCodes.length },
      stock: { total: stockTotal, factAvgYear, months: factAvgYear ? stockTotal / (factAvgYear / 12) : null,
        dead: { n: dead.length, value: dead.reduce((s, x) => s + x.value, 0), bySite: deadSite, top: dead.slice(0, 12) },
        excess: { n: excess.length, value: excess.reduce((s, x) => s + x.value, 0), top: excess.slice(0, 12) } },
      price: { pairs: idx, chain: chainIdx, growth: growth.slice(0, 12), growthN: growth.length, growthOut, fall: growth.slice().reverse().slice(0, 6), plan: planPrice },
      unplanned,
      orderBy: { months: orderBy, pastN, pastV, noDateV },
      suppliers: suppliers.slice(0, 12), suppliersN: suppliers.length,
    };
  }

  return { PRICE_JUMP, normArt, interKey, resolve, profile, efficiency, statusOf };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MtrCore;
