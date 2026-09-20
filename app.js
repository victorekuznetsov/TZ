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
function makeActivatable(root, selector) {
  qsa(selector, root).forEach(el => {
    if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
    if (!el.hasAttribute("role")) el.setAttribute("role", "button");
    el.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); }
    });
  });
}
// та же нормализация номера, что в build/ekmtr_match.py::norm — по ней
// ключи в data/linkome_catalog.json.byPart
const normText = s => String(s == null ? "" : s).normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
const normArt = s => normText(s).toUpperCase().replace(/[^0-9A-ZА-ЯЁ]/g, "");
const debounce = (fn, wait = 220) => {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
};

// Витрины грузятся тегами <script src="data/*.local.js"> (не fetch): fetch()
// локального файла браузер блокирует при открытии страницы без сервера
// (file://…, двойной щелчок по index.html) — <script> этому не подчиняется.
// Каждый такой файл кладёт свои данные в window.__DATA__["<имя>"]. Тот же
// приём — в TOPO, CAT и KOMATSU_PARTS_BOOK. build/make_local_js.py
// генерирует .local.js из уже собранного data/*.json.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src}: не удалось загрузить`));
    document.head.appendChild(s);
  });
}
function dataFor(key) {
  const v = window.__DATA__ && window.__DATA__[key];
  if (v === undefined) throw new Error(`data/${key}.local.js: нет window.__DATA__["${key}"]`);
  return v;
}

/* ---------- выгрузка CSV ---------- */
function csvCell(v) {
  if (v == null) return "";
  if (Array.isArray(v)) v = v.length;               // напр. массив узлов -> число
  if (typeof v === "object") v = "";                 // прочие объекты в CSV не тащим
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
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
  let shownLimit = limit || rows.length;
  function draw() {
    const sorted = [...rows].sort((a, b) => {
      const va = a[key], vb = b[key];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb), "ru") * dir;
    });
    const shown = shownLimit ? sorted.slice(0, shownLimit) : sorted;
    const thead = `<thead><tr>${cols.map(c =>
      `<th class="${c.numeric ? "n" : ""} ${c.key === key ? "sorted" : ""}" data-k="${c.key}" tabindex="0" role="columnheader" aria-sort="${c.key === key ? (dir > 0 ? "ascending" : "descending") : "none"}">${esc(c.label)}${c.key === key ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`
    ).join("")}</tr></thead>`;
    const tbody = `<tbody>${shown.map((r, ri) => {
      const cls = rowClass ? rowClass(r) : "";
      return `<tr class="${cls}" data-ri="${ri}"${onRowClick ? ' tabindex="0" role="button"' : ""}>${cols.map(c => {
        const v = c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key]);
        return `<td class="${c.numeric ? "n" : ""} ${c.cls || ""}">${v}</td>`;
      }).join("")}</tr>`;
    }).join("")}</tbody>`;
    container.innerHTML =
      (csv ? `<div style="display:flex;justify-content:flex-end;margin-bottom:6px"><button class="minibtn" id="${container.id}_csv" type="button">⇓ CSV (${num(sorted.length)})</button></div>` : "") +
      `<div class="twrap"><table>${thead}${tbody}</table></div>` +
      (shown.length < rows.length ? `<div class="table-more"><span class="count">показано ${shown.length} из ${rows.length}</span><button class="minibtn" type="button" data-more>Показать ещё</button><button class="minibtn" type="button" data-all>Показать все</button></div>` : "");
    const sortBy = th => {
      const k = th.dataset.k;
      if (k === key) dir = -dir; else { key = k; dir = -1; }
      draw();
    };
    qsa("th[data-k]", container).forEach(th => {
      th.onclick = () => sortBy(th);
      th.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sortBy(th); } };
    });
    if (onRowClick) {
      qsa("tbody tr", container).forEach(tr => {
        tr.onclick = () => onRowClick(shown[+tr.dataset.ri]);
        tr.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(shown[+tr.dataset.ri]); } };
      });
    }
    if (csv) {
      const btn = byId(container.id + "_csv");
      if (btn) btn.onclick = () => downloadCSV(csvName || "export.csv", sorted, cols);
    }
    const more = qs("[data-more]", container), all = qs("[data-all]", container);
    if (more) more.onclick = () => { shownLimit += limit || rows.length; draw(); };
    if (all) all.onclick = () => { shownLimit = rows.length; draw(); };
  }
  draw();
}

function callout(kind, html) { return `<div class="callout ${kind}">${html}</div>`; }

