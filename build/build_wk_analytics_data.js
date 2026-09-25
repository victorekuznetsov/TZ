/* Данные для раздела презентации «Автовыводы и контроль отделов» — из того
   же ядра, что вкладки «Аналитика» и «Контроль отделов» (lib/analytics_core.js),
   поэтому цифры слайдов совпадают с отчётом.

     node build/build_wk_analytics_data.js wk_analytics.json
*/
"use strict";
const fs = require("fs");
const path = require("path");
const A = require("../lib/analytics_core.js");

const root = path.join(__dirname, "..");
const L = n => JSON.parse(fs.readFileSync(path.join(root, "data", n + ".json"), "utf8"));
const src = { control: L("control"), provision: L("provision"), stock: L("stock"), fleet: L("fleet") };
src.controlRows = A.decodeControl(src.control);
const texts = L("order_text").text;

const slim = r => ({ y: r.y, order: r.order, unit: r.unit.replace("Экскаватор электрический ", ""), site: r.site,
  kind: r.kind, start: r.start, end: r.end, plan: r.planCounted, fact: r.fact, stage: r.stage, text: texts[r.order] || "" });

const m = A.buildModel(src, {});
const sites = ["1100", "1400", "2400"];
const bySite = Object.fromEntries(sites.map(s => [s, A.buildModel(src, { site: s })]));
const levels = mm => Object.fromEntries(A.RULES.map(r => {
  const lv = mm.conclusions.filter(c => c.id === r.id).map(c => c.level);
  const order = ["bad", "warn", "info", "ok"];
  return [r.id, lv.length ? order.find(l => lv.includes(l)) : "na"];
}));
const cur = m.asOf.slice(0, 4), next = String(+cur + 1);
const E = m.execCtl, P = m.plan, B = m.budget;

const out = {
  asOf: m.asOf, cur, next, elapsed: m.elapsed,
  rules: A.RULES.map(r => ({ id: r.id, group: r.group, title: r.title, test: r.test })),
  levels: { all: levels(m), ...Object.fromEntries(sites.map(s => [s, levels(bySite[s])])) },
  conclusions: m.conclusions.map(c => ({ id: c.id, group: c.group, title: c.title, level: c.level, text: c.text, evidence: c.evidence })),
  counts: Object.fromEntries(["bad", "warn", "info", "ok"].map(l => [l, m.conclusions.filter(c => c.level === l).length])),
  checks: { total: m.checks.length, ok: m.checks.filter(c => c.ok).length,
            bySite: Object.fromEntries(sites.map(s => [s, [bySite[s].checks.length, bySite[s].checks.filter(c => c.ok).length]])) },
  exec: { years: Object.fromEntries(A.YEARS.map(y => [y, { plan: m.exec.years[y].plan, fact: m.exec.years[y].fact,
            mtrPlan: m.exec.years[y].mtrPlan, mtrFact: m.exec.years[y].mtrFact, usoPlan: m.exec.years[y].usoPlan, usoFact: m.exec.years[y].usoFact }])) },
  plan: {
    chain: P.chain, approvedShare: P.approvedShare, nextPlan: P.nextPlan, approvedPlan: P.approvedPlan,
    annual: P.annual, operative: P.operative, soon: P.soon, materials: P.materials.map(({ top, ...x }) => x),
    accuracy: P.accuracy, unplanned: P.unplanned,
    notReleasedStarted: { n: P.notReleasedStarted.n, plan: P.notReleasedStarted.plan },
    scope: { devGroups: m.planScope.devGroups, devShareNext: m.planScope.devShareNext, devShareCur: m.planScope.devShareCur,
             groups: m.planScope.groups.map(g => ({ group: g.group, name: g.name, dev: g.dev, next: (g.years[next] || {}).plan || 0, cur: (g.years[cur] || {}).plan || 0 })) },
  },
  execCtl: {
    funnel: E.funnel, execDue: E.execDue, dueToDate: E.dueToDate, factDueToDate: E.factDueToDate, sCurve: E.sCurve,
    releasedEmpty: { n: E.releasedEmpty.n, plan: E.releasedEmpty.plan, top: E.releasedEmpty.all.slice(0, 8).map(slim) },
    closeOverdue: { n: E.closeOverdue.n, plan: E.closeOverdue.plan },
    notReleasedStarted: { n: E.notReleasedStarted.n, plan: E.notReleasedStarted.plan },
    readyToClose: { n: E.readyToClose.n, plan: E.readyToClose.plan },
    acceptPending: { n: E.acceptPending.n, plan: E.acceptPending.plan },
    tails: { "2024": { n: E.tails["2024"].n, plan: E.tails["2024"].plan }, "2025": { n: E.tails["2025"].n, plan: E.tails["2025"].plan } },
  },
  budget: {
    overrun: Object.fromEntries(Object.entries(B.overrun).map(([y, v]) => [y, { n: v.n, value: v.value }])),
    underrun: Object.fromEntries(Object.entries(B.underrun).map(([y, v]) => [y, { n: v.n, value: v.value }])),
    statusCur: B.statusCur, statusNext: B.statusNext,
    riskUnspent: B.riskUnspent, riskN: B.riskN, riskShare: B.riskShare, ahead: B.ahead,
    riskTop: B.riskAll.slice(0, 8).map(slim),
  },
  orderTexts: Object.keys(texts).length,
};
fs.writeFileSync(process.argv[2] || "wk_analytics.json", JSON.stringify(out));
console.log(`выводов ${m.conclusions.length} (${JSON.stringify(out.counts)}), сверок ${out.checks.ok}/${out.checks.total}`);
