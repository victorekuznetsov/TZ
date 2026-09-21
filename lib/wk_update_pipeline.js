/* Пересборка витрин WK CRM из сырых выгрузок BW — те же правила, что
   build/build_provision.py и build/build_uso_wk.py. PM-06 и «МТР УСО»
   разбирает lib/pm06_pipeline.js / lib/uso_pipeline.js; здесь — срез WK,
   зерно план/факт и ATP. */
const WkUpdate = (() => {
  "use strict";

  const WK_RE = /WK-?\d/i;
  const N = v => typeof v === "number" && !isNaN(v) ? v : 0;
  const DATE_RE = /(\d{2})[_.-](\d{2})[_.-](\d{4})/;
  const KEYS = ["fromStock", "fromBuy", "late", "undated", "gap"];

  function parseToroName(name) {
    const m = /(\d{4})[_-](20\d{2})/.exec(String(name || "").replace(/\.xlsx$/i, ""));
    return m ? { site: m[1], year: m[2] } : { site: "", year: "" };
  }
  function parseUsoName(name) {
    const s = String(name || "").replace(/\.xlsx$/i, "");
    const m = /(?:УСО|uso)[^\d]*(20\d{2})/i.exec(s) || /(20\d{2})/.exec(s);
    return m ? m[1] : "";
  }

  function asOf(meta) {
    let best = null;
    for (const key of ["srcStock", "srcRestricted", "srcPurchase"]) {
      const m = DATE_RE.exec(meta && meta[key] || "");
      if (!m) continue;
      const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
      if (!best || d > best) best = d;
    }
    return best || new Date();
  }

  function iso(d) {
    return d.toISOString().slice(0, 10);
  }

  function orderId(site, unit, order) {
    const raw = JSON.stringify([site, unit, String(order)]);
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0") +
      Math.imul(h, 2654435761 >>> 0).toString(16).padStart(8, "0").slice(0, 10);
  }

  function loadNeed(details) {
    const need = [], closed = [];
    let nocodeRows = 0, nocodeV = 0;
    for (const d of details) {
      if (!d || !d.e || !d.n) continue;
      const wkIdx = new Set();
      d.e.forEach((n, i) => { if (n && WK_RE.test(n)) wkIdx.add(i); });
      if (!wkIdx.size) continue;
      const od = d.od || {}, orr = d.orr || {};
      const grains = new Map();
      const uArr = d.u || [];
      const upArr = d.up || [];
      const ufArr = d.uf || [];
      const wArr = d.w || [];
      const wiArr = d.wi || [];
      for (let i = 0; i < d.n; i++) {
        if (!wkIdx.has(d.ei[i])) continue;
        const ei = d.ei[i], ci = d.ci[i], wi = wiArr[i];
        const order = d.o[i];
        const key = order + "\0" + ei + "\0" + wi + "\0" + ci;
        let g = grains.get(key);
        if (!g) {
          const unit = (typeof ei === "number" && ei < d.e.length) ? d.e[ei] : "";
          const work = (typeof wi === "number" && wi < wArr.length) ? wArr[wi] : "";
          const code = (typeof ci === "number" && ci < (d.cek || []).length) ? (d.cek[ci] || "") : "";
          const mat = (typeof ci === "number" && ci < (d.c || []).length) ? (d.c[ci] || "") : "";
          g = {
            date: ((od[order] || [""])[0] || ""), code, mat, order,
            kind: orr[order] || "", site: String(d.s), year: String(d.y),
            unit, work, method: uArr[i] || "",
            planQty: 0, factQty: 0, planValue: 0, factValue: 0, usoPlan: 0, usoFact: 0,
          };
          grains.set(key, g);
        }
        g.planQty += N(d.qp[i]);
        g.factQty += N(d.qf[i]);
        g.planValue += N(d.p[i]);
        g.factValue += N(d.a[i]);
        g.usoPlan += N(upArr[i]);
        g.usoFact += N(ufArr[i]);
        if (uArr[i]) g.method = uArr[i];
      }
      grains.forEach(g => {
        const remaining = Math.max(g.planQty - g.factQty, 0);
        if (!g.code) {
          nocodeRows++;
          nocodeV += g.planQty ? g.planValue * remaining / g.planQty : 0;
          return;
        }
        g.qty = remaining;
        g.value = g.planQty ? g.planValue * remaining / g.planQty : 0;
        if (remaining <= 0) {
          if (g.planQty > 0 || g.factQty > 0) closed.push(g);
          return;
        }
        need.push(g);
      });
    }
    return { need, closed, nocodeRows, nocodeV };
  }

  function allocate(need, stock, today) {
    const avail = {};
    const inflow = {};
    const asofMonth = today ? iso(today).slice(0, 7) : "";
    Object.keys(stock).forEach(c => {
      const s = stock[c];
      avail[c] = N(s.availQty);
      const raw = ((s.purchase || {}).byMonth) || {};
      const bm = {};
      Object.keys(raw).forEach(month => {
        const reliable = (asofMonth && month && month < asofMonth) ? "" : month;
        bm[reliable] = (bm[reliable] || 0) + N(raw[month]);
      });
      if (Object.keys(bm).length) inflow[c] = bm;
    });
    need.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || String(a.code).localeCompare(String(b.code)));
    need.forEach(r => {
      r.fromStock = 0; r.fromBuy = 0; r.late = 0; r.undated = 0; r.gap = 0; r.left = r.qty;
    });
    need.forEach(r => {
      const take = Math.min(r.left, avail[r.code] || 0);
      if (take > 0) { avail[r.code] -= take; r.fromStock += take; r.left -= take; }
      const month = (r.date || "").slice(0, 7);
      const sched = inflow[r.code];
      if (!sched || r.left <= 0 || !month) return;
      Object.keys(sched).filter(x => x && x <= month).sort().forEach(m => {
        if (r.left <= 0) return;
        const t = Math.min(r.left, sched[m]);
        if (t <= 0) return;
        sched[m] -= t; r.fromBuy += t; r.left -= t;
      });
    });
    need.forEach(r => {
      const sched = inflow[r.code];
      if (!sched || r.left <= 0) return;
      Object.keys(sched).sort((a, b) => (a || "9999").localeCompare(b || "9999")).forEach(m => {
        if (r.left <= 0) return;
        const t = Math.min(r.left, sched[m]);
        if (t <= 0) return;
        sched[m] -= t;
        if (!m) r.undated += t; else r.late += t;
        r.left -= t;
      });
    });
    need.forEach(r => { r.gap = r.left; });
    return need;
  }

  const val = (r, k) => r.qty ? r.value * (r[k] / r.qty) : 0;

  function totals(rows) {
    const t = { value: 0, qty: 0, lines: rows.length };
    KEYS.forEach(k => { t[k] = 0; t[k + "Qty"] = 0; });
    rows.forEach(r => {
      t.value += r.value; t.qty += r.qty;
      KEYS.forEach(k => { t[k] += val(r, k); t[k + "Qty"] += r[k]; });
    });
    t.value = Math.round(t.value * 100) / 100;
    t.qty = Math.round(t.qty * 1000) / 1000;
    KEYS.forEach(k => {
      t[k] = Math.round(t[k] * 100) / 100;
      t[k + "Qty"] = Math.round(t[k + "Qty"] * 1000) / 1000;
    });
    return t;
  }

  function buildOrders(rows, names) {
    const grouped = new Map();
    rows.forEach(r => {
      const key = r.site + "\0" + r.unit + "\0" + r.order;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    });
    const out = [];
    grouped.forEach(lines => {
      const t = totals(lines);
      const onTime = t.fromStock + t.fromBuy;
      let status = (t.gapQty + t.lateQty + t.undatedQty) <= 1e-9 ? "full"
        : ((t.fromStockQty + t.fromBuyQty) <= 1e-9 ? "none" : "partial");
      const detail = lines.slice().sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || a.work.localeCompare(b.work, "ru") || String(a.code).localeCompare(String(b.code))).map(r => {
        const row = {
          date: r.date, work: r.work, code: r.code,
          name: names[r.code] || r.mat, qty: Math.round(r.qty * 1000) / 1000,
          value: Math.round(r.value * 100) / 100,
          planQty: Math.round((r.planQty || 0) * 1000) / 1000,
          factQty: Math.round((r.factQty || 0) * 1000) / 1000,
          method: r.method || "",
          usoPlan: Math.round((r.usoPlan || 0) * 100) / 100,
          usoFact: Math.round((r.usoFact || 0) * 100) / 100,
        };
        KEYS.forEach(k => {
          row[k] = Math.round(r[k] * 1000) / 1000;
          row[k + "Value"] = Math.round(val(r, k) * 100) / 100;
        });
        return row;
      });
      const site = lines[0].site, unit = lines[0].unit, order = String(lines[0].order);
      const years = [...new Set(lines.map(r => String(r.year)))].sort();
      const dates = lines.map(r => r.date).filter(Boolean).sort();
      const mm = /WK-?(\d+C?)/i.exec(unit || "");
      const methods = [...new Set(lines.map(r => r.method).filter(Boolean))].sort();
      const planValue = Math.round(lines.reduce((s, r) => s + (r.planValue || 0), 0) * 100) / 100;
      const factValue = Math.round(lines.reduce((s, r) => s + (r.factValue || 0), 0) * 100) / 100;
      const closed = t.qty <= 1e-9 && (planValue > 0 || factValue > 0);
      if (closed) status = "closed";
      out.push({
        id: orderId(site, unit, order), site, unit,
        model: mm ? "WK-" + mm[1].toUpperCase() : "",
        order, years, date: dates[0] || "",
        kind: (lines.find(r => r.kind) || {}).kind || "",
        method: methods.length === 1 ? methods[0] : methods.join("+"),
        status, closed, planValue, factValue,
        coverage: closed ? 100 : (t.value ? Math.round(1000 * onTime / t.value) / 10 : 0),
        ...t, lines: detail,
      });
    });
    out.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || a.site.localeCompare(b.site) || a.unit.localeCompare(b.unit, "ru") || a.order.localeCompare(b.order));
    return out;
  }

  function assemble(details, ekmtrWk, stockJson) {
    const wkNames = {};
    (ekmtrWk.items || []).forEach(e => { wkNames[e.code] = e.name; });
    const stock = {};
    (stockJson.items || []).forEach(i => { stock[i.code] = i; });
    const today = asOf(stockJson.meta || {});
    const leadDefault = (stockJson.meta || {}).leadMedianDays || 0;
    const loaded = loadNeed(details);
    const need = allocate(loaded.need, stock, today);
    const known = need.filter(r => r.code in stock);
    const other = need.filter(r => !(r.code in stock));
    const wkClosed = loaded.closed.filter(r => r.code in wkNames).map(r => {
      r.fromStock = 0; r.fromBuy = 0; r.late = 0; r.undated = 0; r.gap = 0; r.left = 0;
      return r;
    });

    const agg = new Map();
    const first = {}, firstOpen = {};
    known.forEach(r => {
      let a = agg.get(r.code);
      if (!a) { a = { needQty: 0, needValue: 0 }; KEYS.forEach(k => { a[k] = 0; a[k + "Value"] = 0; }); agg.set(r.code, a); }
      a.needQty += r.qty; a.needValue += r.value;
      KEYS.forEach(k => { a[k] += r[k]; a[k + "Value"] += val(r, k); });
      if (r.date && (!(r.code in first) || r.date < first[r.code])) first[r.code] = r.date;
      const openQ = r.gap + r.late + r.undated;
      if (r.date && openQ > 0 && (!(r.code in firstOpen) || r.date < firstOpen[r.code])) firstOpen[r.code] = r.date;
    });

    const feas = {};
    const perCode = new Map();
    known.forEach(r => {
      const g = r.gap + r.late + r.undated;
      if (g <= 0) return;
      const lead = ((stock[r.code].purchase || {}).leadDays) || leadDefault;
      const eta = new Date(today); eta.setUTCDate(eta.getUTCDate() + lead);
      let k = "nodate", start = null;
      if (r.date) {
        start = new Date(r.date.slice(0, 10) + "T00:00:00Z");
        if (isNaN(+start)) start = null;
      }
      if (!start) k = "nodate";
      else if (start < today) k = "past";
      else if (eta <= start) k = "inTime";
      else if ((eta - start) / 86400000 <= 92) k = "late3";
      else k = "lateMore";
      const gv = val(r, "gap") + val(r, "late") + val(r, "undated");
      if (!feas[k]) feas[k] = { value: 0, qty: 0, lines: 0 };
      feas[k].value += gv; feas[k].qty += g; feas[k].lines += 1;
      if (!perCode.has(r.code)) perCode.set(r.code, {});
      const c = perCode.get(r.code);
      c[k] = (c[k] || 0) + gv;
      c[k + "Qty"] = (c[k + "Qty"] || 0) + g;
    });
    Object.keys(feas).forEach(k => {
      feas[k] = { value: Math.round(feas[k].value * 100) / 100, qty: Math.round(feas[k].qty * 1000) / 1000, lines: feas[k].lines };
    });

    const items = [];
    agg.forEach((a, code) => {
      const s = stock[code], p = s.purchase || {};
      const lead = p.leadDays || leadDefault;
      const fo = firstOpen[code] || "";
      const eta = new Date(today); eta.setUTCDate(eta.getUTCDate() + lead);
      let verdict = "covered", slip = null;
      if (a.gap + a.late + a.undated > 1e-9) {
        if (!fo) verdict = "nodate";
        else {
          const start = new Date(fo.slice(0, 10) + "T00:00:00Z");
          if (start < today) { verdict = "past"; slip = Math.round((today - start) / 86400000); }
          else if (eta <= start) verdict = "inTime";
          else { verdict = "late"; slip = Math.round((eta - start) / 86400000); }
        }
      }
      const status = (a.gap + a.late + a.undated) <= 1e-9 ? "full"
        : ((a.fromStock + a.fromBuy) <= 1e-9 ? "none" : "partial");
      const pc = perCode.get(code) || {};
      items.push({
        code, name: wkNames[code] || s.name || "",
        needQty: Math.round(a.needQty * 1000) / 1000,
        needValue: Math.round(a.needValue * 100) / 100,
        fromStock: Math.round(a.fromStock * 1000) / 1000,
        fromBuy: Math.round(a.fromBuy * 1000) / 1000,
        late: Math.round(a.late * 1000) / 1000,
        undated: Math.round(a.undated * 1000) / 1000,
        gap: Math.round(a.gap * 1000) / 1000,
        gapValue: Math.round((a.gapValue + a.lateValue + a.undatedValue) * 100) / 100,
        availQty: s.availQty || 0, openQty: p.openQty || 0,
        restricted: !!s.fullyRestricted, leadDays: lead, leadN: p.leadN || 0,
        firstNeed: first[code] || "", firstOpen: fo,
        orderBy: fo ? iso(new Date(new Date(fo.slice(0, 10) + "T00:00:00Z") - lead * 86400000)) : "",
        verdict, slipDays: slip, status,
        canOrder: Math.round((pc.inTime || 0) * 100) / 100,
        tooLate: Math.round(((pc.late3 || 0) + (pc.lateMore || 0) + (pc.past || 0) + (pc.nodate || 0)) * 100) / 100,
      });
    });
    items.sort((a, b) => b.gapValue - a.gapValue);

    const bym = {};
    agg.forEach((_, code) => {
      const bm = ((stock[code].purchase || {}).byMonth) || {};
      Object.keys(bm).forEach(m => { bym[m || ""] = (bym[m || ""] || 0) + bm[m]; });
    });

    function cut(rows, keyfn) {
      const g = new Map();
      rows.forEach(r => {
        const k = keyfn(r);
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(r);
      });
      return [...g].map(([key, v]) => ({ key, ...totals(v) })).sort((a, b) => String(a.key).localeCompare(String(b.key), "ru"));
    }

    const orders = buildOrders(known, wkNames);
    const closedOrders = buildOrders(wkClosed, wkNames);
    const sj = stockJson.meta || {};
    return {
      meta: {
        src: "браузер: PM-06 BW + текущий stock.json; план и факт слиты в зерно заказ×материал",
        srcStock: sj.srcStock, srcPurchase: sj.srcPurchase,
        asOf: iso(today),
        leadMedianDays: sj.leadMedianDays,
        leadMeasurements: sj.leadMeasurements,
        leadCodes: sj.leadCodes,
        orders: orders.length, closedOrders: closedOrders.length,
        lines: need.length, positions: items.length,
        noCodeRows: loaded.nocodeRows, noCodeValue: Math.round(loaded.nocodeV * 100) / 100,
        notWkParts: { lines: other.length, value: Math.round(other.reduce((s, r) => s + r.value, 0) * 100) / 100 },
        wk: totals(known),
        byYear: cut(known, r => String(r.year)),
        bySite: cut(known, r => String(r.site)),
        byHalf: cut(known, r => r.date ? r.date.slice(0, 4) + (r.date.slice(5, 7) <= "06" ? " I" : " II") : "без срока"),
        byKind: cut(known, r => r.kind || "не присвоено"),
        feasible: feas,
        arrivals: Object.keys(bym).sort((a, b) => (a || "9999").localeCompare(b || "9999")).map(m => ({ month: m, qty: Math.round(bym[m] * 1000) / 1000 })),
        rebuiltInBrowser: new Date().toISOString(),
      },
      items, orders, closedOrders,
    };
  }

  function orderPropsFromDetails(details) {
    const props = new Map();
    (details || []).forEach(d => {
      if (!d || !d.n) return;
      const acc = new Map();
      const bump = (m, v) => { if (v) m.set(v, (m.get(v) || 0) + 1); };
      for (let i = 0; i < d.n; i++) {
        const o = d.o[i];
        let x = acc.get(o);
        if (!x) acc.set(o, x = { wc: new Map(), w: new Map(), u: new Map(), e: new Map() });
        if (d.wc && d.wci) bump(x.wc, d.wc[d.wci[i]]);
        if (d.w && d.wi) bump(x.w, d.w[d.wi[i]]);
        if (d.u) bump(x.u, d.u[i]);
        if (d.e && d.ei) bump(x.e, d.e[d.ei[i]]);
      }
      const top = m => { let best = "", n = -1; m.forEach((c, v) => { if (c > n) { n = c; best = v; } }); return best; };
      acc.forEach((x, o) => {
        const od = (d.od && d.od[o]) || [null, null];
        props.set(String(o), {
          wc: top(x.wc), w: top(x.w), u: top(x.u), e: top(x.e),
          bs: od[0] || "", orr: String((d.orr && d.orr[o]) || "").trim(),
        });
      });
    });
    return props;
  }

  function buildUsoWk(rows, props, labels) {
    const SITE_REGION = (labels && labels.siteRegion) || { "7101": "1100", "7102": "1200", "7103": "1300", "7104": "1400" };
    const SITE_LABELS = (labels && labels.siteLabels) || {
      "1100": "Красноярск / Еруда", "1200": "Вернинское", "1300": "Алдан", "1400": "Магадан", "2400": "Сухой Лог",
      "7101": "Развитие Красноярск", "7102": "Развитие Иркутск", "7103": "Развитие Алдан", "7104": "Развитие Магадан",
    };
    const BE_SITE = (typeof USOPIPE !== "undefined" && USOPIPE.BE_SITE) || {};
    const byOrder = new Map();
    (rows || []).forEach(r => {
      const pr = (props && props.get(String(r.order))) || {};
      const unit = pr.e || r.eo || "";
      const model = r.model || "";
      if (!WK_RE.test(unit) && !WK_RE.test(model)) return;
      const key = String(r.order) + "|" + (r.y || "");
      if (!byOrder.has(key)) {
        const plant = String(r.site || "");
        const be = r.be || "";
        const site = BE_SITE[be] || SITE_REGION[plant] || plant;
        let mdl = "";
        const tail = /WK-?(\d+C?)/i.exec(unit || model);
        if (tail) mdl = "WK-" + tail[1].toUpperCase();
        byOrder.set(key, {
          order: String(r.order), plant, site, siteName: SITE_LABELS[site] || site,
          year: String(r.y || ""), unit, model: mdl, method: pr.u || r.mu || "",
          kind: pr.orr || r.rs || "", work: pr.w || r.wk || "", be,
          month: (pr.bs || r.mo || "").slice(0, 7), lines: [],
        });
      }
      byOrder.get(key).lines.push({
        code: String(r.ek || ""), name: r.name || "",
        qp: N(r.qp), qf: N(r.qf), p: N(r.p), a: N(r.a),
      });
    });
    const orders = [...byOrder.values()].map(o => {
      const open = o.lines.filter(x => x.qp > x.qf + 1e-9);
      o.closed = o.lines.length > 0 && open.length === 0;
      o.planValue = Math.round(o.lines.reduce((s, x) => s + x.p, 0) * 100) / 100;
      o.factValue = Math.round(o.lines.reduce((s, x) => s + x.a, 0) * 100) / 100;
      o.openValue = Math.round(open.reduce((s, x) => s + (x.qp ? x.p * Math.max(x.qp - x.qf, 0) / x.qp : 0), 0) * 100) / 100;
      return o;
    }).sort((a, b) => (a.month || "9999").localeCompare(b.month || "9999") || a.site.localeCompare(b.site) || a.order.localeCompare(b.order));
    return {
      meta: {
        src: "браузер: rawdata/УСО МТР УСО {год} all.xlsx",
        asOf: iso(new Date()),
        siteRegion: SITE_REGION, siteLabels: SITE_LABELS,
        orders: orders.length,
        rows: orders.reduce((s, o) => s + o.lines.length, 0),
        closedOrders: orders.filter(o => o.closed).length,
        openValue: Math.round(orders.reduce((s, o) => s + o.openValue, 0) * 100) / 100,
        planValue: Math.round(orders.reduce((s, o) => s + o.planValue, 0) * 100) / 100,
        factValue: Math.round(orders.reduce((s, o) => s + o.factValue, 0) * 100) / 100,
        rebuiltInBrowser: new Date().toISOString(),
      },
      orders,
    };
  }

  function mergeUsoWk(current, fresh, years) {
    const keep = ((current && current.orders) || []).filter(o => !years.has(String(o.year)));
    const merged = { orders: keep.concat(fresh.orders || []) };
    const m = fresh.meta || {};
    merged.meta = Object.assign({}, (current && current.meta) || {}, m, {
      orders: merged.orders.length,
      rows: merged.orders.reduce((s, o) => s + (o.lines || []).length, 0),
      closedOrders: merged.orders.filter(o => o.closed).length,
      openValue: Math.round(merged.orders.reduce((s, o) => s + (o.openValue || 0), 0) * 100) / 100,
      planValue: Math.round(merged.orders.reduce((s, o) => s + (o.planValue || 0), 0) * 100) / 100,
      factValue: Math.round(merged.orders.reduce((s, o) => s + (o.factValue || 0), 0) * 100) / 100,
    });
    return merged;
  }

  return { parseToroName, parseUsoName, loadNeed, allocate, assemble, orderPropsFromDetails, buildUsoWk, mergeUsoWk, asOf };
})();

if (typeof module !== "undefined" && module.exports) module.exports = WkUpdate;