/* ---------- линейный график (SVG, hover-курсор + тултип) ---------- */
/* series: [{label, values, color}] — values выровнены по months, null = нет данных за месяц */
function renderLineChart(container, { months, series, height = 220, yFormat = v => pct(v), yDomain = [0, 1] }) {
  if (!months || !months.length) { container.innerHTML = callout("info", "Нет данных для графика."); return; }
  const W = 760, H = height, padL = 34, padR = 8, padT = 10, padB = 22;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const [yMin, yMaxRaw] = yDomain;
  const yMax = yMaxRaw === yMin ? yMin + 1 : yMaxRaw;
  const x = i => padL + (months.length === 1 ? innerW / 2 : (innerW * i) / (months.length - 1));
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
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block" id="${uid}" role="img" aria-label="${esc(series.map(s => s.label).join(", "))}">
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
    let i = months.length === 1 ? 0 : Math.round(((px - padL) / innerW) * (months.length - 1));
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
// ключ витрины (D.<key>) -> имя файла data/<файл>.local.js
const FILES = {
  catalog: "catalog", ekmtrWk: "ekmtr_wk",
  tree: "tree", interchange: "interchange",
  fleetBooks: "fleet_books", fleet: "fleet",
  repairs: "repairs", provision: "provision",
  stock: "stock", quality: "quality", kb: "kb",
  drawings: "drawings", linkome: "linkome_catalog",
  linkomeDraw: "linkome_drawings",
};

function boot() {
  const keys = Object.keys(FILES);
  Promise.all(keys.map(k => loadScript(`data/${FILES[k]}.local.js`)))
    .then(() => {
      keys.forEach(k => { D[k] = dataFor(FILES[k]); });
      buildIndexes();
      renderTab();
    })
    .catch(e => {
      byId("main").innerHTML = callout("bad",
        `Не удалось загрузить данные: ${esc(e.message)}. Проверьте, что рядом с index.html лежит вся ` +
        `папка целиком (включая data/) — файлы data/*.local.js должны быть на месте.`);
    });
}

/* индексы для быстрого поиска и join между витринами */
let STOCK_BY_CODE = new Map();
let EKMTR_NAME = new Map();
let CATALOG_BY_ART = new Map();
let CATALOG_BY_NORMART = new Map(); // нормализованный номер -> позиция каталога (для кросс-линковки из LinkOne)
let INTER_GROUP_OF = new Map(); // каталожный номер -> группа взаимозаменяемости (массив)
function linkomeRowsFor(art) {
  // data/linkome_catalog.json.byPart уже ключуется нормализованным номером
  return (art && D.linkome.byPart[normArt(art)]) || null;
}
function buildIndexes() {
  STOCK_BY_CODE = new Map(D.stock.items.map(i => [String(i.code), i]));
  EKMTR_NAME = new Map(D.ekmtrWk.items.map(i => [String(i.code), i.name]));
  CATALOG_BY_ART = new Map(D.catalog.items.map(i => [i.art, i]));
  CATALOG_BY_NORMART = new Map(D.catalog.items.map(i => [normArt(i.art), i]));
  INTER_GROUP_OF = new Map();
  D.interchange.groups.forEach(g => g.forEach(part => INTER_GROUP_OF.set(normArt(part), g)));
}

/* ---------- вкладки ---------- */
function renderTab() {
  const host = byId("main");
  switch (TAB) {
    case "sum": return renderSum(host);
    case "catalog": return renderCatalog(host);
    case "linkone": return renderLinkone(host);
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
    default: TAB = "sum"; return renderSum(host);
  }
}

/* ===================== ЗАЯВКА (КОРЗИНА) ===================== */
/* Рабочий список на закупку/кодификацию — собирается из «Обеспеченности»,
   «Запасов» и «Кодификации» кнопкой «+ в заявку» на строке. Хранится в
   браузере (localStorage) — черновик одного человека, не общая заявка;
   выгружается в CSV или печатается, дальше — обычным порядком в закупку. */
const CART_KEY = "wkcrm_cart_v1";
function cartGet() {
  try {
    const value = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(i => i && typeof i === "object" && i.code != null).map(i => ({
      code: String(i.code), name: String(i.name || ""), source: String(i.source || ""),
      value: Number.isFinite(Number(i.value)) ? Number(i.value) : null,
      qty: Math.max(1, parseInt(i.qty, 10) || 1), note: String(i.note || ""), addedAt: i.addedAt || "",
    }));
  } catch (e) { return []; }
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
  byId("btnCart")?.setAttribute("aria-label", n ? `Открыть заявку, позиций: ${n}` : "Открыть заявку");
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
      <span class="count" id="cartTotal" aria-live="polite">${num(items.length)} позиций${items.some(i => i.value) ? " · " + rub(items.reduce((s, i) => s + (i.value || 0) * (i.qty || 1), 0)) : ""}</span>
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
    if (it) {
      it.qty = Math.max(1, parseInt(el.value, 10) || 1); el.value = it.qty; cartSet(items2);
      const total = byId("cartTotal");
      if (total) total.textContent = `${num(items2.length)} позиций · ${rub(items2.reduce((s, i) => s + (i.value || 0) * i.qty, 0))}`;
    }
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
      ${kpi("Не обеспечено 26-27", mrub(p.wk.late + p.wk.undated + p.wk.gap), "bad")}
    </div>

    ${callout("info", `<b>Ограниченный запас</b> — позиции, которые физически есть на складе, но SAP запрещает их использовать в ремонте (брак, резерв, спорное качество). Такой запас <b>вычитается</b> из доступного остатка везде в этом портале и подсвечивается статусом «ограничено» — не путайте с обычным наличием.`)}

    <h2>Обеспеченность плана 2026–2027 (номенклатура WK)</h2>
    <p class="sub">Потребность ${mrub(p.wk.value)} закрывается остатком и уже размещённой закупкой с учётом сроков поставки. Данные на ${dmy(p.asOf)}.</p>
    ${provBar(p.wk, p.wk.value, 14)}
    ${provLegend(p.wk)}
    <div class="grid3" style="margin-top:14px">
      <div class="card"><h3>Обеспечено к сроку работ</h3><div class="kpi good" style="border:0;padding:0"><div class="v">${mrub(p.wk.fromStock + p.wk.fromBuy)}</div></div><p class="hint">${num(100 * (p.wk.fromStock + p.wk.fromBuy) / (p.wk.value || 1), 0)}% потребности</p></div>
      <div class="card"><h3>Ещё можно успеть заказом</h3><div class="kpi warn" style="border:0;padding:0"><div class="v">${mrub((p.feasible.inTime || {}).value || 0)}</div></div><p class="hint">при сроке поставки ${num(p.leadMedianDays)} дн.</p></div>
      <div class="card"><h3>Заказывать уже поздно</h3><div class="kpi bad" style="border:0;padding:0"><div class="v">${mrub(["late3", "lateMore", "past"].reduce((a, k) => a + ((p.feasible[k] || {}).value || 0), 0))}</div></div><p class="hint">срок работ наступит раньше поставки</p></div>
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
let CAT_FILTER = { model: "", q: "", noCode: false, diff: false };

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
      <button class="pill ${CAT_FILTER.noCode ? "on" : ""}" id="catNoCode" type="button" aria-pressed="${CAT_FILTER.noCode}">без кода ЕКМТР</button>
      <button class="pill ${CAT_FILTER.diff ? "on" : ""}" id="catDiff" type="button" aria-pressed="${CAT_FILTER.diff}">цена ДП≠УСО</button>
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--ink-3)">
        курс ¥→₽ <input type="number" id="catRate" step="0.01" min="0" placeholder="—" value="${rate || ""}" style="width:64px;background:var(--surface-2);border:var(--hair);border-radius:var(--radius);color:var(--ink);padding:5px 7px;font:inherit"/>
      </span>
      <button class="minibtn" id="catReset" type="button">Сбросить</button>
      <span class="count" id="catCount"></span>
    </div>
    <div id="catTable"></div>
  `;
  byId("catRate").oninput = e => {
    const v = parseFloat(e.target.value);
    setRate(isFinite(v) && v > 0 ? v : null);
    apply();
  };
  function apply() {
    const curRate = getRate();
    const qText = normText(CAT_FILTER.q).trim();
    const qNum = normArt(CAT_FILTER.q);
    let rows = items.filter(i => {
      if (CAT_FILTER.model && i.model !== CAT_FILTER.model) return false;
      if (CAT_FILTER.noCode && i.ekmtr) return false;
      if (CAT_FILTER.diff && i.priceDiffCNY == null) return false;
      if (qText) {
        const text = normText([i.nameRu, i.nameZh, i.model, i.type, i.tnved,
          ...(i.tree || []).flatMap(t => [t.num, t.mech])].filter(Boolean).join(" "));
        const numberHit = qNum.length >= 2 && [i.art, i.artNew, i.ekmtr].some(v => normArt(v).includes(qNum));
        if (!numberHit && !text.includes(qText)) return false;
      }
      return true;
    });
    byId("catCount").textContent = num(rows.length) + " позиций";
    if (!rows.length) { byId("catTable").innerHTML = callout("info", "По текущим фильтрам позиций нет. Измените запрос или сбросьте фильтры."); return; }
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
          key: "art", label: "Чертёж / состав", cls: "",
          plain: v => D.drawings.byNum[v] ? "чертёж" : linkomeRowsFor(v) ? "состав узла (LinkOme)" : "",
          fmt: (v) => D.drawings.byNum[v]
            ? '<span class="badge good">чертёж</span>'
            : linkomeRowsFor(v) ? '<span class="badge info">состав узла</span>' : ""
        },
      ],
    });
  }
  byId("catQ").oninput = debounce(e => { CAT_FILTER.q = e.target.value; apply(); });
  byId("catModel").onchange = e => { CAT_FILTER.model = e.target.value; apply(); };
  byId("catNoCode").onclick = e => { CAT_FILTER.noCode = !CAT_FILTER.noCode; e.currentTarget.classList.toggle("on", CAT_FILTER.noCode); e.currentTarget.setAttribute("aria-pressed", CAT_FILTER.noCode); apply(); };
  byId("catDiff").onclick = e => { CAT_FILTER.diff = !CAT_FILTER.diff; e.currentTarget.classList.toggle("on", CAT_FILTER.diff); e.currentTarget.setAttribute("aria-pressed", CAT_FILTER.diff); apply(); };
  byId("catReset").onclick = () => { CAT_FILTER = { model: "", q: "", noCode: false, diff: false }; renderCatalog(host); };
  apply();
}

/* ===================== КАТАЛОГ LINKONE (формат Komatsu/Cat/Cummins) =====================
   Дерево книга → узел → состав, как в песочнице KOMATSU_PARTS_BOOK: слева дерево, справа
   таблица позиций текущего узла, клик по позиции с дочерним узлом — раскрывает его, клик по
   номеру, сверенному с прайсом ДП, — открывает карточку детали. В отличие от Komatsu, чертёж
   (растровый .ilg) не декодирован — контейнер LinkOne читается, картинка нет (см. «Качество
   данных»), поэтому показывается только состав узла, без изображения. */
const LO = { book: null, index: null, current: null, filter: "", fullscreen: false };
const loAliasKey = id => String(id || "").toLowerCase().replace(/^\d+-/, "").replace(/^dk/, "k").replace(/a$/, "");

function loBuildIndex(bookCode) {
  const byPageId = new Map(); // нормализованный (lower) id -> {id, title, rows}
  const aliases = new Map();
  const prefix = bookCode + "|";
  for (const key in D.linkome.pages) {
    if (!key.startsWith(prefix)) continue;
    const p = D.linkome.pages[key];
    byPageId.set(p.id.toLowerCase(), p);
    const alias = loAliasKey(p.id);
    if (!aliases.has(alias)) aliases.set(alias, p);
  }
  const referenced = new Set();
  byPageId.forEach(p => (p.rows || []).forEach(r => { if (r.link) referenced.add(loAliasKey(r.link)); }));
  const roots = [];
  byPageId.forEach((p, id) => { if (!referenced.has(loAliasKey(id))) roots.push(p); });
  // главный узел книги — корень с самым большим деревом (сумма строк по всем потомкам), а не
  // просто самой длинной собственной таблицей: у страницы-узла в глубине дерева бывает больше
  // прямых строк, чем у корня, но это не делает её книгой. Остальные корни (если есть) —
  // несвязанные страницы (не входят в дерево главного корня), показываем отдельным списком.
  const subtreeSize = p => {
    const seen = new Set();
    const walk = id => {
      if (seen.has(id)) return 0;
      seen.add(id);
      const page = byPageId.get(id) || aliases.get(loAliasKey(id));
      if (!page) return 0;
      let n = (page.rows || []).length;
      for (const r of page.rows || []) if (r.link) n += walk(r.link.toLowerCase());
      return n;
    };
    return walk(p.id.toLowerCase());
  };
  roots.sort((a, b) => subtreeSize(b) - subtreeSize(a));
  return { byPageId, aliases, roots };
}

function loFindPage(id) {
  return id ? LO.index.byPageId.get(id.toLowerCase()) || LO.index.aliases.get(loAliasKey(id)) || null : null;
}

// путь от ближайшего корня до узла (BFS по rows[].link) — для «хлебных крошек»
function loPathTo(targetId) {
  const target = targetId.toLowerCase();
  for (const root of LO.index.roots) {
    if (root.id.toLowerCase() === target) return [root];
    const seen = new Set([root.id.toLowerCase()]);
    const q = [[root]];
    while (q.length) {
      const path = q.shift();
      const last = path[path.length - 1];
      for (const r of last.rows || []) {
        if (!r.link) continue;
        const lid = r.link.toLowerCase();
        if (seen.has(lid)) continue;
        const kid = loFindPage(lid);
        if (!kid) continue;
        const next = [...path, kid];
        if (lid === target) return next;
        seen.add(lid);
        q.push(next);
      }
    }
  }
  const p = loFindPage(targetId);
  return p ? [p] : [];
}

function renderLinkone(host) {
  const books = Object.entries(D.linkome.books).sort((a, b) => a[0].localeCompare(b[0]));
  host.innerHTML = `
    <h1>Каталог LinkOne</h1>
    <p class="sub">${D.linkome.meta.books} книг, ${num(D.linkome.meta.pagesTotal)} страниц, ${num(D.linkome.meta.rowsTotal)} строк состава — разбор заводской выгрузки LinkOne, формат тот же, что у каталогов Komatsu/Cat/Cummins: дерево узлов книги, таблица позиций узла, карточка детали. ${D.linkome.meta.pagesFailed} страниц не разобрались (см. «Качество данных»).</p>
    ${callout("good", `Чертежи распакованы из самих книг: ${num(D.linkomeDraw.meta.sheets)} листов на ${num(D.linkomeDraw.meta.pages)} узлов — формат .ilg разобран (палитра + построчный RLE, см. «Методика»). Чертёж открывается рядом с составом узла, клик — в полный размер.`)}
    <div class="lo-books" id="loBooks">
      ${books.map(([code, b]) => `
        <div class="lo-book${LO.book === code ? " on" : ""}" data-book="${esc(code)}">
          <span class="n">${esc(code)}</span>
          <span class="s">${esc(b.model || "")} · ${num(b.pageCount)} стр.</span>
        </div>`).join("")}
    </div>
    <div id="loBody"></div>
  `;
  qsa(".lo-book", host).forEach(el => el.onclick = () => loSelectBook(el.dataset.book, host));
  makeActivatable(host, ".lo-book");
  if (LO.book && books.some(([c]) => c === LO.book)) {
    loRenderBody(host);
  } else if (books.length) {
    loSelectBook(books[0][0], host);
  }
}

function loSelectBook(code, host) {
  LO.book = code;
  LO.index = loBuildIndex(code);
  LO.current = LO.index.roots[0] ? LO.index.roots[0].id : null;
  LO.filter = "";
  qsa(".lo-book", host).forEach(el => el.classList.toggle("on", el.dataset.book === code));
  loRenderBody(host);
}

function loRenderBody(host) {
  const body = byId("loBody");
  if (!LO.index || !LO.index.roots.length) {
    body.innerHTML = callout("bad", "В этой книге не удалось построить дерево — нет ни одной страницы.");
    return;
  }
  body.innerHTML = `
    <div class="lo-wrap">
      <div>
        <input type="search" id="loFilter" placeholder="Название узла или номер детали…" value="${esc(LO.filter)}" style="width:100%;margin-bottom:8px;background:var(--surface-2);border:var(--hair);border-radius:var(--radius);color:var(--ink);padding:7px 10px;font:inherit;font-size:12px"/>
        <div class="lo-tree" id="loTree"></div>
      </div>
      <div id="loMain"></div>
    </div>
  `;
  byId("loFilter").oninput = e => { LO.filter = e.target.value; loRenderTree(); };
  loRenderTree();
  loRenderMain();
}

function loRenderTree() {
  const host = byId("loTree");
  const q = normText(LO.filter).trim();
  const qNum = normArt(LO.filter);
  if (q) {
    const hits = [];
    LO.index.byPageId.forEach(p => {
      const hay = normText(p.title);
      const partHit = (p.rows || []).some(r => (qNum.length >= 2 && normArt(r.part).includes(qNum)) || normText(r.name).includes(q));
      if (hay.includes(q) || partHit || (qNum.length >= 2 && normArt(p.id).includes(qNum))) hits.push(p);
    });
    host.innerHTML = hits.length
      ? hits.slice(0, 200).map(p => `
          <div class="lo-node-head" data-id="${esc(p.id)}" style="border-left-color:transparent">
            <span class="t">${esc(p.title || p.id)}</span>
            <span class="c">${(p.rows || []).length}</span>
          </div>`).join("")
      : '<div class="tree-note" style="padding:8px 10px;font-size:12px;color:var(--ink-3)">Ничего не найдено</div>';
    qsa(".lo-node-head", host).forEach(el => el.onclick = () => { LO.current = el.dataset.id; LO.filter = ""; loRenderTree(); loRenderMain(); byId("loFilter").value = ""; });
    return;
  }
  const path = LO.current ? loPathTo(LO.current) : [];
  const openIds = new Set(path.map(p => p.id.toLowerCase()));
  const seenGlobal = new Set();
  const nodeHtml = (p, depth) => {
    const id = p.id.toLowerCase();
    const cycle = seenGlobal.has(id);
    seenGlobal.add(id);
    const kids = cycle ? [] : (p.rows || []).map(r => r.link && loFindPage(r.link)).filter(Boolean);
    const isOpen = openIds.has(id);
    const isActive = LO.current && LO.current.toLowerCase() === id;
    return `<div class="lo-node${isOpen ? " open" : ""}${isActive ? " active" : ""}">
      <div class="lo-node-head" data-id="${esc(p.id)}">
        <span class="tw">${kids.length ? (isOpen ? "▾" : "▸") : ""}</span>
        <span class="t" title="${esc(p.title || p.id)}">${esc(p.title || p.id)}</span>
        <span class="c">${(p.rows || []).length}</span>
      </div>
      ${kids.length ? `<div class="lo-node-kids">${kids.map(k => nodeHtml(k, depth + 1)).join("")}</div>` : ""}
    </div>`;
  };
  const main = LO.index.roots[0];
  const orphans = LO.index.roots.slice(1);
  let html = nodeHtml(main, 0);
  if (orphans.length) {
    html += `<div class="lo-orphans">
      <div class="lo-node-head" data-toggle-orphans style="color:var(--ink-3)">
        <span class="t">Несвязанные страницы книги</span><span class="c">${orphans.length}</span>
      </div>
      <div class="lo-node-kids" id="loOrphanKids">${orphans.map(o => nodeHtml(o, 0)).join("")}</div>
    </div>`;
  }
  host.innerHTML = html;
  qsa(".lo-node-head[data-id]", host).forEach(el => el.onclick = e => {
    e.stopPropagation();
    LO.current = el.dataset.id;
    loRenderTree();
    loRenderMain();
  });
  makeActivatable(host, ".lo-node-head");
  const orphToggle = host.querySelector("[data-toggle-orphans]");
  if (orphToggle) orphToggle.onclick = () => byId("loOrphanKids").classList.toggle("open-orphans");
}

function loRenderMain() {
  const host = byId("loMain");
  const page = loFindPage(LO.current);
  if (!page) { host.innerHTML = callout("bad", "Узел не найден."); return; }
  const path = loPathTo(page.id);
  const crumbs = path.map(p => `<a data-id="${esc(p.id)}">${esc(p.title || p.id)}</a>`).join(" › ") || esc(page.title || page.id);
  const rows = page.rows || [];
  const sheets = (D.linkomeDraw.byPage[`${LO.book}|${page.id.toUpperCase()}`]) || [];
  // Раскладка узла — как в каталоге Cummins: чертёж слева «липким» столбцом,
  // таблица позиций справа, листы переключаются каруселью, клик по чертежу
  // разворачивает его в натуральную величину.
  host.innerHTML = `
    <div class="lo-crumbs">${crumbs}</div>
    <div class="lo-head">
      <div>
        <h2 class="lo-title">${esc(page.title || page.id)}</h2>
        <div class="lo-meta"><span class="mono">${esc(page.id)}</span> · позиций: ${num(rows.length)}${sheets.length ? ` · листов: ${sheets.length}` : " · чертежа нет"}</div>
      </div>
      <button class="minibtn lo-full-btn" id="loFullscreen" type="button" aria-pressed="${LO.fullscreen}" title="Развернуть чертёж и таблицу на весь экран">${LO.fullscreen ? "✕ Закрыть полный экран" : "⛶ На весь экран"}</button>
    </div>
    <div class="lo-body${LO.fullscreen ? " lo-fullscreen" : ""}" id="loBody">
      <div class="lo-fullbar"><b>${esc(page.title || page.id)}</b><span>${num(rows.length)} позиций</span><button class="minibtn" id="loFullscreenClose" type="button">✕ Закрыть</button></div>
      <div class="lo-pane">
        ${sheets.length ? `
          <div class="lo-draw" id="loDraw">
            <div class="lo-stage" id="loStage">
              <img src="${esc(sheets[0].file)}" id="loDrawImg" alt="Чертёж ${esc(page.id)}"/>
              <div class="lo-spots" id="loSpots"></div>
            </div>
          </div>
          ${sheets.length > 1 ? `<div class="lo-carousel">
            <button class="lo-navbtn" id="loPrev" type="button" title="Предыдущий лист">‹</button>
            <span id="loSheetLabel"></span>
            <button class="lo-navbtn" id="loNext" type="button" title="Следующий лист">›</button>
          </div>` : ""}
          <div class="lo-hint" id="loDrawHint"></div>`
        : `<div class="lo-nodraw">Для этого узла в книге нет чертежа — состав приведён справа.</div>`}
      </div>
      <div class="lo-tablepane">
        <div class="twrap"><table class="lo-parts">
          <thead><tr><th class="c-pos">№</th><th>Номер</th><th>Наименование</th><th class="n">Кол.</th>
            <th>ЕКМТР</th><th>Наличие<br>и заказ</th><th class="n">Цена</th><th></th></tr></thead>
          <tbody>${rows.map(r => {
            const kid = r.link && loFindPage(r.link);
            const sup = supplyCells(r.part);
            return `<tr data-item="${esc(r.item || "")}">
              <td class="c-pos">${esc(r.item || "")}</td>
              <td class="mono">${sup.art
                ? `<span class="pn-link" data-art="${esc(sup.art)}" title="Открыть карточку детали">${esc(r.part || "")}</span>`
                : esc(r.part || "")}</td>
              <td class="wrap">${esc(r.name || "")}</td>
              <td class="n">${r.qty != null ? num(r.qty) : ""}</td>
              <td>${sup.ekmtr}</td>
              <td class="c-stock">${sup.stock}${sup.order ? " " + sup.order : ""}</td>
              <td class="n c-price">${sup.price}</td>
              <td class="c-act">${kid ? `<span class="badge info" data-goto="${esc(kid.id)}" style="cursor:pointer">узел ▸</span>` : ""}${sup.art ? ` ${cartAddBtn(sup.cart)}` : ""}</td>
            </tr>`;
          }).join("") || `<tr><td colspan="8" class="dim">Состав пуст</td></tr>`}</tbody>
        </table></div>
      </div>
    </div>
  `;
  // Номера позиций в самом чертеже не нарисованы — в книге это пустые кружки,
  // а цифру в них рисует программа просмотра по рамкам выносок из .bli. Здесь
  // то же самое: накладываем номер поверх кружка и делаем его кликабельным.
  let loSheet = 0;
  function loShowSheet(k) {
    const s = sheets[k];
    if (!s) return;
    loSheet = k;
    const img = byId("loDrawImg");
    img.src = s.file;
    img.onerror = () => {
      img.hidden = true;
      const hint = byId("loDrawHint");
      if (hint) hint.textContent = "Файл чертежа не загрузился. Проверьте целостность папки media/linkome_drawings.";
    };
    img.onload = () => { img.hidden = false; };
    img.classList.remove("zoomed");
    const label = byId("loSheetLabel");
    if (label) label.textContent = `Лист ${k + 1} из ${sheets.length}`;
    const box = byId("loSpots");
    const spots = s.spots || [];
    box.innerHTML = spots.map((sp, i) =>
      `<b class="lo-spot" data-n="${esc(sp.n)}" data-i="${i}" title="Позиция ${esc(sp.n)}"
         style="left:${sp.x}%;top:${sp.y}%;width:${sp.w}%;height:${sp.h}%">${esc(sp.n)}</b>`).join("");
    const hint = byId("loDrawHint");
    if (hint) {
      hint.textContent = spots.length
        ? `Номер на чертеже = № позиции в таблице (${spots.length} выносок). Клик по номеру подсвечивает позицию, наведение на строку — выноску. Щелчок по чертежу — увеличить.`
        : "Выноски для этого листа в книге не заданы. Щелчок по чертежу — увеличить.";
    }
    qsa(".lo-spot", box).forEach(el => el.onclick = () => loPickItem(el.dataset.n, true));
    qsa(".lo-spot", box).forEach(el => {
      el.onmouseenter = () => loHiRow(el.dataset.n, true);
      el.onmouseleave = () => loHiRow(el.dataset.n, false);
    });
  }
  // Номер позиции подставляется в селектор как значение атрибута в кавычках:
  // CSS.escape тут не годится — он экранирует по правилам идентификатора и из
  // «7» делает «\37 », что уже ничему не соответствует.
  const attrVal = v => String(v).replace(/[\\"]/g, "\\$&");
  // Наведение и выбор — разные состояния: иначе уход мыши с выноски снимал бы
  // подсветку, поставленную кликом по ней же.
  function loHiRow(n, on) {
    qsa(`tbody tr[data-item="${attrVal(n)}"]`, host).forEach(tr => tr.classList.toggle("lo-hi", on));
  }
  function loHiSpot(n, on) {
    qsa(`.lo-spot[data-n="${attrVal(n)}"]`, host).forEach(el => el.classList.toggle("hov", on));
  }
  function loPickItem(n, scroll) {
    qsa(".lo-spot", host).forEach(el => el.classList.toggle("on", el.dataset.n === n));
    qsa("tbody tr", host).forEach(tr => tr.classList.toggle("lo-pin", tr.dataset.item === n));
    if (!scroll) return;
    const tr = qs(`tbody tr[data-item="${attrVal(n)}"]`, host);
    if (tr) tr.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  if (sheets.length) {
    loShowSheet(0);
    qsa("tbody tr[data-item]", host).forEach(tr => {
      const n = tr.dataset.item;
      if (!n) return;
      tr.onmouseenter = () => loHiSpot(n, true);
      tr.onmouseleave = () => loHiSpot(n, false);
    });
  }
  const prev = byId("loPrev"), next = byId("loNext"), dimg = byId("loDrawImg");
  if (prev) prev.onclick = () => loShowSheet((loSheet - 1 + sheets.length) % sheets.length);
  if (next) next.onclick = () => loShowSheet((loSheet + 1) % sheets.length);
  // Зум — как в Cummins: снимаем ограничение по ширине, выноски остаются на
  // местах, потому что заданы в процентах и масштабируются вместе с картинкой.
  if (dimg) dimg.onclick = () => dimg.classList.toggle("zoomed");
  const setFullscreen = on => {
    LO.fullscreen = on;
    document.body.classList.toggle("lo-full-open", on);
    loRenderMain();
  };
  byId("loFullscreen").onclick = () => setFullscreen(!LO.fullscreen);
  const fullClose = byId("loFullscreenClose");
  if (fullClose) fullClose.onclick = () => setFullscreen(false);
  qsa(".lo-crumbs a", host).forEach(el => el.onclick = () => { LO.current = el.dataset.id; loRenderTree(); loRenderMain(); });
  qsa("[data-goto]", host).forEach(el => el.onclick = () => { LO.current = el.dataset.goto; loRenderTree(); loRenderMain(); });
  qsa("[data-art]", host).forEach(el => el.onclick = () => openDetail(el.dataset.art));
  makeActivatable(host, ".lo-crumbs a,.pn-link,[data-goto],.lo-spot");
  wireCartButtons(host);
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
      { key: "garage", label: "Борт", cls: "mono", fmt: v => v || '<span class="dim">—</span>' },
      {
        key: "siteName", label: "Площадка", cls: "wrap",
        plain: (v, r) => v || r.site || "",
        fmt: (v, r) => v ? `${esc(v)} <span class="dim">${esc(r.site)}</span>` : esc(r.site || "—"),
      },
      { key: "model", label: "Модель" },
      { key: "serial", label: "Заводской №", cls: "mono", fmt: v => v || '<span class="dim">—</span>' },
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
// Пять корзин покрытия — порядок фиксирован: от «уже есть» к «ничего нет».
// Цвет закреплён за смыслом корзины, а не за её местом в списке.
const PROV_BUCKETS = [
  { key: "fromStock", label: "Есть на складе", color: "var(--c1)" },
  { key: "fromBuy", label: "Закупка успевает", color: "var(--c7)" },
  { key: "late", label: "Закупка опаздывает", color: "var(--c5)" },
  { key: "undated", label: "Закупка просрочена / без срока", color: "var(--c6)" },
  { key: "gap", label: "Не покрыто ничем", color: "var(--c8)" },
];
// Вердикт — по БЛИЖАЙШЕМУ незакрытому сроку позиции. Деньги при этом
// делятся построчно (canOrder / tooLate): у одной позиции часть строк
// может быть просрочена, а часть — ещё закрываема заказом.
const PROV_VERDICT = {
  covered: { label: "обеспечено", cls: "good" },
  inTime: { label: "успеем, если заказать", cls: "warn" },
  late: { label: "не успеем", cls: "bad" },
  past: { label: "ближайший срок прошёл", cls: "bad" },
  nodate: { label: "срок не проставлен", cls: "" },
};
const dmy = s => s && s.length >= 10 ? s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4) : "—";

// Горизонтальная доля: один прямоугольник = одна корзина, между заливками
// зазор цветом фона, чтобы соседние сегменты не сливались.
function provBar(t, total, h) {
  const T = total || 1;
  const seg = PROV_BUCKETS.filter(b => t[b.key] > 0).map(b =>
    `<i style="width:${(100 * t[b.key] / T).toFixed(2)}%;background:${b.color}" title="${esc(b.label)}: ${mrub(t[b.key])}"></i>`).join("");
  return `<div class="prov-bar" style="height:${h || 10}px">${seg}</div>`;
}
// Пустые корзины в легенду и разбивку не попадают: строка «0,0 млн ₽»
// ничего не сообщает, а место занимает.
function provLegend(t) {
  return `<div class="prov-legend">` + PROV_BUCKETS.filter(b => !t || t[b.key] > 0).map(b =>
    `<span><i style="background:${b.color}"></i>${esc(b.label)}</span>`).join("") + `</div>`;
}
// Разрез: строка = группа, слева подпись, справа доля и обеспеченность.
function provCut(rows, nameOf) {
  return `<table class="prov-cut"><tbody>` + rows.map(r => {
    const ok = r.fromStock + r.fromBuy;
    return `<tr>
      <th>${esc(nameOf ? nameOf(r.key) : r.key)}</th>
      <td class="n">${mrub(r.value)}</td>
      <td class="b">${provBar(r, r.value, 8)}</td>
      <td class="n ${ok / (r.value || 1) < .5 ? "low" : ""}">${num(100 * ok / (r.value || 1), 0)}%</td>
    </tr>`;
  }).join("") + `</tbody></table>`;
}

function provisionAudit(m, items, stockItems) {
  const w = m.wk, tol = .01;
  const qtyBuckets = w.fromStockQty + w.fromBuyQty + w.lateQty + w.undatedQty + w.gapQty;
  const valueBuckets = w.fromStock + w.fromBuy + w.late + w.undated + w.gap;
  const badBalance = items.filter(i => Math.abs(i.needQty - i.fromStock - i.fromBuy - i.late - i.undated - i.gap) > tol);
  const stockOver = items.filter(i => i.fromStock > i.availQty + tol);
  const buyOver = items.filter(i => i.fromBuy + i.late + i.undated > i.openQty + tol);
  const asOfMonth = (m.asOf || "").slice(0, 7);
  let overdueQty = 0, overdueCodes = 0;
  (stockItems || []).forEach(i => {
    const byMonth = ((i.purchase || {}).byMonth) || {};
    const q = Object.entries(byMonth).reduce((s, [month, qty]) => s + (month && month < asOfMonth ? (+qty || 0) : 0), 0);
    if (q > tol) { overdueQty += q; overdueCodes++; }
  });
  return {
    qtyDelta: w.qty - qtyBuckets, valueDelta: w.value - valueBuckets,
    badBalance: badBalance.length, stockOver: stockOver.length, buyOver: buyOver.length,
    overdueQty, overdueCodes,
  };
}

function provisionArrivalChart(arrivals, asOf) {
  const month = (asOf || "").slice(0, 7);
  const rows = (arrivals || []).filter(r => r.month).map(r => ({ ...r, overdue: r.month < month }));
  const max = Math.max(1, ...rows.map(r => r.qty || 0));
  return `<div class="prov-arrivals" role="img" aria-label="Открытые поставки по плановому месяцу">
    ${rows.map(r => `<div class="prov-arrival${r.overdue ? " overdue" : ""}" title="${esc(r.month)}: ${num(r.qty, 0)} ед.">
      <span>${esc(r.month.slice(2).replace("-", "."))}</span>
      <i style="height:${Math.max(3, 100 * r.qty / max)}%"></i>
      <b>${num(r.qty, 0)}</b>
    </div>`).join("")}
  </div>`;
}

function renderProvision(host) {
  const m = D.provision.meta, w = m.wk;
  const T = w.value || 1;
  const sites = { ...((D.fleet && D.fleet.meta && D.fleet.meta.sites) || {}), "2400": "Сухой Лог" };
  const f = m.feasible || {};
  const fv = k => (f[k] && f[k].value) || 0;
  const gapTotal = w.late + w.undated + w.gap;
  const eta = new Date(m.asOf + "T00:00:00");
  eta.setDate(eta.getDate() + (m.leadMedianDays || 0));
  const etaStr = dmy(eta.toISOString().slice(0, 10));
  const audit = provisionAudit(m, D.provision.items, D.stock.items);
  const auditOk = Math.abs(audit.qtyDelta) < .01 && Math.abs(audit.valueDelta) < .1 && !audit.badBalance && !audit.stockOver && !audit.buyOver;

  host.innerHTML = `
    <h1>Обеспеченность плана ТОиР 2026–2027</h1>
    <p class="sub">${num(m.orders)} открытых заказов, ${num(m.lines)} строк плана без факта.
      Потребность закрывается <b>доступным остатком</b> (за вычетом ограниченного) и <b>уже размещённой закупкой</b>,
      приход которой сопоставлен с датой начала работ помесячно. Данные на ${dmy(m.asOf)}.</p>
    <div class="kpis">
      ${kpi("Потребность WK", mrub(w.value))}
      ${kpi("Обеспечено к сроку", mrub(w.fromStock + w.fromBuy) + ` <span class="kpi-sub">${num(100 * (w.fromStock + w.fromBuy) / T, 0)}%</span>`, "good")}
      ${kpi("Не обеспечено", mrub(gapTotal) + ` <span class="kpi-sub">${num(100 * gapTotal / T, 0)}%</span>`, "bad")}
      ${kpi("Ещё можно успеть", mrub(fv("inTime")), "warn")}
      ${kpi("Уже не успеть", mrub(fv("late3") + fv("lateMore") + fv("past")), "bad")}
    </div>

    <div class="prov-main">
      ${provBar(w, T, 16)}
      ${provLegend(w)}
      <table class="prov-cut wide"><tbody>
        ${PROV_BUCKETS.filter(b => w[b.key] > 0).map(b => `<tr>
          <th><i class="dot" style="background:${b.color}"></i>${esc(b.label)}</th>
          <td class="n">${mrub(w[b.key])}</td>
          <td class="n">${num(100 * w[b.key] / T, 1)}%</td>
          <td class="n">${num(w[b.key + "Qty"], 0)} ед.</td>
        </tr>`).join("")}
      </tbody></table>
    </div>

    <div class="prov-audit-grid">
      <section class="card prov-audit">
        <div class="prov-card-head"><div><h3>Контроль распределения</h3><p class="hint">Автоматическая сверка потребности, остатка и открытой закупки</p></div><span class="badge ${auditOk ? "good" : "bad"}">${auditOk ? "баланс сходится" : "есть ошибки"}</span></div>
        <div class="prov-checks">
          <div><span class="prov-check ${Math.abs(audit.qtyDelta) < .01 ? "ok" : "bad"}">${Math.abs(audit.qtyDelta) < .01 ? "✓" : "!"}</span><b>Количество</b><small>расхождение ${num(audit.qtyDelta, 2)} ед.</small></div>
          <div><span class="prov-check ${Math.abs(audit.valueDelta) < .1 ? "ok" : "bad"}">${Math.abs(audit.valueDelta) < .1 ? "✓" : "!"}</span><b>Стоимость</b><small>расхождение ${rub(audit.valueDelta)}</small></div>
          <div><span class="prov-check ${!audit.stockOver && !audit.buyOver ? "ok" : "bad"}">${!audit.stockOver && !audit.buyOver ? "✓" : "!"}</span><b>Лимиты источников</b><small>${audit.stockOver + audit.buyOver} превышений</small></div>
        </div>
        ${audit.badBalance ? callout("bad", `${num(audit.badBalance)} позиций не сходятся по количеству.`) : ""}
        ${audit.overdueQty ? callout("warn", `<b>${num(audit.overdueQty, 0)} ед. по ${num(audit.overdueCodes)} кодам</b> имеют открытый плановый приход раньше даты снимка. Сборщик исключает их из покрытия к сроку и относит использованный объём в корзину «просрочено / без срока».`) : ""}
      </section>
      <section class="card prov-arrival-card">
        <div class="prov-card-head"><div><h3>Календарь открытой закупки</h3><p class="hint">Количество по плановому месяцу; красным — дата уже прошла</p></div></div>
        ${provisionArrivalChart(m.arrivals, m.asOf)}
      </section>
    </div>

    <h2>Сроки: что ещё можно закрыть заказом сегодня</h2>
    <p class="sub">Медианный фактический срок поставки по номенклатуре WK — <b>${num(m.leadMedianDays)} дн.</b>
      (${num(m.leadMeasurements)} замеров «дата поставки − дата заявки» по ${num(m.leadCodes)} кодам той же выгрузки закупки).
      Заказ, размещённый на дату выгрузки, приходит около <b>${etaStr}</b>. Для позиции со своей статистикой берётся её собственный срок.</p>
    <table class="prov-cut wide"><tbody>
      ${[["inTime", "Успеем, если заказать сейчас", "good"],
         ["late3", "Не успеем, опоздание до 3 мес.", "warn"],
         ["lateMore", "Не успеем, опоздание больше 3 мес.", "bad"],
         ["past", "Срок работ уже прошёл", "bad"],
         ["nodate", "Срок работ не проставлен", ""]]
        .filter(([k]) => f[k]).map(([k, label, cls]) => `<tr>
          <th><span class="badge ${cls}">${esc(label)}</span></th>
          <td class="n">${mrub(f[k].value)}</td>
          <td class="n">${num(100 * f[k].value / (gapTotal || 1), 0)}% дефицита</td>
          <td class="n">${num(f[k].lines)} строк</td>
        </tr>`).join("")}
    </tbody></table>

    <h2>Разрезы</h2>
    <div class="prov-cuts">
      <div><h3>По году плана</h3>${provCut(m.byYear)}</div>
      <div><h3>По сроку начала работ</h3>${provCut(m.byHalf, k => k.replace(/ (I+)$/, (_, r) => ", " + r + " полугодие"))}</div>
      <div><h3>По площадкам</h3>${provCut(m.bySite, k => sites[k] ? k + " " + sites[k] : k)}</div>
      <div><h3>По виду затрат</h3>${provCut(m.byKind)}</div>
    </div>

    <h2>Позиции</h2>
    <p class="sub">${num(m.positions)} позиций номенклатуры WK. Прочие материалы (ГСМ, общий крепёж, общие МТР)
      на ${mrub(m.notWkParts.value)} в расчёт не входят — витрины остатков по ним нет, и считать их дефицитом было бы неправдой.</p>
    <div class="toolbar">
      <select id="provStatus">
        <option value="">Все позиции</option>
        <option value="can">Ещё можно успеть — заказать сейчас</option>
        <option value="too">Заказывать уже поздно</option>
        <option value="none">Нет ни остатка, ни закупки</option>
        <option value="partial">Покрыто частично</option>
        <option value="full">Покрыто полностью</option>
      </select>
      <input type="search" id="provQ" placeholder="Код или наименование…" aria-label="Поиск позиции"/>
      <span class="count" id="provCount"></span>
    </div>
    <div id="provTable"></div>
  `;

  const items = D.provision.items;
  function apply() {
    const f2 = byId("provStatus").value;
    const q = normText(byId("provQ").value).trim();
    let rows = f2 === "can" ? items.filter(i => i.canOrder > 0)
      : f2 === "too" ? items.filter(i => i.tooLate > 0)
        : f2 ? items.filter(i => i.status === f2) : items;
    if (q) rows = rows.filter(i => normText(i.code).includes(q) || normText(i.name).includes(q));
    // Считаем ту сумму, по которой отфильтровали, иначе итог в счётчике
    // не сойдётся с цифрой в сводке наверху.
    const sumKey = f2 === "can" ? "canOrder" : f2 === "too" ? "tooLate" : "gapValue";
    byId("provCount").textContent = num(rows.length) + " позиций · " +
      (f2 === "can" ? "ещё можно заказать " : f2 === "too" ? "поздно заказывать " : "дефицит ") +
      mrub(rows.reduce((s, r) => s + r[sumKey], 0));
    renderTable(byId("provTable"), {
      rows, limit: 300, sortKey: sumKey,
      rowClass: r => r.restricted ? "restricted-row" : "",
      csv: true, csvName: "wk_provision.csv",
      cols: [
        { key: "code", label: "Код ЕКМТР", cls: "mono" },
        { key: "name", label: "Наименование", cls: "wrap" },
        { key: "needQty", label: "Нужно", numeric: true, fmt: v => num(v, 0) },
        { key: "fromStock", label: "Со склада", numeric: true, fmt: v => num(v, 0) },
        { key: "fromBuy", label: "Закупка к сроку", numeric: true, fmt: v => num(v, 0) },
        {
          key: "needQty", label: "Покрытие", numeric: true,
          plain: (v, r) => v ? Math.round(100 * (r.fromStock + r.fromBuy) / v) : 0,
          fmt: (v, r) => {
            const pc = v ? Math.min(100, 100 * (r.fromStock + r.fromBuy) / v) : 0;
            return `<span class="prov-cover"><i style="width:${pc.toFixed(1)}%"></i></span><small>${num(pc, 0)}%</small>`;
          }
        },
        {
          key: "gap", label: "Дефицит", numeric: true,
          plain: (v, r) => num(v + r.late + r.undated, 0),
          fmt: (v, r) => {
            const g = v + r.late + r.undated;
            return g > 0 ? `<b style="color:var(--bad)">${num(g, 0)}</b>` : "—";
          }
        },
        { key: "gapValue", label: "Дефицит, ₽", numeric: true, fmt: rub },
        {
          key: "canOrder", label: "Ещё можно заказать", numeric: true,
          fmt: v => v > 0 ? `<span style="color:var(--warn)">${rub(v)}</span>` : "—"
        },
        {
          key: "leadDays", label: "Срок пост.", numeric: true,
          plain: (v, r) => v + (r.leadN ? "" : "*"),
          fmt: (v, r) => num(v) + " дн." + (r.leadN ? "" : '<span title="своей статистики нет — медиана по WK" style="color:var(--ink-4)">*</span>')
        },
        { key: "orderBy", label: "Заказать до", plain: v => v || "", fmt: v => v ? `<span class="mono">${dmy(v)}</span>` : "—" },
        {
          key: "verdict", label: "Вывод",
          plain: (v, r) => (PROV_VERDICT[v] || {}).label + (r.slipDays ? ` (+${r.slipDays} дн.)` : ""),
          fmt: (v, r) => {
            const d = PROV_VERDICT[v] || { label: v, cls: "" };
            return `<span class="badge ${d.cls}">${esc(d.label)}</span>` +
              (r.slipDays ? ` <span style="color:var(--ink-3);font-size:11px">+${num(r.slipDays)} дн.</span>` : "");
          }
        },
        {
          key: "code", label: "", plain: () => "",
          fmt: (v, r) => cartAddBtn({ code: v, name: r.name, value: r.gapValue || r.needValue, source: "Обеспеченность" })
        },
      ],
    });
    wireCartButtons(byId("provTable"));
  }
  byId("provStatus").onchange = apply;
  byId("provQ").oninput = debounce(apply, 150);
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
      <button class="pill" id="stkRestricted" type="button" aria-pressed="false">только ограниченные</button>
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
  byId("stkRestricted").onclick = e => { restrOnly = !restrOnly; e.currentTarget.classList.toggle("on", restrOnly); e.currentTarget.setAttribute("aria-pressed", restrOnly); apply(); };
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
    <div class="card"><h3>Обеспеченность: как считается</h3>
      <p class="hint">Потребность — строки плана ТОиР 2026–2027 по технике WK, у которых нет ни факта количества, ни факта суммы. Распределение — как в MRP/ATP, в два прохода.</p>
      <ul>
        <li><b>Проход 1.</b> Потребность, отсортированная по дате начала работ, забирает доступный остаток, затем — те приходы закупки, чей месяц поставки не раньше даты снимка и не позже месяца начала работ («успевает»).</li>
        <li><b>Проход 2.</b> Остатками приходов закрывается то, что не успели, — это «опоздание».</li>
        <li>Два прохода здесь принципиальны: в один проход ранняя потребность забирает поздний приход и помечает его опозданием, хотя тот же приход мог бы вовремя закрыть более позднюю потребность. На этих данных разница почти вдвое по доле «закупка успевает».</li>
        <li><b>Срок поставки</b> — медиана «дата поставки − дата заявки» по той же выгрузке закупки (${num(D.provision.meta.leadMeasurements)} замеров по ${num(D.provision.meta.leadCodes)} кодам). Для позиции со своей статистикой берётся её собственный срок, иначе — медиана по WK (${num(D.provision.meta.leadMedianDays)} дн.).</li>
        <li><b>Дата анализа</b> — самая поздняя из дат выгрузок (${dmy(D.provision.meta.asOf)}), а не дата открытия портала: иначе один и тот же исходник давал бы разный ответ ото дня ко дню.</li>
      </ul>
      <p class="hint">Открытая поставка с плановым месяцем раньше даты снимка считается просроченной: её старый срок ненадёжен, поэтому она не улучшает показатель «обеспечено к сроку». Чего расчёт сознательно не делает: прочая номенклатура (ГСМ, общий крепёж, общие МТР) в него не входит — витрины остатков по ней нет; срок прихода закупки известен только до месяца, внутри месяца приход считается успевающим.</p>
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
      ${UPD.applied ? callout("good", "Применено в этом сеансе: разделы «Запасы», «Закупки» и карточки деталей используют новую выгрузку. «Обеспеченность» не пересчитывается в браузере: для неё нужен <code>build/build_provision.py</code>.") : ""}
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
let MODAL_RETURN_FOCUS = null;
function closeModal() {
  if (byId("modalCard").hidden) return;
  byId("modalBack").hidden = true;
  byId("modalCard").hidden = true;
  document.body.classList.remove("modal-open");
  if (MODAL_RETURN_FOCUS && document.contains(MODAL_RETURN_FOCUS)) MODAL_RETURN_FOCUS.focus();
}
function openDetail(art) {
  const item = CATALOG_BY_ART.get(art);
  if (!item) return;
  const stock = item.ekmtr ? STOCK_BY_CODE.get(item.ekmtr) : null;
  const group = INTER_GROUP_OF.get(normArt(item.art)) ||
    (item.tree[0] ? INTER_GROUP_OF.get(normArt(item.tree[0].num)) : null);
  const drawings = D.drawings.byNum[item.art] ||
    (item.tree[0] ? D.drawings.byNum[item.tree[0].num] : null);
  const linkomeRows = linkomeRowsFor(item.art) ||
    (item.tree[0] ? linkomeRowsFor(item.tree[0].num) : null);

  MODAL_RETURN_FOCUS = document.activeElement;
  const back = byId("modalBack"), card = byId("modalCard");
  back.hidden = false; card.hidden = false;
  document.body.classList.add("modal-open");
  back.onclick = closeModal;

  card.innerHTML = `
    <button class="mclose" id="mCloseBtn" type="button" aria-label="Закрыть карточку">✕</button>
    <h2 class="mono" id="modalTitle">${esc(item.art)}</h2>
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
      <p style="font-size:12px">${drawings.map(d => `<a href="${esc(kbFileUrl(d.path))}" target="_blank" rel="noopener" style="text-decoration:none"><span class="badge good">${esc(d.ext.toUpperCase())}</span> ${esc(d.path.split("/").pop())}</a>`).join("<br>")}</p>` : ""}

    ${linkomeRows ? `
      <h3 style="font-size:12.5px;margin:16px 0 6px">Состав в LinkOme</h3>
      <dl class="dl">
        ${linkomeRows.map(r => `<dt>${esc(r.book)}</dt><dd>${esc(r.pageTitle || r.page)} · кол-во ${num(r.qty ?? 1)}${r.raw !== item.art ? ` <span class="dim mono">(${esc(r.raw)})</span>` : ""}</dd>`).join("")}
      </dl>
      <p class="hint">Реальный состав узла из книги LinkOme (формат разобран — см. «Качество данных»); сам растровый чертёж (.ilg) пока не извлекается — эта часть формата у книг WK ещё не поддалась.</p>` :
      !drawings ? '<p class="hint">Ни чертежа, ни строки в LinkOme для этого номера нет.</p>' : ""}
  `;
  byId("mCloseBtn").onclick = closeModal;
  byId("mCloseBtn").focus();
}

