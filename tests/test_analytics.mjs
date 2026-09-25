import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const A = require("../lib/analytics_core.js");

// Двойная проверка вкладок «Аналитика» и «Контроль отделов»: ядро
// (lib/analytics_core.js) против независимого пересчёта на Python
// (tests/verify_analytics.py → fixtures/analytics_expected.json) во всех
// контекстах — весь парк, каждая площадка, модель и борт.
const L = n => JSON.parse(readFileSync(new URL(`../data/${n}.json`, import.meta.url), "utf8"));
const exp = JSON.parse(readFileSync(new URL("./fixtures/analytics_expected.json", import.meta.url), "utf8"));
const src = { control: L("control"), provision: L("provision"), stock: L("stock"), fleet: L("fleet") };
src.controlRows = A.decodeControl(src.control);

const h = createHash("sha256");
for (const n of ["control", "provision", "stock", "fleet"]) h.update(readFileSync(new URL(`../data/${n}.json`, import.meta.url)));
assert.equal(h.digest("hex").slice(0, 16), exp.meta.fingerprint,
  "витрины изменились после пересчёта — запустите python3 tests/verify_analytics.py");
assert.equal(exp.meta.controlDiffCount, 0, "control.json расходится с независимой сборкой заказов из графика");
assert.equal(src.controlRows.length, exp.meta.orders);
assert.equal(src.controlRows.filter(r => r.dev).length, exp.meta.devOrders, "заказов групп 100/200");

let compared = 0;
const money = (got, want, label) => {   // рубли: допуск 1 ₽ + 1e-9 относительный (порядок суммирования)
  compared++;
  if (want == null) return assert.ok(got == null || got === 0, `${label}: ${got} ≠ ${want}`);
  assert.ok(Math.abs((got || 0) - want) <= 1 + Math.abs(want) * 1e-9, `${label}: ${got} ≠ ${want}`);
};
const share = (got, want, label) => {
  compared++;
  if (want == null) return assert.ok(got == null, `${label}: ${got} ≠ null`);
  assert.ok(got != null && Math.abs(got - want) < 1e-9, `${label}: ${got} ≠ ${want}`);
};
const count = (got, want, label) => { compared++; assert.equal(got, want, label); };

