/* Вкладки «Аналитика» и «Контроль отделов».

   Расчёты — lib/analytics_core.js (без DOM, проверяется тестами), здесь только
   отрисовка. Всё реагирует на сквозные фильтры отчёта (площадка, модель,
   машина, заказ). Графики — SVG на переменных темы, подписи значений прямо на
   метках, у каждого графика легенда и подсказки при наведении. */
"use strict";

let AN_CACHE = { key: null, model: null, refs: [] };
let AN_LEVEL = "problems";   // problems | all
let AN_GROUP = "";
let CTRL_DEPT = "plan";      // plan | exec | budget
let CTRL_FACT = "";          // фильтр списков заказов по факту
const CTRL_FACTS = [
  ["", "Все заказы", () => true],
  ["has", "Есть факт", r => r.fact > 0],
  ["none", "Нет факта", r => r.fact <= 0],
  ["over", "Факт выше плана > 10%", r => r.planCounted > 0 && r.fact > r.planCounted * 1.1],
  ["match", "Факт в пределах ±10% плана", r => r.planCounted > 0 && Math.abs(r.fact - r.planCounted) <= r.planCounted * 0.1],
  ["under", "Факт ниже плана > 10%", r => r.fact > 0 && r.fact < r.planCounted * 0.9],
  ["noplan", "Факт без плана", r => r.planCounted <= 0 && r.fact > 0],
];
const ctrlFactPred = () => (CTRL_FACTS.find(f => f[0] === CTRL_FACT) || CTRL_FACTS[0])[2];

function anModel() {
  const ctx = { site: G.site, model: G.model, unit: G.unit, order: G.order };
  const key = JSON.stringify(ctx);
  // витрины могут подмениться во вкладке «Обновление данных» — кэш сверяем и по ним
  const refs = [D.control, D.provision, D.stock, D.fleet];
  if (AN_CACHE.key === key && AN_CACHE.model && AN_CACHE.refs.every((r, i) => r === refs[i])) return AN_CACHE.model;
  if (!D.controlRows || D.controlRowsOf !== D.control) { D.controlRows = AnalyticsCore.decodeControl(D.control); D.controlRowsOf = D.control; }
  const model = AnalyticsCore.buildModel({ control: D.control, controlRows: D.controlRows, provision: D.provision, stock: D.stock, fleet: D.fleet }, ctx);
  AN_CACHE = { key, model, refs };
  return model;
}

/* ---------- палитра (переменные темы) ---------- */
const AN_C = {
  plan: "var(--c6)", fact: "var(--c1)",
  own: "var(--good)", buy: "var(--info)", late: "var(--warn)", gap: "var(--bad)",
  pot: "color-mix(in srgb, var(--bad) 32%, var(--surface-2))",
  y2024: "var(--c2)", y2025: "var(--c4)", y2026: "var(--c7)", y2027: "var(--c1)",
  "Закрыт": "var(--c1)", "Тех. закрыт": "color-mix(in srgb, var(--c1) 55%, var(--surface-2))",
  "В работе": "var(--c7)", "Деблокирован, пусто": "var(--warn)", "Согласование": "var(--info)",
  "ППР без заказа": "var(--c6)", "Нет статуса": "var(--line-2)",
};
const AN_LEVELS = {
  bad: { label: "Критично", cls: "bad" }, warn: { label: "Внимание", cls: "warn" },
  info: { label: "К сведению", cls: "info" }, ok: { label: "Норма", cls: "good" },
};
const anShort = u => String(u || "").replace("Экскаватор электрический ", "");
const anSite = s => (siteNameOf(s) || s || "—");
const anM = v => v == null ? "—" : num(v / 1e6, Math.abs(v) < 1e7 ? 1 : 0);

/* Графики рисуются в натуральную ширину своего блока: разметка кладёт
   заглушку, anMount() меряет её и строит SVG — подписи одного размера и в
   половинной карточке, и во всю ширину. */
let AN_CHARTS = [];
function anChart(draw) {
  return `<div class="an-chart" data-an-chart="${AN_CHARTS.push(draw) - 1}"></div>`;
}
function anMount(host) {
  qsa("[data-an-chart]", host).forEach(el => {
    const draw = AN_CHARTS[+el.dataset.anChart];
    if (draw) el.innerHTML = draw(Math.max(320, Math.floor(el.clientWidth || 600)));
    el.removeAttribute("data-an-chart");
  });
}
let AN_RESIZE_W = 0, AN_RESIZE_T = null;
window.addEventListener("resize", () => {
  clearTimeout(AN_RESIZE_T);
  AN_RESIZE_T = setTimeout(() => {
    const w = window.innerWidth;
    if ((TAB === "analytics" || TAB === "control") && Math.abs(w - AN_RESIZE_W) > 40) { AN_RESIZE_W = w; renderTab(); }
  }, 250);
});

function anLegend(defs) {
  return `<div class="chart-legend">${defs.map(d => `<span><i style="background:${d.color}"></i>${esc(d.label)}</span>`).join("")}</div>`;
}

/* Горизонтальные столбцы с накоплением. rows: [{label, values:{k:v}, note?}],
   defs: [{k, label, color}]; percent — доли вместо сумм. */
function anHBars(rows, defs, opts = {}) {
  if (!rows.length) return '<p class="hint">Нет данных в выбранном контексте.</p>';
  return anChart(W => anHBarsSvg(rows, defs, { ...opts, W }));
}
function anHBarsSvg(rows, defs, { W = 1000, percent = false, rowH = 24, labelW = 190, fmt = anM, totalFmt = null, minLabel = 46 } = {}) {
  labelW = Math.min(labelW, Math.round(W * 0.34));
  const padR = percent ? 10 : 70, barW = W - labelW - padR, H = rows.length * rowH + 6;
  const tot = r => defs.reduce((s, d) => s + Math.max(0, r.values[d.k] || 0), 0);
  const max = percent ? 1 : Math.max(1, ...rows.map(tot));
  let svg = "";
  rows.forEach((r, i) => {
    const y = 3 + i * rowH, t = tot(r) || 1;
    let x = labelW;
    svg += `<text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="11.5" fill="var(--ink-2)">${esc(r.label)}</text>`;
    defs.forEach(d => {
      const v = Math.max(0, r.values[d.k] || 0);
      if (!v) return;
      const w = barW * (percent ? v / t : v / max);
      svg += `<g><title>${esc(r.label)} · ${esc(d.label)}: ${esc(fmt(v))}${percent ? ` (${pct(v / t)})` : ""}</title>
        <rect x="${x.toFixed(1)}" y="${y + 3}" width="${Math.max(0, w - 1.5).toFixed(1)}" height="${rowH - 7}" rx="3" fill="${d.color}"/>
        ${w >= minLabel ? `<text x="${(x + w / 2).toFixed(1)}" y="${y + rowH / 2 + 4}" text-anchor="middle" font-size="10.5" font-weight="600" fill="${d.light ? "var(--ink)" : "var(--bg)"}">${esc(percent ? pct(v / t) : fmt(v))}</text>` : ""}</g>`;
      x += w;
    });
    if (!percent) svg += `<text x="${(x + 6).toFixed(1)}" y="${y + rowH / 2 + 4}" font-size="11" fill="var(--ink-3)">${esc(totalFmt ? totalFmt(r) : fmt(tot(r)))}</text>`;
  });
  return `${anLegend(defs)}<svg class="an-svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="${esc(defs.map(d => d.label).join(", "))}">${svg}</svg>`;
}

