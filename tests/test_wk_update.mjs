import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WkUpdate = require("../lib/wk_update_pipeline.js");

assert.deepEqual(WkUpdate.parseToroName("M06_1400_2026.xlsx"), { site: "1400", year: "2026" });
assert.deepEqual(WkUpdate.parseToroName("1100-2027.xlsx"), { site: "1100", year: "2027" });
assert.equal(WkUpdate.parseUsoName("МТР УСО 2026 all.xlsx"), "2026");
assert.equal(WkUpdate.parseUsoName("uso_2025.xlsx"), "2025");

const d = {
  s: "1400", y: "2026", n: 4,
  o: ["1200407027", "1200407027", "1200407027", "1200407027"],
  e: ["Экскаватор электрический WK-20C №6"],
  ei: [0, 0, 0, 0],
  c: ["Насос", "Рычаг"], ci: [0, 0, 1, 1], cek: ["976494", "869271"],
  w: ["Текущий ремонт"], wi: [0, 0, 0, 0],
  u: ["Комб", "Комб", "Комб", "Комб"],
  qp: [1, 0, 1, 0], qf: [0, 1, 0, 1],
  p: [1231017, 0, 191163, 0], a: [0, 1132563, 0, 265828],
  up: [0, 0, 0, 0], uf: [0, 0, 0, 0],
  od: { "1200407027": ["2026-07-24", "2026-07-24"] },
  orr: { "1200407027": "OPEX (ремонты и ТО)" },
};
const loaded = WkUpdate.loadNeed([d]);
assert.equal(loaded.need.length, 0, loaded.need);
assert.equal(loaded.closed.length, 2);
assert.ok(loaded.closed.every(c => c.qty === 0 && c.factQty === 1));

const d2 = {
  s: "1400", y: "2026", n: 2,
  o: ["1", "1"], e: ["Экскаватор WK-20 №1"], ei: [0, 0],
  c: ["Болт"], ci: [0, 0], cek: ["918065"],
  w: ["ТО"], wi: [0, 0], u: ["ХС", "ХС"],
  qp: [10, 0], qf: [0, 3], p: [1000, 0], a: [0, 250],
  up: [0, 0], uf: [0, 0],
  od: { "1": ["2026-10-01"] }, orr: { "1": "OPEX" },
};
const open = WkUpdate.loadNeed([d2]);
assert.equal(open.need.length, 1);
assert.equal(open.need[0].qty, 7);
assert.equal(open.closed.length, 0);

const uso = WkUpdate.buildUsoWk([
  { site: "7104", order: "1200407027", name: "Выкл", ek: "976555", y: "2026", model: "WK-20C", be: "АО \"Полюс Магадан\"", qp: 1, qf: 1, p: 1044, a: 1044 },
], new Map([["1200407027", { e: "Экскаватор электрический WK-20C №6", u: "Комб", w: "Текущий ремонт", orr: "OPEX", bs: "2026-07-24" }]]));
assert.equal(uso.orders.length, 1);
assert.equal(uso.orders[0].closed, true);
assert.equal(uso.orders[0].site, "1400");

console.log("WkUpdate tests: OK");

const reversal = {...d2, qp: [0, 0], qf: [0, -14]};
assert.equal(WkUpdate.loadNeed([reversal]).need.length, 0);
assert.equal(WkUpdate.loadNeed([{...d2, qf: [0, -3]}]).need[0].qty, 10);
assert.equal(WkUpdate.loadNeed([{...d2, qf: undefined, a: undefined}]).need[0].qty, 10);
const mixed = {...d, qf: [0, 1, 0, 0]};
const assembled = WkUpdate.assemble([mixed],
  {items: d.cek.map(code => ({code, name: code}))},
  {meta: {}, items: d.cek.map(code => ({code, availQty: 0}))});
assert.equal(assembled.orders.length, 1);
assert.equal(assembled.closedOrders.length, 0);
assert.equal(assembled.orders[0].lines.length, 2);
assert.equal(assembled.orders[0].factValue, 1398391);
console.log("Negative corrections, optional columns, partial order completeness: OK");