for (const c of exp.cases) {
  const tag = JSON.stringify(c.ctx);
  const m = A.buildModel(src, c.ctx);
  const cur = m.asOf.slice(0, 4), next = String(+cur + 1);
  share(m.elapsed, exp.meta.elapsed, "доля года");

  // исполнение по годам
  for (const y of A.YEARS) {
    const g = m.exec.years[y], w = c.years[y], t = `${tag} ${y}`;
    for (const k of ["plan", "fact", "mtrPlan", "usoPlan", "mtrFact", "usoFact", "noOrderPlan"]) money(g[k], w[k], `${t} ${k}`);
    count(g.orders, w.orders, `${t} orders`); count(g.noOrderN, w.noOrderN, `${t} noOrderN`);
    share(g.exec, w.exec, `${t} exec`);
    for (const [k, v] of Object.entries(w.groups)) money(g.groups[k], v, `${t} group ${k}`);
    const other = A.GROUPS.filter(k => !(k in w.groups)).reduce((s, k) => s + g.groups[k], 0);
    money(other, 0, `${t} прочие группы`);
  }
  // контроль исполнения
  const E = m.execCtl, we = c.exec;
  for (const k of ["releasedEmpty", "closeOverdue", "notReleasedStarted", "readyToClose", "acceptPending"]) {
    count(E[k].n, we[k].n, `${tag} ${k}.n`); money(E[k].plan, we[k].plan, `${tag} ${k}.plan`);
  }
  for (const y of ["2024", "2025"]) { count(E.tails[y].n, we.tails[y].n, `${tag} tails ${y}`); money(E.tails[y].plan, we.tails[y].plan, `${tag} tails ${y}`); }
  money(E.dueToDate, we.dueToDate, `${tag} dueToDate`); money(E.factDueToDate, we.factDueToDate, `${tag} factDueToDate`);
  for (const y of ["2024", "2025", "2026"]) share(E.unplanned[y].share, we.unplanned[y], `${tag} unplanned ${y}`);
  // контроль планирования
  const P = m.plan, wp = c.plan;
  for (const ch of P.chain) { count(ch.n, wp.chain[ch.key].n, `${tag} chain ${ch.key}`); money(ch.plan, wp.chain[ch.key].plan, `${tag} chain ${ch.key}`); }
  money(P.nextPlan, wp.nextPlan, `${tag} nextPlan`); money(P.approvedPlan, wp.approvedPlan, `${tag} approvedPlan`);
  share(P.approvedShare, wp.approvedShare, `${tag} approvedShare`);
  for (const a of P.annual) share(a.share, wp.annual[a.code], `${tag} annual ${a.code}`);
  count(P.soon.n, wp.soon.n, `${tag} soon.n`); money(P.soon.plan, wp.soon.plan, `${tag} soon.plan`);
  for (const a of P.operative) share(a.share, wp.operative[a.code], `${tag} operative ${a.code}`);
  for (const a of P.materials) { count(a.n, wp.materials[a.code].n, `${tag} mat ${a.code}`); money(a.plan, wp.materials[a.code].plan, `${tag} mat ${a.code}`); }
  for (const y of ["2024", "2025"]) for (const k of ["n", "ok", "noFactN"]) count(P.accuracy[y][k], wp.accuracy[y][k], `${tag} accuracy ${y}.${k}`);
  // оценка планирования «Развития» — только группы 100/200
  count(P.notReleasedStarted.n, wp.notReleasedStarted.n, `${tag} plan notReleasedStarted.n`); money(P.notReleasedStarted.plan, wp.notReleasedStarted.plan, `${tag} plan notReleasedStarted.plan`);
  for (const y of ["2024", "2025", "2026"]) { share(P.unplanned[y].share, wp.unplanned[y], `${tag} plan unplanned ${y}`); money(P.unplanned[y].fact, wp.unplannedFact[y], `${tag} plan unplanned fact ${y}`); }
  money(P.curYear.plan, wp.curPlan, `${tag} plan curYear`);
  assert.ok(m.rows.filter(r => r.dev).every(r => A.DEV_GROUPS.includes(r.pg.split("/").pop())), `${tag} группы «Развития»`);
  // контроль бюджета
  const B = m.budget, wb = c.budget;
  for (const k of ["overrun", "underrun", "noPlan"]) for (const y of ["2024", "2025", cur]) {
    count(B[k][y].n, wb[k][y].n, `${tag} ${k} ${y}.n`); money(B[k][y].value, wb[k][y].value, `${tag} ${k} ${y}`);
  }
  for (const [k, list] of [["statusCur", B.statusCur], ["statusNext", B.statusNext]]) for (const x of list) {
    count(x.n, wb[k][x.code].n, `${tag} ${k} ${x.code}.n`); money(x.plan, wb[k][x.code].plan, `${tag} ${k} ${x.code}`);
    share(x.share, wb[k][x.code].share, `${tag} ${k} ${x.code} share`);
  }
  money(B.riskUnspent, wb.riskUnspent, `${tag} riskUnspent`); count(B.riskN, wb.riskN, `${tag} riskN`);
  money(B.ahead, wb.ahead, `${tag} ahead`);
  // обеспеченность: итоги заказа в ядре против построчной суммы в пересчёте
  const pv = m.prov, wv = c.prov;
  const cmpProv = (g, w, t) => {
    money(g.value, w.value, `${t} value`); money(g.fromStock, w.own, `${t} own`); money(g.fromBuy, w.buy, `${t} buy`);
    money(g.uncovered, w.uncovered, `${t} uncovered`); money(g.gap, w.gap, `${t} gap`);
    money(g.transferPotential, w.potential, `${t} potential`);
    share(g.coverage, w.coverage, `${t} coverage`); share(g.coverageWithMove, w.coverageWithMove, `${t} coverageWithMove`);
    for (const k of ["own", "buy", "late", "pot", "gap"]) {
      money(g.seg[k], w.seg[k], `${t} seg.${k}`);
      assert.ok(g.seg[k] >= -1, `${t} seg.${k} < 0`);
    }
  };
  assert.deepEqual(Object.keys(pv.byYear).sort(), Object.keys(wv.byYear).sort(), `${tag} годы обеспеченности`);
  for (const [k, w] of Object.entries(wv.byYear)) cmpProv(pv.byYear[k], w, `${tag} prov ${k}`);
  assert.deepEqual(Object.keys(pv.bySite).sort(), Object.keys(wv.bySite).sort(), `${tag} площадки обеспеченности`);
  for (const [k, w] of Object.entries(wv.bySite)) cmpProv(pv.bySite[k], w, `${tag} prov ${k}`);
  money(pv.total.value, wv.value, `${tag} prov total`); share(pv.total.coverage, wv.coverage, `${tag} prov coverage`);
  for (const [k, w] of Object.entries(wv.ppm)) { money(pv.ppm[k].value, w.value, `${tag} ppm ${k}`); money(pv.ppm[k].uncovered, w.uncovered, `${tag} ppm ${k} unc`); }
  for (const [k, w] of Object.entries(wv.moves)) money(pv.moves[k], w, `${tag} move ${k}`);
  money(Object.values(pv.moves).reduce((s, v) => s + v, 0), Object.values(wv.moves).reduce((s, v) => s + v, 0), `${tag} moves total`);
  for (const [k, w] of Object.entries(wv.feasible)) money(pv.feasible[k], w, `${tag} feasible ${k}`);
  // КТГ
  assert.deepEqual(m.ktg.below.map(r => r.unit).sort(), c.ktg.below, `${tag} КТГ ниже плана`);
  for (const r of m.ktg.byUnit) { share(r[cur].plan, c.ktg.byUnit[r.unit].plan, `${tag} ktg ${r.unit} plan`); share(r[cur].fact, c.ktg.byUnit[r.unit].fact, `${tag} ktg ${r.unit} fact`); }

  // автовыводы: тот же набор правил с теми же уровнями
  const got = m.conclusions.map(x => [x.id, x.level]).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  const want = c.levels.map(x => [x[0], x[1]]).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  assert.deepEqual(got, want, `${tag} уровни автовыводов`);
  // каждое число-доказательство — конечное, каждый вывод ссылается на правило из схемы
  for (const x of m.conclusions) {
    assert.ok(A.RULES.some(r => r.id === x.id), `${tag} ${x.id}: нет в схеме`);
    for (const e of x.evidence) assert.ok(e.value == null || Number.isFinite(e.value), `${tag} ${x.id} ${e.label}`);
    assert.ok(!/NaN|undefined|null/.test(x.text), `${tag} ${x.id}: ${x.text}`);
  }
  // сверки ядра сходятся в каждом контексте
  const bad = m.checks.filter(x => !x.ok);
  assert.deepEqual(bad, [], `${tag} сверки: ${bad.map(x => x.label + " " + x.detail).join("; ")}`);
}

