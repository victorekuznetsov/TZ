import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const headers = ["Код услуги", "еще поставить", "Количество в пути", "Общая стоимость", "Дата поставки", "Имя поставщика", "Количество", "Дата заявки", "Документ закупки", "Заявка", "Позиция", "Валюта", "ЕИ"];
const source = [
  ["001", 2, 1, 120, "2026-10-15", "Поставщик", 3, "2026-09-01", "00450001", "0010001", "00010", "RUB", "шт"],
  ["001", 1, 0, 40, "", "Поставщик", 1, "", "00450001", "0010001", "00020", "RUB", "шт"],
  ["002", 0, 0, 10, "2026-09-10", "Другой", 1, "", "00450001", "", "00030", "CNY", "кг"],
];
globalThis.XLSXStream = {streamSheet: async (z,s,cb) => [headers,...source].forEach(cb)};
const pipeline = require("../lib/stock_pipeline.js");
const p = await pipeline.parsePurchase(null, "", new Set(["001","002"]));
assert.equal(p.byCode["001"].documents.length,2);
assert.equal(p.byCode["001"].documents[0].document,"00450001");
assert.equal(p.byCode["001"].documents[0].deliveryDate,"2026-10-15");
assert.equal(p.byCode["001"].documents[1].deliveryDate,"");
assert.equal(p.byCode["001"].byMonth[""],1);
globalThis.XLSXStream = {streamSheet: async (z,s,cb) => [headers.slice(0,8),source[0].slice(0,8)].forEach(cb)};
const legacy = await pipeline.parsePurchase(null,"",new Set(["001"]));
assert.equal(legacy.byCode["001"].documents[0].document,"");

const order = {id:"a",order:"123",site:"1400",unit:"WK-20",date:"2026-10-01",lines:[{code:"001",qty:3,fromStock:1,fromBuy:1,gap:1},{code:"002",qty:200}]};
const elements = new Map();
const button = {dataset:{materialOrder:"a"}};
let navigated = "";
const context = {
  D:{stock:{items:Object.entries(p.byCode).map(([code,purchase])=>({code,name:code,purchase}))},
    provision:{orders:[order],closedOrders:[{...order,id:"b",order:"124",closed:true,site:"1200"}]}},
  G:{site:"1400",part:"old",ekmtr:"old"},PROV_FILTER:{q:"stale"},PROV_SELECTED:null,
  esc:v=>String(v??""),num:v=>String(v),dmy:v=>v,siteNameOf:v=>v,
  STOCK_BY_CODE:new Map(),codeLink:v=>v,closeModal:()=>{},renderGlobalFilters:()=>{},
  navigateTo:tab=>{navigated=tab},wireCodeLinks:()=>{},
  byId:id=>{if(!elements.has(id))elements.set(id,{innerHTML:"",focus(){}});return elements.get(id)},
  qsa:sel=>sel==="[data-material-order]"?[button]:[],
};
context.STOCK_BY_CODE=new Map(context.D.stock.items.map(x=>[x.code,x]));
vm.createContext(context);
const app=fs.readFileSync(new URL("../app.js",import.meta.url),"utf8");
vm.runInContext(app.slice(app.indexOf("function materialOrders("),app.indexOf("function openCodeDetail(")),context);
const rows=context.materialOrders("001");
assert.equal(rows.length,1);assert.equal(rows[0].materialQty,3);
assert.ok(context.materialOrdersHtml("001").includes("2026-10-01"));
assert.ok(context.materialPurchasesHtml("001").includes("00450001"));
context.openPurchaseDocument("document","00450001","001");
assert.ok(elements.get("modalCard").innerHTML.includes("Строк: 3"));
assert.ok(elements.get("modalCard").innerHTML.includes("CNY"));
context.wireMaterialDrilldowns({}, "001");button.onclick();
assert.equal(context.PROV_SELECTED,"a");assert.equal(context.PROV_FILTER.q,"");
assert.equal(context.G.ekmtr,"");assert.equal(context.G.part,"");
assert.equal(navigated,"provision");
console.log("Material drilldowns: document lines, missing fields, dates, scope, TORO navigation OK");
