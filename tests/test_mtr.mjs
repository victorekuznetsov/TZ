import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const A = require("../lib/analytics_core.js");
const M = require("../lib/mtr_core.js");
const T = require("../lib/toro_rebuild.js");

// Двойная проверка «Поиска по номеру» и раздела «Эффективность»: ядро
// (lib/mtr_core.js) против независимого пересчёта на Python
// (tests/verify_mtr.py → fixtures/mtr_expected.json).
const url = p => new URL(p, import.meta.url);
const L = n => JSON.parse(readFileSync(url(`../data/${n}.json`), "utf8"));
const LJ = n => { const t = readFileSync(url(`../data/${n}.local.js`), "utf8"); return JSON.parse(t.slice(t.indexOf("=", t.indexOf("__DATA__[")) + 1).trim().replace(/;$/, "")); };
const exp = JSON.parse(readFileSync(url("./fixtures/mtr_expected.json"), "utf8"));

const man = LJ("schedule_manifest");
const rows = man.shards.flatMap(n => T.decodeTable(LJ(n)));
const h = createHash("sha256");
for (const n of ["catalog", "ekmtr_wk", "interchange", "control", "provision", "stock", "fleet"]) h.update(readFileSync(url(`../data/${n}.json`)));
h.update(JSON.stringify(man.shards).replace(/","/g, '", "')); h.update(String(rows.length));
assert.equal(h.digest("hex").slice(0, 16), exp.meta.fingerprint, "витрины изменились — запустите python3 tests/verify_mtr.py");

const control = L("control"), catalog = L("catalog").items, ek = L("ekmtr_wk").items, stock = L("stock"), provision = L("provision");
const src = { scheduleRows: rows, controlRows: A.decodeControl(control), provision, stock, fleet: L("fleet"), asOf: control.meta.asOf, catalog };
// справочник поиска — как lkRef() во вкладке
const known = new Set([...stock.items.map(i => String(i.code)), ...provision.items.map(i => String(i.code)), ...rows.filter(r => r.code).map(r => String(r.code))]);
const nameOf = new Map(ek.map(e => [String(e.code), e.name]));
stock.items.forEach(i => { if (!nameOf.has(String(i.code))) nameOf.set(String(i.code), i.name); });
const ref = { catalog, ekmtr: ek, interchange: L("interchange"), knownCodes: known, nameOf };

let compared = 0;
const near = (got, want, label, tol = 1e-6) => {
  compared++;
  if (want == null) return assert.ok(got == null, `${label}: ${got} ≠ null`);
  assert.ok(got != null && Math.abs(got - want) <= tol * Math.max(1, Math.abs(want)), `${label}: ${got} ≠ ${want}`);
};
const eq = (got, want, label) => { compared++; assert.deepEqual(got, want, label); };

