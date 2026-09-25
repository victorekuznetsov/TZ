/* «Аналитика» → разделы 01–05: те же слайды, что в презентации
   «Экскаваторы WK: исполнение 2024–2026 и план 2027» (build/build_wk_status_deck.py),
   с теми же цветами, — но по фильтрам отчёта (площадка, модель, машина, заказ).
   Расчёты — AnalyticsCore.deck (lib/analytics_core.js); без фильтров они
   совпадают с данными презентации (tests/test_deck.mjs). */
"use strict";

let AN_SECTION = (() => { try { return sessionStorage.getItem("wk-an-section") || "concl"; } catch (e) { return "concl"; } })();
const AN_SECTIONS = [
  ["concl", "Выводы"], ["s01", "01 Парк и КТГ"], ["s02", "02 Исполнение"], ["s03", "03 План"],
  ["s04", "04 Обеспеченность"], ["s05", "05 Запасы и закупки"],
];
// палитра презентации (deck: C_STOCK, C_BUY, …)
const DK = {
  stock: "#12A06E", buy: "#5566C9", late: "#E0A030", gap: "#D2454F", plan: "#C3C8CE", fact: "#12A06E", pot: "#F2B8BD",
  y: { "2024": "#B9C1EE", "2025": "#8793E0", "2026": "#5566C9", "2027": "#12A06E" },
  g: { "Закрыт": "#0E7A54", "Тех. закрыт": "#12A06E", "В работе": "#7FD8B4", "Деблокирован, пусто": "#E0A030",
       "Согласование": "#5566C9", "ППР без заказа": "#C3C8CE", "Нет статуса": "#E5E7EA" },
  tG: "#D5F5E6", tA: "#FCEFD2", tR: "#F8DADC", tB: "#E3E6F7",
};
const DK_LIGHT = new Set(["#7FD8B4", "#C3C8CE", "#E5E7EA", "#F2B8BD", "#B9C1EE"]);
const dkMln = v => (v == null ? "—" : num(v / 1e6, 0));
const dkShort = s => ({ "1100": "Красноярск", "1400": "Магадан", "2400": "Сухой Лог" })[s] || anSite(s);
const dkExecFill = v => (v == null ? null : v >= 0.95 ? DK.tG : v >= 0.75 ? DK.tA : DK.tR);
const dkKtgFill = (f, p) => (f == null || p == null ? null : f >= p - 0.005 ? DK.tG : f >= p - 0.05 ? DK.tA : DK.tR);
const dkCovFill = v => (v == null ? null : v >= 0.9 ? DK.tG : v >= 0.7 ? DK.tA : DK.tR);
const dkKtg = v => (v == null || v >= 0.99999 ? null : v);   // ровно 100 % за год — заглушка витрины
const dkUnc = p => (p ? p.late + p.undated + p.gap : 0);
const dkCov = p => (p && p.value ? (p.fromStock + p.fromBuy) / p.value : null);
const dkCovPot = p => (p && p.value ? (p.fromStock + p.fromBuy + (p.transferPotential || 0)) / p.value : null);
const dkUnitKey = u => { const m = /(WK-\S+)\s*№\s*(\d+)/.exec(u) || []; return [m[1] || u, +(m[2] || 0)]; };
const dkSortUnits = a => a.sort((x, y) => { const a1 = dkUnitKey(x.unit || x), b1 = dkUnitKey(y.unit || y); return a1[0] < b1[0] ? -1 : a1[0] > b1[0] ? 1 : a1[1] - b1[1]; });

// сегменты обеспеченности — перемещение* вырезано из непокрытого, как в презентации
const DK_SEG = [
  { k: "own", label: "Склад своей площадки", color: DK.stock }, { k: "buy", label: "Закупка к сроку", color: DK.buy },
  { k: "late", label: "Закупка опаздывает / без срока", color: DK.late, light: true },
  { k: "pot", label: "Не покрыто, есть на другой площадке*", color: DK.pot, light: true }, { k: "gap", label: "Не покрыто", color: DK.gap },
];
function dkSeg(p) {
  if (!p) return { own: 0, buy: 0, late: 0, pot: 0, gap: 0 };
  const pot = p.transferPotential || 0, pg = Math.min(pot, p.gap);
  return { own: p.fromStock, buy: p.fromBuy, late: p.late + p.undated - (pot - pg), pot, gap: p.gap - pg };
}
const DK_STAR = '<p class="hint">* Перемещение между площадками ограничено: в обеспеченность не входит, это возможность улучшения (запас другой площадки сверх её потребности).</p>';

/* таблица с цветными ячейками, как в презентации */
function dkTable(head, rows, { fills = null, aligns = null, bold = [], cls = "" } = {}) {
  const al = j => (aligns ? aligns[j] : j === 0 ? "l" : "r");
  return `<div class="twrap"><table class="dk-table ${cls}"><thead><tr>${head.map((h, j) => `<th class="${al(j) === "l" ? "" : al(j) === "c" ? "c" : "n"}">${esc(h)}</th>`).join("")}</tr></thead><tbody>
    ${rows.map((r, i) => `<tr>${r.map((v, j) => {
      const f = fills && fills(i, j);
      return `<td class="${al(j) === "l" ? "" : al(j) === "c" ? "c" : "n"}${bold.includes(j) ? " b" : ""}"${f ? ` style="background:${f};color:#1d2329"` : ""}>${v}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function dkTile(value, label, sub, dark = false, color = null) {
  return `<div class="dk-tile${dark ? " dark" : ""}"><div class="v"${color ? ` style="color:${color}"` : ""}>${value}</div><div class="l">${esc(label)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>`;
}
function dkSlide(title, sub, body, cls = "") {
  return `<section class="card dk-slide ${cls}"><h3>${esc(title)}</h3>${sub ? `<p class="hint">${sub}</p>` : ""}${body}</section>`;
}
function dkNote(html) { return `<div class="dk-note">${html}</div>`; }

/* линейный график в натуральную ширину */
function dkLine(cats, series, { yMin = 0, yMax = 1, fmt = v => pct(v), every = 3, H = 250 } = {}) {
  return anChart(W => {
    const padL = 42, padR = 10, padT = 10, padB = 24, iw = W - padL - padR, ih = H - padT - padB;
    const x = i => padL + (cats.length < 2 ? iw / 2 : iw * i / (cats.length - 1)), y = v => padT + ih - ih * (v - yMin) / (yMax - yMin);
    let svg = "";
    for (let g = 0; g <= 4; g++) {
      const v = yMin + (yMax - yMin) * g / 4, gy = y(v);
      svg += `<line x1="${padL}" x2="${W - padR}" y1="${gy}" y2="${gy}" stroke="var(--line)" stroke-width="0.8"/><text x="${padL - 6}" y="${gy + 3}" text-anchor="end" font-size="10" fill="var(--ink-3)">${esc(fmt(v))}</text>`;
    }
    cats.forEach((c, i) => { if (i % every === 0) svg += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--ink-3)">${esc(c)}</text>`; });
    series.forEach(s => {
      let d = "", pen = false;
      s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round"><title>${esc(s.label)}</title></path>`;
    });
    return `${anLegend(series)}<svg class="an-svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img">${svg}</svg>`;
  });
}

