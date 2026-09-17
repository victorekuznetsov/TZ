"use strict";
/* ============================================================
   WK CRM — единая логика портала.
   Данные — статичные json в data/, вся обработка в браузере.
   ============================================================ */

/* ---------- утилиты ---------- */
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const num = (v, d = 0) => v == null || isNaN(v) ? "—" :
  Number(v).toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });
const rub = v => v == null ? "—" : num(v, 0) + " ₽";
const mrub = v => v == null ? "—" : num(v / 1e6, 1) + " млн ₽";
const cny = v => v == null ? "—" : num(v, 2) + " ¥";
const pct = v => v == null ? "—" : num(v * 100, 0) + "%";
const byId = id => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

function fetchJSON(path) {
  return fetch(path).then(r => {
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  });
}

/* ---------- выгрузка CSV ---------- */
function csvCell(v) {
  if (v == null) return "";
  if (Array.isArray(v)) v = v.length;               // напр. массив узлов -> число
  if (typeof v === "object") v = "";                 // прочие объекты в CSV не тащим
  const s = String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCSV(filename, rows, cols) {
  const head = cols.map(c => csvCell(c.label)).join(";");
  const body = rows.map(r => cols.map(c => csvCell(c.plain ? c.plain(r[c.key], r) : r[c.key])).join(";")).join("\n");
  const blob = new Blob(["﻿" + head + "\n" + body], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------- состояние ---------- */
const D = {}; // сюда лягут все витрины после загрузки
let TAB = "sum";

/* ---------- generic sortable table ---------- */
function renderTable(container, { rows, cols, sortKey, sortDir = -1, rowClass, limit, onRowClick, csv, csvName }) {
  let key = sortKey || (cols.find(c => c.numeric) || cols[0]).key;
  let dir = sortDir;
  function draw() {
    const sorted = [...rows].sort((a, b) => {
      const va = a[key], vb = b[key];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb), "ru") * dir;
    });
    const shown = limit ? sorted.slice(0, limit) : sorted;
    const thead = `<thead><tr>${cols.map(c =>
      `<th class="${c.numeric ? "n" : ""} ${c.key === key ? "sorted" : ""}" data-k="${c.key}">${esc(c.label)}${c.key === key ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`
    ).join("")}</tr></thead>`;
    const tbody = `<tbody>${shown.map((r, ri) => {
      const cls = rowClass ? rowClass(r) : "";
      return `<tr class="${cls}" data-ri="${ri}">${cols.map(c => {
        const v = c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key]);
        return `<td class="${c.numeric ? "n" : ""} ${c.cls || ""}">${v}</td>`;
      }).join("")}</tr>`;
    }).join("")}</tbody>`;
    container.innerHTML =
      (csv ? `<div style="display:flex;justify-content:flex-end;margin-bottom:6px"><button class="minibtn" id="${container.id}_csv" type="button">⇓ CSV (${num(sorted.length)})</button></div>` : "") +
      `<div class="twrap"><table>${thead}${tbody}</table></div>` +
      (limit && rows.length > limit ? `<div class="count">показано ${limit} из ${rows.length}</div>` : "");
    qsa("th", container).forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      if (k === key) dir = -dir; else { key = k; dir = -1; }
      draw();
    });
    if (onRowClick) {
      qsa("tbody tr", container).forEach(tr => tr.onclick = () => onRowClick(shown[+tr.dataset.ri]));
    }
    if (csv) {
      const btn = byId(container.id + "_csv");
      if (btn) btn.onclick = () => downloadCSV(csvName || "export.csv", sorted, cols);
    }
  }
  draw();
}

function callout(kind, html) { return `<div class="callout ${kind}">${html}</div>`; }

/* ---------- линейный график (SVG, hover-курсор + тултип) ---------- */
/* series: [{label, values, color}] — values выровнены по months, null = нет данных за месяц */
function renderLineChart(container, { months, series, height = 220, yFormat = v => pct(v), yDomain = [0, 1] }) {
  const W = 760, H = height, padL = 34, padR = 8, padT = 10, padB = 22;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const [yMin, yMax] = yDomain;
  const x = i => padL + (innerW * i) / (months.length - 1);
  const y = v => padT + innerH - (innerH * (v - yMin)) / (yMax - yMin);

  const gridN = 4;
  let gridSvg = "";
  for (let g = 0; g <= gridN; g++) {
    const gy = padT + (innerH * g) / gridN;
    const val = yMax - ((yMax - yMin) * g) / gridN;
    gridSvg += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="var(--grid)" stroke-width="1"/>`;
    gridSvg += `<text x="${padL - 6}" y="${gy + 3}" text-anchor="end" font-size="9.5" fill="var(--ink-3)">${yFormat(val)}</text>`;
  }
  // подписи по оси X — каждый N-й месяц, чтобы не налезали
  const step = Math.ceil(months.length / 8);
  let xLabels = "";
  months.forEach((m, i) => {
    if (i % step !== 0 && i !== months.length - 1) return;
    xLabels += `<text x="${x(i)}" y="${H - 5}" text-anchor="middle" font-size="9.5" fill="var(--ink-3)">${esc(m)}</text>`;
  });

  let paths = "";
  series.forEach(s => {
    let d = "", pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1) + " ";
      pen = true;
    });
    paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  });

  const legend = series.length > 1 ? `<div class="chart-legend">${series.map(s =>
    `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join("")}</div>` : "";

  const uid = "lc" + Math.random().toString(36).slice(2, 8);
  container.innerHTML = `
    ${legend}
    <div class="chart-wrap" style="position:relative">
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block" id="${uid}">
        ${gridSvg}${xLabels}${paths}
        <line id="${uid}-cross" x1="0" y1="${padT}" x2="0" y2="${H - padB}" stroke="var(--axis)" stroke-width="1" opacity="0"/>
        <rect x="${padL}" y="${padT}" width="${innerW}" height="${innerH}" fill="transparent" id="${uid}-cap" style="cursor:crosshair"/>
      </svg>
      <div id="${uid}-tip" class="chart-tip" style="display:none"></div>
    </div>`;

  const svg = byId(uid), cap = byId(uid + "-cap"), cross = byId(uid + "-cross"), tip = byId(uid + "-tip");
  cap.addEventListener("mousemove", e => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let i = Math.round(((px - padL) / innerW) * (months.length - 1));
    i = Math.max(0, Math.min(months.length - 1, i));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("opacity", "1");
    const rows = series.map(s => `<div class="tr"><i style="background:${s.color}"></i>${esc(s.label)} <b>${s.values[i] == null ? "—" : yFormat(s.values[i])}</b></div>`).join("");
    tip.innerHTML = `<div class="hd">${esc(months[i])}</div>${rows}`;
    tip.style.display = "block";
    const leftPct = (x(i) / W) * 100;
    tip.style.left = leftPct > 65 ? "auto" : `calc(${leftPct}% + 10px)`;
    tip.style.right = leftPct > 65 ? `calc(${100 - leftPct}% + 10px)` : "auto";
  });
  cap.addEventListener("mouseleave", () => { cross.setAttribute("opacity", "0"); tip.style.display = "none"; });
}

/* компактный спарклайн в ячейке таблицы — без интерактива */
function sparkline(values, color) {
  const w = 90, h = 22, pad = 2;
  const pts = values.map((v, i) => ({ v, i })).filter(p => p.v != null);
  if (pts.length < 2) return '<span class="dim">—</span>';
  const x = i => pad + ((w - 2 * pad) * i) / (values.length - 1);
  const y = v => h - pad - (h - 2 * pad) * v; // v в [0,1]
  let d = "", pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1) + " ";
    pen = true;
  });
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:block"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function kpi(label, value, kind) {
  return `<div class="kpi ${kind || ""}"><div class="l">${esc(label)}</div><div class="v">${value}</div></div>`;
}

/* ---------- загрузка ---------- */
const FILES = {
  catalog: "data/catalog.json", ekmtrWk: "data/ekmtr_wk.json",
  tree: "data/tree.json", interchange: "data/interchange.json",
  fleetBooks: "data/fleet_books.json", fleet: "data/fleet.json",
  repairs: "data/repairs.json", provision: "data/provision.json",
  stock: "data/stock.json", quality: "data/quality.json", kb: "data/kb.json",
  drawings: "data/drawings.json", linkome: "data/linkome_sheets.json",
};