/* Сгруппированные столбцы. cats: [..], series: [{label, color, values:[..]}] */
function anColumns(cats, series, opts = {}) {
  return anChart(W => anColumnsSvg(cats, series, { ...opts, W }));
}
function anColumnsSvg(cats, series, { W = 1000, H = 240, fmt = anM, note = null } = {}) {
  if (note) H += 16;
  const padL = 10, padB = 26, padT = note ? 36 : 18, innerH = H - padT - padB;
  const max = Math.max(1, ...series.flatMap(s => s.values.map(v => v || 0)));
  const gw = (W - padL * 2) / cats.length, bw = Math.min(58, (gw * 0.72) / series.length);
  let svg = `<line x1="${padL}" y1="${H - padB}" x2="${W - padL}" y2="${H - padB}" stroke="var(--line)"/>`;
  cats.forEach((c, i) => {
    const gx = padL + i * gw + (gw - bw * series.length) / 2;
    series.forEach((s, j) => {
      const v = s.values[i];
      if (v == null) return;
      const h = innerH * Math.max(0, v) / max, x = gx + j * bw, y = H - padB - h;
      svg += `<g><title>${esc(c)} · ${esc(s.label)}: ${esc(fmt(v))}</title><rect x="${x + 2}" y="${y}" width="${bw - 4}" height="${h}" rx="3" fill="${s.color}"/>
        <text x="${x + bw / 2}" y="${y - 5}" text-anchor="middle" font-size="10.5" fill="var(--ink-2)">${esc(fmt(v))}</text></g>`;
    });
    svg += `<text x="${padL + i * gw + gw / 2}" y="${H - 8}" text-anchor="middle" font-size="11.5" fill="var(--ink-2)">${esc(c)}</text>`;
    if (note && note[i]) svg += `<text x="${padL + i * gw + gw / 2}" y="13" text-anchor="middle" font-size="11" font-weight="600" fill="var(--ink)">${esc(note[i])}</text>`;
  });
  return `${series.length > 1 ? anLegend(series) : ""}<svg class="an-svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img">${svg}</svg>`;
}

function anSegRows(pairs) {
  // pairs: [[label, provBlank]] → строки с сегментами обеспеченности
  return pairs.filter(([, t]) => t && t.value > 0).map(([label, t]) => ({ label: `${label} · ${anM(t.value)}`, values: {
    own: t.seg.own, buy: t.seg.buy, late: t.seg.late, pot: t.seg.pot, gap: t.seg.gap } }));
}
const AN_SEG = [
  { k: "own", label: "Склад своей площадки", color: AN_C.own }, { k: "buy", label: "Закупка к сроку", color: AN_C.buy },
  { k: "late", label: "Закупка опаздывает / без срока", color: AN_C.late },
  { k: "pot", label: "Не покрыто, есть на другой площадке*", color: AN_C.pot, light: true }, { k: "gap", label: "Не покрыто", color: AN_C.gap },
];
const AN_POT_NOTE = '<p class="hint">* Перемещение между площадками ограничено: в обеспеченность не входит, это возможность её улучшить (запас другой площадки сверх её собственной потребности).</p>';

/* ---------- схема автовыводов ---------- */
const AN_FILL = { bad: "var(--bad-bg)", warn: "var(--warn-bg)", info: "rgba(126,131,250,.14)", ok: "var(--good-bg)", na: "var(--surface-2)" };
const AN_INK = { bad: "var(--bad)", warn: "var(--warn)", info: "var(--info)", ok: "var(--good)", na: "var(--ink-3)" };
/* узкий экран: группы и правила столбиком, источники — подписью у группы */
function anSchemeNarrow(m, W) {
  const lv = anRuleLevels(m), rowH = 26;
  let y = 0, svg = "";
  AN_GROUPS.forEach(g => {
    const src = AN_SOURCES.filter(x => x.groups.includes(g)).map(x => x.label.split(":")[0]).join(" · ");
    svg += `<text x="0" y="${y + 15}" font-size="12.5" font-weight="600" fill="var(--ink)">${esc(g)}</text>
      <text x="0" y="${y + 30}" font-size="10" fill="var(--ink-3)">${esc(src)}</text>`;
    y += 38;
    AnalyticsCore.RULES.filter(r => r.group === g).forEach(r => {
      const l = lv[r.id] || "na";
      svg += `<g class="an-rule" data-rule="${r.id}" tabindex="0" style="cursor:pointer"><title>${esc(r.title)}: ${esc(r.test)}</title>
        <rect x="0" y="${y}" width="${W}" height="${rowH - 4}" rx="5" fill="${AN_FILL[l]}" stroke="${AN_INK[l]}" stroke-opacity=".5"/>
        <circle cx="12" cy="${y + (rowH - 4) / 2}" r="4.5" fill="${AN_INK[l]}"/>
        <text x="24" y="${y + rowH / 2 + 2}" font-size="11.5" fill="var(--ink)">${esc(r.title)}</text>
        <text x="${W - 8}" y="${y + rowH / 2 + 2}" text-anchor="end" font-size="10.5" fill="${AN_INK[l]}">${esc(l === "na" ? "нет данных" : AN_LEVELS[l].label)}</text></g>`;
      y += rowH;
    });
    y += 8;
  });
  return `<svg class="an-svg an-scheme" viewBox="0 0 ${W} ${y}" style="width:100%;height:auto" role="img" aria-label="Схема автоматических выводов">${svg}</svg>`;
}
const AN_SOURCES = [
  { id: "orders", label: "Заказы PM-06: план, факт, сроки", groups: ["Исполнение", "Планирование", "Бюджет", "Техника"] },
  { id: "status", label: "Статусы SAP заказа", groups: ["Исполнение", "Планирование", "Бюджет"] },
  { id: "supply", label: "Потребность, остатки, закупка", groups: ["Обеспеченность"] },
  { id: "ktg", label: "КТГ по бортам", groups: ["Техника"] },
];
const AN_GROUPS = ["Исполнение", "Планирование", "Обеспеченность", "Бюджет", "Техника"];
const AN_LVL_ORDER = { bad: 0, warn: 1, info: 2, ok: 3, na: 4 };

