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

/* ---------- состояние ---------- */
const D = {}; // сюда лягут все витрины после загрузки
let TAB = "sum";

/* ---------- generic sortable table ---------- */
function renderTable(container, { rows, cols, sortKey, sortDir = -1, rowClass, limit, onRowClick }) {
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
    container.innerHTML = `<div class="twrap"><table>${thead}${tbody}</table></div>` +
      (limit && rows.length > limit ? `<div class="count">показано ${limit} из ${rows.length}</div>` : "");
    qsa("th", container).forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      if (k === key) dir = -dir; else { key = k; dir = -1; }
      draw();
    });
    if (onRowClick) {
      qsa("tbody tr", container).forEach(tr => tr.onclick = () => onRowClick(shown[+tr.dataset.ri]));
    }
  }
  draw();
}

function callout(kind, html) { return `<div class="callout ${kind}">${html}</div>`; }
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
  drawings: "data/drawings.json",
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
function buildIndexes() {
  STOCK_BY_CODE = new Map(D.stock.items.map(i => [i.code, i]));
  EKMTR_NAME = new Map(D.ekmtrWk.items.map(i => [i.code, i.name]));
  CATALOG_BY_ART = new Map(D.catalog.items.map(i => [i.art, i]));
  D.interchange.groups.forEach(g => g.forEach(num => INTER_GROUP_OF.set(num, g)));
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
  }
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
function renderCatalog(host) {
  const items = D.catalog.items;
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
      <span class="count" id="catCount"></span>
    </div>
    <div id="catTable"></div>
  `;
  let noCodeOnly = false, diffOnly = false;
  function apply() {
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
      cols: [
        { key: "art", label: "Артикул", cls: "mono" },
        { key: "model", label: "Модель" },
        { key: "nameRu", label: "Наименование", cls: "wrap" },
        { key: "resource", label: "Ресурс, м/ч", numeric: true },
        { key: "priceCNY", label: "Цена, ¥", numeric: true, fmt: cny },
        { key: "priceDiffCNY", label: "Δ УСО", numeric: true, fmt: v => v == null ? "" : `<span class="badge warn">${cny(v)}</span>` },
        {
          key: "ekmtr", label: "ЕКМТР", cls: "mono", fmt: (v, r) => v
            ? `${esc(v)}${r.ekmtrAmbiguous ? ' <span class="badge warn">?</span>' : ""}`
            : '<span class="badge bad">нет</span>'
        },
        {
          key: "tree", label: "Узел", cls: "wrap", fmt: v => v && v.length
            ? esc(v[0].mech) + (v.length > 1 ? ` (+${v.length - 1})` : "")
            : '<span class="dim">—</span>'
        },
        {
          key: "art", label: "Чертёж", cls: "", fmt: (v) => D.drawings.byNum[v]
            ? '<span class="badge good">есть</span>' : ""
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
function renderFleet(host) {
  host.innerHTML = `
    <h1>Парк WK</h1>
    <p class="sub">${D.fleet.meta.units} единиц (карточки-дубли в КТГ схлопнуты). ${D.fleet.meta.matchedToBook} связаны с книгой комплектации.</p>
    <div id="fleetTable"></div>
  `;
  renderTable(byId("fleetTable"), {
    rows: D.fleet.units, sortKey: "ktg", sortDir: 1,
    cols: [
      { key: "name", label: "Единица", cls: "wrap" },
      { key: "site", label: "Площадка" },
      { key: "model", label: "Модель" },
      { key: "book", label: "Книга", cls: "mono", fmt: v => v || '<span class="dim">—</span>' },
      { key: "ktg", label: "КТГ", numeric: true, fmt: v => v == null ? "—" : pct(v) },
      { key: "kio", label: "КИО", numeric: true, fmt: v => v == null ? "—" : pct(v) },
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
    cols: [
      { key: "code", label: "Код ЕКМТР", cls: "mono" },
      { key: "name", label: "Наименование", cls: "wrap" },
      { key: "isWkPart", label: "WK-номенклатура", fmt: v => v ? '<span class="badge good">да</span>' : "" },
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
      cols: [
        { key: "code", label: "Код ЕКМТР", cls: "mono" },
        { key: "name", label: "Наименование", cls: "wrap" },
        { key: "needValue", label: "Потребность", numeric: true, fmt: rub },
        { key: "availQty", label: "Доступно, ед.", numeric: true, fmt: v => num(v, 1) },
        {
          key: "status", label: "Статус", fmt: (v, r) => {
            const badge = v === "full" ? '<span class="badge good">полностью</span>' :
              v === "partial" ? '<span class="badge warn">частично</span>' :
                '<span class="badge bad">нет остатка</span>';
            return badge + (r.restricted ? ' <span class="badge restricted">огранич.</span>' : "");
          }
        },
      ],
    });
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
      cols: [
        { key: "code", label: "Код", cls: "mono" },
        { key: "name", label: "Наименование", cls: "wrap" },
        { key: "qty", label: "Остаток, ед.", numeric: true, fmt: v => num(v, 1) },
        { key: "value", label: "Стоимость", numeric: true, fmt: rub },
        { key: "restrictedValue", label: "Ограничено", numeric: true, fmt: v => v > 0 ? `<span class="badge restricted">${rub(v)}</span>` : "" },
        { key: "availValue", label: "Доступно", numeric: true, fmt: rub },
        { key: "purchase", label: "В закупке", numeric: true, fmt: v => v ? rub(v.planV) : "" },
      ],
    });
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
    cols: [
      { key: "art", label: "Артикул", cls: "mono" },
      { key: "model", label: "Модель" },
      { key: "nameRu", label: "Наименование", cls: "wrap" },
      { key: "priceCNY", label: "Цена, ¥", numeric: true, fmt: cny },
      { key: "tree", label: "Узел", cls: "wrap", fmt: v => v && v.length ? esc(v[0].mech) : "" },
    ],
  });
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
      <dt>Цена ДП</dt><dd>${cny(item.priceCNY)}</dd>
      <dt>Цена УСО</dt><dd>${cny(item.priceUsoCNY)} ${item.priceDiffCNY != null ? `<span class="badge warn">Δ ${cny(item.priceDiffCNY)}</span>` : ""}</dd>
      <dt>Код ЕКМТР</dt><dd class="mono">${item.ekmtr ? esc(item.ekmtr) + (item.ekmtrAmbiguous ? ' <span class="badge warn">неоднозначно</span>' : "") : '<span class="badge bad">не кодифицировано</span>'}</dd>
      ${item.artNew ? `<dt>Артикул обн.</dt><dd class="mono">${esc(item.artNew)}</dd>` : ""}
    </dl>

    ${stock ? `
      <h3 style="font-size:12.5px;margin:16px 0 6px">Остаток и закупка</h3>
      <dl class="dl">
        <dt>Остаток</dt><dd>${num(stock.qty, 1)} ед. · ${rub(stock.value)}</dd>
        <dt>Доступно</dt><dd>${rub(stock.availValue)}</dd>
        ${stock.restrictedValue > 0 ? `<dt>Ограничено</dt><dd><span class="badge restricted">${rub(stock.restrictedValue)}</span>${stock.fullyRestricted ? " — весь остаток" : ""}</dd>` : ""}
        ${stock.purchase ? `<dt>В закупке</dt><dd>${rub(stock.purchase.planV)} · ещё поставить ${num(stock.purchase.openQty, 1)} ед.</dd>` : ""}
      </dl>` : (item.ekmtr ? '<p class="hint">Остатка по этому коду нет.</p>' : "")}

    ${item.tree.length ? `
      <h3 style="font-size:12.5px;margin:16px 0 6px">В узлах</h3>
      <dl class="dl">
        ${item.tree.map(t => `<dt>${esc(t.book)}</dt><dd>${esc(t.mech)} · кол-во ${num(t.qty)}</dd>`).join("")}
      </dl>` : ""}

    ${group ? `
      <h3 style="font-size:12.5px;margin:16px 0 6px">Взаимозаменяемые номера</h3>
      <p class="mono" style="font-size:12px">${group.map(esc).join(", ")}</p>` : ""}

    ${drawings ? `
      <h3 style="font-size:12.5px;margin:16px 0 6px">Чертежи (реестр)</h3>
      <p style="font-size:12px">${drawings.map(d => `<span class="badge good">${esc(d.ext.toUpperCase())}</span> ${esc(d.path.split("/").pop())}`).join("<br>")}</p>
      <p class="hint">Файлы — в ветке <code>rawdata</code>, порталом пока не раздаются.</p>` :
        '<p class="hint">Чертежа в реестре нет — по этому номеру нужен экспорт из LinkOne или OCR каталога-скана.</p>'}
  `;
  byId("mCloseBtn").onclick = closeModal;
}