/* ===================== БАЗА ЗНАНИЙ ===================== */
let KB_FILTER = { cls: "", q: "" };
let KB_SEARCH_QUERY = "";
let KB_TEXT = null;     // lazy: data/kb_text.json грузится только по первому поиску по содержимому
let KB_TEXT_PROMISE = null;

function kbEnsureText() {
  if (KB_TEXT) return Promise.resolve(KB_TEXT);
  if (!KB_TEXT_PROMISE) KB_TEXT_PROMISE = loadScript("data/kb_text.local.js")
    .then(() => (KB_TEXT = dataFor("kb_text"))).catch(() => null);
  return KB_TEXT_PROMISE;
}

function kbSnippet(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return "";
  const start = Math.max(0, i - 70), end = Math.min(text.length, i + q.length + 90);
  let s = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  return esc(s).replace(re, m => `<mark>${m}</mark>`);
}

// data/kb.json.docs[].path — "rawdata/АТ майнинг/…"; сами файлы лежат в этой же ветке
// под media/kb/ (см. build/README.md) — переписываем префикс и кодируем каждый сегмент
// пути отдельно (не всю строку — иначе "/" превратится в %2F и ссылка сломается).
function kbFileUrl(path) {
  const rel = path.startsWith("rawdata/") ? path.slice("rawdata/".length) : path;
  return "media/kb/" + rel.split("/").map(encodeURIComponent).join("/");
}