function boot() {
  const keys = Object.keys(FILES);
  Promise.all(keys.map(k => fetchJSON(FILES[k]).then(v => D[k] = v)))
    .then(() => {
      buildIndexes();
      renderTab();
    })
    .catch(e => {
      byId("main").innerHTML = callout("bad",
        `Не удалось загрузить данные: ${esc(e.message)}. Портал открывается только через http(s) — ` +
        `откройте его с сервера (GitHub Pages / Vercel / <code>python3 -m http.server</code>), не двойным щелчком по файлу.`);
    });
}

/* индексы для быстрого поиска и join между витринами */
let STOCK_BY_CODE = new Map();
let EKMTR_NAME = new Map();
let CATALOG_BY_ART = new Map();
let INTER_GROUP_OF = new Map(); // каталожный номер -> группа взаимозаменяемости (массив)
let LINKOME_BOOKS_OF = new Map(); // каталожный номер -> книги LinkOme, где числится лист
function buildIndexes() {
  STOCK_BY_CODE = new Map(D.stock.items.map(i => [i.code, i]));
  EKMTR_NAME = new Map(D.ekmtrWk.items.map(i => [i.code, i.name]));
  CATALOG_BY_ART = new Map(D.catalog.items.map(i => [i.art, i]));
  D.interchange.groups.forEach(g => g.forEach(num => INTER_GROUP_OF.set(num, g)));
  Object.entries(D.linkome.byBook).forEach(([book, info]) => {
    info.nums.forEach(n => {
      if (!LINKOME_BOOKS_OF.has(n)) LINKOME_BOOKS_OF.set(n, []);
      LINKOME_BOOKS_OF.get(n).push(book);
    });
  });
}

/* ---------- вкладки ---------- */
function renderTab() {
  const host = byId("main");
  switch (TAB) {
    case "sum": return renderSum(host);
    case "catalog": return renderCatalog(host);
    case "kb": return renderKB(host);
    case "fleet": return renderFleet(host);
    case "repairs": return renderRepairs(host);
    case "provision": return renderProvision(host);
    case "stock": return renderStock(host);
    case "purchase": return renderPurchase(host);
    case "codif": return renderCodif(host);
    case "inter": return renderInter(host);
    case "dq": return renderDQ(host);
    case "doc": return renderDoc(host);
    case "upd": return renderUpdate(host);
    case "cart": return renderCart(host);
  }
}

/* ===================== ЗАЯВКА (КОРЗИНА) ===================== */
/* Рабочий список на закупку/кодификацию — собирается из «Обеспеченности»,
   «Запасов» и «Кодификации» кнопкой «+ в заявку» на строке. Хранится в
   браузере (localStorage) — черновик одного человека, не общая заявка;
   выгружается в CSV или печатается, дальше — обычным порядком в закупку. */
const CART_KEY = "wkcrm_cart_v1";
function cartGet() {
  try { return JSON.parse(localStorage.getItem(CART_KEY) || "[]"); } catch (e) { return []; }
}
function cartSet(items) {
  try { localStorage.setItem(CART_KEY, JSON.stringify(items)); } catch (e) { /* приватный режим и т.п. */ }
  cartUpdateBadge();
}
function cartHas(code) { return cartGet().some(i => i.code === code); }
function cartAdd(item) {
  const items = cartGet();
  if (items.some(i => i.code === item.code)) return;
  items.push({ ...item, addedAt: new Date().toISOString() });
  cartSet(items);
}
function cartRemove(code) { cartSet(cartGet().filter(i => i.code !== code)); }
function cartClear() { cartSet([]); }
function cartUpdateBadge() {
  const el = byId("cartBadge");
  if (!el) return;
  const n = cartGet().length;
  el.textContent = n || "";
  el.style.display = n ? "" : "none";
}

function cartAddBtn(item) {
  const has = cartHas(item.code);
  return `<button class="minibtn cart-add ${has ? "on" : ""}" data-code="${esc(item.code)}" data-name="${esc(item.name || "")}" data-value="${item.value || ""}" data-source="${esc(item.source)}" title="${has ? "уже в заявке" : "добавить в заявку"}">${has ? "✓" : "+"}</button>`;
}
/* Делегирование, а не навешивание на каждую кнопку: renderTable
   пересоздаёт всю разметку таблицы при клике по заголовку (пересортировка),
   старые узлы со своими обработчиками при этом уничтожаются — слушатель
   на самом контейнере переживает такие перерисовки. Идемпотентно —
   повторный вызов на том же контейнере не даёт второго обработчика. */
function wireCartButtons(container) {
  if (container.dataset.cartWired) return;
  container.dataset.cartWired = "1";
  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".cart-add");
    if (!btn) return;
    e.stopPropagation();
    const code = btn.dataset.code;
    if (cartHas(code)) { cartRemove(code); } else {
      cartAdd({ code, name: btn.dataset.name, value: btn.dataset.value ? Number(btn.dataset.value) : null, source: btn.dataset.source, qty: 1, note: "" });
    }
    btn.classList.toggle("on");
    btn.textContent = btn.classList.contains("on") ? "✓" : "+";
    btn.title = btn.classList.contains("on") ? "уже в заявке" : "добавить в заявку";
    cartUpdateBadge();
  });
}

function renderCart(host) {
  const items = cartGet();
  host.innerHTML = `
    <h1>Заявка</h1>
    <p class="sub">Рабочий список из «Обеспеченности», «Запасов» и «Кодификации» — на закупку или на заведение НСИ. Хранится только в этом браузере.</p>
    ${!items.length ? callout("info", "Пусто. Добавляйте позиции кнопкой «+» на строках в «Обеспеченности», «Запасах» или «Кодификации».") : ""}
    ${items.length ? `
    <div class="toolbar">
      <span class="count">${num(items.length)} позиций${items.some(i => i.value) ? " · " + rub(items.reduce((s, i) => s + (i.value || 0) * (i.qty || 1), 0)) : ""}</span>
      <button class="minibtn" id="cartClearBtn" type="button">Очистить</button>
      <button class="minibtn" id="cartPrintBtn" type="button">Печать</button>
    </div>
    <div id="cartTable"></div>` : ""}
  `;
  if (!items.length) return;
  renderTable(byId("cartTable"), {
    rows: items, sortKey: "addedAt", sortDir: -1,
    csv: true, csvName: "wk_zayavka.csv",
    cols: [
      { key: "code", label: "Код", cls: "mono" },
      { key: "name", label: "Наименование", cls: "wrap" },
      { key: "source", label: "Источник" },
      { key: "value", label: "Стоимость", numeric: true, fmt: v => v ? rub(v) : "" },
      {
        key: "qty", label: "Кол-во", numeric: true,
        fmt: (v, r) => `<input type="number" min="1" value="${v || 1}" class="cart-qty" data-code="${esc(r.code)}" style="width:56px;background:var(--surface-2);border:var(--hair);border-radius:var(--radius);color:var(--ink);padding:3px 6px;font:inherit"/>`
      },
      {
        key: "note", label: "Заметка", cls: "wrap",
        fmt: (v, r) => `<input type="text" value="${esc(v || "")}" class="cart-note" data-code="${esc(r.code)}" placeholder="…" style="width:100%;background:var(--surface-2);border:var(--hair);border-radius:var(--radius);color:var(--ink);padding:3px 6px;font:inherit"/>`
      },
      { key: "code", label: "", plain: () => "", fmt: (v) => `<button class="minibtn" data-rm="${esc(v)}" type="button">✕</button>` },
    ],
  });
  qsa(".cart-qty", host).forEach(el => el.onchange = () => {
    const items2 = cartGet();
    const it = items2.find(i => i.code === el.dataset.code);
    if (it) { it.qty = Math.max(1, parseInt(el.value) || 1); cartSet(items2); }
  });
  qsa(".cart-note", host).forEach(el => el.onchange = () => {
    const items2 = cartGet();
    const it = items2.find(i => i.code === el.dataset.code);
    if (it) { it.note = el.value; cartSet(items2); }
  });
  qsa("[data-rm]", host).forEach(btn => btn.onclick = () => { cartRemove(btn.dataset.rm); renderTab(); });
  byId("cartClearBtn").onclick = () => { if (confirm("Очистить заявку?")) { cartClear(); renderTab(); } };
  byId("cartPrintBtn").onclick = () => window.print();
}

