/* Вкладка «Поиск по номеру»: каталожный номер (или ЕКМТР, или название) →
   историческое потребление, плановое потребление, изменение цен, закупка и
   статус наличия — одной страницей, с автоматическим выводом и действием.
   Расчёты — MtrCore (lib/mtr_core.js), сверяются tests/test_mtr.mjs с
   независимым пересчётом tests/verify_mtr.py. */
"use strict";

try { LK.analogs = localStorage.getItem("wk-lk-analogs") !== "0"; } catch (e) { /* нет хранилища */ }
const LK_RECENT_KEY = "wk-lk-recent";
const LK_VERD = { covered: "обеспечено", inTime: "успеем заказать", late: "не успеем", past: "срок прошёл", nodate: "нет срока" };
const LK_LV = { ok: ["good", "var(--good)"], warn: ["warn", "var(--warn)"], bad: ["bad", "var(--bad)"], info: ["info", "var(--info)"], na: ["", "var(--ink-3)"] };

function lkRecent() { try { return JSON.parse(localStorage.getItem(LK_RECENT_KEY)) || []; } catch (e) { return []; } }
function lkRemember(q) {
  try { localStorage.setItem(LK_RECENT_KEY, JSON.stringify([q, ...lkRecent().filter(x => x !== q)].slice(0, 8))); } catch (e) { /* нет хранилища */ }
}
function lkRef() {
  const ek = (D.ekmtrWk && D.ekmtrWk.items) || [];
  const known = new Set((D.stock.items || []).map(i => String(i.code)));
  (D.provision.items || []).forEach(i => known.add(String(i.code)));
  if (S) S.rows.forEach(r => { if (r.code) known.add(String(r.code)); });
  const nameOf = new Map(ek.map(e => [String(e.code), e.name]));
  (D.stock.items || []).forEach(i => { if (!nameOf.has(String(i.code))) nameOf.set(String(i.code), i.name); });
  return { catalog: D.catalog.items || [], ekmtr: ek, interchange: D.interchange, knownCodes: known, nameOf };
}
function lkSrc() {
  if (!D.controlRows || D.controlRowsOf !== D.control) { D.controlRows = AnalyticsCore.decodeControl(D.control); D.controlRowsOf = D.control; }
  return { scheduleRows: S ? S.rows : [], controlRows: D.controlRows, provision: D.provision, stock: D.stock, fleet: D.fleet,
    asOf: (D.control.meta && D.control.meta.asOf) || (D.provision.meta || {}).asOf, catalog: D.catalog.items || [] };
}
const lkQty = v => (v == null ? "—" : num(v, Number.isInteger(+v) ? 0 : 1));
const lkRub = v => (v == null ? "—" : Math.abs(v) >= 1e6 ? num(v / 1e6, 1) + " млн ₽" : num(v, 0) + " ₽");
const lkSite = s => (siteNameOf(s) || s || "—").split(" / ")[0];
const lkMon = m => { const MN = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]; return m && /^\d{4}-\d{2}/.test(m) ? `${MN[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}` : (m || "—"); };
const lkChg = v => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${num(Math.abs(v) * 100, 0)}%`);

/* линейный график цен с точками (одиночные значения тоже видны) */
function lkPriceChart(cats, series, H = 260) {
  return anChart(W => {
    const vals = series.flatMap(s => s.values).filter(v => v != null && v > 0);
    if (!vals.length) return '<p class="hint">Цен для графика нет.</p>';
    const max = Math.max(...vals) * 1.12, padL = 64, padR = 12, padT = 12, padB = 26, iw = W - padL - padR, ih = H - padT - padB;
    const x = i => padL + (cats.length < 2 ? iw / 2 : iw * i / (cats.length - 1)), y = v => padT + ih - ih * v / max;
    const f = v => (v >= 1e6 ? num(v / 1e6, 1) + " млн" : v >= 1e3 ? num(v / 1e3, 1) + " тыс" : num(v, 0));
    let svg = "";
    for (let g = 0; g <= 4; g++) { const v = max * g / 4, gy = y(v); svg += `<line x1="${padL}" x2="${W - padR}" y1="${gy}" y2="${gy}" stroke="var(--line)" stroke-width="0.8"/><text x="${padL - 6}" y="${gy + 3}" text-anchor="end" font-size="10" fill="var(--ink-3)">${esc(f(v))}</text>`; }
    cats.forEach((c, i) => { svg += `<text x="${x(i)}" y="${H - 7}" text-anchor="middle" font-size="10.5" fill="var(--ink-3)">${esc(c)}</text>`; });
    series.forEach(s => {
      if (s.flat != null) { svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(s.flat)}" y2="${y(s.flat)}" stroke="${s.color}" stroke-width="1.6" stroke-dasharray="6 4"><title>${esc(s.label)}: ${esc(f(s.flat))} ₽</title></line>`; return; }
      let d = "", pen = false;
      s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
      if (!s.dots) svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round"/>`;
      s.values.forEach((v, i) => { if (v != null) svg += `<circle cx="${x(i)}" cy="${y(v)}" r="${s.dots ? 5 : 3.6}" fill="${s.color}"><title>${esc(s.label)} ${esc(cats[i])}: ${esc(num(v, 0))} ₽</title></circle>`; });
    });
    return `${anLegend(series.map(s => ({ label: s.label, color: s.color })))}<svg class="an-svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img">${svg}</svg>`;
  });
}