/* ---------- единый поиск базы знаний ----------
   Один запрос идёт по всем витринам сразу: прайс ДП, состав узлов LinkOne,
   дерево узлов, коды ЕКМТР, парк и документы — по номеру и по наименованию.
   Номера сравниваются в нормализованном виде (normArt: без точек и дефисов),
   наименования — по подстроке без учёта регистра. Так же устроен поиск в
   каталоге Cummins: одна строка, дальше результат разложен по разделам.
   Содержимое документов ищется отдельно и лениво — индекс тяжёлый. */
const KB_LIMIT = 40;   // строк на раздел; остальное сворачивается в «…ещё N»

function kbFindAll(q) {
  const lo = q.trim().toLowerCase();
  const num = normArt(q);
  const hasNum = num.length >= 2;
  const hit = (s) => s && String(s).toLowerCase().includes(lo);
  const hitNum = (s) => hasNum && normArt(s).includes(num);
  const out = { parts: [], linkome: [], nodes: [], ekmtr: [], fleet: [], docs: [] };

  for (const i of D.catalog.items) {
    if (hitNum(i.art) || hit(i.nameRu) || hit(i.nameZh) || hitNum(i.ekmtr)) out.parts.push(i);
  }
  for (const key in D.linkome.byPart) {
    const rows = D.linkome.byPart[key];
    if (key.includes(num) && hasNum) { out.linkome.push([key, rows]); continue; }
    if (lo.length >= 2 && rows.some(r => hit(r.name))) out.linkome.push([key, rows]);
  }
  for (const n of D.tree.nodes) {
    if (hitNum(n.num) || hit(n.nameRu) || hit(n.nameZh) || hit(n.mech)) out.nodes.push(n);
  }
  for (const e of D.ekmtrWk.items) {
    if (hitNum(e.code) || hit(e.name) || hitNum(e.cat)) out.ekmtr.push(e);
  }
  for (const u of D.fleet.units) {
    if (hit(u.name) || hit(u.model) || hit(u.garage) || hit(u.book) ||
        hitNum(u.serial) || hit(u.siteName) || hit(u.site)) out.fleet.push(u);
  }
  for (const d of D.kb.docs) {
    if (hit(d.name) || hit(d.class) || hit(d.model) || hit(d.path)) out.docs.push(d);
  }
  return out;
}