function anRuleLevels(m) {
  const lv = {};
  m.conclusions.forEach(c => { if (!(c.id in lv) || AN_LVL_ORDER[c.level] < AN_LVL_ORDER[lv[c.id]]) lv[c.id] = c.level; });
  return lv;
}
function anScheme(m) { return anChart(W => anSchemeSvg(m, W)); }
function anSchemeSvg(m, W) {
  if (W < 640) return anSchemeNarrow(m, W);
  const lv = anRuleLevels(m);
  const rowH = 25, gap = 12;
  const sw = Math.round(W * 0.23), gx = Math.round(W * 0.36), gw = Math.round(W * 0.19), rx = Math.round(W * 0.62), rw = W - 10 - rx;
  const sx = 10 + sw / 2, gc = gx + gw / 2, ge = gx + gw;
  const rules = AnalyticsCore.RULES;
  let y = 8, groupsPos = {}, rulesSvg = "", grpSvg = "", srcSvg = "", links = "";
  const colFill = { bad: "var(--bad-bg)", warn: "var(--warn-bg)", info: "rgba(126,131,250,.14)", ok: "var(--good-bg)", na: "var(--surface-2)" };
  const colInk = { bad: "var(--bad)", warn: "var(--warn)", info: "var(--info)", ok: "var(--good)", na: "var(--ink-3)" };
  AN_GROUPS.forEach(g => {
    const rs = rules.filter(r => r.group === g);
    const top = y, h = rs.length * rowH;
    const worst = rs.map(r => lv[r.id] || "na").sort((a, b) => AN_LVL_ORDER[a] - AN_LVL_ORDER[b])[0];
    groupsPos[g] = { y: top + h / 2 };
    grpSvg += `<g><rect x="${gx}" y="${top + h / 2 - 18}" width="${gw}" height="36" rx="8" fill="var(--surface-2)" stroke="${colInk[worst]}" stroke-width="1.5"/>
      <text x="${gc}" y="${top + h / 2 + 4}" text-anchor="middle" font-size="12.5" font-weight="600" fill="var(--ink)">${esc(g)}</text></g>`;
    rs.forEach((r, i) => {
      const ry = top + i * rowH, l = lv[r.id] || "na";
      links += `<path d="M${ge},${top + h / 2} C${(ge + rx) / 2},${top + h / 2} ${(ge + rx) / 2},${ry + rowH / 2} ${rx},${ry + rowH / 2}" fill="none" stroke="var(--line-2)" stroke-width="1"/>`;
      rulesSvg += `<g class="an-rule" data-rule="${r.id}" tabindex="0" style="cursor:pointer"><title>${esc(r.title)}: ${esc(r.test)}</title>
        <rect x="${rx}" y="${ry + 2}" width="${rw}" height="${rowH - 5}" rx="5" fill="${colFill[l]}" stroke="${colInk[l]}" stroke-opacity=".5"/>
        <circle cx="${rx + 14}" cy="${ry + rowH / 2}" r="4.5" fill="${colInk[l]}"/>
        <text x="${rx + 26}" y="${ry + rowH / 2 + 4}" font-size="11.5" fill="var(--ink)">${esc(r.title)}</text>
        <text x="${W - 18}" y="${ry + rowH / 2 + 4}" text-anchor="end" font-size="10.5" fill="${colInk[l]}">${esc(l === "na" ? "нет данных" : AN_LEVELS[l].label)}</text></g>`;
    });
    y += h + gap;
  });
  const H = y;
  AN_SOURCES.forEach((s, i) => {
    const sy = 20 + i * ((H - 40) / (AN_SOURCES.length - 1 || 1));
    srcSvg += `<g><rect x="10" y="${sy - 20}" width="${sw}" height="40" rx="8" fill="var(--surface-2)" stroke="var(--line-2)"/>
      <text x="${sx}" y="${sy + 4}" text-anchor="middle" font-size="11.5" fill="var(--ink-2)">${esc(s.label)}</text></g>`;
    s.groups.forEach(g => {
      const gy = groupsPos[g].y;
      links += `<path d="M${10 + sw},${sy} C${(10 + sw + gx) / 2},${sy} ${(10 + sw + gx) / 2},${gy} ${gx},${gy}" fill="none" stroke="var(--line-2)" stroke-width="1.2"/>`;
    });
  });
  const head = `<text x="${sx}" y="-6" text-anchor="middle" font-size="10.5" fill="var(--ink-3)">ИСТОЧНИКИ</text>
    <text x="${gc}" y="-6" text-anchor="middle" font-size="10.5" fill="var(--ink-3)">ГРУППЫ ПРОВЕРОК</text>
    <text x="${rx + rw / 2}" y="-6" text-anchor="middle" font-size="10.5" fill="var(--ink-3)">ПРАВИЛА → ВЫВОД</text>`;
  return `<svg class="an-svg an-scheme" viewBox="0 -18 ${W} ${H + 18}" style="width:100%;height:auto" role="img" aria-label="Схема автоматических выводов">${head}${links}${srcSvg}${grpSvg}${rulesSvg}</svg>`;
}

function anEvidence(e) {
  const v = e.kind === "pct" ? pct(e.value) : e.kind === "n" ? num(e.value) : e.kind === "pp" ? `${e.value > 0 ? "+" : ""}${num(e.value * 100, 1)} п.п.` : mrub(e.value);
  return `<span class="an-ev"><i>${esc(e.label)}</i> ${esc(v)}</span>`;
}
function anCards(list) {
  if (!list.length) return callout("info", "По выбранным условиям выводов нет.");
  return `<div class="an-cards">${list.map(c => `<article class="an-card ${AN_LEVELS[c.level].cls}" id="an-c-${esc(c.id)}">
    <header><span class="badge ${AN_LEVELS[c.level].cls}">${AN_LEVELS[c.level].label}</span><span class="dim">${esc(c.group)}</span></header>
    <h3>${esc(c.title)}</h3><p>${esc(c.text)}</p>
    ${c.evidence.length ? `<div class="an-evs">${c.evidence.map(anEvidence).join("")}</div>` : ""}
    <footer><span class="dim" title="Правило">правило: ${esc(c.test)}</span>${c.go ? `<button class="minibtn" data-an-go="${esc(c.go.tab)}">Открыть →</button>` : ""}</footer>
  </article>`).join("")}</div>`;
}

function anWire(host) {
  qsa("[data-an-go]", host).forEach(b => { b.onclick = () => navigateTo(b.dataset.anGo); });
  qsa(".an-rule", host).forEach(g => {
    const go = () => {
      AN_LEVEL = "all";
      const el = byId("an-c-" + g.dataset.rule);
      if (!el) { renderTab(); setTimeout(() => { const e2 = byId("an-c-" + g.dataset.rule); if (e2) { e2.scrollIntoView({ behavior: "smooth", block: "center" }); e2.classList.add("flash"); } }, 60); return; }
      el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600);
    };
    g.onclick = go;
    g.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
  });
}
function anChecksHtml(m) {
  const bad = m.checks.filter(c => !c.ok);
  return `<details class="card an-checks"${bad.length ? " open" : ""}><summary><b>Сверка расчётов:</b> ${bad.length
    ? `<span class="badge bad">${bad.length} расхождений</span>` : `<span class="badge good">все ${m.checks.length} сходятся</span>`}</summary>
    <p class="hint">Разрезы пересчитываются к итогам, итоги — к витринам отчёта. Тот же расчёт независимо проверяется тестами (tests/verify_analytics.py).</p>
    <ul>${m.checks.map(c => `<li class="${c.ok ? "ok" : "fail"}">${c.ok ? "✓" : "✗"} ${esc(c.label)}${c.detail ? ` <span class="dim">${esc(c.detail)}</span>` : ""}</li>`).join("")}</ul></details>`;
}