/* ---------- модель раздела ---------- */
let DK_CACHE = { key: null, deck: null };
function dkModel(m) {
  const key = JSON.stringify(m.ctx) + "|" + (S ? S.rows.length : 0);
  if (DK_CACHE.key === key && DK_CACHE.m === m) return DK_CACHE.deck;
  const deck = AnalyticsCore.deck({ control: D.control, controlRows: D.controlRows, provision: D.provision, stock: D.stock,
    fleet: D.fleet, usoWk: D.usoWk, scheduleRows: S ? S.rows : null }, m.ctx, m);
  DK_CACHE = { key, deck, m };
  return deck;
}
function dkUnits(dk) {
  // борта контекста: из «Парка» и из заказов (новые машины без карточки КТГ — площадка по заказу)
  const set = new Map(dk.units.map(u => [u.unit, u]));
  Object.keys(dk.unit).forEach(u => { if (!set.has(u)) { const full = "Экскаватор электрический " + u; set.set(u, { unit: u, site: siteOfUnit(full) || siteOfUnit(u), model: u.split(" ")[0], book: "" }); } });
  return dkSortUnits([...set.values()]);
}
const dkU = (dk, u, y) => (dk.unit[u] && dk.unit[u][y]) || { plan: 0, fact: 0, exec: null, noOrderPlan: 0, orders: 0 };

/* ===================== 01 Парк и КТГ ===================== */
function dkS01(dk) {
  const units = dkUnits(dk).filter(u => dk.ktg.unit[u.unit]);
  const sites = [...new Set(units.map(u => u.site))].sort();
  const cy = dk.cur;
  const cards = sites.map(st => {
    const us = units.filter(u => u.site === st);
    const models = {};
    us.forEach(u => { models[u.model] = (models[u.model] || 0) + 1; });
    return `<div class="dk-fleet"><header><div><b>${esc(anSite(st))}</b><span>${Object.entries(models).map(([m, n]) => `${esc(m)} × ${n}`).join(" · ")}</span></div><i>${us.length}</i></header>
      <div class="dk-fleet-h"><span>Борт · книга</span><span>КТГ ${cy}</span></div>
      ${us.map(u => { const kf = dkKtg(dk.ktg.unit[u.unit][cy].fact), kp = dkKtg(dk.ktg.unit[u.unit][cy].plan);
        return `<div class="dk-fleet-r"><span><b>${esc(u.unit)}</b> <small${u.book ? "" : ' style="color:' + DK.gap + '"'}>${esc(u.book || "нет книги")}</small></span>
          <em style="background:${dkKtgFill(kf, kp) || "var(--surface-2)"};color:#1d2329">${kf ? pct(kf) : "нет данных"}</em></div>`; }).join("")}</div>`;
  }).join("");
  const mi = dk.ktg.months.map((m, i) => i).filter(i => dk.ktg.months[i] >= "2024-01" && dk.ktg.months[i] <= cy + "-12");
  const MN = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const ktgRows = sites.map(st => [esc(anSite(st)), ...dk.factYears.map(y => { const k = dk.ktg.siteYear[st][y]; return `${pct(k.plan)} / ${pct(k.fact)}`; })]);
  const ktgFill = (i, j) => (j ? dkKtgFill(dk.ktg.siteYear[sites[i]][dk.factYears[j - 1]].fact, dk.ktg.siteYear[sites[i]][dk.factYears[j - 1]].plan) : null);
  const withF = units.filter(u => dkKtg(dk.ktg.unit[u.unit][cy].fact));
  const best = withF.slice().sort((a, b) => dk.ktg.unit[b.unit][cy].fact - dk.ktg.unit[a.unit][cy].fact)[0];
  const worst = withF.slice().sort((a, b) => dk.ktg.unit[a.unit][cy].fact - dk.ktg.unit[b.unit][cy].fact)[0];
  const unitRows = units.map(u => {
    const r = [esc(dkShort(u.site)), `<b>${esc(u.unit)}</b>`];
    dk.factYears.forEach(y => { const k = dk.ktg.unit[u.unit][y]; r.push(pct(dkKtg(k.plan)), pct(dkKtg(k.fact))); });
    const k = dk.ktg.unit[u.unit][cy], p = dkKtg(k.plan), f = dkKtg(k.fact);
    r.push(p == null || f == null ? "—" : `${f - p >= 0 ? "+" : "−"}${num(Math.abs(f - p) * 100, 0)}`);
    return r;
  });
  const unitFill = (i, j) => { if (j < 3 || j > 2 + dk.factYears.length * 2 || (j - 2) % 2) return null; const y = dk.factYears[(j - 3) / 2 | 0]; const k = dk.ktg.unit[units[i].unit][y]; return dkKtgFill(dkKtg(k.fact), dkKtg(k.plan)); };
  return dkSlide("Парк WK по площадкам", "Площадка машины — по вкладке «Парк». Книга — каталог комплектации LinkOne. КТГ — фактический коэффициент технической готовности " + cy + " (январь–август).",
      `<div class="dk-fleets">${cards || '<p class="hint">Нет бортов в контексте.</p>'}</div>${anLegend([{ label: "КТГ факт ≥ плана", color: DK.tG }, { label: "ниже плана до 5 п.п.", color: DK.tA }, { label: "ниже более чем на 5 п.п.", color: DK.tR }])}`)
    + dkSlide("КТГ парка: план и факт по месяцам", "Среднее по бортам с данными. Таблица — среднегодовые значения по площадкам; " + cy + " — январь–август.",
      `<div class="dk-grid dk-62"><div>${dkLine(mi.map(i => MN[+dk.ktg.months[i].slice(5) - 1] + " " + dk.ktg.months[i].slice(2, 4)),
        [{ label: "КТГ план", color: "#9AA3AB", values: mi.map(i => dk.ktg.fleetMonth.plan[i]) }, { label: "КТГ факт", color: DK.fact, values: mi.map(i => dk.ktg.fleetMonth.fact[i]) }],
        { yMin: 0.6, yMax: 1 })}</div>
      <div>${dkTable(["Площадка", ...dk.factYears], ktgRows, { fills: ktgFill, aligns: ["l", "c", "c", "c"] })}
        ${best ? dkNote(`<b>Разброс по бортам ${cy}</b><br>Лучший: <b>${esc(best.unit)} — ${pct(dk.ktg.unit[best.unit][cy].fact)}</b><br>Худший: <b>${esc(worst.unit)} — ${pct(dk.ktg.unit[worst.unit][cy].fact)}</b>`) : ""}</div></div>`)
    + dkSlide(`КТГ по каждому борту: план и факт ${dk.factYears[0]}–${cy}`, "Среднее по месяцам года. Цвет факта: зелёный — не ниже плана, янтарный — ниже до 5 п.п., красный — ниже более чем на 5 п.п.",
      dkTable(["Площадка", "Борт", ...dk.factYears.flatMap(y => [`${y} план`, `${y} факт`]), `Δ ${cy}, п.п.`], unitRows,
        { fills: unitFill, aligns: ["l", "l", ...dk.factYears.flatMap(() => ["c", "c"]), "c"], cls: "dk-compact" }));
}