// Подсветка совпадения в результате: сначала экранируем, потом вставляем <mark>,
// иначе разметка из данных попала бы в вывод как разметка.
function kbMark(text, q) {
  const s = esc(text == null ? "" : text);
  const needle = String(q || "").trim();
  if (!needle) return s;
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  return s.replace(re, m => `<mark>${m}</mark>`);
}

/* ---------- снабжение позиции: ЕКМТР, остаток, консигнация, цена, заказ ----------
   Формат тот же, что в каталоге Komatsu: в строке состава — короткие «пилюли»,
   подробности (по складам, по годам поставки) в подсказке. Источник — прайс ДП
   (цена, код ЕКМТР) и выгрузка SAP (остатки с разбивкой по складам, открытые
   закупки). Консигнация в остатках приходит отдельным складом, поэтому
   показывается своей пометкой: она лежит на площадке, но ещё не наша.
   Разбивки консигнации по площадкам в выгрузке пока нет — будет добавлена. */
const CONSIGN_RE = /консигнац/i;

function supplyOf(part) {
  const item = part && CATALOG_BY_NORMART.get(normArt(part));
  if (!item) return null;
  const stock = item.ekmtr ? STOCK_BY_CODE.get(item.ekmtr) : null;
  let consign = 0, own = 0;
  const byWh = (stock && stock.byWarehouse) || {};
  for (const wh in byWh) {
    if (CONSIGN_RE.test(wh)) consign += byWh[wh]; else own += byWh[wh];
  }
  return { item, stock, consign, own, byWh };
}

