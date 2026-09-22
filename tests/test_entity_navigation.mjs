import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const app = fs.readFileSync(new URL("../app.js",import.meta.url),"utf8");
let handler, backed;
const card = {hidden:true,querySelector:()=>null,insertBefore(){}};
const rootFocus={};
const ctx={console,document:{activeElement:rootFocus,body:{classList:{add(){}}},
  addEventListener:(type,fn)=>{handler=fn},
  createElement:()=>({querySelector:()=>({addEventListener:(type,fn)=>{backed=fn}}),querySelectorAll:()=>[]})},
  esc:v=>String(v??"").replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;"),
  byId:id=>id==="modalCard"?card:{},closeModal(){},MODAL_RETURN_FOCUS:null};
vm.createContext(ctx);
vm.runInContext(app.slice(app.indexOf("function entityLink("), app.indexOf("function renderTable(")),ctx);
assert.match(ctx.entityCell({key:"code",label:"Код ЕКМТР"},{code:"001"},"001"), /data-entity="material"/);
assert.match(ctx.entityCell({key:"order",label:"Заказ"},{order:"77",site:"1400",unit:"WK"},"77"), /data-site="1400"/);
assert.match(ctx.entityCell({key:"art",label:"Артикул"},{art:"A-12"},"A-12"), /data-entity="part"/);
assert.equal(ctx.entityCell({key:"code",label:"Цена ДП",numeric:true},{code:"001"},"200 ₽"),"200 ₽");
assert.equal(ctx.entityCell({key:"code",label:""},{code:"001"},'<button class="cart-add">+</button>'),'<button class="cart-add">+</button>');
assert.equal(ctx.entityCell({key:"qty",label:"Потребность",numeric:true},{code:"001",qty:2},"2"),"2");
assert.match(ctx.entityCell({key:"availQty",label:"Доступно",numeric:true},{code:"001",availQty:2},"2"),/data-entity="stock"/);
assert.match(ctx.entityLink("part",'<x"'), /&lt;x&quot;/);
let opened;
ctx.openCodeDetail=id=>{opened=["material",id]};
ctx.openPartCard=id=>{opened=["part",id]};
ctx.openToroCard=(id,hint)=>{opened=["toro",id,hint]};
ctx.openPurchaseDocument=(type,id,code)=>{opened=[type,id,code]};
ctx.initEntityLinks();
let stopped=false;
handler({target:{closest:()=>({dataset:{entity:"toro",id:"77",site:"1400",unit:"WK"}})},preventDefault(){},stopImmediatePropagation(){stopped=true}});
assert.equal(opened[0],"toro");assert.equal(opened[2].site,"1400");assert.ok(stopped);
ctx.beginEntityCard("material",["001"]);
ctx.beginEntityCard("document",["450001",{code:"001"}]);
ctx.finishEntityCard();
backed();
assert.deepEqual(opened,["material","001"]);
assert.equal(ctx.MODAL_RETURN_FOCUS,rootFocus);
// Repeated routes are not added to the back stack.
ctx.beginEntityCard("material",["001"]);
assert.equal(vm.runInContext("CARD_TRAIL.length",ctx),1);
console.log("Typed navigation, independent actions, event isolation, back stack and root focus: OK");