/* ===================== СВОДКА ===================== */
function renderSum(host) {
  const c = D.catalog.meta, s = D.stock.meta, p = D.provision.meta, r = D.repairs.meta, f = D.fleet.meta;
  host.innerHTML = `
    <h1>WK CRM</h1>
    <p class="sub">Каталог запчастей, база знаний, запасы, обеспеченность, закупки и ремонты экскаваторов WK. Taiyuan Heavy Industry, ${f.units} единиц.</p>
    <div class="kpis">
      ${kpi("Парк", f.units + " ед.")}
      ${kpi("Позиций в прайсе", num(c.items))}
      ${kpi("Кодифицировано", pct(c.matchedEkmtr / c.items), c.matchedEkmtr / c.items < 0.5 ? "warn" : "")}
      ${kpi("Остаток WK доступно", mrub(s.totalAvailValue), "good")}
      ${kpi("Запас ограничен", mrub(s.totalRestrictedValue), s.totalRestrictedValue > 0 ? "bad" : "")}
      ${kpi("Закупка план", mrub(s.totalPurchasePlanValue))}
      ${kpi("Ремонт факт 22-27", mrub(r.factTotal))}
      ${kpi("Не обеспечено 26-27", mrub(p.noCoverage.value), "bad")}
    </div>

    ${callout("info", `<b>Ограниченный запас</b> — позиции, которые физически есть на складе, но SAP запрещает их использовать в ремонте (брак, резерв, спорное качество). Такой запас <b>вычитается</b> из доступного остатка везде в этом портале и подсвечивается статусом «ограничено» — не путайте с обычным наличием.`)}

    <h2>Обеспеченность плана 2026–2027 (номенклатура WK)</h2>
    <div class="grid3">
      <div class="card"><h3>Полностью обеспечено</h3><div class="kpi good" style="border:0;padding:0"><div class="v">${mrub(p.fullCoverage.value)}</div></div><p class="hint">${num(p.fullCoverage.n)} позиций</p></div>
      <div class="card"><h3>Частично обеспечено</h3><div class="kpi warn" style="border:0;padding:0"><div class="v">${mrub(p.partialCoverage.value)}</div></div><p class="hint">${num(p.partialCoverage.n)} позиций</p></div>
      <div class="card"><h3>Нет остатка</h3><div class="kpi bad" style="border:0;padding:0"><div class="v">${mrub(p.noCoverage.value)}</div></div><p class="hint">${num(p.noCoverage.n)} позиций</p></div>
    </div>

    <h2>Парк по моделям</h2>
    <div id="sumFleet"></div>

    <h2>Крупнейшие статьи ремонта (факт 2022-2027)</h2>
    <div id="sumWork"></div>
  `;
  const byModel = {};
  D.fleet.units.forEach(u => { byModel[u.model] = (byModel[u.model] || 0) + 1; });
  renderTable(byId("sumFleet"), {
    rows: Object.entries(byModel).map(([model, n]) => ({ model, n })),
    cols: [{ key: "model", label: "Модель" }, { key: "n", label: "Единиц", numeric: true }],
  });
  renderTable(byId("sumWork"), {
    rows: D.repairs.byWork.slice(0, 10),
    cols: [{ key: "work", label: "Вид работ" }, { key: "value", label: "Факт", numeric: true, fmt: mrub }],
  });
}

/* ===================== КАТАЛОГ ===================== */
let CAT_FILTER = { model: "", q: "" };

/* Курс CNY→₽ — только для отображения в каталоге, нигде не сохраняется
   в данных и не переносится между вкладками расчёта. Хранится в браузере
   (per-viewer удобство): если пуст или очищен, каталог просто не
   показывает колонку ₽, а не подставляет выдуманное значение. Из
   закупок курс НЕ выводится: разброс «Учётная цена / Цена нетто» по
   строкам ZCNY (6,9–55,7 на 5–95 перцентиле) слишком широкий, чтобы
   считаться курсом обмена, а не искажённым пошлинами и логистикой. */
function getRate() {
  try {
    const v = parseFloat(localStorage.getItem("wkcrm_cny_rate"));
    return isFinite(v) && v > 0 ? v : null;
  } catch (e) { return null; }
}
function setRate(v) {
  try {
    if (v == null) localStorage.removeItem("wkcrm_cny_rate");
    else localStorage.setItem("wkcrm_cny_rate", String(v));
  } catch (e) { /* приватный режим и т.п. — молча игнорируем */ }
}

function renderCatalog(host) {
  const items = D.catalog.items;
  const rate = getRate();
  host.innerHTML = `
    <h1>Каталог запчастей</h1>
    <p class="sub">${num(items.length)} позиций прайса ДП (основной источник) со сверкой прайса УСО, привязкой к дереву узлов и к коду ЕКМТР. Цена — <b>в юанях</b>, единственное место в портале.</p>
    <div class="toolbar">
      <input type="search" id="catQ" placeholder="Артикул или наименование…" value="${esc(CAT_FILTER.q)}"/>
      <select id="catModel">
        <option value="">Все модели</option>
        ${["WK-20", "WK-35", "WK-20C", "WK-20&WK-35"].map(m => `<option ${CAT_FILTER.model === m ? "selected" : ""}>${m}</option>`).join("")}
      </select>
      <span class="pill" id="catNoCode">без кода ЕКМТР</span>
      <span class="pill" id="catDiff">цена ДП≠УСО</span>
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--ink-3)">
        курс ¥→₽ <input type="number" id="catRate" step="0.01" min="0" placeholder="—" value="${rate || ""}" style="width:64px;background:var(--surface-2);border:var(--hair);border-radius:var(--radius);color:var(--ink);padding:5px 7px;font:inherit"/>
      </span>
      <span class="count" id="catCount"></span>
    </div>
    <div id="catTable"></div>
  `;
  byId("catRate").oninput = e => {
    const v = parseFloat(e.target.value);
    setRate(isFinite(v) && v > 0 ? v : null);
    apply();
  };
  let noCodeOnly = false, diffOnly = false;
  function apply() {
    const curRate = getRate();
    const q = CAT_FILTER.q.trim().toLowerCase().replace(/-/g, "");
    let rows = items.filter(i => {
      if (CAT_FILTER.model && i.model !== CAT_FILTER.model) return false;
      if (noCodeOnly && i.ekmtr) return false;
      if (diffOnly && i.priceDiffCNY == null) return false;
      if (q) {
        const a = (i.art || "").toLowerCase().replace(/-/g, "");
        const n = (i.nameRu || "").toLowerCase();
        if (!a.includes(q) && !n.includes(q)) return false;
      }
      return true;
    });
    byId("catCount").textContent = num(rows.length) + " позиций";
    renderTable(byId("catTable"), {
      rows, limit: 500, rowClass: () => "mrow",
      onRowClick: r => openDetail(r.art),
      csv: true, csvName: "wk_catalog.csv",
      cols: [
        { key: "art", label: "Артикул", cls: "mono" },
        { key: "model", label: "Модель" },
        { key: "nameRu", label: "Наименование", cls: "wrap" },
        { key: "resource", label: "Ресурс, м/ч", numeric: true },
        { key: "priceCNY", label: "Цена, ¥", numeric: true, fmt: cny },
        ...(curRate ? [{ key: "priceCNY", label: "Цена, ₽", numeric: true, fmt: v => v == null ? "—" : rub(v * curRate), plain: v => v == null ? "" : Math.round(v * curRate) }] : []),
        { key: "priceDiffCNY", label: "Δ УСО", numeric: true, fmt: v => v == null ? "" : `<span class="badge warn">${cny(v)}</span>` },
        {
          key: "ekmtr", label: "ЕКМТР", cls: "mono", fmt: (v, r) => v
            ? `${esc(v)}${r.ekmtrAmbiguous ? ' <span class="badge warn">?</span>' : ""}`
            : '<span class="badge bad">нет</span>'
        },
        {
          key: "tree", label: "Узел", cls: "wrap", plain: v => v && v.length ? v[0].mech : "",
          fmt: (v, r) => v && v.length
            ? esc(v[0].mech) + (v.length > 1 ? ` (+${v.length - 1})` : "") +
              (r.treeMethod === "parent" ? ' <span class="badge info" title="сам номер в ведомости не значится, найден узел-родитель на уровень выше">родитель</span>' : "")
            : '<span class="dim">—</span>'
        },
        {
          key: "art", label: "Чертёж", cls: "",
          plain: v => D.drawings.byNum[v] ? "есть" : LINKOME_BOOKS_OF.has(v) ? "в LinkOme" : "",
          fmt: (v) => D.drawings.byNum[v]
            ? '<span class="badge good">есть</span>'
            : LINKOME_BOOKS_OF.has(v) ? '<span class="badge info">в LinkOme</span>' : ""
        },
      ],
    });
  }
  byId("catQ").oninput = e => { CAT_FILTER.q = e.target.value; apply(); };
  byId("catModel").onchange = e => { CAT_FILTER.model = e.target.value; apply(); };
  byId("catNoCode").onclick = e => { noCodeOnly = !noCodeOnly; e.target.classList.toggle("on"); apply(); };
  byId("catDiff").onclick = e => { diffOnly = !diffOnly; e.target.classList.toggle("on"); apply(); };
  apply();
}

