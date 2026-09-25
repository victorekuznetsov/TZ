import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const A = require("../lib/analytics_core.js");
const T = require("../lib/toro_rebuild.js");

// Слайды презентации во вкладке «Аналитика» (AnalyticsCore.deck) против данных,
// по которым собрана презентация: build/build_wk_status_data.py — отдельная
// сборка на Python (tests/fixtures/deck_expected.json).
const url = p => new URL(p, import.meta.url);
const L = n => JSON.parse(readFileSync(url(`../data/${n}.json`), "utf8"));
const LJ = n => { const t = readFileSync(url(`../data/${n}.local.js`), "utf8"); return JSON.parse(t.slice(t.indexOf("=", t.indexOf("__DATA__[")) + 1).trim().replace(/;$/, "")); };
const w = JSON.parse(readFileSync(url("./fixtures/deck_expected.json"), "utf8"));
const man = LJ("schedule_manifest");
const src = { control: L("control"), provision: L("provision"), stock: L("stock"), fleet: L("fleet"), usoWk: L("uso_wk"),
  scheduleRows: man.shards.flatMap(n => T.decodeTable(LJ(n))) };
src.controlRows = A.decodeControl(src.control);
assert.equal(src.provision.meta.asOf, w.meta.asOf, "данные обновились — пересоберите фикстуру (build/build_wk_status_data.py)");
const d = A.deck(src, {});
// МТР подрядчика: статус и факт — из заказа ТОРО, не из «факта» реестра УСО (плановая цена в валюте по курсу)
{ const o = src.usoWk.orders.find(x => x.order === "1102377926"), u = A.usoStatus(o);
  assert.equal(u.stage, "approved"); assert.equal(u.closed, false); assert.equal(u.sapFact, 0);
  assert.equal(u.plan, 5529014); assert.equal(u.open, 5529014); assert.equal(o.lines[0].a, undefined); }