/* вывод по позиции: что происходит и что делать */
function lkSummary(p, r) {
  const st = p.status.all, out = [], act = [];
  const fy = p.years.filter(y => y >= String(+p.cur - 2) && y <= p.cur);
  const qf = fy.reduce((s, y) => s + p.byYear[y].qf, 0), a = fy.reduce((s, y) => s + p.byYear[y].a, 0);
  const top = p.units.find(u => u.qf > 0);
  out.push(qf > 0
    ? `<b>Расход ${fy[0]}–${fy[fy.length - 1]}:</b> ${lkQty(qf)} шт на ${lkRub(a)}; в среднем ${lkQty(p.avgQf)} шт в год (${p.fullYears.join(", ")}). Больше всего — ${esc(top ? top.unitShort : "—")}${p.lastFact ? `, последний раз ${dmy(p.lastFact)}` : ""}.`
    : `<b>Расхода за ${fy[0]}–${fy[fy.length - 1]} нет</b>${p.lastFact ? ` (последний — ${dmy(p.lastFact)})` : ""}.`);
  const n = p.need.total;
  if (n.qty > 0) {
    out.push(`<b>Потребность в открытых заказах:</b> ${lkQty(n.qty)} шт на ${lkRub(n.value)} — со склада ${lkQty(n.fromStock)}, закупкой к сроку ${lkQty(n.fromBuy)}${n.late ? `, поставка опаздывает ${lkQty(n.late)}` : ""}${n.undated ? `, без даты поставки ${lkQty(n.undated)}` : ""}${n.gap ? `, <b style="color:var(--bad)">не покрыто ${lkQty(n.gap)}</b>` : ""}.`);
  } else out.push("<b>В открытых заказах 2026–2027 не нужна.</b>");
  const pr = p.price;
  if (pr.factLast) out.push(`<b>Цена:</b> факт ${pr.factLast.year} — ${lkRub(pr.factLast.price)} за шт${pr.factChange != null ? ` (${lkChg(pr.factChange)} к ${pr.factFirst.year})` : ""}${pr.planVsFact != null ? `; в плане ${p.next} заложено ${lkChg(pr.planVsFact)} к последней фактической` : ""}${pr.purchase.length ? `; последняя закупка — ${lkRub(pr.purchase[pr.purchase.length - 1].price)} за шт (${pr.purchase[pr.purchase.length - 1].year})` : ""}.`);
  const s = p.stock;
  out.push(s.qty > 0
    ? `<b>Наличие:</b> доступно ${lkQty(s.availQty)} шт (${lkRub(s.availValue)}) — ${Object.entries(s.bySite).filter(([, v]) => v.availQty > 0).map(([k, v]) => `${esc(lkSite(k))} ${lkQty(v.availQty)}`).join(", ") || "нет"}${s.restrictedQty ? `; ограничено ${lkQty(s.restrictedQty)} шт` : ""}${p.status.monthsOfStock != null ? `; хватит на ${num(p.status.monthsOfStock, 0)} мес. среднего расхода` : ""}.`
    : "<b>На складах нет.</b>");
  const pu = p.purchase;
  if (pu.openQty > 0) out.push(`<b>Закупка:</b> ещё поставить ${lkQty(pu.openQty)} шт${pu.overdueQty ? `, из них <b style="color:var(--bad)">просрочено ${lkQty(pu.overdueQty)}</b>` : ""}; ближайшая поставка — ${lkMon(pu.nextDelivery)}; срок поставки по коду ~${pu.leadMedianCode || "—"} дн.`);
  else out.push("<b>В закупке нет</b> открытых заявок и заказов.");
  // что делать
  if (st.key === "notOrdered" || st.key === "short") act.push(`Заказать ${lkQty(st.gap)} шт${p.status.orderBy ? ` — крайняя дата заказа ${dmy(p.status.orderBy)}${p.status.orderBy < p.asOf ? " уже прошла: искать аналог, перенос работ или перемещение" : ""}` : ""}.`);
  if (st.key === "late") act.push(`Ускорить поставку или перенести работы: потребность с ${p.status.firstNeed ? dmy(p.status.firstNeed) : "—"}, поставка ${lkMon(pu.nextDelivery)}.`);
  if (st.transfer > 0) act.push(`Есть на другой площадке: до ${lkQty(st.transfer)} шт можно переместить (перемещение ограничено, в обеспеченность не входит).`);
  if (pu.overdueQty > 0) act.push(`Эскалировать поставщику ${esc((pu.suppliers[0] || {}).supplier || "")} просрочку ${lkQty(pu.overdueQty)} шт.`);
  if (st.key === "idle") act.push(`Запас без расхода 3 года и без потребности — проверить на неликвид (${lkRub(s.availValue)}).`);
  if (p.status.monthsOfStock != null && p.status.monthsOfStock > 36 && st.key !== "idle") act.push(`Запаса на ${num(p.status.monthsOfStock, 0)} мес. — новые закупки сверх плана не нужны.`);
  if (LK.analogs && r.codes.some(c => c.rel === "analog") && (st.key === "notOrdered" || st.key === "short" || st.key === "late")) {
    const aq = s.analogAvailQty;
    act.push(aq > 0 ? `Взаимозаменяемые номера есть на складе: ${lkQty(aq)} шт (${lkRub(s.analogAvailValue)}) — сверить комплектацию и применить.` : "Взаимозаменяемых номеров на складе тоже нет.");
  }
  return { out, act };
}

