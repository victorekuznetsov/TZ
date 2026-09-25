import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const T = require("../lib/toro_rebuild.js");

// Заказы на ЕО-узлах техместа машины WK (ковш, ЭД…): машина — по техместу, узел — отдельным полем.
// 1) браузерный сбор метаданных выгрузки находит узлы по «Техническому месту» (как build_wk_nodes.py по БДО)
const H = ["Балансовая единица", "ЕО", "", "Техническое место", "", "Заказ", "", "Заказ Системный статус", "Заказ Пользовательский статус",
  "Заказ Вид заказа", "", "Заказ Вид работы ТОРО", "Заказ Базисный срок начала (дата)", "Заказ Завод, планирующий ТОРО",
  "Заказ Группа планирования ТОРО", "", "Компонент Заказа/Заявки", "", "Компонент Заказа Резерв./заявка"];
const row = (eo, eon, tm, tmn, order) => ["АО \"Полюс Магадан\"", eo, eon, tm, tmn, order, "текст", "ОТКР", "СГГС", "APP1", "", "КР", "2027-08-01",
  "7104", "7104/100", "Механика", "", "", "Немедленно"];
const meta = T.createMetaCollector("1400");
meta.pushRow(H);
meta.pushRow(row("Экскаватор электрический WK-20 №1", "100000084442", "Экскаватор электрический WK-20 №1", "05-KAR-UOGR-W201", "1"));
meta.pushRow(row("Ковш K1623.01.00", "100000090277", "Экскаватор электрический WK-20 №1", "05-KAR-UOGR-W201", "2"));
meta.pushRow(row("ЭД асинх YJ56E", "100000000001", "Привод", "05-KAR-UOGR-W201-ED01", "3"));
meta.pushRow(row("Бульдозер D375A №7", "100000084421", "Бульдозер D375A №7", "05-KAR-UOGR-BZ14", "4"));
meta.pushRow(row("Ковш", "100000000002", "Не присвоено", "#", "5"));
const m = meta.finish();
assert.deepEqual(m.nodes, {
  2: ["Экскаватор электрический WK-20 №1", "05-KAR-UOGR-W201", "Ковш K1623.01.00", "100000090277"],
  3: ["Экскаватор электрический WK-20 №1", "05-KAR-UOGR-W201-ED01", "ЭД асинх YJ56E", "100000000001"],
});

// 2) строки графика: заказ на узел идёт на машину, ЕО-узел — в поле node; без карты — не попадает
const d = { s: "1400", y: "2027", n: 3, o: ["1", "2", "4"], e: ["Экскаватор электрический WK-20 №1", "Ковш K1623.01.00", "Бульдозер D375A №7"],
  ei: [0, 1, 2], c: ["Зуб", "Зуб"], ci: [0, 1, 0], cek: ["111", "111"], w: ["КР"], wi: [0, 0, 0],
  p: [10, 20, 30], a: [0, 0, 0], up: [0, 0, 0], uf: [0, 0, 0], qp: [1, 2, 3], qf: [0, 0, 0], od: {}, orr: {} };
const withNodes = T.scheduleRowsFromDetail(d, m.nodes).rows;
assert.deepEqual(withNodes.map(r => [r.order, r.unit, r.node]), [["1", "Экскаватор электрический WK-20 №1", ""], ["2", "Экскаватор электрический WK-20 №1", "Ковш K1623.01.00"]]);
assert.equal(T.scheduleRowsFromDetail(d).rows.length, 1);

// 3) витрины: каждый заказ карты БДО в графике — на своей машине и с узлом
const N = JSON.parse(readFileSync(new URL("../data/wk_nodes.json", import.meta.url), "utf8")).orders;
const LJ = n => { const t = readFileSync(new URL(`../data/${n}.local.js`, import.meta.url), "utf8"); return JSON.parse(t.slice(t.indexOf("=", t.indexOf("__DATA__[")) + 1).trim().replace(/;$/, "")); };
const rows = LJ("schedule_manifest").shards.flatMap(n => T.decodeTable(LJ(n)));
const nodeRows = rows.filter(r => r.node);
assert.ok(nodeRows.length > 0);
nodeRows.forEach(r => { assert.ok(N[r.order], `узел без карты ${r.order}`); assert.equal(r.unit, N[r.order][0]); assert.equal(r.node, N[r.order][2]); });
console.log(`test_wk_nodes: узлов в выгрузке ${Object.keys(m.nodes).length}, строк графика на узлах ${nodeRows.length}, заказов ${new Set(nodeRows.map(r => r.order)).size} — OK`);