// запасы по площадкам: витрина = сумма по кодам
const m0 = A.buildModel(src, {});
for (const s of m0.stock.bySite) money(s.value, exp.meta.stockBySite[s.site], `запас ${s.site}`);

// пороги правил: граничные значения ведут себя как написано в схеме
const base = A.buildModel(src, {});
const lvl = (mut, id) => { const m = structuredClone({ ...base, conclusions: null, checks: null, rows: [] }); mut(m); return A.conclusions(m).filter(c => c.id === id).map(c => c.level); };
const cy = base.asOf.slice(0, 4), ny = String(+cy + 1);
assert.deepEqual(lvl(m => { m.prov.byYear[ny].coverage = 0.69; }, "supply-coverage"), ["bad"]);
assert.deepEqual(lvl(m => { m.prov.byYear[ny].coverage = 0.70; }, "supply-coverage"), ["warn"]);
assert.deepEqual(lvl(m => { m.prov.byYear[ny].coverage = 0.90; }, "supply-coverage"), ["ok"]);
assert.deepEqual(lvl(m => { m.exec.years[cy].exec = m.elapsed - 0.151; }, "exec-pace"), ["bad"]);
assert.deepEqual(lvl(m => { m.exec.years[cy].exec = m.elapsed - 0.10; }, "exec-pace"), ["warn"]);
assert.deepEqual(lvl(m => { m.exec.years[cy].exec = m.elapsed; }, "exec-pace"), ["ok"]);
assert.deepEqual(lvl(m => { m.budget.riskShare = 0.26; }, "budget-unspent"), ["bad"]);
assert.deepEqual(lvl(m => { m.budget.riskShare = 0.11; }, "budget-unspent"), ["warn"]);
assert.deepEqual(lvl(m => { m.budget.riskShare = 0.10; }, "budget-unspent"), ["ok"]);
assert.deepEqual(lvl(m => { m.exec.years["2024"].exec = 1.11; m.exec.years["2025"].exec = 1.0; }, "exec-closed"), ["warn", "ok"]);
assert.deepEqual(lvl(m => { m.plan.approvedShare = 0.49; }, "plan-next-approved"), ["warn"]);
assert.deepEqual(lvl(m => { m.execCtl.releasedEmpty = { n: 0, plan: 0, fact: 0, top: [] }; }, "exec-released-empty"), ["ok"]);

console.log(`test_analytics: ${exp.cases.length} контекстов, ${compared} сверенных показателей, режим статусов ${exp.meta.mode} — OK`);