/* ===================== ПАРК ===================== */
const MODEL_COLOR = { "WK-20": "var(--c1)", "WK-35": "var(--c2)", "WK-20C": "var(--c3)" };

function renderFleet(host) {
  host.innerHTML = `
    <h1>Парк WK</h1>
    <p class="sub">${D.fleet.meta.units} единиц (карточки-дубли в КТГ схлопнуты). ${D.fleet.meta.matchedToBook} связаны с книгой комплектации.</p>
    <div class="card"><h3>КТГ по моделям, среднее по месяцам</h3>
      <p class="hint">Месяцы, где у модели ещё не было бортов в парке, из среднего исключены — не занижают график нулями.</p>
      <div id="fleetChart"></div>
    </div>
    <div id="fleetTable"></div>
  `;
  const months = D.fleet.meta.months;
  const models = ["WK-20", "WK-35", "WK-20C"];
  const series = models.map(model => {
    const units = D.fleet.units.filter(u => u.model === model && u.ktgByMonth);
    const values = months.map((_, i) => {
      const vals = units.map(u => u.ktgByMonth[i]).filter(v => v > 0);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    });
    return { label: model, values, color: MODEL_COLOR[model] };
  });
  renderLineChart(byId("fleetChart"), { months, series, yDomain: [0.5, 1] });

  renderTable(byId("fleetTable"), {
    rows: D.fleet.units, sortKey: "ktg", sortDir: 1,
    csv: true, csvName: "wk_fleet.csv",
    cols: [
      { key: "name", label: "Единица", cls: "wrap" },
      { key: "site", label: "Площадка" },
      { key: "model", label: "Модель" },
      { key: "book", label: "Книга", cls: "mono", fmt: v => v || '<span class="dim">—</span>' },
      {
        key: "ktgByMonth", label: "КТГ, тренд", plain: () => "",
        fmt: (v, r) => v ? sparkline(v.map(x => x > 0 ? x : null), MODEL_COLOR[r.model] || "var(--accent)") : ""
      },
      { key: "ktg", label: "КТГ", numeric: true, fmt: v => v == null ? "—" : pct(v), plain: v => v == null ? "" : Math.round(v * 1000) / 1000 },
      { key: "kio", label: "КИО", numeric: true, fmt: v => v == null ? "—" : pct(v), plain: v => v == null ? "" : Math.round(v * 1000) / 1000 },
    ],
  });
}

/* ===================== РЕМОНТЫ ===================== */
function renderRepairs(host) {
  const m = D.repairs.meta;
  host.innerHTML = `
    <h1>Ремонты 2022–2027</h1>
    <p class="sub">${num(m.rowsTotal)} строк заказов ТОиР по парку WK (SAP PM-06, детализация «заказ → единица → материал»).</p>
    <div class="kpis">
      ${kpi("План", mrub(m.planTotal))}
      ${kpi("Факт", mrub(m.factTotal))}
      ${kpi("Исполнение", pct(m.factTotal / m.planTotal))}
    </div>
    <div class="grid2">
      <div class="card"><h3>По единицам (факт)</h3><div id="repUnit"></div></div>
      <div class="card"><h3>По видам работ (факт)</h3><div id="repWork"></div></div>
    </div>
    <h2>Материалы — крупнейшие статьи</h2>
    <div id="repMat"></div>
  `;
  renderTable(byId("repUnit"), {
    rows: D.repairs.byUnit, limit: 15,
    cols: [{ key: "unit", label: "Единица", cls: "wrap" }, { key: "total", label: "Факт", numeric: true, fmt: mrub }],
  });
  renderTable(byId("repWork"), {
    rows: D.repairs.byWork, limit: 15,
    cols: [{ key: "work", label: "Вид работ" }, { key: "value", label: "Факт", numeric: true, fmt: mrub }],
  });
  renderTable(byId("repMat"), {
    rows: D.repairs.byMaterial, limit: 30,
    csv: true, csvName: "wk_repairs_materials.csv",
    cols: [
      { key: "code", label: "Код ЕКМТР", cls: "mono" },
      { key: "name", label: "Наименование", cls: "wrap" },
      { key: "isWkPart", label: "WK-номенклатура", plain: v => v ? "да" : "", fmt: v => v ? '<span class="badge good">да</span>' : "" },
      { key: "value", label: "Факт", numeric: true, fmt: mrub },
    ],
  });
}

/* ===================== ОБЕСПЕЧЕННОСТЬ ===================== */
function renderProvision(host) {
  const m = D.provision.meta;
  host.innerHTML = `
    <h1>Обеспеченность плана 2026–2027</h1>
    <p class="sub">${num(m.orders)} заказов без единого факта, ${num(m.lines)} строк. Обеспеченность считается по <b>доступному</b> остатку (за вычетом ограниченного) — только для номенклатуры WK.</p>
    <div class="kpis">
      ${kpi("Потребность WK", mrub(m.wkPartsTotal))}
      ${kpi("Полностью", mrub(m.fullCoverage.value), "good")}
      ${kpi("Частично", mrub(m.partialCoverage.value), "warn")}
      ${kpi("Нет остатка", mrub(m.noCoverage.value), "bad")}
      ${kpi("Прочие материалы*", mrub(m.notWkParts.value))}
    </div>
    <p class="hint" style="color:var(--ink-3);font-size:11.5px;margin:-10px 0 14px">* ГСМ, общий крепёж и другие материалы, которые расходуют единицы WK, но которых нет в номенклатуре ППЗ 3.1.2.7 — остаток по ним здесь не отслеживается.</p>
    <div class="toolbar">
      <select id="provStatus">
        <option value="">Все статусы</option>
        <option value="none">Нет остатка</option>
        <option value="partial">Частично</option>
        <option value="full">Полностью</option>
      </select>
      <span class="count" id="provCount"></span>
    </div>
    <div id="provTable"></div>
  `;
  const items = D.provision.items.filter(i => i.status !== "notWkPart");
  function apply() {
    const st = byId("provStatus").value;
    const rows = st ? items.filter(i => i.status === st) : items;
    byId("provCount").textContent = num(rows.length) + " позиций";
    renderTable(byId("provTable"), {
      rows, limit: 300, sortKey: "needValue",
      rowClass: r => r.restricted ? "restricted-row" : "",
      csv: true, csvName: "wk_provision.csv",
      cols: [
        { key: "code", label: "Код ЕКМТР", cls: "mono" },
        { key: "name", label: "Наименование", cls: "wrap" },
        { key: "needValue", label: "Потребность", numeric: true, fmt: rub },
        { key: "availQty", label: "Доступно, ед.", numeric: true, fmt: v => num(v, 1) },
        {
          key: "status", label: "Статус",
          plain: (v, r) => ({ full: "полностью", partial: "частично", none: "нет остатка" }[v] || v) + (r.restricted ? " + ограничено" : ""),
          fmt: (v, r) => {
            const badge = v === "full" ? '<span class="badge good">полностью</span>' :
              v === "partial" ? '<span class="badge warn">частично</span>' :
                '<span class="badge bad">нет остатка</span>';
            return badge + (r.restricted ? ' <span class="badge restricted">огранич.</span>' : "");
          }
        },
        {
          key: "code", label: "", plain: () => "",
          fmt: (v, r) => cartAddBtn({ code: v, name: r.name, value: r.needValue, source: "Обеспеченность" })
        },
      ],
    });
    wireCartButtons(byId("provTable"));
  }
  byId("provStatus").onchange = apply;
  apply();
}

