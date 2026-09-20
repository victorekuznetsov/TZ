import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const safe = source.split('document.addEventListener("keydown"', 1)[0] + ";globalThis.__h={normArt,loAliasKey,csvCell};";
const context = {console,setTimeout,clearTimeout,document:{querySelector:()=>null,querySelectorAll:()=>[]},window:{}};
vm.createContext(context); vm.runInContext(safe, context);
const {normArt,loAliasKey,csvCell}=context.__h;
assert.equal(normArt("K-1801.03.00"),"K18010300");
assert.equal(loAliasKey("1-DK1626.01.00A"),"k1626.01.00");
assert.equal(csvCell("=2+2"),"'=2+2");
console.log("Helper tests: OK");