/* ===================== 02 Исполнение ===================== */
function dkS02(dk, m) {
  const Y = dk.total, YS = AnalyticsCore.YEARS, cy = dk.cur, ny = dk.next, FY = dk.factYears;
  const sites = Object.keys(dk.site).sort();
  const colsYear = t => anColumns(["2024", "2025", `${cy} · на ${dmy(m.asOf).slice(0, 5)}`, `${ny} · план`],
    [{ label: "План", color: DK.plan, values: YS.map(y => t[y].plan) }, { label: "Факт", color: DK.fact, values: YS.map(y => (y === ny ? null : t[y].fact)) }], { H: 260 });
  const tiles = FY.map(y => dkTile(pct(Y[y].exec), `исполнение ${y}${y === cy ? " на " + dmy(m.asOf) : ""}`, `закрыто ${pct(Y[y].closedShare)} плана · ${num(Y[y].orders)} заказов`, y === cy, y === cy ? "var(--good)" : null)).join("")
    + dkTile(`${dkMln(Y[ny].plan)} млн ₽`, `план ${ny} в заказах SAP`, `${num(Y[ny].orders)} заказов · МТР ${dkMln(Y[ny].mtrPlan)} · УСО ${dkMln(Y[ny].usoPlan)}`);
  const siteCards = sites.map(st => {
    const ss = dk.site[st];
    return `<div class="dk-panel"><b>${esc(anSite(st))}</b>${colsYear(ss)}
      <div class="dk-mini">${FY.map(y => `<div style="background:${y === cy ? DK.tB : dkExecFill(ss[y].exec) || "var(--surface-2)"};color:#1d2329"><b>${pct(ss[y].exec)}</b><span>исполнение ${y}</span></div>`).join("")}</div>
      <p class="hint">Заказов ${cy}: ${num(ss[cy].orders)}</p></div>`;
  }).join("");
  const G = AnalyticsCore.GROUPS.filter(g => g !== "Нет статуса");
  const gdefs = G.map(g => ({ k: g, label: g, color: DK.g[g], light: DK_LIGHT.has(DK.g[g]) }));
  const mlnLabel = v => dkMln(v);
  const stagesAll = anHBars(YS.map(y => ({ label: y === ny ? y + " план" : y, values: Object.fromEntries(G.map(g => [g, Y[y].groups[g]])) })), gdefs,
    { percent: true, rowH: 40, labelW: 80, labelFmt: mlnLabel, minLabel: 40 });
  const G26 = G.filter(g => g !== "ППР без заказа");
  const stagesSite = anHBars(sites.map(st => ({ label: dkShort(st), values: Object.fromEntries(G26.map(g => [g, dk.site[st][cy].groups[g]])) })),
    gdefs.filter(d => d.k !== "ППР без заказа"), { percent: true, rowH: 40, labelW: 90, labelFmt: mlnLabel, minLabel: 34, legend: false });
  // виды работ, модели, статьи
  const W_ = dk.work, topW = Object.keys(W_).sort((a, b) => (FY.reduce((s, y) => s + W_[b][y][1], 0) + W_[b][ny][0]) - (FY.reduce((s, y) => s + W_[a][y][1], 0) + W_[a][ny][0])).slice(0, 8);
  const works = anHBars(topW.map(k => ({ label: k === "Не присвоено" ? "Не присвоено (компоненты)" : k,
    values: Object.fromEntries([...FY.map(y => [y, W_[k][y][1]]), [ny, W_[k][ny][0]]]) })),
    [...FY.map(y => ({ k: y, label: `Факт ${y}`, color: DK.y[y] })), { k: ny, label: `План ${ny}`, color: DK.y[ny] }], { grouped: true, rowH: 50, labelW: 200 });
  const models = Object.keys(dk.model).sort();
  const R = dk.reason, rtot = Object.keys(R).reduce((s, k) => s + FY.reduce((x, y) => x + R[k][y][1], 0), 0) || 1;
  const reasons = Object.keys(R).sort((a, b) => FY.reduce((s, y) => s + R[b][y][1], 0) - FY.reduce((s, y) => s + R[a][y][1], 0)).slice(0, 3);
  // затраты на борт, таблицы по бортам
  const units = dkUnits(dk);
  const fact3 = u => FY.reduce((s, y) => s + dkU(dk, u, y).fact, 0);
  const ordU = units.filter(u => fact3(u.unit) > 0).sort((a, b) => fact3(b.unit) - fact3(a.unit));
  const tot3 = ordU.reduce((s, u) => s + fact3(u.unit), 0) || 1, top5 = ordU.slice(0, 5).reduce((s, u) => s + fact3(u.unit), 0) / tot3;
  const unitTable = us => {
    const rows = [], fl = [];
    us.forEach(u => {
      const r = [esc(dkShort(u.site)), `<b>${esc(u.unit)}</b>`], f = [null, null];
      FY.forEach(y => { const x = dkU(dk, u.unit, y); r.push(x.plan ? dkMln(x.plan) : "—", x.fact ? dkMln(x.fact) : "—", x.plan ? pct(x.exec) : "—"); f.push(null, null, x.plan && y !== cy ? dkExecFill(x.exec) : null); });
      const x27 = dkU(dk, u.unit, ny), p = (dk.prov.unit[u.unit] || {})[ny], k = (dk.ktg.unit[u.unit] || {})[cy] || {};
      const cv = dkCov(p), kf = dkKtg(k.fact);
      r.push(x27.plan ? dkMln(x27.plan) : "—", x27.noOrderPlan ? dkMln(x27.noOrderPlan) : "—", pct(cv), pct(kf));
      f.push(null, null, dkCovFill(cv), dkKtgFill(kf, dkKtg(k.plan)));
      rows.push(r); fl.push(f);
    });
    return dkTable(["Площадка", "Борт", ...FY.flatMap(y => [`План ${y.slice(2)}`, `Факт ${y.slice(2)}`, "%"]), `План ${ny.slice(2)}`, `ППР ${ny.slice(2)}*`, `Обесп. ${ny.slice(2)}`, `КТГ ${cy.slice(2)}`],
      rows, { fills: (i, j) => fl[i][j], aligns: ["l", "l", ...FY.flatMap(() => ["r", "r", "c"]), "r", "r", "c", "c"], cls: "dk-compact" });
  };
  const tf = dk.topFact;
  const mats = tf ? (() => {
    const mx = (tf[0] && tf[0].fact) || 1;
    return dkTable(["№", "ЕКМТР", "Наименование", "Кол-во", "Факт, млн ₽", ""], tf.map((x, i) => [String(i + 1), codeLink(x.code), esc(x.name), num(x.qf), `<b>${num(x.fact / 1e6, 0)}</b>`,
      `<span class="dk-bar" style="width:${(100 * x.fact / mx).toFixed(1)}%;background:${i < 3 ? DK.fact : "#7FD8B4"}"></span>`]), { aligns: ["c", "l", "l", "r", "r", "l"] });
  })() : callout("info", "Загрузка графика план-факт…");
  const sitesU = [...new Set(units.map(u => u.site))].sort();
  return dkSlide("Программа ремонтов WK: план и факт по годам", `План и факт — МТР Полюса и МТР подрядчика (УСО) по заказам ТОРО. Позиции графика ППР без заказа SAP в план ${ny} не входят (${dkMln(Y[ny].noOrderPlan)} млн ₽, ${num(Y[ny].noOrderN)} позиций). У оригиналов БЕ с копией в «Развитии» не учтён неисполненный план: ${YS.map(y => num(Y[y].copyExcluded / 1e6, 1)).join(", ")} млн ₽ по годам.`,
      `<div class="dk-grid dk-62"><div>${colsYear(Y)}</div><div class="dk-tiles-col">${tiles}</div></div>`)
    + dkSlide("Исполнение по площадкам", `План и факт МТР + УСО, млн ₽. Шкалы у площадок разные — сравнивайте проценты. ${cy} — на ${dmy(m.asOf)}.`,
      `<div class="dk-grid dk-3">${siteCards}</div>`)
    + dkSlide("Где находятся заказы: стадии SAP по годам", "Стадия по системным и пользовательским статусам PM-06: закрыт (ЗАКР), тех. закрыт (ТЗКР, ПРСЗ, ВСБЕ), в работе (факт, подтверждения, ПРНТ, ФХСМ), деблокирован без факта и подтверждений, на согласовании (ПЛАН–СГГС). Статус — на дату годовой выгрузки. Доли — от плана в рублях, подписи — млн ₽.",
      `<div class="dk-grid dk-55"><div><b class="dk-sub">Доля плана по стадиям</b>${stagesAll}</div><div><b class="dk-sub">${cy} по площадкам</b>${stagesSite}
        ${dkNote(`<b>${dkMln(Y[cy].groups["Деблокирован, пусто"])} млн ₽</b> — ${num(Y[cy].groupN["Деблокирован, пусто"])} заказов ${cy} деблокированы, но без факта и подтверждений.<br><b>${dkMln(Y[cy].groups["Согласование"])} млн ₽</b> на согласовании: пересмотрите, что реально выполнится до конца года.`)}</div></div>`)
    + dkSlide("На что уходят деньги: виды работ и модели", "Вид работ — по наибольшей доле плана в заказе. «Не присвоено» — заказы на компоненты (крупные узлы) без вида работ. Факт по годам и план следующего года, млн ₽.",
      `<div class="dk-grid dk-62"><div>${works}</div><div><b class="dk-sub">Исполнение по моделям</b>
        ${dkTable(["Модель", ...FY, `План ${ny.slice(2)}`], models.map(md => [`<b>${esc(md)}</b>`, ...FY.map(y => pct(dk.model[md][y].exec)), dkMln(dk.model[md][ny].plan)]),
          { fills: (i, j) => (j >= 1 && j <= FY.length && FY[j - 1] !== cy ? dkExecFill(dk.model[models[i]][FY[j - 1]].exec) : null), aligns: ["l", ...FY.map(() => "c"), "r"] })}
        <b class="dk-sub">По статье затрат, факт ${FY[0]}–${cy}</b>
        ${reasons.map((k, j) => { const v = FY.reduce((s, y) => s + R[k][y][1], 0); return `<div class="dk-reason"><b>${esc(k || "—")}</b><div><span style="width:${(80 * v / rtot).toFixed(1)}%;background:${[DK.fact, DK.buy, DK.late][j]}"></span><em>${dkMln(v)} млн ₽ · ${pct(v / rtot)}</em></div></div>`; }).join("")}</div></div>`)
    + dkSlide(`Затраты на каждый борт: факт ${FY[0]}–${cy}`, `Факт МТР + УСО по заказам ТОРО, млн ₽. Борта отсортированы по сумме за ${FY.length} года. Пять крупнейших — ${pct(top5)} всего факта.`,
      anHBars(ordU.map(u => ({ label: `${u.unit} · ${dkShort(u.site)}`, values: Object.fromEntries(FY.map(y => [y, dkU(dk, u.unit, y).fact])) })),
        FY.map(y => ({ k: y, label: `Факт ${y}`, color: DK.y[y], light: y === "2024" })), { rowH: 22, labelW: 200 }))
    + sitesU.map(st => dkSlide(`Исполнение по бортам: ${anSite(st)}`, `Цвет % исполнения закрытых лет: зелёный ≥ 95%, янтарный 75–95%, красный < 75%. ${cy} — на ${dmy(m.asOf)} и не окрашен: год не завершён.`,
        unitTable(units.filter(u => u.site === st)) + `<p class="hint">млн ₽. * ППР — позиции графика ППР без заказа SAP, в план не входят. Обесп. — доля потребности МТР ${ny}, покрытая складом и закупкой к сроку. КТГ — факт январь–август.</p>`)).join("")
    + dkSlide(`Крупнейшие материалы: факт ${FY[0]}–${cy}`, "Факт МТР по коду ЕКМТР, млн ₽ (вкладка «График · план-факт»). Полоса — доля от крупнейшей позиции.", mats);
}

