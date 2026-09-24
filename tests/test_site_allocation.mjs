import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WkUpdate = require("../lib/wk_update_pipeline.js");
const StockPipeline = require("../lib/stock_pipeline.js");

// Та же фикстура, что в tests/test_site_allocation.py: браузерная пересборка
// обязана распределять остаток по площадкам так же, как build_provision.py.
const fix = JSON.parse(readFileSync(new URL("./fixtures/site_allocation.json", import.meta.url), "utf8"));
const need = structuredClone(fix.need);
const out = WkUpdate.allocate(need, structuredClone(fix.stock), new Date(fix.today + "T00:00:00Z"), fix.leadDays);
const got = Object.fromEntries(out.map(r => [r.id, r]));
for (const [id, exp] of Object.entries(fix.expected)) {
  for (const [k, v] of Object.entries(exp)) assert.deepEqual(got[id][k], v, `${id}.${k}`);
}

// Правило площадки по заводу — одно для остатков и потребности.
for (const [plant, site] of Object.entries({ "1100": "1100", "7101": "1100", "7106": "1100", "110C": "1100", "1400": "1400", "7104": "1400", "1200": "2400", "1208": "2400", "2400": "2400", "7102": "2400", "7108": "2400", "1300": "1300", "7103": "1300", "7100": "", "": "" })) {
  assert.equal(StockPipeline.plantSite(plant), site, plant);
}

// Ограниченный запас вычитается на своём складе, а не по средней цене кода:
// б/у-ковш на складе с нулевой стоимостью не уменьшает доступную стоимость.
const wh = {
  "1100/2101": { site: "1100" }, "7106/1005": { site: "1100" }, "1400/1W01": { site: "1400" },
};
const split = StockPipeline.warehouseSplit(
  { "1100/2101": 6, "7106/1005": 1, "1400/1W01": 2 },
  { "1100/2101": 0, "7106/1005": 45.76, "1400/1W01": 10 },
  wh, { "1100/2101": 6 });
assert.equal(split.avail["1100/2101"], 0);
assert.equal(split.sites["1100"].availQty, 1);
assert.equal(split.sites["1100"].availValue, 45.76);
assert.equal(split.sites["1100"].restrictedValue, 0);
assert.equal(split.sites["1400"].availQty, 2);
console.log("site allocation ok");
