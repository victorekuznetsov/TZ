import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const safe = source.split('document.addEventListener("keydown"', 1)[0] +
  ";globalThis.__h={normArt,loAliasKey,csvCell,interKey,provisionCoverage,parseHash,serializeHash,cartNormalize,tabAllowed,orderTodayItems,issueText,stockAtSite,ROLES};";
const context = {
  console, setTimeout, clearTimeout,
  document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
  window: {},
  location: { hash: "", href: "https://example.test/" },
  history: { replaceState() {}, pushState() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
vm.createContext(context); vm.runInContext(safe, context);
const {
  normArt, loAliasKey, csvCell, interKey, provisionCoverage,
  parseHash, serializeHash, cartNormalize, tabAllowed, orderTodayItems,
  issueText, stockAtSite, ROLES,
} = context.__h;

assert.notEqual(interKey('GB/T91 6.3X45'), interKey('GB/T91 63X45'));
assert.equal(provisionCoverage({needQty:10,fromStock:2,fromBuy:3}),50);
assert.equal(provisionCoverage({needQty:0,fromStock:0,fromBuy:0}),0);
assert.equal(normArt("K-1801.03.00"),"K18010300");
assert.equal(loAliasKey("1-DK1626.01.00A"),"k1626.01.00");
assert.equal(csvCell("=2+2"),"'=2+2");

const parsed = parseHash("#provision&site=2400&order=77&part=K1801.03.15.00&role=supply");
assert.equal(parsed.tab, "provision");
assert.equal(parsed.role, "supply");
assert.equal(parsed.g.site, "2400");
assert.equal(parsed.g.order, "77");
assert.equal(parsed.g.part, "K1801.03.15.00");
assert.equal(serializeHash("provision", "supply", parsed.g), "#provision&role=supply&site=2400&order=77&part=K1801.03.15.00");
assert.equal(parseHash("#catalog").tab, "catalog");
assert.equal(parseHash("").tab, "sum");

assert.equal(tabAllowed("purchase", "supply"), true);
assert.equal(tabAllowed("linkone", "supply"), false);
assert.equal(tabAllowed("kb", "all"), true);
assert.ok(ROLES.toir.tabs.includes("repairs"));

const cart = cartNormalize([{ code: 1, qty: "2", site: "2400" }, null, { name: "x" }]);
assert.equal(cart.length, 1);
assert.equal(cart[0].code, "1");
assert.equal(cart[0].qty, 2);
assert.equal(cart[0].site, "2400");

const pack = orderTodayItems([
  { verdict: "covered", gapValue: 9 },
  { verdict: "inTime", gapValue: 10, canOrder: 4 },
  { verdict: "inTime", gapValue: 50, canOrder: 40 },
  { verdict: "late", gapValue: 80 },
]);
assert.equal(pack.length, 2);
assert.equal(pack[0].canOrder, 40);

assert.ok(issueText(["a", "b"]).includes("a"));
assert.equal(issueText("x"), "x");

const at = stockAtSite({ availQty: 10, byWarehouse: { "2400 СЛ": 2, "1100": 8 } }, "2400", "Сухой Лог");
assert.equal(at.matched, true);
assert.equal(at.siteQty, 2);
assert.equal(stockAtSite({ availQty: 10, byWarehouse: { "1100": 10 } }, "", "").siteQty, null);

console.log("Helper tests: OK");
