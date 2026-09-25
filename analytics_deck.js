/* «Аналитика» → разделы 01–05: те же слайды, что в презентации
   «Экскаваторы WK: исполнение 2024–2026 и план 2027» (build/build_wk_status_deck.py),
   с теми же цветами, — но по фильтрам отчёта (площадка, модель, машина, заказ).
   Расчёты — AnalyticsCore.deck (lib/analytics_core.js); без фильтров они
   совпадают с данными презентации (tests/test_deck.mjs). */
"use strict";

let AN_SECTION = (() => { try { return sessionStorage.getItem("wk-an-section") || "concl"; } catch (e) { return "concl"; } })();
const AN_SECTIONS = [
  ["concl", "Выводы"], ["s01", "01 Парк и КТГ"], ["s02", "02 Исполнение"], ["s03", "03 План"],
  ["s04", "04 Обеспеченность"], ["s05", "05 Запасы и закупки"], ["s06", "06 Контроль и что сделать"],
  ["s07", "07 Справочники и данные"], ["s08", "08 Эффективность"],
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
  const needSchedule = (AN_SECTION === "s02" || AN_SECTION === "s03" || AN_SECTION === "s08") && !S;
  const needData = { s06: ["orderText"], s07: ["interchange"] }[AN_SECTION] || [];
  const dk = dkModel(m);
  const html = { s01: dkS01, s02: dkS02, s03: dkS03, s04: dkS04, s05: dkS05, s06: dkS06, s07: dkS07, s08: dkS08 }[AN_SECTION](dk, m);
  const rerender = () => { if (TAB === "analytics") { const y = window.scrollY; renderTab(); window.scrollTo(0, y); } };
  if (needSchedule) ensureSchedule().then(rerender).catch(() => {});
  if (needData.some(k => D[k] === undefined)) ensureData(needData).then(rerender).catch(() => {});
  return html;
}
function dkWire(host) {
  qsa("[data-an-section]", host).forEach(b => { b.onclick = () => { AN_SECTION = b.dataset.anSection; try { sessionStorage.setItem("wk-an-section", AN_SECTION); } catch (e) {} renderTab(); window.scrollTo(0, 0); }; });
  qsa("[data-an-goto]", host).forEach(b => { b.onclick = () => navigateTo(b.dataset.anGoto); });
  if (typeof wireCodeLinks === "function") wireCodeLinks(host);
}