for (const c of exp.cases) {
  const r = M.resolve(c.q, ref);
  eq(r.codes.filter(x => x.rel === "self").map(x => x.code).sort(), c.find.self, `${c.q}: свои коды`);
  eq(r.codes.filter(x => x.rel === "analog").map(x => x.code).sort(), c.find.analog, `${c.q}: взаимозаменяемые коды`);
  eq(r.arts.filter(a => !a.notInCatalog).map(a => a.art).sort(), c.find.arts, `${c.q}: номера прайса`);
  if (!c.profile) continue;
  const w = c.profile, p = M.profile(src, c.find.self, { analogs: c.find.analog });
  const tag = c.q;
  Object.entries(w.years).forEach(([y, t]) => {
    const g = p.byYear[y];
    ["qp", "qf", "p", "a", "qpNoOrder"].forEach(k => near(g[k], t[k], `${tag} ${y} ${k}`));
    ["lines", "orders", "units"].forEach(k => eq(g[k], t[k], `${tag} ${y} ${k}`));
    near(g.pricePlan, t.pricePlan, `${tag} ${y} цена плана`); near(g.priceFact, t.priceFact, `${tag} ${y} цена факта`);
    near(p.byYearAnalog[y].qf, t.analogQf, `${tag} ${y} факт взаимозаменяемых`);
  });
  Object.entries(w.bySite).forEach(([k, t]) => { const [s, y] = k.split("|"); near(p.bySite[s][y].qp, t.qp || 0, `${tag} ${k} qp`); near(p.bySite[s][y].qf, t.qf || 0, `${tag} ${k} qf`); });
  near(p.avgQf, w.avgQf, `${tag} средний расход`); eq(p.recentFact, w.recentFact, `${tag} расход за 3 года`); eq(p.lastFact, w.lastFact, `${tag} последний расход`);
  eq(p.need.lines.length, w.need.lines, `${tag} строк потребности`);
  Object.entries(w.need.total).forEach(([k, v]) => near(p.need.total[k], v, `${tag} потребность ${k}`));
  Object.entries(w.need.byYear).forEach(([y, t]) => Object.entries(t).forEach(([k, v]) => near(p.need.byYear[y][k], v, `${tag} потребность ${y} ${k}`)));
  ["qty", "availQty", "value", "availValue", "restrictedQty"].forEach(k => near(p.stock[k], w.stock[k], `${tag} склад ${k}`));
  Object.entries(w.stock.bySite).forEach(([s, t]) => Object.entries(t).forEach(([k, v]) => near(p.stock.bySite[s][k], v, `${tag} склад ${s} ${k}`)));
  ["openQty", "overdueQty", "leadDays", "leadN", "nextDelivery"].forEach(k => (typeof w.purchase[k] === "number" ? near : eq)(p.purchase[k], w.purchase[k], `${tag} закупка ${k}`));
  eq(p.purchase.docs.length, w.purchase.docs, `${tag} документов`);
  Object.entries(w.purchase.byMonth).forEach(([mm, v]) => near(p.purchase.byMonth[mm], v, `${tag} поставка ${mm}`));
  eq(Object.keys(p.purchase.byMonth).length, Object.keys(w.purchase.byMonth).length, `${tag} месяцев поставки`);
  eq(p.price.purchase.length, Object.keys(w.purchase.prices).length, `${tag} цен закупки`);
  p.price.purchase.forEach(x => near(x.price, w.purchase.prices[`${x.year}|${x.currency}`], `${tag} цена закупки ${x.year}`));
  eq(p.status.all.key, w.status.all, `${tag} статус`);
  eq(Object.fromEntries(Object.entries(p.status.bySite).map(([s, v]) => [s, v.key])), w.status.bySite, `${tag} статус по площадкам`);
  near(p.status.monthsOfStock, w.status.monthsOfStock, `${tag} месяцев запаса`);
}