function renderLookup(host) {
  const recent = lkRecent();
  const examples = ["K1839.01.00", "K1844.16.01.00", "K1803.07.02.00", "976755"];
  host.innerHTML = `<h1>Поиск по каталожному номеру</h1>
    <p class="sub">Каталожный номер, код ЕКМТР или часть названия → история расхода 2022–${esc(String(new Date().getFullYear()))}, план, изменение цен, закупка и наличие по площадкам. Номер в прайсе ДП, в названии ЕКМТР и в ведомости взаимозаменяемости ищется одинаково.</p>
    <form class="lk-search" id="lkForm" role="search">
      <input type="search" id="lkQ" value="${esc(LK.q)}" placeholder="Например, K1839.01.00 или 976755" autocomplete="off" aria-label="Каталожный номер"/>
      <button class="pill on" type="submit" style="padding:10px 20px">Найти</button>
      <label class="lk-an"><input type="checkbox" id="lkAn" ${LK.analogs ? "checked" : ""}/> учитывать взаимозаменяемые</label>
    </form>
    <div class="toolbar lk-chips">${(recent.length ? recent : examples).map(q => `<button class="pill" type="button" data-lk-q="${esc(q)}">${esc(q)}</button>`).join("")}<span class="hint" style="margin:0">${recent.length ? "недавние" : "примеры"}</span></div>
    <div id="lkOut"></div>`;
  const form = byId("lkForm"), inp = byId("lkQ");
  form.onsubmit = e => { e.preventDefault(); lkGo(inp.value); };
  byId("lkAn").onchange = e => { LK.analogs = e.target.checked; try { localStorage.setItem("wk-lk-analogs", LK.analogs ? "1" : "0"); } catch (x) {} lkShow(); };
  qsa("[data-lk-q]", host).forEach(b => { b.onclick = () => { inp.value = b.dataset.lkQ; lkGo(b.dataset.lkQ); }; });
  if (!LK.q) { byId("lkOut").innerHTML = lkIntro(); return; }
  lkShow();
}
function lkIntro() {
  return `<section class="card"><h3>Что показывает поиск</h3><div class="dk-grid dk-3">
    ${[["Историческое потребление", "план и факт по годам и площадкам, борта и заказы с расходом"], ["Плановое потребление", "план 2027 и потребность открытых заказов 2026–2027 с покрытием складом и закупкой"],
       ["Изменение цен", "цена списания и плана по годам, цена закупки, прайс ДП в юанях"], ["Закупка", "заявки и заказы поставщику, график поставок, просрочка, срок поставки"],
       ["Статус наличия", "склады по площадкам, ограниченный запас, вердикт и что сделать"], ["Взаимозаменяемость", "прямые замены из ведомости WK — их запас, закупка и расход рядом"]]
      .map(([t, s]) => `<div class="dk-tile"><div class="l"><b>${esc(t)}</b></div><div class="s">${esc(s)}</div></div>`).join("")}</div></section>`;
}
function lkGo(q) {
  LK.q = String(q || "").trim();
  if (LK.q) lkRemember(LK.q);
  writeHash(true);
  renderTab();
}
async function lkShow() {
  const out = byId("lkOut");
  if (!out) return;
  if (!S) {
    out.innerHTML = callout("info", "Загрузка истории заказов 2022–2027…");
    try { await ensureSchedule(); } catch (e) { out.innerHTML = callout("bad", esc(e.message)); return; }
    if (TAB !== "lookup") return;
  }
  const r = MtrCore.resolve(LK.q, lkRef());
  const self = r.codes.filter(c => c.rel === "self").map(c => c.code), an = LK.analogs ? r.codes.filter(c => c.rel === "analog").map(c => c.code) : [];
  if (!self.length) {
    out.innerHTML = (r.arts.length ? lkArts(r) + callout("warn", "<b>У номера нет кода ЕКМТР.</b> Без кода позиция не видна в расходе, остатках и закупке SAP — её нужно кодифицировать (вкладка «Кодификация»).") : callout("warn", `По запросу «${esc(LK.q)}» точного совпадения нет.`))
      + (r.suggestions.length ? `<section class="card"><h3>Похожие номера и названия</h3><div class="twrap"><table><thead><tr><th>Номер / код</th><th>Наименование</th><th>Где</th></tr></thead><tbody>
        ${r.suggestions.map(s => `<tr><td><button class="minibtn mono" data-lk-q="${esc(s.key)}">${esc(s.key)}</button></td><td>${esc(s.name)}</td><td>${esc(s.kind === "art" ? "прайс ДП · " + s.sub : s.sub)}</td></tr>`).join("")}</tbody></table></div></section>` : "");
    lkWire(out);
    return;
  }
  const p = MtrCore.profile(lkSrc(), self, { analogs: an });
  out.innerHTML = lkArts(r) + lkStatus(p, r) + lkHistory(p) + lkPrices(p) + lkNeed(p) + lkPurchase(p) + lkStock(p) + lkUnits(p);
  anMount(out);
  lkWire(out);
}
function lkWire(host) {
  qsa("[data-lk-q]", host).forEach(b => { b.onclick = () => { const i = byId("lkQ"); if (i) i.value = b.dataset.lkQ; lkGo(b.dataset.lkQ); }; });
  qsa("[data-lk-art]", host).forEach(b => { b.onclick = () => openDetail(b.dataset.lkArt); });
  qsa("[data-lk-more]", host).forEach(b => { b.onclick = () => { qsa(`[data-lk-row="${b.dataset.lkMore}"]`, host).forEach(tr => { tr.hidden = false; }); b.remove(); }; });
  qsa("[data-purchase-id]", host).forEach(b => { b.onclick = () => openPurchaseDocument(b.dataset.purchaseType, b.dataset.purchaseId, b.dataset.code || ""); });
  wireCodeLinks(host);
}

