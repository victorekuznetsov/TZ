/* Обновлённые витрины без Python и без замены файлов руками.

   1. Хранилище браузера (IndexedDB): после «Применить» во вкладке
      «Обновление данных» пересобранные витрины сохраняются под именами
      файлов data/<имя>.local.js. При следующем открытии отчёта загрузчик
      берёт их отсюда вместо файлов — обновление переживает перезагрузку.
      Хранилище своё у каждого браузера и компьютера.
   2. Архив для публикации: те же витрины zip-архивом с папкой data/ —
      распаковать поверх папки отчёта (или залить в репозиторий), и
      обновление увидят все.

   Модуль без DOM, zip проверяется тестом в node. */
const UpdStore = (() => {
  "use strict";
  const DB = "wkcrm-data-updates", STORE = "data", INFO = "__info";

  function open() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("хранилище браузера недоступно")); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("хранилище браузера недоступно"));
    });
  }
  const done = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error("не удалось записать в хранилище браузера"));
  });

  /* Все сохранённые витрины: { data: Map(имя → объект), info } */
  async function loadAll() {
    const db = await open();
    try {
      const tx = db.transaction(STORE, "readonly"), st = tx.objectStore(STORE);
      const [keys, values] = await Promise.all([
        new Promise((res, rej) => { const r = st.getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
        new Promise((res, rej) => { const r = st.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
      ]);
      const data = new Map();
      let info = null;
      keys.forEach((k, i) => { if (k === INFO) info = values[i]; else if (!String(k).startsWith("__")) data.set(k, values[i]); });
      return { data, info };
    } finally { db.close(); }
  }

  /* Сохранить витрины (имя → объект), удалить устаревшие имена, записать сведения. */
  async function save(entries, remove, info) {
    const db = await open();
    try {
      const tx = db.transaction(STORE, "readwrite"), st = tx.objectStore(STORE);
      (remove || []).forEach(k => st.delete(k));
      Object.entries(entries).forEach(([k, v]) => st.put(v, k));
      if (info) st.put(info, INFO);
      await done(tx);
    } finally { db.close(); }
  }

  async function clear() {
    const db = await open();
    try { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).clear(); await done(tx); }
    finally { db.close(); }
  }

  /* ---------- папка отчёта на диске (Chrome / Edge) ---------- */
  const DIR = "__dir";
  async function getKey(key) {
    const db = await open();
    try {
      return await new Promise((res, rej) => { const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    } finally { db.close(); }
  }
  async function putKey(key, value) {
    const db = await open();
    try { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put(value, key); await done(tx); }
    finally { db.close(); }
  }
  const canWriteFolder = () => typeof showDirectoryPicker === "function";
  /* Папка data/ отчёта: выбранная ранее (с повторным разрешением) или новая.
     Можно выбрать и саму папку отчёта (где index.html), и её data/. */
  async function dataFolder(pickNew) {
    let root = pickNew ? null : await getKey(DIR).catch(() => null);
    if (root) {
      const opts = { mode: "readwrite" };
      if ((await root.queryPermission(opts)) !== "granted" && (await root.requestPermission(opts)) !== "granted") root = null;
    }
    if (!root) root = await showDirectoryPicker({ id: "wkcrm-report", mode: "readwrite" });
    let data = null;
    try { data = await root.getDirectoryHandle("data"); } catch (e) { /* выбрана сама data/ */ }
    if (!data) {
      try { await root.getFileHandle("provision.local.js"); data = root; }
      catch (e) { throw new Error(`в папке «${root.name}» нет data/ с витринами — выберите папку отчёта (где лежит index.html)`); }
    }
    await putKey(DIR, root).catch(() => {});
    return { root, data };
  }
  /* записать файлы витрин (имена data/…) в папку data/ отчёта */
  async function writeFolder(files, pickNew = false) {
    const { root, data } = await dataFolder(pickNew);
    let n = 0, bytes = 0;
    for (const f of files) {
      const name = f.name.replace(/^data\//, "");
      if (name.includes("/")) continue;
      const h = await data.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(f.text);
      await w.close();
      n++; bytes += f.text.length;
    }
    return { folder: root.name, files: n, bytes };
  }

  /* ---------- файлы витрин ---------- */
  const json = obj => JSON.stringify(obj);
  const localJs = (key, obj) => "window.__DATA__=window.__DATA__||{};window.__DATA__[\"" + key + "\"]=" +
    json(obj).replace(/<\//g, "<\\/") + ";\n";

  /* ---------- zip (без сжатия: витрины и так читаются браузером как есть) ---------- */
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  /* files: [{ name: "data/provision.json", text }] → Uint8Array архива */
  function zip(files, when = new Date()) {
    const enc = new TextEncoder();
    const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
    const dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = typeof f.text === "string" ? enc.encode(f.text) : f.text;
      const crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); // UTF-8 имена
      h.setUint16(8, 0, true); h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(e.buffer)];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let p = 0;
    all.forEach(a => { out.set(a, p); p += a.length; });
    return out;
  }

  /* Витрины (имя файла → объект) → файлы архива: .json и .local.js; у графика —
     только .local.js, как у build/build_schedule.py. */
  function dataFiles(datasets) {
    const files = [];
    Object.keys(datasets).sort().forEach(name => {
      if (!/^schedule_/.test(name)) files.push({ name: `data/${name}.json`, text: json(datasets[name]) });
      files.push({ name: `data/${name}.local.js`, text: localJs(name, datasets[name]) });
    });
    return files;
  }

  return { loadAll, save, clear, zip, crc32, dataFiles, localJs, canWriteFolder, writeFolder };
})();

if (typeof module !== "undefined" && module.exports) module.exports = UpdStore;