/* ===================== 03 План ===================== */
function dkS03(dk) {
  const ny = dk.next, Y = dk.total[ny], sites = Object.keys(dk.site).sort();
  const G27 = [["Деблокирован, пусто", "Деблокирован"], ["Согласование", "Открыт: согласование и СГГС"], ["ППР без заказа", "Позиции ППР без заказа"]];
  const units = dkUnits(dk).filter(u => dkU(dk, u.unit, ny).plan + dkU(dk, u.unit, ny).noOrderPlan > 0)
    .sort((a, b) => (dkU(dk, b.unit, ny).plan * 10 + dkU(dk, b.unit, ny).noOrderPlan) - (dkU(dk, a.unit, ny).plan * 10 + dkU(dk, a.unit, ny).noOrderPlan));
  const items = new Map((D.provision.items || []).map(i => [String(i.code), i]));
  const VERD = { covered: ["обеспечено", DK.tG], inTime: ["успеем заказать", DK.tA], late: ["не успеем", DK.tR], past: ["срок прошёл", DK.tR], nodate: ["нет срока", null] };
  const tp = dk.topPlan;
  const mats = tp ? dkTable(["№", "ЕКМТР", "Наименование", "Бортов", "Кол-во", "План, млн ₽", "Обеспечено", "Вывод"],
    tp.map((x, i) => { const it = items.get(String(x.code)); const cv = it && it.needQty ? (it.fromStock + it.fromBuy) / it.needQty : null;
      return [String(i + 1), codeLink(x.code), esc(x.name), num(x.units), num(x.qp27), `<b>${num(x.plan27 / 1e6, 0)}</b>`, pct(cv), it ? (VERD[it.verdict] || [it.verdict])[0] : "—"]; }),
    { fills: (i, j) => { const it = items.get(String(tp[i].code)); if (!it) return null; if (j === 6) return dkCovFill(it.needQty ? (it.fromStock + it.fromBuy) / it.needQty : null); if (j === 7) return (VERD[it.verdict] || [])[1] || null; return null; },
      aligns: ["c", "l", "l", "c", "r", "r", "c", "c"] }) : callout("info", "Загрузка графика план-факт…");
  return dkSlide(`План ${ny}: объём и готовность заказов`, `План ${ny} по стадиям SAP, млн ₽. Позиции графика ППР без заказа — не заказы: в план и потребность не включаются, показаны отдельно, чтобы был виден полный объём графика.`,
      `<div class="dk-grid dk-62"><div>${anHBars(sites.map(st => ({ label: anSite(st), values: Object.fromEntries(G27.map(([g]) => [g, dk.site[st][ny].groups[g]])) })),
        G27.map(([g, l]) => ({ k: g, label: l, color: DK.g[g], light: DK_LIGHT.has(DK.g[g]) })), { rowH: 44, labelW: 170 })}</div>
      <div class="dk-tiles-col">${dkTile(`${dkMln(Y.plan)} млн ₽`, `план ${ny} в заказах SAP`, `${num(Y.orders)} заказов · из них ${pct(Y.plan ? Y.groups["Согласование"] / Y.plan : null)} ещё открыты`)}
        ${dkTile(`${dkMln(Y.noOrderPlan)} млн ₽`, "позиции ППР без заказа", `${num(Y.noOrderN)} позиций · не входят в план`)}
        ${dkTile(`${dkMln(Y.usoPlan)} млн ₽`, "из плана — МТР подрядчика (УСО)", "")}
        ${dkNote(`<b>Деблокировано</b> ${dkMln(Y.groups["Деблокирован, пусто"])} млн ₽ — остальное закупка увидит только после ДЕБЛ, если у строк «Начиная с деблок.».`)}</div></div>`)
    + dkSlide(`План ${ny} по бортам`, "План в заказах SAP и позиции графика ППР без заказа, млн ₽. Сортировка по плану в заказах.",
      anHBars(units.map(u => ({ label: `${u.unit} · ${dkShort(u.site)}`, values: { plan: dkU(dk, u.unit, ny).plan, ppr: dkU(dk, u.unit, ny).noOrderPlan } })),
        [{ k: "plan", label: "План в заказах SAP", color: DK.y[ny] }, { k: "ppr", label: "Позиции ППР без заказа", color: DK.plan, light: true }], { rowH: 22, labelW: 200 }))
    + dkSlide(`Крупнейшие МТР плана ${ny} и их обеспеченность`, "План МТР по коду ЕКМТР (без позиций ППР), млн ₽; бортов — сколько машин несут потребность. Обеспечено — склад и закупка к сроку по расчёту вкладки «Обеспеченность».", mats);
}