/* ===================== ЗАПАСЫ ===================== */
function renderStock(host) {
  const m = D.stock.meta;
  host.innerHTML = `
    <h1>Запасы</h1>
    <p class="sub">Остаток по номенклатуре WK на дату выгрузки (${esc(m.srcStock)}). Ограниченный и блокированный запас вычтен из доступного и подсвечен отдельно.</p>
    <div class="kpis">
      ${kpi("Кодов с остатком", num(m.codesWithStock))}
      ${kpi("Остаток всего", mrub(m.totalValue))}
      ${kpi("Доступно", mrub(m.totalAvailValue), "good")}
      ${kpi("Ограничено", mrub(m.totalRestrictedValue), "bad")}
      ${kpi("Полностью ограничено", m.fullyRestrictedCodes + " код.", m.fullyRestrictedCodes > 0 ? "bad" : "")}
    </div>
    ${m.totalRestrictedValue > 0 ? callout("warn", `<b>${num(m.fullyRestrictedCodes)} позиций</b> имеют остаток, весь который ограничен — фактически это дефицит, хотя формально «есть на складе».`) : ""}
    <div class="toolbar">
      <span class="pill" id="stkRestricted">только ограниченные</span>
      <input type="search" id="stkQ" placeholder="Код или наименование…"/>
      <span class="count" id="stkCount"></span>
    </div>
    <div id="stkTable"></div>
  `;
  let restrOnly = false;
  function apply() {
    const q = (byId("stkQ").value || "").trim().toLowerCase();
    let rows = D.stock.items.filter(i => {
      if (restrOnly && i.restrictedValue <= 0) return false;
      if (q && !i.code.includes(q) && !(i.name || "").toLowerCase().includes(q)) return false;
      return true;
    });
    byId("stkCount").textContent = num(rows.length) + " позиций";
    renderTable(byId("stkTable"), {
      rows, limit: 300, sortKey: "value",
      rowClass: r => r.fullyRestricted ? "restricted-row" : "",
      csv: true, csvName: "wk_stock.csv",
      cols: [
        { key: "code", label: "Код", cls: "mono" },
        { key: "name", label: "Наименование", cls: "wrap" },
        { key: "qty", label: "Остаток, ед.", numeric: true, fmt: v => num(v, 1) },
        { key: "value", label: "Стоимость", numeric: true, fmt: rub },
        { key: "restrictedValue", label: "Ограничено", numeric: true, fmt: v => v > 0 ? `<span class="badge restricted">${rub(v)}</span>` : "" },
        { key: "availValue", label: "Доступно", numeric: true, fmt: rub },
        { key: "purchase", label: "В закупке", numeric: true, plain: v => v ? v.planV : "", fmt: v => v ? rub(v.planV) : "" },
        {
          key: "code", label: "", plain: () => "",
          fmt: (v, r) => cartAddBtn({ code: v, name: r.name, value: r.availValue, source: "Запасы" })
        },
      ],
    });
    wireCartButtons(byId("stkTable"));
  }
  byId("stkQ").oninput = apply;
  byId("stkRestricted").onclick = e => { restrOnly = !restrOnly; e.target.classList.toggle("on"); apply(); };
  apply();
}

/* ===================== ЗАКУПКИ ===================== */
function renderPurchase(host) {
  const rows = D.stock.items.filter(i => i.purchase).map(i => ({ ...i.purchase, code: i.code, name: i.name }));
  const total = rows.reduce((s, r) => s + r.planV, 0);
  const openQty = rows.reduce((s, r) => s + r.openQty, 0);
  host.innerHTML = `
    <h1>Закупки</h1>
    <p class="sub">Открытые заявки и заказы на поставку по номенклатуре WK (${esc(D.stock.meta.srcPurchase)}).</p>
    <div class="kpis">
      ${kpi("Кодов в закупке", num(rows.length))}
      ${kpi("Плановая стоимость", mrub(total))}
      ${kpi("Ещё поставить, ед.", num(openQty, 0))}
    </div>
    <div id="purTable"></div>
  `;
  renderTable(byId("purTable"), {
    rows, limit: 300, sortKey: "planV",
    csv: true, csvName: "wk_purchase.csv",
    cols: [
      { key: "code", label: "Код", cls: "mono" },
      { key: "name", label: "Наименование", cls: "wrap" },
      { key: "planV", label: "Плановая ст-ть", numeric: true, fmt: rub },
      { key: "openQty", label: "Ещё поставить", numeric: true, fmt: v => num(v, 1) },
      { key: "transitQty", label: "В пути", numeric: true, fmt: v => num(v, 1) },
      { key: "lines", label: "Строк", numeric: true },
      { key: "topSupplier", label: "Поставщик", cls: "wrap" },
    ],
  });
}

/* ===================== КОДИФИКАЦИЯ ===================== */
function renderCodif(host) {
  const items = D.catalog.items;
  const uncoded = items.filter(i => !i.ekmtr);
  const ambiguous = items.filter(i => i.ekmtrAmbiguous);
  const value = uncoded.reduce((s, i) => s + (i.priceCNY || 0), 0);
  host.innerHTML = `
    <h1>Кодификация</h1>
    <p class="sub">Позиции прайса без кода ЕКМТР — рабочий список на заведение НСИ.</p>
    <div class="kpis">
      ${kpi("Без кода", num(uncoded.length) + " / " + num(items.length), "bad")}
      ${kpi("Стоимость", cny(value))}
      ${kpi("Неоднозначно сопоставлено", num(ambiguous.length), "warn")}
    </div>
    <div id="codifTable"></div>
  `;
  renderTable(byId("codifTable"), {
    rows: uncoded, limit: 300, sortKey: "priceCNY",
    csv: true, csvName: "wk_codification.csv",
    cols: [
      { key: "art", label: "Артикул", cls: "mono" },
      { key: "model", label: "Модель" },
      { key: "nameRu", label: "Наименование", cls: "wrap" },
      { key: "priceCNY", label: "Цена, ¥", numeric: true, fmt: cny },
      { key: "tree", label: "Узел", cls: "wrap", plain: v => v && v.length ? v[0].mech : "", fmt: v => v && v.length ? esc(v[0].mech) : "" },
      {
        key: "art", label: "", plain: () => "",
        fmt: (v, r) => cartAddBtn({ code: v, name: r.nameRu, value: null, source: "Кодификация" })
      },
    ],
  });
  wireCartButtons(byId("codifTable"));
}

/* ===================== ВЗАИМОЗАМЕНЯЕМОСТЬ ===================== */
function renderInter(host) {
  const m = D.interchange.meta;
  host.innerHTML = `
    <h1>Взаимозаменяемость</h1>
    <p class="sub">Группы номеров, взаимозаменяемых между комплектациями (из ведомости WK4.7). Строки без явной отметки — кандидаты на ручную проверку.</p>
    <div class="kpis">
      ${kpi("Групп", num(m.groups))}
      ${kpi("Номеров в группах", num(m.partsInGroups))}
      ${kpi("На разбор", num(m.unmarkedRows), "warn")}
    </div>
    <div class="grid2">
      <div class="card"><h3>Группы взаимозаменяемости</h3><div id="interGroups"></div></div>
      <div class="card"><h3>Кандидаты — с примечанием</h3><div id="interCand"></div></div>
    </div>
  `;
  renderTable(byId("interGroups"), {
    rows: D.interchange.groups.map((g, i) => ({ i, n: g.length, parts: g.join(", ") })),
    limit: 100,
    cols: [{ key: "n", label: "Номеров", numeric: true }, { key: "parts", label: "Каталожные номера", cls: "wrap mono" }],
  });
  renderTable(byId("interCand"), {
    rows: D.interchange.candidates, limit: 100,
    cols: [
      { key: "parts", label: "Номера", cls: "mono wrap", fmt: v => v.join(", ") },
      { key: "note", label: "Примечание", cls: "wrap" },
    ],
  });
}