for (const { ctx, eff: w } of exp.efficiency) {
  const e = M.efficiency(src, ctx), tag = JSON.stringify(ctx);
  near(e.abc.total, w.abc.total, `${tag} ABC итог`); eq(e.abc.n, w.abc.n, `${tag} ABC кодов`); eq(e.abc.aNoStock, w.abc.aNoStock, `${tag} A без склада`);
  "ABC".split("").forEach(k => { eq(e.abc.classes[k].n, w.abc.classes[k].n, `${tag} класс ${k}`); near(e.abc.classes[k].value, w.abc.classes[k].value, `${tag} класс ${k} ₽`); });
  w.abc.top.forEach((t, i) => { const g = e.abc.top[i]; eq(g.code, t.code, `${tag} ABC #${i}`); eq(g.cls, t.cls, `${tag} ABC #${i} класс`); near(g.value, t.value, `${tag} ABC #${i} ₽`); near(g.avail, t.avail, `${tag} ABC #${i} склад`); near(g.need, t.need, `${tag} ABC #${i} нужно`); });
  near(e.stock.total, w.stock.total, `${tag} склад`); near(e.stock.factAvgYear, w.stock.factAvgYear, `${tag} расход в год`);
  eq(e.stock.dead.n, w.stock.deadN, `${tag} без движения, кодов`); near(e.stock.dead.value, w.stock.deadV, `${tag} без движения ₽`);
  Object.entries(w.stock.deadSite).forEach(([s, v]) => near(e.stock.dead.bySite[s], v, `${tag} без движения ${s}`));
  eq(e.stock.excess.n, w.stock.excessN, `${tag} избыток, кодов`); near(e.stock.excess.value, w.stock.excessV, `${tag} избыток ₽`);
  w.price.pairs.forEach((x, i) => { const g = e.price.pairs[i]; eq([g.from, g.to, g.n, g.outliers], [x.from, x.to, x.n, x.outliers], `${tag} индекс ${x.from}`); near(g.index, x.index, `${tag} индекс ${x.from}→${x.to}`); });
  eq(e.price.growth.map(x => x.code), w.price.growthTop, `${tag} рост цен`); eq([e.price.growthN, e.price.growthOut], [w.price.growthN, w.price.growthOut], `${tag} рост цен, кодов`);
  near(e.price.plan.index, w.price.plan.index, `${tag} цена плана`); eq(e.price.plan.n, w.price.plan.n, `${tag} цена плана, кодов`);
  eq(Object.keys(e.unplanned).sort(), Object.keys(w.unplanned).sort(), `${tag} годы точности плана МТР`);
  Object.entries(w.unplanned).forEach(([y, t]) => Object.entries(t).forEach(([k, v]) => near(e.unplanned[y][k], v, `${tag} ${y} ${k}`)));
  eq(Object.keys(e.orderBy.months).sort(), Object.keys(w.orderBy.months).sort(), `${tag} месяцы «заказать до»`);
  Object.entries(w.orderBy.months).forEach(([mm, v]) => near(e.orderBy.months[mm].value, v, `${tag} заказать до ${mm}`));
  near(e.orderBy.pastV, w.orderBy.pastV, `${tag} дата заказа прошла`); eq(e.orderBy.pastN, w.orderBy.pastN, `${tag} дата заказа прошла, поз.`);
  const bySup = new Map(e.suppliers.map(s => [s.supplier, s]));
  let both = 0;
  w.suppliers.forEach(s => { const g = bySup.get(s.supplier); if (!g) return; both++; eq([g.positions, g.open, g.overdue, g.leadMedian], [s.positions, s.open, s.overdue, s.leadMedian], `${tag} поставщик ${s.supplier}`); });
  assert.ok(both >= Math.min(10, w.suppliers.length), `${tag} поставщиков совпало ${both}`);
}

// нормализация номера — как normArt отчёта
assert.equal(M.normArt("K-1801.03.00"), "K18010300");
assert.equal(M.normArt("к1839.01.00"), "К18390100");
// статус: правила по порядку
const S0 = { need: 0, fromStock: 0, fromBuy: 0, late: 0, undated: 0, gap: 0, transfer: 0, avail: 0, openQty: 0, recentFact: false };
assert.equal(M.statusOf({ ...S0, need: 2, fromStock: 2 }).key, "covered");
assert.equal(M.statusOf({ ...S0, need: 2, fromStock: 1, fromBuy: 1 }).key, "coveredBuy");
assert.equal(M.statusOf({ ...S0, need: 2, gap: 2 }).key, "notOrdered");
assert.equal(M.statusOf({ ...S0, need: 2, gap: 1, openQty: 1 }).key, "short");
assert.equal(M.statusOf({ ...S0, need: 2, late: 2, openQty: 2 }).key, "late");
assert.equal(M.statusOf({ ...S0, avail: 3 }).key, "idle");
assert.equal(M.statusOf({ ...S0, avail: 3, recentFact: true }).key, "stock");
assert.equal(M.statusOf({ ...S0, openQty: 1 }).key, "buying");
assert.equal(M.statusOf(S0).key, "none");

console.log(`test_mtr: запросов ${exp.cases.length}, контекстов ${exp.efficiency.length}, сверено ${compared} значений — OK`);