/* ===================== АНАЛИТИКА ===================== */
function renderAnalytics(host) {
  AN_CHARTS = [];
  const m = anModel(), Y = m.exec.years, cur = m.asOf.slice(0, 4), next = String(+cur + 1);
  const pv27 = m.prov.byYear[next], pv26 = m.prov.byYear[cur];
  const lvCount = l => m.conclusions.filter(c => c.level === l).length;
  const ktgNow = (() => { const a = m.ktg.byUnit.map(r => r[cur]).filter(r => r && r.fact != null); return a.length ? a.reduce((s, r) => s + r.fact, 0) / a.length : null; })();
  const unitTotal = u => AnalyticsCore.YEARS.reduce((s, y) => s + u.years[y].fact + u.years[y].plan, 0);
  const idleUnits = m.exec.byUnit.filter(u => unitTotal(u) <= 0);
  const shown = m.conclusions.filter(c => (AN_LEVEL === "all" || c.level !== "ok") && (!AN_GROUP || c.group === AN_GROUP));
  host.innerHTML = `
    <h1>Аналитика: исполнение ${Y ? "2024–" + cur : ""} и план ${next}</h1>
    ${contextBanner()}
    <p class="sub">Визуализация презентации и автоматические выводы по выбранным фильтрам. Данные на ${dmy(m.asOf)}; ${cur} — незавершённый год.</p>
    <div class="kpis">
      ${["2024", "2025"].map(y => kpi(`Исполнение ${y}`, pct(Y[y].exec), Y[y].exec == null ? "" : Y[y].exec < .9 || Y[y].exec > 1.1 ? "warn" : "good")).join("")}
      ${kpi(`Исполнение ${cur}`, pct(Y[cur].exec) + ` <small>при ${pct(m.elapsed)} года</small>`, (Y[cur].exec || 0) < m.elapsed - .15 ? "bad" : "warn")}
      ${kpi(`План ${next} в заказах`, mrub(Y[next].plan) + ` <small>+${anM(Y[next].noOrderPlan)} ППР</small>`)}
      ${kpi(`Обеспеченность ${next}`, pv27 ? pct(pv27.coverage) + ` <small>до ${pct(pv27.coverageWithMove)}*</small>` : "—", pv27 && pv27.coverage < .7 ? "bad" : "warn")}
      ${kpi("КТГ факт " + cur, pct(ktgNow))}
    </div>

    <h2>Автоматические выводы <span class="dim" style="font-weight:400;font-size:13px">· ${lvCount("bad")} критично · ${lvCount("warn")} внимание · ${lvCount("info")} к сведению · ${lvCount("ok")} норма</span></h2>
    <section class="card"><h3>Схема: источники → проверки → выводы</h3>
      <p class="hint">Каждое правило пересчитывается при смене фильтров. Цвет — результат для текущего контекста; нажмите правило, чтобы открыть вывод с цифрами-доказательствами.</p>
      ${anScheme(m)}</section>
    <div class="toolbar an-pills">
      <button class="pill ${AN_LEVEL === "problems" ? "on" : ""}" data-an-level="problems">Проблемы и сведения</button>
      <button class="pill ${AN_LEVEL === "all" ? "on" : ""}" data-an-level="all">Все, включая норму</button>
      <span style="width:12px"></span>
      <button class="pill ${!AN_GROUP ? "on" : ""}" data-an-group="">Все группы</button>
      ${AN_GROUPS.map(g => `<button class="pill ${AN_GROUP === g ? "on" : ""}" data-an-group="${esc(g)}">${esc(g)}</button>`).join("")}
    </div>
    ${anCards(shown)}

    <h2>Исполнение программы ремонтов</h2>
    <div class="grid2">
      <section class="card"><h3>План и факт по годам, млн ₽</h3><p class="hint">МТР + УСО по заказам ТОРО. Над столбцами — исполнение.</p>
        ${anColumns(["2024", "2025", cur + " · на " + dmy(m.asOf).slice(0, 5), next + " · план"],
          [{ label: "План", color: AN_C.plan, values: m.exec && AnalyticsCore.YEARS.map(y => Y[y].plan) },
           { label: "Факт", color: AN_C.fact, values: AnalyticsCore.YEARS.map(y => y === next ? null : Y[y].fact) }],
          { note: AnalyticsCore.YEARS.map(y => y === next ? "" : pct(Y[y].exec)) })}</section>
      <section class="card"><h3>Стадии SAP: доля плана</h3><p class="hint">Статус — на дату годовой выгрузки PM-06.</p>
        ${anHBars(AnalyticsCore.YEARS.map(y => ({ label: y === next ? y + " план" : y, values: Object.fromEntries(AnalyticsCore.GROUPS.map(g => [g, Y[y].groups[g]])) })),
          AnalyticsCore.GROUPS.filter(g => AnalyticsCore.YEARS.some(y => Y[y].groups[g] > 0)).map(g => ({ k: g, label: g, color: AN_C[g] })), { percent: true, rowH: 34, labelW: 90 })}</section>
    </div>
    <div class="grid2">
      <section class="card"><h3>По площадкам, млн ₽</h3><div id="anSites"></div></section>
      <section class="card"><h3>Виды работ: факт 2024–${cur} и план ${next}, млн ₽</h3>
        ${anHBars(m.exec.byWork.slice(0, 8).map(w => ({ label: w.key === "Не присвоено" ? "Компоненты (без вида)" : w.key,
          values: { y2024: N0(w.years["2024"], "fact"), y2025: N0(w.years["2025"], "fact"), y2026: N0(w.years[cur], "fact"), y2027: N0(w.years[next], "plan") } })),
          [{ k: "y2024", label: "Факт 2024", color: AN_C.y2024 }, { k: "y2025", label: "Факт 2025", color: AN_C.y2025 },
           { k: "y2026", label: `Факт ${cur}`, color: AN_C.y2026 }, { k: "y2027", label: `План ${next}`, color: AN_C.y2027 }], { labelW: 210 })}</section>
    </div>
    <section class="card"><h3>Затраты на каждый борт: факт по годам и план ${next}, млн ₽</h3>
      ${anHBars(m.exec.byUnit.filter(u => !idleUnits.includes(u)).map(u => ({ label: anShort(u.key) + " · " + anSite(siteOfUnit(u.key)).split(" ")[0],
          values: { y2024: u.years["2024"].fact, y2025: u.years["2025"].fact, y2026: u.years[cur].fact, y2027: u.years[next].plan },
          sortKey: u.years["2024"].fact + u.years["2025"].fact + u.years[cur].fact })).sort((a, b) => b.sortKey - a.sortKey),
        [{ k: "y2024", label: "Факт 2024", color: AN_C.y2024 }, { k: "y2025", label: "Факт 2025", color: AN_C.y2025 },
         { k: "y2026", label: `Факт ${cur}`, color: AN_C.y2026 }, { k: "y2027", label: `План ${next}`, color: AN_C.y2027 }], { rowH: 21, labelW: 200 })}
      ${idleUnits.length ? `<p class="hint">Без заказов в 2024–${next}: ${idleUnits.map(u => esc(anShort(u.key))).join(", ")}.</p>` : ""}</section>

    <h2>План ${next}</h2>
    <section class="card"><h3>Готовность плана по площадкам, млн ₽</h3><p class="hint">Позиции графика ППР без заказа SAP в план не входят — показаны, чтобы был виден полный объём графика.</p>
      ${anHBars(m.exec.bySite.map(s => ({ label: anSite(s.key), values: { rel: s.years[next].groups["Деблокирован, пусто"] + s.years[next].groups["В работе"],
          app: s.years[next].groups["Согласование"], ppr: s.years[next].groups["ППР без заказа"] } })),
        [{ k: "rel", label: "Деблокирован", color: AN_C["Деблокирован, пусто"] }, { k: "app", label: "Открыт: согласование и СГГС", color: AN_C["Согласование"] },
         { k: "ppr", label: "Позиции ППР без заказа", color: AN_C["ППР без заказа"] }], { rowH: 34 })}</section>

    <h2>Обеспеченность МТР ${cur}–${next}</h2>
    <div class="grid2">
      <section class="card"><h3>По годам и площадкам, млн ₽</h3>
        ${anHBars(anSegRows([[cur, pv26], [next, pv27], ...m.exec.bySite.flatMap(s => [[anSite(s.key).split(" ")[0] + " " + cur, m.prov.bySite[s.key + "|" + cur]], [anSite(s.key).split(" ")[0] + " " + next, m.prov.bySite[s.key + "|" + next]]])]), AN_SEG, { rowH: 28, labelW: 200 })}
        ${AN_POT_NOTE}</section>
      <section class="card"><h3>${next} по бортам, млн ₽</h3>
        ${anHBars(anSegRows(Object.entries(m.prov.byUnit).filter(([k]) => k.endsWith("|" + next)).map(([k, t]) => [anShort(k.split("|")[0]), t]))
          .sort((a, b) => (b.values.gap + b.values.late + b.values.pot) - (a.values.gap + a.values.late + a.values.pot)), AN_SEG, { rowH: 21, labelW: 170 })}</section>
    </div>
    <div class="grid2">
      <section class="card"><h3>Можно ли ещё успеть заказом: непокрытое ${cur}–${next}, млн ₽</h3><p class="hint">Срок работ против фактического срока поставки кода, если разместить заказ сегодня.</p>
        ${anHBars([{ label: "Непокрытое", values: m.prov.feasible }], [
          { k: "inTime", label: "Успеем, если заказать сейчас", color: "var(--good)" }, { k: "late3", label: "Опоздаем до 3 мес.", color: "var(--warn)" },
          { k: "lateMore", label: "Опоздаем > 3 мес.", color: "var(--bad)" }, { k: "past", label: "Срок работ прошёл", color: "var(--c8)" },
          ...(m.prov.feasible.nodate > 0 ? [{ k: "nodate", label: "Без даты работ", color: "var(--line-2)", light: true }] : [])], { rowH: 40, labelW: 110 })}</section>
      <section class="card"><h3>Видит ли закупка потребность ${next}, млн ₽</h3>
        <div id="anPpm"></div></section>
    </div>

    <h2>Запасы по площадкам и возможность перемещения</h2>
    <div class="grid2">
      <section class="card"><h3>Запас, потребность и покрытие своим складом, млн ₽</h3><div id="anStock"></div>${AN_POT_NOTE}</section>
      <section class="card"><h3>Откуда → куда можно переместить*, млн ₽</h3><div id="anMoves"></div>
        <p class="hint">Верхняя оценка: запас другой площадки, оставшийся после её собственной потребности, против непокрытого к сроку. Логистика и согласование не учтены.</p></section>
    </div>

    <h2>Готовность техники (КТГ)</h2>
    <div class="grid2">
      <section class="card"><h3>План и факт по месяцам, среднее по бортам</h3><div id="anKtg"></div></section>
      <section class="card"><h3>По бортам: факт ${cur} против плана</h3><div id="anKtgT"></div></section>
    </div>
    ${anChecksHtml(m)}
  `;
  // по площадкам — таблица
  renderTable(byId("anSites"), {
    rows: m.exec.bySite.map(s => ({ site: anSite(s.key), ...Object.fromEntries(AnalyticsCore.YEARS.flatMap(y => [["p" + y, s.years[y].plan], ["f" + y, s.years[y].fact], ["e" + y, s.years[y].exec]])) })),
    sortKey: "p" + cur, csv: true, csvName: "wk_exec_by_site.csv",
    cols: [{ key: "site", label: "Площадка" },
      ...["2024", "2025", cur].flatMap(y => [{ key: "f" + y, label: `Факт ${y}`, numeric: true, fmt: anM },
        { key: "e" + y, label: "%", numeric: true, fmt: v => v == null ? "—" : `<span class="badge ${y === cur ? "" : v < .9 || v > 1.1 ? "warn" : "good"}">${pct(v)}</span>` }]),
      { key: "p" + next, label: `План ${next}`, numeric: true, fmt: anM }],
  });
  const ppmRows = ["immediate", "onRelease", "never"].map(k => ({ k, ...(m.prov.ppm[next + "|" + k] || { value: 0, covered: 0, uncovered: 0, potential: 0 }) }));
  renderTable(byId("anPpm"), {
    rows: ppmRows, sortKey: "value",
    cols: [{ key: "k", label: "Признак «Резерв./заявка»", fmt: v => ({ immediate: "Немедленно — закупка видит", onRelease: "Начиная с деблок. — не видит до ДЕБЛ", never: "Никогда — в заявку не попадёт" })[v] },
      { key: "value", label: "Потребность", numeric: true, fmt: anM }, { key: "covered", label: "Обеспечено", numeric: true, fmt: anM },
      { key: "uncovered", label: "Не покрыто", numeric: true, fmt: v => v > 0 ? `<b style="color:var(--bad)">${anM(v)}</b>` : "—" },
      { key: "potential", label: "Перем.*", numeric: true, fmt: v => v > 0 ? anM(v) : "—" }],
  });
  const stockSites = m.stock.bySite.map(s => {
    const a = m.prov.bySite[s.site + "|" + cur], b = m.prov.bySite[s.site + "|" + next];
    const need = (a ? a.value : 0) + (b ? b.value : 0);
    return { site: s.name || anSite(s.site), code: s.site, value: s.value, need, own: (a ? a.fromStock : 0) + (b ? b.fromStock : 0),
             cov: need ? ((a ? a.covered : 0) + (b ? b.covered : 0)) / need : null, unc: (a ? a.uncovered : 0) + (b ? b.uncovered : 0),
             pot: (a ? a.transferPotential : 0) + (b ? b.transferPotential : 0) };
  });
  renderTable(byId("anStock"), {
    rows: stockSites, sortKey: "value", rowClass: r => G.site && r.code === G.site ? "lo-pin" : "",
    onRowClick: r => { G.site = r.code; renderGlobalFilters(); renderTab(); },
    cols: [{ key: "site", label: "Площадка" }, { key: "value", label: "Запас", numeric: true, fmt: anM },
      { key: "need", label: `Нужно ${cur}–${next}`, numeric: true, fmt: anM }, { key: "own", label: "Свой склад", numeric: true, fmt: anM },
      { key: "cov", label: "Обеспечено", numeric: true, fmt: v => v == null ? "—" : `<span class="badge ${v < .7 ? "bad" : v < .9 ? "warn" : "good"}">${pct(v)}</span>` },
      { key: "unc", label: "Не покрыто", numeric: true, fmt: anM }, { key: "pot", label: "Перем.*", numeric: true, fmt: v => v > 0 ? anM(v) : "—" }],
  });
  const sites = m.stock.bySite.map(s => s.site);
  const mv = sites.map(f => ({ from: "из " + anSite(f).split(" ")[0], ...Object.fromEntries(sites.map(t => [t, f === t ? null : (m.prov.moves[f + ">" + t] || 0)])),
    total: sites.reduce((s, t) => s + (f === t ? 0 : (m.prov.moves[f + ">" + t] || 0)), 0) }));
  byId("anMoves").innerHTML = `<div class="twrap"><table><thead><tr><th></th>${sites.map(t => `<th class="n">в ${esc(anSite(t).split(" ")[0])}</th>`).join("")}<th class="n">всего из</th></tr></thead><tbody>
    ${mv.map(r => `<tr><td><b>${esc(r.from)}</b></td>${sites.map(t => `<td class="n">${r[t] == null ? '<span class="dim">—</span>' : r[t] > 0 ? `<b>${anM(r[t])}</b>` : "0"}</td>`).join("")}<td class="n">${anM(r.total)}</td></tr>`).join("")}
    <tr><td class="dim">всего в</td>${sites.map(t => `<td class="n">${anM(sites.reduce((s, f) => s + (f === t ? 0 : (m.prov.moves[f + ">" + t] || 0)), 0))}</td>`).join("")}<td class="n"><b>${anM(m.prov.total.transferPotential)}</b></td></tr>
    </tbody></table></div>
    ${m.prov.moveTop.length ? `<p class="hint" style="margin-top:10px">Крупнейшие позиции: ${m.prov.moveTop.slice(0, 5).map(x => `${esc(x.name)} — ${anM(x.value)} млн ₽`).join("; ")}.</p>` : ""}`;
  const mi = m.ktg.monthly.map((x, i) => i).filter(i => m.ktg.monthly[i].month >= "2024-01");
  renderLineChart(byId("anKtg"), { months: mi.map(i => m.ktg.monthly[i].month), series: [
    { label: "КТГ план", values: mi.map(i => m.ktg.monthly[i].plan), color: "var(--c6)" },
    { label: "КТГ факт", values: mi.map(i => m.ktg.monthly[i].fact), color: "var(--c1)" }], yDomain: [0.6, 1] });
  renderTable(byId("anKtgT"), {
    rows: m.ktg.byUnit.map(r => ({ unit: anShort(r.unit), site: anSite(r.site).split(" ")[0], plan: r[cur].plan, fact: r[cur].fact,
      d: r[cur].plan != null && r[cur].fact != null ? (Math.round((r[cur].fact - r[cur].plan) * 1000) / 1000 || 0) : null })),
    sortKey: "d", sortDir: 1, limit: 12,
    cols: [{ key: "unit", label: "Борт" }, { key: "site", label: "Площадка" }, { key: "plan", label: "План", numeric: true, fmt: pct },
      { key: "fact", label: "Факт", numeric: true, fmt: pct },
      { key: "d", label: "Δ, п.п.", numeric: true, fmt: v => v == null ? "—" : `<span class="badge ${v < -AnalyticsCore.T.ktgGap ? "bad" : v < 0 ? "warn" : "good"}">${v > 0 ? "+" : ""}${num(v * 100, 1)}</span>` }],
  });
  qsa("[data-an-level]", host).forEach(b => { b.onclick = () => { AN_LEVEL = b.dataset.anLevel; renderTab(); }; });
  qsa("[data-an-group]", host).forEach(b => { b.onclick = () => { AN_GROUP = b.dataset.anGroup; renderTab(); }; });
  anMount(host);
  anWire(host);
}
function N0(o, k) { return o ? (o[k] || 0) : 0; }
function siteOfUnit(name) {
  const u = (D.fleet.units || []).find(x => x.name === name);
  if (u) return u.site;
  const r = (D.controlRows || []).find(x => x.unit === name);   // борта нет в парке — площадка по заказу
  return r ? r.site : "";
}

