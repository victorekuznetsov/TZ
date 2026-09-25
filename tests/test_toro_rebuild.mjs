import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const X = require("../lib/xlsx_stream.js");
const PM06 = require("../lib/pm06_pipeline.js");
const T = require("../lib/toro_rebuild.js");

// Пересборка витрин в браузере (lib/toro_rebuild.js) против Python.
//  A. Без загрузок — из текущих витрин — воспроизводит provision, control,
//     repairs, order_text и график, собранные build/*.py.
//  B. Настоящая выгрузка PM-06 (выборка tests/fixtures/pm06_sample.xlsx):
//     строки графика, статусы, копии, признак ППМ и тексты — как в витринах.
//  C. Если задан RAW_PM06_DIR с полными M06_*.xlsx — полный паритет по файлам.
const url = p => new URL(p, import.meta.url);
const L = n => JSON.parse(readFileSync(url(`../data/${n}.json`), "utf8"));
const LJ = n => { const t = readFileSync(url(`../data/${n}.local.js`), "utf8"); return JSON.parse(t.slice(t.indexOf("=", t.indexOf("__DATA__[")) + 1).trim().replace(/;$/, "")); };

let compared = 0;
function same(a, b, p, diffs) {
  if (diffs.length > 20) return;
  if (typeof a === "number" && typeof b === "number") {
    compared++;
    if (Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(b))) diffs.push(`${p}: ${a} ≠ ${b}`);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) { diffs.push(`${p}: длина ${a && a.length} ≠ ${b && b.length}`); return; }
    a.forEach((x, i) => same(x, b[i], `${p}[${i}]`, diffs));
    return;
  }
  if (a && b && typeof a === "object") { new Set([...Object.keys(a), ...Object.keys(b)]).forEach(k => same(a[k], b[k], `${p}.${k}`, diffs)); return; }
  compared++;
  if (a !== b) diffs.push(`${p}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
}
const assertSame = (a, b, label) => { const d = []; same(a, b, label, d); assert.deepEqual(d, [], d.join("\n")); };

const man = LJ("schedule_manifest");
const baseRows = man.shards.flatMap(n => T.decodeTable(LJ(n)));
const base = () => ({ scheduleRows: baseRows, scheduleMeta: man.meta, control: L("control"), provision: L("provision"), orderText: L("order_text") });
const ctx = { stockJson: L("stock"), ekmtrWk: L("ekmtr_wk"), fleet: L("fleet") };

// браузер читает .local.js — он обязан совпадать с .json
for (const n of ["provision", "control", "repairs", "order_text", "stock", "fleet"]) {
  assert.equal(JSON.stringify(LJ(n)), JSON.stringify(L(n)), `data/${n}.local.js устарел — запустите build/make_local_js.py`);
}

// ---------- A. пересборка из текущих витрин ----------
{
  const out = T.rebuild({ base: base(), uploads: [], ...ctx });
  assertSame(out.provision, L("provision"), "provision");
  assertSame(out.control, L("control"), "control");
  assertSame(out.repairs, L("repairs"), "repairs");
  assertSame(out.orderText, L("order_text"), "order_text");
  assertSame(out.schedule.manifest, man, "schedule_manifest");
  out.schedule.manifest.shards.forEach(n => assertSame(out.schedule.shards[n], LJ(n), n));
}

// ---------- округление и хеш как в Python ----------
assert.equal(T.pyRound(0.125, 2), 0.12);          // половина к чётному
assert.equal(T.pyRound(0.375, 2), 0.38);
assert.equal(T.pyRound(2.675, 2), 2.67);          // двоичное 2.67499…
assert.equal(T.pyRound(1.0005, 3), 1);
assert.equal(T.pyRound(-1.5, 0), -2);
assert.equal(T.sha256hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(T.hid("1400", "Экскаватор электрический WK-20 №1", "1102298470"), L("provision").orders.find(o => o.order === "1102298470").id);

// ---------- B. выборка настоящей выгрузки PM-06 ----------
async function parse(buf, file, site, year) {
  const zip = await X.openZip(new Blob([buf]));
  const router = PM06.createSiteRouter(site, year), meta = T.createMetaCollector(site);
  await X.streamSheet(zip, "PM-06", cells => { router.pushRow(cells); meta.pushRow(cells); }, () => {});
  return { file, site, year, details: router.finishAll().map(r => r.detail), meta: meta.finish() };
}
{
  const up = await parse(readFileSync(url("./fixtures/pm06_sample.xlsx")), "pm06_sample.xlsx", "1200", "2027");
  assert.deepEqual(up.details.map(d => d.s).sort(), ["1200", "2400"], "строки разведены по балансовой единице");
  const d2400 = up.details.find(d => d.s === "2400");
  const got = T.scheduleRowsFromDetail(d2400).rows;
  const orders = new Set(got.map(r => r.order));
  const want = baseRows.filter(r => r.site === "2400" && r.year === "2027" && orders.has(r.order));
  const strip = r => { const { sourceRows, ...rest } = r; return { ...rest, nRows: sourceRows.length }; };
  const key = r => [r.order, r.work, r.code, r.name].join("|");
  assertSame(got.map(strip).sort((a, b) => key(a) < key(b) ? -1 : 1), want.map(strip).sort((a, b) => key(a) < key(b) ? -1 : 1), "строки графика 2400_2027");
  assert.ok(got.length >= 20, "в выборке есть строки WK");

  // статусы и копии → те же стадии, коды и признак копии, что control.json
  const ctl = new Map(T.decodeTable(L("control")).filter(r => r.y === "2027").map(r => [r.order, r]));
  let checked = 0;
  up.meta.orders.forEach((v, o) => {
    const c = ctl.get(o);
    if (!c) return;
    checked++;
    const s = new Set(v.sys.split(/\s+/)), u = new Set(v.usr.split(/\s+/));
    const fact = got.filter(r => r.order === o).reduce((x, r) => x + (r.a || 0) + (r.uf || 0), 0);
    assert.equal(T.controlStage(T.phaseOf(v.sys), s, u, fact), c.stage, `стадия ${o}`);
    assert.equal(up.meta.originals.has(o) ? 1 : 0, c.copy, `копия ${o}`);
    assert.equal(v.kind, c.kind, `вид заказа ${o}`);
    const flags = c.flags ? c.flags.split(" ") : [];
    flags.forEach(f => assert.ok(s.has(f) || u.has(f), `статус ${f} заказа ${o}`));
  });
  assert.ok(checked >= 8, `сверено статусов: ${checked}`);
  assert.ok(up.meta.originals.has("1200434254"), "оригинал, перенесённый копией в «Развитие»");
  // признак ППМ — как meta.ppmFlags обеспеченности
  const flags = L("provision").meta.ppmFlags;
  let nppm = 0;
  Object.entries(flags).forEach(([k, v]) => {
    const [y, o, code] = k.split("|");
    if (y !== "2027" || !up.meta.orders.has(o)) return;
    nppm++;
    assert.equal({ 0: "onRelease", 1: "never" }[up.meta.comps.get(o)?.get(code)], v, `ППМ ${k}`);
  });
  up.meta.comps.forEach((codes, o) => { if (ctl.has(o)) codes.forEach((_, code) => assert.ok(`2027|${o}|${code}` in flags, `лишний признак ППМ ${o}/${code}`)); });
  assert.ok(nppm > 0, "в выборке есть признаки ППМ");
  // тексты заказов — как order_text.json
  const texts = L("order_text").text;
  up.meta.orders.forEach((v, o) => { if (texts[o]) assert.equal(v.text, texts[o], `текст ${o}`); });

  // пересборка с загрузкой: заменены только площадко-годы файла, заказы выборки — как в control.json
  const out = T.rebuild({ base: base(), uploads: [up], ...ctx });
  assert.deepEqual(out.report.replaced.sort(), ["1200_2027", "2400_2027"]);
  const keep = r => !(r.year === "2027" && (r.site === "2400" || r.site === "1200"));
  assertSame(out.scheduleRows.filter(keep).map(r => r.id), baseRows.filter(keep).map(r => r.id), "неизменные площадко-годы");
  const newCtl = new Map(T.decodeTable(out.control).filter(r => r.y === "2027").map(r => [r.order, r]));
  orders.forEach(o => assertSame(newCtl.get(o), ctl.get(o), `control ${o}`));
  assert.equal(out.control.rows.length, L("control").rows.length - [...ctl.values()].filter(r => r.plant === "2400" && !orders.has(r.order)).length, "в 2400_2027 остались только заказы файла");
  const pm = out.provision.meta;
  assert.ok(pm.sapSources.includes("браузер: pm06_sample.xlsx") && pm.rebuiltInBrowser, "источник пересборки отмечен");
}

// ---------- архив data/ для публикации: читается обычным zip-ридером ----------
{
  const U = require("../lib/upd_store.js");
  const ds = { order_text: L("order_text"), schedule_00: LJ("schedule_00") };
  const files = U.dataFiles(ds);
  assert.deepEqual(files.map(f => f.name), ["data/order_text.json", "data/order_text.local.js", "data/schedule_00.local.js"]);
  const zip = await X.openZip(new Blob([U.zip(files)]));
  assert.deepEqual(JSON.parse(await X.readText(zip, "data/order_text.json")), ds.order_text);
  const js = await X.readText(zip, "data/schedule_00.local.js");
  assert.ok(js.startsWith('window.__DATA__=window.__DATA__||{};window.__DATA__["schedule_00"]='));
  assert.deepEqual(JSON.parse(js.slice(js.indexOf("=", js.indexOf("__DATA__[")) + 1).trim().replace(/;$/, "")), ds.schedule_00);
  assert.equal(U.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
}

// ---------- C. полные выгрузки (по желанию) ----------
if (process.env.RAW_PM06_DIR) {
  const dir = process.env.RAW_PM06_DIR.replace(/\/?$/, "/");
  const uploads = [];
  for (const f of ["M06_1400_2027.xlsx", "M06_1200_2027.xlsx"]) {
    if (!existsSync(dir + f)) continue;
    const m = /(\d{4})_(\d{4})/.exec(f);
    uploads.push(await parse(readFileSync(dir + f), f, m[1], m[2]));
  }
  const out = T.rebuild({ base: base(), uploads, ...ctx });
  out.provision.meta.sapSources = L("provision").meta.sapSources;
  delete out.provision.meta.rebuiltInBrowser;
  assertSame(out.provision, L("provision"), "provision (полные файлы)");
  assertSame(out.control, L("control"), "control (полные файлы)");
  assertSame(out.repairs, L("repairs"), "repairs (полные файлы)");
  assertSame(out.orderText, L("order_text"), "order_text (полные файлы)");
  out.schedule.manifest.shards.forEach(n => assertSame(out.schedule.shards[n], LJ(n), n));
  console.log(`полные выгрузки: ${uploads.map(u => u.file).join(", ")} — витрины совпали`);
}
console.log(`test_toro_rebuild: сверено ${compared} значений — OK`);