/* ===================== 06 Контроль отделов и выводы ===================== */
const DK_LV = { bad: "Критично", warn: "Внимание", info: "К сведению", ok: "Норма", na: "нет данных" };
const DK_LV_FILL = { bad: DK.tR, warn: DK.tA, info: DK.tB, ok: DK.tG, na: null };
let DK_MATRIX = { key: null, cols: null, ctl: null };
function dkRuleMatrix(m) {
  const key = JSON.stringify(m.ctx);
  if (DK_MATRIX.key === key && DK_MATRIX.ctl === D.control && DK_MATRIX.prov === D.provision) return DK_MATRIX.cols;
  const src = { control: D.control, controlRows: D.controlRows, provision: D.provision, stock: D.stock, fleet: D.fleet };
  const all = m.ctx.site ? AnalyticsCore.buildModel(src, { ...m.ctx, site: "" }) : m;
  const cols = [["all", "Весь парк", all], ...["1100", "1400", "2400"].map(s => [s, dkShort(s), s === m.ctx.site ? m : AnalyticsCore.buildModel(src, { ...m.ctx, site: s })])]
    .map(([k, l, mm]) => [k, l, anRuleLevels(mm), mm.checks]);
  DK_MATRIX = { key, cols, ctl: D.control, prov: D.provision };
  return cols;
}
function dkS06(dk, m) {
  const cur = dk.cur, next = dk.next, P = m.plan, E = m.execCtl, B = m.budget, Y = m.exec.years;
  const cols = dkRuleMatrix(m), lv = (c, id) => c[2][id] || "na";
  const ann = Object.fromEntries(P.annual.map(a => [a.code, a.share]));
  const acc = P.accuracy[String(+cur - 1)] || {};
  const texts = (D.orderText && D.orderText.text) || {};
  const rel = E.releasedEmpty.all.slice(0, 10), relSum = rel.reduce((s, r) => s + r.planCounted, 0);
  const fun = E.funnel.filter(f => f.n);
  const funGroup = k => (k === "released" ? "w" : k === "inWork" || k === "factDone" ? "r" : ["closed", "billed", "accepted", "techClosed"].includes(k) ? "c" : "a");
  const sc = E.sCurve, mon = m.asOf.slice(0, 7), scMax = Math.max(1, ...sc.map(x => x.planCum)) * 1.05;
  const bcodes = ["ТКБЕ", "УТВП", "СГЛБ", "ПЗТГ", "КОРБ", "ТРКБ"], stc = Object.fromEntries(B.statusCur.map(x => [x.code, x])), stn = Object.fromEntries(B.statusNext.map(x => [x.code, x]));
  const trkb = [...B.statusCur, ...B.statusNext].filter(x => x.code === "ТРКБ").reduce((s, x) => s + x.n, 0);
  const onR = m.prov.ppm[next + "|onRelease"] || { value: 0 }, fz = dk.prov.feasible || {};
  const acts = [
    [`Закрыть хвосты ${cur}`, `${num(Y[cur].groupN["Деблокирован, пусто"])} деблокированных заказов на ${dkMln(Y[cur].groups["Деблокирован, пусто"])} млн ₽ без факта: провести факт, перенести или закрыть до конца года.`, DK.late],
    [`Ревизия согласования ${cur}`, `${dkMln(P.curYear.groups["Согласование"])} млн ₽ заказов групп 100/200 ещё на согласовании на ${dmy(m.asOf)} — решить, что переходит в ${next}.`, DK.buy],
    [`Деблокировать ${next} раньше`, `${dkMln(onR.value)} млн ₽ потребности закупка не видит до деблокирования при сроке поставки ${dk.prov.leadMedianDays || "—"} дней.`, DK.gap],
    ["Заказать сегодня", `${num(dk.prov.orderTodayN)} позиций на ${dkMln(dk.prov.orderTodaySum)} млн ₽ ещё успеваем; по ${dkMln((fz.lateMore || 0) + (fz.late3 || 0))} млн ₽ — аналоги или перенос.`, DK.stock],
    ["Просроченные поставки", `${num(dk.purchase.overdue)} ед. с прошедшим месяцем поставки — эскалация поставщикам (раздел 08 → «Поставщики»).`, DK.gap],
    ["Возможность перемещения", `До ${dkMln(m.prov.total.transferPotential)} млн ₽ дефицита есть на других площадках. Перемещение ограничено — проверить, что реально согласовать и перевезти.`, "#8A9199"],
  ];
  return dkSlide("Один набор правил — разные ответы по площадкам", `Результат каждого из ${AnalyticsCore.RULES.length} правил автовыводов для всего парка и каждой площадки${m.ctx.model || m.ctx.unit || m.ctx.order ? " (с учётом фильтров модели, машины и заказа)" : ""}. Нажмите правило в разделе «Выводы», чтобы увидеть цифры-доказательства.`,
      dkTable(["Группа", "Правило", ...cols.map(c => c[1])], AnalyticsCore.RULES.map(r => [esc(r.group), esc(r.title), ...cols.map(c => `<b>${DK_LV[lv(c, r.id)]}</b>`)]),
        { fills: (i, j) => (j >= 2 ? DK_LV_FILL[lv(cols[j - 2], AnalyticsCore.RULES[i].id)] : null), aligns: ["l", "l", ...cols.map(() => "c")], cls: "dk-compact" })
      + `<p class="hint">Сверки расчётов: ${cols.map(c => `${esc(c[1])} ${c[3].filter(x => x.ok).length}/${c[3].length}`).join(" · ")}</p>`)
    + dkSlide(`Контроль планирования: план ${next} и оперативный план`, `Только заказы групп планирования 100 Механика и 200 Энергетика — их планирует «Развитие» (${num((m.planScope.devShareNext || 0) * 100, 1)}% плана ${next}); группы 300–900 — службы БЕ. Цепочка согласования ПЛАН → СГПЛ → ССПЛ → СГГС → деблокирование; статусы годового и оперативного плана — доля плана в рублях с проставленным статусом.`,
      `<div class="dk-tiles">${dkTile(pct(P.approvedShare), `плана ${next} согласовано`, `${dkMln(P.approvedPlan)} из ${dkMln(P.nextPlan)} млн ₽`, true, "var(--good)")}
        ${dkTile(pct(ann["УТВГ"] || 0), "утверждено в годовом (УТВГ)", "плановые заказы APP1")}${dkTile(num(P.chain[0].n), "позиций ППР без заказа", `${dkMln(P.chain[0].plan)} млн ₽ вне плана`)}
        ${dkTile(num(P.notReleasedStarted.n), "начало прошло, не деблок.", `${dkMln(P.notReleasedStarted.plan)} млн ₽ ${cur}`, false, P.notReleasedStarted.n ? DK.late : null)}
        ${dkTile(pct(acc.n ? acc.ok / acc.n : null), `точность плана ${+cur - 1}`, "факт в ±20% плана заказа")}${dkTile(pct((P.unplanned[String(+cur - 1)] || {}).share), `внеплановые ${+cur - 1}`, "доля факта AVS1")}</div>
      <div class="dk-grid dk-55"><div><b class="dk-sub">Цепочка согласования ${next}, млн ₽</b>${anHBars(P.chain.map((c, i) => ({ label: `${c.key} · ${num(c.n)}`, values: { v: c.plan } })), [{ k: "v", label: "План", color: DK.buy }], { rowH: 30, labelW: 150, legend: false })}</div>
      <div><b class="dk-sub">Статусы плана: доля плана со статусом</b>${anHBars([...P.annual.map(a => ({ label: `${a.code} (год)`, values: { y: a.share || 0, n: 1 - (a.share || 0) } })), ...P.operative.map(a => ({ label: `${a.code} (≤31 дн.)`, values: { y: a.share || 0, n: 1 - (a.share || 0) } }))],
        [{ k: "y", label: "Есть статус", color: DK.stock }, { k: "n", label: "Нет статуса", color: "#E5E7EA", light: true }], { percent: true, rowH: 24, labelW: 120 })}</div></div>
      <p class="hint">ГОД — включён в годовой план, ПТОГ — согласован ПТО, ГИП — главным инженером, УТВГ — утверждён, УТВП — в программе и бюджете. МЕС/УТВМ, НЕД/УТВН — месячный и недельный план для заказов с началом в ближайшие 31 день.</p>`)
    + dkSlide(`Контроль исполнения ${cur}: воронка и освоение`, `Стадия — по статусам SAP на дату выгрузки. Освоение наступивших работ — факт к плану заказов с базисным началом не позже ${dmy(m.asOf).slice(3)}.`,
      `<div class="dk-tiles">${dkTile(pct(Y[cur].exec), `исполнение ${cur}`, `при ${pct(m.elapsed)} прошедшего года`, true, DK.gap)}${dkTile(pct(E.execDue), "освоение наступивших", `${dkMln(E.factDueToDate)} из ${dkMln(E.dueToDate)} млн ₽`)}
        ${dkTile(num(E.releasedEmpty.n), "деблокированы пусто", `${dkMln(E.releasedEmpty.plan)} млн ₽`, false, E.releasedEmpty.n ? DK.late : null)}${dkTile(num(E.closeOverdue.n), "просрочено закрытие", `${dkMln(E.closeOverdue.plan)} млн ₽, > ${AnalyticsCore.T.closeLagDays} дн.`)}
        ${dkTile(num(E.readyToClose.n), "ФХСМ, ждут ТЗКР", "затрат больше не ждём")}${dkTile(num(E.tails["2024"].n + E.tails["2025"].n), "хвосты 2024–2025", `${dkMln(E.tails["2024"].plan + E.tails["2025"].plan)} млн ₽ не закрыто`)}</div>
      <div class="dk-grid dk-55"><div><b class="dk-sub">Воронка ${cur}: план по стадиям, млн ₽</b>${anHBars(fun.map(f => ({ label: `${f.label} · ${num(f.n)}`, values: { [funGroup(f.key)]: f.plan } })),
        [{ k: "a", label: "Согласование", color: DK.buy }, { k: "w", label: "Деблок. без факта", color: DK.late }, { k: "r", label: "В работе", color: "#7FD8B4", light: true }, { k: "c", label: "Закрыто", color: DK.stock }], { rowH: 26, labelW: 230 })}</div>
      <div><b class="dk-sub">План и факт ${cur} нарастающим, млн ₽</b>${dkLine(sc.map(x => x.month.slice(5)), [{ label: "План нарастающим", color: DK.plan, values: sc.map(x => x.planCum) }, { label: "Факт нарастающим", color: DK.fact, values: sc.map(x => (x.month <= mon ? x.factCum : null)) }], { yMax: scMax, fmt: v => dkMln(v), every: 1, H: 260 })}</div></div>`)
    + dkSlide(`Деблокированы без факта: крупнейшие заказы ${cur}`, `${num(E.releasedEmpty.n)} заказов на ${dkMln(E.releasedEmpty.plan)} млн ₽ переданы в работу, но нет ни факта, ни подтверждений. Текст заказа — из выгрузки PM-06.`,
      (rel.length ? dkTable(["Заказ", "Текст заказа", "Борт", "Площадка", "Начало", "Конец", "План, млн ₽"], rel.map(r => [entityLink("toro", r.order, r), esc(texts[r.order] || (D.orderText ? "—" : "загрузка…")), esc(anShort(r.unit)), esc(dkShort(r.site)), dmy(r.start), dmy(r.end), `<b>${num(r.planCounted / 1e6, 1)}</b>`]), { aligns: ["l", "l", "l", "l", "c", "c", "r"] })
        + dkNote(`<b>Что сделать:</b> ${rel.length} крупнейших — ${dkMln(relSum)} млн ₽, ${pct(E.releasedEmpty.plan ? relSum / E.releasedEmpty.plan : null)} суммы. Провести факт, перенести сроки или закрыть; полный список — «Контроль отделов» → «Исполнение», фильтр «Факт по заказу: нет факта».`) : '<p class="hint">Таких заказов в контексте нет.</p>'))
    + dkSlide("Контроль бюджетирования: план, факт, статусы", `Перерасход — факт больше плана × ${num(AnalyticsCore.T.overrunRatio, 1)} и больше ${num(AnalyticsCore.T.overrunMin / 1000)} тыс. ₽; риск неосвоения — базисное начало наступило, факта нет.`,
      `<div class="dk-tiles">${["2024", "2025"].map(y => dkTile(pct(Y[y].exec), `факт / план ${y}`, "")).join("")}${dkTile(dkMln(B.riskUnspent), "млн ₽ риск неосвоения", `${pct(B.riskShare)} плана ${cur}, ${num(B.riskN)} заказ.`, true, DK.late)}
        ${dkTile(dkMln(B.overrun[cur].value), `млн ₽ перерасход ${cur}`, `${num(B.overrun[cur].n)} заказов`)}${dkTile(num(trkb), "ТРКБ: нужна корректировка", `заказы ${cur}–${next}`)}${dkTile(pct(Y[cur].usoPlan ? Y[cur].usoFact / Y[cur].usoPlan : null), `УСО факт / план ${cur}`, "МТР подрядчика")}</div>
      <div class="dk-grid dk-55"><div><b class="dk-sub">План и факт МТР и УСО по годам, млн ₽</b>${anColumns(AnalyticsCore.YEARS, [{ label: "План МТР", color: DK.plan, values: AnalyticsCore.YEARS.map(y => Y[y].mtrPlan) },
          { label: "Факт МТР", color: DK.fact, values: AnalyticsCore.YEARS.map(y => (y === next ? null : Y[y].mtrFact)) }, { label: "План УСО", color: "#B9C1EE", values: AnalyticsCore.YEARS.map(y => Y[y].usoPlan) },
          { label: "Факт УСО", color: DK.buy, values: AnalyticsCore.YEARS.map(y => (y === next ? null : Y[y].usoFact)) }], { H: 260 })}</div>
      <div><b class="dk-sub">Бюджетные статусы плановых заказов: доля плана</b>${anHBars(bcodes.map(c => ({ label: c, values: { a: (stc[c] || {}).share || 0, b: (stn[c] || {}).share || 0 } })), [{ k: "a", label: cur, color: DK.buy }, { k: "b", label: next, color: DK.stock }], { grouped: true, rowH: 34, labelW: 70, fmt: v => pct(v) })}</div></div>
      <p class="hint">ТКБЕ — бюджет утверждён ТК БЕ; УТВП — в программе и бюджете (MCB); СГЛБ — согласован бюджетированием; ПЗТГ — прогноз завершения года; КОРБ — скорректирован; ТРКБ — нужна корректировка. План УСО в заказах заполнен не полностью — факт УСО прошлых лет выше плана.</p>`)
    + dkSlide("Выводы и что сделать", `Предложения по текущему контексту на ${dmy(m.asOf)}; сроки и ответственных нужно согласовать.`,
      `<div class="dk-acts">${acts.map(([t, b, c], i) => `<div><i style="background:${c}">${i + 1}</i><p><b>${esc(t)}</b><br>${esc(b)}</p></div>`).join("")}</div>`);
}