function supplyCells(part) {
  const s = supplyOf(part);
  if (!s) return { ekmtr: '<span class="dim">—</span>', stock: '<span class="dim">—</span>',
                   price: '<span class="dim">—</span>', order: "" };
  const { item, stock, consign, own, byWh } = s;
  const whTitle = Object.keys(byWh).sort((a, b) => byWh[b] - byWh[a])
    .map(w => `${w}: ${num(byWh[w], 1)}`).join("\n");

  let stockHtml;
  if (!stock || !stock.qty) {
    stockHtml = '<span class="dim">—</span>';
  } else {
    const parts = [];
    if (own) parts.push(`<span class="sup-pill${stock.availQty > 0 ? " ok" : ""}" title="${esc(whTitle)}">${num(own, 1)}</span>`);
    if (stock.restrictedQty > 0) {
      parts.push(`<span class="sup-pill restricted" title="Ограниченный запас — есть, но использовать нельзя">${num(stock.restrictedQty, 1)}</span>`);
    }
    if (consign) {
      parts.push(`<span class="sup-pill consign" title="Консигнация — лежит на площадке, но ещё не выкуплено">К ${num(consign, 1)}</span>`);
    }
    stockHtml = parts.join(" ") || '<span class="dim">—</span>';
  }

  const rate = getRate();
  const priceHtml = item.priceCNY == null ? '<span class="dim">—</span>'
    : `<span class="sup-price" title="${esc(item.nameRu || "")}">${cny(item.priceCNY)}</span>` +
      (rate ? `<span class="sup-sub">${rub(item.priceCNY * rate)}</span>` : "");

  let orderHtml = "";
  const p = stock && stock.purchase;
  if (p && p.openQty > 0) {
    const years = Object.keys(p.years || {}).sort().map(y => `${y}: ${p.years[y]}`).join("\n");
    orderHtml = `<span class="sup-pill order" title="${esc(`в закупке ${num(p.qty, 1)}, поставщик ${p.topSupplier || "—"}${years ? "\n" + years : ""}`)}">едет ${num(p.openQty, 1)}</span>`;
  }
  return {
    ekmtr: item.ekmtr ? `<span class="mono">${esc(item.ekmtr)}</span>` : '<span class="dim">—</span>',
    stock: stockHtml, price: priceHtml, order: orderHtml, art: item.art,
    // в заявку кладём по коду ЕКМТР, а без кода — по артикулу прайса:
    // иначе позиция без кодификации в заявку вообще не попадёт
    cart: {
      code: item.ekmtr || item.art,
      name: item.nameRu || item.art,
      value: rate && item.priceCNY != null ? item.priceCNY * rate : null,
      source: "Каталог LinkOne",
    },
  };
}