/* ===================== КАЧЕСТВО ДАННЫХ ===================== */
function renderDQ(host) {
  host.innerHTML = `
    <h1>Качество данных</h1>
    <p class="sub">Известные пробелы и допущения — что не сошлось и почему.</p>
    <div id="dqList"></div>
  `;
  byId("dqList").innerHTML = D.quality.issues.map(i => `
    <div class="card"><h3>${esc(i.area)}</h3>
      <p style="margin:6px 0">${esc(i.issue)}</p>
      <p class="hint" style="color:var(--warn)">${esc(i.impact)}</p>
    </div>`).join("");
}

/* ===================== МЕТОДИКА ===================== */
function renderDoc(host) {
  host.innerHTML = `
    <h1>Методика</h1>
    <div class="card"><h3>Источники</h3>
      <div class="twrap"><table>
        <thead><tr><th>Выгрузка</th><th>Использование</th></tr></thead>
        <tbody>
          <tr><td>Прайс-лист ДП / УСО (Мэйлинь)</td><td>Каталог: цена CNY, ресурс, ТНВЭД, наименования RU/ZH</td></tr>
          <tr><td>Ведомость взаимозаменяемости WK4.7</td><td>Дерево узлов, механизмы, связка книга↔борт, группы взаимозаменяемости</td></tr>
          <tr><td>${esc(D.stock.meta.srcStock)}</td><td>Остатки по складам (SAP BW MM-M03)</td></tr>
          <tr><td>${esc(D.stock.meta.srcRestricted)}</td><td>Ограниченный и блокированный запас</td></tr>
          <tr><td>${esc(D.stock.meta.srcPurchase)}</td><td>Открытые заявки и заказы на поставку</td></tr>
          <tr><td>TOPO: mtr.json, ktg.json, детализация PM-06</td><td>Код ЕКМТР, КТГ/КИО, история и план ремонтов</td></tr>
        </tbody>
      </table></div>
    </div>
    <div class="card"><h3>Правила расчёта</h3>
      <ul>
        <li>Цена в юанях — только в разделе «Каталог». Везде далее — рубли, как в выгрузках SAP.</li>
        <li>Ограниченный и блокированный запас вычитается из остатка: доступно = остаток − ограничено − блокировано − на контроле качества.</li>
        <li>Обеспеченность считается только по номенклатуре WK (код входит в ППЗ 3.1.2.7 «Запчасти к экскаваторам WK»).</li>
        <li>Дубли карточек КТГ схлопываются по паре (площадка, точное имя борта) — берётся запись с непустым КТГ.</li>
      </ul>
    </div>
  `;
}

/* ===================== ОБНОВЛЕНИЕ ДАННЫХ ===================== */
/* Пересборка stock.json (остатки + ограниченный запас + закупки) прямо
   в браузере — те же правила, что в build/build_stock.py (доступно =
   остаток минус ограниченное), см. lib/stock_pipeline.js. Файлы не
   уходят никуда за пределы вкладки: разбор целиком в браузере. */
const UPD = { files: {}, busy: false, progress: null, result: null, err: "" };

async function updRun() {
  if (UPD.busy) return;
  const need = ["stock", "restricted", "purchase"];
  if (!need.every(k => UPD.files[k])) { UPD.err = "Нужны все три файла: остатки, ограниченный запас, закупка."; renderTab(); return; }
  UPD.busy = true; UPD.err = ""; UPD.result = null; UPD.progress = null;
  renderTab();
  try {
    const wkCodes = new Set(D.ekmtrWk.items.map(e => e.code));
    const tick = (label) => (p) => { UPD.progress = { label, pct: p.total ? Math.round(100 * p.done / p.total) : 0 }; renderTab(); };

    const zStock = await XLSXStream.openZip(UPD.files.stock);
    const stock = await StockPipeline.parseStock(zStock, wkCodes, tick("Остатки"));

    const zRestr = await XLSXStream.openZip(UPD.files.restricted);
    const restrSheet = await StockPipeline.firstSheetName(zRestr);
    const restr = await StockPipeline.parseRestricted(zRestr, restrSheet, wkCodes, tick("Ограниченный запас"));

    const zPurch = await XLSXStream.openZip(UPD.files.purchase);
    const purchSheet = await StockPipeline.firstSheetName(zPurch);
    const purch = await StockPipeline.parsePurchase(zPurch, purchSheet, wkCodes, tick("Закупка"));

    UPD.result = StockPipeline.assemble(D.ekmtrWk, stock, restr, purch, {
      stock: UPD.files.stock.name, restricted: UPD.files.restricted.name, purchase: UPD.files.purchase.name,
    });
  } catch (e) {
    UPD.err = "Ошибка разбора: " + e.message;
  }
  UPD.busy = false; UPD.progress = null;
  renderTab();
}

function updApply() {
  if (!UPD.result) return;
  D.stock = UPD.result;
  buildIndexes();
  UPD.applied = true;
  renderTab();
}