/* ===================== БАЗА ЗНАНИЙ ===================== */
let KB_FILTER = { cls: "", q: "" };
function renderKB(host) {
  const m = D.kb.meta;
  const classes = Object.entries(m.byClass).sort((a, b) => b[1] - a[1]);
  host.innerHTML = `
    <h1>База знаний</h1>
    <p class="sub">${num(m.docs)} документов из АТ-Майнинг (руководства, схемы, нормы ТО, чертежи CAD) — ${num(m.totalBytes / 1e9, 1)} ГБ. Каталоги в PDF (${m.skippedCatalogPdf}) сюда не входят — чертежи берутся из LinkOme, каталог остаётся только справочно там, где книги LinkOme нет (см. «Качество данных»).</p>
    ${callout("info", "Реестр — метаданные (путь, класс, модель); сами файлы лежат в ветке <code>rawdata</code> и пока не раздаются порталом — см. открытый вопрос о хостинге в плане.")}
    <div class="kbgrid" id="kbClasses"></div>
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
      cols: [
        { key: "name", label: "Файл", cls: "wrap" },
        { key: "class", label: "Класс" },
        { key: "model", label: "Модель", fmt: v => v || '<span class="dim">общая</span>' },
        { key: "sizeBytes", label: "Размер", numeric: true, fmt: v => num(v / 1e6, 1) + " МБ" },
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