let n = 0; const bad = [];
const eq = (a, b, p) => { n++; if (typeof b === 'number' || typeof a === 'number') { if (Math.abs((a || 0) - (b || 0)) > 1e-6 * Math.max(1, Math.abs(b || 0)) + 1e-9) bad.push(`${p}: ${a} ≠ ${b}`); } else if (a !== b && !(a == null && b == null)) bad.push(`${p}: ${a} ≠ ${b}`); };
const K = ['plan', 'fact', 'mtrPlan', 'mtrFact', 'usoPlan', 'usoFact', 'orders', 'noOrderPlan', 'noOrderN', 'copyExcluded', 'exec', 'closedShare'];
for (const y of A.YEARS) { K.forEach(k => eq(d.total[y][k], w.total[y][k], `total.${y}.${k}`)); A.GROUPS.forEach(g => eq(d.total[y].groups[g], w.total[y].groups[g], `total.${y}.${g}`)); }
for (const s in w.site) for (const y of A.YEARS) { K.forEach(k => eq(d.site[s][y][k], w.site[s][y][k], `site.${s}.${y}.${k}`)); A.GROUPS.forEach(g => eq(d.site[s][y].groups[g], w.site[s][y].groups[g], `site.${s}.${y}.${g}`)); }
for (const u in w.unit) for (const y of A.YEARS) ['plan', 'fact', 'noOrderPlan', 'exec'].forEach(k => eq((d.unit[u] || {})[y]?.[k], w.unit[u][y][k], `unit.${u}.${y}.${k}`));
for (const md in w.model) for (const y of A.YEARS) ['plan', 'fact', 'exec'].forEach(k => eq(d.model[md][y][k], w.model[md][y][k], `model.${md}.${y}.${k}`));
for (const k in w.work) for (const y of A.YEARS) [0, 1].forEach(i => eq((d.work[k] || {})[y]?.[i], w.work[k][y][i], `work.${k}.${y}.${i}`));
for (const k in w.reason) for (const y of A.YEARS) [0, 1].forEach(i => eq((d.reason[k] || {})[y]?.[i], w.reason[k][y][i], `reason.${k}.${y}.${i}`));
w.topFact.forEach((x, i) => { eq(d.topFact[i].code, x.code, `topFact[${i}].code`); ['fact', 'qf', 'plan27'].forEach(k => eq(d.topFact[i][k], x[k], `topFact[${i}].${k}`)); eq(d.topFact[i].name, x.name, `topFact[${i}].name`); });
w.topPlan27.forEach((x, i) => { eq(d.topPlan[i].code, x.code, `topPlan[${i}].code`); ['plan27', 'qp27', 'units'].forEach(k => eq(d.topPlan[i][k], x[k], `topPlan[${i}].${k}`)); });
for (const u in w.ktg.unit) for (const y in w.ktg.unit[u]) ['plan', 'fact'].forEach(k => eq(d.ktg.unit[u]?.[y]?.[k], w.ktg.unit[u][y][k], `ktg.${u}.${y}.${k}`));
for (const s in w.ktg.siteYear) for (const y in w.ktg.siteYear[s]) ['plan', 'fact'].forEach(k => eq(d.ktg.siteYear[s][y][k], w.ktg.siteYear[s][y][k], `ktgSite.${s}.${y}.${k}`));
['plan', 'fact'].forEach(k => w.ktg.fleetMonth[k].forEach((v, i) => eq(d.ktg.fleetMonth[k][i], v, `fleetMonth.${k}[${i}]`)));
for (const s in w.prov.site) for (const y in w.prov.site[s]) for (const k in w.prov.site[s][y]) eq(d.prov.site[s]?.[y]?.[k], w.prov.site[s][y][k], `prov.site.${s}.${y}.${k}`);
for (const u in w.prov.unit) for (const y in w.prov.unit[u]) for (const k in w.prov.unit[u][y]) eq(d.prov.unit[u]?.[y]?.[k] ?? 0, w.prov.unit[u][y][k], `prov.unit.${u}.${y}.${k}`);
w.prov.deficit.forEach((x, i) => { eq(d.prov.deficit[i].code, x.code, `deficit[${i}]`); eq(d.prov.deficit[i].gapValue, x.gapValue, `deficit[${i}].gapValue`); });
w.prov.orderToday.forEach((x, i) => { eq(d.prov.orderToday[i].code, x.code, `orderToday[${i}]`); eq(d.prov.orderToday[i].canOrder, x.canOrder, `orderToday[${i}].canOrder`); });
eq(d.prov.orderTodaySum, w.prov.orderTodaySum, 'orderTodaySum'); eq(d.prov.orderTodayN, w.prov.orderTodayN, 'orderTodayN');
w.prov.moves.forEach(([f, t, v]) => eq(d.prov.moves[f + '>' + t], v, `moves.${f}>${t}`));
w.prov.moveTop.forEach((x, i) => { eq(d.prov.moveTop[i].code, x.code, `moveTop[${i}]`); eq(d.prov.moveTop[i].value, x.value, `moveTop[${i}].value`); });
w.stock.byWarehouse.forEach(([nm, v], i) => { eq(d.stock.byWarehouse[i].name, nm, `wh[${i}].name`); eq(d.stock.byWarehouse[i].value, v, `wh[${i}].value`); });
['items', 'openQty', 'transitQty', 'overdue', 'undated', 'needCodes', 'leadMedian', 'leadN'].forEach(k => eq(d.purchase[k], w.purchase[k], `purchase.${k}`));
for (const k in w.purchase.byMonth) eq(d.purchase.byMonth[k], w.purchase.byMonth[k], `purchase.byMonth.${k}`);
for (const k in w.purchase.leadHist) eq(d.purchase.leadHist[k], w.purchase.leadHist[k], `leadHist.${k}`);
for (const s in w.uso.site) for (const y in w.uso.site[s]) for (const k in w.uso.site[s][y]) eq(d.uso[s]?.[y]?.[k] ?? 0, w.uso.site[s][y][k], `uso.${s}.${y}.${k}`);
assert.deepEqual(bad, [], bad.slice(0, 20).join("\n"));
assert.ok(n > 2000);
// фильтр по площадке: суммы разрезов сходятся к итогам всего парка
const bySite = ["1100", "1400", "2400"].map(s => A.deck(src, { site: s }));
for (const y of A.YEARS) {
  const sum = bySite.reduce((s, x) => s + x.total[y].plan, 0);
  assert.ok(Math.abs(sum - d.total[y].plan) < 1, `план ${y}: сумма площадок ${sum} ≠ ${d.total[y].plan}`);
}
bySite.forEach((x, i) => Object.keys(x.prov.site).forEach(s => assert.equal(s, ["1100", "1400", "2400"][i], "обеспеченность другой площадки в фильтре")));
console.log(`test_deck: сверено ${n} значений слайдов с данными презентации — OK`);