function updDownload() {
  if (!UPD.result) return;
  const blob = new Blob([JSON.stringify(UPD.result)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "stock.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function updDiffRow(label, oldV, newV, fmt) {
  const delta = newV - oldV;
  const cls = Math.abs(delta) < 1e-6 ? "" : delta > 0 ? "good" : "bad";
  return `<tr><td>${esc(label)}</td><td class="n">${fmt(oldV)}</td><td class="n">${fmt(newV)}</td>
    <td class="n"><span class="badge ${cls}">${delta >= 0 ? "+" : ""}${fmt(delta)}</span></td></tr>`;
}

function renderUpdate(host) {
  const f = UPD.files;
  host.innerHTML = `
    <h1>Обновление данных</h1>
    <p class="sub">Пересборка остатков, ограниченного запаса и закупок — прямо в браузере, без Python. Разбирает те же три файла, что и <code>build/build_stock.py</code>, теми же правилами; файлы не покидают вкладку.</p>
    ${callout("info", "Официальный способ обновить данные портала — <code>python3 build/build_stock.py</code> и коммит в репозиторий: здесь только предпросмотр и файл на скачивание, ничего не публикуется само.")}

    <div class="card">
      <h3>1. Файлы</h3>
      <p class="hint">Три отдельных поля — надёжнее, чем угадывать тип по имени файла (его могут переименовать при сохранении).</p>
      <div class="dl" style="grid-template-columns:170px 1fr">
        <dt>Остатки</dt><dd><input type="file" id="updFileStock" accept=".xlsx,.XLSX"/> ${f.stock ? `<span class="badge good">✓ ${esc(f.stock.name)}</span>` : ""}</dd>
        <dt>Ограниченный запас</dt><dd><input type="file" id="updFileRestricted" accept=".xlsx,.XLSX"/> ${f.restricted ? `<span class="badge good">✓ ${esc(f.restricted.name)}</span>` : ""}</dd>
        <dt>Закупка</dt><dd><input type="file" id="updFilePurchase" accept=".xlsx,.XLSX"/> ${f.purchase ? `<span class="badge good">✓ ${esc(f.purchase.name)}</span>` : ""}</dd>
      </div>
      <div style="margin-top:12px">
        <button class="iconbtn ${Object.keys(f).length === 3 ? "on" : ""}" id="updGo" ${UPD.busy ? "disabled" : ""}>${UPD.busy ? "Разбор…" : "Пересобрать"}</button>
      </div>
      ${UPD.progress ? `<div class="bar" style="margin-top:10px;height:8px"><i style="width:${UPD.progress.pct}%"></i></div><p class="hint">${esc(UPD.progress.label)} — ${UPD.progress.pct}%</p>` : ""}
      ${UPD.err ? callout("bad", esc(UPD.err)) : ""}
    </div>

    ${UPD.result ? `
    <div class="card">
      <h3>2. Сверка с текущими данными портала</h3>
      <div class="twrap"><table>
        <thead><tr><th>Показатель</th><th class="n">Сейчас</th><th class="n">Новая выгрузка</th><th class="n">Δ</th></tr></thead>
        <tbody>
          ${updDiffRow("Остаток всего", D.stock.meta.totalValue, UPD.result.meta.totalValue, rub)}
          ${updDiffRow("Доступно", D.stock.meta.totalAvailValue, UPD.result.meta.totalAvailValue, rub)}
          ${updDiffRow("Ограничено", D.stock.meta.totalRestrictedValue, UPD.result.meta.totalRestrictedValue, rub)}
          ${updDiffRow("Полностью ограничено, кодов", D.stock.meta.fullyRestrictedCodes, UPD.result.meta.fullyRestrictedCodes, v => num(v))}
          ${updDiffRow("Закупка план", D.stock.meta.totalPurchasePlanValue, UPD.result.meta.totalPurchasePlanValue, rub)}
          ${updDiffRow("Кодов с остатком", D.stock.meta.codesWithStock, UPD.result.meta.codesWithStock, v => num(v))}
        </tbody>
      </table></div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="iconbtn on" id="updApplyBtn">Применить в этом сеансе</button>
        <button class="iconbtn" id="updDownloadBtn">Скачать stock.json</button>
      </div>
      ${UPD.applied ? callout("good", "Применено — разделы «Запасы», «Закупки», «Обеспеченность» и карточки деталей теперь используют новую выгрузку (только в этой вкладке браузера, до перезагрузки страницы).") : ""}
      <p class="hint" style="margin-top:8px">Чтобы изменения остались навсегда — скачайте файл и замените <code>data/stock.json</code> в репозитории.</p>
    </div>` : ""}
  `;
  [["updFileStock", "stock"], ["updFileRestricted", "restricted"], ["updFilePurchase", "purchase"]].forEach(([id, key]) => {
    byId(id).onchange = e => {
      if (e.target.files[0]) UPD.files[key] = e.target.files[0];
      UPD.result = null; UPD.err = "";
      renderTab();
    };
  });
  const go = byId("updGo");
  if (go) go.onclick = updRun;
  const ap = byId("updApplyBtn");
  if (ap) ap.onclick = updApply;
  const dl = byId("updDownloadBtn");
  if (dl) dl.onclick = updDownload;
}

/* ===================== КАРТОЧКА ДЕТАЛИ (модалка) ===================== */
function closeModal() {
  byId("modalBack").hidden = true;
  byId("modalCard").hidden = true;
}
function openDetail(art) {
  const item = CATALOG_BY_ART.get(art);
  if (!item) return;
  const stock = item.ekmtr ? STOCK_BY_CODE.get(item.ekmtr) : null;
  const group = INTER_GROUP_OF.get(item.art) ||
    (item.tree[0] ? INTER_GROUP_OF.get(item.tree[0].num) : null);
  const drawings = D.drawings.byNum[item.art] ||
    (item.tree[0] ? D.drawings.byNum[item.tree[0].num] : null);
  const linkomeBooks = LINKOME_BOOKS_OF.get(item.art) ||
    (item.tree[0] ? LINKOME_BOOKS_OF.get(item.tree[0].num) : null);

  const back = byId("modalBack"), card = byId("modalCard");
  back.hidden = false; card.hidden = false;
  back.onclick = closeModal;

  card.innerHTML = `
    <button class="mclose" id="mCloseBtn">✕</button>
    <h2 class="mono">${esc(item.art)}</h2>
    <p class="sub" style="margin:0">${esc(item.nameRu)} ${item.nameZh ? `· ${esc(item.nameZh)}` : ""}</p>
    <dl class="dl">
      <dt>Модель</dt><dd>${esc(item.model)}</dd>
      <dt>Тип</dt><dd>${esc(item.type || "—")}</dd>
      <dt>Ресурс</dt><dd>${item.resource ? num(item.resource) + " м/ч" : "—"}</dd>
      <dt>ТНВЭД</dt><dd class="mono">${esc(item.tnved || "—")}</dd>
      <dt>Цена ДП</dt><dd>${cny(item.priceCNY)}${getRate() && item.priceCNY != null ? ` · ${rub(item.priceCNY * getRate())}` : ""}</dd>
      <dt>Цена УСО</dt><dd>${cny(item.priceUsoCNY)} ${item.priceDiffCNY != null ? `<span class="badge warn">Δ ${cny(item.priceDiffCNY)}</span>` : ""}</dd>
      <dt>Код ЕКМТР</dt><dd class="mono">${item.ekmtr ? esc(item.ekmtr) + (item.ekmtrAmbiguous ? ' <span class="badge warn">неоднозначно</span>' : "") : '<span class="badge bad">не кодифицировано</span>'}</dd>
      ${item.artNew ? `<dt>Артикул обн.</dt><dd class="mono">${esc(item.artNew)}</dd>` : ""}
    </dl>
    ${item.ekmtr ? `<p class="hint">🔗 <a href="https://victorekuznetsov.github.io/TOPO/?ekmtr=${encodeURIComponent(item.ekmtr)}#mtr" target="_blank" rel="noopener">Открыть в TOPO по коду ЕКМТР ${esc(item.ekmtr)} →</a> — КТГ, история и план ремонтов, закупки по этой позиции.</p>` : ""}

    ${stock ? `
      <h3 style="font-size:12.5px;margin:16px 0 6px">Остаток и закупка</h3>
      <dl class="dl">
        <dt>Остаток</dt><dd>${num(stock.qty, 1)} ед. · ${rub(stock.value)}</dd>
        <dt>Доступно</dt><dd>${rub(stock.availValue)}</dd>
        ${stock.restrictedValue > 0 ? `<dt>Ограничено</dt><dd><span class="badge restricted">${rub(stock.restrictedValue)}</span>${stock.fullyRestricted ? " — весь остаток" : ""}</dd>` : ""}
        ${stock.purchase ? `<dt>В закупке</dt><dd>${rub(stock.purchase.planV)} · ещё поставить ${num(stock.purchase.openQty, 1)} ед.</dd>` : ""}
      </dl>` : (item.ekmtr ? '<p class="hint">Остатка по этому коду нет.</p>' : "")}

    ${item.tree.length ? `
      <h3 style="font-size:12.5px;margin:16px 0 6px">В узлах${item.treeMethod === "parent" ? ' <span class="badge info">через родителя</span>' : ""}</h3>
      ${item.treeMethod === "parent" ? `<p class="hint">Номер ${esc(item.art)} сам в ведомости взаимозаменяемости не значится — показан узел-родитель на уровень выше (${esc(item.tree[0].num)}).</p>` : ""}
      <dl class="dl">
        ${item.tree.map(t => `<dt>${esc(t.book)}</dt><dd>${esc(t.mech)} · кол-во ${num(t.qty)}${item.treeMethod === "parent" ? ` <span class="dim">(${esc(t.num)})</span>` : ""}</dd>`).join("")}
      </dl>` : ""}

    ${group ? `
      <h3 style="font-size:12.5px;margin:16px 0 6px">Взаимозаменяемые номера</h3>
      <p class="mono" style="font-size:12px">${group.map(esc).join(", ")}</p>` : ""}

    ${drawings ? `
      <h3 style="font-size:12.5px;margin:16px 0 6px">Чертежи (реестр)</h3>
      <p style="font-size:12px">${drawings.map(d => `<span class="badge good">${esc(d.ext.toUpperCase())}</span> ${esc(d.path.split("/").pop())}`).join("<br>")}</p>
      <p class="hint">Файлы — в ветке <code>rawdata</code>, порталом пока не раздаются.</p>` :
        linkomeBooks ? `
      <h3 style="font-size:12.5px;margin:16px 0 6px">Чертёж в LinkOme</h3>
      <p style="font-size:12px"><span class="badge info">в реестре</span> книги: ${linkomeBooks.map(esc).join(", ")}</p>
      <p class="hint">Лист числится в оглавлении книги LinkOme, но сам чертёж пока не извлекается — формат .bli/.ilg не декодирован (см. «Качество данных»). Нужен экспорт через LinkOne Viewer.</p>` :
        '<p class="hint">Чертежа в реестре нет — ни в предразбитых файлах, ни в оглавлении LinkOme.</p>'}
  `;
  byId("mCloseBtn").onclick = closeModal;
}

/* ===================== БАЗА ЗНАНИЙ ===================== */
let KB_FILTER = { cls: "", q: "" };
let KB_TEXT = null;     // lazy: data/kb_text.json грузится только по первому поиску по содержимому
let KB_TEXT_LOADING = false;

function kbEnsureText(onReady) {
  if (KB_TEXT) { onReady(); return; }
  if (KB_TEXT_LOADING) return;
  KB_TEXT_LOADING = true;
  fetchJSON("data/kb_text.json").then(d => {
    KB_TEXT = d; KB_TEXT_LOADING = false; onReady();
  }).catch(() => { KB_TEXT_LOADING = false; onReady(); });
}

function kbSnippet(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return "";
  const start = Math.max(0, i - 70), end = Math.min(text.length, i + q.length + 90);
  let s = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  return esc(s).replace(re, m => `<mark>${m}</mark>`);
}

function renderKB(host) {
  const m = D.kb.meta;
  const classes = Object.entries(m.byClass).sort((a, b) => b[1] - a[1]);
  host.innerHTML = `
    <h1>База знаний</h1>
    <p class="sub">${num(m.docs)} документов из АТ-Майнинг (руководства, схемы, нормы ТО, чертежи CAD) — ${num(m.totalBytes / 1e9, 1)} ГБ. Каталоги в PDF (${m.skippedCatalogPdf}) сюда не входят — чертежи берутся из LinkOme, каталог остаётся только справочно там, где книги LinkOme нет (см. «Качество данных»).</p>
    ${callout("info", "Реестр — метаданные (путь, класс, модель); сами файлы лежат в ветке <code>rawdata</code> и пока не раздаются порталом — см. открытый вопрос о хостинге в плане.")}
    <div class="kbgrid" id="kbClasses"></div>

    <div class="card">
      <h3>Поиск по содержимому</h3>
      <p class="hint" id="kbSearchHint">Индекс — первые ~60 тыс. знаков каждого PDF/DOCX/PPTX; загружается при первом запросе. Легаси .doc/.ppt не проиндексированы — LibreOffice не работает в этой песочнице.</p>
      <input type="search" id="kbSearchQ" placeholder="Слово или фраза, например «регламент», «K1839»…"/>
      <div id="kbSearchResults" style="margin-top:10px"></div>
    </div>

    <div class="toolbar">
      <input type="search" id="kbQ" placeholder="Имя файла…"/>
      <select id="kbModel"><option value="">Все модели</option><option>WK-20</option><option>WK-20C</option><option>WK-35</option></select>
      <span class="count" id="kbCount"></span>
    </div>
    <div id="kbTable"></div>
  `;
  byId("kbClasses").innerHTML = classes.map(([c, n]) => `
    <div class="kbclass ${KB_FILTER.cls === c ? "on" : ""}" data-c="${esc(c)}">
      <div class="n">${n}</div><div class="l">${esc(c)}</div>
    </div>`).join("");

  const byPath = new Map(D.kb.docs.map(d => [d.path, d]));
  let searchTimer;
  byId("kbSearchQ").oninput = e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    const box = byId("kbSearchResults");
    if (!q || q.length < 3) { box.innerHTML = q ? '<p class="hint">Минимум 3 символа.</p>' : ""; return; }
    box.innerHTML = '<p class="hint">Поиск…</p>';
    searchTimer = setTimeout(() => {
      kbEnsureText(() => {
        if (!KB_TEXT) { box.innerHTML = callout("bad", "Индекс недоступен."); return; }
        const hintEl = byId("kbSearchHint");
        if (hintEl) hintEl.textContent = `Индекс: ${num(KB_TEXT.meta.docsIndexed)} документов (PDF, DOCX, PPTX; первые ~${Math.round(KB_TEXT.meta.maxCharsPerDoc / 1000)} тыс. знаков каждого). Легаси .doc/.ppt не проиндексированы — LibreOffice не работает в этой песочнице.`;
        const ql = q.toLowerCase();
        const hits = [];
        for (const path in KB_TEXT.docs) {
          const t = KB_TEXT.docs[path].text;
          if (t.toLowerCase().includes(ql)) hits.push({ path, doc: byPath.get(path) });
        }
        if (!hits.length) { box.innerHTML = '<p class="hint">Ничего не найдено.</p>'; return; }
        box.innerHTML = `<p class="hint">${hits.length} документов</p>` + hits.slice(0, 40).map(h => `
          <div style="padding:9px 0;border-bottom:1px solid var(--grid)">
            <div style="font-size:12.5px;font-weight:600">${esc(h.doc ? h.doc.name : h.path)}</div>
            <div style="font-size:11px;color:var(--ink-3);margin:1px 0 4px">${esc(h.doc ? h.doc.class : "")}</div>
            <div style="font-size:12px;color:var(--ink-2);line-height:1.5">${kbSnippet(KB_TEXT.docs[h.path].text, q)}</div>
          </div>`).join("");
      });
    }, 300);
  };

  function apply() {
    let rows = D.kb.docs.filter(d => {
      if (KB_FILTER.cls && d.class !== KB_FILTER.cls) return false;
      const model = byId("kbModel").value;
      if (model && d.model !== model) return false;
      if (KB_FILTER.q && !d.name.toLowerCase().includes(KB_FILTER.q.toLowerCase())) return false;
      return true;
    });
    byId("kbCount").textContent = num(rows.length) + " документов";
    renderTable(byId("kbTable"), {
      rows, limit: 300, sortKey: "name", sortDir: 1,
      csv: true, csvName: "wk_kb_registry.csv",
      cols: [
        { key: "path", label: "Путь", cls: "wrap mono" },
        { key: "name", label: "Файл", cls: "wrap" },
        { key: "class", label: "Класс" },
        { key: "model", label: "Модель", plain: v => v || "", fmt: v => v || '<span class="dim">общая</span>' },
        { key: "sizeBytes", label: "Размер", numeric: true, plain: v => Math.round(v / 1e6 * 10) / 10, fmt: v => num(v / 1e6, 1) + " МБ" },
      ],
    });
  }
  qsa(".kbclass", host).forEach(el => el.onclick = () => {
    KB_FILTER.cls = KB_FILTER.cls === el.dataset.c ? "" : el.dataset.c;
    qsa(".kbclass", host).forEach(x => x.classList.toggle("on", x.dataset.c === KB_FILTER.cls));
    apply();
  });
  byId("kbQ").oninput = e => { KB_FILTER.q = e.target.value; apply(); };
  byId("kbModel").onchange = apply;
  apply();
}

/* ---------- навигация / поиск / тема ---------- */
function initNav() {
  qsa("#tabs button").forEach(b => b.onclick = () => {
    qsa("#tabs button").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    TAB = b.dataset.t;
    renderTab();
  });
  byId("btnTheme").onclick = () => {
    const html = document.documentElement;
    const cur = html.getAttribute("data-theme");
    const next = cur === "light" ? "dark" : "light";
    html.setAttribute("data-theme", next);
    byId("btnTheme").textContent = next === "light" ? "☀" : "☾";
  };
  byId("btnCart").onclick = () => {
    qsa("#tabs button").forEach(x => x.classList.remove("on"));
    TAB = "cart";
    renderTab();
  };
  cartUpdateBadge();
  let searchTimer;
  byId("globalSearch").oninput = e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (!q) return;
    searchTimer = setTimeout(() => {
      qsa("#tabs button").forEach(x => x.classList.remove("on"));
      qs('#tabs button[data-t="catalog"]').classList.add("on");
      TAB = "catalog";
      CAT_FILTER.q = q;
      renderTab();
    }, 250);
  };
}

document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

initNav();
boot();