/* ===================== 04 Обеспеченность ===================== */
function dkS04(dk, m) {
  const cy = dk.cur, ny = dk.next, P = dk.prov, sites = Object.keys(P.site).sort();
  const p26 = P.byYear[cy], p27 = P.byYear[ny], fz = P.feasible;
  const segRows = pairs => pairs.filter(([, p]) => p && p.value > 0).map(([label, p]) => ({ label, values: dkSeg(p) }));
  const units = Object.keys(P.unit).filter(u => P.unit[u][ny] && P.unit[u][ny].value > 0).sort((a, b) => dkUnc(P.unit[b][ny]) - dkUnc(P.unit[a][ny]));
  const unitSite = u => { const x = dkUnits(dk).find(v => v.unit === u); return x ? x.site : ""; };
  const ppm = [["Немедленно", "immediate"], ["Начиная с деблок.", "onRelease"], ["Никогда", "never"]].map(([l, k]) => [l, P.ppm[ny + "|" + k]]);
  const byPpm = {};
  (D.provision.orders || []).filter(o => AnalyticsCore.inContext(o, m.ctx)).forEach(o => {
    const y = String((o.years || [])[0] || (o.date || "").slice(0, 4));
    if (y !== ny) return;
    (o.lines || []).forEach(l => { const k = l.ppm || "immediate", t = (byPpm[k] = byPpm[k] || { value: 0, fromStock: 0, fromBuy: 0, late: 0, undated: 0, gap: 0, transferPotential: 0 });
      t.value += l.value || 0; t.fromStock += l.fromStockValue || 0; t.fromBuy += l.fromBuyValue || 0; t.late += l.lateValue || 0; t.undated += l.undatedValue || 0; t.gap += l.gapValue || 0; t.transferPotential += l.transferPotentialValue || 0; });
  });
  const VERD = { covered: ["обеспечено", DK.tG], inTime: ["успеем заказать", DK.tA], late: ["не успеем", DK.tR], past: ["срок прошёл", DK.tR], nodate: ["нет срока", null] };
  const unc27 = dkUnc(p27);
  return dkSlide("Обеспеченность потребности WK по годам", `Потребность открытых заказов по номенклатуре WK после правил SAP, остатки на ${dmy(m.asOf)}. Сначала склад своей площадки, затем закупка с датой поставки до потребности. «Опаздывает» — закупка придёт позже; «без срока» — без даты или просрочена.`,
      `<div class="dk-grid dk-62"><div>${anHBars(segRows([[`${cy} · ${dkMln(p26 && p26.value)} млн ₽`, p26], [`${ny} · ${dkMln(p27 && p27.value)} млн ₽`, p27]]), DK_SEG, { rowH: 56, labelW: 150 })}${DK_STAR}</div>
      <div class="dk-tiles-col">${p26 ? dkTile(pct(dkCov(p26)), `обеспечено к сроку ${cy}`, `не покрыто ${dkMln(dkUnc(p26))} млн ₽ · с перемещением* до ${pct(dkCovPot(p26))}`) : ""}
        ${p27 ? dkTile(pct(dkCov(p27)), `обеспечено к сроку ${ny}`, `не покрыто ${dkMln(unc27)} млн ₽ · с перемещением* до ${pct(dkCovPot(p27))}`, true, "var(--good)") : ""}
        ${dkNote(`<b>Что ещё можно успеть</b><br>Успеем, если заказать сейчас: <b>${dkMln(fz.inTime)} млн ₽</b><br>Опоздаем до 3 мес.: <b>${dkMln(fz.late3)} млн ₽</b><br>Опоздаем более чем на 3 мес.: <b>${dkMln(fz.lateMore)} млн ₽</b><br><small>Срок — медиана фактических поставок по коду.</small>`)}</div></div>`)
    + dkSlide("Обеспеченность по площадкам", "Потребность открытых заказов WK по площадке машины, млн ₽. Таблица — доля, покрытая складом и закупкой к сроку.",
      `<div class="dk-grid dk-62"><div>${anHBars(segRows(sites.flatMap(st => [cy, ny].map(y => [`${anSite(st)} · ${y}`, P.site[st][y]]))), DK_SEG, { rowH: 30, labelW: 210 })}${DK_STAR}</div>
      <div>${dkTable(["Площадка", cy, ny, "Перем.*", `Не покр. ${ny.slice(2)}`], sites.map(st => [esc(anSite(st)), pct(dkCov(P.site[st][cy])), pct(dkCov(P.site[st][ny])),
        dkMln([cy, ny].reduce((s, y) => s + ((P.site[st][y] || {}).transferPotential || 0), 0)), dkMln(dkUnc(P.site[st][ny]))]),
        { fills: (i, j) => (j === 1 || j === 2 ? dkCovFill(dkCov(P.site[sites[i]][[cy, ny][j - 1]])) : null), aligns: ["l", "c", "c", "r", "r"] })}</div></div>`)
    + dkSlide(`Обеспеченность ${ny} по бортам`, "Потребность МТР каждого борта, млн ₽. Сортировка по непокрытой части.",
      anHBars(segRows(units.map(u => [`${u} · ${dkShort(unitSite(u))}`, P.unit[u][ny]])), DK_SEG, { rowH: 22, labelW: 200, minLabel: 30 }) + DK_STAR)
    + dkSlide(`Видит ли закупка потребность ${ny}`, "Признак «Резерв./заявка» строк заказа: «Немедленно» — потребность сразу в ППМ; «Начиная с деблок.» — только после деблокирования заказа; «Никогда» — в заявку не попадает. млн ₽.",
      `<div class="dk-grid dk-62"><div>${anHBars(segRows(ppm.map(([l, x], i) => [`${l} · ${dkMln(x && x.value)}`, byPpm[["immediate", "onRelease", "never"][i]]])), DK_SEG, { rowH: 50, labelW: 190 })}${DK_STAR}</div>
      <div class="dk-tiles-col">${dkTile(`${dkMln((byPpm.onRelease || {}).value || 0)} млн ₽`, "закупка не видит до деблокирования", `из них не покрыто ${dkMln(dkUnc(byPpm.onRelease))} млн ₽`, true, "var(--good)")}
        ${dkTile(`${dkMln((byPpm.never || {}).value || 0)} млн ₽`, "строки «Никогда»", "в заявку не попадут совсем")}
        ${dkNote("<b>Что сделать</b><br>Деблокировать заказы с длинными позициями раньше — с запасом на срок поставки; либо перевести строки на «Немедленно». Строки «Никогда» — проверить.")}</div></div>`)
    + dkSlide("Критичные позиции дефицита", "Крупнейшие по непокрытой стоимости позиции. «Заказать до» — дата первой непокрытой потребности минус медианный фактический срок поставки кода.",
      dkTable(["ЕКМТР", "Наименование", "Потребн.", "Не покрыто, млн ₽", "Срок, дн.", "Нужно с", "Заказать до", "Вывод"],
        P.deficit.map(x => [codeLink(x.code), esc(x.name || ""), num(x.needQty), `<b>${num((x.gapValue || 0) / 1e6, 1)}</b>`, x.leadDays || "—", x.firstNeed ? dmy(x.firstNeed) : "—", x.orderBy ? dmy(x.orderBy) : "—", (VERD[x.verdict] || [x.verdict || "—"])[0]]),
        { fills: (i, j) => (j === 7 ? (VERD[P.deficit[i].verdict] || [])[1] || null : null), aligns: ["l", "l", "r", "r", "r", "c", "c", "c"] }))
    + dkSlide("Заказать сегодня", "Позиции дефицита, которые ещё закрываются заказом: срок поставки укладывается до потребности. Это пакет «Заказать сегодня» со вкладки «Сводка».",
      `<div class="dk-grid dk-28"><div class="dk-tiles-col">${dkTile(num(P.orderTodayN), "позиций ещё успеваем", "если заказать сейчас", true, "var(--good)")}
        ${dkTile(dkMln(P.orderTodaySum), "млн ₽ — стоимость пакета", "")}${dkTile(dkMln(fz.lateMore + fz.late3), "млн ₽ — уже не успеть", "аналоги, перенос сроков или ремонт узла", false, DK.gap)}</div>
      <div>${dkTable(["ЕКМТР", "Наименование", "Не покрыто, млн ₽", "Ещё успеем, млн ₽", "Срок, дн."], P.orderToday.map(x => [codeLink(x.code), esc(x.name || ""), num((x.gapValue || 0) / 1e6, 1), `<b>${num(x.canOrder / 1e6, 1)}</b>`, x.leadDays || "—"]), { aligns: ["l", "l", "r", "r", "r"] })}</div></div>`);
}