/* ===================== КОНТРОЛЬ ОТДЕЛОВ ===================== */
function anOrderTable(host, rows, { csvName, extra = [], sortKey = "planCounted" } = {}) {
  const all = rows;
  rows = rows.filter(ctrlFactPred());
  if (CTRL_FACT) {
    const f = CTRL_FACTS.find(x => x[0] === CTRL_FACT);
    host.insertAdjacentHTML("beforebegin", `<p class="hint ctl-fact-note">Фильтр «${esc(f[1])}»: ${num(rows.length)} из ${num(all.length)} заказов · план ${mrub(rows.reduce((s, r) => s + r.planCounted, 0))} · факт ${mrub(rows.reduce((s, r) => s + r.fact, 0))}</p>`);
  }
  if (!rows.length) { host.innerHTML = '<p class="hint">Нет заказов под выбранный фильтр факта.</p>'; return; }
  renderTable(host, {
    rows: rows.map(r => ({ ...r, text: D.orderText && D.orderText.text ? D.orderText.text[r.order] || "" : "", factShare: r.planCounted > 0 ? r.fact / r.planCounted : null, unitShort: anShort(r.unit), siteName: anSite(r.site).split(" ")[0], stageLabel: (AnalyticsCore.STAGES.find(s => s[0] === r.stage) || [0, r.stage])[1] })),
    limit: 15, sortKey, csv: true, csvName: csvName || "orders.csv",
    onRowClick: r => { G.order = r.order; renderGlobalFilters(); navigateTo("repairs"); },
    cols: [{ key: "y", label: "Год" }, { key: "siteName", label: "Площадка" }, { key: "unitShort", label: "Борт" },
      { key: "order", label: "Заказ", cls: "mono" },
      ...(D.orderText ? [{ key: "text", label: "Текст заказа", fmt: v => v ? `<span class="ctl-text" title="${esc(v)}">${esc(v)}</span>` : '<span class="dim">—</span>' }] : []),
      { key: "kind", label: "Вид", fmt: (v, r) => `<span title="${esc(r.kindText)}">${esc(v)}</span>` },
      { key: "start", label: "Начало", fmt: v => v ? dmy(v) : "—" }, { key: "end", label: "Конец", fmt: v => v ? dmy(v) : "—" },
      { key: "planCounted", label: "План", numeric: true, fmt: mrub }, { key: "fact", label: "Факт", numeric: true, fmt: mrub },
      { key: "factShare", label: "Факт / план", numeric: true, fmt: v => v == null ? '<span class="dim">—</span>' : `<span class="badge ${v > 1.1 ? "warn" : v >= 0.9 ? "good" : v > 0 ? "info" : ""}">${pct(v)}</span>` },
      ...extra, { key: "stageLabel", label: "Стадия" }],
  });
}
function anListCard(id, title, hint, data) {
  return `<section class="card"><h3>${esc(title)} <span class="badge ${data.n ? "warn" : "good"}">${num(data.n)} · ${mrub(data.plan)}</span></h3>
    <p class="hint">${hint}</p><div id="${id}"></div></section>`;
}
function renderControl(host) {
  AN_CHARTS = [];
  const m = anModel(), cur = m.asOf.slice(0, 4), next = String(+cur + 1), P = m.plan, E = m.execCtl, B = m.budget, Y = m.exec.years;
  const deptConcl = { plan: ["Планирование"], exec: ["Исполнение", "Техника"], budget: ["Бюджет"] }[CTRL_DEPT];
  const conc = m.conclusions.filter(c => deptConcl.includes(c.group) && c.level !== "ok");
  const tabs = [["plan", "Планирование"], ["exec", "Исполнение"], ["budget", "Бюджетирование"]];
  const lvl = (v, good, warn, inverse) => v == null ? "" : inverse ? (v <= good ? "good" : v <= warn ? "warn" : "bad") : (v >= good ? "good" : v >= warn ? "warn" : "bad");
  let body = "";
  if (CTRL_DEPT === "plan") {
    const annual = P.annual, op = P.operative, acc24 = P.accuracy["2024"], acc25 = P.accuracy["2025"];
    body = `
      <div class="kpis">
        ${kpi(`План ${next} согласован`, pct(P.approvedShare), lvl(P.approvedShare, .9, .5))}
        ${kpi(`Утверждён в годовом (УТВГ)`, pct((annual.find(a => a.code === "УТВГ") || {}).share), "")}
        ${kpi(`Позиции ППР без заказа ${next}`, num(P.noOrder.n) + ` <small>${anM(P.noOrder.plan)} млн</small>`, P.noOrder.n ? "warn" : "good")}
        ${kpi(`Начало прошло, не деблок.`, num(E.notReleasedStarted.n) + ` <small>${anM(E.notReleasedStarted.plan)} млн</small>`, E.notReleasedStarted.n ? "warn" : "good")}
        ${kpi("Точность плана 2025 (±20%)", pct(acc25 && acc25.share), lvl(acc25 && acc25.share, .7, .5))}
        ${kpi("Внеплановые 2025", pct(E.unplanned["2025"].share), lvl(E.unplanned["2025"].share, .25, .4, true))}
      </div>
      <div class="grid2">
        <section class="card"><h3>Цепочка согласования плана ${next}, млн ₽</h3><p class="hint">ПЛАН → СГПЛ (планировщик) → ССПЛ (старший планировщик) → СГГС (главный специалист) → деблокирование.</p>
          ${anHBars(P.chain.map(c => ({ label: `${c.key} · ${num(c.n)}`, values: { v: c.plan } })), [{ k: "v", label: "План, млн ₽", color: "var(--info)" }], { rowH: 30, labelW: 170 })}</section>
        <section class="card"><h3>Статусы годового плана ${next} (плановые заказы APP1)</h3><p class="hint">Доля плана в рублях с проставленным статусом: включён → согласован ПТО → главным инженером → утверждён → в программе и бюджете.</p>
          ${anHBars(annual.map(a => ({ label: a.code, values: { y: a.share || 0, n: 1 - (a.share || 0) } })),
            [{ k: "y", label: "Есть статус", color: "var(--good)" }, { k: "n", label: "Нет статуса", color: "var(--line-2)", light: true }], { percent: true, rowH: 30, labelW: 70 })}</section>
      </div>
      <div class="grid2">
        <section class="card"><h3>Оперативный план: заказы с началом в ближайшие 31 день</h3><p class="hint">${num(P.soon.n)} заказов на ${mrub(P.soon.plan)}. Должны быть включены в месячный и недельный план и утверждены.</p>
          ${anHBars(op.map(a => ({ label: a.code, values: { y: a.share || 0, n: 1 - (a.share || 0) } })),
            [{ k: "y", label: "Есть статус", color: "var(--good)" }, { k: "n", label: "Нет статуса", color: "var(--warn)" }], { percent: true, rowH: 30, labelW: 70 })}</section>
        <section class="card"><h3>Точность и внеплановость по годам</h3>
          <div class="twrap"><table><thead><tr><th>Год</th><th class="n">Закрытых заказов</th><th class="n">Факт в ±20% плана</th><th class="n">Закрыто без факта</th><th class="n">Внеплановые, доля факта</th></tr></thead><tbody>
          ${["2024", "2025"].map(y => { const a = P.accuracy[y], u = E.unplanned[y]; return `<tr><td>${y}</td><td class="n">${num(a.n)}</td><td class="n">${pct(a.share)}</td><td class="n">${num(a.noFactN)} · ${mrub(a.noFactPlan)}</td><td class="n">${pct(u.share)}</td></tr>`; }).join("")}
          <tr><td>${cur}</td><td class="n dim" colspan="3">год не завершён</td><td class="n">${pct(E.unplanned[cur].share)}</td></tr></tbody></table></div>
          <p class="hint">Закрыто без факта — отменённые или перенесённые работы (при переносе создают новый заказ).</p></section>
      </div>
      <section class="card"><h3>Материалы в открытых заказах ${cur}–${next}</h3>
        <div class="twrap"><table><thead><tr><th>Статус</th><th>Смысл</th><th class="n">Заказов</th><th class="n">План</th></tr></thead><tbody>
        ${P.materials.map(x => `<tr><td><span class="badge ${x.code === "МТРН" && x.n ? "warn" : ""}">${esc(x.code)}</span></td><td>${esc({ МТРН: "есть МТР без цены — план занижен", СРОЧ: "срочная закупка: потребность раньше, чем придёт поставка", НВСО: "невостребованные остатки после удаления потребности", ТОПЗ: "требуется опережающая закупка", СОПЗ: "опережающая закупка согласована" }[x.code] || "")}</td><td class="n">${num(x.n)}</td><td class="n">${mrub(x.plan)}</td></tr>`).join("")}
        </tbody></table></div></section>
      ${anListCard("ctlNotRel", "Базисное начало прошло, заказ не деблокирован", `Заказы ${cur} на согласовании или согласованные, но не переданные в работу.`, E.notReleasedStarted)}`;
  } else if (CTRL_DEPT === "exec") {
    body = `
      <div class="kpis">
        ${kpi(`Исполнение ${cur}`, pct(Y[cur].exec) + ` <small>при ${pct(m.elapsed)} года</small>`, (Y[cur].exec || 0) < m.elapsed - .15 ? "bad" : "warn")}
        ${kpi("Освоение наступивших заказов", pct(E.execDue), lvl(E.execDue, .9, .7))}
        ${kpi("Деблокировано пусто", num(E.releasedEmpty.n) + ` <small>${anM(E.releasedEmpty.plan)} млн</small>`, E.releasedEmpty.n ? "bad" : "good")}
        ${kpi("Просрочено закрытие", num(E.closeOverdue.n) + ` <small>${anM(E.closeOverdue.plan)} млн</small>`, E.closeOverdue.n ? "warn" : "good")}
        ${kpi("Готовы к ТЗКР (ФХСМ)", num(E.readyToClose.n), E.readyToClose.n ? "warn" : "good")}
        ${kpi("Хвосты 2024–2025", num(E.tails["2024"].n + E.tails["2025"].n) + ` <small>${anM(E.tails["2024"].plan + E.tails["2025"].plan)} млн</small>`, E.tails["2024"].n + E.tails["2025"].n ? "warn" : "good")}
      </div>
      <div class="grid2">
        <section class="card"><h3>Воронка исполнения ${cur}: план по стадиям, млн ₽</h3>
          ${anHBars(E.funnel.map(f => ({ label: `${f.label} · ${num(f.n)}`, values: { v: f.plan } })), [{ k: "v", label: "План, млн ₽", color: "var(--c7)" }], { rowH: 26, labelW: 250 })}</section>
        <section class="card"><h3>План и факт ${cur} нарастающим итогом</h3><p class="hint">По месяцу базисного начала заказа. Разрыв линий к текущему месяцу — неосвоенное по наступившим работам.</p><div id="ctlS"></div></section>
      </div>
        ${anListCard("ctlRel", "Деблокирован, но без факта и подтверждений", "Проведите факт, перенесите или закройте заказ.", E.releasedEmpty)}
        ${anListCard("ctlOver", "Просрочено закрытие", `Базисный конец прошёл более ${AnalyticsCore.T.closeLagDays} дней назад, заказ не закрыт технически.`, E.closeOverdue)}
        ${anListCard("ctlReady", "Факт проведён (ФХСМ), ждёт ТЗКР", "Затрат больше не ожидается — закройте технически.", E.readyToClose)}
        ${anListCard("ctlAcc", "ТЗКР без приёмки службой заказчика", "Нужен ПРСЗ или НПСЗ, чтобы выставить работы в БЕ.", E.acceptPending)}
      <section class="card"><h3>Хвосты прошлых лет</h3><p class="hint">Заказы 2024–2025, не закрытые технически на дату годовой выгрузки.</p><div id="ctlTails"></div></section>`;
  } else {
    const bs = (list) => anHBars(list.filter(x => ["ТКБЕ", "УТВП", "СГЛБ", "ПЗТГ", "КОРБ", "ТРКБ"].includes(x.code)).map(x => ({ label: `${x.code} · ${num(x.n)}`, values: { y: x.share || 0, n: 1 - (x.share || 0) } })),
      [{ k: "y", label: "Доля плана со статусом", color: "var(--info)" }, { k: "n", label: "Без статуса", color: "var(--line-2)", light: true }], { percent: true, rowH: 26, labelW: 90 });
    body = `
      <div class="kpis">
        ${["2024", "2025"].map(y => kpi(`Факт / план ${y}`, pct(Y[y].exec), lvl(Math.abs(1 - (Y[y].exec || 0)), .05, .1, true))).join("")}
        ${kpi(`Риск неосвоения ${cur}`, mrub(B.riskUnspent) + ` <small>${pct(B.riskShare)}</small>`, lvl(B.riskShare, .1, .25, true))}
        ${kpi(`Перерасход ${cur}`, mrub(B.overrun[cur].value) + ` <small>${num(B.overrun[cur].n)} зак.</small>`, B.overrun[cur].n ? "warn" : "good")}
        ${kpi("Нужна корректировка (ТРКБ)", num(((B.statusCur.find(x => x.code === "ТРКБ") || {}).n || 0) + ((B.statusNext.find(x => x.code === "ТРКБ") || {}).n || 0)), "warn")}
        ${kpi(`УСО факт/план ${cur}`, pct(Y[cur].usoPlan ? Y[cur].usoFact / Y[cur].usoPlan : null))}
      </div>
      <div class="grid2">
        <section class="card"><h3>План и факт по годам: МТР и УСО, млн ₽</h3>
          ${anColumns(AnalyticsCore.YEARS, [
            { label: "План МТР", color: "var(--c6)", values: AnalyticsCore.YEARS.map(y => Y[y].mtrPlan) },
            { label: "Факт МТР", color: "var(--c1)", values: AnalyticsCore.YEARS.map(y => y === next ? null : Y[y].mtrFact) },
            { label: "План УСО", color: "var(--c2)", values: AnalyticsCore.YEARS.map(y => Y[y].usoPlan) },
            { label: "Факт УСО", color: "var(--c4)", values: AnalyticsCore.YEARS.map(y => y === next ? null : Y[y].usoFact) }])}
          <p class="hint">План МТР подрядчика в заказах заполнен не полностью — факт УСО прошлых лет выше плана; процент по УСО не показателен.</p></section>
        <section class="card"><h3>План и факт ${cur} по месяцам начала, млн ₽</h3><div id="ctlBM"></div></section>
      </div>
      <div class="grid2">
        <section class="card"><h3>Бюджетные статусы ${cur} (плановые заказы)</h3>${bs(B.statusCur)}</section>
        <section class="card"><h3>Бюджетные статусы ${next} (плановые заказы)</h3>${bs(B.statusNext)}
          <p class="hint">ТКБЕ — бюджет утверждён ТК БЕ; УТВП — в программе и бюджете (из MCB); СГЛБ — согласован бюджетированием; ПЗТГ — прогноз завершения года; КОРБ — скорректирован; ТРКБ — нужна корректировка.</p></section>
      </div>
        <section class="card"><h3>Перерасход по заказам <span class="badge warn">2025: ${num(B.overrun["2025"].n)} · ${mrub(B.overrun["2025"].value)} · ${cur}: ${num(B.overrun[cur].n)} · ${mrub(B.overrun[cur].value)}</span></h3>
          <p class="hint">Факт больше плана × ${AnalyticsCore.T.overrunRatio} и больше чем на ${num(AnalyticsCore.T.overrunMin / 1000)} тыс. ₽.</p><div id="ctlOvr"></div></section>
        <section class="card"><h3>Риск неосвоения ${cur} <span class="badge warn">${num(B.riskN)} · ${mrub(B.riskUnspent)}</span></h3>
          <p class="hint">Базисное начало наступило, факта нет. Ещё ${mrub(B.ahead)} без факта — заказы с началом до конца года.</p><div id="ctlRisk"></div></section>
      <section class="card"><h3>Закрыто с фактом меньше половины плана — высвобождаемый бюджет</h3>
        <p class="hint">2025: ${num(B.underrun["2025"].n)} заказов на ${mrub(B.underrun["2025"].value)}; ${cur}: ${num(B.underrun[cur].n)} на ${mrub(B.underrun[cur].value)}. Факт без плана: 2025 — ${mrub(B.noPlan["2025"].value)}, ${cur} — ${mrub(B.noPlan[cur].value)}.</p><div id="ctlUnder"></div></section>`;
  }
  host.innerHTML = `
    <h1>Контроль отделов</h1>
    ${contextBanner()}
    <p class="sub">Показатели для отделов планирования, исполнения и бюджетирования по статусам SAP заказов WK. Данные на ${dmy(m.asOf)}. Строка заказа открывает его в «График · план-факт».</p>
    <div class="toolbar dept-tabs">${tabs.map(([k, l]) => `<button class="pill ${CTRL_DEPT === k ? "on" : ""}" data-dept="${k}">${l}</button>`).join("")}
      <label class="ctl-fact">Факт по заказу
        <select id="ctlFact">${CTRL_FACTS.map(([k, l]) => `<option value="${k}"${CTRL_FACT === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label></div>
    ${conc.length ? `<h2>Выводы для отдела</h2>${anCards(conc)}` : callout("good", "Замечаний по отделу в выбранном контексте нет.")}
    ${body}
    ${anChecksHtml(m)}`;
  if (CTRL_DEPT === "plan") anOrderTable(byId("ctlNotRel"), E.notReleasedStarted.all, { csvName: "not_released_started.csv" });
  if (CTRL_DEPT === "exec") {
    anOrderTable(byId("ctlRel"), E.releasedEmpty.all, { csvName: "released_empty.csv" });
    anOrderTable(byId("ctlOver"), E.closeOverdue.all, { csvName: "close_overdue.csv" });
    anOrderTable(byId("ctlReady"), E.readyToClose.all, { csvName: "ready_to_close.csv" });
    anOrderTable(byId("ctlAcc"), E.acceptPending.all, { csvName: "accept_pending.csv" });
    anOrderTable(byId("ctlTails"), [...E.tails["2024"].all, ...E.tails["2025"].all], { csvName: "tails.csv" });
    const s = E.sCurve;
    renderLineChart(byId("ctlS"), { months: s.map(x => x.month), series: [
      { label: "План нарастающим", values: s.map(x => x.planCum / 1e6), color: "var(--c6)" },
      { label: "Факт нарастающим", values: s.map(x => x.month <= m.asOf.slice(0, 7) ? x.factCum / 1e6 : null), color: "var(--c1)" }],
      yDomain: [0, Math.max(1, ...s.map(x => x.planCum / 1e6)) * 1.05], yFormat: v => num(v, 0) });
  }
  if (CTRL_DEPT === "budget") {
    const s = E.sCurve;
    byId("ctlBM").innerHTML = anColumns(s.map(x => x.month.slice(5)), [
      { label: "План", color: "var(--c6)", values: s.map(x => x.plan) },
      { label: "Факт", color: "var(--c1)", values: s.map(x => x.month <= m.asOf.slice(0, 7) ? x.fact : null) }], { H: 220 });
    anOrderTable(byId("ctlOvr"), [...B.overrun[cur].all, ...B.overrun["2025"].all].map(r => ({ ...r, over: r.fact - r.planCounted })).sort((a, b) => b.over - a.over),
      { csvName: "overrun.csv", sortKey: "over", extra: [{ key: "over", label: "Сверх плана", numeric: true, fmt: v => `<b style="color:var(--warn)">${mrub(v)}</b>` }] });
    anOrderTable(byId("ctlRisk"), B.riskAll, { csvName: "unspent_risk.csv" });
    anOrderTable(byId("ctlUnder"), [...B.underrun[cur].all, ...B.underrun["2025"].all], { csvName: "underrun.csv" });
  }
  qsa("[data-dept]", host).forEach(b => { b.onclick = () => { CTRL_DEPT = b.dataset.dept; renderTab(); }; });
  byId("ctlFact").onchange = e => { CTRL_FACT = e.target.value; const y = window.scrollY; renderTab(); window.scrollTo(0, y); };
  anMount(host);
  anWire(host);
}
