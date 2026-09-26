"use strict";
/* ============================================================
   WK CRM — единая логика портала.
   Данные — статичные json в data/, вся обработка в браузере.
   ============================================================ */

/* ---------- утилиты ---------- */
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ESC_MAP[c]);
/* toLocaleString с объектом опций каждый раз собирает форматтер заново.
   На таблице это тысячи вызовов и самая дорогая функция во всём портале
   по профилю V8. Кэшируем форматтер на число знаков — вывод тот же. */
const NUM_FMT = new Map();
const numFormatter = d => {
  let f = NUM_FMT.get(d);
  if (!f) {
    f = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });
    NUM_FMT.set(d, f);
  }
  return f;
};
const num = (v, d = 0) => v == null || isNaN(v) ? "—" : numFormatter(d).format(Number(v));
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
/* Витрины, пересобранные во вкладке «Обновление данных», лежат в хранилище
   браузера (lib/upd_store.js) и подменяют одноимённые data/*.local.js. */
let DATA_OVERRIDE = new Map(), DATA_OVERRIDE_INFO = null;
function loadScript(src) {
  const own = /^data\/(.+)\.local\.js$/.exec(src);
  if (own && DATA_OVERRIDE.has(own[1])) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src}: не удалось загрузить`));
    document.head.appendChild(s);
  });
}
function dataFor(key) {
  if (DATA_OVERRIDE.has(key)) return DATA_OVERRIDE.get(key);
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
let G = { site: "", model: "", unit: "", order: "", ekmtr: "", part: "", pg: "" };
let ROLE = "all";
let LK = { q: "", analogs: true };   // «Поиск по номеру» (lookup.js): запрос живёт в ссылке #lookup&q=…
let NAV_SEQ = 0;
let CART_MEM = null;
const ROLES = {
  all:     { label: "Все разделы", tabs: null },
  supply:  { label: "Снабжение",   tabs: ["sum", "analytics", "lookup", "provision", "stock", "purchase", "codif", "inter", "cart"] },
  toir:    { label: "ТОиР",        tabs: ["sum", "analytics", "control", "lookup", "fleet", "repairs", "provision", "linkone", "kb", "catalog"] },
  catalog: { label: "Справочник",  tabs: ["catalog", "lookup", "linkone", "kb", "inter", "fleet"] },
};
const TAB_NEEDS = {
  sum: [],
  analytics: ["control", "usoWk"],
  control: ["control", "orderText"],
  lookup: ["interchange", "control"],
  catalog: ["tree", "drawings"],
  // tree — не украшение: карточка узла читает D.tree.bookModel, чтобы
  // подобрать документы по модели. Без этой зависимости первый заход
  // сразу в LinkOne (без каталога) валился на undefined.
  linkone: ["linkome", "linkomeDraw", "kb", "tree"],
  kb: ["kb", "tree", "linkome"],
  fleet: ["wkNodes"],
  repairs: ["usoWk", "control", "orderText"],
  provision: ["interchange", "usoWk", "control"],
  stock: [],
  purchase: [],
  codif: ["tree"],
  inter: ["interchange"],
  dq: [],
  doc: [],
  upd: [],
  cart: [],
};
function parseHash(raw) {
  const text = String(raw == null ? "" : raw).replace(/^#/, "");
  const out = { tab: "sum", role: "all", q: "", g: { site: "", model: "", unit: "", order: "", ekmtr: "", part: "", pg: "" } };
  if (!text) return out;
  const parts = text.split("&").filter(Boolean);
  for (const part of parts) {
    if (!part.includes("=")) {
      if (VALID_TABS && VALID_TABS.has(part)) out.tab = part;
      else if (!VALID_TABS) out.tab = part;
      continue;
    }
    const eq = part.indexOf("=");
    const k = part.slice(0, eq);
    const v = decodeURIComponent(part.slice(eq + 1) || "");
    if (k === "role" && ROLES[v]) out.role = v;
    else if (k === "tab" && (!VALID_TABS || VALID_TABS.has(v))) out.tab = v;
    else if (k === "q") out.q = v;
    else if (k in out.g) out.g[k] = v;
  }
  return out;
}
function serializeHash(tab, role, g, q) {
  const parts = [tab || "sum"];
  if (tab === "lookup" && q) parts.push("q=" + encodeURIComponent(q));
  if (role && role !== "all") parts.push("role=" + encodeURIComponent(role));
  for (const k of ["site", "model", "unit", "order", "ekmtr", "part", "pg"]) {
    if (g && g[k]) parts.push(k + "=" + encodeURIComponent(g[k]));
  }
  return "#" + parts.join("&");
}
function writeHash(push) {
  const next = serializeHash(TAB, ROLE, G, typeof LK !== "undefined" ? LK.q : "");
  if (location.hash === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}
function tabAllowed(tab, role) {
  const spec = ROLES[role || ROLE] || ROLES.all;
  return !spec.tabs || spec.tabs.includes(tab);
}
function applyRoleChrome() {
  qsa("#tabs button").forEach(b => {
    const on = tabAllowed(b.dataset.t);
    b.hidden = !on;
    b.style.display = on ? "" : "none";
  });
  const roleSel = byId("roleSelect");
  if (roleSel && roleSel.value !== ROLE) roleSel.value = ROLE;
}
function siteNameOf(code) {
  if (!code || !D.fleet) return "";
  const u = D.fleet.units.find(x => x.site === code);
  return (u && (u.siteName || u.site)) || code;
}
/* Склад в stock.json — ключ «завод/код»; справочник с площадкой (по заводу
   строки выгрузки) — D.stock.meta.warehouses. Эвристика по имени ниже —
   только для старых данных без справочника. */
function stockWarehouse(key) {
  return ((D.stock && D.stock.meta && D.stock.meta.warehouses) || {})[key] || null;
}
function warehouseSite(name) {
  const wh = stockWarehouse(name);
  if (wh) {
    const siteLabel = wh.siteName || siteNameOf(wh.site) || "площадка не определена";
    const label = wh.kind === "consign" ? `консигнация · ${siteLabel}` : wh.kind === "transit" ? `перевалочная база · ${siteLabel}` : siteLabel;
    return { site: wh.site, kind: wh.kind, label, name: `${wh.name} · ${wh.plant}`, plant: wh.plant, plantName: wh.plantName };
  }
  const raw = String(name || "").trim();
  const w = raw.toLowerCase();
  if (/консигнац/.test(w)) return { site: "", kind: "consign", label: "консигнация" };
  const plant = (raw.match(/^710\d/) || [])[0];
  const PLANTS = { "7101": ["1100", "Развитие Красноярск"], "7102": ["2400", "Развитие Иркутск"], "7103": ["1300", "Развитие Алдан"], "7104": ["1400", "Развитие Магадан"] };
  if (plant && PLANTS[plant]) return { site: PLANTS[plant][0], kind: "contractor", label: PLANTS[plant][1] + " (подрядчик)" };
  if (/^1400\b|магадан|янтарь/.test(w)) return { site: "1400", kind: "site", label: "Магадан" };
  if (/^2400\b|сухой\s*лог/.test(w)) return { site: "2400", kind: "site", label: "Сухой Лог" };
  if (/^1200\b|вернин/.test(w)) return { site: "2400", kind: "site", label: "Сухой Лог (Вернинское)" };
  if (/^1300\b|алдан/.test(w)) return { site: "1300", kind: "site", label: "Алдан" };
  if (/^1100\b|еруда|благодат|ожок|бгок|карьер|восточн|вост\.?\s*техн|бывш/.test(w))
    return { site: "1100", kind: "site", label: "Красноярск / Еруда" };
  if (/ат\s*майнинг/.test(w)) return { site: "", kind: "vendor", label: "поставщик" };
  return { site: "", kind: "unknown", label: "площадка не подписана" };
}
function warehouseBreakdown(byWh) {
  return Object.entries(byWh || {}).map(([key, qty]) => {
    const meta = warehouseSite(key);
    return { key, name: meta.name || key, qty: Number(qty) || 0, site: meta.site, kind: meta.kind, label: meta.label, plantName: meta.plantName || "" };
  }).sort((a, b) => b.qty - a.qty);
}
/* Показатель позиции в контексте площадки: при выбранной площадке — только
   её склады (item.bySite), иначе — по всем площадкам. */
function stockSiteVal(item, key, site = G.site) {
  if (!item) return 0;
  if (!site || !item.bySite) return item[key] || 0;
  const o = item.bySite[site];
  return o ? (o[key] || 0) : 0;
}
function stockAtSite(item, site, siteName) {
  const byWh = (item && item.byWarehouse) || {};
  const total = item ? (item.availQty != null ? item.availQty : item.qty) : 0;
  const rows = warehouseBreakdown(byWh);
  if (!site) return { siteQty: null, total, matched: false, warehouses: rows.map(r => r.name), rows };
  if (item && item.bySite) {
    const siteQty = stockSiteVal(item, "availQty", site);
    const hit = rows.filter(r => r.site === site);
    return { siteQty, total, matched: hit.length > 0, warehouses: hit.map(r => r.name), rows, others: rows.filter(r => r.site !== site) };
  }
  const needle = String(siteName || "").toLowerCase();
  const hit = rows.filter(r => r.site === site || (needle && r.name.toLowerCase().includes(needle)) || r.name.includes(site));
  const siteQty = hit.reduce((s, r) => s + r.qty, 0);
  return { siteQty, total, matched: hit.length > 0, warehouses: hit.map(r => r.name), rows, others: rows.filter(r => !hit.includes(r)) };
}
function purchaseAgainstDate(purchase, needDate) {
  const empty = { status: "none", label: "не заказано", onTime: 0, late: 0, undated: 0, months: [], supplier: "", transit: 0, openQty: 0 };
  if (!purchase || !(purchase.openQty > 0)) return empty;
  const needMonth = (needDate || "").slice(0, 7);
  let onTime = 0, late = 0, undated = 0;
  const months = Object.entries(purchase.byMonth || {}).sort().map(([month, qty]) => {
    const q = Number(qty) || 0;
    let kind = "undated";
    if (!month) { undated += q; kind = "undated"; }
    else if (!needMonth || month <= needMonth) { onTime += q; kind = "onTime"; }
    else { late += q; kind = "late"; }
    return { month, qty: q, kind };
  });
  let status = "onTime", label = "к сроку";
  const firstLate = (months.find(x => x.kind === "late") || {}).month || "";
  if (!months.length) { status = "none"; label = "не заказано"; }
  else if (onTime <= 0 && late <= 0) { status = "undated"; label = "в закупке, срок не проставлен"; }
  else if (onTime <= 0 && late > 0) { status = "late"; label = "приход " + firstLate + (needMonth ? " после начала " + needMonth : ""); }
  else if (late > 0) { status = "mixed"; label = "часть к сроку, часть с " + firstLate; }
  else { status = "onTime"; label = months.filter(x => x.month).map(x => x.month + ": " + x.qty).join(", "); }
  return {
    status, label, onTime, late, undated, months,
    supplier: purchase.topSupplier || "", transit: purchase.transitQty || 0, openQty: purchase.openQty || 0,
  };
}
function codeLink(code) {
  if (code == null || code === "") return "";
  const v = String(code);
  return `<button type="button" class="pn-link mono" data-code="${esc(v)}">${esc(v)}</button>`;
}
function orderTodayItems(items) {
  return (items || [])
    .filter(i => i && (i.verdict === "inTime" || (i.canOrder || 0) > 0))
    .slice()
    .sort((a, b) => (b.canOrder || b.gapValue || 0) - (a.canOrder || a.gapValue || 0))
    .slice(0, 15);
}
function issueText(issue) {
  if (Array.isArray(issue)) return issue.filter(Boolean).join(" ");
  return issue == null ? "" : String(issue);
}
function directSubs(art) {
  const key = interKey(art);
  const group = INTER_GROUP_OF.get(key);
  if (!group) return [];
  return group.filter(p => interKey(p) !== key);
}

function globalUnits() {
  return D.fleet ? D.fleet.units.filter(u => (!G.site || u.site === G.site) && (!G.model || u.model === G.model)) : [];
}
function renderGlobalFilters() {
  const host = byId("globalFilters");
  if (!host || !D.fleet) return;
  const sites = [...new Map(D.fleet.units.map(u => [u.site, u.siteName || u.site]))].sort((a,b) => a[1].localeCompare(b[1], "ru"));
  const models = [...new Set(D.fleet.units.filter(u => !G.site || u.site === G.site).map(u => u.model).filter(Boolean))].sort();
  if (G.model && !models.includes(G.model)) G.model = "";
  const units = globalUnits();
  if (G.unit && !units.some(u => u.name === G.unit)) G.unit = "";
  host.innerHTML = `<div class="gf-title"><b>Контекст отчёта</b><span>применяется ко всем доступным разрезам</span></div>
    <label>Площадка<select id="gfSite"><option value="">Все</option>${sites.map(([v,l])=>`<option value="${esc(v)}"${G.site===v?' selected':''}>${esc(l)} · ${esc(v)}</option>`).join('')}</select></label>
    <label>Модель<select id="gfModel"><option value="">Все</option>${models.map(v=>`<option${G.model===v?' selected':''}>${esc(v)}</option>`).join('')}</select></label>
    <label>Машина<select id="gfUnit"><option value="">Все</option>${units.map(u=>`<option value="${esc(u.name)}"${G.unit===u.name?' selected':''}>${esc(u.name)}</option>`).join('')}</select></label>
    <label>Заказ<input id="gfOrder" value="${esc(G.order)}" placeholder="номер"/></label>
    <label>ЕКМТР<input id="gfEkmtr" value="${esc(G.ekmtr)}" placeholder="код"/></label>
    <label>Каталожный №<input id="gfPart" value="${esc(G.part)}" placeholder="K…"/></label>
    <label title="Группа планирования ТОРО заказа (PM-06, с 2024 года). «Развитие» — 100 Механика и 200 Энергетика; 300–900 — службы БЕ (заказчика)">Группа планирования<select id="gfPg">${pgFilterOptions().map(([v, l]) => `<option value="${esc(v)}"${G.pg === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
    <button class="minibtn" id="gfReset" type="button">Сбросить</button>`;
  const apply = (k,v) => { G[k]=v; if(k==='site'||k==='model') G.unit=''; writeHash(false); renderGlobalFilters(); renderTab(); };
  byId('gfSite').onchange=e=>apply('site',e.target.value);
  byId('gfModel').onchange=e=>apply('model',e.target.value);
  byId('gfUnit').onchange=e=>apply('unit',e.target.value);
  byId('gfPg').onchange=e=>apply('pg',e.target.value);
  for (const [id,k] of [['gfOrder','order'],['gfEkmtr','ekmtr'],['gfPart','part']]) byId(id).oninput=debounce(e=>{G[k]=e.target.value.trim();writeHash(false);renderTab()},180);
  byId('gfReset').onclick=()=>{G={site:'',model:'',unit:'',order:'',ekmtr:'',part:'',pg:''};writeHash(false);renderGlobalFilters();renderTab()};
}

/* фильтр «Группа планирования»: группы — из витрины control (если загружена), иначе справочник SAP */
function pgFilterOptions() {
  const names = (typeof AnalyticsCore !== "undefined" && AnalyticsCore.PG_NAMES) || {};
  const seen = new Set(Object.keys(((D.control || {}).meta || {}).planningGroups || {}).map(k => k.split("/").pop()));
  const groups = (seen.size ? [...seen] : Object.keys(names)).sort((a, b) => (a === "#") - (b === "#") || a.localeCompare(b));
  return [["", "Все"], ["dev", "Развитие (100, 200)"], ["be", "Службы БЕ (300–900)"],
    ...groups.map(g => [g, g === "#" ? "не присвоена" : `${g} ${names[g] || ""}`.trim()])];
}
function pgFilterLabel(v) { return (pgFilterOptions().find(o => o[0] === v) || [v, v])[1]; }
/* проходит ли заказ фильтр группы планирования (заказы без группы — 2022–2023 — не проходят) */
function pgPass(order) {
  return !G.pg || (typeof AnalyticsCore !== "undefined" && AnalyticsCore.pgMatch(AnalyticsCore.pgOfOrder(order), G.pg));
}

/* ---------- generic sortable table ---------- */
/* Typed links: identifiers are routed by meaning, never guessed from digits. */
function entityLink(type, value, row = {}) {
  if (value == null || value === "") return '<span class="dim">—</span>';
  return `<button type="button" class="pn-link mono" data-entity="${esc(type)}" data-id="${esc(value)}" data-site="${esc(row.site || "")}" data-unit="${esc(row.unit || "")}">${esc(value)}</button>`;
}
/* Константы вынесены из entityCell: функция вызывается на КАЖДУЮ ячейку
   (на «Обеспеченности» это ~6 000 вызовов за перерисовку), и создавать
   в ней шесть регулярных выражений и три массива заново — чистая
   потеря. Поведение не меняется. */
const EC_INTERACTIVE = /<(button|a|input|select)\b/i;
const EC_HAS_TAG = /<[^>]+>/;
const EC_STOCK_LABEL = /остаток|склад|налич/i;
const EC_QTY_KEYS = new Set(["qty", "availQty", "restrictedQty", "fromStock", "openQty", "fromBuy"]);
const EC_PURCHASE_KEYS = new Set(["openQty", "fromBuy"]);
const EC_STOCK_KEYS = new Set(["qty", "fromStock"]);
const EC_LABELS = {
  code: /^(код|код екмтр|екмтр)$/i, ekmtr: /екмтр/i,
  art: /^(артикул|каталожный.*|номер)$/i, order: /^(заказ|заказ торо)$/i,
  document: /документ закупки/i, request: /заявка/i,
};
const EC_TYPES = { code: "material", ekmtr: "material", art: "part",
  order: "toro", document: "document", request: "request" };

function entityCell(col, row, fallback) {
  if (!col.label || EC_INTERACTIVE.test(fallback)) return fallback;
  if (row.code && EC_QTY_KEYS.has(col.key)) {
    const section = EC_PURCHASE_KEYS.has(col.key) ? "purchase" : "stock";
    if (EC_STOCK_KEYS.has(col.key) && !EC_STOCK_LABEL.test(col.label)) return fallback;
    if (!EC_HAS_TAG.test(fallback)) return entityLink(section,row.code).replace(">" + esc(row.code) + "</button>", ">" + fallback + "</button>");
  }
  if (col.numeric) return fallback;
  if (!EC_LABELS[col.key]?.test(col.label.trim())) return fallback;
  const type = EC_TYPES[col.key];
  return row[col.key] == null || row[col.key] === "" ? fallback : entityLink(type, row[col.key], row);
}
let CARD_TRAIL = [], CARD_REPLAY = false, CARD_SEQ = 0;
function beginEntityCard(type, args) {
  const card = byId("modalCard"), wasClosed = card.hidden;
  card.classList?.remove("wide");
  if (wasClosed) { CARD_TRAIL = []; MODAL_RETURN_FOCUS = document.activeElement; }
  const next = {type, args};
  if (!CARD_REPLAY && JSON.stringify(CARD_TRAIL.at(-1)) !== JSON.stringify(next)) CARD_TRAIL.push(next);
  CARD_SEQ++;
  card.hidden = false; byId("modalBack").hidden = false;
  byId("modalBack").onclick = closeModal;
  document.body.classList.add("modal-open");
}
function finishEntityCard(code) {
  const card = byId("modalCard");
  const bar = document.createElement("div");
  bar.className = "entity-card-nav";
  bar.innerHTML = (CARD_TRAIL.length > 1 ? '<button class="minibtn" data-card-back>← Назад</button>' : "") +
    (code ? `<button class="minibtn" data-card-section="stock">Наличие</button><button class="minibtn" data-card-section="purchase">Закупки</button><button class="minibtn" data-card-section="toro">Заказы ТОРО</button>` : "");
  card.insertBefore(bar, card.querySelector("h2")?.nextSibling || card.firstChild);
  bar.querySelector("[data-card-back]")?.addEventListener("click", () => {
    CARD_TRAIL.pop(); const prev = CARD_TRAIL.at(-1); if (!prev) return;
    CARD_REPLAY = true;
    try { routeEntity(prev.type, ...prev.args); } finally { CARD_REPLAY = false; }
  });
  card.querySelectorAll?.("[data-lookup]").forEach(b => b.onclick = () => { if (typeof openLookup === "function") openLookup(b.dataset.lookup); });
  bar.querySelectorAll("[data-card-section]").forEach(b => b.onclick = () => {
    if (CARD_TRAIL.at(-1)?.type !== "material") openCodeDetail(code);
    const target = byId("modalCard").querySelector('[data-section="' + b.dataset.cardSection + '"]');
    target?.scrollIntoView({block:"start", behavior:"smooth"});
  });
}
function routeEntity(type, id, hint = {}) {
  if (type === "stock" || type === "purchase") {
    openCodeDetail(id);
    byId("modalCard").querySelector('[data-section="' + type + '"]')?.scrollIntoView({block:"start"});
    return;
  }
  if (type === "material") return openCodeDetail(id);
  if (type === "part") return openPartCard(id);
  if (type === "toro") return openToroCard(id, hint);
  if (type === "document" || type === "request") return openPurchaseDocument(type, id, hint.code || "");
}
function openPartCard(part) {
  // Exact match only; punctuation can distinguish different spare parts.
  const item = CATALOG_BY_ART.get(String(part)) || (D.catalog.items || []).find(i => interKey(i.art) === interKey(part));
  if (item) return openDetail(item.art);
  beginEntityCard("part", [part]);
  const refs = (D.ekmtrWk?.items || []).filter(i => interKey(i.cat) === interKey(part));
  const card = byId("modalCard");
  card.innerHTML = `<button class="mclose" id="mCloseBtn" aria-label="Закрыть карточку">✕</button><h2 id="modalTitle">Каталожный № ${esc(part)}</h2>
  <p class="hint">Номер отсутствует в прайсе. Наличие и закупка доступны только при подтверждённой связи с ЕКМТР.</p>
  <p><button class="minibtn" type="button" data-lookup="${esc(part)}">История, цены и статус наличия →</button></p>
  ${refs.map(i => `<p>${codeLink(i.code)} · ${esc(i.name)}</p>`).join("") || '<p class="hint">Точная связь с ЕКМТР не найдена.</p>'}`;
  byId("mCloseBtn").onclick = closeModal; finishEntityCard(); byId("mCloseBtn").focus();
}
/* ---------- карточка заказа ТОРО ---------- */
function toroControlRows(number, hint = {}) {
  if (!D.control) return [];
  if (!D.controlRows || D.controlRowsOf !== D.control) {
    D.controlRows = AnalyticsCore.decodeControl(D.control); D.controlRowsOf = D.control;
  }
  return D.controlRows.filter(r => String(r.order) === String(number) && (!hint.unit || r.unit === hint.unit));
}
// виды работ заказа: один — выносится в шапку, несколько — строки группируются
function toroWorks(list) {
  const m = new Map();
  list.filter(w => w && w !== "Не присвоено" && w !== "#").forEach(w => m.set(w, (m.get(w) || 0) + 1));
  return [...m.keys()];
}
const TORO_STAGE = Object.fromEntries((typeof AnalyticsCore !== "undefined" ? AnalyticsCore.STAGES : []));
function toroHeader(number, orders, historical, uso, ctl, works) {
  const text = D.orderText && D.orderText.text && D.orderText.text[number];
  const o = orders[0] || {}, h = historical[0] || {}, u = uso[0] || {}, c = ctl[ctl.length - 1] || {};
  const unit = o.unit || c.unit || h.unit || u.unit || "", site = o.site || c.site || h.site || u.site || "";
  const start = c.start || o.date || h.start, end = c.end || h.end;
  const chip = (label, value, cls = "") => value ? `<span class="toro-chip ${cls}"><i>${esc(label)}</i> ${value}</span>` : "";
  const plan = ctl.reduce((s, r) => s + r.planCounted, 0), fact = ctl.reduce((s, r) => s + r.fact, 0);
  const val = orders.reduce((s, x) => s + (x.value || 0), 0), cov = orders.reduce((s, x) => s + (x.fromStock || 0) + (x.fromBuy || 0), 0);
  const unc = orders.reduce((s, x) => s + (x.late || 0) + (x.undated || 0) + (x.gap || 0), 0);
  const pot = orders.reduce((s, x) => s + (x.transferPotential || 0), 0);
  return `<h2 id="modalTitle">Заказ ТОРО <span class="mono">${esc(number)}</span></h2>
    <div class="toro-title">${text ? esc(text) : '<span class="dim">текст заказа не выгружен</span>'}</div>
    <div class="toro-sub">${esc(unit)}${site ? " · " + esc(siteNameOf(site) || site) : ""}</div>
    <div class="toro-chips">
      ${chip("Вид работ", works.length ? works.map(esc).join(", ") : "", "strong")}
      ${chip("Вид заказа", c.kind ? `${esc(c.kind)}${c.kindText ? " · " + esc(c.kindText) : ""}` : "")}
      ${chip("Стадия", c.stage ? esc(TORO_STAGE[c.stage] || c.stage) : o.closed ? "Закрыт фактом" : o.stage ? esc(TORO_STAGE[o.stage] || o.stage) : "")}
      ${chip("Сроки", start ? `${dmy(start)}${end && end !== start ? " – " + dmy(end) : ""}` : "")}
      ${chip("Статья", o.kind ? esc(o.kind) : "")}${chip("Способ", o.method ? esc(o.method) : u.method ? esc(u.method) : "")}
      ${chip("Год", [...new Set(ctl.map(r => r.y))].join(", "))}
      ${(() => { const nd = D.wkNodes && D.wkNodes.orders && D.wkNodes.orders[number]; return nd ? chip("ЕО-узел", `${esc(nd[2])} · ЕО ${esc(nd[3])} · ТМ <span class="mono">${esc(nd[1])}</span>`, "warn") : ""; })()}
    </div>
    <div class="kpis toro-kpis">
      ${ctl.length ? kpi("План МТР + УСО", mrub(plan)) + kpi("Факт", mrub(fact) + (plan ? ` <small>${pct(fact / plan)}</small>` : ""), fact > plan * 1.1 && plan ? "warn" : "") : ""}
      ${val > 0 ? kpi("Потребность", mrub(val)) + kpi("Обеспечено к сроку", val ? pct(cov / val) : "—", !val ? "" : cov / val >= .9 ? "good" : cov / val >= .7 ? "warn" : "bad")
        + kpi("Не покрыто", mrub(unc), unc > 0 ? "bad" : "good") + (pot > 0 ? kpi("Можно переместить*", mrub(pot)) : "") : ""}
    </div>`;
}
function toroCovBadge(l) {
  const need = l.qty || 0;
  if (need <= 0) return (l.factQty || 0) > 0 ? '<span class="badge good">закрыт фактом</span>' : '<span class="dim">—</span>';
  const c = ((l.fromStock || 0) + (l.fromBuy || 0)) / need;
  return `<span class="badge ${c >= 0.999 ? "good" : c > 0 ? "warn" : "bad"}">${pct(c)}</span>`;
}
// количество: целое — без дробной части («10», а не «10,000»), дробное — до тысячных
function toroN(v) { v = Number(v) || 0; return Number.isInteger(v) ? num(v, 0) : num(v, 3).replace(/,?0+$/, ""); }
function toroQty(v, cls = "") { return v ? `<span class="${cls}">${toroN(v)}</span>` : '<span class="dim">·</span>'; }
function toroGrouped(lines, works, cols, rowHtml) {
  const groups = works.length > 1 ? works.map(w => [w, lines.filter(l => l.work === w)]).concat([["Без вида работ", lines.filter(l => !works.includes(l.work))]]) : [[null, lines]];
  return groups.filter(([, a]) => a.length).map(([w, a]) =>
    (w ? `<tr class="toro-grp"><td colspan="${cols}">${esc(w)} · ${a.length} поз.</td></tr>` : "") + a.map(rowHtml).join("")).join("");
}
function toroProvisionBlock(o, works) {
  const lines = o.lines || [];
  const head = `<h3>Материалы: обеспеченность по позициям, шт.</h3>
    <p class="hint">Дата работ ${o.date ? dmy(o.date) : "не указана"} · ${o.closed ? "закрыт фактом" : "открыт"}. Нужно = план − факт; склад — только своей площадки; перемещение* ограничено и в обеспеченность не входит.</p>`;
  const row = l => {
    const from = Object.entries(l.transferFrom || {}).filter(([, q]) => q > 0).map(([st, q]) => `${num(q, 1)} из ${esc((siteNameOf(st) || st).split(" ")[0])}`).join(", ");
    return `<tr><td>${codeLink(l.code)}</td><td class="toro-name">${esc(l.name)}</td>
      <td class="n">${toroN(l.planQty)}</td><td class="n">${toroQty(l.factQty)}</td><td class="n"><b>${toroQty(l.qty)}</b></td>
      <td class="n">${toroQty(l.fromStock, "q-own")}</td><td class="n">${toroQty(l.fromBuy, "q-buy")}</td>
      <td class="n">${toroQty(l.late, "q-late")}</td><td class="n">${toroQty(l.undated, "q-late")}</td><td class="n">${toroQty(l.gap, "q-gap")}</td>
      <td class="n" title="${esc(from)}">${l.transferPotential ? `${toroN(l.transferPotential)}<div class="sup-sub">${from}</div>` : '<span class="dim">·</span>'}</td>
      <td class="n">${toroCovBadge(l)}</td></tr>`;
  };
  return head + `<div class="twrap"><table class="toro-lines"><thead><tr><th>ЕКМТР</th><th>Материал</th><th class="n">План</th><th class="n">Факт</th><th class="n">Нужно</th>
    <th class="n" title="Склад своей площадки">Склад</th><th class="n" title="Закупка приходит к сроку работ">Закупка к сроку</th>
    <th class="n" title="Закупка приходит позже срока работ">Опоздание</th><th class="n" title="Открытая закупка без даты поставки">Без срока</th>
    <th class="n">Не покрыто</th><th class="n" title="Есть на другой площадке сверх её потребности — ограниченная возможность">Можно перем.*</th><th class="n">Обеспечено</th></tr></thead>
    <tbody>${toroGrouped(lines, works, 12, row)}</tbody></table></div>`;
}
/* статус позиции заказа по количеству: в плане / частично / закрыта (факт ≥ план) / вне плана */
function lineStatus(qp, qf) {
  qp = +qp || 0; qf = +qf || 0;
  if (qp > 0 && qf >= qp - 1e-9) return ["закрыта", "good"];
  if (qp > 0 && qf > 0) return ["частично", "warn"];
  if (qp > 0) return ["в плане", "info"];
  if (qf > 0) return ["вне плана", "warn"];
  return ["—", ""];
}
function lineStatusBadge(qp, qf) { const [l, c] = lineStatus(qp, qf); return c ? `<span class="badge ${c}">${l}</span>` : '<span class="dim">—</span>'; }
/* МТР подрядчика (УСО). Реестр МТР УСО — состав: какие материалы идут от подрядчика, сколько, по какой цене и
   на какую сумму (план). Его «Стоимость факт» — плановая цена в валюте по курсу, не факт, и в отчёте не используется.
   Статус — стадия заказа ТОРО (не закрыт заказ — не закрыто и УСО), факт — строка PM-06 «ТОиР. Материалы подрядчика». */
function usoStatusOf(o) {
  return typeof AnalyticsCore !== "undefined" && AnalyticsCore.usoStatus ? AnalyticsCore.usoStatus(o)
    : { stage: "", closed: false, plan: o.planValue || 0, open: o.planValue || 0, sapPlan: 0, sapFact: 0 };
}
function usoStageBadge(u) {
  if (!u.stage) return '<span class="badge warn">нет статуса ТОРО</span>';
  return `<span class="badge ${u.closed ? "good" : "info"}">${esc(TORO_STAGE[u.stage] || u.stage)}</span>`;
}
function usoLinesHtml(usoOrders) {
  const um = (D.usoWk && D.usoWk.meta) || {};
  return (usoOrders || []).map(o => {
    const u = usoStatusOf(o), L = (o.lines || []).slice().sort((a, b) => (b.p || 0) - (a.p || 0));
    const qty = L.reduce((x, l) => x + (l.qp || 0), 0), diff = u.sapPlan ? u.sapPlan - u.plan : 0;
    return `<h3>МТР подрядчика (УСО) · ${num(L.length)} поз. на ${mrub(u.plan)}</h3>
      <div class="kpis toro-kpis">${kpi("Материалы подрядчика (состав)", mrub(u.plan))}${kpi("План в заказе SAP", u.sapPlan ? mrub(u.sapPlan) : "—")}
        ${kpi("Факт в заказе SAP", mrub(u.sapFact), u.closed || u.sapFact > 0 ? "good" : "")}${kpi("Статус (заказ ТОРО)", u.stage ? esc(TORO_STAGE[u.stage] || u.stage) : "—", u.closed ? "good" : "")}</div>
      <p class="hint">Какие материалы идут от подрядчика, сколько, по какой цене и на какую сумму — реестр МТР УСО на ${dmy(um.asOf)}${o.year ? `, ${esc(o.year)} год` : ""}${o.method ? ` · ${esc(o.method)}` : ""}.
        Цена и сумма — плановые, в рублях (в SAP на вкладке «МТР подрядчика» — в валюте плана). Статус — по заказу ТОРО: ${u.closed ? "заказ закрыт — МТР подрядчика закрыты" : "заказ не закрыт — МТР подрядчика не закрыты"}${u.sapFact ? `, факт в заказе ${rub(u.sapFact)}` : ", факта в заказе нет"}.${Math.abs(diff) > 1 ? ` План в заказе SAP отличается от суммы состава на ${rub(diff)}.` : ""}</p>
      <div class="twrap"><table class="toro-lines"><thead><tr><th>ЕКМТР</th><th>Материал</th><th class="n">Кол-во</th><th class="n">Цена, ₽</th><th class="n">Сумма, ₽</th></tr></thead><tbody>
      ${L.map(l => `<tr><td>${l.code ? codeLink(l.code) : '<span class="dim">без кода</span>'}</td><td class="toro-name">${esc(l.name)}</td><td class="n">${toroN(l.qp)}</td><td class="n">${rub(l.price != null ? l.price : (l.qp ? l.p / l.qp : 0))}</td><td class="n">${rub(l.p)}</td></tr>`).join("")}
      <tr class="toro-grp"><td colspan="2">Итого · ${usoStageBadge(u)}</td><td class="n">${toroN(qty)}</td><td></td><td class="n">${rub(u.plan)}</td></tr></tbody></table></div>`;
  }).join("");
}
function toroPlainTable(lines, works) {
  const money = v => (v ? rub(v) : '<span class="dim">·</span>');
  const row = l => `<tr><td>${l.code ? codeLink(l.code) : '<span class="dim">—</span>'}</td><td class="toro-name">${esc(l.name)}</td><td class="n">${toroN(l.planQty ?? l.qp)}</td><td class="n">${toroN(l.factQty ?? l.qf)}</td>
    <td class="n">${money(l.p)}</td><td class="n">${money(l.a)}</td><td class="n">${money(l.up)}</td><td class="n">${money(l.uf)}</td><td>${(l.up || l.uf) && !(l.qp || l.qf) ? '<span class="badge">УСО</span>' : lineStatusBadge(l.planQty ?? l.qp, l.factQty ?? l.qf)}</td></tr>`;
  return `<div class="twrap"><table class="toro-lines"><thead><tr><th>ЕКМТР</th><th>Материал</th><th class="n">План, шт</th><th class="n">Факт, шт</th><th class="n">План МТР</th><th class="n">Факт МТР</th><th class="n" title="МТР подрядчика">План УСО</th><th class="n" title="МТР подрядчика">Факт УСО</th><th>Статус</th></tr></thead>
    <tbody>${toroGrouped(lines, works, 9, row)}</tbody></table></div>`;
}
async function openToroCard(number, hint = {}) {
  beginEntityCard("toro", [number, hint]);
  const seq = CARD_SEQ, card = byId("modalCard");
  card.classList.add("wide");
  card.innerHTML = '<button class="mclose" id="mCloseBtn" aria-label="Закрыть карточку">✕</button><h2 id="modalTitle">Заказ ТОРО ' + esc(number) + '</h2><p>Загрузка состава заказа…</p>';
  byId("mCloseBtn").onclick = closeModal;
  try {
    await ensureData(["provision", "usoWk", "control"]);
    try { await ensureData(["orderText"]); } catch (e) { D.orderText = null; }   // тексты заказов — необязательная витрина
    try { await ensureData(["wkNodes"]); } catch (e) { D.wkNodes = null; }       // заказ на ЕО-узле техместа машины
    let orders = [...(D.provision.orders || []), ...(D.provision.closedOrders || [])].filter(o =>
      String(o.order) === String(number) && (!hint.site || o.site === hint.site) && (!hint.unit || o.unit === hint.unit));
    let historical = [];
    if (!orders.length) {
      if (!S) {
        if (!SP) SP = loadScript("data/schedule_manifest.local.js").then(async () => {
          const m = dataFor("schedule_manifest");
          await Promise.all(m.shards.map(n => loadScript("data/" + n + ".local.js")));
          return {meta:m.meta, rows:m.shards.flatMap(n => sDecode(dataFor(n)))};
        });
        S = await SP;
      }
      historical = S.rows.filter(r => String(r.order) === String(number) && (!hint.site || r.site === hint.site) && (!hint.unit || r.unit === hint.unit));
    }
    if (seq !== CARD_SEQ || card.hidden) return;
    const uso = (D.usoWk?.orders || []).filter(o => String(o.order) === String(number) && (!hint.site || o.site === hint.site) && (!hint.unit || o.unit === hint.unit));
    const ctl = toroControlRows(number, hint);
    const allLines = [...orders.flatMap(o => o.lines || []), ...historical, ...uso.flatMap(o => o.lines || [])];
    const works = toroWorks([...allLines.map(l => l.work), ...uso.map(o => o.work), ...ctl.map(r => r.work)]);
    card.innerHTML = `<button class="mclose" id="mCloseBtn" aria-label="Закрыть карточку">✕</button>
      ${toroHeader(number, orders, historical, uso, ctl, works)}
      ${orders.map(o => toroProvisionBlock(o, works)).join("")}
      ${historical.length ? '<h3>История ТОРО</h3><p class="hint">Начало: ' + [...new Set(historical.map(r => r.start).filter(Boolean))].map(dmy).join(", ") + '</p>' + toroPlainTable(historical, works) : ""}
      ${usoLinesHtml(uso)}
      ${!orders.length && !historical.length && !uso.length ? '<p class="hint">Заказ не найден в загруженных данных.</p>' : ""}`;
    byId("mCloseBtn").onclick = closeModal; finishEntityCard(); byId("mCloseBtn").focus();
  } catch (e) {
    if (seq !== CARD_SEQ || card.hidden) return;
    card.insertAdjacentHTML("beforeend", callout("bad", "Не удалось загрузить заказ: " + esc(e.message)));
    finishEntityCard();
  }
}
function initEntityLinks() { document.addEventListener("click", e => {
  const b = e.target.closest('[data-entity],button.pn-link[data-code],button[data-inter-part],span.pn-link[data-art]');
  if (!b) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (b.dataset.entity) routeEntity(b.dataset.entity,b.dataset.id,{site:b.dataset.site,unit:b.dataset.unit});
  else if (b.dataset.code) openCodeDetail(b.dataset.code);
  else openPartCard(b.dataset.interPart || b.dataset.art);
}, true); }

const RU_COLLATOR = new Intl.Collator("ru");
function renderTable(container, { rows, cols, sortKey, sortDir = -1, rowClass, limit, onRowClick, csv, csvName }) {
  let key = sortKey || (cols.find(c => c.numeric) || cols[0]).key;
  let dir = sortDir;
  let shownLimit = limit || rows.length;
  function draw() {
    // localeCompare создаёт правила сравнения на КАЖДЫЙ вызов; на таблице
    // в сотни строк это тысячи вызовов. Один Collator на модуль — та же
    // сортировка, но кратно дешевле.
    const sorted = [...rows].sort((a, b) => {
      const va = key === "coverage" ? provisionCoverage(a) : a[key];
      const vb = key === "coverage" ? provisionCoverage(b) : b[key];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return RU_COLLATOR.compare(String(va), String(vb)) * dir;
    });
    const shown = shownLimit ? sorted.slice(0, shownLimit) : sorted;
    // Разметка строки вынесена из цикла — используется и при сортировке.
    const rowHtml = (r, ri) => {
      const cls = rowClass ? rowClass(r) : "";
      return `<tr class="${cls}" data-ri="${ri}"${onRowClick ? ' tabindex="0" role="button"' : ""}>${cols.map(c => {
        const raw = c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key]);
        const v = entityCell(c, r, raw);
        return `<td class="${c.numeric ? "n" : ""} ${c.cls || ""}">${v}</td>`;
      }).join("")}</tr>`;
    };
    const thead = `<thead><tr>${cols.map(c =>
      `<th class="${c.numeric ? "n" : ""} ${c.key === key ? "sorted" : ""}" data-k="${c.key}" tabindex="0" role="columnheader" aria-sort="${c.key === key ? (dir > 0 ? "ascending" : "descending") : "none"}">${esc(c.label)}${c.key === key ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`
    ).join("")}</tr></thead>`;
    const tbody = `<tbody>${shown.map(rowHtml).join("")}</tbody>`;
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
      // Один обработчик на контейнер вместо двух на каждую строку: на
      // таблице в 500 строк это 1 000 замыканий за перерисовку, которые
      // к тому же пересоздаются при каждой сортировке.
      container.onclick = e => {
        const tr = e.target.closest("tbody tr");
        if (!tr || !container.contains(tr)) return;
        if (e.target.closest("button,a,input,select,textarea")) return;
        const row = shown[+tr.dataset.ri];
        if (row) onRowClick(row);
      };
      container.onkeydown = e => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const tr = e.target.closest("tbody tr");
        if (!tr || e.target !== tr) return;
        e.preventDefault();
        const row = shown[+tr.dataset.ri];
        if (row) onRowClick(row);
      };
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
function kpi(label, value, kind, extra) {
  return `<div class="kpi ${kind || ""}"${extra || ""}><div class="l">${esc(label)}</div><div class="v">${value}</div></div>`;
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
  linkomeDraw: "linkome_drawings", usoWk: "uso_wk", wkNodes: "wk_nodes",
  control: "control", orderText: "order_text",
};
const CORE_KEYS = ["catalog", "ekmtrWk", "fleetBooks", "fleet", "repairs", "provision", "stock", "quality"];

async function ensureData(keys) {
  const missing = [...new Set(keys)].filter(k => k && D[k] === undefined && FILES[k]);
  if (!missing.length) return;
  await Promise.all(missing.map(async k => {
    await loadScript(`data/${FILES[k]}.local.js`);
    D[k] = dataFor(FILES[k]);
  }));
  buildIndexes();
}

async function bootOverrides() {
  if (typeof UpdStore === "undefined") return;
  try {
    const { data, info } = await UpdStore.loadAll();
    DATA_OVERRIDE = data; DATA_OVERRIDE_INFO = info;
  } catch (e) { /* нет хранилища (приватный режим и т. п.) — работаем по файлам */ }
  renderUpdBanner();
}
function renderUpdBanner() {
  const el = byId("updBanner");
  if (!el) return;
  const info = DATA_OVERRIDE_INFO, on = DATA_OVERRIDE.size > 0 && info && TAB !== "upd";
  el.hidden = !on;
  if (!on) return;
  const last = (info.log || []).slice(-1)[0] || {};
  el.innerHTML = `<span class="upd-banner-t" title="${esc(last.label || "")}"><b>Данные обновлены в этом браузере</b> ${esc(dmy(info.savedAt))} ${esc(String(info.savedAt).slice(11, 16))} — ${esc(last.label || "")}. Опубликованные файлы не изменены: чтобы обновление увидели все, скачайте архив.</span>
    <button class="minibtn" type="button" data-upd-open>Обновление данных</button>`;
  el.querySelector("[data-upd-open]").onclick = () => navigateTo("upd");
}
async function boot() {
  await bootOverrides();
  const host = byId("main");
  let done = 0;
  const tick = () => {
    done++;
    host.innerHTML = callout("info", `Загрузка данных… ${done} / ${CORE_KEYS.length}`);
  };
  host.innerHTML = callout("info", `Загрузка данных… 0 / ${CORE_KEYS.length}`);
  Promise.all(CORE_KEYS.map(k => loadScript(`data/${FILES[k]}.local.js`).then(() => { tick(); return k; })))
    .then(() => {
      CORE_KEYS.forEach(k => { D[k] = dataFor(FILES[k]); });
      buildIndexes();
      renderGlobalFilters();
      applyRoleChrome();
      renderTab();
    })
    .catch(e => {
      host.innerHTML = callout("bad",
        `Не удалось загрузить данные: ${esc(e.message)}. Проверьте, что рядом с index.html лежит вся ` +
        `папка целиком (включая data/) — файлы data/*.local.js должны быть на месте.`);
    });
}

/* индексы для быстрого поиска и join между витринами */
let STOCK_BY_CODE = new Map();
let EKMTR_NAME = new Map();
let CATALOG_BY_ART = new Map();
let CATALOG_BY_EKMTR = new Map();
let CATALOG_BY_NORMART = new Map(); // нормализованный номер -> позиция каталога (для кросс-линковки из LinkOne)
let INTER_GROUP_OF = new Map(); // каталожный номер -> группа взаимозаменяемости (массив)
let PROVISION_ORDER_BY_ID = new Map();
// Exact identity: punctuation and dimensional suffixes are significant.
function interKey(value) { return String(value || "").trim().toUpperCase().replace(/\s+/g, " "); }
function provTransfer(orders) {
  return (orders || []).reduce((s, o) => s + (o.lines || []).reduce((x, l) => x + (l.transferPotentialValue || 0), 0), 0);
}
function transferNote(l) {
  const from = Object.entries((l && l.transferFrom) || {}).filter(([, q]) => q > 0);
  if (!from.length) return "";
  return `<div class="sup-sub" title="Перемещение между площадками ограничено: в обеспеченность не входит, это возможность её улучшить"><span class="badge">можно переместить</span> ${from.map(([st, q]) => `${num(q, 1)} из ${esc((siteNameOf(st) || st || "?").split(" ")[0])}`).join(", ")}</div>`;
}
function provisionCoverage(row) { return row.needQty > 0 ? 100 * (row.fromStock + row.fromBuy) / row.needQty : 0; }
function interPartLink(part) {
  return entityLink("part", part);
}
function wireInterLinks(container) {
  container.onclick = e => {
    const button = e.target.closest("[data-inter-part]");
    if (button) { e.stopPropagation(); openDetail(button.dataset.interPart); }
  };
}
function linkomeRowsFor(art) {
  const byPart = D.linkome && D.linkome.byPart;
  return (art && byPart && byPart[normArt(art)]) || null;
}
function buildIndexes() {
  STOCK_BY_CODE = new Map((D.stock && D.stock.items || []).map(i => [String(i.code), i]));
  EKMTR_NAME = new Map((D.ekmtrWk && D.ekmtrWk.items || []).map(i => [String(i.code), i.name]));
  CATALOG_BY_ART = new Map((D.catalog && D.catalog.items || []).map(i => [i.art, i]));
  CATALOG_BY_NORMART = new Map((D.catalog && D.catalog.items || []).map(i => [normArt(i.art), i]));
  CATALOG_BY_EKMTR = new Map();
  (D.catalog && D.catalog.items || []).forEach(i => { if (i.ekmtr && !CATALOG_BY_EKMTR.has(String(i.ekmtr))) CATALOG_BY_EKMTR.set(String(i.ekmtr), i); });
  INTER_GROUP_OF = new Map();
  ((D.interchange && D.interchange.groups) || []).forEach(g => g.forEach(part => {
    const key = interKey(part);
    INTER_GROUP_OF.set(key, [...new Set([...(INTER_GROUP_OF.get(key) || []), ...g])]);
  }));
  if (D.control && D.controlRowsOf !== D.control && typeof AnalyticsCore !== "undefined") { D.controlRows = AnalyticsCore.decodeControl(D.control); D.controlRowsOf = D.control; }
  PROVISION_ORDER_BY_ID = new Map([...(D.provision && D.provision.orders || []), ...(D.provision && D.provision.closedOrders || [])].map(o => [o.id, o]));
}
function catalogByEkmtr(code) {
  return CATALOG_BY_EKMTR.get(String(code || "")) || null;
}
function wireCodeLinks(host) {
  if (!host) return;
  qsa("button.pn-link[data-code]", host).forEach(el => {
    el.onclick = e => { e.stopPropagation(); openCodeDetail(el.dataset.code); };
  });
}
function purchaseMonthsHtml(purchase) {
  const months = Object.entries((purchase && purchase.byMonth) || {}).sort();
  if (!months.length) return '<span class="dim">нет открытой поставки</span>';
  return months.map(([m, q]) => `<span class="sup-pill order">${esc(m || "без даты")}: ${num(q, 1)}</span>`).join(" ");
}
function warehouseHtml(byWh, site) {
  const rows = warehouseBreakdown(byWh);
  if (!rows.length) return '<span class="dim">складов нет</span>';
  return rows.map(r => {
    const here = site && r.site === site;
    const tag = r.kind === "consign" ? "consign" : here ? "ok" : r.site ? "info" : "";
    const where = [r.label, r.plantName].filter(Boolean).join(" · ");
    const short = r.site ? (siteNameOf(r.site) || r.site).split(" ")[0] : r.label;
    return `<span class="sup-pill ${tag}" title="${esc(where)}">${esc(short)} · ${esc(r.name)} · ${num(r.qty, 1)}</span>`;
  }).join(" ");
}

/* ---------- вкладки ---------- */
async function renderTab() {
  const host = byId("main");
  renderUpdBanner();
  const seq = ++NAV_SEQ;
  writeHash(false);
  applyRoleChrome();
  syncFiltersToContext();
  const need = [...(TAB_NEEDS[TAB] || [])];
  if (G.pg) need.push("control");     // группа планирования заказа — из витрины control
  if ((TAB === "catalog" || TAB === "kb" || TAB === "provision") && (G.part || G.ekmtr || G.order)) {
    need.push("linkome", "linkomeDraw");
  }
  if (need.some(k => D[k] === undefined)) {
    host.innerHTML = callout("info", "Загрузка раздела…");
    try { await ensureData(need); if (G.pg) renderGlobalFilters(); }
    catch (e) {
      if (seq !== NAV_SEQ) return;
      host.innerHTML = callout("bad", esc(e.message));
      return;
    }
    if (seq !== NAV_SEQ) return;
  }
  switch (TAB) {
    case "sum": return renderSum(host);
    case "analytics": return renderAnalytics(host);
    case "control": return renderControl(host);
    case "lookup": return renderLookup(host);
    case "catalog": return renderCatalog(host);
    case "linkone": return renderLinkone(host);
    case "kb": return renderKB(host);
    case "fleet": return renderFleet(host);
    case "repairs": return renderSchedule(host);
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
function cartNormalize(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(i => i && typeof i === "object" && i.code != null).map(i => ({
    code: String(i.code), name: String(i.name || ""), source: String(i.source || ""),
    value: Number.isFinite(Number(i.value)) ? Number(i.value) : null,
    qty: Math.max(1, parseInt(i.qty, 10) || 1), note: String(i.note || ""), addedAt: i.addedAt || "",
    site: String(i.site || ""), unit: String(i.unit || ""), order: String(i.order || ""),
  }));
}
function cartGet() {
  if (CART_MEM) return CART_MEM;
  try {
    CART_MEM = cartNormalize(JSON.parse(localStorage.getItem(CART_KEY) || "[]"));
  } catch (e) { CART_MEM = []; }
  return CART_MEM;
}
function cartSet(items) {
  CART_MEM = cartNormalize(items);
  try { localStorage.setItem(CART_KEY, JSON.stringify(CART_MEM)); } catch (e) { /* приватный режим и т.п. */ }
  cartUpdateBadge();
}
function cartHas(code) { return cartGet().some(i => i.code === code); }
function cartAdd(item) {
  const items = cartGet();
  if (items.some(i => i.code === item.code)) return;
  items.push({
    ...item,
    site: item.site || G.site || "",
    unit: item.unit || G.unit || "",
    order: item.order || G.order || "",
    addedAt: new Date().toISOString(),
  });
  cartSet(items);
}
function cartAddMany(list) {
  const items = cartGet();
  const have = new Set(items.map(i => i.code));
  let n = 0;
  for (const item of list) {
    if (!item || item.code == null || have.has(String(item.code))) continue;
    have.add(String(item.code));
    items.push({
      ...item, code: String(item.code),
      site: item.site || G.site || "", unit: item.unit || G.unit || "",
      order: item.order || G.order || "", addedAt: new Date().toISOString(),
    });
    n++;
  }
  if (n) cartSet(items);
  return n;
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
      { key: "site", label: "Площадка", plain: v => v || "", fmt: v => v ? esc(siteNameOf(v) || v) : "—" },
      { key: "unit", label: "Машина", fmt: v => v ? esc(v) : "—" },
      { key: "order", label: "Заказ", fmt: v => v ? esc(v) : "—" },
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
let SUM_DRILL = null;

const SUM_DRILL_KEYS = {
  fromStock: ["fromStock"],
  fromBuy: ["fromBuy"],
  late: ["late"],
  undated: ["undated"],
  gap: ["gap"],
  covered: ["fromStock", "fromBuy"],
  uncovered: ["late", "undated", "gap"],
};
const SUM_DRILL_LABEL = {
  fromStock: "Есть на складе",
  fromBuy: "Закупка успевает к сроку",
  late: "Закупка опаздывает",
  undated: "Закупка просрочена / без срока",
  gap: "Не покрыто ничем",
  covered: "Обеспечено к сроку работ",
  uncovered: "Не обеспечено к сроку",
  inTime: "Ещё можно успеть заказом",
  tooLate: "Заказывать уже поздно",
};

function sumLineBucket(line, keys) {
  let qty = 0, value = 0;
  keys.forEach(k => {
    qty += line[k] || 0;
    value += line[k + "Value"] || 0;
  });
  return { qty, value };
}

function sumBucketPositions(keys) {
  const map = new Map();
  contextOrders().forEach(o => (o.lines || []).forEach(l => {
    const b = sumLineBucket(l, keys);
    if (b.qty <= 1e-9 && b.value <= 1e-9) return;
    const cur = map.get(String(l.code)) || { code: l.code, name: l.name, qty: 0, value: 0, orders: new Set(), sites: new Set() };
    cur.qty += b.qty; cur.value += b.value;
    cur.orders.add(o.order); cur.sites.add(o.site);
    map.set(String(l.code), cur);
  }));
  return [...map.values()].map(r => ({ ...r, orders: r.orders.size, sites: [...r.sites].join(", ") }))
    .sort((a, b) => b.value - a.value);
}

function sumBucketLines(keys, code) {
  const rows = [];
  contextOrders().forEach(o => (o.lines || []).forEach(l => {
    if (code && String(l.code) !== String(code)) return;
    const b = sumLineBucket(l, keys);
    if (b.qty <= 1e-9 && b.value <= 1e-9) return;
    rows.push({
      date: l.date || o.date, site: o.site, unit: o.unit, order: o.order,
      work: l.work, code: l.code, name: l.name, method: l.method || o.method,
      qty: b.qty, value: b.value, need: l.qty,
    });
  }));
  return rows.sort((a, b) => b.value - a.value);
}

function sumFeasibleItems(kind) {
  const scoped = contextScopedItems();
  if (kind === "inTime") return scoped.filter(i => (i.canOrder || 0) > 0).sort((a, b) => (b.canOrder || 0) - (a.canOrder || 0));
  if (kind === "tooLate") return scoped.filter(i => (i.tooLate || 0) > 0).sort((a, b) => (b.tooLate || 0) - (a.tooLate || 0));
  return [];
}
function contextScopedItems() {
  const items = D.provision.items || [];
  if (!contextHasFilter()) return items;
  const codes = new Set();
  contextOrders().forEach(o => (o.lines || []).forEach(l => codes.add(String(l.code))));
  return items.filter(i => codes.has(String(i.code)));
}

function sumSetDrill(next) {
  if (!next) {
    SUM_DRILL = null;
  } else if (next.keep) {
    SUM_DRILL = { kind: next.kind, key: next.key, code: next.code || null };
  } else if (SUM_DRILL && SUM_DRILL.kind === next.kind && SUM_DRILL.key === next.key && !next.code && !SUM_DRILL.code) {
    SUM_DRILL = null;
  } else {
    SUM_DRILL = { kind: next.kind, key: next.key, code: next.code || null };
  }
  const box = byId("sumDrill");
  if (box) {
    box.innerHTML = sumDrillHtml();
    wireSumDrill(box);
    if (SUM_DRILL) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  qsa("[data-sum-bucket],[data-sum-drill]").forEach(el => {
    const keys = SUM_DRILL ? (SUM_DRILL_KEYS[SUM_DRILL.key] || [SUM_DRILL.key]) : [];
    const hit = SUM_DRILL && (
      el.dataset.sumBucket === SUM_DRILL.key ||
      el.dataset.sumDrill === SUM_DRILL.key ||
      keys.includes(el.dataset.sumBucket)
    );
    el.classList.toggle("on", !!hit);
  });
}

function sumDrillHtml() {
  if (!SUM_DRILL) {
    return `<p class="hint">Нажмите сегмент графика, легенду или карточку — здесь раскроется состав.</p>`;
  }
  const sites = (D.fleet && D.fleet.meta && D.fleet.meta.sites) || {};
  if (SUM_DRILL.kind === "fleet") {
    const units = (D.fleet.units || []).filter(u => u.model === SUM_DRILL.key && (!G.site || u.site === G.site) && (!G.unit || u.name === G.unit));
    return `<div class="sum-drill-head"><h3>${esc(SUM_DRILL.key)} · ${num(units.length)} машин</h3>
      <button class="minibtn" type="button" data-sum-close>Скрыть</button></div>
      <div id="sumDrillTable"></div>`;
  }
  if (SUM_DRILL.kind === "work") {
    return `<div class="sum-drill-head"><h3>${esc(SUM_DRILL.key)}</h3>
      <button class="minibtn" type="button" data-sum-close>Скрыть</button></div>
      <p class="hint">Факт ремонта 2022–2027 по этой статье — крупнейшие машины. Клик по строке откроет график план-факт.</p>
      <div id="sumDrillTable"></div>`;
  }
  const label = SUM_DRILL_LABEL[SUM_DRILL.key] || SUM_DRILL.key;
  if (SUM_DRILL.kind === "feasible") {
    const rows = sumFeasibleItems(SUM_DRILL.key);
    const money = rows.reduce((s, r) => s + (SUM_DRILL.key === "inTime" ? (r.canOrder || 0) : (r.tooLate || 0)), 0);
    return `<div class="sum-drill-head"><h3>${esc(label)}</h3>
      <button class="minibtn" type="button" data-sum-close>Скрыть</button></div>
      <p class="hint">${num(rows.length)} позиций · ${mrub(money)}. Клик по строке — карточка кода.</p>
      <div id="sumDrillTable"></div>`;
  }
  const keys = SUM_DRILL_KEYS[SUM_DRILL.key] || [SUM_DRILL.key];
  if (SUM_DRILL.code) {
    const lines = sumBucketLines(keys, SUM_DRILL.code);
    const pos = lines[0];
    const money = lines.reduce((s, r) => s + r.value, 0);
    return `<div class="sum-drill-head"><h3><button class="minibtn" type="button" data-sum-back>← К позициям</button> ${esc(SUM_DRILL.code)} · ${esc(pos && pos.name || "")}</h3>
      <button class="minibtn" type="button" data-sum-close>Скрыть</button></div>
      <p class="hint">${num(lines.length)} строк заказов · ${mrub(money)} в корзине «${esc(label)}». Клик — заказ на вкладке обеспеченности.</p>
      <div id="sumDrillTable"></div>`;
  }
  const rows = sumBucketPositions(keys);
  const money = rows.reduce((s, r) => s + r.value, 0);
  return `<div class="sum-drill-head"><h3>${esc(label)}</h3>
    <button class="minibtn" type="button" data-sum-close>Скрыть</button></div>
    <p class="hint">${num(rows.length)} позиций · ${mrub(money)}. Клик по коду — строки заказов этой корзины.</p>
    <div id="sumDrillTable"></div>`;
}

function wireSumDrill(box) {
  const close = qs("[data-sum-close]", box);
  if (close) close.onclick = () => sumSetDrill(null);
  const back = qs("[data-sum-back]", box);
  if (back) back.onclick = () => sumSetDrill({ kind: SUM_DRILL.kind, key: SUM_DRILL.key, keep: true });
  const table = byId("sumDrillTable");
  if (!table || !SUM_DRILL) return;
  const sites = (D.fleet && D.fleet.meta && D.fleet.meta.sites) || {};
  if (SUM_DRILL.kind === "fleet") {
    const units = (D.fleet.units || []).filter(u => u.model === SUM_DRILL.key && (!G.site || u.site === G.site) && (!G.unit || u.name === G.unit));
    renderTable(table, {
      rows: units, sortKey: "name", sortDir: 1, csv: true, csvName: `wk_fleet_${SUM_DRILL.key}.csv`,
      onRowClick: u => { G.model = u.model; G.unit = u.name; G.site = u.site; TAB = "fleet"; writeHash(); renderGlobalFilters(); renderTab(); },
      cols: [
        { key: "siteName", label: "Площадка" },
        { key: "name", label: "Борт", cls: "wrap" },
        { key: "garage", label: "Гар. №" },
        { key: "serial", label: "Зав. №", cls: "mono" },
        { key: "ktg", label: "КТГ факт", numeric: true, fmt: v => v != null ? num(v * 100, 1) + "%" : "—" },
        { key: "book", label: "Книга", cls: "mono" },
      ],
    });
    return;
  }
  if (SUM_DRILL.kind === "work") {
    renderTable(table, {
      rows: (D.repairs.byUnit || []).slice(0, 40), sortKey: "total",
      csv: true, csvName: "wk_repairs_units.csv",
      onRowClick: u => { G.unit = u.unit; TAB = "repairs"; writeHash(); renderGlobalFilters(); renderTab(); },
      cols: [
        { key: "unit", label: "Машина", cls: "wrap" },
        { key: "total", label: "Факт 22–27", numeric: true, fmt: mrub },
      ],
    });
    return;
  }
  if (SUM_DRILL.kind === "feasible") {
    const moneyKey = SUM_DRILL.key === "inTime" ? "canOrder" : "tooLate";
    const rows = sumFeasibleItems(SUM_DRILL.key);
    renderTable(table, {
      rows, sortKey: moneyKey, limit: 80, csv: true, csvName: `wk_sum_${SUM_DRILL.key}.csv`,
      onRowClick: r => openCodeDetail(r.code),
      cols: [
        { key: "code", label: "ЕКМТР", cls: "mono", fmt: v => codeLink(v) },
        { key: "name", label: "Деталь", cls: "wrap" },
        { key: moneyKey, label: "Сумма", numeric: true, fmt: rub },
        { key: "leadDays", label: "Срок, дн.", numeric: true },
        { key: "orderBy", label: "Заказать до", fmt: v => v ? dmy(v) : "—" },
        { key: "firstOpen", label: "Ближайшая потребность", fmt: v => v ? dmy(v) : "—" },
      ],
    });
    wireCodeLinks(table);
    return;
  }
  const keys = SUM_DRILL_KEYS[SUM_DRILL.key] || [SUM_DRILL.key];
  if (SUM_DRILL.code) {
    const lines = sumBucketLines(keys, SUM_DRILL.code);
    renderTable(table, {
      rows: lines, sortKey: "value", limit: 120, csv: true, csvName: `wk_sum_${SUM_DRILL.key}_${SUM_DRILL.code}.csv`,
      onRowClick: r => { G.order = r.order; G.unit = r.unit; G.site = r.site; TAB = "provision"; writeHash(); renderGlobalFilters(); renderTab(); },
      cols: [
        { key: "date", label: "Начало", fmt: dmy },
        { key: "site", label: "Площадка", fmt: v => esc(sites[v] || v) },
        { key: "unit", label: "Машина", cls: "wrap" },
        { key: "order", label: "Заказ", cls: "mono" },
        { key: "work", label: "Вид работ", cls: "wrap" },
        { key: "qty", label: "В корзине, ед.", numeric: true, fmt: v => num(v, 3) },
        { key: "value", label: "В корзине ₽", numeric: true, fmt: rub },
      ],
    });
    return;
  }
  const rows = sumBucketPositions(keys);
  renderTable(table, {
    rows, sortKey: "value", limit: 80, csv: true, csvName: `wk_sum_${SUM_DRILL.key}.csv`,
    onRowClick: r => sumSetDrill({ kind: "bucket", key: SUM_DRILL.key, code: r.code }),
    cols: [
      { key: "code", label: "ЕКМТР", cls: "mono", fmt: v => codeLink(v) },
      { key: "name", label: "Деталь", cls: "wrap" },
      { key: "qty", label: "Кол-во", numeric: true, fmt: v => num(v, 1) },
      { key: "value", label: "Сумма", numeric: true, fmt: rub },
      { key: "orders", label: "Заказов", numeric: true },
      { key: "sites", label: "Площадки" },
    ],
  });
  wireCodeLinks(table);
}

function wireSumClicks(host) {
  const go = (next) => (e) => { e.preventDefault(); e.stopPropagation(); sumSetDrill(next); };
  qsa("[data-sum-bucket]", host).forEach(el => {
    el.onclick = go({ kind: "bucket", key: el.dataset.sumBucket });
  });
  qsa("[data-sum-drill]", host).forEach(el => {
    el.onclick = go({
      kind: el.dataset.sumKind || (SUM_DRILL_KEYS[el.dataset.sumDrill] ? "bucket" : "feasible"),
      key: el.dataset.sumDrill,
    });
  });
  makeActivatable(host, "[data-sum-bucket],[data-sum-drill]");
}

function renderSum(host) {
  const c = D.catalog.meta, s = D.stock.meta, r = D.repairs.meta, f = D.fleet.meta, p = D.provision.meta;
  const orders = contextOrders();
  const w = contextHasFilter() ? provisionOrderTotals(orders) : p.wk;
  const T = w.value || 1;
  const units = D.fleet.units.filter(u => (!G.site || u.site === G.site) && (!G.model || u.model === G.model) && (!G.unit || u.name === G.unit));
  const unitNames = new Set(units.map(u => u.name));
  const repairUnits = (D.repairs.byUnit || []).filter(u => !contextHasFilter() || unitNames.has(u.unit));
  const repairFact = contextHasFilter() ? repairUnits.reduce((sum, u) => sum + (u.total || 0), 0) : r.factTotal;
  const scopedItems = contextScopedItems();
  const inTime = scopedItems.filter(i => (i.canOrder || 0) > 0).reduce((sum, i) => sum + (i.canOrder || 0), 0);
  const tooLate = scopedItems.filter(i => (i.tooLate || 0) > 0).reduce((sum, i) => sum + (i.tooLate || 0), 0);
  const catItems = D.catalog.items.filter(catalogInContext);
  const stockRows = (D.stock.items || []).filter(stockInContext);
  const stockAvail = stockRows.reduce((s, i) => s + stockSiteVal(i, "availValue"), 0);
  const stockRest = stockRows.reduce((s, i) => s + stockSiteVal(i, "restrictedValue"), 0);
  const purchPlan = stockRows.reduce((s, i) => s + ((i.purchase && i.purchase.planV) || 0), 0);
  const catCoded = catItems.filter(i => i.ekmtr).length;
  const ctx = contextHasFilter() ? contextLabel() : "";
  const uncovered = w.late + w.undated + w.gap;
  host.innerHTML = `
    <h1>WK CRM</h1>
    <p class="sub">Каталог запчастей, база знаний, запасы, обеспеченность, закупки и ремонты экскаваторов WK. Taiyuan Heavy Industry, ${f.units} единиц.${ctx ? ` Контекст: <b>${esc(ctx)}</b>.` : ""}</p>
    ${ctx ? callout("info", `Показатели и списки на этой вкладке — по выбранному контексту (<b>${esc(ctx)}</b>). Сбросьте фильтры сверху, чтобы вернуть весь парк.`) : ""}
    <div class="kpis">
      ${kpi("Парк", units.length + " ед.", "", ` data-sum-tab="fleet" tabindex="0"`)}
      ${kpi("Позиций в прайсе", num(catItems.length), "", ` data-sum-tab="catalog" tabindex="0"`)}
      ${kpi("Кодифицировано", pct(catItems.length ? catCoded / catItems.length : 0), catItems.length && catCoded / catItems.length < 0.5 ? "warn" : "", ` data-sum-tab="catalog" tabindex="0"`)}
      ${kpi(G.site ? "Остаток WK на площадке" : "Остаток WK доступно", mrub(stockAvail), "good", ` data-sum-tab="stock" tabindex="0"`)}
      ${kpi("Запас ограничен", mrub(stockRest), stockRest > 0 ? "bad" : "", ` data-sum-tab="stock" tabindex="0"`)}
      ${kpi("Закупка план", mrub(purchPlan), "", ` data-sum-tab="purchase" tabindex="0"`)}
      ${kpi("Ремонт факт 22-27", mrub(repairFact), "", ` data-sum-tab="repairs" tabindex="0"`)}
      ${kpi("Не обеспечено 26-27", mrub(uncovered), "bad", ` data-sum-drill="uncovered" tabindex="0"`)}
    </div>

    ${callout("info", `<b>Ограниченный запас</b> — позиции, которые физически есть на складе, но SAP запрещает их использовать в ремонте (брак, резерв, спорное качество). Такой запас <b>вычитается</b> из доступного остатка везде в этом портале и подсвечивается статусом «ограничено» — не путайте с обычным наличием.`)}

    <h2>Обеспеченность плана 2026–2027 (номенклатура WK)</h2>
    <p class="sub">${ctx ? `В контексте ${esc(ctx)}: ` : ""}потребность ${mrub(w.value)} · ${num(orders.length)} открытых заказов. Закрывается остатком и уже размещённой закупкой. Данные на ${dmy(p.asOf)}. Нажмите сегмент графика или подпись — откроется состав корзины.</p>
    ${provBar(w, T, 14, true)}
    ${provLegend(w, true)}
    <div id="sumDrill" class="sum-drill">${sumDrillHtml()}</div>
    <div class="grid3" style="margin-top:14px">
      <div class="card sum-hit" data-sum-drill="covered" tabindex="0"><h3>Обеспечено к сроку работ</h3><div class="kpi good" style="border:0;padding:0"><div class="v">${mrub(w.fromStock + w.fromBuy)}</div></div><p class="hint">${num(100 * (w.fromStock + w.fromBuy) / T, 0)}% потребности · нажмите, чтобы раскрыть</p></div>
      <div class="card sum-hit" data-sum-drill="inTime" tabindex="0"><h3>Ещё можно успеть заказом</h3><div class="kpi warn" style="border:0;padding:0"><div class="v">${mrub(contextHasFilter() ? inTime : ((p.feasible.inTime || {}).value || 0))}</div></div><p class="hint">при сроке поставки ${num(p.leadMedianDays)} дн. · нажмите, чтобы раскрыть</p></div>
      <div class="card sum-hit" data-sum-drill="tooLate" tabindex="0"><h3>Заказывать уже поздно</h3><div class="kpi bad" style="border:0;padding:0"><div class="v">${mrub(contextHasFilter() ? tooLate : ["late3", "lateMore", "past"].reduce((a, k) => a + ((p.feasible[k] || {}).value || 0), 0))}</div></div><p class="hint">срок работ наступит раньше поставки · нажмите, чтобы раскрыть</p></div>
    </div>

    <h2>Заказать сегодня</h2>
    <p class="sub">Верхние позиции дефицита, которые ещё закрываются заказом на дату снимка. Пакет кладётся в заявку с площадкой и заказом из текущего контекста.</p>
    <div id="sumOrderToday"></div>

    <h2>Парк по моделям</h2>
    <div id="sumFleet"></div>

    <h2>Крупнейшие статьи ремонта (факт 2022-2027)</h2>
    <div id="sumWork"></div>
  `;
  const today = orderTodayItems(scopedItems);
  if (!today.length) {
    byId("sumOrderToday").innerHTML = callout("info", "Нет позиций со статусом «успеем, если заказать сейчас».");
  } else {
    const packValue = today.reduce((s, r) => s + (r.canOrder || r.gapValue || 0), 0);
    byId("sumOrderToday").innerHTML = `
      <div class="toolbar">
        <span class="count">${num(today.length)} позиций · ${mrub(packValue)}</span>
        <button class="iconbtn on" id="sumPackBtn" type="button">В заявку пакетом</button>
      </div>
      <div id="sumOrderTable"></div>`;
    renderTable(byId("sumOrderTable"), {
      rows: today, sortKey: "gapValue",
      csv: true, csvName: "wk_order_today.csv",
      onRowClick: r => openCodeDetail(r.code),
      cols: [
        { key: "code", label: "ЕКМТР", cls: "mono" },
        { key: "name", label: "Наименование", cls: "wrap" },
        { key: "gapValue", label: "Дефицит", numeric: true, fmt: rub },
        { key: "canOrder", label: "Ещё можно заказать", numeric: true, fmt: v => v ? rub(v) : "—" },
        { key: "leadDays", label: "Срок, дн.", numeric: true },
        { key: "orderBy", label: "Заказать до", fmt: v => v ? `<span class="mono">${dmy(v)}</span>` : "—" },
        { key: "code", label: "", plain: () => "", fmt: (v, r) => cartAddBtn({ code: v, name: r.name, value: r.canOrder || r.gapValue, source: "Заказать сегодня" }) },
      ],
    });
    wireCartButtons(byId("sumOrderTable"));
    byId("sumPackBtn").onclick = () => {
      const n = cartAddMany(today.map(r => ({ code: r.code, name: r.name, value: r.canOrder || r.gapValue, source: "Заказать сегодня" })));
      byId("sumPackBtn").textContent = n ? `Добавлено ${n}` : "Уже в заявке";
      cartUpdateBadge();
    };
  }
  const byModel = {};
  units.forEach(u => { byModel[u.model] = (byModel[u.model] || 0) + 1; });
  renderTable(byId("sumFleet"), {
    rows: Object.entries(byModel).map(([model, n]) => ({ model, n })),
    cols: [{ key: "model", label: "Модель" }, { key: "n", label: "Единиц", numeric: true }],
    onRowClick: r => sumSetDrill({ kind: "fleet", key: r.model, keep: true }),
  });
  renderTable(byId("sumWork"), {
    rows: contextHasFilter()
      ? repairUnits.slice().sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 10).map(u => ({ work: u.unit, value: u.total }))
      : D.repairs.byWork.slice(0, 10),
    cols: [{ key: "work", label: contextHasFilter() ? "Машина" : "Вид работ" }, { key: "value", label: "Факт", numeric: true, fmt: mrub }],
    onRowClick: r => contextHasFilter()
      ? (G.unit = r.work, navigateTo("repairs"))
      : sumSetDrill({ kind: "work", key: r.work, keep: true }),
  });
  qsa("[data-sum-tab]", host).forEach(el => {
    el.onclick = e => { e.preventDefault(); e.stopPropagation(); navigateTo(el.dataset.sumTab); };
  });
  makeActivatable(host, "[data-sum-tab],.sum-hit");
  wireSumClicks(host);
  if (SUM_DRILL) wireSumDrill(byId("sumDrill"));
}

/* ===================== КАТАЛОГ ===================== */
let CAT_FILTER = { model: "", q: "", noCode: false, diff: false };
let KB_FILTER = { cls: "", q: "", model: "" };

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
  const ctxModels = contextModels();
  const models = [...new Set(items.map(i => i.model).filter(Boolean))]
    .filter(m => catalogModelFits(m, ctxModels))
    .sort((a, b) => a.localeCompare(b, "ru"));
  host.innerHTML = `
    <h1>Каталог запчастей</h1>
    ${contextBanner()}
    ${schemePanelHtml()}
    <p class="sub">${num(items.length)} позиций прайса ДП (основной источник) со сверкой прайса УСО, привязкой к дереву узлов и к коду ЕКМТР. Цена — <b>в юанях</b>, единственное место в портале.</p>
    <div class="toolbar">
      <input type="search" id="catQ" placeholder="Артикул или наименование…" value="${esc(CAT_FILTER.q)}"/>
      <select id="catModel">
        <option value="">Все модели</option>
        ${models.map(m => `<option ${CAT_FILTER.model === m ? "selected" : ""}>${m}</option>`).join("")}
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
      if (!catalogInContext(i)) return false;
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
    if (!rows.length) { byId("catTable").innerHTML = callout("info", "По текущим фильтрам позиций нет. Сбросьте фильтры каталога или контекст отчёта сверху (площадка / модель / ЕКМТР)."); return; }
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
          plain: v => (D.drawings && D.drawings.byNum && D.drawings.byNum[v]) ? "чертёж" : linkomeRowsFor(v) ? "состав узла (LinkOme)" : "",
          fmt: (v) => (D.drawings && D.drawings.byNum && D.drawings.byNum[v])
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
  byId("catReset").onclick = () => { CAT_FILTER = { model: G.model || "", q: "", noCode: false, diff: false }; renderCatalog(host); };
  const schemeBtn = byId("schemeOpenLo");
  if (schemeBtn) schemeBtn.onclick = () => {
    const hit = loFocusContext();
    if (hit) { LO.book = hit.book; LO.current = hit.page; LO.index = null; }
    navigateTo("linkone");
  };
  apply();
}

/* ===================== КАТАЛОГ LINKONE (формат Komatsu/Cat/Cummins) =====================
   Дерево книга → узел → состав, как в песочнице KOMATSU_PARTS_BOOK: слева дерево, справа
   таблица позиций текущего узла, клик по позиции с дочерним узлом — раскрывает его, клик по
   номеру, сверенному с прайсом ДП, — открывает карточку детали. Чертежи .ilg разобраны
   (палитра RGBQUAD + LZH + построчный RLE), выноски кликабельны. */
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

function kbDocsForNode(page) {
  const model = ((D.tree || {}).bookModel || {})[LO.book] || "";
  const id = normArt(page.id);
  const tokens = normText(page.title || page.name || "").split(/[^a-zа-я0-9]+/i).filter(x => x.length >= 5);
  return D.kb.docs.map(d => {
    const hay = normText(`${d.name} ${d.path} ${d.class}`), compact = normArt(`${d.name} ${d.path}`);
    let score = 0;
    if (id.length >= 5 && compact.includes(id)) score += 20;
    score += tokens.filter(t => hay.includes(t)).length * 3;
    if (model && d.model === model) score += 2;
    if (model && d.model && d.model !== model) score -= 20;
    return { d, score };
  }).filter(x => x.score >= 3).sort((a,b) => b.score-a.score || a.d.name.localeCompare(b.d.name,"ru")).slice(0,8).map(x=>x.d);
}

function renderLinkone(host) {
  const allBooks = Object.entries(D.linkome.books).sort((a, b) => a[0].localeCompare(b[0]));
  const allowed = contextBooks();
  const selectedUnit = G.unit ? D.fleet.units.find(u => u.name === G.unit) : null;
  const focus = loFocusContext();
  let books = allowed.size ? allBooks.filter(([code]) => allowed.has(code)) : allBooks;
  if (focus && !books.some(([c]) => c === focus.book)) {
    const extra = allBooks.find(([c]) => c === focus.book);
    if (extra) books = [extra, ...books];
  }
  if (focus) {
    if (LO.book !== focus.book) {
      LO.book = focus.book; LO.index = loBuildIndex(LO.book);
    }
    LO.current = focus.page;
    LO.focusRaw = focus.raw;
  } else if (selectedUnit && selectedUnit.book && D.linkome.books[selectedUnit.book]) {
    if (LO.book !== selectedUnit.book) {
      LO.book = selectedUnit.book; LO.index = loBuildIndex(LO.book); LO.current = LO.index.roots[0]?.id || null;
    }
  } else if (allowed.size && (!LO.book || !allowed.has(LO.book))) {
    const first = books[0] && books[0][0];
    if (first) { LO.book = first; LO.index = loBuildIndex(LO.book); LO.current = LO.index.roots[0]?.id || null; }
  } else if (G.part) {
    LO.focusRaw = G.part;
  }
  host.innerHTML = `
    <div class="lo-screen"><h1>Каталог LinkOne</h1>
    ${contextBanner()}
    <p class="sub">${books.length} ${allowed.size ? "книг машин выбранного контекста" : "книг"} · ${num(D.linkome.meta.pagesTotal)} страниц. ${selectedUnit ? `Книга борта <b>${esc(selectedUnit.book || "не привязана")}</b>.` : G.site ? "Показаны только книги машин этой площадки." : ""}</p>
    ${selectedUnit && !selectedUnit.book ? callout("warn", "У выбранной машины нет подтверждённой книги — каталог не подставляется наугад.") : ""}
    <div class="lo-books" id="loBooks">
      ${books.map(([code, b]) => `
        <div class="lo-book${LO.book === code ? " on" : ""}" data-book="${esc(code)}">
          <span class="n">${esc(code)}</span>
          <span class="s">${esc(b.model || "")} · ${num(b.pageCount)} стр.</span>
        </div>`).join("")}
    </div>
    <div id="loShell"></div></div>
  `;
  qsa(".lo-book", host).forEach(el => el.onclick = () => loSelectBook(el.dataset.book, host));
  makeActivatable(host, ".lo-book");
  if (LO.book && books.some(([c]) => c === LO.book)) {
    loRenderBody(host);
  } else if (books.length) {
    loSelectBook(books[0][0], host);
  } else {
    byId("loShell").innerHTML = callout("info", "В этом контексте нет книги LinkOne.");
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
  const body = byId("loShell");
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
    const isOpen = depth < 2 || openIds.has(id);
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
  const relatedDocs = kbDocsForNode(page);
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
    <div class="lo-body${LO.fullscreen ? " lo-fullscreen" : ""}" id="loFull">
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
        ${relatedDocs.length ? `<details class="lo-kb" open><summary>База знаний по узлу · ${relatedDocs.length}</summary>${relatedDocs.map(d=>`<a href="${esc(kbFileUrl(d.path))}" target="_blank" rel="noopener"><b>${esc(d.name)}</b><span>${esc(d.class)}${d.model?' · '+esc(d.model):''}</span></a>`).join('')}</details>` : ''}
        <div class="twrap"><table class="lo-parts">
          <thead><tr><th class="c-pos">№</th><th>Номер</th><th>Наименование</th><th class="n">Кол.</th>
            <th>ЕКМТР</th><th>Наличие<br>и заказ</th><th class="n">Цена</th><th></th></tr></thead>
          <tbody>${rows.map(r => {
            const kid = r.link && loFindPage(r.link);
            const sup = supplyCells(r.part);
            return `<tr data-item="${esc(r.item || "")}" data-part="${esc(r.part || "")}">
              <td class="c-pos">${esc(r.item || "")}</td>
              <td class="mono">${sup.art
                ? entityLink("part",sup.art)
                : entityLink("part",r.part || "")}</td>
              <td class="wrap">${esc(r.name || "")}</td>
              <td class="n">${r.qty != null ? num(r.qty) : ""}</td>
              <td>${sup.ekmtr}</td>
              <td class="c-stock">${sup.stock}${sup.order ? " " + sup.order : ""}</td>
              <td class="n c-price">${sup.price}</td>
              <td class="c-act">${kid ? `<span class="badge info" data-goto="${esc(kid.id)}" style="cursor:pointer">узел ▸</span>` : ""}${r.part ? ` ${cartAddBtn(sup.art ? sup.cart : {code:r.part,name:r.name,value:null,source:'LinkOne'})}` : ""}</td>
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
  const want = normArt(LO.focusRaw || G.part || "");
  if (want) {
    const tr = qsa("tbody tr[data-part]", host).find(el => normArt(el.dataset.part) === want);
    if (tr) {
      tr.classList.add("lo-pin");
      if (tr.dataset.item) loPickItem(tr.dataset.item, true);
      else tr.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

/* ===================== ПАРК ===================== */
const MODEL_COLOR = { "WK-20": "var(--c1)", "WK-35": "var(--c2)", "WK-20C": "var(--c3)" };

/* Структура БДО по машинам WK: техместо (ТМ) и его предки, ЕО на ТМ машины (сама машина и ЕО-узлы: ковш,
   рукоять, ЭД…), заказы на узлы. Источник — data/wk_nodes.json (БДО TOPO из всех заказов PM-06 2022–2027).
   Имена промежуточных уровней в PM-06 не выгружаются: расшифровка кода — по мнемонике, сверять в SAP (IH06). */
const BDO_MNEMO = { "03": "АО «Полюс Вернинское»", "04": "АО «Полюс Алдан»", "05": "АО «Полюс Магадан»", "06": "ООО «Полюс Сухой Лог»",
  "11": "АО «Полюс Красноярск»", RUD: "рудник", KAR: "карьер", ATC: "автотранспортный цех", ZIF: "ЗИФ", VOST: "Восточный",
  BLAG: "Благодатный", UGVS: "участок горных работ «Восточный»", UGBL: "участок горных работ «Благодатный»",
  UOGR: "управление открытых горных работ", EKSK: "экскаваторный участок", OOBR: "основное оборудование", EXCV: "экскаваторы" };
function bdoLevelName(code, name) {
  if (name) return esc(name);
  const m = BDO_MNEMO[code.split("-").pop()];
  return m ? `<span class="dim" title="Расшифровка кода по мнемонике — в выгрузке PM-06 имени нет, сверять в SAP (IH06)">${esc(m)}*</span>` : '<span class="dim">—</span>';
}
function bdoFleetHtml(units) {
  const W = D.wkNodes && D.wkNodes.machines;
  if (!W) return "";
  const names = new Set(units.map(u => u.name));
  const ms = Object.entries(W).filter(([, m]) => names.has(m.unit));
  if (!ms.length) return "";
  const sum = (a, i) => a.reduce((x, o) => x + (o[i] || 0), 0);
  const head = `<h3>Структура БДО: техместо машины и единицы оборудования на нём</h3>
    <p class="hint">Техместо (ТМ) — «где стоит» (ГОК → производство → цех/карьер → участок → машина), ЕО — «что стоит» и монтируется на ТМ.
      На ТМ экскаватора кроме самой машины стоят ЕО-узлы: ковш, рукоять, асинхронные ЭД, редукторы, бортовой компьютер. Заказы на узлы
      (${num(ms.reduce((x, [, m]) => x + m.orders.length, 0))} в выбранном контексте) входят в отчёт по машине с отметкой «ЕО-узел». Источник — БДО из всех заказов PM-06 2022–2027.</p>`;
  if (ms.length > 1 || !G.unit) {
    const rows = ms.map(([tm, m]) => ({ tm, unit: m.unit, be: m.be, level: tm.split("-").length, eo: m.eo.length, nodes: m.eo.filter(e => !e[2]).length,
      n: m.orders.length, plan: sum(m.orders, 5), fact: sum(m.orders, 6) }));
    setTimeout(() => { const h = byId("bdoTable"); if (h) renderTable(h, { rows, sortKey: "plan", limit: 40,
      onRowClick: r => { G.unit = r.unit; writeHash(false); renderGlobalFilters(); renderTab(); },
      cols: [{ key: "unit", label: "Машина", cls: "wrap" }, { key: "be", label: "БЕ" }, { key: "tm", label: "Техместо", cls: "mono" },
        { key: "level", label: "Уровень", numeric: true }, { key: "eo", label: "ЕО на ТМ", numeric: true }, { key: "nodes", label: "из них узлов", numeric: true },
        { key: "n", label: "Заказов на узлы", numeric: true }, { key: "plan", label: "План узлов", numeric: true, fmt: mrub }, { key: "fact", label: "Факт узлов", numeric: true, fmt: mrub }] }); }, 0);
    return head + '<div id="bdoTable"></div><p class="hint">Строка открывает машину: цепочка техмест, ЕО и заказы на узлы.</p>';
  }
  return head + ms.map(([tm, m]) => `
    <div class="bdo-chain">${[...m.chain, [tm, m.tmName]].map(([c, n], i) => `<div class="bdo-lvl" style="margin-left:${i * 14}px"><span class="bdo-l">ур. ${i + 1}</span> <span class="mono">${esc(c)}</span> ${i === m.chain.length ? `<b>${esc(n)}</b>` : bdoLevelName(c, n)}</div>`).join("")}</div>
    <div class="twrap"><table class="toro-lines"><thead><tr><th>ЕО</th><th>Наименование</th><th>Роль</th><th class="n">Заказов</th><th>Годы</th></tr></thead><tbody>
      ${m.eo.map(e => `<tr><td class="mono">${esc(e[0])}</td><td class="toro-name">${esc(e[1])}</td><td>${e[2] ? '<span class="badge good">машина</span>' : '<span class="badge warn">ЕО-узел</span>'}</td><td class="n">${num(e[3])}</td><td>${esc(e[4].join(", "))}</td></tr>`).join("")}</tbody></table></div>
    ${m.orders.length ? `<h3>Заказы на ЕО-узлы · ${num(m.orders.length)} · план ${mrub(sum(m.orders, 5))} · факт ${mrub(sum(m.orders, 6))}</h3>
    <div class="twrap"><table class="toro-lines"><thead><tr><th>Заказ</th><th>Год</th><th>ЕО-узел</th><th>Вид</th><th>Текст заказа</th><th class="n">План МТР+УСО</th><th class="n">Факт</th></tr></thead><tbody>
      ${m.orders.slice().sort((a, b) => b[1].localeCompare(a[1]) || b[5] - a[5]).map(o => `<tr><td>${entityLink("toro", o[0], { unit: m.unit })}</td><td>${esc(o[1])}</td><td class="toro-name">${esc(o[2])}</td><td>${esc(o[3])}</td><td class="toro-name">${esc(o[4])}</td><td class="n">${rub(o[5])}</td><td class="n">${rub(o[6])}</td></tr>`).join("")}</tbody></table></div>` : '<p class="hint">Заказов на ЕО-узлы этой машины нет.</p>'}`).join('<hr class="soft">');
}
function renderFleet(host) {
  const all = D.fleet.units;
  const rows = all.filter(u => (!G.site || u.site === G.site) && (!G.model || u.model === G.model) && (!G.unit || u.name === G.unit));
  const avg = (a,k) => { const v=a.map(x=>x[k]).filter(Number.isFinite); return v.length?v.reduce((s,x)=>s+x,0)/v.length:null };
  const level = !G.site ? "site" : !G.model ? "model" : "unit";
  const groups = new Map();
  rows.forEach(u => { const key=level==='site'?u.site:level==='model'?u.model:u.name; if(!groups.has(key))groups.set(key,[]);groups.get(key).push(u) });
  const agg = [...groups].map(([key,a])=>({key,label:level==='site'?(a[0].siteName||key):key,site:a[0].site,model:a[0].model,n:a.length,ktg:avg(a,'ktg'),kio:avg(a,'kio'),book:[...new Set(a.map(x=>x.book).filter(Boolean))].join(', ')}));
  host.innerHTML = `
    <h1>Парк WK</h1>
    ${contextBanner()}
    <p class="sub">${num(rows.length)} из ${D.fleet.meta.units} единиц. Иерархия агрегации: площадка → модель → гаражный номер. Нажмите строку, чтобы перейти на следующий уровень.</p>
    <div class="kpis">${kpi('Единиц',num(rows.length))}${kpi('КТГ план',pct(avg(rows,'ktg')))}${kpi('КТГ факт',pct(avg(rows,'kio')), avg(rows,'kio') < avg(rows,'ktg') ? 'warn' : 'good')}${kpi('Связано с каталогом',num(rows.filter(x=>x.book).length)+' из '+num(rows.length),rows.some(x=>!x.book)?'warn':'good')}</div>
    ${callout("info", "В витрине TOPO <code>ktg.json</code> поле <b>p/pm — план КТГ</b>, <b>a/am — факт КТГ</b>. Это не КИО: коэффициент использования в этой выгрузке отдельно не приходит.")}
    ${rows.some(x=>!x.book) ? callout("warn", `<b>Без подтверждённой книги:</b> ${rows.filter(x=>!x.book).map(x=>esc(x.name)).join(", ")}. Книга не подставляется наугад — нужна связка заводской № → комплектация от АТ-Майнинг.`) : ""}
    <div class="card"><h3>${level==='site'?'По площадкам':level==='model'?'Модели на выбранной площадке':'Единицы выбранной модели'}</h3><div id="fleetAgg"></div></div>
    <div class="card"><h3>КТГ план и факт по месяцам</h3>
      <p class="hint">${rows.length===1 ? "Один борт: две линии — план и факт." : "Среднее по выбранным бортам. Месяцы без значения исключены, нулями график не занижается."}</p>
      <div id="fleetChart"></div>
    </div>
    <div class="card" id="fleetBdo">${bdoFleetHtml(rows)}</div>
    <div id="fleetTable"></div>
  `;
  renderTable(byId('fleetAgg'),{rows:agg,sortKey:'label',sortDir:1,onRowClick:r=>{if(level==='site')G.site=r.site;else if(level==='model')G.model=r.model;else G.unit=r.key;renderGlobalFilters();renderTab()},cols:[{key:'label',label:level==='site'?'Площадка':level==='model'?'Модель':'Единица',cls:'wrap'},{key:'n',label:'Единиц',numeric:true},{key:'book',label:'Книги',cls:'mono wrap'},{key:'ktg',label:'КТГ план',numeric:true,fmt:pct},{key:'kio',label:'КТГ факт',numeric:true,fmt:pct}]});
  const months = D.fleet.meta.months;
  const avgMonth = (key, i) => {
    const vals = rows.map(u => u[key] && u[key][i]).filter(v => v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const series = [
    { label: "КТГ план", values: months.map((_, i) => avgMonth("ktgByMonth", i)), color: "var(--c1)" },
    { label: "КТГ факт", values: months.map((_, i) => avgMonth("kioByMonth", i)), color: "var(--c5)" },
  ];
  renderLineChart(byId("fleetChart"), { months, series, yDomain: [0.5, 1] });

  renderTable(byId("fleetTable"), {
    rows, sortKey: "ktg", sortDir: 1,
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
        key: "ktgByMonth", label: "План, тренд", plain: () => "",
        fmt: (v) => v ? sparkline(v.map(x => x > 0 ? x : null), "var(--c1)") : ""
      },
      {
        key: "kioByMonth", label: "Факт, тренд", plain: () => "",
        fmt: (v) => v ? sparkline(v.map(x => x > 0 ? x : null), "var(--c5)") : ""
      },
      { key: "ktg", label: "КТГ план", numeric: true, fmt: v => v == null ? "—" : pct(v), plain: v => v == null ? "" : Math.round(v * 1000) / 1000 },
      { key: "kio", label: "КТГ факт", numeric: true, fmt: v => v == null ? "—" : pct(v), plain: v => v == null ? "" : Math.round(v * 1000) / 1000 },
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
function provBar(t, total, h, clickable) {
  const T = total || 1;
  const seg = PROV_BUCKETS.filter(b => t[b.key] > 0).map(b =>
    `<i${clickable ? ` data-sum-bucket="${b.key}" tabindex="0" role="button"` : ""} style="width:${(100 * t[b.key] / T).toFixed(2)}%;background:${b.color}" title="${esc(b.label)}: ${mrub(t[b.key])}"></i>`).join("");
  return `<div class="prov-bar${clickable ? " prov-bar-click" : ""}" style="height:${h || 10}px">${seg}</div>`;
}
// Пустые корзины в легенду и разбивку не попадают: строка «0,0 млн ₽»
// ничего не сообщает, а место занимает.
function provLegend(t, clickable) {
  return `<div class="prov-legend">` + PROV_BUCKETS.filter(b => !t || t[b.key] > 0).map(b =>
    `<span${clickable ? ` data-sum-bucket="${b.key}" tabindex="0" role="button" class="prov-leg-hit"` : ""}><i style="background:${b.color}"></i>${esc(b.label)}</span>`).join("") + `</div>`;
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

function supplyBars(rows, valueKey, labelKey, format) {
  const top = (rows || []).filter(r => (r[valueKey] || 0) > 0).slice(0, 10);
  const max = Math.max(1, ...top.map(r => r[valueKey] || 0));
  if (!top.length) return '<p class="hint">Нет данных для выбранного контекста.</p>';
  return `<div class="supply-bars">${top.map(r => `<div>
    <span title="${esc(r[labelKey])}">${esc(r[labelKey])}</span>
    <i><b style="width:${(100 * r[valueKey] / max).toFixed(1)}%"></b></i>
    <strong>${format(r[valueKey])}</strong>
  </div>`).join("")}</div>`;
}

function purchaseScheduleRows(rows) {
  const by = new Map();
  (rows || []).forEach(r => Object.entries(r.byMonth || {}).forEach(([month, qty]) => {
    const key = month || "";
    by.set(key, (by.get(key) || 0) + (+qty || 0));
  }));
  return [...by].map(([month, qty]) => ({ month, qty })).sort((a, b) => (a.month || "9999").localeCompare(b.month || "9999"));
}

let PROV_FILTER = { year: "", from: "", to: "", status: "", q: "" };
let PROV_SELECTED = null;
function provisionPass(o, partCodes, q, ge, go) {
  return globalPass(o, partCodes, ge, go)
    && (!PROV_FILTER.year || (o.years||[]).includes(PROV_FILTER.year))
    && (!PROV_FILTER.from || !o.date || o.date>=PROV_FILTER.from)
    && (!PROV_FILTER.to || !o.date || o.date<=PROV_FILTER.to)
    && (!q || normText([o.order,o.unit,o.kind,...(o.lines||[]).flatMap(l=>[l.code,l.name,l.work])].join(' ')).includes(q));
}
function globalPartCodes() {
  const partCodes = new Set();
  if (G.part && D.catalog) {
    D.catalog.items.filter(i => normArt(i.art).includes(normArt(G.part)) || normArt(i.artNew).includes(normArt(G.part)))
      .forEach(i => i.ekmtr && partCodes.add(String(i.ekmtr)));
  }
  return partCodes;
}
function globalPass(o, partCodes, ge, go) {
  if (partCodes == null) partCodes = globalPartCodes();
  if (ge == null) ge = normText(G.ekmtr);
  if (go == null) go = normText(G.order);
  return (!G.site || o.site===G.site) && (!G.model || o.model===G.model) && (!G.unit || o.unit===G.unit)
    && (!go || normText(o.order).includes(go)) && pgPass(o.order)
    && (!ge || (o.lines||[]).some(l=>normText(l.code).includes(ge)))
    && (!G.part || (o.lines||[]).some(l=>partCodes.has(String(l.code))));
}
function contextHasFilter() {
  return !!(G.site || G.model || G.unit || G.order || G.ekmtr || G.part || G.pg);
}
function contextOrders() {
  const open = (D.provision.orders || []).filter(o => globalPass(o));
  if (!G.order) return open;
  const closed = (D.provision.closedOrders || []).filter(o => globalPass(o));
  const seen = new Set(open.map(o => o.id || o.order));
  return open.concat(closed.filter(o => !seen.has(o.id || o.order)));
}
function contextLabel() {
  const bits = [];
  if (G.site) bits.push(siteNameOf(G.site) || G.site);
  if (G.model) bits.push(G.model);
  if (G.unit) bits.push(G.unit);
  if (G.order) bits.push("заказ " + G.order);
  if (G.ekmtr) bits.push("ЕКМТР " + G.ekmtr);
  if (G.part) bits.push("№ " + G.part);
  if (G.pg) bits.push("группа планирования: " + pgFilterLabel(G.pg));
  return bits.join(" · ");
}
function contextUnits() {
  return D.fleet ? D.fleet.units.filter(u =>
    (!G.site || u.site === G.site) &&
    (!G.model || u.model === G.model) &&
    (!G.unit || u.name === G.unit)
  ) : [];
}
function contextModels() { return new Set(contextUnits().map(u => u.model).filter(Boolean)); }
function contextBooks() { return new Set(contextUnits().map(u => u.book).filter(Boolean)); }
function contextNeedCodes() {
  const codes = new Set();
  contextOrders().forEach(o => (o.lines || []).forEach(l => { if (l.code) codes.add(String(l.code)); }));
  return codes;
}
function contextBanner() {
  if (!contextHasFilter()) return "";
  const pgNote = G.pg && ["stock", "purchase", "catalog", "linkone", "kb", "fleet", "codif", "inter", "cart"].includes(TAB)
    ? " Группа планирования относится к заказам ТОРО — на склад, закупку и справочники она не влияет." : "";
  return `<p class="hint">Контекст: <b>${esc(contextLabel())}</b> — таблицы и графики этой вкладки сужены.${pgNote}</p>`;
}
let LAST_CTX_KEY = null;
function contextKey() {
  return [G.site || "", G.model || "", G.unit || "", G.order || "", G.ekmtr || "", G.part || "", G.pg || ""].join("\0");
}
function syncFiltersToContext() {
  const key = contextKey();
  if (key === LAST_CTX_KEY) return;
  LAST_CTX_KEY = key;
  CAT_FILTER.model = G.model || "";
  KB_FILTER.model = G.model || "";
}
function catalogModelFits(itemModel, models) {
  if (!models || !models.size) return true;
  const parts = String(itemModel || "").split("&").map(s => s.trim()).filter(Boolean);
  if (!parts.length) return true;
  return parts.some(p => models.has(p));
}
function catalogInContext(i) {
  if (G.ekmtr && !normText(i.ekmtr || "").includes(normText(G.ekmtr))) return false;
  if (G.part && ![i.art, i.artNew].some(v => normArt(v).includes(normArt(G.part)))) return false;
  if (G.order) {
    const needed = contextNeedCodes();
    if (needed.size && (!i.ekmtr || !needed.has(String(i.ekmtr)))) return false;
  }
  if (G.site || G.model || G.unit) {
    if (!catalogModelFits(i.model, contextModels())) return false;
    if (G.unit) {
      const u = D.fleet.units.find(x => x.name === G.unit);
      if (u && u.book && (i.tree || []).length && !(i.tree || []).some(t => t.book === u.book)) return false;
    }
  }
  return true;
}
function stockInContext(i) {
  if (G.ekmtr && !String(i.code).includes(G.ekmtr)) return false;
  if (G.part) {
    const partCodes = globalPartCodes();
    if (!partCodes.has(String(i.code))) return false;
  }
  if (G.site) {
    const a = stockAtSite(i, G.site, siteNameOf(G.site));
    const needed = contextNeedCodes();
    if (!a.matched && !needed.has(String(i.code))) return false;
  } else if (G.model || G.unit || G.order) {
    const needed = contextNeedCodes();
    if (needed.size && !needed.has(String(i.code))) return false;
  }
  return true;
}
function loFocusContext() {
  if (!D.linkome || !D.linkome.byPart) return null;
  const arts = [];
  if (G.part) arts.push(G.part);
  if (G.ekmtr) {
    const cat = catalogByEkmtr(G.ekmtr);
    if (cat) arts.push(cat.art);
  }
  if (G.order) {
    const all = (D.provision.orders || []).concat(D.provision.closedOrders || []);
    const o = all.find(x => String(x.order) === String(G.order));
    (o && o.lines || []).forEach(l => {
      const cat = catalogByEkmtr(l.code);
      if (cat) arts.push(cat.art);
    });
  }
  const books = contextBooks();
  for (const art of arts) {
    const rows = D.linkome.byPart[normArt(art)];
    if (!rows || !rows.length) continue;
    const hit = (books.size ? rows.find(r => books.has(r.book)) : null) || rows[0];
    if (hit) return hit;
  }
  return null;
}
function openSchemeOr(fallback) {
  writeHash(false);
  renderGlobalFilters();
  const go = () => {
    const hit = loFocusContext();
    if (hit) {
      LO.book = hit.book;
      LO.current = hit.page;
      LO.index = null;
      LO.focusRaw = hit.raw;
      navigateTo("linkone");
    } else {
      navigateTo(fallback || "catalog");
    }
  };
  if (!D.linkome) {
    ensureData(["linkome", "linkomeDraw"]).then(go).catch(() => navigateTo(fallback || "catalog"));
  } else go();
}
function schemePanelHtml() {
  const hit = loFocusContext();
  const art = G.part || (catalogByEkmtr(G.ekmtr) || {}).art || (hit && hit.raw) || "";
  const drawings = art && D.drawings && D.drawings.byNum && D.drawings.byNum[art];
  const sheets = hit && D.linkomeDraw && D.linkomeDraw.byPage
    ? (D.linkomeDraw.byPage[`${hit.book}|${String(hit.page || "").toUpperCase()}`] || [])
    : [];
  if (!hit && !drawings && !sheets.length) return "";
  const img = (sheets[0] && sheets[0].file) || "";
  return `<section class="card scheme-panel">
    <div class="prov-card-head"><div>
      <h3>Схема из каталога</h3>
      <p class="hint">${esc(hit ? (hit.pageTitle || hit.page) : art)} · ${esc(hit && hit.book || "")}${hit && hit.name ? " · " + esc(hit.name) : ""}</p>
    </div>
    ${hit ? `<button class="minibtn" type="button" id="schemeOpenLo">Открыть в LinkOne</button>` : ""}
    </div>
    ${img ? `<img class="scheme-img" src="${esc(img)}" alt="Чертёж ${esc(art)}"/>` : drawings ? `<p class="hint">${num(drawings.length)} файл(ов) чертежа в базе знаний.</p>` : ""}
  </section>`;
}
function provisionOrderRows() {
  const partCodes = new Set();
  if (G.part) D.catalog.items.filter(i => normArt(i.art).includes(normArt(G.part)) || normArt(i.artNew).includes(normArt(G.part))).forEach(i => i.ekmtr && partCodes.add(String(i.ekmtr)));
  const q = normText(PROV_FILTER.q), ge = normText(G.ekmtr), go = normText(G.order);
  const wantClosed = PROV_FILTER.status === "closed" || !!go || (!!q && /^\d{7,}$/.test(q.trim()));
  const open = (D.provision.orders || []).filter(o => provisionPass(o, partCodes, q, ge, go) && (!PROV_FILTER.status || PROV_FILTER.status === "closed" || o.status===PROV_FILTER.status));
  if (!wantClosed && PROV_FILTER.status !== "closed") return open;
  const closed = (D.provision.closedOrders || []).filter(o => provisionPass(o, partCodes, q, ge, go));
  if (PROV_FILTER.status === "closed") return closed;
  const seen = new Set(open.map(o => o.id));
  return open.concat(closed.filter(o => !seen.has(o.id)));
}
function provisionOrderTotals(orders) {
  const t={value:0,qty:0,lines:0}; for(const k of ['fromStock','fromBuy','late','undated','gap','transferPotential']){t[k]=0;t[k+'Qty']=0}
  orders.forEach(o=>{t.value+=o.value;t.qty+=o.qty;t.lines+=o.lines.length;for(const k of ['fromStock','fromBuy','late','undated','gap','transferPotential']){t[k]+=o[k]||0;t[k+'Qty']+=o[k+'Qty']||0}}); return t;
}
function provisionOrderCut(orders,keyfn){const m=new Map;orders.forEach(o=>{const k=keyfn(o);if(!m.has(k))m.set(k,[]);m.get(k).push(o)});return [...m].map(([key,a])=>({key,...provisionOrderTotals(a)})).sort((a,b)=>String(a.key).localeCompare(String(b.key),'ru'))}
/* Статусы SAP в витрине обеспеченности (PM06_STATUSES.md): стадия жизненного
   цикла заказа, признак ППМ строк и что снято правилами статусов. */
const PPM_LABEL={immediate:'Немедленно — закупка видит',onRelease:'Начиная с деблокирования — закупка пока не видит',never:'Никогда — в закупку не попадает'};
function stageLabel(key){const st=((D.provision.meta||{}).stages||[]).find(x=>x.key===key);return st?st.label:(key||'—')}
function executionContextRows(){
  return (D.provision.execution||[]).filter(r=>(!G.site||r.site===G.site)&&(!G.model||r.model===G.model)&&(!G.unit||r.unit===G.unit)&&(!G.order||String(r.order)===String(G.order))&&pgPass(r.order));
}
function executionFunnelHtml(){
  const rows=executionContextRows(); if(!rows.length) return '';
  const stages=(D.provision.meta.stages||[]).filter(s=>s.key!=='unknown'||rows.some(r=>r.stage==='unknown'));
  const years=[...new Set(rows.map(r=>r.year))].sort();
  const block=y=>{
    const inPlan=rows.filter(r=>r.year===y&&r.stage!=='noOrder'&&!r.copyOriginal);
    const tot=inPlan.reduce((a,r)=>a+r.plan,0)||1, done=inPlan.filter(r=>['techClosed','rejected','accepted','billed','closed'].includes(r.stage));
    const by=new Map(stages.map(s=>[s.key,{n:0,plan:0,fact:0}]));
    inPlan.forEach(r=>{const b=by.get(r.stage)||by.get('unknown');if(b){b.n++;b.plan+=r.plan;b.fact+=r.fact}});
    const noOrder=rows.filter(r=>r.year===y&&r.stage==='noOrder'), copies=rows.filter(r=>r.year===y&&r.copyOriginal&&r.stage!=='noOrder');
    const body=stages.map((s,i)=>{const b=by.get(s.key);if(!b||!b.n)return'';const share=b.plan/tot;
      // одна шкала акцентного цвета: чем дальше стадия, тем насыщеннее
      const op=(0.3+0.7*i/Math.max(1,stages.length-2)).toFixed(2);
      return `<tr title="${esc(s.label)} · ${num(b.n)} заказов · план ${mrub(b.plan)} · факт ${mrub(b.fact)}"><td class="wrap exec-stage">${esc(s.label)}</td><td class="n">${num(b.n)}</td><td class="n">${mrub(b.plan)}</td><td class="n">${mrub(b.fact)}</td><td class="n" style="white-space:nowrap"><span class="bar stage-bar"><i style="width:${(100*share).toFixed(1)}%;opacity:${op}"></i></span> ${num(100*share,0)}%</td></tr>`}).join('');
    return `<div><h3>${esc(y)}: ${num(inPlan.length)} заказов, план ${mrub(tot)}</h3>
      <p class="sub">Закрыто (ТЗКР и далее): ${num(done.length)} заказов, ${num(100*done.reduce((a,r)=>a+r.plan,0)/tot,0)}% плана.</p>
      <div class="twrap"><table><thead><tr><th>Стадия</th><th class="n">Заказов</th><th class="n">План</th><th class="n">Факт</th><th class="n">Доля плана</th></tr></thead><tbody>${body}</tbody></table></div>
      ${noOrder.length?`<p class="hint">Вне плана: ${num(noOrder.length)} позиций графика ППР без заказа SAP на ${mrub(noOrder.reduce((a,r)=>a+r.plan,0))} — не заказы, в план и потребность не входят.</p>`:''}
      ${copies.length?`<p class="hint">Не учтены: ${num(copies.length)} оригиналов БЕ, перенесённых копией в «Развитие» (план ${mrub(copies.reduce((a,r)=>a+r.plan,0))}, факт ${mrub(copies.reduce((a,r)=>a+r.fact,0))}) — их план несёт копия.</p>`:''}</div>`;
  };
  return `<h2>Исполнение программы ремонтов по статусам SAP</h2>
    <p class="sub">Все заказы WK выгрузки PM-06 по стадиям жизненного цикла: фаза ОТКР → ДЕБЛ → ТЗКР → ЗАКР и пользовательские статусы согласования и приёмки. План и факт — МТР и УСО заказа. Контекст (площадка, машина) учитывается.</p>
    <div class="exec-grid">${years.map(block).join('')}</div>`;
}
function ppmVisibilityHtml(orders){
  const acc=new Map();
  orders.forEach(o=>(o.lines||[]).forEach(l=>{const y=(o.years||[])[0]||'',k=y+'|'+(l.ppm||'immediate');const a=acc.get(k)||{year:y,ppm:l.ppm||'immediate',value:0,stock:0,buy:0,late:0,gap:0,orders:new Set()};
    a.value+=l.value;a.stock+=l.fromStockValue||0;a.buy+=l.fromBuyValue||0;a.late+=(l.lateValue||0)+(l.undatedValue||0);a.gap+=l.gapValue||0;a.orders.add(o.order);acc.set(k,a)}));
  const rows=[...acc.values()].sort((a,b)=>a.year.localeCompare(b.year)||['immediate','onRelease','never'].indexOf(a.ppm)-['immediate','onRelease','never'].indexOf(b.ppm));
  if(!rows.length||rows.every(r=>r.ppm==='immediate')&&!D.provision.meta.sapStatus) return '';
  return `<h2>Видит ли закупка потребность</h2>
    <p class="sub">Признак «Резерв./заявка» строки заказа — релевантность для ППМ. «Начиная с деблокирования»: потребность попадёт в закупку только после деблокирования заказа. «Никогда»: в закупочную заявку не попадает, покрыть её может только склад — поэтому приходы закупки таким строкам не распределяются.</p>
    <div class="twrap"><table><thead><tr><th>Год</th><th>Признак ППМ</th><th class="n">Заказов</th><th class="n">Потребность</th><th class="n">Со склада</th><th class="n">Закупка к сроку</th><th class="n">Закупка позже / без срока</th><th class="n">Не покрыто</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td>${esc(r.year)}</td><td>${esc(PPM_LABEL[r.ppm]||r.ppm)}</td><td class="n">${num(r.orders.size)}</td><td class="n">${mrub(r.value)}</td><td class="n">${mrub(r.stock)}</td><td class="n">${mrub(r.buy)}</td><td class="n">${r.late>0?mrub(r.late):'—'}</td><td class="n">${r.gap>0?`<b style="color:var(--bad)">${mrub(r.gap)}</b>`:'—'}</td></tr>`).join('')}
    </tbody></table></div>`;
}
function sapRemovedHtml(m){
  const r=m.sapRemoved||{}; if(!m.sapStatus) return '';
  const part=(k,t)=>r[k]&&r[k].orders?`<li>${t}: ${num(r[k].orders)} заказов, ${mrub(r[k].value)}</li>`:'';
  return callout('info',`Потребность очищена по статусам заказов SAP из исходных выгрузок PM-06:<ul>
    ${part('planPosition','позиции графика ППР без заказа — не заказы и вне плана')}
    ${part('closedInSap','заказ закрыт в SAP (ТЗКР или ЗАКР) — остаток «план − факт» не потребность')}
    ${part('migrationCopy','оригинал БЕ перенесён копией в «Развитие» — его план несёт копия')}</ul>`);
}
function provisionMonthChart(orders){const by=new Map;orders.forEach(o=>{const k=o.date?o.date.slice(0,7):'без даты';if(!by.has(k))by.set(k,[]);by.get(k).push(o)});const rows=[...by].map(([month,a])=>({month,...provisionOrderTotals(a),orders:a.length})).sort((a,b)=>a.month.localeCompare(b.month)),max=Math.max(1,...rows.map(r=>r.value));return `<div class="prov-months">${rows.map(r=>`<button data-prov-month="${esc(r.month)}" title="${esc(r.month)} · ${num(r.orders)} заказов · ${mrub(r.value)}"><b>${esc(r.month.replace(/^20/,''))}</b><i style="height:${Math.max(3,100*r.value/max)}%"></i><span>${num(r.orders)}</span></button>`).join('')}</div>`}

function usoForOrder(order) {
  return ((D.usoWk && D.usoWk.orders) || []).filter(o => String(o.order) === String(order));
}
function usoContextOrders() {
  return ((D.usoWk && D.usoWk.orders) || []).filter(o =>
    (!G.site || o.site === G.site) &&
    (!G.model || o.model === G.model) &&
    (!G.unit || o.unit === G.unit) &&
    (!G.order || String(o.order).includes(String(G.order))) && pgPass(o.order)
  );
}
function usoTotals(rows) {
  return (rows || []).reduce((t, o) => { const u = usoStatusOf(o); return {
    orders: t.orders + 1, closed: t.closed + (u.closed ? 1 : 0),
    planValue: t.planValue + u.plan, factValue: t.factValue + u.sapFact, openValue: t.openValue + u.open,
  }; }, { orders: 0, closed: 0, planValue: 0, factValue: 0, openValue: 0 });
}
function usoBlockHtml(list) {
  if (!list || !list.length) return "";
  return `<div class="card" style="margin-top:10px">${list.map(u => `<p class="hint">${esc(u.be || "")} · завод подрядчика ${esc(u.plant)} → ${esc(u.siteName || u.site)} · ${esc(u.month || "")}. Это материалы из реестра «МТР УСО», не остаток склада Полюса.</p>` + usoLinesHtml([u])).join("")}</div>`;
}

function renderProvision(host) {
  const m = D.provision.meta, orders = provisionOrderRows(), w = provisionOrderTotals(orders);
  const T = w.value || 1;
  const sites = { ...((D.fleet && D.fleet.meta && D.fleet.meta.sites) || {}), "2400": "Сухой Лог" };
  const f = m.feasible || {};
  const fv = k => (f[k] && f[k].value) || 0;
  const gapTotal = w.late + w.undated + w.gap;
  const feasibilityGap = m.wk.late + m.wk.undated + m.wk.gap;
  const eta = new Date(m.asOf + "T00:00:00");
  eta.setDate(eta.getDate() + (m.leadMedianDays || 0));
  const etaStr = dmy(eta.toISOString().slice(0, 10));
  const audit = provisionAudit(m, D.provision.items, D.stock.items);
  const auditOk = Math.abs(audit.qtyDelta) < .01 && Math.abs(audit.valueDelta) < .1 && !audit.badBalance && !audit.stockOver && !audit.buyOver;
  const um = (D.usoWk && D.usoWk.meta) || {};
  const usoRowsAll = usoContextOrders();
  const ut = usoTotals(usoRowsAll);
  const closedN = (D.provision.closedOrders || []).filter(o => globalPass(o)).length;
  const scopedFeas = contextScopedItems();
  const feasInTime = scopedFeas.reduce((s, i) => s + (i.canOrder || 0), 0);
  const feasTooLate = scopedFeas.reduce((s, i) => s + (i.tooLate || 0), 0);
  const feasInTimeN = scopedFeas.filter(i => (i.canOrder || 0) > 0).length;
  const feasTooLateN = scopedFeas.filter(i => (i.tooLate || 0) > 0).length;
  const pmPlan = orders.reduce((s, o) => s + (o.planValue || 0), 0);
  const pmFact = orders.reduce((s, o) => s + (o.factValue || 0), 0);

  /* Разрез по годам с их статусом — иначе один итог по 2026-2027 читается
     как текущий кризис. На деле открытый год обеспечен почти полностью, а
     весь дефицит — это план ненаступившего года, по которому закупка ещё
     не начиналась. Статус берём из витрины (правило TOPO: год без факта —
     «план»), а суммы считаем по отфильтрованным заказам, чтобы разрез
     уважал контекст, как остальные блоки вкладки. */
  const yearStatus = {};
  (m.byYear || []).forEach(r => { if (r.status) yearStatus[String(r.key)] = r.status; });
  const yearCut = provisionOrderCut(orders, o => String((o.years || [])[0] || "без года"));
  const YEAR_HINT = {
    "план": "год не начался: факта нет ни по одной площадке, закупка под него ещё не размещалась",
    "открыт": "год идёт: факт продолжает поступать, цифры ещё изменятся",
    "закрыт": "год завершён: факт сформирован полностью",
  };


  host.innerHTML = `
    <h1>Обеспеченность плана ТОиР 2026–2027</h1>
    ${contextBanner()}
    ${schemePanelHtml()}
    <p class="sub">${num(orders.length)} открытых заказов в текущем контексте, ${num(w.lines)} строк потребности.
      План и факт PM-06 слиты в зерно «заказ × материал» — закрытый заказ больше не висит дефицитом.
      Покрытие — доступный остаток Полюса и уже размещённая закупка. Данные на ${dmy(m.asOf)}.</p>
    ${callout("info", `В SAP план и факт одной позиции — <b>разные строки</b> (qp на одной, qf на другой). Без слияния закрытый заказ висит дефицитом: так выглядел 1200407027 (WK-20C №6, Магадан, 24.07.2026) — все 5 МТР уже с фактом. Введите номер в «Заказ» или фильтр «Закрытые (факт или SAP)». МТР подрядчика (УСО) — отдельная выгрузка, её коды не обязаны совпадать с МТР Полюса.`)}
    <div class="kpis">
      ${kpi("Открытых заказов", num(orders.filter(o=>o.status!=='closed').length))}
      ${kpi("Закрытых фактом", num(closedN), "good")}
      ${kpi("Потребность WK", mrub(w.value))}
      ${kpi("Обеспечено к сроку", mrub(w.fromStock + w.fromBuy) + ` <span class="kpi-sub">${num(100 * (w.fromStock + w.fromBuy) / T, 0)}%</span>`, "good")}
      ${kpi("Возможность перемещения*", mrub(provTransfer(orders)) + ` <span class="kpi-sub">не входит</span>`, "")}
      ${kpi("Не обеспечено", mrub(gapTotal) + ` <span class="kpi-sub">${num(100 * gapTotal / T, 0)}%</span>`, "bad")}
    </div>
    ${callout("info", `Склад привязан к площадке (по заводу строки остатков) и покрывает только <b>свою</b> площадку. *Перемещение между площадками ограничено, поэтому в обеспеченность не входит. Отдельно показана <b>возможность</b> её улучшить: запас других площадок, оставшийся после их собственной потребности, против непокрытого к сроку — <b>${mrub(provTransfer(orders))}</b> в выбранном контексте. Это верхняя оценка: логистика и согласование перемещения не учтены.`)}
    ${yearCut.length > 1 ? `
    <h2>Обеспеченность по годам плана</h2>
    <p class="sub">Итог выше складывает два разных года. Открытый год — это то, что обеспечивается
      сейчас; год со статусом «план» ещё не начался, и незакрытая потребность по нему — не срыв,
      а объём предстоящей закупки.</p>
    <div class="twrap"><table><thead><tr>
      <th>Год</th><th>Статус</th><th class="n">Потребность</th><th class="n">Со склада</th>
      <th class="n">Закупка к сроку</th><th class="n">Обеспечено</th><th class="n">Дефицит</th><th class="n" title="Перемещение ограничено: в обеспеченность не входит">Можно перемещением*</th>
    </tr></thead><tbody>${yearCut.map(r => {
      const t = r.value || 1, on = r.fromStock + r.fromBuy, st = yearStatus[String(r.key)] || "";
      const tone = st === "план" ? "n" : st === "открыт" ? "w" : "g";
      return `<tr><td><b>${esc(r.key)}</b></td>
        <td>${st ? `<span class="tag ${tone}" title="${esc(YEAR_HINT[st] || "")}">${esc(st)}</span>` : "—"}</td>
        <td class="n">${mrub(r.value)}</td><td class="n">${mrub(r.fromStock)}</td>
        <td class="n">${mrub(r.fromBuy)}</td>
        <td class="n"><b>${num(100 * on / t, 0)}%</b></td>
        <td class="n">${mrub(r.gap)}</td>
        <td class="n">${r.transferPotential > 0 ? `${mrub(r.transferPotential)} <span class="dim">→ до ${num(100 * (on + r.transferPotential) / t, 0)}%</span>` : "—"}</td></tr>`;
    }).join("")}</tbody></table></div>` : ""}
    ${sapRemovedHtml(m)}
    ${ppmVisibilityHtml(orders)}
    ${executionFunnelHtml()}
    ${um.orders ? `<div class="kpis">
      ${kpi("Заказов УСО WK", num(ut.orders))}
      ${kpi("МТР подрядчика, план (состав)", mrub(ut.planValue))}
      ${kpi("Факт в заказах SAP", mrub(ut.factValue), "good")}
      ${kpi("Не закрыто (заказ ТОРО открыт)", mrub(ut.openValue) + ` <small>${num(ut.orders - ut.closed)} зак.</small>`, ut.openValue > 0 ? "warn" : "good")}
    </div>
    <p class="hint">KPI УСО — по выбранному контексту. Состав, количество, цена и сумма — реестр МТР УСО (АО «Развитие», заводы 7101–7104); статус — по заказу ТОРО (не закрыт заказ — не закрыто УСО), факт — строка PM‑06 «ТОиР. Материалы подрядчика». «Стоимость факт» реестра — плановая цена в валюте по курсу, как факт не используется. МТР подрядчика не смешиваются с остатком Полюса и не закрывают дефицит.</p>` : ""}

    <section class="card">
      <div class="prov-card-head"><div><h3>План, фактический расход и открытая потребность</h3><p class="hint">PM‑06 и УСО — для текущего контекста. PM‑06 включает закрытые строки выбранных заказов, но только номенклатуру WK из витрины. Смешивать их в одну сумму нельзя.</p></div></div>
      <div class="twrap"><table class="supply-ledger"><thead><tr><th>Контур</th><th class="n">План</th><th class="n">Факт</th><th class="n">Исполнение</th><th class="n">Открыто</th></tr></thead><tbody>
        <tr><th>МТР Полюса, PM‑06 (WK)</th><td class="n">${rub(pmPlan)}</td><td class="n">${rub(pmFact)}</td><td class="n">${pmPlan > 0 ? num(100 * pmFact / pmPlan, 1) + "%" : "—"}</td><td class="n"><b>${rub(w.value)}</b></td></tr>
        ${um.orders ? `<tr><th>МТР подрядчика, УСО (факт — в заказах SAP, открыто — заказ ТОРО не закрыт)</th><td class="n">${rub(ut.planValue)}</td><td class="n">${rub(ut.factValue)}</td><td class="n">${ut.planValue > 0 ? num(100 * ut.factValue / ut.planValue, 1) + "%" : "—"}</td><td class="n"><b>${rub(ut.openValue)}</b></td></tr>` : ""}
      </tbody></table></div>
    </section>

    <div class="prov-order-filters">
      <label>Год<select id="provYear"><option value="">Все</option>${['2026','2027'].map(y=>`<option${PROV_FILTER.year===y?' selected':''}>${y}</option>`).join('')}</select></label>
      <label>Период с<input id="provFrom" type="date" value="${esc(PROV_FILTER.from)}"></label>
      <label>по<input id="provTo" type="date" value="${esc(PROV_FILTER.to)}"></label>
      <label>Статус<select id="provOrderStatus"><option value="">Открытые</option><option value="full"${PROV_FILTER.status==='full'?' selected':''}>Полностью</option><option value="partial"${PROV_FILTER.status==='partial'?' selected':''}>Частично</option><option value="none"${PROV_FILTER.status==='none'?' selected':''}>Не обеспечен</option><option value="closed"${PROV_FILTER.status==='closed'?' selected':''}>Закрытые (факт или SAP)</option></select></label>
      <label class="wide">Поиск<input id="provOrderQ" value="${esc(PROV_FILTER.q)}" placeholder="заказ, машина, ЕКМТР, деталь"></label>
      <button class="minibtn" id="provOrderReset">Сбросить период</button>
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

    <section class="card"><div class="prov-card-head"><div><h3>Обеспеченность заказов по месяцу начала работ</h3><p class="hint">Столбцы кликабельны: нажатие отбирает месяц и открывает реестр заказов.</p></div></div>${provisionMonthChart(orders)}</section>
    <section class="card"><h3>Плановые заказы</h3><div id="provOrders"></div><div id="provOrderDetail"></div></section>
    ${um.orders ? `<section class="card"><h3>МТР подрядчика (УСО) по парку WK</h3>
      <p class="hint">Источник TOPO <code>rawdata/УСО/МТР УСО {год} all.xlsx</code> → uso_mtr.json. Заводы 7101–7104 — АО «Развитие»; заказчик — Полюс. Это не остаток склада и не прайс ДП. Коды в УСО часто другие, чем МТР заказа PM-06 (в 1200407027 УСО закрыло выключатель и засов, а насос/рычаг/втулка/цепь/болт закрыты фактом Полюса).</p>
      <div id="usoTable"></div></section>` : ""}

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
        ${provisionArrivalChart(
          contextHasFilter()
            ? purchaseScheduleRows(D.stock.items.filter(stockInContext).map(i => i.purchase).filter(Boolean))
            : m.arrivals,
          m.asOf
        )}
      </section>
    </div>

    <h2>Сроки: что ещё можно закрыть заказом сегодня</h2>
    <p class="hint">${contextHasFilter() ? "Прогноз по позициям выбранного контекста." : "Прогноз срока поставки по полной витрине WK; фильтры заказов выше применяются к обеспеченности и реестру."}</p>
    <p class="sub">Медианный фактический срок поставки по номенклатуре WK — <b>${num(m.leadMedianDays)} дн.</b>
      (${num(m.leadMeasurements)} замеров «дата поставки − дата заявки» по ${num(m.leadCodes)} кодам той же выгрузки закупки).
      Заказ, размещённый на дату выгрузки, приходит около <b>${etaStr}</b>. Для позиции со своей статистикой берётся её собственный срок.</p>
    <table class="prov-cut wide"><tbody>
      ${contextHasFilter()
        ? `<tr><th><span class="badge good">Успеем, если заказать сейчас</span></th><td class="n">${mrub(feasInTime)}</td><td class="n">${num(feasInTimeN)} поз.</td></tr>
           <tr><th><span class="badge bad">Заказывать уже поздно</span></th><td class="n">${mrub(feasTooLate)}</td><td class="n">${num(feasTooLateN)} поз.</td></tr>`
        : [["inTime", "Успеем, если заказать сейчас", "good"],
           ["late3", "Не успеем, опоздание до 3 мес.", "warn"],
           ["lateMore", "Не успеем, опоздание больше 3 мес.", "bad"],
           ["past", "Срок работ уже прошёл", "bad"],
           ["nodate", "Срок работ не проставлен", ""]]
          .filter(([k]) => f[k]).map(([k, label, cls]) => `<tr>
            <th><span class="badge ${cls}">${esc(label)}</span></th>
            <td class="n">${mrub(f[k].value)}</td>
            <td class="n">${num(100 * f[k].value / (feasibilityGap || 1), 0)}% дефицита</td>
            <td class="n">${num(f[k].lines)} строк</td>
          </tr>`).join("")}
    </tbody></table>

    <h2>Разрезы</h2>
    <div class="prov-cuts">
      <div><h3>По году плана</h3>${provCut(provisionOrderCut(orders,o=>o.years.join(', ')))}</div>
      <div><h3>По сроку начала работ</h3>${provCut(provisionOrderCut(orders,o=>o.date?o.date.slice(0,7):'без срока'))}</div>
      <div><h3>По площадкам</h3>${provCut(provisionOrderCut(orders,o=>o.site), k => sites[k] ? k + " " + sites[k] : k)}</div>
      <div><h3>По виду затрат</h3>${provCut(provisionOrderCut(orders,o=>o.kind||'не присвоено'))}</div>
    </div>

    <h2>Позиции</h2>
    <p class="sub">${num(contextHasFilter() ? contextNeedCodes().size : m.positions)} позиций номенклатуры WK в текущем срезе. Прочие материалы (ГСМ, общий крепёж, общие МТР)
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

  const rerenderProvision = () => renderProvision(host);
  const schemeBtn = byId("schemeOpenLo");
  if (schemeBtn) schemeBtn.onclick = () => {
    const hit = loFocusContext();
    if (hit) { LO.book = hit.book; LO.current = hit.page; LO.index = null; LO.focusRaw = hit.raw; }
    navigateTo("linkone");
  };
  for (const [id,key] of [['provYear','year'],['provFrom','from'],['provTo','to'],['provOrderStatus','status']]) byId(id).onchange=e=>{PROV_FILTER[key]=e.target.value;PROV_SELECTED=null;rerenderProvision()};
  byId('provOrderQ').oninput=debounce(e=>{PROV_FILTER.q=e.target.value;PROV_SELECTED=null;rerenderProvision()},180);
  byId('provOrderReset').onclick=()=>{PROV_FILTER={year:'',from:'',to:'',status:'',q:''};PROV_SELECTED=null;rerenderProvision()};
  qsa('[data-prov-month]',host).forEach(b=>b.onclick=()=>{const month=b.dataset.provMonth;if(month==='без даты'){PROV_FILTER.from='';PROV_FILTER.to=''}else{const [y,mn]=month.split('-').map(Number),last=new Date(Date.UTC(y,mn,0)).getUTCDate();PROV_FILTER.year=String(y);PROV_FILTER.from=`${month}-01`;PROV_FILTER.to=`${month}-${String(last).padStart(2,'0')}`}PROV_SELECTED=null;rerenderProvision()});
  renderTable(byId('provOrders'),{rows:orders,limit:100,sortKey:'date',sortDir:1,csv:true,csvName:'wk_provision_orders.csv',onRowClick:o=>{PROV_SELECTED=o.id;showOrder(o)},cols:[
    {key:'date',label:'Начало'},{key:'site',label:'Площадка',fmt:v=>esc(sites[v]||v)},{key:'unit',label:'Машина',cls:'wrap'},{key:'order',label:'Заказ'},{key:'stage',label:'Стадия SAP',cls:'wrap',plain:v=>stageLabel(v),fmt:v=>v?`<span class="dim">${esc(stageLabel(v))}</span>`:'<span class="dim">—</span>'},{key:'method',label:'Способ',fmt:v=>v?esc(v):'<span class="dim">—</span>'},{key:'status',label:'Статус',fmt:(v,r)=>r.closed||v==='closed'?(r.sapReason==='closedInSap'?'<span class="badge good">закрыт в SAP</span>':r.sapReason==='migrationCopy'?'<span class="badge info">перенесён копией</span>':'<span class="badge good">закрыт фактом</span>'):v==='full'?'<span class="badge good">обеспечен</span>':v==='none'?'<span class="badge bad">не обеспечен</span>':'<span class="badge warn">частично</span>'},{key:'kind',label:'Вид затрат',cls:'wrap'},{key:'value',label:'Открыто',numeric:true,fmt:(v,r)=>r.closed?rub(0):rub(v)},{key:'coverage',label:'Обеспеченность',numeric:true,fmt:(v,r)=>`<span class="prov-cover"><i style="width:${Math.min(100,v)}%"></i></span><small>${num(v,0)}%</small>`},{key:'gap',label:'Не покрыто',numeric:true,plain:(v,r)=>r.late+r.undated+r.gap,fmt:(v,r)=>r.closed?'—':mrub(r.late+r.undated+r.gap)}
  ]});
  function showOrder(o){
    const box=byId('provOrderDetail'); if(!box) return;
    G.order = o.order; G.unit = o.unit || G.unit; G.site = o.site || G.site;
    writeHash(false);
    const uso = usoForOrder(o.order);
    const closed = o.closed || o.status === "closed";
    box.innerHTML=`<div class="prov-order-detail"><div class="prov-card-head"><div><h3>Заказ ${esc(o.order)} · ${esc(o.unit)}</h3><p class="hint">${esc(sites[o.site]||o.site)} · начало ${dmy(o.date)} · ${esc(o.method||"")} · ${closed ? (o.sapReason==='closedInSap' ? "закрыт в SAP" : o.sapReason==='migrationCopy' ? "перенесён копией в «Развитие»" : "закрыт фактом PM-06") : num(o.lines.length)+" открытых строк МТР"}.</p></div><button class="minibtn" data-close-prov>Закрыть</button></div>
      ${o.stage?`<p class="hint">Стадия SAP: <b>${esc(stageLabel(o.stage))}</b>.</p>`:''}
      ${closed ? callout("good", o.sapReason==='closedInSap' ? `План ${rub(o.planValue)} · факт ${rub(o.factValue)}. Заказ закрыт в SAP (ТЗКР/ЗАКР): остаток «план − факт» больше не спишут, это не потребность.` : o.sapReason==='migrationCopy' ? `План ${rub(o.planValue)} · факт ${rub(o.factValue)}. Заказ перенесён копией в АО «Развитие»: неисполненный план несёт копия, здесь он не считается.` : `План ${rub(o.planValue)} · факт ${rub(o.factValue)}. Открытой потребности нет: qp и qf жили на соседних строках SAP, после слияния remaining = 0. Это не «не обеспечено».`) : provBar(o,o.value||1,11)+provLegend(o)}
      <div id="provOrderLines"></div><div id="provOrderUso">${usoBlockHtml(uso)}</div></div>`;
    renderTable(byId('provOrderLines'),{rows:o.lines,limit:200,sortKey:'value',csv:true,csvName:`order_${o.order}_provision.csv`,onRowClick:l=>openCodeDetail(l.code, o.date),cols:[
      {key:'work',label:'Вид работ',cls:'wrap'},
      {key:'code',label:'ЕКМТР',cls:'mono',fmt:v=>codeLink(v)},
      {key:'name',label:'Деталь',cls:'wrap'},
      {key:'code',label:'Цена ДП',numeric:true,plain:(v)=>{const c=catalogByEkmtr(v);return c&&c.priceCNY||"";},fmt:(v)=>{const c=catalogByEkmtr(v);return c&&c.priceCNY!=null?cny(c.priceCNY)+ (getRate()?`<span class="sup-sub">${rub(c.priceCNY*getRate())}</span>`:""):'<span class="dim">нет в прайсе</span>';}},
      {key:'value',label:'Открытая сумма',numeric:true,fmt:rub},
      {key:'planQty',label:'План',numeric:true,fmt:(v,r)=>num(r.planQty,3)},
      {key:'factQty',label:'Факт',numeric:true,fmt:(v,r)=>num(r.factQty,3)},
      {key:'qty',label:'Ещё нужно',numeric:true,fmt:v=>num(v,3)},
      {key:'fromStock',label:'Склад',numeric:true,fmt:(v,r)=>{const st=STOCK_BY_CODE.get(String(r.code)); return `${num(v,3)}${st?`<div class="sup-sub">${warehouseHtml(st.byWarehouse,o.site)}</div>`:""}`;}},
      {key:'code',label:'Закупка',cls:'wrap',plain:(v,r)=>{const st=STOCK_BY_CODE.get(String(v)); const vs=purchaseAgainstDate(st&&st.purchase, r.date||o.date); return vs.label;},fmt:(v,r)=>{
        const st=STOCK_BY_CODE.get(String(v)); const vs=purchaseAgainstDate(st&&st.purchase, r.date||o.date);
        if(vs.status==='none') return '<span class="badge bad">не заказано</span>';
        const cls=vs.status==='onTime'?'good':vs.status==='late'?'warn':'info';
        return `<span class="badge ${cls}">${esc(vs.label)}</span><div class="sup-sub">${purchaseMonthsHtml(st&&st.purchase)}${vs.supplier? " · "+esc(vs.supplier):""}</div>`;
      }},
      {key:'fromBuy',label:'К сроку ATP',numeric:true,fmt:v=>num(v,3)},
      {key:'transferPotential',label:'Можно переместить*',numeric:true,plain:v=>v||0,fmt:(v,r)=>v>0?`${num(v,3)}${transferNote(r)}`:'—'},
      {key:'gap',label:'Не покрыто ATP',numeric:true,plain:(v,r)=>r.late+r.undated+r.gap,fmt:(v,r)=>{const g=r.late+r.undated+r.gap; return g>0?`<b style="color:var(--bad)">${num(g,3)}</b>`:"—";}},
      {key:'code',label:'',plain:()=>'',fmt:(v,r)=>cartAddBtn({code:v,name:r.name,value:r.value,source:`Заказ ${o.order}`,order:o.order,unit:o.unit,site:o.site})}
    ]});
    wireCartButtons(byId('provOrderLines'));
    wireCodeLinks(box);
    qs('[data-close-prov]',box).onclick=()=>{PROV_SELECTED=null;box.innerHTML=''};
    box.scrollIntoView({behavior:'smooth',block:'nearest'});
  }
  if(PROV_SELECTED){const selected=orders.find(o=>o.id===PROV_SELECTED)||(D.provision.closedOrders||[]).find(o=>o.id===PROV_SELECTED);if(selected)showOrder(selected)}
  else if(G.order){
    const found=orders.find(o=>String(o.order)===String(G.order))
      || (D.provision.closedOrders||[]).find(o=>String(o.order)===String(G.order));
    if(found) showOrder(found);
    else {
      const uso=usoForOrder(G.order);
      const box=byId('provOrderDetail');
      if(box && uso.length){
        box.innerHTML = callout("good", `Заказ <b>${esc(G.order)}</b> не в открытой потребности WK. Ниже — МТР подрядчика по этому заказу.`) + usoBlockHtml(uso);
        wireCodeLinks(box);
      } else if (box) {
        box.innerHTML = callout("info", `Заказ <b>${esc(G.order)}</b> не найден среди открытых/закрытых строк WK и не найден в срезе УСО.`);
      }
    }
  }
  if (byId("usoTable") && D.usoWk) {
    let usoRows = usoRowsAll.map(o => { const u = usoStatusOf(o); return { ...o, u, stageLabel: TORO_STAGE[u.stage] || u.stage || "нет статуса", sapFact: u.sapFact, openValue: u.open }; });
    renderTable(byId("usoTable"), {
      rows: usoRows, limit: 80, sortKey: "month", sortDir: 1,
      csv: true, csvName: "wk_uso.csv",
      onRowClick: r => { G.order = r.order; writeHash(false); renderGlobalFilters(); renderTab(); },
      cols: [
        { key: "month", label: "Месяц" },
        { key: "siteName", label: "Площадка" },
        { key: "order", label: "Заказ", cls: "mono" },
        { key: "unit", label: "Машина", cls: "wrap" },
        { key: "method", label: "Способ" },
        { key: "stageLabel", label: "Статус заказа ТОРО", fmt: (v, r) => usoStageBadge(r.u) },
        { key: "planValue", label: "План (состав)", numeric: true, fmt: rub },
        { key: "sapFact", label: "Факт в SAP", numeric: true, fmt: v => v ? rub(v) : "—" },
        { key: "openValue", label: "Не закрыто", numeric: true, fmt: v => v ? rub(v) : "—" },
      ],
    });
  }

  const items = D.provision.items;
  const provisionItemByCode = new Map(items.map(i => [String(i.code), i]));
  function apply() {
    const f2 = byId("provStatus").value;
    const q = normText(byId("provQ").value).trim();
    const scoped = new Map(), asOfDate = new Date(m.asOf + 'T00:00:00');
    orders.flatMap(o=>o.lines).forEach(l=>{
      const k=String(l.code), item=provisionItemByCode.get(k)||{}, lead=item.leadDays||m.leadMedianDays||0;
      const a=scoped.get(k)||{needQty:0,needValue:0,fromStock:0,fromBuy:0,late:0,undated:0,gap:0,gapValue:0,canOrder:0,tooLate:0,orderBy:'',transferPotential:0,transferFrom:{}};
      a.needQty+=l.qty; a.needValue+=l.value;
      for(const x of ['fromStock','fromBuy','late','undated','gap']) a[x]+=l[x];
      a.transferPotential+=l.transferPotential||0; for(const [st,q] of Object.entries(l.transferFrom||{})) a.transferFrom[st]=(a.transferFrom[st]||0)+q;
      const openValue=l.lateValue+l.undatedValue+l.gapValue;
      a.gapValue+=openValue;
      if(openValue>0){
        const start=l.date?new Date(l.date+'T00:00:00'):null, eta=new Date(asOfDate); eta.setDate(eta.getDate()+lead);
        if(start&&start>=asOfDate&&eta<=start) a.canOrder+=openValue; else a.tooLate+=openValue;
        if(start){const deadline=new Date(start);deadline.setDate(deadline.getDate()-lead);const ds=deadline.toISOString().slice(0,10);if(!a.orderBy||ds<a.orderBy)a.orderBy=ds}
      }
      scoped.set(k,a)
    });
    const scopedItems=items.filter(i=>scoped.has(String(i.code))).map(i=>{const a=scoped.get(String(i.code)),status=a.late+a.undated+a.gap<=1e-9?'full':a.fromStock+a.fromBuy<=1e-9?'none':'partial',verdict=status==='full'?'covered':a.canOrder>0?'inTime':'late';return {...i,...a,status,verdict,slipDays:0}});
    let rows = f2 === "can" ? scopedItems.filter(i => i.canOrder > 0)
      : f2 === "too" ? scopedItems.filter(i => i.tooLate > 0)
        : f2 ? scopedItems.filter(i => i.status === f2) : scopedItems;
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
        { key: "fromStock", label: "Со своего склада", numeric: true, fmt: v => num(v, 0) },
        { key: "fromBuy", label: "Закупка к сроку", numeric: true, fmt: v => num(v, 0) },
        {
          key: "coverage", label: "Покрытие", numeric: true,
          plain: (v, r) => Math.round(provisionCoverage(r)),
          fmt: (v, r) => {
            const pc = Math.min(100, provisionCoverage(r));
            return `<span class="prov-cover"><i style="width:${pc.toFixed(1)}%"></i></span><small>${num(pc, 0)}%</small>`;
          }
        },
        {
          key: "gap", label: "Дефицит", numeric: true,
          plain: (v, r) => num(v + r.late + r.undated, 0),
          fmt: (v, r) => {
            const g = v + r.late + r.undated;
            return g > 0 ? `<b style="color:var(--bad)">${num(g, 0)}</b>${transferNote(r)}` : "—";
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
          key: "code", label: "Прямые замены",
          plain: (v, r) => {
            const item = D.catalog.items.find(i => String(i.ekmtr) === String(v));
            return item ? directSubs(item.art).join(", ") : "";
          },
          fmt: (v) => {
            const item = D.catalog.items.find(i => String(i.ekmtr) === String(v));
            const subs = item ? directSubs(item.art) : [];
            if (!subs.length) return '<span class="dim" title="Транзитив отключён; показаны только прямые строки ведомости">нет</span>';
            return `<span class="badge info" title="${esc(subs.join(", "))} — не засчитываются в покрытие">прямые ${num(subs.length)}</span>`;
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
  const needByCode = new Map(((D.provision && D.provision.items) || []).map(i => [String(i.code), i]));
  const allRows = D.stock.items.map(i => {
    const need = needByCode.get(String(i.code));
    const uncoveredQty = need ? need.gap + need.late + need.undated : 0;
    const supplyStatus = !need ? "noNeed" : uncoveredQty > 0 ? (need.fromStock + need.fromBuy > 0 ? "partial" : "gap") : "covered";
    return { ...i, need, needQty: need ? need.needQty : 0, uncoveredQty, supplyStatus, firstNeed: need ? need.firstNeed : "" };
  });
  const stockRows = allRows.filter(stockInContext);
  // склады — со стоимостью по строке выгрузки и площадкой по заводу
  const warehouse = new Map();
  stockRows.forEach(i => Object.entries(i.byWarehouse || {}).forEach(([key, qty]) => {
    const meta = warehouseSite(key);
    if (G.site && meta.site !== G.site) return;
    const w = warehouse.get(key) || { name: `${(siteNameOf(meta.site) || meta.label || "?").split(" ")[0]} · ${meta.name}`, qty: 0, value: 0 };
    w.qty += +qty || 0;
    w.value += +((i.byWarehouseValue || {})[key]) || 0;
    warehouse.set(key, w);
  }));
  const hasWhValue = stockRows.some(i => i.byWarehouseValue);
  const warehouseRows = [...warehouse.values()].sort((a, b) => hasWhValue ? b.value - a.value : b.qty - a.qty).slice(0, 12);
  // по площадкам — в текущем контексте (модель, код, заказ)
  const bySite = new Map();
  stockRows.forEach(i => Object.entries(i.bySite || {}).forEach(([st, o]) => {
    const t = bySite.get(st) || { site: st, name: siteNameOf(st) || (D.stock.meta.sites || {})[st]?.name || "площадка не определена", codes: 0, value: 0, availValue: 0, restrictedValue: 0 };
    t.codes += o.qty > 0 ? 1 : 0; t.value += o.value || 0; t.availValue += o.availValue || 0; t.restrictedValue += o.restrictedValue || 0;
    bySite.set(st, t);
  }));
  const siteRows = [...bySite.values()].sort((a, b) => b.value - a.value);
  const transferValue = ((D.provision && D.provision.items) || []).filter(it => stockRows.some(r => String(r.code) === String(it.code)))
    .reduce((s, it) => s + (it.transferPotentialValue || 0), 0);
  const totalQty = stockRows.reduce((s, i) => s + stockSiteVal(i, "qty"), 0);
  const availQty = stockRows.reduce((s, i) => s + stockSiteVal(i, "availQty"), 0);
  const restrictedQty = stockRows.reduce((s, i) => s + stockSiteVal(i, "restrictedQty"), 0);
  const purchaseQty = stockRows.reduce((s, i) => s + ((i.purchase && i.purchase.openQty) || 0), 0);
  const totalValue = stockRows.reduce((s, i) => s + stockSiteVal(i, "value"), 0);
  const availValue = stockRows.reduce((s, i) => s + stockSiteVal(i, "availValue"), 0);
  const restrictedValue = stockRows.reduce((s, i) => s + stockSiteVal(i, "restrictedValue"), 0);
  const fullyRestricted = stockRows.filter(i => i.fullyRestricted).length;
  const purchaseValue = stockRows.reduce((s, i) => s + ((i.purchase && i.purchase.planV) || 0), 0);
  const gapQty = stockRows.reduce((s, i) => s + (i.uncoveredQty || 0), 0);
  const gapVal = stockRows.reduce((s, i) => s + ((i.need && (i.need.gapValue || 0)) || 0), 0);
  host.innerHTML = `
    <h1>Запасы</h1>
    ${contextBanner()}
    <p class="hint">KPI, склады и реестр — по выбранному контексту.</p>
    <p class="sub">Остаток по номенклатуре WK на дату выгрузки (${esc(m.srcStock)}). Ограниченный и блокированный запас вычтен из доступного и подсвечен отдельно.
      ${G.site ? `Площадка <b>${esc(siteNameOf(G.site))} (${esc(G.site)})</b>: KPI — только склады этой площадки; в реестре позиции с наличием здесь или потребностью её машин.` : "Площадка склада — по заводу строки выгрузки (MM‑M03), не по названию склада."}
      Склад покрывает потребность только своей площадки; перемещение между площадками ограничено и показывается как возможность, а не как покрытие.</p>
    <div class="kpis">
      ${kpi("Кодов с остатком", num(stockRows.filter(i => i.qty > 0).length))}
      ${kpi("Остаток всего", mrub(totalValue))}
      ${kpi("Доступно", mrub(availValue), "good")}
      ${kpi("Ограничено", mrub(restrictedValue), "bad")}
      ${kpi("Полностью ограничено", fullyRestricted + " код.", fullyRestricted > 0 ? "bad" : "")}
    </div>
    <div class="kpis">
      ${kpi("Остаток, ед.", num(totalQty, 0))}
      ${kpi("Доступно, ед.", num(availQty, 0), "good")}
      ${kpi("Ограничено, ед.", num(restrictedQty, 0), restrictedQty ? "bad" : "")}
      ${kpi("Открытая закупка, ед.", num(purchaseQty, 0), "warn")}
      ${kpi("Кодов с дефицитом", num(stockRows.filter(i => i.uncoveredQty > 0).length), "bad")}
    </div>
    ${restrictedValue > 0 ? callout("warn", `<b>${num(fullyRestricted)} позиций</b> имеют остаток, весь который ограничен — фактически это дефицит, хотя формально «есть на складе».`) : ""}
    <section class="card"><h3>Запас по площадкам</h3>
      <p class="hint">${esc(D.stock.meta.siteRule || "")}. WK в Иркутской области работают только на Сухом Логе, заказы его бортов планирует завод 1200 — поэтому склады Вернинского и «Развитие» Иркутские активы относятся к Сухому Логу. Нажмите строку, чтобы выбрать площадку.</p>
      <div id="stkSites"></div>
      ${transferValue > 0 ? `<p class="hint">Возможность (ограниченная): запас других площадок, оставшийся после их собственной потребности, мог бы закрыть ещё до <b>${mrub(transferValue)}</b> непокрытой потребности 2026–2027. В обеспеченность не входит — подробности во вкладке «Обеспеченность».</p>` : ""}
    </section>
    <div class="prov-audit-grid">
      <section class="card"><h3>Крупнейшие места хранения</h3><p class="hint">${hasWhValue ? "Стоимость по строкам MM‑M03; склад — пара «завод/код», площадка — по заводу." : "Справочная сумма количества разных МТР из MM‑M03, без сопоставления единиц измерения."}</p>${hasWhValue ? supplyBars(warehouseRows, "value", "name", v => mrub(v)) : supplyBars(warehouseRows, "qty", "name", v => num(v, 0) + " ед.")}</section>
      <section class="card"><h3>Контур запас → потребность</h3><p class="hint">В выбранном контексте.</p>
        <div class="supply-flow"><div><span>Доступный запас</span><b>${num(availQty, 0)} ед.</b><small>${mrub(availValue)}</small></div><i>+</i><div><span>Открытая закупка</span><b>${num(purchaseQty, 0)} ед.</b><small>${mrub(purchaseValue)}</small></div><i>→</i><div><span>Дефицит плана</span><b>${num(gapQty, 0)} ед.</b><small>${mrub(gapVal)}</small></div></div>
      </section>
    </div>
    <div class="toolbar">
      <button class="pill" id="stkRestricted" type="button" aria-pressed="false">только ограниченные</button>
      <select id="stkStatus"><option value="">Все статусы</option><option value="gap">Нет покрытия</option><option value="partial">Частичное покрытие</option><option value="covered">Потребность покрыта</option><option value="noNeed">Нет потребности в плане</option></select>
      <input type="search" id="stkQ" placeholder="Код или наименование…" value="${esc(G.ekmtr)}"/>
      <span class="count" id="stkCount"></span>
    </div>
    <div id="stkTable"></div>
  `;
  renderTable(byId("stkSites"), {
    rows: siteRows, sortKey: "value",
    onRowClick: r => { if (r.site) { G.site = r.site; renderGlobalFilters(); renderTab(); } },
    cols: [
      { key: "name", label: "Площадка", fmt: (v, r) => `${esc(v)} <span class="dim">${esc(r.site || "")}</span>` },
      { key: "codes", label: "Кодов", numeric: true },
      { key: "value", label: "Остаток", numeric: true, fmt: mrub },
      { key: "availValue", label: "Доступно", numeric: true, fmt: mrub },
      { key: "restrictedValue", label: "Ограничено", numeric: true, fmt: v => v > 0 ? mrub(v) : "—" },
      { key: "value", label: "Доля", numeric: true, plain: v => v, fmt: v => pct(v / (siteRows.reduce((s, r) => s + r.value, 0) || 1)) },
    ],
  });
  let restrOnly = false;
  function apply() {
    const q = (byId("stkQ").value || "").trim().toLowerCase();
    const status = byId("stkStatus").value;
    let rows = stockRows.filter(i => {
      if (restrOnly && i.restrictedValue <= 0) return false;
      if (status && i.supplyStatus !== status) return false;
      if (q && !i.code.includes(q) && !(i.name || "").toLowerCase().includes(q)) return false;
      return true;
    });
    byId("stkCount").textContent = num(rows.length) + " позиций";
    renderTable(byId("stkTable"), {
      rows, limit: 300, sortKey: "value",
      rowClass: r => r.fullyRestricted ? "restricted-row" : "",
      onRowClick: r => openCodeDetail(r.code),
      csv: true, csvName: "wk_stock.csv",
      cols: [
        { key: "code", label: "Код", cls: "mono", fmt: v => codeLink(v) },
        { key: "name", label: "Наименование", cls: "wrap",
          fmt: (v, r) => {
            const cat = catalogByEkmtr(r.code);
            return cat ? `<button type="button" class="pn-link" data-code="${esc(r.code)}">${esc(v || "")}</button>` : esc(v || "");
          } },
        { key: "needQty", label: "Потребность", numeric: true, fmt: v => v > 0 ? num(v, 1) : "—" },
        { key: "uncoveredQty", label: "Не покрыто", numeric: true, fmt: v => v > 0 ? `<b style="color:var(--bad)">${num(v, 1)}</b>` : "—" },
        { key: "supplyStatus", label: "ATP", fmt: v => v === "gap" ? '<span class="badge bad">нет покрытия</span>' : v === "partial" ? '<span class="badge warn">частично</span>' : v === "covered" ? '<span class="badge good">покрыто</span>' : '<span class="dim">нет потребности</span>' },
        { key: "firstNeed", label: "Первая потребность", fmt: v => v ? dmy(v) : "—" },
        { key: "qty", label: "Остаток, ед.", numeric: true, fmt: v => num(v, 1) },
        { key: "qty", label: "На выбранной площадке", numeric: true,
          plain: (v, r) => { const a = stockAtSite(r, G.site, siteNameOf(G.site)); return a.siteQty == null ? "" : a.siteQty; },
          fmt: (v, r) => {
            const a = stockAtSite(r, G.site, siteNameOf(G.site));
            if (!G.site) return '<span class="dim">все площадки</span>';
            if (!a.matched) return `<span class="badge warn">0 здесь</span>`;
            return a.siteQty ? `<b>${num(a.siteQty, 1)}</b> <span class="dim">из ${num(a.total, 1)}</span>` : '<span class="badge warn">0 на площадке</span>';
          } },
        { key: "byWarehouse", label: "Где лежит", cls: "wrap",
          plain: v => warehouseBreakdown(v).map(w => `${w.label} · ${w.name}: ${w.qty}`).join("; "),
          fmt: (v) => warehouseHtml(v, G.site) },
        { key: "value", label: "Стоимость", numeric: true, fmt: rub },
        { key: "restrictedValue", label: "Ограничено", numeric: true, fmt: v => v > 0 ? `<span class="badge restricted">${rub(v)}</span>` : "" },
        { key: "availValue", label: "Доступно", numeric: true, fmt: rub },
        { key: "purchase", label: "В закупке", numeric: true, plain: v => v ? v.planV : "",
          fmt: v => v ? `${rub(v.planV)}<div class="sup-sub">${purchaseMonthsHtml(v)}</div>` : '<span class="dim">не заказано</span>' },
        {
          key: "code", label: "", plain: () => "",
          fmt: (v, r) => cartAddBtn({ code: v, name: r.name, value: r.availValue, source: "Запасы" })
        },
      ],
    });
    wireCartButtons(byId("stkTable"));
    wireCodeLinks(byId("stkTable"));
  }
  byId("stkQ").oninput = apply;
  byId("stkStatus").onchange = apply;
  byId("stkRestricted").onclick = e => { restrOnly = !restrOnly; e.currentTarget.classList.toggle("on", restrOnly); e.currentTarget.setAttribute("aria-pressed", restrOnly); apply(); };
  apply();
}

/* ===================== ЗАКУПКИ ===================== */
function renderPurchase(host) {
  const asOfMonth = (D.provision.meta.asOf || "").slice(0, 7);
  const needByCode = new Map(((D.provision && D.provision.items) || []).map(i => [String(i.code), i]));
  const rows = D.stock.items.filter(i => i.purchase && stockInContext(i)).map(i => {
    const p = i.purchase, need = needByCode.get(String(i.code));
    const overdueQty = Object.entries(p.byMonth || {}).reduce((s, [month, qty]) => s + (month && month < asOfMonth ? (+qty || 0) : 0), 0);
    const undatedQty = +(p.byMonth || {})[""] || 0;
    const uncoveredQty = need ? need.gap + need.late + need.undated : 0;
    return { ...p, code: i.code, name: i.name, needQty: need ? need.needQty : 0, uncoveredQty, firstNeed: need ? need.firstNeed : "", orderBy: need ? need.orderBy : "", overdueQty, undatedQty, scheduleStatus: overdueQty > 0 ? "overdue" : undatedQty > 0 ? "undated" : "future" };
  });
  const total = rows.reduce((s, r) => s + r.planV, 0);
  const openQty = rows.reduce((s, r) => s + r.openQty, 0);
  const overdueQty = rows.reduce((s, r) => s + r.overdueQty, 0);
  const undatedQty = rows.reduce((s, r) => s + r.undatedQty, 0);
  const suppliers = new Set(rows.map(r => r.topSupplier).filter(Boolean)).size;
  host.innerHTML = `
    <h1>Закупки</h1>
    ${contextBanner()}
    <p class="hint">KPI, график и реестр — по выбранному контексту. Количества разных МТР суммированы справочно.</p>
    <p class="sub">Открытые заявки и заказы на поставку по номенклатуре WK (${esc(D.stock.meta.srcPurchase)}).</p>
    <div class="kpis">
      ${kpi("Кодов в закупке", num(rows.length))}
      ${kpi("Плановая стоимость", mrub(total))}
      ${kpi("Ещё поставить, ед.", num(openQty, 0))}
      ${kpi("Просрочено, ед.", num(overdueQty, 0), overdueQty ? "bad" : "good")}
      ${kpi("Без даты, ед.", num(undatedQty, 0), undatedQty ? "warn" : "good")}
      ${kpi("Основных поставщиков", num(suppliers))}
    </div>
    <section class="card prov-arrival-card"><div class="prov-card-head"><div><h3>График открытых поставок</h3><p class="hint">Точное открытое количество по плановому месяцу; красным — месяц раньше снимка ${dmy(D.provision.meta.asOf)}.</p></div></div>${provisionArrivalChart(purchaseScheduleRows(rows), D.provision.meta.asOf)}</section>
    <div class="toolbar"><select id="purStatus"><option value="">Все сроки</option><option value="overdue">Есть просрочка</option><option value="undated">Есть объём без даты</option><option value="future">Только будущий график</option><option value="gap">Есть непокрытая потребность</option></select><input type="search" id="purQ" placeholder="Код, наименование или поставщик…"><span class="count" id="purCount"></span></div>
    <div id="purTable"></div>
  `;
  function apply() {
    const status = byId("purStatus").value, q = normText(byId("purQ").value).trim();
    let shown = rows.filter(r => (!status || (status === "gap" ? r.uncoveredQty > 0 : status === "undated" ? r.undatedQty > 0 : r.scheduleStatus === status)) && (!q || normText([r.code, r.name, r.topSupplier].join(" ")).includes(q)));
    byId("purCount").textContent = `${num(shown.length)} позиций · ${num(shown.reduce((s, r) => s + r.openQty, 0), 0)} ед. · ${mrub(shown.reduce((s, r) => s + r.planV, 0))}`;
    renderTable(byId("purTable"), {
    rows: shown, limit: 300, sortKey: "planV",
    csv: true, csvName: "wk_purchase.csv",
    onRowClick: r => openCodeDetail(r.code),
    cols: [
      { key: "code", label: "Код", cls: "mono", fmt: v => codeLink(v) },
      { key: "name", label: "Наименование", cls: "wrap" },
      { key: "needQty", label: "Потребность", numeric: true, fmt: v => v > 0 ? num(v, 1) : "—" },
      { key: "uncoveredQty", label: "Не покрыто ATP", numeric: true, fmt: v => v > 0 ? `<b style="color:var(--bad)">${num(v, 1)}</b>` : "—" },
      { key: "planV", label: "Плановая ст-ть", numeric: true, fmt: rub },
      { key: "openQty", label: "Ещё поставить", numeric: true, fmt: v => num(v, 1) },
      { key: "transitQty", label: "В пути", numeric: true, fmt: v => num(v, 1) },
      { key: "overdueQty", label: "Просрочено", numeric: true, fmt: v => v > 0 ? `<span class="badge bad">${num(v, 1)}</span>` : "—" },
      { key: "undatedQty", label: "Без даты", numeric: true, fmt: v => v > 0 ? `<span class="badge warn">${num(v, 1)}</span>` : "—" },
      { key: "byMonth", label: "График поставки", cls: "wrap",
        plain: v => Object.entries(v || {}).map(([m, q]) => (m || "без даты") + ": " + q).join("; "),
        fmt: (v, r) => purchaseMonthsHtml(r) },
      { key: "lines", label: "Строк", numeric: true },
      { key: "topSupplier", label: "Основной поставщик", cls: "wrap" },
      { key: "leadDays", label: "Факт. срок", numeric: true, fmt: (v, r) => v ? `${num(v)} дн. <span class="sup-sub">${num(r.leadN)} зам.</span>` : "—" },
      { key: "firstNeed", label: "Первая потребность", fmt: v => v ? dmy(v) : "—" },
      { key: "orderBy", label: "Заказать до", fmt: v => v ? dmy(v) : "—" },
    ],
  });
  wireCodeLinks(byId("purTable"));
  }
  byId("purStatus").onchange = apply;
  byId("purQ").oninput = debounce(apply, 120);
  apply();
}

/* ===================== КОДИФИКАЦИЯ ===================== */
function renderCodif(host) {
  const items = D.catalog.items.filter(catalogInContext);
  const uncoded = items.filter(i => !i.ekmtr);
  const ambiguous = items.filter(i => i.ekmtrAmbiguous);
  const value = uncoded.reduce((s, i) => s + (i.priceCNY || 0), 0);
  host.innerHTML = `
    <h1>Кодификация</h1>
    ${contextBanner()}
    <p class="sub">Позиции прайса без кода ЕКМТР — рабочий список на заведение НСИ.</p>
    <div class="kpis">
      ${kpi("Без кода", num(uncoded.length) + " / " + num(items.length), "bad")}
      ${kpi("Стоимость", cny(value))}
      ${kpi("Неоднозначно сопоставлено", num(ambiguous.length), "warn")}
    </div>
    <div id="codifTable"></div>
  `;
  const ranked = uncoded.map(i => ({
    ...i,
    treeHit: (i.tree || []).length,
    priority: (i.priceCNY || 0) * ((i.tree || []).length ? 2 : 1),
  }));
  renderTable(byId("codifTable"), {
    rows: ranked, limit: 300, sortKey: "priority",
    csv: true, csvName: "wk_codification.csv",
    cols: [
      { key: "art", label: "Артикул", cls: "mono" },
      { key: "model", label: "Модель" },
      { key: "nameRu", label: "Наименование", cls: "wrap" },
      { key: "priceCNY", label: "Цена, ¥", numeric: true, fmt: cny },
      { key: "priority", label: "Приоритет", numeric: true, fmt: v => num(v, 0),
        plain: v => v },
      { key: "treeHit", label: "В ведомости", numeric: true, fmt: v => v ? `<span class="badge good">${v}</span>` : '<span class="dim">нет</span>' },
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
  const filter = normArt(G.part);
  const books = contextBooks();
  const evidence = (D.interchange.evidence || []).filter(g => {
    if (filter && !g.parts.some(p => normArt(p.num).includes(filter))) return false;
    if (books.size && !g.parts.some(p => books.has(p.book))) return false;
    return true;
  });
  const scoped = contextHasFilter() || filter;
  host.innerHTML = `
    <h1>Взаимозаменяемость</h1>
    ${contextBanner()}
    <p class="sub">Каждая строка Excel принята как прямая связь замены. Признак «Да» не обязателен; комментарий сохраняется. Одинаковый номер в разных комплектациях считается той же деталью. Связи разных строк транзитивно не объединяются.</p>
    <div class="kpis">
      ${kpi("Строк-связей", num(scoped ? evidence.length : m.rowRelations))}
      ${kpi("Номеров в группах", num(scoped ? new Set(evidence.flatMap(g => g.parts.map(p => p.num))).size : m.partsInGroups))}
      ${kpi("Одинаковые номера", num(scoped ? evidence.filter(g => g.relation === "identity").length : m.identityRows), "good")}
      ${kpi("С комментарием", num(scoped ? evidence.filter(g => g.note).length : m.commentedRows))}
    </div>
    <div class="card"><h3>Таблица взаимозаменяемости</h3><p class="hint">Показано ${num(evidence.length)} строк${books.size ? " книг выбранного контекста" : ""}. Фильтр «Каталожный №» находится в сквозной панели выше.</p><div id="interGroups"></div></div>
  `;
  renderTable(byId("interGroups"), {
    rows: evidence.map(g => ({ ...g,
      n: g.parts.length, sourceParts: g.parts, parts: g.parts.map(p => p.book + ": " + p.num).join(", "),
      source: g.sheet + " · строка " + g.row, flags: (g.flags || []).join(", ") })),
    limit: 300,
    csv: true, csvName: "interchange_evidence.csv",
    cols: [{ key: "source", label: "Источник" }, { key: "parts", label: "Комплектации и номера", cls: "wrap mono",
      fmt: (_, r) => r.sourceParts.map(p => esc(p.book) + ": " + interPartLink(p.num)).join("<br>") },
      { key: "relation", label: "Тип", fmt:v=>v==='identity'?'<span class="badge good">тот же номер</span>':'<span class="badge info">замена по строке</span>' },
      { key: "flags", label: "Отметка Excel" }, { key: "note", label: "Комментарий", cls: "wrap" }],
  });
  wireInterLinks(byId("interGroups"));
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
      <p style="margin:6px 0">${esc(issueText(i.issue))}</p>
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
          <tr><td>TOPO: mtr.json, ktg.json, детализация PM-06</td><td>Код ЕКМТР, КТГ план/факт (p/pm и a/am), история и план ремонтов</td></tr>
        </tbody>
      </table></div>
    </div>
    <div class="card"><h3>Правила расчёта</h3>
      <ul>
        <li>Цена в юанях — только в разделе «Каталог». Везде далее — рубли, как в выгрузках SAP.</li>
        <li>Ограниченный и блокированный запас вычитается из остатка <b>на том же складе</b>: доступно = остаток − ограничено − блокировано − на контроле качества. У склада своя цена: б/у и неисправный запас часто стоит 0 ₽, поэтому вычитать его по средней цене кода нельзя.</li>
        <li>Обеспеченность считается только по номенклатуре WK (код входит в ППЗ 3.1.2.7 «Запчасти к экскаваторам WK»).</li>
        <li>Дубли карточек КТГ схлопываются по паре (площадка, точное имя борта) — берётся запись с непустым планом КТГ.</li>
        <li>КТГ план = поля p/pm витрины TOPO, КТГ факт = a/am. Это не КИО: коэффициент использования в ktg.json отдельно не приходит.</li>
        <li>Склад — пара «завод/код склада» из MM-M03 (одинаковые названия встречаются на разных заводах). <b>Площадка — по заводу строки:</b> 11xx, 7101, 7106 (перевалочная база КБЕ) — Красноярск / Еруда; 14xx, 7104 — Магадан; 12xx, 24xx, 7102, 7108 — Сухой Лог (WK в Иркутской области работают только там, заказы его бортов планирует завод 1200); 13xx, 7103 — Алдан. 71xx — заводы АО «Развитие» на той же площадке.</li>
        <li>План и факт PM-06 одной позиции приходят разными строками. Обеспеченность сначала сливает зерно заказ × материал, затем remaining = max(план − факт, 0). Иначе закрытый заказ висит дефицитом.</li>
        <li>МТР подрядчика (УСО) — отдельная выгрузка TOPO <code>rawdata/УСО</code>. Она не вычитается из остатка Полюса и не подменяет ATP.</li>
      </ul>
    </div>
    <div class="card"><h3>Обеспеченность: как считается</h3>
      <p class="hint">Потребность — открытый остаток строк плана ТОиР 2026–2027 по технике WK: количество = max(план − факт, 0), стоимость пропорциональна. Распределение — как в MRP/ATP, в два прохода.</p>
      <ul>
        <li><b>Склад — только своей площадке.</b> Остаток лежит на конкретной площадке и покрывает потребность только её машин.</li>
        <li><b>Проход 1.</b> Потребность, отсортированная по дате начала работ, забирает остаток своей площадки, затем — те приходы закупки, чей месяц поставки не раньше даты снимка и не позже месяца начала работ («успевает»). Закупка общая: документ закупки не привязан к площадке потребности.</li>
        <li><b>Возможность перемещения.</b> Перемещение между площадками ограничено (логистика, согласование БЕ), поэтому в обеспеченность не входит. Отдельно показано, сколько непокрытой к сроку потребности мог бы закрыть запас других площадок, оставшийся после их собственной потребности, — верхняя оценка улучшения.</li>
        <li><b>Проход 2.</b> Остатками приходов закрывается то, что не успели, — это «опоздание».</li>
        <li>Два прохода здесь принципиальны: в один проход ранняя потребность забирает поздний приход и помечает его опозданием, хотя тот же приход мог бы вовремя закрыть более позднюю потребность. На этих данных разница почти вдвое по доле «закупка успевает».</li>
        <li><b>Срок поставки</b> — медиана «дата поставки − дата заявки» по той же выгрузке закупки (${num(D.provision.meta.leadMeasurements)} замеров по ${num(D.provision.meta.leadCodes)} кодам). Для позиции со своей статистикой берётся её собственный срок, иначе — медиана по WK (${num(D.provision.meta.leadMedianDays)} дн.).</li>
        <li><b>Дата анализа</b> — самая поздняя из дат выгрузок (${dmy(D.provision.meta.asOf)}), а не дата открытия портала: иначе один и тот же исходник давал бы разный ответ ото дня ко дню.</li>
      </ul>
      <p class="hint">Открытая поставка с плановым месяцем раньше даты снимка считается просроченной: её старый срок ненадёжен, поэтому она не улучшает показатель «обеспечено к сроку». Чего расчёт сознательно не делает: прочая номенклатура (ГСМ, общий крепёж, общие МТР) в него не входит — витрины остатков по ней нет; срок прихода закупки известен только до месяца, внутри месяца приход считается успевающим.</p>
    </div>
    <div class="card"><h3>Аналитика и контроль отделов: как считается</h3>
      <p class="hint">Витрина <code>data/control.json</code> — заказ ТОРО WK × год выгрузки PM-06 (2024–2027): план и факт МТР и УСО из строк графика, стадия и статусы заказа из выгрузки статусов PM-06 TOPO (<code>build/build_control.py</code>). Расчёты — <code>lib/analytics_core.js</code>, одни и те же для графиков, автовыводов и тестов. Всё пересчитывается по сквозным фильтрам: площадка, модель, машина, заказ.</p>
      <ul>
        <li><b>План</b> = МТР Полюса + МТР подрядчика (УСО). Позиции графика ППР без заказа SAP в план не входят и показываются отдельно. У оригинала БЕ, перенесённого копией в «Развитие», неисполненный план не считается: план = min(план, факт).</li>
        <li><b>Оценка планирования «Развития»</b> — только заказы групп планирования ТОРО 100 Механика и 200 Энергетика (поле «Заказ Группа планирования ТОРО» PM-06, есть с 2024 года). Группы 300 Метрология, 400 ЗиС, 500 Пожарная охрана, 600 АГиТО, 700 Эксплуатация, 800 ГПМ, 900 КИПиА — службы БЕ (заказчика): их заказы входят в исполнение, бюджет и обеспеченность, но не в показатели и выводы планирования. Раскладка по группам — «Контроль отделов» → «Планирование». Сквозной фильтр «Группа планирования» (Развитие, службы БЕ или одна группа) сужает всё, что считается по заказам ТОРО: аналитику, контроль отделов, обеспеченность, график план-факт, УСО; заказы 2022–2023 (группы ещё нет в выгрузке) и склад он не делит.</li>
        <li><b>Стадия</b> — по статусам: ЗАКР &gt; ТЗКР (ВСБЕ / ПРСЗ) &gt; ДЕБЛ (ФХСМ / в работе / пусто) &gt; ОТКР (СГГС / на согласовании). Статус — на дату годовой выгрузки PM-06.</li>
        <li><b>Темп года</b> сравнивается с долей прошедшего года на дату данных; «план к дате» — заказы с базисным началом не позже текущего месяца.</li>
        <li><b>Обеспеченность</b> — склад своей площадки и закупка к сроку; перемещение между площадками ограничено и показывается как возможность, а не покрытие.</li>
      </ul>
      <div class="twrap"><table><thead><tr><th>Группа</th><th>Правило</th><th>Когда срабатывает</th></tr></thead><tbody>
        ${(typeof AnalyticsCore !== "undefined" ? AnalyticsCore.RULES : []).map(r => `<tr><td>${esc(r.group)}</td><td>${esc(r.title)}</td><td>${esc(r.test)}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="hint" style="margin-top:10px"><b>Двойная проверка.</b> 1) В каждом контексте вкладка сверяет разрезы с итогами (стадии, площадки, МТР + УСО, сегменты обеспеченности, цепочка согласования, воронка, S-кривая) и итоги — с витринами отчёта; результат виден внизу вкладки. 2) <code>tests/verify_analytics.py</code> — вторая, независимая реализация на Python: собирает заказы из строк графика и статусов TOPO, обеспеченность — построчно; <code>tests/test_analytics.mjs</code> сверяет с ядром все показатели и уровни выводов для всего парка, каждой площадки, модели и борта. 3) Итоги по годам, площадкам и бортам совпадают с данными презентации (<code>build/build_wk_status_data.py</code>).</p>
      <p class="hint"><b>Поиск по номеру и «Эффективность»</b> (<code>lib/mtr_core.js</code>). Номер ищется в прайсе ДП (и «Артикуле обн.»), в названии материала ЕКМТР и как сам код; взаимозаменяемые — прямые связи ведомости. История — строки графика PM-06: площадка по борту, позиции ППР без заказа в план не входят, отрицательное количество (возврат демонтированного узла) — не расход. Цена факта = стоимость / количество списания; цена закупки = «Общая стоимость» / количество — в рублях (у позиций прайса ДП = цена в юанях × курс ≈ 12,48 ₽/¥). ABC — по факту трёх последних лет; «без движения» — доступный запас без расхода за три года и без потребности; «избыток» — запас сверх потребности и двух лет расхода; индекс цен — Ласпейрес в весах количества прошлого года, скачки больше чем в 5 раз отсеиваются. Всё повторено независимо в <code>tests/verify_mtr.py</code>, сверку делает <code>tests/test_mtr.mjs</code>.</p>
      <p class="hint"><b>Обновление без Python.</b> Вкладка «Обновление данных» пересобирает в браузере все витрины ТОиР — график план-факт, статусы и стадии, копии «Развития», признак ППМ, <code>control.json</code>, обеспеченность, свод ремонтов и тексты заказов — по тем же правилам (<code>lib/toro_rebuild.js</code>; совпадение с <code>build/*.py</code> проверяет <code>tests/test_toro_rebuild.mjs</code>, в том числе на полных выгрузках PM-06). Загруженные площадко-годы заменяют свои, остальные берутся из текущих данных. Результат сохраняется в браузере и выгружается архивом <code>data/</code> для публикации.</p>
    </div>
  `;
}

/* ===================== ОБНОВЛЕНИЕ ДАННЫХ ===================== */
/* Пересборка витрин прямо в браузере — без Python. Файлы не покидают вкладку.
   Остатки — lib/stock_pipeline.js; ТОРО PM-06 — lib/pm06_pipeline.js +
   lib/toro_rebuild.js (график, статусы, контроль, обеспеченность, свод
   ремонтов, тексты заказов — те же правила, что build/*.py, паритет
   проверяет tests/test_toro_rebuild.mjs); УСО — lib/uso_pipeline.js.
   «Применить» сохраняет витрины в хранилище браузера (lib/upd_store.js),
   архив data/ — для публикации всем. */
const UPD = { files: {}, busy: false, progress: null, result: null, err: "", applied: false };
const UPD_TORO = { files: [], busy: false, progress: null, err: "", results: [], out: null, applied: false, msg: "", source: "" };
const UPD_USO = { files: [], busy: false, progress: null, err: "", usoWk: null, applied: false, msg: "", years: [] };
let UPD_LIBS = null, UPD_STORE_ERR = "", UPD_FOLDER = { busy: false, msg: "", err: "" };

function updLoadLibs() {
  if (UPD_LIBS) return UPD_LIBS;
  const one = src => new Promise((res, rej) => {
    if ((src.includes("pm06") && typeof PM06 !== "undefined") ||
        (src.includes("uso_pipeline") && typeof USOPIPE !== "undefined") ||
        (src.includes("toro_rebuild") && typeof ToroRebuild !== "undefined") ||
        (src.includes("wk_update") && typeof WkUpdate !== "undefined")) return res();
    const el = document.createElement("script");
    el.src = src;
    el.onload = res;
    el.onerror = () => rej(new Error("Не загрузился " + src + " — папка lib должна лежать рядом с index.html"));
    document.head.appendChild(el);
  });
  UPD_LIBS = Promise.all([
    one("lib/pm06_pipeline.js"),
    one("lib/uso_pipeline.js"),
    one("lib/wk_update_pipeline.js"),
  ]).then(() => one("lib/toro_rebuild.js")).catch(e => { UPD_LIBS = null; throw e; });
  return UPD_LIBS;
}

async function updStreamPm06(zip, onRow, onProgress) {
  try {
    return await XLSXStream.streamSheet(zip, "PM-06", onRow, onProgress);
  } catch (e) {
    const name = await StockPipeline.firstSheetName(zip);
    if (!name || name === "PM-06") throw e;
    return await XLSXStream.streamSheet(zip, name, onRow, onProgress);
  }
}

function updTickBar(id, pct, text) {
  const bar = byId(id), txt = byId(id + "Txt");
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
  if (txt) txt.textContent = text;
}

function updDownloadBlob(filename, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

function updDiffRow(label, oldV, newV, fmt) {
  const delta = (newV || 0) - (oldV || 0);
  const cls = Math.abs(delta) < 1e-6 ? "" : delta > 0 ? "good" : "bad";
  return `<tr><td>${esc(label)}</td><td class="n">${fmt(oldV)}</td><td class="n">${fmt(newV)}</td>
    <td class="n"><span class="badge ${cls}">${delta >= 0 ? "+" : ""}${fmt(delta)}</span></td></tr>`;
}

/* график план-факт целиком (база пересборки) */
async function ensureSchedule() {
  if (S) return S;
  if (!SP) SP = loadScript("data/schedule_manifest.local.js").then(async () => {
    const m = dataFor("schedule_manifest");
    await Promise.all(m.shards.map(n => loadScript("data/" + n + ".local.js")));
    return { meta: m.meta, rows: m.shards.flatMap(n => sDecode(dataFor(n))) };
  });
  S = await SP;
  return S;
}

/* Пересобрать все витрины ТОиР: загруженные площадко-годы + текущие данные */
async function updRebuild(uploads, stockJson) {
  await updLoadLibs();
  const sched = await ensureSchedule();
  await ensureData(["control"]);
  try { await ensureData(["orderText"]); } catch (e) { D.orderText = null; }
  try { await ensureData(["wkNodes"]); } catch (e) { D.wkNodes = null; }   // заказы на ЕО-узлах техместа машины (БДО)
  const out = ToroRebuild.rebuild({
    base: { scheduleRows: sched.rows, scheduleMeta: sched.meta, control: D.control, provision: D.provision,
            orderText: D.orderText || { meta: {}, text: {} }, wkNodes: D.wkNodes },
    uploads, stockJson: stockJson || D.stock, ekmtrWk: D.ekmtrWk, fleet: D.fleet,
  });
  // сверки аналитики на новых витринах — та же двойная проверка, что внизу вкладки «Аналитика»
  const model = AnalyticsCore.buildModel({ control: out.control, provision: out.provision, stock: stockJson || D.stock, fleet: D.fleet }, {});
  const before = AnalyticsCore.buildModel({ control: D.control, provision: D.provision, stock: D.stock, fleet: D.fleet }, {});
  out.checks = model.checks;
  out.model = model; out.before = before;
  out.old = { rows: sched.rows.length, control: D.control, provision: D.provision, repairs: D.repairs,
              texts: Object.keys((D.orderText && D.orderText.text) || {}).length };
  return out;
}

/* применить пересборку в сеансе и сохранить в хранилище браузера */
async function updApplyRebuild(out, label, extra = {}) {
  D.provision = out.provision; D.control = out.control; D.controlRows = null;
  D.orderText = out.orderText; D.repairs = out.repairs;
  S = { meta: out.schedule.manifest.meta, rows: out.scheduleRows }; SP = Promise.resolve(S);
  Object.entries(extra).forEach(([file, v]) => { const k = Object.keys(FILES).find(x => FILES[x] === file); if (k) D[k] = v; });
  buildIndexes();
  await updPersist({ ...extra, provision: out.provision, control: out.control, order_text: out.orderText, repairs: out.repairs,
                     schedule_manifest: out.schedule.manifest, ...out.schedule.shards }, label);
}
async function updPersist(entries, label) {
  const remove = entries.schedule_manifest
    ? [...DATA_OVERRIDE.keys()].filter(k => /^schedule_\d+$/.test(k) && !entries.schedule_manifest.shards.includes(k)) : [];
  remove.forEach(k => DATA_OVERRIDE.delete(k));
  Object.entries(entries).forEach(([k, v]) => DATA_OVERRIDE.set(k, v));
  const at = new Date().toISOString();
  const info = { savedAt: at, log: [...((DATA_OVERRIDE_INFO && DATA_OVERRIDE_INFO.log) || []), { at, label }].slice(-30) };
  DATA_OVERRIDE_INFO = info;
  try { await UpdStore.save(entries, remove, info); UPD_STORE_ERR = ""; }
  catch (e) { UPD_STORE_ERR = "Не удалось сохранить в браузере (" + e.message + "): обновление действует до закрытия вкладки — скачайте архив."; }
  renderUpdBanner();
}
function updArchive() {
  const datasets = Object.fromEntries(DATA_OVERRIDE);
  if (!Object.keys(datasets).length) return;
  const files = UpdStore.dataFiles(datasets);
  const log = ((DATA_OVERRIDE_INFO && DATA_OVERRIDE_INFO.log) || []).map(x => `${x.at.slice(0, 16).replace("T", " ")}  ${x.label}`).join("\n");
  files.push({ name: "data/ОБНОВЛЕНИЕ.txt", text:
    "Витрины WK CRM, пересобранные в браузере (вкладка «Обновление данных»).\n" +
    "Распакуйте архив в папку отчёта с заменой файлов (папка data/ рядом с index.html)\n" +
    "или залейте data/ в репозиторий — обновление увидят все.\n\nИстория:\n" + log + "\n" });
  const stamp = new Date().toISOString().slice(0, 10);
  updDownloadBlob(`wk_crm_data_${stamp}.zip`, new Blob([UpdStore.zip(files)], { type: "application/zip" }));
}
/* записать обновлённые витрины прямо в папку отчёта на диске (Chrome / Edge) */
async function updWriteFolder(pickNew) {
  const datasets = Object.fromEntries(DATA_OVERRIDE);
  if (!Object.keys(datasets).length) return;
  UPD_FOLDER = { busy: true, msg: "", err: "" }; renderTab();
  try {
    const r = await UpdStore.writeFolder(UpdStore.dataFiles(datasets), pickNew);
    const w = (n => { const a = n % 100, b = n % 10; return a > 10 && a < 20 ? "файлов" : b === 1 ? "файл" : b >= 2 && b <= 4 ? "файла" : "файлов"; })(r.files);
    UPD_FOLDER = { busy: false, err: "", msg: `Записано ${num(r.files)} ${w} (${num(r.bytes / 1e6, 1)} МБ) в папку «${r.folder}/data». Отчёт из этой папки теперь открывается с новыми данными на любом компьютере, куда её скопируют.` };
  } catch (e) {
    UPD_FOLDER = { busy: false, msg: "", err: e && e.name === "AbortError" ? "" : "Не удалось записать в папку: " + (e && e.message || e) };
  }
  renderTab();
}
async function updReset() {
  if (!confirm("Вернуть опубликованные данные? Обновления, сохранённые в этом браузере, будут удалены.")) return;
  try { await UpdStore.clear(); } catch (e) { /* нечего чистить */ }
  location.reload();
}

/* ---------- 1. остатки ---------- */
async function updRun() {
  if (UPD.busy) return;
  const need = ["stock", "restricted", "purchase"];
  if (!need.every(k => UPD.files[k])) { UPD.err = "Нужны все три файла: остатки, ограниченный запас, закупка."; renderTab(); return; }
  UPD.busy = true; UPD.err = ""; UPD.result = null; UPD.progress = null; UPD.applied = false;
  renderTab();
  try {
    const wkCodes = new Set(D.ekmtrWk.items.map(e => e.code));
    const tick = (label) => (p) => { UPD.progress = { label, pct: p.total ? Math.round(100 * p.done / p.total) : 0 }; renderTab(); };
    const zStock = await XLSXStream.openZip(UPD.files.stock);
    const stock = await StockPipeline.parseStock(zStock, wkCodes, tick("Остатки"));
    const zRestr = await XLSXStream.openZip(UPD.files.restricted);
    const restr = await StockPipeline.parseRestricted(zRestr, await StockPipeline.firstSheetName(zRestr), wkCodes, tick("Ограниченный запас"));
    const zPurch = await XLSXStream.openZip(UPD.files.purchase);
    const purch = await StockPipeline.parsePurchase(zPurch, await StockPipeline.firstSheetName(zPurch), wkCodes, tick("Закупка"));
    UPD.result = StockPipeline.assemble(D.ekmtrWk, stock, restr, purch, {
      stock: UPD.files.stock.name, restricted: UPD.files.restricted.name, purchase: UPD.files.purchase.name,
    });
    try {   // отпечаток файла закупки — как git blob sha1 в build_stock.py
      const buf = new Uint8Array(await UPD.files.purchase.arrayBuffer());
      const head = new TextEncoder().encode("blob " + buf.length + "\0"), all = new Uint8Array(head.length + buf.length);
      all.set(head); all.set(buf, head.length);
      UPD.result.meta.purchaseDocumentBlob = [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))].map(b => b.toString(16).padStart(2, "0")).join("");
    } catch (e) { /* без отпечатка — только справочное поле */ }
    UPD.progress = { label: "Пересчёт обеспеченности и аналитики по новым остаткам", pct: 100 }; renderTab();
    UPD.out = await updRebuild([], UPD.result);
  } catch (e) {
    UPD.err = "Ошибка разбора: " + (e && e.message || e);
  }
  UPD.busy = false; UPD.progress = null;
  renderTab();
}
async function updApply() {
  if (!UPD.result || !UPD.out) return;
  D.stock = UPD.result;
  await updApplyRebuild(UPD.out, "остатки, ограниченный запас, закупка: " + [UPD.files.stock, UPD.files.restricted, UPD.files.purchase].map(f => f.name).join(", "), { stock: UPD.result });
  UPD.applied = true;
  renderTab();
}

/* ---------- 2. ТОРО PM-06 ---------- */
async function updToroRun() {
  if (UPD_TORO.busy || !UPD_TORO.files.length) return;
  UPD_TORO.busy = true; UPD_TORO.err = ""; UPD_TORO.out = null; UPD_TORO.msg = ""; UPD_TORO.applied = false;
  renderTab();
  try {
    await updLoadLibs();
    const uploads = [], details = [];
    for (const f of UPD_TORO.files) {
      if (!f.site || !f.year) throw new Error("Для «" + f.file.name + "» укажите площадку и год (из имени M06_1400_2026.xlsx или вручную)");
      UPD_TORO.progress = { name: f.file.name, pct: 0 };
      updTickBar("updToroBar", 0, f.file.name);
      const zip = await XLSXStream.openZip(f.file);
      const router = PM06.createSiteRouter(f.site, f.year), meta = ToroRebuild.createMetaCollector(f.site);
      await updStreamPm06(zip, cells => { router.pushRow(cells); meta.pushRow(cells); }, pr => {
        const pct = pr.total ? Math.round(100 * pr.done / pr.total) : 0;
        UPD_TORO.progress = { name: f.file.name, pct };
        updTickBar("updToroBar", pct, f.file.name + " — " + pct + "%, " + (pr.rows || 0) + " строк");
      });
      const det = router.finishAll().map(r => r.detail);
      details.push(...det);
      uploads.push({ file: f.file.name, site: f.site, year: f.year, details: det, meta: meta.finish() });
    }
    UPD_TORO.results = details;
    updTickBar("updToroBar", 100, "Пересборка витрин…");
    UPD_TORO.out = await updRebuild(uploads);
    const r = UPD_TORO.out.report;
    UPD_TORO.msg = `Заменены площадко-годы: ${r.replaced.concat(r.added).map(x => x.replace("_", " · ")).join(", ") || "—"}. Остальные — из текущих данных.`;
  } catch (e) {
    UPD_TORO.err = "Ошибка разбора ТОРО: " + (e && e.message || e);
  }
  UPD_TORO.busy = false; UPD_TORO.progress = null;
  renderTab();
}
async function updToroApply() {
  if (!UPD_TORO.out) return;
  await updApplyRebuild(UPD_TORO.out, "ТОРО PM-06: " + UPD_TORO.files.map(f => f.file.name).join(", "));
  UPD_TORO.applied = true;
  renderTab();
}

/* ---------- 3. УСО ---------- */
async function updUsoRun() {
  if (UPD_USO.busy || !UPD_USO.files.length) return;
  UPD_USO.busy = true; UPD_USO.err = ""; UPD_USO.usoWk = null; UPD_USO.msg = ""; UPD_USO.applied = false;
  renderTab();
  try {
    await updLoadLibs();
    await ensureData(["usoWk"]);
    const parsed = [];
    for (const f of UPD_USO.files) {
      if (!f.year) throw new Error("Для «" + f.file.name + "» укажите год (имя «МТР УСО 2026 all.xlsx» или вручную)");
      UPD_USO.progress = { name: f.file.name, pct: 0 };
      updTickBar("updUsoBar", 0, f.file.name);
      const zip = await XLSXStream.openZip(f.file);
      const proc = USOPIPE.createProcessor(f.year);
      await updStreamPm06(zip, cells => proc.pushRow(cells), pr => {
        const pct = pr.total ? Math.round(100 * pr.done / pr.total) : 0;
        UPD_USO.progress = { name: f.file.name, pct };
        updTickBar("updUsoBar", pct, f.file.name + " — " + pct + "%");
      });
      parsed.push(proc.finish());
    }
    const years = new Set(parsed.map(r => String(r.year)));
    const props = WkUpdate.orderPropsFromDetails(UPD_TORO.results || []);
    ((D.usoWk && D.usoWk.orders) || []).forEach(o => {
      if (!props.has(String(o.order))) props.set(String(o.order), { e: o.unit, u: o.method, w: o.work, orr: o.kind, bs: o.month });
    });
    ((D.provision && D.provision.orders) || []).concat((D.provision && D.provision.closedOrders) || []).forEach(o => {
      if (!props.has(String(o.order))) props.set(String(o.order), { e: o.unit, u: o.method, w: (o.lines && o.lines[0] && o.lines[0].work) || "", orr: o.kind, bs: o.date });
    });
    USOPIPE.enrich(parsed.flatMap(r => r.rows), props);
    const fresh = WkUpdate.buildUsoWk(parsed.flatMap(r => r.rows), props, D.usoWk && D.usoWk.meta);
    UPD_USO.years = [...years];
    UPD_USO.usoWk = WkUpdate.mergeUsoWk(D.usoWk, fresh, years);
    UPD_USO.msg = "Годы " + UPD_USO.years.join(", ") + " заменены в срезе УСО WK. Остальные годы текущей витрины сохранены.";
  } catch (e) {
    UPD_USO.err = "Ошибка разбора УСО: " + (e && e.message || e);
  }
  UPD_USO.busy = false; UPD_USO.progress = null;
  renderTab();
}
async function updUsoApply() {
  if (!UPD_USO.usoWk) return;
  D.usoWk = UPD_USO.usoWk;
  await updPersist({ uso_wk: UPD_USO.usoWk }, "МТР подрядчика (УСО): " + UPD_USO.files.map(f => f.file.name).join(", "));
  UPD_USO.applied = true;
  renderTab();
}

/* результат пересборки: что изменится, сверки, кнопки */
function updOutHtml(out, applyId, applied) {
  if (!out) return "";
  const cur = out.provision.meta.asOf.slice(0, 4);
  const Y0 = out.before.exec.years[cur], Y1 = out.model.exec.years[cur];
  const unc = p => p.meta.wk.late + p.meta.wk.undated + p.meta.wk.gap;
  const bad = out.checks.filter(c => !c.ok);
  const r = out.report;
  return `
    <div class="twrap" style="margin-top:12px"><table>
      <thead><tr><th>Показатель</th><th class="n">Сейчас</th><th class="n">После пересборки</th><th class="n">Δ</th></tr></thead>
      <tbody>
        ${updDiffRow("Строк графика план-факт", out.old.rows, out.scheduleRows.length, v => num(v))}
        ${updDiffRow("Заказов WK 2024–2027", out.old.control.meta.orders, out.control.meta.orders, v => num(v))}
        ${updDiffRow(`План ${cur} (МТР + УСО)`, Y0.plan, Y1.plan, mrub)}
        ${updDiffRow(`Факт ${cur}`, Y0.fact, Y1.fact, mrub)}
        ${updDiffRow("Открытых заказов в обеспеченности", out.old.provision.meta.orders, out.provision.meta.orders, v => num(v))}
        ${updDiffRow("Потребность WK", out.old.provision.meta.wk.value, out.provision.meta.wk.value, mrub)}
        ${updDiffRow("Не покрыто к сроку", unc(out.old.provision), unc(out.provision), mrub)}
        ${updDiffRow("Факт ремонтов (свод)", out.old.repairs.meta.factTotal, out.repairs.meta.factTotal, mrub)}
        ${updDiffRow("Текстов заказов", out.old.texts, Object.keys(out.orderText.text).length, v => num(v))}
      </tbody>
    </table></div>
    <p class="hint" style="margin-top:8px">Дата данных: ${dmy(out.provision.meta.asOf)} (последняя из дат выгрузок остатков и закупки).
      ${r.files.length ? `Площадко-годы из файлов: ${r.replaced.concat(r.added).map(esc).join(", ")}.` : "Выгрузки ТОРО не менялись — пересчитаны обеспеченность и аналитика."}</p>
    ${bad.length ? callout("bad", `Сверки аналитики: ${bad.length} из ${out.checks.length} не сходятся — ${bad.map(c => esc(c.label)).join("; ")}. Проверьте выгрузки перед применением.`)
      : callout("good", `Сверки аналитики на новых данных: все ${out.checks.length} сходятся (стадии, площадки, МТР + УСО, обеспеченность, цепочка согласования, воронка).`)}
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="iconbtn on" id="${applyId}" ${applied ? "disabled" : ""}>${applied ? "Применено и сохранено" : "Применить и сохранить в браузере"}</button>
    </div>`;
}

function renderUpdate(host) {
  const f = UPD.files, toro = UPD_TORO.files, uso = UPD_USO.files;
  const um = UPD_USO.usoWk;
  const info = DATA_OVERRIDE_INFO, saved = DATA_OVERRIDE.size > 0;
  host.innerHTML = `
    <h1>Обновление данных</h1>
    <p class="sub">Три контура выгрузок SAP BW — остатки, ТОРО (PM-06) и МТР подрядчика (УСО). Всё пересобирается прямо здесь, Python не нужен: график план-факт, статусы и стадии заказов, контроль отделов, обеспеченность, свод ремонтов и тексты заказов — по тем же правилам, что сборка репозитория (совпадение проверено тестом на настоящих выгрузках). Файлы никуда не уходят.</p>

    <div class="card upd-state">
      <h3>Текущие данные</h3>
      ${saved ? `<p><span class="badge info">обновлены в этом браузере</span> ${esc(dmy(info.savedAt))} ${esc(String(info.savedAt).slice(11, 16))}. Витрины: ${[...DATA_OVERRIDE.keys()].filter(k => !/^schedule_\d+$/.test(k)).map(esc).join(", ")}${[...DATA_OVERRIDE.keys()].some(k => /^schedule_\d+$/.test(k)) ? " и график план-факт" : ""}.</p>
        <ul class="upd-log">${(info.log || []).slice().reverse().map(x => `<li>${esc(dmy(x.at))} ${esc(x.at.slice(11, 16))} — ${esc(x.label)}</li>`).join("")}</ul>
        <p class="hint">Сохранено в этом браузере и переживает перезагрузку. Чтобы обновились сами файлы отчёта: <b>«Записать в папку отчёта на диске»</b> (Chrome / Edge; укажите папку, где лежит index.html, — файлы data/ перезапишутся на месте) или скачайте архив и распакуйте его в папку отчёта с заменой. Для общего доступа — залейте папку data/ в репозиторий.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${UpdStore.canWriteFolder() ? `<button class="iconbtn on" id="updFolder" ${UPD_FOLDER.busy ? "disabled" : ""}>${UPD_FOLDER.busy ? "Запись…" : "Записать в папку отчёта на диске"}</button>
          <button class="minibtn" id="updFolderNew" title="Выбрать другую папку отчёта">Другая папка…</button>` : ""}
          <button class="iconbtn ${UpdStore.canWriteFolder() ? "" : "on"}" id="updArchive">Скачать архив data/ для публикации</button>
          <button class="minibtn" id="updReset">Вернуть опубликованные данные</button>
        </div>`
      : `<p>Опубликованные файлы папки <code>data/</code> — обновлений в этом браузере нет.</p>`}
      ${UPD_FOLDER.msg ? callout("good", esc(UPD_FOLDER.msg)) : ""}${UPD_FOLDER.err ? callout("bad", esc(UPD_FOLDER.err)) : ""}
      ${UPD_STORE_ERR ? callout("warn", esc(UPD_STORE_ERR)) : ""}
    </div>

    <div class="card">
      <h3>1. Остатки, ограниченный запас, закупка</h3>
      <p class="hint">Те же три файла, что <code>build/build_stock.py</code>. После разбора обеспеченность и аналитика пересчитываются по новым остаткам автоматически.</p>
      <div class="dl" style="grid-template-columns:170px 1fr">
        <dt>Остатки MM-M03</dt><dd><input type="file" id="updFileStock" accept=".xlsx,.XLSX"/> ${f.stock ? `<span class="badge good">✓ ${esc(f.stock.name)}</span>` : ""}</dd>
        <dt>Ограниченный запас</dt><dd><input type="file" id="updFileRestricted" accept=".xlsx,.XLSX"/> ${f.restricted ? `<span class="badge good">✓ ${esc(f.restricted.name)}</span>` : ""}</dd>
        <dt>Закупка ALL</dt><dd><input type="file" id="updFilePurchase" accept=".xlsx,.XLSX"/> ${f.purchase ? `<span class="badge good">✓ ${esc(f.purchase.name)}</span>` : ""}</dd>
      </div>
      <div style="margin-top:12px">
        <button class="iconbtn ${Object.keys(f).length === 3 ? "on" : ""}" id="updGo" ${UPD.busy ? "disabled" : ""}>${UPD.busy ? "Разбор…" : "Пересобрать остатки"}</button>
      </div>
      ${UPD.progress ? `<div class="bar" style="margin-top:10px;height:8px"><i style="width:${UPD.progress.pct}%"></i></div><p class="hint">${esc(UPD.progress.label)} — ${UPD.progress.pct}%</p>` : ""}
      ${UPD.err ? callout("bad", esc(UPD.err)) : ""}
      ${UPD.result ? `
        <div class="twrap" style="margin-top:12px"><table>
          <thead><tr><th>Показатель</th><th class="n">Сейчас</th><th class="n">Новая выгрузка</th><th class="n">Δ</th></tr></thead>
          <tbody>
            ${updDiffRow("Остаток всего", D.stock.meta.totalValue, UPD.result.meta.totalValue, rub)}
            ${updDiffRow("Доступно", D.stock.meta.totalAvailValue, UPD.result.meta.totalAvailValue, rub)}
            ${updDiffRow("Ограничено", D.stock.meta.totalRestrictedValue, UPD.result.meta.totalRestrictedValue, rub)}
            ${updDiffRow("Закупка план", D.stock.meta.totalPurchasePlanValue, UPD.result.meta.totalPurchasePlanValue, rub)}
          </tbody>
        </table></div>
        ${updOutHtml(UPD.out, "updApplyBtn", UPD.applied)}
        ${UPD.applied ? callout("good", "Остатки, обеспеченность и аналитика обновлены и сохранены в браузере.") : ""}
      ` : ""}
    </div>

    <div class="card">
      <h3>2. ТОРО · гибкий отчёт PM-06 (BW)</h3>
      <p class="hint">Сырые <code>M06_{площадка}_{год}.xlsx</code> (лист PM-06). Площадка и год — из имени, иначе вручную. Можно несколько файлов, достаточно тех, что изменились: загруженные площадко-годы заменяют свои, остальные берутся из текущих данных. Строки разводятся по балансовой единице (в файле 1200 — Вернинское и Сухой Лог). Пересобираются график план-факт, статусы SAP и стадии, копии «Развития», признак ППМ, контроль отделов, обеспеченность, свод ремонтов и тексты заказов.</p>
      <input type="file" id="updToroInput" accept=".xlsx,.XLSX" multiple hidden/>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="minibtn" type="button" id="updToroPick">Выбрать файлы PM-06…</button>
        ${toro.length ? `<button class="minibtn" type="button" id="updToroClear">Очистить</button>
          <button class="iconbtn on" type="button" id="updToroGo" ${UPD_TORO.busy ? "disabled" : ""}>${UPD_TORO.busy ? "Разбор…" : "Пересобрать витрины"}</button>` : ""}
      </div>
      ${toro.length ? `<div class="twrap" style="margin-top:10px"><table>
        <thead><tr><th>Файл</th><th class="n">МБ</th><th>Площадка</th><th>Год</th></tr></thead>
        <tbody>${toro.map((x, i) => `<tr>
          <td>${esc(x.file.name)}</td><td class="n">${(x.file.size / 1e6).toFixed(1)}</td>
          <td><input data-toro-site="${i}" value="${esc(x.site)}" size="6"/></td>
          <td><input data-toro-year="${i}" value="${esc(x.year)}" size="6"/></td>
        </tr>`).join("")}</tbody></table></div>` : `<p class="hint" style="margin-top:8px">Нажмите «Выбрать файлы» и укажите выгрузки BW PM-06.</p>`}
      ${(UPD_TORO.busy || UPD_TORO.progress) ? `<div class="bar" style="margin-top:10px;height:8px"><i id="updToroBar" style="width:${(UPD_TORO.progress && UPD_TORO.progress.pct) || 0}%"></i></div><p class="hint" id="updToroBarTxt">${esc((UPD_TORO.progress && UPD_TORO.progress.name) || "Разбор…")}</p>` : ""}
      ${UPD_TORO.err ? callout("bad", esc(UPD_TORO.err)) : ""}
      ${UPD_TORO.msg ? callout("info", esc(UPD_TORO.msg)) : ""}
      ${updOutHtml(UPD_TORO.out, "updToroApply", UPD_TORO.applied)}
      ${UPD_TORO.applied ? callout("good", "Витрины ТОиР обновлены и сохранены в браузере: график, контроль отделов, аналитика, обеспеченность, ремонты, тексты заказов.") : ""}
    </div>

    <div class="card">
      <h3>3. УСО · МТР подрядчика</h3>
      <p class="hint">Файлы <code>МТР УСО {год} all.xlsx</code> (лист тоже PM-06 — не путать с гибким отчётом ТОРО). Один файл = все площадки за год. Заводы 7101–7104 — АО «Развитие». Единица оборудования подтягивается по номеру заказа из PM-06 этого сеанса, иначе из текущих витрин. Обновляются только выбранные годы.</p>
      <input type="file" id="updUsoInput" accept=".xlsx,.XLSX" multiple hidden/>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="minibtn" type="button" id="updUsoPick">Выбрать файлы УСО…</button>
        ${uso.length ? `<button class="minibtn" type="button" id="updUsoClear">Очистить</button>
          <button class="iconbtn on" type="button" id="updUsoGo" ${UPD_USO.busy ? "disabled" : ""}>${UPD_USO.busy ? "Разбор…" : "Пересобрать УСО WK"}</button>` : ""}
      </div>
      ${uso.length ? `<div class="twrap" style="margin-top:10px"><table>
        <thead><tr><th>Файл</th><th class="n">МБ</th><th>Год</th></tr></thead>
        <tbody>${uso.map((x, i) => `<tr>
          <td>${esc(x.file.name)}</td><td class="n">${(x.file.size / 1e6).toFixed(1)}</td>
          <td><input data-uso-year="${i}" value="${esc(x.year)}" size="6"/></td>
        </tr>`).join("")}</tbody></table></div>` : `<p class="hint" style="margin-top:8px">Нажмите «Выбрать файлы» и укажите выгрузки «МТР УСО».</p>`}
      ${(UPD_USO.busy || UPD_USO.progress) ? `<div class="bar" style="margin-top:10px;height:8px"><i id="updUsoBar" style="width:${(UPD_USO.progress && UPD_USO.progress.pct) || 0}%"></i></div><p class="hint" id="updUsoBarTxt">${esc((UPD_USO.progress && UPD_USO.progress.name) || "Разбор…")}</p>` : ""}
      ${UPD_USO.err ? callout("bad", esc(UPD_USO.err)) : ""}
      ${UPD_USO.msg ? callout("info", esc(UPD_USO.msg)) : ""}
      ${um ? `
        <div class="twrap" style="margin-top:12px"><table>
          <thead><tr><th>Показатель</th><th class="n">Сейчас</th><th class="n">Новая выгрузка</th><th class="n">Δ</th></tr></thead>
          <tbody>
            ${updDiffRow("Заказов УСО WK", (D.usoWk && D.usoWk.meta.orders) || 0, um.meta.orders, v => num(v))}
            ${updDiffRow("Сумма по составу", (D.usoWk && D.usoWk.meta.planValue) || 0, um.meta.planValue, rub)}
            ${updDiffRow("Позиций", (D.usoWk && D.usoWk.meta.rows) || 0, um.meta.rows, v => num(v))}
          </tbody>
        </table></div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="iconbtn on" id="updUsoApply" ${UPD_USO.applied ? "disabled" : ""}>${UPD_USO.applied ? "Применено и сохранено" : "Применить и сохранить в браузере"}</button>
        </div>
        ${UPD_USO.applied ? callout("good", "Срез УСО WK применён и сохранён. Это не склад Полюса и не закрывает ATP.") : ""}
      ` : ""}
    </div>
  `;

  [["updFileStock", "stock"], ["updFileRestricted", "restricted"], ["updFilePurchase", "purchase"]].forEach(([id, key]) => {
    const el = byId(id); if (!el) return;
    el.onchange = e => {
      if (e.target.files[0]) UPD.files[key] = e.target.files[0];
      UPD.result = null; UPD.out = null; UPD.err = ""; UPD.applied = false;
      renderTab();
    };
  });
  const on = (id, fn) => { const el = byId(id); if (el) el.onclick = fn; };
  on("updGo", updRun); on("updApplyBtn", updApply);
  on("updArchive", updArchive); on("updReset", updReset);
  on("updFolder", () => updWriteFolder(false)); on("updFolderNew", () => updWriteFolder(true));
  on("updToroPick", () => byId("updToroInput").click());
  const inpT = byId("updToroInput");
  if (inpT) inpT.onchange = e => {
    UPD_TORO.files = [...e.target.files].map(file => ({ file, ...WkUpdate.parseToroName(file.name) }));
    UPD_TORO.out = null; UPD_TORO.err = ""; UPD_TORO.msg = ""; UPD_TORO.applied = false;
    renderTab();
  };
  qsa("[data-toro-site]", host).forEach(el => el.oninput = () => { UPD_TORO.files[+el.dataset.toroSite].site = el.value.trim(); });
  qsa("[data-toro-year]", host).forEach(el => el.oninput = () => { UPD_TORO.files[+el.dataset.toroYear].year = el.value.trim(); });
  on("updToroClear", () => { UPD_TORO.files = []; UPD_TORO.out = null; UPD_TORO.msg = ""; renderTab(); });
  on("updToroGo", updToroRun); on("updToroApply", updToroApply);
  on("updUsoPick", () => byId("updUsoInput").click());
  const inpU = byId("updUsoInput");
  if (inpU) inpU.onchange = e => {
    UPD_USO.files = [...e.target.files].map(file => ({ file, year: WkUpdate.parseUsoName(file.name) }));
    UPD_USO.usoWk = null; UPD_USO.err = ""; UPD_USO.msg = ""; UPD_USO.applied = false;
    renderTab();
  };
  qsa("[data-uso-year]", host).forEach(el => el.oninput = () => { UPD_USO.files[+el.dataset.usoYear].year = el.value.trim(); });
  on("updUsoClear", () => { UPD_USO.files = []; UPD_USO.usoWk = null; renderTab(); });
  on("updUsoGo", updUsoRun); on("updUsoApply", updUsoApply);
}

/* ===================== КАРТОЧКА ДЕТАЛИ (модалка) ===================== */
let MODAL_RETURN_FOCUS = null;
function closeModal() {
  CARD_SEQ++; CARD_TRAIL = [];
  if (byId("modalCard").hidden) return;
  byId("modalBack").hidden = true;
  byId("modalCard").hidden = true;
  document.body.classList.remove("modal-open");
  if (MODAL_RETURN_FOCUS && document.contains(MODAL_RETURN_FOCUS)) MODAL_RETURN_FOCUS.focus();
}
function jumpToCodeTab(tab, code, extra) {
  closeModal();
  G.ekmtr = String(code || "");
  if (extra && extra.order) G.order = String(extra.order);
  if (extra && extra.unit) G.unit = String(extra.unit);
  writeHash(false);
  renderGlobalFilters();
  navigateTo(tab);
}
function materialOrders(code) {
  const seen = new Set();
  return [...((D.provision || {}).orders || []), ...((D.provision || {}).closedOrders || [])]
    .filter(o => {
      if (seen.has(o.id)) return false;
      seen.add(o.id);
      return (!G.site || o.site === G.site) && (!G.model || o.model === G.model)
        && (!G.unit || o.unit === G.unit) && (!G.order || String(o.order) === String(G.order)) && (typeof pgPass !== "function" || pgPass(o.order))
        && (o.lines || []).some(l => String(l.code) === String(code));
    }).map(o => {
      const lines = o.lines.filter(l => String(l.code) === String(code));
      const sum = k => lines.reduce((s, l) => s + (+l[k] || 0), 0);
      return { ...o, materialQty: sum("qty"), materialStock: sum("fromStock"),
        materialBuy: sum("fromBuy"), materialGap: sum("gap") + sum("late") + sum("undated") };
    }).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
}
function materialOrdersHtml(code) {
  const orders = materialOrders(code);
  return '<h3 data-section="toro">Обеспеченность по заказам ТОРО</h3>' +
    (orders.length ? `<p class="hint">Заказы по выбранному контексту. Количества относятся только к этому материалу; нажмите номер, чтобы открыть весь заказ.</p>
    <div class="twrap" style="max-height:360px;overflow:auto"><table><thead><tr><th>Заказ ТОРО</th><th>Дата начала</th><th>Машина / площадка</th><th>Состояние</th><th>Потребность</th><th>Со склада</th><th>Закупка к сроку</th><th>Не покрыто к сроку</th></tr></thead><tbody>
    ${orders.map(o => `<tr><td><button class="minibtn mono" data-material-order="${esc(o.id)}">${esc(o.order)}</button></td>
    <td>${o.date ? dmy(o.date) : "Не указана"}</td><td>${esc(o.unit)} · ${esc(siteNameOf(o.site) || o.site)}</td>
    <td>${o.closed ? "Закрыт фактом" : o.materialQty <= 0 ? "Материал закрыт" : o.materialGap > 0 ? "Не обеспечен к сроку" : "Обеспечен"}</td>
    <td>${num(o.materialQty, 3)}</td><td>${num(o.materialStock, 3)}</td><td>${num(o.materialBuy, 3)}</td><td>${num(o.materialGap, 3)}</td></tr>`).join("")}
    </tbody></table></div>` : '<p class="hint">Заказы ТОРО с этим материалом в выбранном контексте не найдены.</p>');
}
function purchaseDocumentButton(r) {
  const type = r.document ? "document" : "request", id = r.document || r.request;
  return id ? `<button class="minibtn mono" data-purchase-id="${esc(id)}" data-purchase-type="${type}">${type === "request" ? "Заявка " : ""}${esc(id)}</button>` : '<span class="dim">Номер не указан</span>';
}
function materialPurchasesHtml(code) {
  const purchase = (STOCK_BY_CODE.get(String(code)) || {}).purchase;
  const rows = (purchase || {}).documents || [];
  return '<h3 data-section="purchase">Документы закупки и даты поставки</h3>' + (rows.length ?
    `<p class="hint">Дата поставки — по заказу поставщику, при отсутствии — требуемая дата. Фактический приход показан отдельно. Показаны также закрытые строки.</p>
    <div class="twrap" style="max-height:360px;overflow:auto"><table><thead><tr><th>Документ закупки / заявка</th><th>Позиция</th><th>Дата поставки</th><th>Факт поставки</th><th>Поставщик</th><th>Ещё поставить</th><th>ЕИ</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${purchaseDocumentButton(r)}</td><td>${esc(r.position || r.requestPosition || "—")}</td>
    <td>${r.deliveryDate ? dmy(r.deliveryDate) : "Не указана"}${r.orderDeliveryDate ? "" : r.deliveryDate ? " (требуемая)" : ""}</td><td>${r.actualDeliveryDate ? dmy(r.actualDeliveryDate) : "—"}</td><td>${esc(r.supplier || "—")}</td><td>${num(r.openQty, 3)}</td><td>${esc(r.unit || "—")}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="hint">${purchase ? "Текущая витрина содержит только суммы по месяцам. Номера документов и точные даты не загружены. Загрузите исходную выгрузку закупки в разделе «Обновление данных»." : "Закупка по материалу в выгрузке не найдена."}</p>`);
}
function wireMaterialDrilldowns(card, code) {
  qsa("[data-purchase-id]", card).forEach(b => b.onclick = () =>
    openPurchaseDocument(b.dataset.purchaseType, b.dataset.purchaseId, code));
  qsa("[data-material-order]", card).forEach(b => b.onclick = () => {
    const o = [...(D.provision.orders || []), ...(D.provision.closedOrders || [])].find(o => o.id === b.dataset.materialOrder);
    if (!o) return;
    openToroCard(o.order, {site:o.site,unit:o.unit});

  });
}
function openPurchaseDocument(type, id, returnCode) {
  if (!["document", "request"].includes(type) || !id) return;
  beginEntityCard(type, [id, {code:returnCode}]);
  const rows = (D.stock.items || []).flatMap(i => ((i.purchase || {}).documents || [])
    .filter(r => String(r[type] || "") === String(id)).map(r => ({ ...r, code: i.code, name: i.name })));
  const card = byId("modalCard");
  card.innerHTML = `<button class="mclose" id="mCloseBtn" aria-label="Закрыть карточку">✕</button>
    <h2 id="modalTitle">${type === "document" ? "Документ закупки" : "Заявка"} ${esc(id)}</h2>
    <p class="hint">Все строки этого документа в витрине WK, независимо от фильтров отчёта. Другие материалы документа могут отсутствовать в витрине. Строк: ${num(rows.length)}.</p>
    <button class="minibtn" id="purchaseBack">← К материалу ${esc(returnCode)}</button>
    <div class="twrap" style="margin-top:12px"><table><thead><tr><th>Позиция</th><th>ЕКМТР</th><th>Материал</th><th>Документ закупки</th><th>Заявка</th><th>Дата заявки</th><th>Заказ создан</th><th>Требуемая дата</th><th>Поставка по заказу</th><th>Факт поставки</th><th>Завод</th><th>Статус</th><th>Поставщик</th><th>Количество</th><th>Ещё поставить</th><th>В пути</th><th>Поставлено</th><th>ЕИ</th><th>Стоимость в плановых ценах, ₽</th><th>Валюта заказа</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.position || r.requestPosition || "—")}</td><td>${codeLink(r.code)}</td><td>${esc(r.name)}</td>
      <td>${r.document ? entityLink("document",r.document) : "—"}</td><td>${r.request ? entityLink("request",r.request) : "—"}</td><td>${r.requestDate ? dmy(r.requestDate) : "Не указана"}</td><td>${r.orderCreatedDate ? dmy(r.orderCreatedDate) : "—"}</td><td>${r.requiredDate ? dmy(r.requiredDate) : "—"}</td><td>${r.orderDeliveryDate ? dmy(r.orderDeliveryDate) : "Не указана"}</td><td>${r.actualDeliveryDate ? dmy(r.actualDeliveryDate) : "—"}</td><td>${esc(r.plant || "—")}</td><td>${esc(r.status || "—")}</td>
      <td>${esc(r.supplier || "—")}</td><td>${num(r.qty, 3)}</td><td>${num(r.openQty, 3)}</td><td>${num(r.transitQty, 3)}</td><td>${r.deliveredQty == null ? "—" : num(r.deliveredQty, 3)}</td><td>${esc(r.unit || "—")}</td><td>${num(r.value, 2)}</td><td>${esc(r.currency || "—")}</td></tr>`).join("")}
    </tbody></table></div>`;
  byId("mCloseBtn").onclick = closeModal;
  byId("purchaseBack").hidden = !returnCode;
  byId("purchaseBack").onclick = () => openCodeDetail(returnCode);
  finishEntityCard();
  wireCodeLinks(card);
  byId("mCloseBtn").focus();
}

function openCodeDetail(code, needDate) {
  const c = String(code || "");
  if (!c) return;
  beginEntityCard("material", [code, needDate]);
  const stock = STOCK_BY_CODE.get(c);
  const cat = catalogByEkmtr(c);
  const prov = ((D.provision && D.provision.items) || []).find(i => String(i.code) === c);
  const need = needDate || (prov && prov.firstNeed) || "";
  const vs = purchaseAgainstDate(stock && stock.purchase, need);
  const rate = getRate();
  const back = byId("modalBack"), card = byId("modalCard");
  back.hidden = false; card.hidden = false;
  document.body.classList.add("modal-open");
  back.onclick = closeModal;
  const wh = warehouseBreakdown(stock && stock.byWarehouse);
  const purch = stock && stock.purchase;
  card.innerHTML = `
    <button class="mclose" id="mCloseBtn" type="button" aria-label="Закрыть карточку">✕</button>
    <h2 class="mono" id="modalTitle">${esc(c)}</h2>
    <p class="sub" style="margin:0">${esc((cat && cat.nameRu) || (stock && stock.name) || (prov && prov.name) || "")}</p>
    <dl class="dl">
      ${cat ? `<dt>Каталожный №</dt><dd class="mono">${entityLink("part",cat.art)} · ${esc(cat.model || "")}</dd>
      <dt>Цена ДП</dt><dd>${cny(cat.priceCNY)}${rate && cat.priceCNY != null ? ` · ${rub(cat.priceCNY * rate)}` : ""}</dd>
      <dt>Цена УСО</dt><dd>${cny(cat.priceUsoCNY)}</dd>` : `<dt>Прайс</dt><dd class="dim">нет в прайсе ДП</dd>`}
      <dt>ЕКМТР</dt><dd class="mono">${esc(c)}</dd>
    </dl>
    <h3 data-section="stock" style="font-size:12.5px;margin:16px 0 6px">Наличие по складам</h3>
    ${stock ? `
      <dl class="dl">
        <dt>Остаток</dt><dd>${num(stock.qty, 1)} ед. · ${rub(stock.value)}</dd>
        <dt>Доступно</dt><dd>${num(stock.availQty, 1)} ед. · ${rub(stock.availValue)}</dd>
        ${stock.restrictedValue > 0 ? `<dt>Ограничено</dt><dd><span class="badge restricted">${rub(stock.restrictedValue)}</span></dd>` : ""}
      </dl>
      <p class="hint">Склад в выгрузке MM-M03 — имя, не код площадки. Площадка подписана по названию склада, где это однозначно.</p>
      <div class="toolbar" style="flex-wrap:wrap">${warehouseHtml(stock.byWarehouse, G.site) || '<span class="dim">разбивки нет</span>'}</div>
      ${wh.length ? `<div class="twrap" style="margin-top:8px"><table><thead><tr><th>Склад</th><th>Площадка</th><th class="n">Кол-во</th></tr></thead><tbody>
        ${wh.map(r => `<tr${G.site && r.site === G.site ? ' class="lo-pin"' : ""}><td>${esc(r.name)}</td><td>${esc(r.site ? r.site + " · " + r.label : r.label)}</td><td class="n">${num(r.qty, 1)}</td></tr>`).join("")}
      </tbody></table></div>` : ""}
    ` : '<p class="hint">Остатка по этому коду в витрине WK нет.</p>'}
    <h3 style="font-size:12.5px;margin:16px 0 6px">Закупка: заявки и заказы</h3>
    ${purch && purch.openQty > 0 ? `
      <dl class="dl">
        <dt>Ещё поставить</dt><dd>${num(purch.openQty, 1)} ед. · ${rub(purch.planV)}</dd>
        <dt>В пути</dt><dd>${num(purch.transitQty, 1)}</dd>
        <dt>Поставщик</dt><dd>${esc(purch.topSupplier || "—")}</dd>
        <dt>Срок (медиана)</dt><dd>${purch.leadDays ? num(purch.leadDays) + " дн." : "—"}</dd>
        ${need ? `<dt>Начало работ</dt><dd>${dmy(need)}</dd>` : ""}
        <dt>К дате работ</dt><dd><span class="badge ${vs.status === "onTime" ? "good" : vs.status === "none" ? "bad" : "warn"}">${esc(vs.label)}</span></dd>
      </dl>
      <p class="hint">График — открытое количество «ещё поставить» по месяцу даты поставки из выгрузки закупки, не корзина ATP.</p>
      <div class="toolbar" style="flex-wrap:wrap">${purchaseMonthsHtml(purch)}</div>
    ` : callout("warn", "<b>Не заказано.</b> В открытых заявках и заказах закупки этой позиции нет — это не то же самое, что «дефицит ATP»: ATP мог закрыть строку складом или чужим приходом.")}
    ${materialPurchasesHtml(c)}
    ${materialOrdersHtml(c)}
    ${prov ? `<h3 style="font-size:12.5px;margin:16px 0 6px">Обеспеченность плана (все площадки)</h3>
      <dl class="dl">
        <dt>Нужно</dt><dd>${num(prov.needQty, 1)} · ${rub(prov.needValue)}</dd>
        <dt>Со склада</dt><dd>${num(prov.fromStock, 1)}</dd>
        <dt>Закупка к сроку</dt><dd>${num(prov.fromBuy, 1)}</dd>
        <dt>Не покрыто</dt><dd>${num(prov.late + prov.undated + prov.gap, 1)} · ${rub(prov.gapValue)}</dd>
      </dl>` : ""}
    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
      ${cartAddBtn({ code: c, name: (cat && cat.nameRu) || (stock && stock.name) || c, value: (stock && stock.availValue) || null, source: "Карточка позиции" })}
      ${cat ? `<button class="minibtn" type="button" id="mOpenArt">Карточка каталога ${esc(cat.art)}</button>` : ""}
      <button class="minibtn" type="button" data-lookup="${esc(cat ? cat.art : c)}">История, цены и статус →</button>
    </div>
  `;
  byId("mCloseBtn").onclick = closeModal;
  wireCartButtons(card);
  wireMaterialDrilldowns(card, c);
  finishEntityCard(c);
  const artBtn = byId("mOpenArt");
  if (artBtn) artBtn.onclick = () => openDetail(cat.art);
  byId("mCloseBtn").focus();
}

function openDetail(art) {
  const item = CATALOG_BY_ART.get(art);
  if (!item) return;
  beginEntityCard("part", [art]);
  const stock = item.ekmtr ? STOCK_BY_CODE.get(item.ekmtr) : null;
  const group = INTER_GROUP_OF.get(interKey(item.art));
  const drawings = (D.drawings && D.drawings.byNum && (D.drawings.byNum[item.art] ||
    (item.tree && item.tree[0] ? D.drawings.byNum[item.tree[0].num] : null))) || null;
  const linkomeRows = linkomeRowsFor(item.art) ||
    (item.tree[0] ? linkomeRowsFor(item.tree[0].num) : null);

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
      <dt>Код ЕКМТР</dt><dd class="mono">${item.ekmtr ? codeLink(item.ekmtr) + (item.ekmtrAmbiguous ? ' <span class="badge warn">неоднозначно</span>' : "") : '<span class="badge bad">не кодифицировано</span>'}</dd>
      ${item.artNew ? `<dt>Артикул обн.</dt><dd class="mono">${esc(item.artNew)}</dd>` : ""}
    </dl>
    ${item.ekmtr ? `<p class="hint">Локально по коду ${esc(item.ekmtr)}: склад и закупка, обеспеченность, график план-факт.</p>
    <p class="sactions" style="display:flex;flex-wrap:wrap;gap:6px">
      <button class="minibtn" type="button" data-open-code="${esc(item.ekmtr)}">Склад и закупка</button>
      <button class="minibtn" type="button" data-jump-provision="${esc(item.ekmtr)}">Обеспеченность</button>
      <button class="minibtn" type="button" data-jump-repairs="${esc(item.ekmtr)}">График план-факт</button>
      <button class="minibtn" type="button" data-lookup="${esc(item.art)}">История, цены и статус →</button>
    </p>` : ""}
    ${stock ? `
      <h3 style="font-size:12.5px;margin:16px 0 6px">Остаток и закупка</h3>
      <dl class="dl">
        <dt>Остаток</dt><dd>${num(stock.qty, 1)} ед. · ${rub(stock.value)}</dd>
        <dt>Доступно</dt><dd>${rub(stock.availValue)}</dd>
        ${stock.restrictedValue > 0 ? `<dt>Ограничено</dt><dd><span class="badge restricted">${rub(stock.restrictedValue)}</span>${stock.fullyRestricted ? " — весь остаток" : ""}</dd>` : ""}
        ${stock.purchase && stock.purchase.openQty ? `<dt>В закупке</dt><dd>${rub(stock.purchase.planV)} · ещё поставить ${num(stock.purchase.openQty, 1)} ед.<div class="sup-sub">${purchaseMonthsHtml(stock.purchase)}</div></dd>` : `<dt>Закупка</dt><dd><span class="badge bad">не заказано</span></dd>`}
      </dl>
      <div class="toolbar" style="flex-wrap:wrap">${warehouseHtml(stock.byWarehouse, G.site)}</div>` : (item.ekmtr ? '<p class="hint">Остатка по этому коду нет.</p>' : "")}

    ${item.ekmtr ? materialPurchasesHtml(item.ekmtr) + materialOrdersHtml(item.ekmtr) : ""}
    ${item.tree.length ? `
      <h3 style="font-size:12.5px;margin:16px 0 6px">В узлах${item.treeMethod === "parent" ? ' <span class="badge info">через родителя</span>' : ""}</h3>
      ${item.treeMethod === "parent" ? `<p class="hint">Номер ${esc(item.art)} сам в ведомости взаимозаменяемости не значится — показан узел-родитель на уровень выше (${esc(item.tree[0].num)}).</p>` : ""}
      <dl class="dl">
        ${item.tree.map(t => `<dt>${esc(t.book)}</dt><dd>${esc(t.mech)} · кол-во ${num(t.qty)}${item.treeMethod === "parent" ? ` <span class="dim">(${esc(t.num)})</span>` : ""}</dd>`).join("")}
      </dl>` : ""}

    ${group ? `
      <h3 style="font-size:12.5px;margin:16px 0 6px">Взаимозаменяемые номера</h3>
      <p class="mono" style="font-size:12px">${group.map(interPartLink).join(", ")}</p>
      <p class="hint">Прямые связи Excel. Перед выбором сверяйте комплектацию и примечание строки:</p>
      ${(D.interchange.evidence || []).filter(g => g.parts.some(p => interKey(p.num) === interKey(item.art))).map(g =>
        `<p class="hint">${esc(g.sheet)} · строка ${g.row} · ${esc(g.parts.map(p => p.book + ": " + p.num).join(" ↔ "))}<br>${esc(g.note || "Без примечания")}</p>`).join("")}` : ""}

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
  finishEntityCard(item.ekmtr);
  wireInterLinks(card);
  wireMaterialDrilldowns(card, item.ekmtr);
  const codeBtn = qs("[data-open-code]", card);
  if (codeBtn) codeBtn.onclick = () => openCodeDetail(codeBtn.dataset.openCode);
  const jp = qs("[data-jump-provision]", card);
  if (jp) jp.onclick = () => jumpToCodeTab("provision", jp.dataset.jumpProvision);
  const jr = qs("[data-jump-repairs]", card);
  if (jr) jr.onclick = () => jumpToCodeTab("repairs", jr.dataset.jumpRepairs);
  byId("mCloseBtn").focus();
}

/* ===================== БАЗА ЗНАНИЙ ===================== */
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

  for (const i of (D.catalog && D.catalog.items) || []) {
    if (hitNum(i.art) || hit(i.nameRu) || hit(i.nameZh) || hitNum(i.ekmtr)) out.parts.push(i);
  }
  const byPart = D.linkome && D.linkome.byPart;
  if (byPart) for (const key in byPart) {
    const rows = byPart[key];
    if (key.includes(num) && hasNum) { out.linkome.push([key, rows]); continue; }
    if (lo.length >= 2 && rows.some(r => hit(r.name))) out.linkome.push([key, rows]);
  }
  for (const n of (D.tree && D.tree.nodes) || []) {
    if (hitNum(n.num) || hit(n.nameRu) || hit(n.nameZh) || hit(n.mech)) out.nodes.push(n);
  }
  for (const e of (D.ekmtrWk && D.ekmtrWk.items) || []) {
    if (hitNum(e.code) || hit(e.name) || hitNum(e.cat)) out.ekmtr.push(e);
  }
  for (const u of (D.fleet && D.fleet.units) || []) {
    if (hit(u.name) || hit(u.model) || hit(u.garage) || hit(u.book) ||
        hitNum(u.serial) || hit(u.siteName) || hit(u.site)) out.fleet.push(u);
  }
  for (const d of (D.kb && D.kb.docs) || []) {
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
    ekmtr: item.ekmtr ? codeLink(item.ekmtr) : '<span class="dim">—</span>',
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
  const contextQuery = G.part || G.ekmtr || G.order || G.unit || KB_SEARCH_QUERY;
  const models = [...new Set(D.kb.docs.map(d => d.model).filter(Boolean))].sort();
  const ctxModels = (G.site || G.model || G.unit) ? contextModels() : null;
  const docsBase = D.kb.docs.filter(d => !ctxModels || !ctxModels.size || !d.model || ctxModels.has(d.model));
  const classCount = {};
  docsBase.forEach(d => { classCount[d.class] = (classCount[d.class] || 0) + 1; });
  const classes = Object.entries(classCount).sort((a, b) => b[1] - a[1]);
  host.innerHTML = `
    <h1>База знаний</h1>
    ${contextBanner()}
    <p class="sub">${num(docsBase.length)} документов: руководства, схемы, нормы ТО, чертежи. Разложены по системам и машинам.</p>
    ${schemePanelHtml()}
    <div class="kb-models" id="kbModels">
      <button type="button" class="pill ${!KB_FILTER.model ? "on" : ""}" data-kb-model="">Все машины</button>
      ${models.filter(m => !ctxModels || !ctxModels.size || ctxModels.has(m)).map(md =>
        `<button type="button" class="pill ${KB_FILTER.model === md ? "on" : ""}" data-kb-model="${esc(md)}">${esc(md)}</button>`).join("")}
      <button type="button" class="pill ${KB_FILTER.model === "__none" ? "on" : ""}" data-kb-model="__none">Общие</button>
    </div>
    <div class="kb-layout">
      <aside class="kb-sys" id="kbClasses"></aside>
      <div>
        <div class="toolbar">
          <input type="search" id="kbQ" placeholder="Название документа…" value="${esc(KB_FILTER.q || "")}"/>
          <span class="count" id="kbCount"></span>
        </div>
        <div id="kbBoard"></div>
      </div>
    </div>

    <div class="card" style="margin-top:18px">
      <h3>Поиск по всему</h3>
      <p class="hint">Номер детали, ЕКМТР, борт, содержимое документа.</p>
      <input type="search" id="kbSearchQ" placeholder="K1601.30.02, пружина, 1001785, регламент…" value="${esc(contextQuery)}"/>
      <div id="kbSearchResults" style="margin-top:10px"></div>
    </div>
  `;
  byId("kbClasses").innerHTML = `<button type="button" class="kbclass ${!KB_FILTER.cls ? "on" : ""}" data-c=""><div class="n">${num(docsBase.length)}</div><div class="l">Все системы</div></button>` +
    classes.map(([c, n]) => `
    <button type="button" class="kbclass ${KB_FILTER.cls === c ? "on" : ""}" data-c="${esc(c)}">
      <div class="n">${n}</div><div class="l">${esc(c)}</div>
    </button>`).join("");

  const byPath = new Map(D.kb.docs.map(d => [d.path, d]));
  let searchTimer;
  let searchRequest = 0;
  let kbShown = 36;

  function kbDocCard(d) {
    return `<article class="kb-doc">
      <h4 title="${esc(d.name)}">${esc(d.name.replace(/\.[a-z0-9]+$/i, ""))}</h4>
      <div class="kb-meta">
        <span class="badge info">${esc(d.class)}</span>
        ${d.model ? `<span class="badge">${esc(d.model)}</span>` : `<span class="badge">общая</span>`}
        <span class="dim">${num(d.sizeBytes / 1e6, 1)} МБ</span>
      </div>
      <a class="minibtn" href="${esc(kbFileUrl(d.path))}" target="_blank" rel="noopener">Открыть</a>
    </article>`;
  }

  function apply() {
    const q = (byId("kbQ").value || KB_FILTER.q || "").trim().toLowerCase();
    KB_FILTER.q = q;
    let rows = docsBase.filter(d => {
      if (KB_FILTER.cls && d.class !== KB_FILTER.cls) return false;
      if (KB_FILTER.model === "__none" && d.model) return false;
      if (KB_FILTER.model && KB_FILTER.model !== "__none" && d.model !== KB_FILTER.model) return false;
      if (q && !d.name.toLowerCase().includes(q) && !(d.class || "").toLowerCase().includes(q)) return false;
      return true;
    });
    byId("kbCount").textContent = num(rows.length) + " документов";
    const groups = new Map();
    rows.forEach(d => {
      const k = d.class || "Прочее";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    });
    const board = byId("kbBoard");
    let html = "";
    groups.forEach((list, cls) => {
      const shown = list.slice(0, kbShown);
      html += `<section class="kb-group"><h3>${esc(cls)} <span class="count">${num(list.length)}</span></h3>
        <div class="kb-docgrid">${shown.map(kbDocCard).join("")}</div>
        ${list.length > shown.length ? `<button class="minibtn" type="button" data-kb-more>Ещё ${num(list.length - shown.length)}</button>` : ""}
      </section>`;
    });
    board.innerHTML = html || callout("info", "Нет документов в этом срезе.");
    qsa("[data-kb-more]", board).forEach(b => b.onclick = () => { kbShown += 48; apply(); });
  }

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
          <td class="mono">${entityLink("part",i.art)}</td><td class="wrap">${kbMark(i.nameRu || "", q)}</td>
          <td>${esc(i.model || "")}</td><td class="mono">${i.ekmtr ? codeLink(i.ekmtr) : '<span class="dim">—</span>'}</td>
          <td class="n">${i.priceCNY == null ? "" : cny(i.priceCNY)}</td></tr>`).join("")}</tbody>
        </table></div>`, KB_LIMIT));
    }
    if (r.linkome.length) {
      h.push(kbSection("Состав узлов LinkOne", r.linkome.length, `<div class="twrap"><table>
        <thead><tr><th>Номер</th><th>Наименование</th><th>Где встречается</th></tr></thead>
        <tbody>${r.linkome.slice(0, KB_LIMIT).map(([, rows]) => {
          const f = rows[0];
          return `<tr class="mrow" data-book="${esc(f.book)}" data-page="${esc(f.page)}">
            <td class="mono">${entityLink("part",f.raw)}</td><td class="wrap">${kbMark(f.name || "", q)}</td>
            <td class="wrap"><span class="badge info">${esc(f.book)}</span> ${esc(f.pageTitle || f.page)}${rows.length > 1 ? ` <span class="dim">+${rows.length - 1}</span>` : ""}</td></tr>`;
        }).join("")}</tbody></table></div>`, KB_LIMIT));
    }
    if (r.nodes.length) {
      h.push(kbSection("Узлы дерева", r.nodes.length, `<div class="twrap"><table>
        <thead><tr><th>Номер</th><th>Наименование</th><th>Механизм</th><th>Книга</th><th>Модель</th></tr></thead>
        <tbody>${r.nodes.slice(0, KB_LIMIT).map(n => `<tr class="mrow" data-book="${esc(n.book)}" data-page="${esc(n.num)}">
          <td class="mono">${kbMark(n.num, q)}</td><td class="wrap">${kbMark(n.nameRu || "", q)}</td>
          <td class="wrap">${esc(n.mech || "")}</td><td>${esc(n.book || "")}</td><td>${esc(n.model || "")}</td></tr>`).join("")}</tbody>
        </table></div>`, KB_LIMIT));
    }
    if (r.ekmtr.length) {
      h.push(kbSection("Коды ЕКМТР", r.ekmtr.length, `<div class="twrap"><table>
        <thead><tr><th>Код</th><th>Наименование</th><th>Каталожный</th><th>Изготовитель</th></tr></thead>
        <tbody>${r.ekmtr.slice(0, KB_LIMIT).map(e => `<tr>
          <td class="mono">${codeLink(e.code)}</td><td class="wrap">${kbMark(e.name || "", q)}</td>
          <td class="mono">${e.cat ? entityLink("part",e.cat) : "—"}</td><td>${esc(e.mf || "")}</td></tr>`).join("")}</tbody>
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

  qsa(".kbclass", host).forEach(el => el.onclick = () => {
    KB_FILTER.cls = KB_FILTER.cls === el.dataset.c ? "" : el.dataset.c;
    qsa(".kbclass", host).forEach(x => x.classList.toggle("on", x.dataset.c === KB_FILTER.cls));
    kbShown = 36;
    apply();
  });
  qsa("[data-kb-model]", host).forEach(el => el.onclick = () => {
    KB_FILTER.model = el.dataset.kbModel || "";
    qsa("[data-kb-model]", host).forEach(x => x.classList.toggle("on", (x.dataset.kbModel || "") === KB_FILTER.model));
    kbShown = 36;
    apply();
  });
  makeActivatable(host, ".kbclass,[data-kb-model]");
  byId("kbQ").oninput = e => { KB_FILTER.q = e.target.value; apply(); };
  const schemeBtn = byId("schemeOpenLo");
  if (schemeBtn) schemeBtn.onclick = () => {
    const hit = loFocusContext();
    if (hit) { LO.book = hit.book; LO.current = hit.page; LO.index = null; LO.focusRaw = hit.raw; }
    navigateTo("linkone");
  };
  apply();
  if (contextQuery.length >= 2) kbRenderResults(contextQuery, byId("kbSearchResults"));
}

/* ---------- навигация / поиск / тема ---------- */
const VALID_TABS = new Set(["sum", "analytics", "control", "lookup", "catalog", "linkone", "kb", "fleet", "repairs", "provision", "stock", "purchase", "codif", "inter", "dq", "doc", "upd", "cart"]);
let CMD_ROWS = [];
function setRole(role) {
  ROLE = ROLES[role] ? role : "all";
  try { localStorage.setItem("wkcrm_role", ROLE); } catch (e) { /* unavailable */ }
  applyRoleChrome();
  if (!tabAllowed(TAB)) {
    const tabs = (ROLES[ROLE].tabs || ["sum"]);
    navigateTo(tabs[0]);
  } else {
    writeHash(false);
  }
}
function cmdClose() {
  const back = byId("cmdBack");
  if (back) back.hidden = true;
}
function cmdOpen(prefill) {
  const back = byId("cmdBack"), input = byId("cmdInput");
  if (!back || !input) {
    KB_SEARCH_QUERY = prefill || "";
    navigateTo("kb");
    return;
  }
  back.hidden = false;
  input.value = prefill != null ? prefill : (byId("globalSearch").value || "");
  input.focus();
  cmdRender(input.value);
}
function cmdRender(q) {
  const list = byId("cmdList");
  if (!list) return;
  const needle = String(q || "").trim();
  if (needle.length < 2) {
    CMD_ROWS = [];
    list.innerHTML = '<p class="hint">Минимум два символа. Enter открывает первый результат, Esc закрывает.</p>';
    return;
  }
  const r = kbFindAll(needle);
  const rows = [];
  if (typeof openLookup === "function") {
    const exact = r.parts.find(i => normArt(i.art) === normArt(needle)) || r.ekmtr.find(e => String(e.code) === needle);
    rows.push({ kind: "Поиск", title: exact ? (exact.art || exact.code) : needle, sub: "история расхода, план, цены, закупка и наличие", run: () => { cmdClose(); openLookup(exact ? (exact.art || exact.code) : needle); } });
  }
  r.parts.slice(0, 8).forEach(i => rows.push({ kind: "Деталь", title: i.art, sub: i.nameRu || "", run: () => { cmdClose(); openPartCard(i.art); } }));
  r.ekmtr.slice(0, 6).forEach(e => rows.push({ kind: "ЕКМТР", title: e.code, sub: e.name || "", run: () => { cmdClose(); openCodeDetail(e.code); } }));
  r.fleet.slice(0, 6).forEach(u => rows.push({ kind: "Борт", title: u.name, sub: `${u.siteName || u.site || ""} · ${u.model || ""}`, run: () => { cmdClose(); G.site = u.site || ""; G.model = u.model || ""; G.unit = u.name; writeHash(false); renderGlobalFilters(); navigateTo("fleet"); } }));
  if (D.provision && D.provision.orders) {
    const lo = needle.toLowerCase();
    D.provision.orders.filter(o => String(o.order).toLowerCase().includes(lo)).slice(0, 5)
      .forEach(o => rows.push({ kind: "Заказ", title: o.order, sub: o.unit || "", run: () => { cmdClose(); openToroCard(o.order, {site:o.site,unit:o.unit}); } }));
    (D.provision.closedOrders || []).filter(o => String(o.order).toLowerCase().includes(lo)).slice(0, 3)
      .forEach(o => rows.push({ kind: "Заказ", title: o.order, sub: (o.unit || "") + " · закрыт", run: () => { cmdClose(); openToroCard(o.order, {site:o.site,unit:o.unit}); } }));
  }
  r.nodes.slice(0, 5).forEach(n => rows.push({ kind: "Узел", title: n.num, sub: n.nameRu || "", run: () => { cmdClose(); LO.book = n.book; LO.current = n.num; LO.index = null; navigateTo("linkone"); } }));
  r.docs.slice(0, 5).forEach(d => rows.push({ kind: "Документ", title: d.name, sub: d.class || "", run: () => { cmdClose(); KB_SEARCH_QUERY = needle; navigateTo("kb"); } }));
  CMD_ROWS = rows;
  if (!rows.length) {
    list.innerHTML = '<p class="hint">Ничего не найдено в загруженных витринах.</p>';
    return;
  }
  list.innerHTML = rows.map((row, i) =>
    `<button class="cmd-row${i === 0 ? " on" : ""}" data-i="${i}" type="button"><span class="kind">${esc(row.kind)}</span><b>${esc(row.title)}</b><span class="sub">${esc(row.sub)}</span></button>`
  ).join("");
  qsa(".cmd-row", list).forEach(btn => btn.onclick = () => CMD_ROWS[+btn.dataset.i] && CMD_ROWS[+btn.dataset.i].run());
}
function copyShareLink() {
  const url = location.href;
  const done = () => {
    const btn = byId("btnShare");
    if (!btn) return;
    const prev = btn.getAttribute("data-label") || "Ссылка";
    btn.textContent = "Скопировано";
    setTimeout(() => { btn.textContent = prev; }, 1400);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => { prompt("Ссылка на текущий вид", url); });
  } else prompt("Ссылка на текущий вид", url);
}
function navigateTo(tab, { updateHash = true, focusMain = true } = {}) {
  if (VALID_TABS.has(tab) && !tabAllowed(tab)) {
    ROLE = "all";
    try { localStorage.setItem("wkcrm_role", ROLE); } catch (e) { /* unavailable */ }
    const roleSel = byId("roleSelect");
    if (roleSel) roleSel.value = ROLE;
    applyRoleChrome();
  }
  TAB = VALID_TABS.has(tab) ? tab : "sum";
  if (!tabAllowed(TAB)) TAB = ((ROLES[ROLE] || ROLES.all).tabs || ["sum"])[0];
  if (TAB !== "repairs") SFULL = false;
  if (TAB !== "linkone") {
    LO.fullscreen = false;
    document.body.classList.remove("lo-full-open");
  }
  qsa("#tabs button").forEach(x => {
    const active = x.dataset.t === TAB;
    x.classList.toggle("on", active); x.setAttribute("aria-selected", active ? "true" : "false"); x.tabIndex = active ? 0 : -1;
  });
  applyRoleChrome();
  if (updateHash) writeHash(true);
  renderTab();
  if (focusMain) byId("main").focus({ preventScroll: true });
}

function applyHashState(raw, push) {
  const parsed = parseHash(raw);
  TAB = VALID_TABS.has(parsed.tab) ? parsed.tab : "sum";
  if (parsed.role && ROLES[parsed.role]) ROLE = parsed.role;
  G = { site: "", model: "", unit: "", order: "", ekmtr: "", part: "", pg: "", ...parsed.g };
  if (parsed.tab === "lookup" && typeof LK !== "undefined") LK.q = parsed.q;
  if (!tabAllowed(TAB)) TAB = ((ROLES[ROLE] || ROLES.all).tabs || ["sum"])[0];
  renderGlobalFilters();
  navigateTo(TAB, { updateHash: !!push, focusMain: false });
}

function initNav() {
  let savedRole = null, savedTheme = null;
  try { savedRole = localStorage.getItem("wkcrm_role"); savedTheme = localStorage.getItem("wkcrm_theme"); } catch (e) { /* unavailable */ }
  const parsed = parseHash(location.hash);
  TAB = VALID_TABS.has(parsed.tab) ? parsed.tab : "sum";
  ROLE = ROLES[parsed.role] ? parsed.role : (ROLES[savedRole] ? savedRole : "all");
  G = { site: "", model: "", unit: "", order: "", ekmtr: "", part: "", pg: "", ...parsed.g };
  if (parsed.tab === "lookup" && typeof LK !== "undefined") LK.q = parsed.q;
  if (!tabAllowed(TAB)) TAB = ((ROLES[ROLE] || ROLES.all).tabs || ["sum"])[0];
  const visibleTabs = () => qsa("#tabs button").filter(b => !b.hidden);
  qsa("#tabs button").forEach(b => {
    b.onclick = () => navigateTo(b.dataset.t);
    b.onkeydown = e => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault(); const tabs = visibleTabs(); let i = tabs.indexOf(b);
      if (i < 0) i = 0;
      i = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[i].focus();
    };
  });
  qsa("#tabs button").forEach(x => { const active = x.dataset.t === TAB; x.classList.toggle("on", active); x.setAttribute("aria-selected", active ? "true" : "false"); x.tabIndex = active ? 0 : -1; });
  applyRoleChrome();
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
  const share = byId("btnShare");
  if (share) { share.setAttribute("data-label", share.textContent); share.onclick = copyShareLink; }
  const roleSel = byId("roleSelect");
  if (roleSel) { roleSel.value = ROLE; roleSel.onchange = e => setRole(e.target.value); }
  cartUpdateBadge();
  const search = byId("globalSearch");
  search.addEventListener("focus", () => cmdOpen(search.value));
  search.oninput = debounce(e => cmdOpen(e.target.value), 180);
  const cmdInput = byId("cmdInput");
  if (cmdInput) {
    cmdInput.oninput = debounce(e => cmdRender(e.target.value), 140);
    cmdInput.onkeydown = e => {
      if (e.key === "Escape") { cmdClose(); search.focus(); }
      if (e.key === "Enter" && CMD_ROWS[0]) { e.preventDefault(); CMD_ROWS[0].run(); }
    };
  }
  const cmdBack = byId("cmdBack");
  if (cmdBack) cmdBack.addEventListener("click", e => { if (e.target === cmdBack) cmdClose(); });
  window.addEventListener("hashchange", () => {
    if (location.hash === serializeHash(TAB, ROLE, G, typeof LK !== "undefined" ? LK.q : "")) return;
    applyHashState(location.hash, false);
  });
}

document.addEventListener("keydown", e => {
  if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) {
    e.preventDefault(); cmdOpen(byId("globalSearch") && byId("globalSearch").value);
    return;
  }
  const cmdBack = byId("cmdBack");
  if (e.key === "Escape" && cmdBack && !cmdBack.hidden) { cmdClose(); return; }
  const card = byId("modalCard");
  if (e.key === "Escape" && !card.hidden) { closeModal(); return; }
  if (e.key === "Escape" && SFULL) { SFULL = false; renderSchedule(byId("main")); return; }
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

initEntityLinks();
initNav();
boot();