function kbSection(title, n, bodyHtml, shown) {
  return `<section class="card" style="margin-bottom:12px">
    <h3>${esc(title)} <span class="count" style="margin-left:6px">${num(n)}</span></h3>
    ${bodyHtml}
    ${n > shown ? `<p class="hint" style="margin:6px 0 0">…ещё ${num(n - shown)}</p>` : ""}
  </section>`;
}

function renderKB(host) {
  const m = D.kb.meta;
  const classes = Object.entries(m.byClass).sort((a, b) => b[1] - a[1]);
  host.innerHTML = `
    <h1>База знаний</h1>
    <p class="sub">${num(m.docs)} документов из АТ-Майнинг (руководства, схемы, нормы ТО, чертежи CAD) — ${num(m.totalBytes / 1e9, 1)} ГБ. Каталоги в PDF (${m.skippedCatalogPdf}) сюда не входят — чертежи берутся из LinkOme, каталог остаётся только справочно там, где книги LinkOme нет (см. «Качество данных»).</p>
    ${callout("good", `Сами файлы (не только реестр) лежат в этой же ветке под <code>media/kb/</code> — ${num(m.totalBytes / 1e9, 1)} ГБ, открываются кликом «файл» и в строке таблицы, и в результатах поиска по содержимому, без интернета. При деплое на GitHub Pages эта папка не публикуется — только для скачанной локально копии ветки.`)}
    <div class="kbgrid" id="kbClasses"></div>

    <div class="card">
      <h3>Поиск по всему</h3>
      <p class="hint" id="kbSearchHint">Номер детали, наименование, узел, код ЕКМТР, борт, имя документа — и содержимое документов (индекс — первые ~60 тыс. знаков каждого, грузится при первом запросе). Номера сверяются без учёта точек и дефисов.</p>
      <input type="search" id="kbSearchQ" placeholder="K1601.30.02, пружина, 1001785, регламент, №02…" value="${esc(KB_SEARCH_QUERY)}"/>
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
  let searchRequest = 0;

  function kbRenderResults(q, box) {
    const request = ++searchRequest;
    const r = kbFindAll(q);
    const total = r.parts.length + r.linkome.length + r.nodes.length +
                  r.ekmtr.length + r.fleet.length + r.docs.length;
    const h = [`<p class="hint">Найдено: прайс ДП ${num(r.parts.length)} · LinkOne ${num(r.linkome.length)} · узлы ${num(r.nodes.length)} · ЕКМТР ${num(r.ekmtr.length)} · парк ${num(r.fleet.length)} · документы ${num(r.docs.length)}</p>`];

    if (r.parts.length) {
      h.push(kbSection("Детали прайса ДП", r.parts.length, `<div class="twrap"><table>
        <thead><tr><th>Артикул</th><th>Наименование</th><th>Модель</th><th>ЕКМТР</th><th>Цена, ¥</th></tr></thead>
        <tbody>${r.parts.slice(0, KB_LIMIT).map(i => `<tr class="mrow" data-art="${esc(i.art)}">
          <td class="mono">${kbMark(i.art, q)}</td><td class="wrap">${kbMark(i.nameRu || "", q)}</td>
          <td>${esc(i.model || "")}</td><td class="mono">${i.ekmtr ? esc(i.ekmtr) : '<span class="dim">—</span>'}</td>
          <td class="n">${i.priceCNY == null ? "" : cny(i.priceCNY)}</td></tr>`).join("")}</tbody>
        </table></div>`, KB_LIMIT));
    }
    if (r.linkome.length) {
      h.push(kbSection("Состав узлов LinkOne", r.linkome.length, `<div class="twrap"><table>
        <thead><tr><th>Номер</th><th>Наименование</th><th>Где встречается</th></tr></thead>
        <tbody>${r.linkome.slice(0, KB_LIMIT).map(([, rows]) => {
          const f = rows[0];
          return `<tr class="mrow" data-book="${esc(f.book)}" data-page="${esc(f.page)}">
            <td class="mono">${kbMark(f.raw, q)}</td><td class="wrap">${kbMark(f.name || "", q)}</td>
            <td class="wrap"><span class="badge info">${esc(f.book)}</span> ${esc(f.pageTitle || f.page)}${rows.length > 1 ? ` <span class="dim">+${rows.length - 1}</span>` : ""}</td></tr>`;
        }).join("")}</tbody></table></div>`, KB_LIMIT));
    }
    if (r.nodes.length) {
      h.push(kbSection("Узлы дерева", r.nodes.length, `<div class="twrap"><table>
        <thead><tr><th>Номер</th><th>Наименование</th><th>Механизм</th><th>Книга</th><th>Модель</th></tr></thead>
        <tbody>${r.nodes.slice(0, KB_LIMIT).map(n => `<tr>
          <td class="mono">${kbMark(n.num, q)}</td><td class="wrap">${kbMark(n.nameRu || "", q)}</td>
          <td class="wrap">${esc(n.mech || "")}</td><td>${esc(n.book || "")}</td><td>${esc(n.model || "")}</td></tr>`).join("")}</tbody>
        </table></div>`, KB_LIMIT));
    }
    if (r.ekmtr.length) {
      h.push(kbSection("Коды ЕКМТР", r.ekmtr.length, `<div class="twrap"><table>
        <thead><tr><th>Код</th><th>Наименование</th><th>Каталожный</th><th>Изготовитель</th></tr></thead>
        <tbody>${r.ekmtr.slice(0, KB_LIMIT).map(e => `<tr>
          <td class="mono">${kbMark(e.code, q)}</td><td class="wrap">${kbMark(e.name || "", q)}</td>
          <td class="mono">${esc(e.cat || "")}</td><td>${esc(e.mf || "")}</td></tr>`).join("")}</tbody>
        </table></div>`, KB_LIMIT));
    }
    if (r.fleet.length) {
      h.push(kbSection("Парк", r.fleet.length, `<div class="twrap"><table>
        <thead><tr><th>Борт</th><th>Площадка</th><th>Модель</th><th>Заводской №</th><th>Книга</th><th class="n">КТГ</th></tr></thead>
        <tbody>${r.fleet.slice(0, KB_LIMIT).map(u => `<tr>
          <td class="mono">${kbMark(u.garage || "", q)}</td>
          <td class="wrap">${esc(u.siteName || u.site || "")} <span class="dim">${esc(u.site || "")}</span></td>
          <td>${esc(u.model)}</td><td class="mono">${kbMark(u.serial || "", q)}</td>
          <td>${esc(u.book || "")}</td><td class="n">${u.ktg == null ? "" : pct(u.ktg)}</td></tr>`).join("")}</tbody>
        </table></div>`, KB_LIMIT));
    }
    if (r.docs.length) {
      h.push(kbSection("Документы (по имени и классу)", r.docs.length,
        r.docs.slice(0, KB_LIMIT).map(d => `<div style="padding:7px 0;border-bottom:1px solid var(--grid)">
          <div style="font-size:12.5px;font-weight:600">${kbMark(d.name, q)}
            <a href="${esc(kbFileUrl(d.path))}" target="_blank" rel="noopener" class="badge good" style="text-decoration:none">файл ↗</a></div>
          <div style="font-size:11px;color:var(--ink-3)">${esc(d.class)}${d.model ? " · " + esc(d.model) : ""}</div>
        </div>`).join(""), KB_LIMIT));
    }
    if (!total) h.push('<p class="hint">По номерам и наименованиям ничего не найдено.</p>');
    h.push('<div id="kbFullText"><p class="hint">Поиск по содержимому документов…</p></div>');
    box.innerHTML = h.join("");

    qsa("[data-art]", box).forEach(el => el.onclick = () => openDetail(el.dataset.art));
    qsa("[data-page]", box).forEach(el => el.onclick = () => {
      LO.book = el.dataset.book;
      LO.index = loBuildIndex(LO.book);
      LO.current = el.dataset.page;
      LO.filter = "";
      navigateTo("linkone");
    });

    // содержимое документов — отдельно и лениво: индекс на 10 МБ
    kbEnsureText().then(() => {
      if (request !== searchRequest) return;
      const ft = byId("kbFullText");
      if (!ft) return;
      if (!KB_TEXT) { ft.innerHTML = callout("bad", "Индекс содержимого недоступен."); return; }
      const ql = q.toLowerCase();
      const hits = [];
      for (const path in KB_TEXT.docs) {
        if (KB_TEXT.docs[path].text.toLowerCase().includes(ql)) hits.push(path);
      }
      ft.innerHTML = hits.length
        ? kbSection("Документы (по содержимому)", hits.length, hits.slice(0, KB_LIMIT).map(p => {
            const d = byPath.get(p);
            return `<div style="padding:9px 0;border-bottom:1px solid var(--grid)">
              <div style="font-size:12.5px;font-weight:600">${esc(d ? d.name : p)}
                <a href="${esc(kbFileUrl(p))}" target="_blank" rel="noopener" class="badge good" style="text-decoration:none">файл ↗</a></div>
              <div style="font-size:11px;color:var(--ink-3);margin:1px 0 4px">${esc(d ? d.class : "")}</div>
              <div style="font-size:12px;color:var(--ink-2);line-height:1.5">${kbSnippet(KB_TEXT.docs[p].text, q)}</div>
            </div>`;
          }).join(""), KB_LIMIT)
        : '<p class="hint">В содержимом документов совпадений нет.</p>';
    });
  }

  byId("kbSearchQ").oninput = e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    KB_SEARCH_QUERY = q;
    const box = byId("kbSearchResults");
    if (!q || q.length < 2) { box.innerHTML = q ? '<p class="hint">Минимум два символа.</p>' : ""; return; }
    box.innerHTML = '<p class="hint">Поиск…</p>';
    searchTimer = setTimeout(() => kbRenderResults(q, box), 220);
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
        { key: "path", label: "Файл", plain: v => kbFileUrl(v), fmt: (v) => `<a href="${esc(kbFileUrl(v))}" target="_blank" rel="noopener" class="badge good" style="text-decoration:none">файл ↗</a>` },
      ],
    });
  }
  qsa(".kbclass", host).forEach(el => el.onclick = () => {
    KB_FILTER.cls = KB_FILTER.cls === el.dataset.c ? "" : el.dataset.c;
    qsa(".kbclass", host).forEach(x => x.classList.toggle("on", x.dataset.c === KB_FILTER.cls));
    apply();
  });
  makeActivatable(host, ".kbclass");
  byId("kbQ").oninput = e => { KB_FILTER.q = e.target.value; apply(); };
  byId("kbModel").onchange = apply;
  apply();
  if (KB_SEARCH_QUERY.length >= 2) kbRenderResults(KB_SEARCH_QUERY, byId("kbSearchResults"));
}

/* ---------- навигация / поиск / тема ---------- */
const VALID_TABS = new Set(["sum", "catalog", "linkone", "kb", "fleet", "repairs", "provision", "stock", "purchase", "codif", "inter", "dq", "doc", "upd", "cart"]);
function navigateTo(tab, { updateHash = true, focusMain = true } = {}) {
  TAB = VALID_TABS.has(tab) ? tab : "sum";
  qsa("#tabs button").forEach(x => {
    const active = x.dataset.t === TAB;
    x.classList.toggle("on", active); x.setAttribute("aria-selected", active ? "true" : "false"); x.tabIndex = active ? 0 : -1;
  });
  if (updateHash && location.hash !== `#${TAB}`) history.pushState(null, "", `#${TAB}`);
  renderTab();
  if (focusMain) byId("main").focus({ preventScroll: true });
}