/* ===================== 05 Запасы, закупки, УСО ===================== */
function dkS05(dk, m) {
  const cy = dk.cur, ny = dk.next, P = dk.prov, St = dk.stock, sites = ["1100", "1400", "2400"].filter(s => St.sites[s] && (!m.ctx.site || s === m.ctx.site));
  const tot = Object.values(St.sites).reduce((s, x) => s + (x.value || 0), 0) || 1;
  const pu = dk.purchase, mths = [];
  for (let y = +cy - 1, mo = 9; y < +ny || (y === +ny && mo <= 8);) { mths.push(`${y}-${String(mo).padStart(2, "0")}`); if (++mo > 12) { mo = 1; y++; } }
  const MN = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"], asOfM = m.asOf.slice(0, 7);
  const moveSites = ["1100", "1400", "2400"];
  const mv = (f, t) => P.moves[f + ">" + t] || 0, totMv = Object.values(P.moves).reduce((s, v) => s + v, 0);
  const usoSites = Object.keys(dk.uso).sort(), YS = AnalyticsCore.YEARS, FY = dk.factYears;
  const RT = { "1100": "Красн.", "1400": "Маг.", "2400": "СЛ" };
  return dkSlide("Запасы WK по площадкам", `Остатки номенклатуры WK на ${dmy(m.asOf)}. Площадка склада — по заводу строки выгрузки: 11xx/7101/7106 — Красноярск, 14xx/7104 — Магадан, 12xx/24xx/7102/7108 — Сухой Лог. Ограниченный запас вычтен на своём складе.`,
      `<div class="dk-tiles">${sites.map(s => dkTile(num(St.sites[s].value / 1e9, 2), `млрд ₽ — ${anSite(s)}`, `${num(St.sites[s].codes)} кодов · ${pct(St.sites[s].value / tot)} запаса`)).join("")}
        ${dkTile(num(tot / 1e9, 2), "млрд ₽ — весь запас WK", `ограничено ${num(St.restricted / 1e6, 1)} млн ₽`, true, "var(--good)")}</div>
      <div class="dk-grid dk-55"><div><b class="dk-sub">Крупнейшие склады, млн ₽</b>${anHBars(St.byWarehouse.slice(0, 8).map(w => ({ label: `${dkShort(w.site)} · ${w.name} · ${w.plant}${w.kind === "consign" ? " (конс.)" : w.kind === "transit" ? " (ПБ)" : ""}`, values: { v: w.value } })), [{ k: "v", label: "Запас", color: DK.buy }], { rowH: 26, labelW: 260, legend: false })}</div>
      <div><b class="dk-sub">Запас и потребность ${cy}–${ny}, млн ₽</b>${dkTable(["Площадка", "Запас", "Нужно", "Свой склад", "Перем.*", "Не покр."], sites.map(s => {
        const a = (P.site[s] || {})[cy] || {}, b = (P.site[s] || {})[ny] || {};
        return [esc(dkShort(s)), dkMln(St.sites[s].value), dkMln((a.value || 0) + (b.value || 0)), dkMln((a.fromStock || 0) + (b.fromStock || 0)), dkMln((a.transferPotential || 0) + (b.transferPotential || 0)), dkMln(dkUnc(a.value ? a : null) + dkUnc(b.value ? b : null))];
      }), { aligns: ["l", "r", "r", "r", "r", "r"] })}${DK_STAR}</div></div>`)
    + dkSlide("Возможность перемещения между площадками", `Перемещение ограничено (логистика, согласование БЕ) и в обеспеченность не входит. Верхняя оценка: сколько непокрытой к сроку потребности ${cy}–${ny} мог бы закрыть запас другой площадки сверх её потребности, млн ₽.`,
      `<div class="dk-grid dk-46"><div>${dkTable(["", ...moveSites.map(t => "в " + dkShort(t)), "всего из"], [...moveSites.map(f => [`<b>из ${esc(dkShort(f))}</b>`, ...moveSites.map(t => (f === t ? "—" : num(mv(f, t) / 1e6, 1))), num(moveSites.reduce((s, t) => s + mv(f, t), 0) / 1e6, 1)]),
          ["всего в", ...moveSites.map(t => num(moveSites.reduce((s, f) => s + mv(f, t), 0) / 1e6, 1)), `<b>${num(totMv / 1e6, 1)}</b>`]],
          { fills: (i, j) => (i < 3 && j >= 1 && j <= 3 ? (moveSites[i] === moveSites[j - 1] ? "var(--surface-2)" : mv(moveSites[i], moveSites[j - 1]) >= 30e6 ? DK.tA : null) : null) })}
        ${dkTile(`до ${dkMln(totMv)} млн ₽`, "можно улучшить перемещением*", `в обеспеченность не входит · ${ny}: ${pct(dkCov(P.byYear[ny]))} → до ${pct(dkCovPot(P.byYear[ny]))}`, true, "var(--good)")}</div>
      <div><b class="dk-sub">Крупнейшие позиции, которые есть на другой площадке</b>${dkTable(["ЕКМТР", "Наименование", "Маршрут, шт", "млн ₽"], P.moveTop.map(x => [codeLink(x.code), esc(x.name || ""),
        Object.entries(x.routes).sort((a, b) => b[1] - a[1]).map(([r, q]) => `${RT[r.split(">")[0]] || r.split(">")[0]} → ${RT[r.split(">")[1]] || r.split(">")[1]}: ${num(q)}`).join(", "), `<b>${num(x.value / 1e6, 1)}</b>`]), { aligns: ["l", "l", "l", "r"] })}</div></div>`)
    + dkSlide("Закупки: график поставок и сроки", `Открытые заявки и заказы на поставку по номенклатуре WK (закупка общая, к площадке не привязана). Количества разных МТР суммированы справочно. Просрочка — плановый месяц поставки раньше ${MN[+asOfM.slice(5) - 1]} ${asOfM.slice(0, 4)}.`,
      `<div class="dk-tiles">${dkTile(num(pu.items), "кодов в закупке", `${num(pu.needCodes)} с потребностью`)}${dkTile(num(pu.openQty), "ед. ещё поставить", `в пути ${num(pu.transitQty)} ед.`)}
        ${dkTile(num(pu.overdue), "ед. просрочено", "месяц поставки прошёл", false, DK.gap)}${dkTile(`${pu.leadMedian || "—"} дн.`, "медианный срок поставки", `по ${num(pu.leadN)} кодам`, true, "var(--good)")}</div>
      <div class="dk-grid dk-62"><div><b class="dk-sub">Открытое количество по месяцу поставки, ед.</b>${anColumns(mths.map(x => `${MN[+x.slice(5) - 1]} ${x.slice(2, 4)}`), [{ label: "Поставка", color: DK.buy, values: mths.map(x => pu.byMonth[x] || 0) }],
        { fmt: v => num(v), pointColor: i => (mths[i] < asOfM ? DK.gap : null), H: 230 })}</div>
      <div><b class="dk-sub">Фактический срок поставки, кодов</b>${anColumns(["до 90 дн.", "90–180", "180–270", "270–360", "360–450", "450+"], [{ label: "Кодов", color: DK.plan, values: [0, 1, 2, 3, 4, 5].map(i => pu.leadHist[i] || 0) }],
        { fmt: v => num(v), pointColor: i => (i === 2 || i === 3 ? DK.buy : null), H: 230 })}</div></div>`)
    + dkSlide("МТР подрядчика (УСО)", `План и факт МТР подрядчика по заказам ТОРО WK, млн ₽. ${cy} — на ${dmy(m.asOf)}.`,
      `<div class="dk-grid dk-55"><div>${anColumns([...FY, `${ny} план`], [{ label: "План", color: DK.plan, values: YS.map(y => dk.total[y].usoPlan) }, { label: "Факт", color: DK.fact, values: YS.map(y => (y === ny ? null : dk.total[y].usoFact)) }], { H: 250 })}</div>
      <div>${dkTable(["Площадка", ...FY, ny], Object.keys(dk.site).sort().map(s => [esc(anSite(s)), ...FY.map(y => `${dkMln(dk.site[s][y].usoPlan)} / ${dkMln(dk.site[s][y].usoFact)}`), dkMln(dk.site[s][ny].usoPlan)]), { aligns: ["l", "c", "c", "c", "r"] })}
        <p class="hint">план / факт, млн ₽</p>
        ${dkNote(`<b>План МТР подрядчика заполнен не полностью.</b> Факт УСО прошлых лет выше плана строк МТР подрядчика — процент исполнения по УСО не показателен: смотрите факт и открытый остаток. Реестр заказов УСО: ${usoSites.length ? usoSites.map(s => `${dkShort(s)} ${num(Object.values(dk.uso[s]).reduce((a, t) => a + t.orders, 0))}`).join(", ") : "—"} заказов.`)}</div></div>`);
}