/* ===================== 07 Справочники и качество данных ===================== */
function dkS07(dk, m) {
  const c = (D.catalog && D.catalog.meta) || {}, ic = (D.interchange && D.interchange.meta) || {};
  const amb = c.ambiguousEkmtr || 0, cod = c.items ? c.matchedEkmtr / c.items : null;
  const nWK = (D.fleet.units || []).length, noBook = (D.fleet.units || []).filter(u => !u.book).length;
  const lims = [
    ["Статус — на дату выгрузки", "Стадия заказов 2024–2025 взята из годовых выгрузок PM-06. Если заказ закрыли позже, в отчёте он может быть «в работе».", "#2A3138"],
    ["Запас по площадкам", "Площадка склада — по заводу строки остатков; склады Иркутской области отнесены к Сухому Логу. Склад покрывает только свою площадку; перемещение ограничено и показано как возможность*, не как покрытие.", DK.late],
    ["Позиции ППР и копии", `${dkMln(m.exec.years[dk.next].noOrderPlan)} млн ₽ позиций ППР ${dk.next} и неисполненный план оригиналов БЕ исключены из плана по правилам PM-06.`, "#8A9199"],
    ["Срок поставки — до месяца", "Обеспеченность считается по месяцу: приход внутри месяца потребности считается успевающим.", "#2A3138"],
    ["Парк и книги", `В парке ${nWK} бортов после схлопывания дублей; у ${noBook} нет книги комплектации.`, "#8A9199"],
    ["Стоимость закупок — в рублях", "«Общая стоимость» выгрузки закупки — в рублях (у позиций прайса ДП = цена в юанях × курс пересчёта ≈ 12,48 ₽/¥); валюта документа (ZCNY, ZUSD) — справочно. Цены закупки сравнимы с учётными и плановыми.", DK.late],
  ];
  const issues = (D.quality && D.quality.issues) || [];
  const ck = dkRuleMatrix(m);
  const info = DATA_OVERRIDE_INFO, over = DATA_OVERRIDE.size > 0 && info;
  const steps = [["Загрузить", "Остатки (3 файла), PM-06 M06_{площадка}_{год}.xlsx — только изменившиеся, МТР УСО", DK.buy], ["Пересобрать", "График, статусы и стадии, копии «Развития», ППМ, контроль, обеспеченность, ремонты, тексты", DK.buy],
    ["Сверить", "«Сейчас / После пересборки» и сверки аналитики на новых данных", DK.stock], ["Применить", "Сохраняется в браузере, переживает перезагрузку; плашка вверху отчёта", DK.stock], ["Выложить", "Записать в папку отчёта на диске (Chrome / Edge) или архив data/ для всех", "#2A3138"]];
  return dkSlide("Каталог, кодификация и взаимозаменяемость", "Вкладки «Каталог», «Каталог LinkOne», «Кодификация», «Взаимозаменяемость», «Поиск по номеру». Позиция без кода ЕКМТР не видна в истории расхода, остатках и закупке SAP — её нельзя обеспечить автоматически.",
      `<div class="dk-tiles">${dkTile(num(c.items), "позиций прайса ДП", `УСО — ${num(c.matchedUso)}`)}${dkTile(pct(cod), "кодифицировано ЕКМТР", `${num(c.matchedEkmtr)} позиций; ${num(amb)} неоднозначно`, false, DK.late)}
        ${dkTile(num((c.items || 0) - (c.matchedEkmtr || 0)), "позиций без ЕКМТР", "нет расхода, остатка и закупки", true, "var(--good)")}${dkTile(num(c.matchedTree), "позиций в дереве узлов", "механизм → узел → деталь")}</div>
      <div class="dk-grid dk-55"><div><b class="dk-sub">Кодификация прайса</b>${anHBars([{ label: "Прайс ДП", values: { a: (c.matchedEkmtr || 0) - amb, b: amb, c: (c.items || 0) - (c.matchedEkmtr || 0) } }],
          [{ k: "a", label: "С кодом ЕКМТР", color: DK.stock }, { k: "b", label: "Неоднозначно", color: DK.late, light: true }, { k: "c", label: "Без кода", color: DK.gap }], { percent: true, rowH: 44, labelW: 90 })}
        <div class="toolbar" style="margin-top:10px"><button class="pill" data-an-goto="codif">Кодификация →</button><button class="pill" data-an-goto="lookup">Поиск по номеру →</button></div></div>
      <div class="dk-panel"><b>Ведомость взаимозаменяемости</b><ul class="lk-sum" style="margin-top:6px">
        <li><b>${num(ic.groups)} групп</b> замен, ${num(ic.partsInGroups)} деталей</li><li><b>${num(ic.rowRelations)} связей</b> между книгами WK-20, WK-20C и WK-35</li>
        <li><b>${num(ic.commentedRows)} строк</b> с комментарием — ограничение применения</li><li class="dim">Прямые замены видны в обеспеченности и в поиске по номеру. Транзитивные замены и пересчёт склада «как будто замена» сознательно не делаются.</li></ul></div></div>`)
    + dkSlide("Ограничения данных и расчёта", "Сводка по вкладке «Качество данных» и правилам расчёта — эти оговорки влияют на цифры отчёта.",
      `<div class="dk-lims">${lims.map(([t, b, col]) => `<div><header style="background:${col};color:${col === DK.late ? "#1d2329" : "#fff"}">${esc(t)}</header><p>${esc(b)}</p></div>`).join("")}</div>
      <p class="hint">${dk.cur} — незавершённый год (факт на ${dmy(m.asOf)}); низкий % исполнения ${dk.cur} не означает отставания сам по себе.</p>
      ${issues.length ? `<details style="margin-top:8px"><summary><b>Все записи «Качества данных»: ${num(issues.length)}</b></summary>${dkTable(["Область", "Что влияет на расчёт"], issues.map(i => [esc(i.area), esc(i.impact || (Array.isArray(i.issue) ? i.issue.join(" ") : i.issue))]), { aligns: ["l", "l"], cls: "dk-wrap" })}</details>` : ""}`)
    + dkSlide("Обновление данных — прямо в отчёте, без Python", "Вкладка «Обновление данных»: новые выгрузки SAP BW пересобирают все витрины в браузере; файлы никуда не уходят.",
      `<div class="dk-chev">${steps.map(([t, b, col]) => `<div><header style="background:${col}">${esc(t)}</header><p>${esc(b)}</p></div>`).join("")}</div>
      <div class="dk-tiles">${dkTile("~3 с", "разбор одной выгрузки PM-06", "в браузере, 20 МБ xlsx")}${dkTile("0", "расхождений с Python", "витрины из полных M06_1400/1200_2027", true, "var(--good)")}
        ${dkTile("1,7 млн", "сверенных значений", "тест test_toro_rebuild.mjs")}${dkTile(over ? dmy(info.savedAt) : "нет", "обновлено в этом браузере", over ? ((info.log || []).slice(-1)[0] || {}).label || "" : "работа по опубликованным файлам")}</div>
      ${dkNote("<b>Загружать всё не нужно.</b> Загруженные площадко-годы заменяют свои, остальные берутся из текущих данных; файл 1200 сам разводится на Вернинское и Сухой Лог по балансовой единице. <b>Python остаётся эталоном</b> для каталога, LinkOne, базы знаний, КТГ и презентаций.")}
      <div class="toolbar" style="margin-top:10px"><button class="pill" data-an-goto="upd">Обновление данных →</button></div>`)
    + dkSlide("Двойная проверка расчётов и выводов", "Каждая цифра отчёта считается дважды и сверяется автоматически — здесь сверки пересчитаны для текущих фильтров.",
      `<div class="dk-grid dk-3">${[
        [`${m.checks.filter(x => x.ok).length} / ${m.checks.length}`, "сверок сходятся — текущий контекст", "Сверки в отчёте", [`по площадкам — ${ck.slice(1).map(x => `${esc(x[1])} ${x[3].filter(y => y.ok).length}/${x[3].length}`).join(", ")}`, "стадии = план + ППР + копии; площадки = итог; МТР + УСО = итог; сегменты обеспеченности; цепочка согласования; воронка; S-кривая"], "#2A3138"],
        ["9 223", "показателя сверено в 35 контекстах", "Независимый пересчёт", ["вторая реализация на Python: заказы из строк графика и статусов TOPO (tests/verify_analytics.py)", "поиск по номеру и «Эффективность» — тоже двумя реализациями (tests/verify_mtr.py)"], DK.buy],
        ["0", "расхождений браузер ↔ Python", "Паритет браузер = Python", ["пересборка в браузере совпала с Python по всем витринам — на полных выгрузках PM-06 и на выборке", "итоги по годам, площадкам и бортам = данным презентации"], DK.stock],
      ].map(([v, l, h, items, col], i) => `<div>${dkTile(v, l, "", i === 2, i === 2 ? "var(--good)" : null)}<div class="dk-lims" style="grid-template-columns:1fr;margin-top:10px"><div><header style="background:${col};color:${col === DK.stock ? "#1d2329" : "#fff"}">${esc(h)}</header><ul class="lk-sum">${items.map(t => `<li>${t}</li>`).join("")}</ul></div></div></div>`).join("")}</div>`);
}

/* ===================== 08 Эффективность ===================== */
let DK_EFF = { key: null, eff: null };
function dkEff(m) {
  const key = JSON.stringify(m.ctx) + "|" + (S ? S.rows.length : 0);
  if (DK_EFF.key === key && DK_EFF.refs === D.stock && DK_EFF.prov === D.provision) return DK_EFF.eff;
  const eff = MtrCore.efficiency({ scheduleRows: S ? S.rows : [], controlRows: D.controlRows, provision: D.provision, stock: D.stock, fleet: D.fleet, asOf: m.asOf }, m.ctx);
  DK_EFF = { key, eff, refs: D.stock, prov: D.provision };
  return eff;
}
function dkParetoSvg(curve, W, H = 250) {
  const padL = 44, padR = 12, padT = 10, padB = 28, iw = W - padL - padR, ih = H - padT - padB;
  const x = v => padL + iw * v, y = v => padT + ih - ih * v;
  let svg = `<rect x="${x(0)}" y="${y(1)}" width="${iw}" height="${y(0.8) - y(1) + ih * 0.8}" fill="none"/>`;
  [[0, 0.8, DK.tG], [0.8, 0.95, DK.tA], [0.95, 1, DK.tR]].forEach(([a, b, f]) => { svg += `<rect x="${padL}" y="${y(b)}" width="${iw}" height="${y(a) - y(b)}" fill="${f}" opacity=".55"/>`; });
  for (let g = 0; g <= 4; g++) { const v = g / 4; svg += `<text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end" font-size="10" fill="var(--ink-3)">${pct(v)}</text><text x="${x(v)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--ink-3)">${pct(v)}</text>`; }
  const d = [[0, 0], ...curve].map(([a, b], i) => `${i ? "L" : "M"}${x(a).toFixed(1)},${y(b).toFixed(1)}`).join("");
  svg += `<path d="${d}" fill="none" stroke="${DK.buy}" stroke-width="2.6"/>`;
  ["A 80%", "B 95%", "C"].forEach((t, i) => { svg += `<text x="${W - padR - 4}" y="${y([0.8, 0.95, 1][i]) + 13}" text-anchor="end" font-size="10.5" font-weight="600" fill="#1d2329">${t}</text>`; });
  return `<svg class="an-svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img"><title>Кривая Парето: доля кодов (ось X) и доля расхода (ось Y)</title>${svg}</svg>`;
}
function dkS08(dk, m) {
  if (!S) return dkSlide("Эффективность", "", callout("info", "Загрузка истории заказов 2022–2027…"));
  const e = dkEff(m), a = e.abc, st = e.stock, pr = e.price, cur = e.cur, next = e.next;
  const lastPair = pr.pairs[pr.pairs.length - 1] || {};
  const un = e.unplanned, uy = Object.keys(un).filter(y => y < cur).sort(), fy = Object.keys(un).filter(y => y <= cur).sort();
  const obM = Object.keys(e.orderBy.months).sort(), asOfM = m.asOf.slice(0, 7);
  const sup = e.suppliers.filter(s => s.supplier !== "—");
  const supOpen = sup.reduce((s, x) => s + x.open, 0), supOver = sup.reduce((s, x) => s + x.overdue, 0);
  const siteNote = m.ctx.site ? `склад площадки ${esc(anSite(m.ctx.site))}` : "все площадки";
  const cls = { A: DK.stock, B: DK.late, C: DK.plan };
  return dkSlide("Эффективность: где деньги и резервы", `Новые показатели поверх презентации: концентрация расхода, замороженный капитал, цены, точность плана МТР, сроки заказа и дисциплина поставщиков. Окно расхода — ${e.win.join("–").replace(/–.*–/, "–")}; ${siteNote}.${m.ctx.pg ? " Фильтр группы планирования сужает расход, план и дефицит по заказам; склад, неликвид и поставщики — общие." : ""}`,
      `<div class="dk-tiles">${m.ctx.pg ? dkTile("—", "мес. расхода на складах", "склад общий, по группам планирования не делится", true, "var(--good)") : dkTile(st.months != null ? num(st.months, 1) : "—", "мес. расхода лежит на складах", `${num(st.total / 1e9, 2)} млрд ₽ при расходе ${dkMln(st.factAvgYear)} млн ₽/год`, true, "var(--good)")}
        ${dkTile(dkMln(st.dead.value), "млн ₽ запаса без движения", `${num(st.dead.n)} кодов: нет расхода ${e.win[0]}–${cur} и потребности`, false, DK.gap)}
        ${dkTile(dkMln(st.excess.value), "млн ₽ сверх нормы", `${num(st.excess.n)} кодов: запас > план + 2 года расхода`, false, DK.late)}
        ${dkTile(`${num(a.classes.A.n)} из ${num(a.n)}`, "кодов дают 80% расхода (A)", `${num(a.aNoStock)} из них нет на складе`)}
        ${dkTile(lkChg(lastPair.index != null ? lastPair.index - 1 : null), `цены списания ${lastPair.from}→${lastPair.to}`, `по ${num(lastPair.n)} кодам`)}
        ${dkTile(pct(supOpen ? supOver / supOpen : null), "открытых позиций закупки просрочено", `${num(supOver)} из ${num(supOpen)}`, false, DK.gap)}</div>`)
    + dkSlide(`ABC-анализ расхода МТР ${e.win[0]}–${cur}`, `Факт списания по кодам в контексте фильтров: A — первые 80% расхода, B — до 95%, C — остальное. A-позиции — где планирование и наличие важнее всего.`,
      `<div class="dk-grid dk-46"><div>${anChart(W => dkParetoSvg(a.curve, W))}
        <div class="dk-tiles" style="margin-top:8px">${["A", "B", "C"].map(k => dkTile(`${num(a.classes[k].n)} кодов`, `класс ${k}: ${pct(a.total ? a.classes[k].value / a.total : null)} расхода`, `${dkMln(a.classes[k].value)} млн ₽`, false, cls[k] === DK.plan ? null : cls[k])).join("")}</div></div>
      <div>${dkTable(["ЕКМТР", "Наименование", "Класс", "Расход, млн ₽", "Доля", "Шт", "На складе", "Нужно", "Не покр."], a.top.map(x => [codeLink(x.code), esc(x.name), `<b>${x.cls}</b>`, num(x.value / 1e6, 1), pct(x.share), lkQty(x.qf), lkQty(x.avail), lkQty(x.need), lkQty(x.unc)]),
        { fills: (i, j) => (j === 6 && !a.top[i].avail ? DK.tR : j === 8 && a.top[i].unc > 0 ? DK.tR : null), aligns: ["l", "l", "c", "r", "r", "r", "r", "r", "r"], cls: "dk-compact" })}
      ${dkNote(`<b>Что сделать:</b> ${num(a.aNoStock)} A-позиций нет на складе — для них держать страховой запас или рамочный договор; по C-позициям (${num(a.classes.C.n)} кодов, ${pct(a.total ? a.classes.C.value / a.total : null)} расхода) — упростить заказ, закупать по факту потребности.`)}</div></div>`)
    + dkSlide("Замороженный капитал: запас без движения и избыток", `Без движения — доступный запас, по которому нет расхода ${e.win[0]}–${cur} ${m.ctx.site ? "на этой площадке" : "по бортам"} и нет потребности в открытых заказах. Избыток — запас сверх потребности плана и двух лет среднего расхода, по учётной цене. ${m.ctx.model || m.ctx.unit ? "Фильтры модели и машины на склад не действуют — склад общий для площадки." : ""}`,
      `<div class="dk-tiles">${dkTile(dkMln(st.dead.value), "млн ₽ без движения", `${num(st.dead.n)} кодов`, true, DK.gap)}
        ${Object.entries(st.dead.bySite).sort().map(([s, v]) => dkTile(dkMln(v), `млн ₽ без движения · ${dkShort(s)}`, "")).join("")}${dkTile(dkMln(st.excess.value), "млн ₽ избыток", `${num(st.excess.n)} кодов`, false, DK.late)}</div>
      <div class="dk-grid dk-55"><div><b class="dk-sub">Без движения: крупнейшие</b>${dkTable(["ЕКМТР", "Наименование", "Шт", "млн ₽"], st.dead.top.map(x => [codeLink(x.code), esc(x.name), lkQty(x.qty), `<b>${num(x.value / 1e6, 1)}</b>`]), { aligns: ["l", "l", "r", "r"], cls: "dk-compact" })}</div>
      <div><b class="dk-sub">Избыток: крупнейшие</b>${dkTable(["ЕКМТР", "Наименование", "Запас", "Нужно", "Расход/год", "Избыток, млн ₽"], st.excess.top.map(x => [codeLink(x.code), esc(x.name), lkQty(x.qty), lkQty(x.need), lkQty(x.avgYear), `<b>${num(x.value / 1e6, 1)}</b>`]), { aligns: ["l", "l", "r", "r", "r", "r"], cls: "dk-compact" })}</div></div>
      ${dkNote("<b>Что сделать:</b> запас без движения — проверить применимость (замены, другие модели), предложить другим площадкам и БЕ, реализовать неликвид; по избытку — снять из заявок закупки такие же позиции и не заказывать до выработки.")}`)
    + dkSlide("Изменение цен списания МТР", `Индекс Ласпейреса: цена за штуку по коду (стоимость / количество списания) в весах количества прошлого года; коды с изменением цены больше чем в ${MtrCore.PRICE_JUMP} раз (смена единицы, ошибка) не входят. Годы с неполными выгрузками дают меньшую выборку.`,
      `<div class="dk-grid dk-55"><div><b class="dk-sub">Цепной индекс цен, ${pr.chain[0].year} = 100</b>${dkLine(pr.chain.map(x => x.year), [{ label: "Индекс цен списания", color: DK.buy, values: pr.chain.map(x => (x.value == null ? null : x.value * 100)) }], { yMin: 60, yMax: Math.max(140, ...pr.chain.map(x => (x.value || 0) * 110)), fmt: v => num(v, 0), every: 1, H: 230 })}
        ${dkTable(["Период", "Индекс", "Кодов", "Отсеяно"], pr.pairs.map(x => [`${x.from} → ${x.to}`, `<b>${lkChg(x.index != null ? x.index - 1 : null)}</b>`, num(x.n), num(x.outliers)]), { fills: (i, j) => (j === 1 && pr.pairs[i].index != null ? (pr.pairs[i].index > 1.1 ? DK.tR : pr.pairs[i].index < 0.95 ? DK.tG : null) : null), aligns: ["l", "r", "r", "r"] })}
        ${dkTile(lkChg(pr.plan.index != null ? pr.plan.index - 1 : null), `план ${next} к последней цене факта`, `${num(pr.plan.n)} кодов · ${dkMln(pr.plan.plan)} млн ₽ плана`, true, "var(--good)")}</div>
      <div><b class="dk-sub">Сильнее всего подорожали (расход ≥ 50 тыс. ₽ в последний год)</b>${dkTable(["ЕКМТР", "Наименование", "Было, ₽/шт", "Стало, ₽/шт", "Изменение"], pr.growth.slice(0, 10).map(x => [codeLink(x.code), esc(x.name), `${num(x.p0, 0)} <span class="dim">${x.y0}</span>`, `${num(x.p1, 0)} <span class="dim">${x.y1}</span>`, `<b>${lkChg(x.change)}</b>`]), { aligns: ["l", "l", "r", "r", "r"], cls: "dk-compact" })}
        <b class="dk-sub" style="margin-top:10px">Подешевели</b>${dkTable(["ЕКМТР", "Наименование", "Было", "Стало", "Изменение"], pr.fall.filter(x => x.change < 0).slice(0, 5).map(x => [codeLink(x.code), esc(x.name), num(x.p0, 0), num(x.p1, 0), `<b>${lkChg(x.change)}</b>`]), { aligns: ["l", "l", "r", "r", "r"], cls: "dk-compact" })}
        <p class="hint">Всего кодов со сравнимой ценой: ${num(pr.growthN)}; отсеяно скачков: ${num(pr.growthOut)}. Цены по одному коду — «Поиск по номеру».</p></div></div>`)
    + dkSlide("Точность планирования МТР по строкам заказов", "Оценка планирования «Развития»: только заказы групп планирования 100 Механика и 200 Энергетика (группа известна с 2024 года). Внеплановый расход — факт по строкам, которых не было в плане заказа; неиспользованный план — строки закрытых лет с планом и без факта (отменённые и перенесённые работы, лишние материалы в плане).",
      `<div class="dk-grid dk-55"><div>${anColumns(fy, [{ label: "Неиспользованный план, доля", color: DK.late, values: fy.map(y => (y < cur ? un[y].unusedShare : null)) }, { label: "Внеплановый расход, доля", color: DK.gap, values: fy.map(y => un[y].share) }], { fmt: v => pct(v), H: 240 })}</div>
      <div>${dkTable(["Год", "План, млн ₽", "Не использовано", "Факт, млн ₽", "Вне плана", "Строк вне плана"], fy.map(y => [y, dkMln(un[y].plan), y < cur ? `${dkMln(un[y].unused)} · <b>${pct(un[y].unusedShare)}</b>` : "год идёт", dkMln(un[y].fact), `${dkMln(un[y].unplanned)} · <b>${pct(un[y].share)}</b>`, num(un[y].unplannedLines)]),
        { fills: (i, j) => (j === 2 && fy[i] < cur ? ((un[fy[i]].unusedShare || 0) > 0.15 ? DK.tR : (un[fy[i]].unusedShare || 0) > 0.05 ? DK.tA : DK.tG) : null), aligns: ["l", "r", "r", "r", "r", "r"] })}
        ${dkNote(`<b>Вывод:</b> на уровне строк почти весь расход запланирован; главный резерв — план, который не превращается в расход (${uy.length ? uy.map(y => `${y}: ${pct(un[y].unusedShare)}`).join(", ") : "—"}): эти деньги держат бюджет и закупку, но не нужны.`)}</div></div>`)
    + dkSlide("Календарь «заказать до»", `Непокрытая к сроку потребность по месяцу крайней даты заказа (дата потребности минус медианный срок поставки кода). Красное — дата уже прошла: заказом не успеть, нужны аналоги, перенос работ или перемещение.`,
      `<div class="dk-tiles">${dkTile(dkMln(e.orderBy.pastV), "млн ₽ — дата заказа прошла", `${num(e.orderBy.pastN)} позиций`, true, DK.gap)}${dkTile(dkMln(obM.filter(x => x >= asOfM).reduce((s, x) => s + e.orderBy.months[x].value, 0)), "млн ₽ — ещё успеваем", "если заказать до даты", false, "var(--good)")}</div>
      ${obM.length ? anColumns(obM.map(x => lkMon(x)), [{ label: "Не покрыто, млн ₽", color: DK.buy, values: obM.map(x => e.orderBy.months[x].value) }], { pointColor: i => (obM[i] < asOfM ? DK.gap : null), H: 240 }) : '<p class="hint">Непокрытой потребности в контексте нет.</p>'}`)
    + dkSlide("Поставщики: просрочка и срок поставки", "По документам выгрузки закупки (закупка общая, фильтры площадки на неё не действуют). Просрочка — открытая позиция с прошедшим месяцем поставки; срок — от создания заказа до фактического прихода.",
      `<div class="dk-grid dk-46"><div>${anHBars(sup.slice(0, 8).map(s => ({ label: s.supplier.length > 22 ? s.supplier.slice(0, 21) + "…" : s.supplier, values: { o: s.overdue, k: s.open - s.overdue } })), [{ k: "o", label: "Просрочено", color: DK.gap }, { k: "k", label: "В срок", color: DK.buy }], { rowH: 28, labelW: 170, fmt: v => num(v) })}</div>
      <div>${dkTable(["Поставщик", "Кодов", "Позиций", "Открыто", "Просрочено", "Доля", "Срок, дн."], sup.map(s => [esc(s.supplier), num(s.codes), num(s.positions), num(s.open), num(s.overdue), `<b>${pct(s.overdueShare)}</b>`, s.leadMedian != null ? `${s.leadMedian} <span class="dim">(${s.leadN})</span>` : "—"]),
        { fills: (i, j) => (j === 5 && sup[i].overdueShare != null ? (sup[i].overdueShare > 0.3 ? DK.tR : sup[i].overdueShare > 0.1 ? DK.tA : DK.tG) : null), aligns: ["l", "r", "r", "r", "r", "r", "r"], cls: "dk-compact" })}</div></div>`);
}