function initNav() {
  const fromHash = location.hash.slice(1);
  TAB = VALID_TABS.has(fromHash) ? fromHash : "sum";
  qsa("#tabs button").forEach(b => {
    b.onclick = () => navigateTo(b.dataset.t);
    b.onkeydown = e => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault(); const tabs = qsa("#tabs button"); let i = tabs.indexOf(b);
      i = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[i].focus();
    };
  });
  qsa("#tabs button").forEach(x => { const active = x.dataset.t === TAB; x.classList.toggle("on", active); x.setAttribute("aria-selected", active ? "true" : "false"); x.tabIndex = active ? 0 : -1; });
  let savedTheme = null; try { savedTheme = localStorage.getItem("wkcrm_theme"); } catch (e) { /* unavailable */ }
  if (savedTheme === "light" || savedTheme === "dark") document.documentElement.setAttribute("data-theme", savedTheme);
  const syncThemeButton = () => {
    const actual = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    byId("btnTheme").innerHTML = `<span aria-hidden="true">${actual === "light" ? "☀" : "☾"}</span>`;
  };
  syncThemeButton();
  byId("btnTheme").onclick = () => {
    const html = document.documentElement;
    const cur = html.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const next = cur === "light" ? "dark" : "light";
    html.setAttribute("data-theme", next);
    try { localStorage.setItem("wkcrm_theme", next); } catch (e) { /* unavailable */ }
    syncThemeButton();
  };
  byId("btnCart").onclick = () => navigateTo("cart");
  cartUpdateBadge();
  byId("globalSearch").oninput = debounce(e => {
    const q = e.target.value.trim();
    if (!q) return;
    KB_SEARCH_QUERY = q; navigateTo("kb");
  }, 250);
  window.addEventListener("hashchange", () => navigateTo(location.hash.slice(1), { updateHash: false }));
}

document.addEventListener("keydown", e => {
  const card = byId("modalCard");
  if (e.key === "Escape" && LO.fullscreen) {
    LO.fullscreen = false;
    document.body.classList.remove("lo-full-open");
    if (TAB === "linkone") loRenderMain();
    return;
  }
  if (e.key === "Escape") closeModal();
  if (e.key !== "Tab" || card.hidden) return;
  const focusable = qsa('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])', card).filter(el => !el.disabled);
  if (!focusable.length) return; const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

initNav();
boot();
