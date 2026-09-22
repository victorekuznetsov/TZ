import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const src=fs.readFileSync(new URL('../schedule.js',import.meta.url),'utf8')+';globalThis.h={sDecode,sRows,sOrders,sProvisionLines,sProvidedQty,set:(d,f)=>{S=d;SF={...SF,...f}}};';
const ctx={console,G:{site:'',model:'',unit:'',order:'',ekmtr:'',part:''},PROVISION_ORDER_BY_ID:new Map(),sessionStorage:{getItem:()=>null,setItem:()=>{}},normText:x=>String(x||'').toLowerCase(),esc:String,Number,Date,Map,Set};vm.createContext(ctx);vm.runInContext(src,ctx);
const d=ctx.h.sDecode({columns:['site','p'],dictionaries:{site:['1100']},rows:[[0,4]]});assert.equal(d[0].site,'1100');assert.equal(d[0].p,4);
const rows=[{orderId:'1',site:'1100',unit:'WK-20 №1',unitId:'u1',year:'2025',work:'ТО',order:'7',code:'A',name:'Болт',start:'2025-01-01',end:'2025-01-03',badDate:false,p:10,a:5,up:null,uf:null,hasFact:true},{orderId:'1',site:'1100',unit:'WK-20 №1',unitId:'u1',year:'2025',work:'ТО',order:'7',code:'B',name:'Гайка',start:'2025-01-01',end:'2025-01-03',badDate:false,p:20,a:0,up:null,uf:null,hasFact:false}];
ctx.PROVISION_ORDER_BY_ID.set('1',{id:'1',lines:[
  {code:'A',work:'ТО',fromStock:1,fromBuy:2},
  {code:'A',work:'Другой',fromStock:9,fromBuy:9},
  {code:'B',work:'Иное',fromStock:0,fromBuy:4},
]});
assert.equal(ctx.h.sProvidedQty(rows[0]),3);
assert.equal(ctx.h.sProvidedQty(rows[1]),4);
assert.equal(ctx.h.sProvidedQty({...rows[0],code:'C'}),null);
ctx.PROVISION_ORDER_BY_ID.set('2',{id:'2',lines:[
  {code:'A',work:'Первый',fromStock:1,fromBuy:0},
  {code:'A',work:'Второй',fromStock:2,fromBuy:0},
]});
assert.equal(ctx.h.sProvidedQty({...rows[0],orderId:'2',work:'Нет совпадения'}),null);
ctx.h.set({rows,meta:{sites:{1100:'Площадка'}}},{site:'1100',unit:'',year:'',work:'',fact:'',q:'болт',from:'',to:''});assert.equal(ctx.h.sRows().length,1);const o=ctx.h.sOrders(rows)[0];assert.equal(o.p,30);assert.equal(o.a,5);assert.equal(o.lines.length,2);console.log('Schedule helpers: OK');