/* навигация по разделам и отрисовка раздела */
function dkNav() {
  return `<div class="toolbar dk-nav">${AN_SECTIONS.map(([k, l]) => `<button class="pill ${AN_SECTION === k ? "on" : ""}" data-an-section="${k}">${esc(l)}</button>`).join("")}
    <button class="pill" data-an-goto="control">Контроль отделов →</button></div>`;
}
function dkRender(host, m) {
  const needSchedule = (AN_SECTION === "s02" || AN_SECTION === "s03") && !S;
  const dk = dkModel(m);
  const html = { s01: dkS01, s02: dkS02, s03: dkS03, s04: dkS04, s05: dkS05 }[AN_SECTION](dk, m);
  if (needSchedule) ensureSchedule().then(() => { if (TAB === "analytics") renderTab(); }).catch(() => {});
  return html;
}
function dkWire(host) {
  qsa("[data-an-section]", host).forEach(b => { b.onclick = () => { AN_SECTION = b.dataset.anSection; try { sessionStorage.setItem("wk-an-section", AN_SECTION); } catch (e) {} renderTab(); window.scrollTo(0, 0); }; });
  qsa("[data-an-goto]", host).forEach(b => { b.onclick = () => navigateTo(b.dataset.anGoto); });
  if (typeof wireCodeLinks === "function") wireCodeLinks(host);
}