/* ---------- блоки ---------- */
function lkArts(r) {
  const rows = r.arts.map(a => [a.rel === "self" ? '<span class="badge good">искомый</span>' : '<span class="badge info">взаимозаменяемый</span>',
    a.notInCatalog ? `<span class="mono">${esc(a.art)}</span>` : `<button class="minibtn mono" data-lk-art="${esc(a.art)}">${esc(a.art)}</button>`,
    esc(a.nameRu || (a.notInCatalog ? "нет в прайсе ДП" : "")), esc(a.model || ""), a.ekmtr ? codeLink(a.ekmtr) : '<span class="badge bad">без ЕКМТР</span>',
    a.priceCNY != null ? cny(a.priceCNY) : "—"]);
  const codes = r.codes.filter(c => LK.analogs || c.rel === "self");
  return dkSlide(`${r.query}: что найдено`, `Коды ЕКМТР — из прайса ДП и по номеру в названии материала; взаимозаменяемые — прямые связи ведомости (перед заменой сверяйте комплектацию).${LK.analogs ? "" : " Взаимозаменяемые выключены."}`,
    (rows.length ? dkTable(["", "Каталожный №", "Наименование", "Модель", "ЕКМТР", "Прайс ДП"], rows, { aligns: ["l", "l", "l", "l", "l", "r"] }) : "")
    + `<div class="toolbar" style="flex-wrap:wrap;margin-top:8px">${codes.map(c => `<span class="sup-pill ${c.rel === "self" ? "ok" : "info"}" title="${esc(c.via.join(", "))}">${codeLink(c.code)} ${esc(c.name || "")} · ${esc(c.via.join(", "))}</span>`).join(" ")}</div>`);
}
function lkStatus(p, r) {
  const st = p.status.all, [cls, ink] = LK_LV[st.level] || LK_LV.na, sm = lkSummary(p, r), s = p.stock, pu = p.purchase, n = p.need.total;
  const cy = p.cur, fy = p.years.filter(y => y >= String(+cy - 2) && y <= cy);
  const qf = fy.reduce((a, y) => a + p.byYear[y].qf, 0);
  const sites = Object.entries(p.status.bySite);
  return `<section class="card lk-status" style="border-left:6px solid ${ink}">
    <div class="lk-status-h"><span class="badge ${cls}" style="font-size:13px;padding:5px 12px">${esc(st.label)}</span>
      ${sites.map(([k, v]) => `<span class="sup-pill ${(LK_LV[v.level] || LK_LV.na)[0] === "good" ? "ok" : (LK_LV[v.level] || LK_LV.na)[0]}"${G.site === k ? ' style="outline:2px solid var(--accent)"' : ""}>${esc(lkSite(k))}: ${esc(v.label)}</span>`).join(" ")}</div>
    <div class="dk-tiles">
      ${dkTile(lkQty(qf), `шт расход ${fy[0]}–${fy[fy.length - 1]}`, `в среднем ${lkQty(p.avgQf)} шт/год`)}
      ${dkTile(lkQty((p.byYear[p.next] || {}).qp || 0), `шт в плане ${p.next}`, lkRub((p.byYear[p.next] || {}).p || 0))}
      ${dkTile(lkQty(n.qty), "шт нужно в открытых заказах", n.qty ? `не покрыто к сроку ${lkQty(n.late + n.undated + n.gap)}` : "потребности нет", false, n.late + n.undated + n.gap > 0 ? DK.gap : null)}
      ${dkTile(lkQty(s.availQty), "шт доступно на складах", `${lkRub(s.availValue)}${s.restrictedQty ? ` · огранич. ${lkQty(s.restrictedQty)}` : ""}`, true, "var(--good)")}
      ${dkTile(lkQty(pu.openQty), "шт ещё поставить", pu.overdueQty ? `просрочено ${lkQty(pu.overdueQty)}` : pu.nextDelivery ? `ближайшая ${lkMon(pu.nextDelivery)}` : "", false, pu.overdueQty ? DK.gap : null)}
      ${dkTile(p.price.factLast ? lkRub(p.price.factLast.price) : "—", "цена факт за шт", p.price.factChange != null ? `${lkChg(p.price.factChange)} к ${p.price.factFirst.year}` : "")}
    </div>
    <div class="dk-grid dk-62"><ul class="lk-sum">${sm.out.map(t => `<li>${t}</li>`).join("")}</ul>
      ${dkNote(`<b>Что сделать</b><br>${sm.act.length ? sm.act.map(t => "• " + t).join("<br>") : "Действий не требуется: потребность покрыта, запас соответствует расходу."}${p.status.orderBy ? `<br><span class="dim">Крайняя дата заказа по витрине: ${dmy(p.status.orderBy)} · вердикт: ${esc(LK_VERD[p.status.verdict] || p.status.verdict || "—")}</span>` : ""}`)}</div>
  </section>`;
}
function lkHistory(p) {
  const ys = p.years, an = LK.analogs && p.analogs.length;
  const series = [{ label: "План, шт", color: DK.plan, values: ys.map(y => p.byYear[y].qp || null) }, { label: "Факт, шт", color: DK.fact, values: ys.map(y => (y > p.cur ? null : p.byYear[y].qf)) }];
  if (an) series.push({ label: "Факт взаимозаменяемых, шт", color: DK.buy, values: ys.map(y => (y > p.cur ? null : p.byYearAnalog[y].qf)) });
  const sites = Object.keys(p.bySite).sort();
  const cover = (S && S.meta && S.meta.sourceFiles) ? S.meta.sourceFiles.filter(f => f.wkRows > 0).map(f => f.file.replace(".json", "")) : [];
  const missing = ys.filter(y => y < p.cur).flatMap(y => ["1100", "1400"].filter(s => !cover.includes(`${s}_${y}`)).map(s => `${lkSite(s)} ${y}`));
  return dkSlide("Историческое и плановое потребление по годам", `Строки графика ТОРО WK (PM-06): план и факт в штуках; ${p.cur} — факт на ${dmy(p.asOf)}, ${p.next} — план. Позиции ППР без заказа в план не входят (показаны серым «+»); строки возврата демонтированного узла (отрицательное количество) — не расход.${missing.length ? ` Нет выгрузок: ${esc(missing.join(", "))}.` : ""}`,
    `<div class="dk-grid dk-55"><div>${anColumns(ys, series, { fmt: v => lkQty(v), H: 240 })}</div>
    <div>${dkTable(["Год", "План, шт", "Факт, шт", "План, ₽", "Факт, ₽", "Заказов", "Бортов", ...(an ? ["Взаимозам. факт"] : [])],
      ys.map(y => { const t = p.byYear[y]; return [y, lkQty(t.qp) + (t.qpNoOrder ? ` <span class="dim" title="позиции ППР без заказа">+${lkQty(t.qpNoOrder)}</span>` : ""), y > p.cur ? "—" : `<b>${lkQty(t.qf)}</b>`, lkRub(t.p), y > p.cur ? "—" : lkRub(t.a), num(t.orders), num(t.units), ...(an ? [y > p.cur ? "—" : lkQty(p.byYearAnalog[y].qf)] : [])]; }),
      { fills: (i, j) => (j === 2 && ys[i] <= p.cur && p.byYear[ys[i]].qp > 0 ? dkExecFill(p.byYear[ys[i]].qf / p.byYear[ys[i]].qp) : null) })}
    ${sites.length > 1 ? `<b class="dk-sub" style="margin-top:12px">По площадкам: план / факт, шт</b>${dkTable(["Площадка", ...ys], sites.map(s => [esc(lkSite(s)), ...ys.map(y => { const t = (p.bySite[s] || {})[y]; return t ? `${lkQty(t.qp)} / ${y > p.cur ? "—" : lkQty(t.qf)}` : "—"; })]), { aligns: ["l", ...ys.map(() => "c")] })}` : ""}</div></div>`);
}
function lkPrices(p) {
  const pr = p.price, ys = p.years;
  const byY = Object.fromEntries(pr.purchase.map(x => [x.year, x]));
  const catYears = [...new Set([...ys, ...pr.purchase.map(x => x.year)])].sort();
  const rate = getRate() || pr.rateImplied;
  const cnyP = pr.catalogCNY.find(c => c.priceCNY);
  const series = [
    { label: "Факт (цена списания)", color: DK.fact, values: catYears.map(y => (pr.byYear[y] ? pr.byYear[y].fact : null)) },
    { label: "План", color: DK.plan, values: catYears.map(y => (pr.byYear[y] ? pr.byYear[y].plan : null)) },
    { label: "Закупка (документы)", color: DK.buy, dots: true, values: catYears.map(y => (byY[y] ? byY[y].price : null)) },
  ];
  if (pr.stock) series.push({ label: "Учётная цена склада", color: DK.late, flat: pr.stock });
  if (cnyP && rate) series.push({ label: `Прайс ДП × ${num(rate, 2)} ₽/¥`, color: DK.gap, flat: cnyP.priceCNY * rate });
  const rows = catYears.map(y => [y, lkRub(pr.byYear[y] && pr.byYear[y].plan), `<b>${lkRub(pr.byYear[y] && pr.byYear[y].fact)}</b>`, byY[y] ? `${lkRub(byY[y].price)} <span class="dim">(${num(byY[y].n)} поз.)</span>` : "—"]);
  return dkSlide("Изменение цен", `Цена за штуку, ₽: факт — стоимость списания / количество, план — плановая стоимость строк графика, закупка — «Общая стоимость» документа / количество по году создания заказа (стоимость в выгрузке — в рублях; у позиций прайса ДП она равна цене в юанях × курс пересчёта${pr.rateImplied ? ` ≈ ${num(pr.rateImplied, 2)} ₽/¥` : ""}).`,
    `<div class="dk-grid dk-55"><div>${lkPriceChart(catYears, series)}</div><div>
      ${dkTable(["Год", "План, ₽/шт", "Факт, ₽/шт", "Закупка, ₽/шт"], rows, { aligns: ["l", "r", "r", "r"] })}
      <div class="dk-tiles" style="margin-top:12px">
        ${dkTile(lkChg(pr.factChange), "изменение цены факта", pr.factFirst && pr.factLast ? `${pr.factFirst.year} → ${pr.factLast.year}` : "мало данных", false, pr.factChange > 0.15 ? DK.gap : null)}
        ${dkTile(lkChg(pr.planVsFact), `план ${p.next} к последней цене`, pr.factLast ? `факт ${pr.factLast.year}` : "", false, pr.planVsFact != null && pr.planVsFact < -0.1 ? DK.gap : null)}
        ${cnyP ? dkTile(cny(cnyP.priceCNY), "прайс ДП", cnyP.priceUsoCNY != null ? `УСО ${cny(cnyP.priceUsoCNY)}` : "") : ""}
      </div></div></div>`);
}
function lkNeed(p) {
  const L = p.need.lines.filter(l => LK.analogs || l.rel === "self"), ny = Object.keys(p.need.byYear).sort();
  const segRows = ny.map(y => { const t = p.need.byYear[y]; return { label: `${y} · ${lkQty(t.qty)} шт`, values: { own: t.fromStock, buy: t.fromBuy, late: t.late + t.undated, gap: t.gap } }; });
  const defs = [{ k: "own", label: "Склад своей площадки", color: DK.stock }, { k: "buy", label: "Закупка к сроку", color: DK.buy }, { k: "late", label: "Опаздывает / без даты", color: DK.late }, { k: "gap", label: "Не покрыто", color: DK.gap }];
  const lim = 25;
  return dkSlide("Плановое потребление: открытые заказы 2026–2027", "Строки открытых заказов ТОРО из витрины обеспеченности: склад своей площадки, затем закупка с датой не позже потребности (по месяцам). Перемещение с других площадок — только возможность.",
    (segRows.length ? `<div class="dk-grid dk-28"><div><b class="dk-sub">Покрытие, шт</b>${anHBars(segRows, defs, { rowH: 30, labelW: 120, fmt: v => lkQty(v) })}</div><div>` : "<div><div>")
    + (L.length ? `<div class="twrap"><table class="dk-table dk-compact"><thead><tr><th>Дата</th><th>Заказ</th><th>Борт</th><th>Площадка</th><th>Код</th><th class="n">Нужно</th><th class="n">Склад</th><th class="n">Закупка</th><th class="n">Опозд.</th><th class="n">Не покр.</th><th>ППМ</th></tr></thead><tbody>
      ${L.map((l, i) => `<tr${i >= lim ? ` data-lk-row="need" hidden` : ""}${l.rel === "analog" ? ' class="dim"' : ""}><td>${dmy(l.date)}</td><td>${entityLink("toro", l.order, l)}</td><td>${esc(anShort(l.unit))}</td><td>${esc(lkSite(l.site))}</td><td>${codeLink(l.code)}</td>
        <td class="n"><b>${lkQty(l.qty)}</b></td><td class="n">${lkQty(l.fromStock)}</td><td class="n">${lkQty(l.fromBuy)}</td><td class="n">${lkQty(l.late + l.undated)}</td>
        <td class="n"${l.gap > 0 ? ' style="color:var(--bad);font-weight:600"' : ""}>${lkQty(l.gap)}</td><td>${esc({ immediate: "Немедл.", onRelease: "С деблок.", never: "Никогда" }[l.ppm] || "—")}</td></tr>`).join("")}
      </tbody></table></div>${L.length > lim ? `<button class="minibtn" data-lk-more="need">Показать все ${num(L.length)}</button>` : ""}` : '<p class="hint">В открытых заказах 2026–2027 этой позиции нет.</p>')
    + "</div></div>");
}
function lkPurchase(p) {
  const pu = p.purchase, docs = pu.docs.filter(d => LK.analogs || d.rel === "self");
  const months = Object.keys(pu.byMonth).sort(), asOfM = p.asOf.slice(0, 7), lim = 20;
  return dkSlide("Закупка: заявки, заказы и поставки", `Выгрузка закупки «Развитие»: открытые и закрытые строки. Просрочка — плановая дата поставки раньше ${lkMon(asOfM)}. Срок поставки — от создания заказа до фактического прихода.`,
    `<div class="dk-tiles">${dkTile(lkQty(pu.openQty), "шт ещё поставить", `в пути ${lkQty(pu.transitQty)}`)}${dkTile(lkQty(pu.overdueQty), "шт просрочено", "дата поставки прошла", false, pu.overdueQty ? DK.gap : null)}
      ${dkTile(pu.nextDelivery ? lkMon(pu.nextDelivery) : "—", "ближайшая поставка", "")}${dkTile(pu.leadMedianCode ? `${pu.leadMedianCode} дн.` : "—", "срок поставки кода", pu.leadN ? `по приходам: ${pu.leadDays} дн. (${pu.leadN})` : "медиана витрины")}
      ${dkTile(num(pu.suppliers.length), "поставщиков", esc((pu.suppliers[0] || {}).supplier || ""))}</div>`
    + (months.length ? `<b class="dk-sub">Ещё поставить по месяцу поставки, шт</b>${anColumns(months.map(lkMon), [{ label: "Поставка", color: DK.buy, values: months.map(m => pu.byMonth[m]) }], { fmt: v => lkQty(v), pointColor: i => (months[i] < asOfM ? DK.gap : null), H: 200 })}` : "")
    + (docs.length ? `<div class="twrap" style="margin-top:10px"><table class="dk-table dk-compact"><thead><tr><th>Документ</th><th>Код</th><th>Создан</th><th>Поставка</th><th>Факт</th><th>Поставщик</th><th>Статус</th><th class="n">Кол-во</th><th class="n">Ещё</th><th class="n">₽ за шт</th><th class="n">Срок, дн.</th></tr></thead><tbody>
      ${docs.map((d, i) => `<tr${i >= lim ? ` data-lk-row="docs" hidden` : ""}${d.rel === "analog" ? ' class="dim"' : ""}><td>${purchaseDocumentButton(d).replace("<button", `<button data-code="${esc(d.code)}"`)}</td><td>${codeLink(d.code)}</td><td>${d.created ? dmy(d.created) : "—"}</td>
        <td${d.overdue ? ' style="color:var(--bad);font-weight:600"' : ""}>${d.delivery ? dmy(d.delivery) : "—"}</td><td>${d.actual ? dmy(d.actual) : "—"}</td><td>${esc(d.supplier || "—")}</td><td>${esc(d.status || "—")}</td>
        <td class="n">${lkQty(d.qty)}</td><td class="n">${lkQty(d.openQty)}</td><td class="n">${d.price != null ? num(d.price, 0) : "—"}</td><td class="n">${d.lead != null ? d.lead : "—"}</td></tr>`).join("")}
      </tbody></table></div>${docs.length > lim ? `<button class="minibtn" data-lk-more="docs">Показать все ${num(docs.length)}</button>` : ""}` : callout("warn", "<b>Не заказано.</b> Заявок и заказов поставщику по коду в выгрузке закупки нет."))
  );
}
function lkStock(p) {
  const s = p.stock, sites = Object.keys(s.bySite).sort();
  const need = p.need.bySite;
  const allSites = [...new Set([...sites, ...Object.keys(need)])].sort();
  return dkSlide("Статус наличия по площадкам и складам", `Остатки на ${dmy(p.asOf)}. Склад покрывает потребность только своей площадки; ограниченный запас (б/у, брак) к выдаче недоступен.`,
    `<div class="dk-grid dk-46"><div>${allSites.length ? dkTable(["Площадка", "Остаток", "Доступно", "Нужно", "Не покрыто", "Статус"], allSites.map(k => {
        const a = s.bySite[k] || {}, n = need[k] || { qty: 0, late: 0, undated: 0, gap: 0 }, st = p.status.bySite[k] || {};
        return [esc(lkSite(k)), lkQty(a.qty || 0), `<b>${lkQty(a.availQty || 0)}</b>`, lkQty(n.qty), lkQty(n.late + n.undated + n.gap), esc(st.label || "—")];
      }), { fills: (i, j) => (j === 5 ? ({ ok: DK.tG, warn: DK.tA, bad: DK.tR })[(p.status.bySite[allSites[i]] || {}).level] || null : null), aligns: ["l", "r", "r", "r", "r", "l"] }) : '<p class="hint">Остатков и потребности по площадкам нет.</p>'}
      ${LK.analogs && p.analogs.length ? dkNote(`<b>Взаимозаменяемые на складах:</b> ${lkQty(s.analogAvailQty)} шт · ${lkRub(s.analogAvailValue)}`) : ""}</div>
    <div>${s.warehouses.length ? dkTable(["Площадка", "Завод", "Склад", "Код", "Кол-во", "Доступно", "₽"], s.warehouses.map(w => [esc(lkSite(w.site)), esc(w.plant), esc(w.name) + (w.kind === "consign" ? ' <span class="badge">конс.</span>' : ""), codeLink(w.code), lkQty(w.qty), lkQty(w.avail), lkRub(w.value)]),
      { fills: (i) => (G.site && s.warehouses[i].site === G.site ? DK.tG : null), aligns: ["l", "l", "l", "l", "r", "r", "r"] }) : '<p class="hint">На складах WK позиции нет.</p>'}</div></div>`);
}
function lkUnits(p) {
  const U = p.units.slice(0, 20), O = p.orders.filter(o => LK.analogs || o.rel === "self"), lim = 25;
  const stage = k => (TORO_STAGE[k] || k || "—");
  return dkSlide("Где расходуется: борта и заказы", "Сумма по всем годам графика; последний расход — дата окончания строки с фактом.",
    `<div class="dk-grid dk-46"><div>${U.length ? dkTable(["Борт", "Площадка", "Факт, шт", "Факт, ₽", "План, шт", "Годы расхода", "Последний"], U.map(u => [esc(u.unitShort), esc(lkSite(u.site)), `<b>${lkQty(u.qf)}</b>`, lkRub(u.a), lkQty(u.qp), esc(u.years.join(", ") || "—"), u.last ? dmy(u.last) : "—"]), { aligns: ["l", "l", "r", "r", "r", "l", "c"] }) : '<p class="hint">Расхода по бортам нет.</p>'}</div>
    <div>${O.length ? `<div class="twrap"><table class="dk-table dk-compact"><thead><tr><th>Год</th><th>Заказ</th><th>Борт</th><th>Вид работ</th><th>Стадия</th><th class="n">План</th><th class="n">Факт</th><th class="n">Факт, ₽</th></tr></thead><tbody>
      ${O.map((o, i) => `<tr${i >= lim ? ` data-lk-row="orders" hidden` : ""}${o.rel === "analog" ? ' class="dim"' : ""}><td>${o.year}</td><td>${entityLink("toro", o.order, o)}</td><td>${esc(anShort(o.unit))}</td><td>${esc(o.work || "—")}</td><td>${esc(stage(o.stage))}</td>
        <td class="n">${lkQty(o.qp)}</td><td class="n"><b>${lkQty(o.qf)}</b></td><td class="n">${lkRub(o.a)}</td></tr>`).join("")}</tbody></table></div>
      ${O.length > lim ? `<button class="minibtn" data-lk-more="orders">Показать все ${num(O.length)}</button>` : ""}` : '<p class="hint">Заказов с этой позицией нет.</p>'}</div></div>`);
}

/* открыть поиск по номеру из карточек и глобального поиска */
function openLookup(q) {
  if (typeof closeModal === "function") closeModal();
  LK.q = String(q || "").trim();
  if (LK.q) lkRemember(LK.q);
  navigateTo("lookup");
}
