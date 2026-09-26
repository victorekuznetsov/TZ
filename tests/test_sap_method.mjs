import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Вкладка «Методология SAP ТОиР»: каждая подвкладка собирается на реальных витринах без ошибок,
// SVG-схемы сбалансированы, цифры БДО — из data/bdo_summary.json, коды статусов — из каталога.
const L = n => JSON.parse(readFileSync(new URL(`../data/${n}.json`, import.meta.url), "utf8"));
const A = require("../lib/analytics_core.js");
const ctx = {
  console, AnalyticsCore: A, sessionStorage: { getItem: () => null, setItem: () => {} },
  esc: s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  num: (v, d = 0) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(d)), pct: v => (v == null ? "—" : Math.round(v * 100) + "%"),
  mrub: v => (v / 1e6).toFixed(1) + " млн ₽", rub: v => String(v), kpi: (l, v) => `<div class="kpi">${l}${v}</div>`, callout: (k, h) => `<div class="callout ${k}">${h}</div>`,
  normText: s => String(s || "").toLowerCase(), debounce: f => f, byId: () => null, renderTable: () => {},
  D: { bdoSummary: L("bdo_summary"), wkNodes: L("wk_nodes"), sapStatus: L("sap_status_catalog"), sapSources: L("sap_sources"), fleet: L("fleet") },
};
ctx.D.controlRows = A.decodeControl(L("control"));
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../sap_method.js", import.meta.url), "utf8") + "\n;this.__subs = SAP_SUBS; this.__fns = {map: sapMap, bdo: sapBdo, roles: sapRoles, status: sapStatus, plan: sapPlan, exec: sapExec, budget: sapBudget, rel: sapRel, mtr: sapMtr, tx: sapTx, src: sapSrc};", ctx);
let svgs = 0;
for (const [k] of ctx.__subs) {
  const html = ctx.__fns[k]();
  assert.ok(html.length > (["tx", "src"].includes(k) ? 150 : 800), `подвкладка ${k} пустая`);   // tx, src: таблица — после вставки
  const open = (html.match(/<svg\b/g) || []).length, close = (html.match(/<\/svg>/g) || []).length;
  assert.equal(open, close, `несбалансированный SVG в ${k}`);
  assert.equal((html.match(/<g\b/g) || []).length, (html.match(/<\/g>/g) || []).length, `несбалансированные <g> в ${k}`);
  assert.ok(!/undefined|NaN/.test(html.replace(/<[^>]+>/g, " ")), `undefined/NaN в тексте ${k}`);
  svgs += open;
}
const bdo = ctx.__fns.bdo(), B = ctx.D.bdoSummary;
assert.ok(bdo.includes(String(B.meta.tm)) || bdo.includes(ctx.num(B.meta.tm)), "число ТМ из сводки БДО");
assert.ok(bdo.includes("11-RUD-VOST-UGVS-W304"), "пример машины WK на ТМ");
const codes = new Set(ctx.D.sapStatus.codes.map(c => c.code));
["СГГС", "ДЕБЛ", "ТЗКР", "ЗАКР", "ПРСЗ", "ВСБЕ", "УТВГ", "ТКБЕ", "СРОЧ"].forEach(c => assert.ok(codes.has(c), `код ${c} в каталоге`));
console.log(`test_sap_method: ${ctx.__subs.length} подвкладок, ${svgs} схем, ${codes.size} кодов статусов — OK`);
