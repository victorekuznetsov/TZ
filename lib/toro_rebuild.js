/* Пересборка витрин ТОиР в браузере — без Python.

   Загруженные выгрузки PM-06 (M06_{площадка}_{год}.xlsx) заменяют свои
   площадко-годы, остальные берутся из текущих витрин — и из этого заново
   собираются все зависимые витрины по тем же правилам, что Python:

     график план-факт  (schedule_*.local.js)  — build/build_schedule.py
     статусы, копии, ППМ, тексты заказов      — TOPO pm06_meta/build_pm06_meta.py,
                                                build/build_order_text.py
     контроль отделов  (control.json)         — build/build_control.py
     обеспеченность    (provision.json)       — build/build_provision.py
     свод ремонтов     (repairs.json)         — build/build_repairs.py

   База для неизменных площадко-лет — строки графика (то же зерно, что у
   расчёта обеспеченности: площадка × год × ЕО × заказ × вид работ ×
   материал), статусы — из control.json, признаки ППМ, итоги контура и
   источники статусов — из provision.json (meta.ppmFlags, meta.contour,
   meta.sapSources). Паритет с Python проверяет tests/test_toro_rebuild.mjs.

   Модуль без DOM: работает и в браузере, и в node. */
const ToroRebuild = (() => {
  "use strict";

  const WU = typeof WkUpdate !== "undefined" ? WkUpdate
    : (typeof require === "function" ? require("./wk_update_pipeline.js") : null);
  const WK_RE = /WK-?\d/i;
  const MODEL_RE = /WK-?(\d+C?)/i;
  const CONTROL_YEARS = ["2024", "2025", "2026", "2027"];
  const PROV_YEARS = ["2026", "2027"];
  const NO_WORK = "Вид работ не указан";
  const BE_SITE = {
    "АО \"Полюс Красноярск\"": "1100", "АО \"Полюс Вернинское\"": "1200",
    "АО \"Полюс Алдан\"": "1300", "АО \"Полюс Магадан\"": "1400",
    "ООО \"Полюс Сухой Лог\"": "2400",
  };
  const N = v => (typeof v === "number" && isFinite(v) ? v : 0);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);          // как сравнение строк в Python
  const sortStr = a => a.sort(cmp);

  /* ---------- округление как round() в Python: точное десятичное, половина к чётному ---------- */
  function pyRound(x, nd) {
    if (typeof x !== "number" || !isFinite(x) || x === 0) return x;
    const neg = x < 0, s = Math.abs(x).toFixed(Math.min(100, nd + 30));
    const [ip, fp = ""] = s.split(".");
    let keep = fp.slice(0, nd);
    const rest = fp.slice(nd);
    let up = false;
    if (rest[0] > "5") up = true;
    else if (rest[0] === "5") up = /[1-9]/.test(rest.slice(1)) || ((+((ip + keep).slice(-1))) % 2 === 1);
    let digits = ip + keep;
    if (up) {
      const arr = digits.split("");
      let i = arr.length - 1;
      while (i >= 0) { if (arr[i] === "9") { arr[i] = "0"; i--; } else { arr[i] = String(+arr[i] + 1); break; } }
      if (i < 0) arr.unshift("1");
      digits = arr.join("");
    }
    const v = Number(nd ? digits.slice(0, digits.length - nd) + "." + digits.slice(digits.length - nd) : digits);
    return neg ? -v : v;
  }
  const r2 = v => pyRound(v, 2), r3 = v => pyRound(v, 3), r1 = v => pyRound(v, 1);

  /* ---------- sha256 (идентификаторы строк и заказов — как hashlib в Python) ---------- */
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const ENC = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  function sha256hex(str) {
    const bytes = ENC.encode(str), len = bytes.length;
    const words = new Uint32Array((((len + 9) + 63) >> 6) << 4);
    for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << (24 - (i & 3) * 8);
    words[len >> 2] |= 0x80 << (24 - (len & 3) * 8);
    words[words.length - 1] = len * 8;
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rot = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < words.length; off += 16) {
      for (let t = 0; t < 16; t++) w[t] = words[off + t];
      for (let t = 16; t < 64; t++) {
        const s0 = rot(w[t - 15], 7) ^ rot(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rot(w[t - 2], 17) ^ rot(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let t = 0; t < 64; t++) {
        const S1 = rot(e, 6) ^ rot(e, 11) ^ rot(e, 25), ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K256[t] + w[t]) | 0;
        const S0 = rot(a, 2) ^ rot(a, 13) ^ rot(a, 22), mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    return [...h].map(x => x.toString(16).padStart(8, "0")).join("");
  }
  // json.dumps(tuple, ensure_ascii=False) — разделитель ", ", кириллица как есть
  const pyJsonList = arr => "[" + arr.map(x => JSON.stringify(x)).join(", ") + "]";
  const hid = (...v) => sha256hex(pyJsonList(v)).slice(0, 18);

  /* ---------- даты ---------- */
  function isoDate(v) {                     // date.fromisoformat(v).isoformat()
    if (!v || typeof v !== "string") return null;
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) || /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  const toDate = s => new Date(s.slice(0, 10) + "T00:00:00Z");
  const iso = d => d.toISOString().slice(0, 10);
  const dayMs = 86400000;

  /* ======================================================================
     1. Строки графика из детализации PM-06 (формат TOPO data/*.json) —
        build/build_schedule.py
     ====================================================================== */
  function dictVal(d, a, ai, i) {
    const idx = d[ai] || [], arr = d[a] || [];
    const j = i < idx.length ? idx[i] : null;
    return Number.isInteger(j) && j < arr.length ? arr[j] : "";
  }
  const NUM = ["p", "a", "up", "uf", "qp", "qf"];
  function scheduleRowsFromDetail(d) {
    const rows = new Map();
    let wk = 0;
    const s = String(d.s), y = String(d.y), file = `${s}_${y}.json`;
    for (let i = 0; i < d.n; i++) {
      const unit = dictVal(d, "e", "ei", i);
      if (!WK_RE.test(unit)) continue;
      wk++;
      const order = String(d.o[i]);
      const work = dictVal(d, "w", "wi", i) || NO_WORK;
      const name = dictVal(d, "c", "ci", i);
      const ci = d.ci[i], cek = d.cek || [];
      const code = ci < cek.length ? String(cek[ci] || "") : "";
      const key = JSON.stringify([s, y, unit, order, work, code, name]);
      let r = rows.get(key);
      if (!r) {
        const od = (d.od || {})[order] || [null, null];
        const start = isoDate(od[0]), end = od.length > 1 ? isoDate(od[1]) : null;
        const m = MODEL_RE.exec(unit);
        r = {
          id: hid(s, y, unit, order, work, code, name), orderId: hid(s, unit, order), unitId: hid(s, unit),
          site: s, year: y, unit, model: "WK-" + (m ? m[1].toUpperCase() : "?"), order, work, code, name, start, end,
          badDate: !!((od[0] && !start) || (od.length > 1 && od[1] && !end) || (start && end && end < start)),
          reason: (d.orr || {})[order] || "", source: file, sourceRows: [],
          makers: new Set(), centers: new Set(), needDates: new Set(), approvalDates: new Set(), method: "",
          p: null, a: null, up: null, uf: null, qp: null, qf: null,
        };
        rows.set(key, r);
      }
      r.sourceRows.push(i + 1);
      const u = (d.u || [])[i];
      if (u) r.method = u;
      for (const k of NUM) {
        const x = (d[k] || [])[i];
        if (typeof x === "number") r[k] = (r[k] || 0) + x;
      }
      for (const [field, a, ai] of [["makers", "mf", "mfi"], ["centers", "wc", "wci"], ["needDates", "nd", "ndi"], ["approvalDates", "ad", "adi"]]) {
        const x = dictVal(d, a, ai, i);
        if (x) r[field].add(x);
      }
    }
    const out = [...rows.values()];
    out.forEach(r => {
      for (const k of ["makers", "centers", "needDates", "approvalDates"]) r[k] = sortStr([...r[k]]);
      r.hasFact = ["a", "uf", "qf"].some(k => (r[k] || 0) !== 0);
      r.remainingQty = r.qp != null && r.qf != null ? Math.max(r.qp - r.qf, 0) : null;
    });
    return { rows: out, source: { file, sha256: "", rows: d.n, wkRows: wk } };
  }

  // итоги всего контура площадко-года — как meta.contour в build_provision.py
  function contourOf(d) {
    const t = {};
    for (const k of ["p", "a", "up", "uf"]) t[k] = r2((d[k] || []).reduce((s, x) => s + N(x), 0));
    return t;
  }

  function scheduleShards(rows, meta) {
    const cols = Object.keys(rows[0]);
    const sf = cols.filter(k => typeof rows[0][k] === "string");
    const shards = {}, names = [];
    for (let n = 0, start = 0; start < rows.length; n++, start += 1500) {
      const subset = rows.slice(start, start + 1500);
      const sd = {}, si = {};
      sf.forEach(k => { sd[k] = sortStr([...new Set(subset.map(r => r[k]))]); si[k] = new Map(sd[k].map((v, i) => [v, i])); });
      const name = "schedule_" + String(n).padStart(2, "0");
      names.push(name);
      shards[name] = { columns: cols, dictionaries: sd, rows: subset.map(r => cols.map(k => (k in si ? si[k].get(r[k]) : r[k]))) };
    }
    return { manifest: { meta, shards: names }, shards };
  }

  /* ======================================================================
     2. Статусы, копии, признак ППМ и текст заказа — build_pm06_meta.py
        (extract + migration_originals) и build_order_text.py
     ====================================================================== */
  const PPM_FLAG = v => {
    const t = String(v == null ? "" : v).trim().toLowerCase();
    if (t.startsWith("никогда")) return 1;
    if (t.startsWith("начиная с деблок")) return 0;
    return null;
  };
  function phaseOf(sys) {
    const s = new Set(String(sys || "").split(/\s+/).filter(Boolean));
    if (!s.size || (s.size === 1 && s.has("#"))) return 0;
    if (s.has("ЗАКР")) return 4;
    if (s.has("ТЗКР")) return 3;
    if (s.has("ДЕБЛ") || s.has("ЧДЕБ")) return 2;
    return 1;
  }
  /* Один файл PM-06 целиком (все балансовые единицы в нём): копии ищутся по
     файлу, как в extract/assemble; площадка заказа — по балансовой единице. */
  function createMetaCollector(site0) {
    let C = null, scanned = 0;
    const orders = new Map(), comps = new Map();
    const str = v => (v == null ? "" : String(v));
    function header(cells) {
      const H = {};
      cells.forEach((v, j) => { if (typeof v === "string" && v.trim()) H[v.trim()] = j; });   // последнее вхождение — как dict в Python
      const col = (n, off = 0) => (n in H ? H[n] + off : null);
      C = {
        o: col("Заказ"), text: col("Заказ", 1), be: col("Балансовая единица"), eo: col("ЕО"), eon: col("ЕО", 1),
        sys: col("Заказ Системный статус"), usr: col("Заказ Пользовательский статус"),
        kind: col("Заказ Вид заказа"), kindt: col("Заказ Вид заказа", 1), w: col("Заказ Вид работы ТОРО"),
        bs: col("Заказ Базисный срок начала (дата)"), pp: col("Заказ Завод, планирующий ТОРО"),
        pg: col("Заказ Группа планирования ТОРО"), pgt: col("Заказ Группа планирования ТОРО", 1),
        ek: col("Компонент Заказа/Заявки", 1), rz: col("Компонент Заказа Резерв./заявка"),
      };
    }
    const get = (cells, k) => (C[k] == null ? null : cells[C[k]]);
    function pushRow(cells) {
      if (!C) {
        if (++scanned > 40) throw new Error("Не найдена строка заголовка с колонкой «Заказ» — это не выгрузка PM-06");
        if (cells && cells.some(v => typeof v === "string" && v.trim() === "Заказ")) header(cells);
        return;
      }
      if (!cells || !cells.length) return;
      const o = str(get(cells, "o")).trim();
      if (!o || o === "#") return;
      let g = orders.get(o);
      if (!g) {
        const be = str(get(cells, "be")).trim();
        g = {
          site: BE_SITE[be] || site0, sys: (str(get(cells, "sys")) || "#").trim(), usr: (str(get(cells, "usr")) || "#").trim(),
          kind: str(get(cells, "kind")), kindText: str(get(cells, "kindt")), w: str(get(cells, "w")),
          bs: str(get(cells, "bs")), pp: str(get(cells, "pp")), eon: str(get(cells, "eon")), text: "",
          pg: str(get(cells, "pg")).trim(), pgText: str(get(cells, "pgt")).trim(),
        };
        orders.set(o, g);
      }
      if (!g.text) {
        const t = str(get(cells, "text")).trim();
        if (t && t !== "#") g.text = t;
      }
      const idx = PPM_FLAG(get(cells, "rz")), code = str(get(cells, "ek"));
      if (idx !== null && code && code !== "#") {
        if (!comps.has(o)) comps.set(o, new Map());
        const m = comps.get(o), prev = m.get(code);
        m.set(code, prev == null ? idx : Math.max(prev, idx));   // «Никогда» хуже «Начиная с деблок.»
      }
    }
    function finish() {
      if (!C) throw new Error("В файле не найдена строка заголовка PM-06");
      // оригиналы БЕ, перенесённые копией в «Развитие»: та же ЕО, вид работ, базисная дата
      const groups = new Map();
      orders.forEach((v, o) => {
        if (v.eon && v.eon !== "#" && v.bs && v.pp) {
          const k = JSON.stringify([v.eon, v.w, v.bs]);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(o);
        }
      });
      const originals = new Set();
      groups.forEach(lst => {
        const rz = lst.filter(o => orders.get(o).pp.includes("Развити"));
        if (rz.length && lst.length > rz.length) lst.filter(o => !rz.includes(o)).forEach(o => originals.add(o));
      });
      return { orders, comps, originals };
    }
    return { pushRow, finish };
  }

  /* ======================================================================
     3. Контроль отделов — build/build_control.py
     ====================================================================== */
  const USR_KEEP = ["ПЛАН", "СГПЛ", "ССПЛ", "СГГС", "ГОД", "ПТОГ", "ГИП", "УТВГ", "УТВП", "МЕС", "ПТОМ", "УТВМ", "НЕД", "УТВН",
    "ТКБЕ", "ТРКБ", "КОРБ", "ОТКБ", "СГЛБ", "ПЗТГ", "ПЗТМ", "МТРЦ", "МТРН", "СРОЧ", "НВСО", "ТОПЗ", "СОПЗ",
    "ПРНТ", "НПРН", "ФХСМ", "ПРСЗ", "НПСЗ", "ВСБЕ", "КРМТ", "ПЛЗК"];
  const SYS_KEEP = ["ОТКР", "ДЕБЛ", "ТЗКР", "ЗАКР", "ПДТВ", "ЧПДТ"];
  function controlStage(ph, s, u, fact) {
    if (ph === 0) return "noOrder";
    if (ph === 4) return "closed";
    if (ph === 3) return u.has("ВСБЕ") ? "billed" : u.has("ПРСЗ") ? "accepted" : "techClosed";
    if (ph === 2) {
      if (u.has("ФХСМ")) return "factDone";
      if (fact > 0 || s.has("ПДТВ") || s.has("ЧПДТ") || u.has("ПРНТ")) return "inWork";
      return "released";
    }
    return u.has("СГГС") ? "approved" : "approving";
  }
  const STAGE_PHASE = { noOrder: 0, approving: 1, approved: 1, released: 2, inWork: 2, factDone: 2,
    techClosed: 3, accepted: 3, billed: 3, rejected: 3, closed: 4 };

  function decodeTable(t) {
    const cols = t.columns, dic = t.dictionaries || {};
    return t.rows.map(v => { const r = {}; cols.forEach((k, i) => { r[k] = dic[k] ? dic[k][v[i]] : v[i]; }); return r; });
  }
  /* статусы неизменных площадко-лет — из control.json: фаза по стадии, коды —
     из сохранённого набора (в нём все коды, от которых зависят стадии) */
  function statusesFromControl(control) {
    const out = new Map();
    decodeTable(control).forEach(r => {
      if (r.stage === "unknown") return;
      const codes = (r.flags || "").split(" ").filter(Boolean);
      out.set(r.y + "|" + r.order, {
        phase: STAGE_PHASE[r.stage], copy: !!r.copy, kind: r.kind || "", kindText: r.kindText || "", pg: r.pg || "",
        sys: new Set(codes.filter(c => SYS_KEEP.includes(c))), usr: new Set(codes.filter(c => !SYS_KEEP.includes(c))),
      });
    });
    return out;
  }

  function buildControl(scheduleRows, status, fleet, asOf, baseMeta, pgNames) {
    const unitSite = new Map(((fleet && fleet.units) || []).map(u => [u.name, u.site]));
    const acc = new Map();
    for (const r of scheduleRows) {
      if (!CONTROL_YEARS.includes(r.year)) continue;
      const key = r.year + "\u0000" + r.order;
      let o = acc.get(key);
      if (!o) {
        o = { y: r.year, order: r.order, unit: r.unit, model: r.model, site: unitSite.has(r.unit) ? unitSite.get(r.unit) : r.site,
              plant: r.site, reason: r.reason || "", p: 0, a: 0, up: 0, uf: 0, starts: [], ends: [], works: new Map(), lines: 0, bad: 0 };
        acc.set(key, o);
      }
      for (const k of ["p", "a", "up", "uf"]) o[k] += r[k] || 0;
      if (r.start && !r.badDate) o.starts.push(r.start);
      if (r.end && !r.badDate) o.ends.push(r.end);
      o.works.set(r.work, (o.works.get(r.work) || 0) + (r.p || 0) + (r.up || 0));
      o.lines += 1;
      o.bad += r.badDate ? 1 : 0;
    }
    let missing = 0;
    const out = [...acc.values()].sort((a, b) => cmp(a.y, b.y) || cmp(a.order, b.order)).map(o => {
      const st = status.get(o.y + "|" + o.order);
      if (!st) missing++;
      const fact = o.a + o.uf;
      const s = st ? st.sys : new Set(), u = st ? st.usr : new Set();
      let work = "", best = -Infinity;
      o.works.forEach((v, k) => { if (v > best) { best = v; work = k; } });      // most_common: при равенстве — первый
      return {
        y: o.y, order: o.order, unit: o.unit, model: o.model, site: o.site, plant: o.plant,
        kind: st ? st.kind : "", kindText: st ? st.kindText : "", reason: o.reason, work,
        start: o.starts.length ? o.starts.reduce((a, b) => (b < a ? b : a)) : "",
        end: o.ends.length ? o.ends.reduce((a, b) => (b > a ? b : a)) : "",
        p: r2(o.p), a: r2(o.a), up: r2(o.up), uf: r2(o.uf),
        stage: st ? controlStage(st.phase, s, u, fact) : "unknown", copy: st && st.copy ? 1 : 0,
        flags: [...SYS_KEEP.filter(c => s.has(c)), ...USR_KEEP.filter(c => u.has(c))].join(" "),
        lines: o.lines, badDates: o.bad, pg: st ? st.pg || "" : "",
      };
    });
    const cols = ["y", "order", "unit", "model", "site", "plant", "kind", "kindText", "reason", "work", "start", "end",
      "p", "a", "up", "uf", "stage", "copy", "flags", "lines", "badDates", "pg"];
    const dictCols = ["y", "unit", "model", "site", "plant", "kind", "kindText", "reason", "work", "stage", "flags", "pg"];
    const dicts = {}, idx = {};
    dictCols.forEach(c => { dicts[c] = sortStr([...new Set(out.map(r => r[c]))]); idx[c] = new Map(dicts[c].map((v, i) => [v, i])); });
    const pgText = Object.assign({}, (baseMeta && baseMeta.planningGroups) || {}, pgNames || {});
    const meta = Object.assign({}, baseMeta || {}, {
      asOf, years: CONTROL_YEARS.slice(), orders: out.length, missingStatus: missing,
      usrCodes: USR_KEEP, sysCodes: SYS_KEEP,
      planningGroups: Object.fromEntries(sortStr([...new Set(out.map(r => r.pg))].filter(Boolean)).map(k => [k, pgText[k] || ""])),
    });
    return { meta, columns: cols, dictionaries: dicts, rows: out.map(r => cols.map(c => (c in idx ? idx[c].get(r[c]) : r[c]))) };
  }

  /* ======================================================================
     4. Обеспеченность — build/build_provision.py
     ====================================================================== */
  const KEYS = ["fromStock", "fromBuy", "late", "undated", "gap"];
  const TKEYS = [...KEYS, "transferPotential"];
  const PPM_KEYS = ["immediate", "onRelease", "never"];
  const PPM_BY_FLAG = { 0: "onRelease", 1: "never" };
  const STAGES = [
    ["approving", "Открыт, на согласовании"], ["approved", "Открыт, согласован (СГГС)"],
    ["released", "Деблокирован: ни факта, ни подтверждений"], ["inWork", "В работе: есть факт, подтверждения или ПРНТ"],
    ["factDone", "Факт проведён полностью (ФХСМ)"], ["techClosed", "Технически закрыт (ТЗКР)"],
    ["rejected", "ТЗКР, не принят службой заказчика (НПСЗ)"], ["accepted", "ТЗКР, принят службой заказчика (ПРСЗ)"],
    ["billed", "ТЗКР, выставлен в БЕ (ВСБЕ)"], ["closed", "Закрыт коммерчески (ЗАКР)"],
    ["unknown", "Нет в выгрузке статусов"],
  ];
  function orderStage(st, fact = 0) {
    if (!st) return "unknown";
    const ph = st.phase, usr = st.usr, sys = st.sys;
    if (ph === 0) return "noOrder";
    if (ph === 4) return "closed";
    if (ph === 3) return usr.has("ВСБЕ") ? "billed" : usr.has("ПРСЗ") ? "accepted" : usr.has("НПСЗ") ? "rejected" : "techClosed";
    if (ph === 2) {
      if (usr.has("ФХСМ")) return "factDone";
      if (usr.has("ПРНТ") || sys.has("ПДТВ") || sys.has("ЧПДТ") || fact > 0) return "inWork";
      return "released";
    }
    return usr.has("СГГС") ? "approved" : "approving";
  }
  const val = (r, k) => (r.qty ? r.value * (r[k] / r.qty) : 0);
  function totals(rows) {
    const t = { value: r2(rows.reduce((s, r) => s + r.value, 0)), qty: r3(rows.reduce((s, r) => s + r.qty, 0)), lines: rows.length };
    for (const k of TKEYS) {
      t[k] = r2(rows.reduce((s, r) => s + (k in r ? val(r, k) : 0), 0));
      t[k + "Qty"] = r3(rows.reduce((s, r) => s + (r[k] || 0), 0));
    }
    return t;
  }
  function cut(rows, keyfn, sortByValue = false, limit = null, keyStr = String) {
    const g = new Map();
    rows.forEach(r => { const k = keyfn(r), ks = JSON.stringify(k); if (!g.has(ks)) g.set(ks, [k, []]); g.get(ks)[1].push(r); });
    const out = [...g.values()].map(([key, v]) => ({ key, ...totals(v) }));
    out.sort(sortByValue ? (a, b) => b.value - a.value : (a, b) => cmp(keyStr(a.key), keyStr(b.key)));
    return limit ? out.slice(0, limit) : out;
  }
  function yearStatus(contour) {
    const agg = {};
    Object.keys(contour).sort(cmp).forEach(key => {
      const y = key.split("_")[1], t = contour[key];
      agg[y] = agg[y] || { p: 0, a: 0, up: 0, uf: 0 };
      for (const k of ["p", "a", "up", "uf"]) agg[y][k] += t[k];
    });
    const years = Object.keys(agg).sort(cmp);
    const withFact = years.filter(y => agg[y].a + agg[y].uf > 0);
    const frontier = withFact.length ? withFact[withFact.length - 1] : null;
    const out = {};
    years.forEach(y => {
      const c = agg[y], plan = c.p + c.up, share = plan ? (c.a + c.uf) / plan : 0;
      const st = c.a === 0 && c.uf === 0 ? "план" : (y === frontier && share < 0.75 ? "открыт" : "закрыт");
      out[y] = { status: st, planValue: r2(plan), factValue: r2(c.a + c.uf), factShare: pyRound(share, 4) };
    });
    return out;
  }
  function buildOrders(rows, names) {
    const grouped = new Map();
    rows.forEach(r => {
      const k = JSON.stringify([r.site, r.unit, String(r.order)]);
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(r);
    });
    const out = [];
    grouped.forEach(lines => {
      const t = totals(lines);
      const onTime = t.fromStock + t.fromBuy;
      let status = t.gapQty + t.lateQty + t.undatedQty <= 1e-9 ? "full" : (t.fromStockQty + t.fromBuyQty <= 1e-9 ? "none" : "partial");
      const detail = lines.slice().sort((a, b) => cmp(a.date || "9999", b.date || "9999") || cmp(a.work, b.work) || cmp(a.code, b.code)).map(r => {
        const row = {
          date: r.date, work: r.work, code: r.code, name: names[r.code] || r.mat,
          qty: r3(r.qty), value: r2(r.value), planQty: r3(r.planQty || 0), factQty: r3(r.factQty || 0),
          method: r.method || "", usoPlan: r2(r.usoPlan || 0), usoFact: r2(r.usoFact || 0), ppm: r.ppm || "immediate",
        };
        KEYS.forEach(k => { row[k] = r3(r[k]); });
        KEYS.forEach(k => { row[k + "Value"] = r2(val(r, k)); });
        row.transferPotential = r3(r.transferPotential || 0);
        row.transferPotentialValue = r2("transferPotential" in r ? val(r, "transferPotential") : 0);
        row.transferFrom = Object.fromEntries(Object.entries(r.transferFrom || {}).map(([st, q]) => [st, r3(q)]));
        return row;
      });
      const site = lines[0].site, unit = lines[0].unit, order = String(lines[0].order);
      const years = sortStr([...new Set(lines.map(r => String(r.year)))]);
      const dates = sortStr(lines.map(r => r.date).filter(Boolean));
      const mm = MODEL_RE.exec(unit || "");
      const methods = sortStr([...new Set(lines.map(r => r.method).filter(Boolean))]);
      const planValue = r2(lines.reduce((s, r) => s + (r.planValue || 0), 0));
      const factValue = r2(lines.reduce((s, r) => s + (r.factValue || 0), 0));
      const closed = t.qty <= 1e-9 && (planValue > 0 || factValue > 0);
      if (closed) status = "closed";
      const ppmValue = {};
      PPM_KEYS.forEach(k => { ppmValue[k] = r2(lines.filter(r => (r.ppm || "immediate") === k).reduce((s, r) => s + r.value, 0)); });
      out.push({
        id: hid(site, unit, order), site, unit, model: mm ? "WK-" + mm[1].toUpperCase() : "",
        order, years, date: dates[0] || "", kind: (lines.find(r => r.kind) || {}).kind || "",
        method: methods.length === 1 ? methods[0] : methods.join("+"),
        status, closed, stage: (lines.find(r => r.stage) || {}).stage || "", sapReason: (lines.find(r => r.sapReason) || {}).sapReason || "",
        ppmValue, planValue, factValue,
        coverage: closed ? 100 : (t.value ? r1(100 * onTime / t.value) : 0),
        ...t, lines: detail,
      });
    });
    return out.sort((a, b) => cmp(a.date || "9999", b.date || "9999") || cmp(a.site, b.site) || cmp(a.unit, b.unit) || cmp(a.order, b.order));
  }

  function buildProvision({ scheduleRows, status, ppm, contour, sapSources, stockJson, ekmtrWk }) {
    if (!WU) throw new Error("нужен lib/wk_update_pipeline.js");
    const wkNames = {};
    (ekmtrWk.items || []).forEach(e => { wkNames[e.code] = e.name; });
    const stock = {};
    (stockJson.items || []).forEach(i => { stock[i.code] = i; });
    const sj = stockJson.meta || {};
    const today = WU.asOf(sj);
    const leadDefault = sj.leadMedianDays || 0;

    // load_need: зерно графика = зерно расчёта (заказ × ЕО × вид работ × материал)
    let need = [], closed = [], nocodeRows = 0, nocodeV = 0;
    const orderTotals = new Map();
    for (const r of scheduleRows) {
      if (!PROV_YEARS.includes(r.year)) continue;
      const g = {
        date: r.start || "", code: r.code, mat: r.name, order: r.order, kind: r.reason || "", site: r.site, year: r.year,
        unit: r.unit, work: r.work === NO_WORK ? "" : r.work, method: r.method || "",
        planQty: r.qp || 0, factQty: r.qf || 0, planValue: r.p || 0, factValue: r.a || 0, usoPlan: r.up || 0, usoFact: r.uf || 0,
      };
      const tk = r.year + "|" + r.order;
      if (!orderTotals.has(tk)) orderTotals.set(tk, { year: r.year, order: r.order, site: r.site, unit: r.unit, plan: 0, fact: 0 });
      const ot = orderTotals.get(tk);
      ot.plan += (r.p || 0) + (r.up || 0); ot.fact += (r.a || 0) + (r.uf || 0);
      const planQty = Math.max(g.planQty, 0), remaining = Math.max(planQty - Math.max(g.factQty, 0), 0);
      if (!g.code) { nocodeRows++; nocodeV += g.planQty ? g.planValue * remaining / g.planQty : 0; continue; }
      g.qty = remaining;
      g.value = planQty ? g.planValue * remaining / planQty : 0;
      if (remaining <= 0) { if (g.planQty > 0 || g.factQty > 0) closed.push(g); continue; }
      need.push(g);
    }
    // apply_sap_rules
    const removed = {};
    ["planPosition", "closedInSap", "migrationCopy"].forEach(k => { removed[k] = { value: 0, qty: 0, lines: 0, orders: new Set() }; });
    const keepNeed = [], keepClosed = closed.slice();
    for (const r of need) {
      const key = r.year + "|" + r.order, st = status.get(key);
      r.stage = orderStage(st);
      r.ppm = ppm.get(key + "|" + r.code) || "immediate";
      let reason = null;
      if (st) reason = st.phase === 0 ? "planPosition" : (st.phase === 3 || st.phase === 4) ? "closedInSap" : st.copy ? "migrationCopy" : null;
      if (!reason) { keepNeed.push(r); continue; }
      const b = removed[reason];
      b.value += r.value; b.qty += r.qty; b.lines += 1; b.orders.add(key);
      if (reason !== "planPosition") { r.qty = 0; r.value = 0; r.sapReason = reason; keepClosed.push(r); }
    }
    closed = keepClosed.filter(r => { const st = status.get(r.year + "|" + r.order); return !(st && st.phase === 0); });
    closed.forEach(r => {
      const key = r.year + "|" + r.order;
      if (!("stage" in r)) r.stage = orderStage(status.get(key));
      if (!("ppm" in r)) r.ppm = ppm.get(key + "|" + r.code) || "immediate";
    });
    need = keepNeed;
    const stageOf = new Map();
    orderTotals.forEach((t, k) => stageOf.set(k, orderStage(status.get(k), t.fact)));
    [...need, ...closed].forEach(r => { const k = r.year + "|" + r.order; r.stage = stageOf.has(k) ? stageOf.get(k) : (r.stage || "unknown"); });

    need = WU.allocate(need, stock, today);
    const known = need.filter(r => r.code in stock), other = need.filter(r => !(r.code in stock));
    const wkClosed = closed.filter(r => r.code in wkNames).map(r => Object.assign(r,
      { fromStock: 0, fromBuy: 0, late: 0, undated: 0, gap: 0, transferPotential: 0, transferFrom: {}, left: 0 }));

    const agg = new Map(), transferFrom = new Map(), first = {}, firstOpen = {};
    known.forEach(r => {
      if (!agg.has(r.code)) { const a = { needQty: 0, needValue: 0 }; TKEYS.forEach(k => { a[k] = 0; a[k + "Value"] = 0; }); agg.set(r.code, a); transferFrom.set(r.code, {}); }
      const a = agg.get(r.code);
      a.needQty += r.qty; a.needValue += r.value;
      TKEYS.forEach(k => { a[k] += r[k]; a[k + "Value"] += val(r, k); });
      const tf = transferFrom.get(r.code);
      Object.entries(r.transferFrom).forEach(([st, q]) => { tf[st] = (tf[st] || 0) + q; });
      const d = r.date;
      if (d && (!(r.code in first) || d < first[r.code])) first[r.code] = d;
      if (d && r.gap + r.late + r.undated > 0 && (!(r.code in firstOpen) || d < firstOpen[r.code])) firstOpen[r.code] = d;
    });
    const feasAcc = new Map(), perCode = new Map();
    known.forEach(r => {
      const g = r.gap + r.late + r.undated;
      if (g <= 0) return;
      const lead = ((stock[r.code].purchase || {}).leadDays) || leadDefault;
      const eta = new Date(+today + lead * dayMs);
      let start = null;
      if (r.date) { start = toDate(r.date); if (isNaN(+start)) start = null; }
      const k = !start ? "nodate" : start < today ? "past" : eta <= start ? "inTime" : Math.floor((eta - start) / dayMs) <= 92 ? "late3" : "lateMore";
      const gv = val(r, "gap") + val(r, "late") + val(r, "undated");
      if (!feasAcc.has(k)) feasAcc.set(k, { value: 0, qty: 0, lines: 0 });
      const b = feasAcc.get(k); b.value += gv; b.qty += g; b.lines += 1;
      if (!perCode.has(r.code)) perCode.set(r.code, {});
      const c = perCode.get(r.code); c[k] = (c[k] || 0) + gv; c[k + "Qty"] = (c[k + "Qty"] || 0) + g;
    });
    const feasible = {};
    feasAcc.forEach((v, k) => { feasible[k] = { value: r2(v.value), qty: r3(v.qty), lines: v.lines }; });

    const items = [];
    agg.forEach((a, code) => {
      const s = stock[code], p = s.purchase || {};
      const lead = p.leadDays || leadDefault, fo = firstOpen[code] || "";
      const eta = new Date(+today + lead * dayMs);
      let verdict = "covered", slip = null;
      if (a.gap + a.late + a.undated > 1e-9) {
        if (!fo) verdict = "nodate";
        else {
          const start = toDate(fo);
          if (start < today) { verdict = "past"; slip = Math.floor((today - start) / dayMs); }
          else if (eta <= start) verdict = "inTime";
          else { verdict = "late"; slip = Math.floor((eta - start) / dayMs); }
        }
      }
      const st = a.gap + a.late + a.undated <= 1e-9 ? "full" : (a.fromStock + a.fromBuy <= 1e-9 ? "none" : "partial");
      const pc = perCode.get(code) || {};
      items.push({
        code, name: wkNames[code] || s.name || "",
        needQty: r3(a.needQty), needValue: r2(a.needValue),
        fromStock: r3(a.fromStock), fromBuy: r3(a.fromBuy), late: r3(a.late), undated: r3(a.undated), gap: r3(a.gap),
        gapValue: r2(a.gapValue + a.lateValue + a.undatedValue),
        availQty: s.availQty || 0,
        availBySite: Object.fromEntries(Object.entries(s.bySite || {}).map(([k, o]) => [k, o.availQty || 0])),
        transferPotential: r3(a.transferPotential), transferPotentialValue: r2(a.transferPotentialValue),
        transferFrom: Object.fromEntries(Object.entries(transferFrom.get(code)).map(([k, q]) => [k, r3(q)])),
        openQty: p.openQty || 0, restricted: !!s.fullyRestricted, leadDays: lead, leadN: p.leadN || 0,
        firstNeed: first[code] || "", firstOpen: fo,
        orderBy: fo ? iso(new Date(+toDate(fo) - lead * dayMs)) : "",
        verdict, slipDays: slip, status: st,
        canOrder: r2(pc.inTime || 0),
        tooLate: r2(["late3", "lateMore", "past", "nodate"].reduce((x, k) => x + (pc[k] || 0), 0)),
      });
    });
    items.sort((a, b) => b.gapValue - a.gapValue);
    const bym = {};
    agg.forEach((_, code) => {
      const bm = ((stock[code].purchase || {}).byMonth) || {};
      Object.keys(bm).forEach(m => { bym[m || ""] = (bym[m || ""] || 0) + bm[m]; });
    });

    const allOrders = buildOrders([...known, ...wkClosed], wkNames);
    const orders = allOrders.filter(o => o.qty > 1e-9), closedOrders = allOrders.filter(o => o.qty <= 1e-9);
    const ystat = yearStatus(contour);
    const halfKey = r => (r.date ? r.date.slice(0, 4) + (r.date.slice(5, 7) <= "06" ? " I" : " II") : "без срока");
    const ppmFlags = {};
    ppm.forEach((v, k) => { const [y, o] = k.split("|"); if (orderTotals.has(y + "|" + o)) ppmFlags[k] = v; });
    const sapRemoved = {};
    Object.entries(removed).forEach(([k, v]) => { sapRemoved[k] = { value: r2(v.value), qty: r3(v.qty), lines: v.lines, orders: v.orders.size }; });
    const execution = [...orderTotals.values()].sort((a, b) => cmp(a.year, b.year) || cmp(a.order, b.order)).map(t => {
      const st = status.get(t.year + "|" + t.order), m = MODEL_RE.exec(t.unit || "");
      return { year: t.year, order: t.order, site: t.site, unit: t.unit, model: m ? "WK-" + m[1].toUpperCase() : "",
               stage: orderStage(st, t.fact), copyOriginal: !!(st && st.copy), plan: r2(t.plan), fact: r2(t.fact) };
    });
    return {
      meta: {
        src: "TOPO data/<площадка>_<год>.json, годы 2026-2027; план и факт слиты в зерно заказ×материал",
        srcStock: sj.srcStock, srcPurchase: sj.srcPurchase, asOf: iso(today),
        leadMedianDays: sj.leadMedianDays, leadMeasurements: sj.leadMeasurements, leadCodes: sj.leadCodes,
        orders: orders.length, closedOrders: closedOrders.length, lines: need.length, positions: agg.size,
        noCodeRows: nocodeRows, noCodeValue: r2(nocodeV),
        notWkParts: { lines: other.length, value: r2(other.reduce((s, r) => s + r.value, 0)) },
        wk: totals(known),
        byYear: cut(known, r => String(r.year)).map(r => Object.assign(r, ystat[String(r.key)] || {})),
        bySite: cut(known, r => String(r.site)),
        byHalf: cut(known, halfKey),
        byKind: cut(known, r => r.kind || "не присвоено", true, 8),
        feasible, contour, ppmFlags,
        sapStatus: true, sapSources: sortStr([...new Set(sapSources)]), sapRemoved,
        byPpm: cut(known, r => [String(r.year), r.ppm || "immediate"], false, null, k => `('${k[0]}', '${k[1]}')`)
          .map(r => Object.assign(r, { year: r.key[0], ppm: r.key[1], key: r.key.join("|") })),
        stages: STAGES.map(([key, label]) => ({ key, label })),
        arrivals: Object.keys(bym).sort((a, b) => cmp(a || "9999", b || "9999")).map(m => ({ month: m, qty: r3(bym[m]) })),
      },
      items, orders, closedOrders, execution,
    };
  }

  /* ======================================================================
     5. Свод ремонтов — build/build_repairs.py
     ====================================================================== */
  function buildRepairs(scheduleRows, ekmtrWk, files) {
    const wk = new Map((ekmtrWk.items || []).map(e => [e.code, e.name]));
    const bySY = new Map(), byUnit = new Map(), byWork = new Map(), byMat = new Map();
    for (const r of scheduleRows) {
      const k = JSON.stringify([r.site, r.year]);
      if (!bySY.has(k)) bySY.set(k, { site: r.site, year: r.year, p: 0, a: 0, qp: 0, qf: 0, rows: 0 });
      const t = bySY.get(k);
      t.p += r.p || 0; t.a += r.a || 0; t.qp += r.qp || 0; t.qf += r.qf || 0; t.rows += r.sourceRows.length;
      if (!byUnit.has(r.unit)) byUnit.set(r.unit, new Map());
      const u = byUnit.get(r.unit); u.set(r.year, (u.get(r.year) || 0) + (r.a || 0));
      const w = r.work === NO_WORK ? "" : r.work;
      byWork.set(w, (byWork.get(w) || 0) + (r.a || 0));
      if (r.code) {
        if (!byMat.has(r.code)) byMat.set(r.code, { v: 0 });
        byMat.get(r.code).v += r.a || 0;
      }
    }
    const sy = [...bySY.values()].sort((a, b) => cmp(a.site, b.site) || cmp(a.year, b.year));
    const unitTotal = ys => [...ys.values()].reduce((s, v) => s + v, 0);
    return {
      meta: {
        src: "TOPO data/<площадка>_<год>.json", files,
        planTotal: r2(sy.reduce((s, t) => s + t.p, 0)), factTotal: r2(sy.reduce((s, t) => s + t.a, 0)),
        rowsTotal: sy.reduce((s, t) => s + t.rows, 0),
      },
      bySiteYear: sy.map(t => ({ site: t.site, year: t.year, p: r2(t.p), a: r2(t.a), qp: r2(t.qp), qf: r2(t.qf), rows: t.rows })),
      byUnit: [...byUnit.entries()].sort((a, b) => unitTotal(b[1]) - unitTotal(a[1])).map(([unit, ys]) => ({
        unit, byYear: Object.fromEntries([...ys.entries()].map(([y, v]) => [y, r2(v)])), total: r2(unitTotal(ys)) })),
      byWork: [...byWork.entries()].map(([work, v]) => ({ work, value: r2(v) })).sort((a, b) => b.value - a.value),
      byMaterial: [...byMat.entries()].map(([code, m]) => ({ code, name: wk.get(code) || "", value: r2(m.v), isWkPart: wk.has(code) }))
        .sort((a, b) => b.value - a.value).slice(0, 200),
    };
  }

  /* ======================================================================
     6. Сборка целиком: база + загруженные площадко-годы
     ====================================================================== */
  /* uploads: [{ file, site, year, details: [TOPO-детализация по площадкам файла], meta: итог createMetaCollector }] */
  function rebuild({ base, uploads = [], stockJson, ekmtrWk, fleet }) {
    const report = { replaced: [], added: [], files: uploads.map(u => u.file) };
    // --- график: заменяем загруженные площадко-годы
    const fresh = new Map(), sources = new Map(), contour = Object.assign({}, (base.provision.meta || {}).contour || {});
    uploads.forEach(u => u.details.forEach(d => {
      const k = `${d.s}_${d.y}`, r = scheduleRowsFromDetail(d);
      fresh.set(k, r.rows);
      sources.set(k, Object.assign(r.source, { uploaded: u.file }));
      contour[k] = contourOf(d);
    }));
    const baseRows = base.scheduleRows.filter(r => !fresh.has(`${r.site}_${r.year}`));
    const groups = new Map();
    baseRows.forEach(r => { const k = `${r.site}_${r.year}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    fresh.forEach((rows, k) => { report[groups.has(k) || (base.scheduleMeta.sourceFiles || []).some(s => s.file === k + ".json") ? "replaced" : "added"].push(k); groups.set(k, rows); });
    const scheduleRows = [...groups.keys()].sort(cmp).flatMap(k => groups.get(k));
    const srcFiles = (base.scheduleMeta.sourceFiles || []).filter(s => !sources.has(s.file.replace(/\.json$/, "")));
    sources.forEach(s => srcFiles.push(s));
    srcFiles.sort((a, b) => cmp(a.file, b.file));
    const smeta = Object.assign({}, base.scheduleMeta, {
      sourceFiles: srcFiles, rawRows: srcFiles.reduce((s, f) => s + (f.wkRows || 0), 0), lines: scheduleRows.length,
      orders: new Set(scheduleRows.map(r => r.orderId)).size, units: new Set(scheduleRows.map(r => r.unitId)).size,
      years: sortStr([...new Set(scheduleRows.map(r => r.year))]),
    });
    if (uploads.length) smeta.rebuiltInBrowser = new Date().toISOString();

    // --- статусы, копии, ППМ, тексты: база, поверх — загруженные файлы
    const status = statusesFromControl(base.control);
    const pgNames = {};
    const ppm = new Map(Object.entries(((base.provision.meta || {}).ppmFlags) || {}));
    const texts = Object.assign({}, (base.orderText && base.orderText.text) || {});
    let sapSources = ((base.provision.meta || {}).sapSources || []).slice();
    uploads.forEach(u => {
      const y = String(u.year), m = u.meta;
      const ordersOfYear = new Set();
      m.orders.forEach((v, o) => {
        ordersOfYear.add(o);
        if (v.pg && v.pgText) pgNames[v.pg] = v.pgText;
        status.set(y + "|" + o, { phase: phaseOf(v.sys), copy: m.originals.has(o), kind: v.kind, kindText: v.kindText, pg: v.pg || "",
          sys: new Set(v.sys.split(/\s+/).filter(Boolean)), usr: new Set(v.usr.split(/\s+/).filter(Boolean)) });
        if (v.text) texts[o] = v.text;
      });
      [...ppm.keys()].forEach(k => { const [yy, o] = k.split("|"); if (yy === y && ordersOfYear.has(o)) ppm.delete(k); });
      m.comps.forEach((codes, o) => codes.forEach((idx, code) => ppm.set(`${y}|${o}|${code}`, PPM_BY_FLAG[idx] || "immediate")));
      if (PROV_YEARS.includes(y)) sapSources.push("браузер: " + u.file);
    });

    const provision = buildProvision({ scheduleRows, status, ppm, contour, sapSources, stockJson, ekmtrWk });
    provision.meta.contour = Object.fromEntries(Object.keys(contour).sort(cmp).map(k => [k, contour[k]]));
    const ppmSorted = {};
    Object.keys(provision.meta.ppmFlags).sort((a, b) => {
      const pa = a.split("|"), pb = b.split("|");
      return cmp(pa[0], pb[0]) || cmp(pa[1], pb[1]) || cmp(pa[2], pb[2]);
    }).forEach(k => { ppmSorted[k] = provision.meta.ppmFlags[k]; });
    provision.meta.ppmFlags = ppmSorted;
    if (uploads.length) provision.meta.rebuiltInBrowser = smeta.rebuiltInBrowser;
    const control = buildControl(scheduleRows, status, fleet, provision.meta.asOf, base.control.meta, pgNames);
    const repairs = buildRepairs(scheduleRows, ekmtrWk, srcFiles.length);
    const wanted = new Set(control.rows.map(r => r[1]));
    const orderText = {
      meta: Object.assign({}, (base.orderText && base.orderText.meta) || {}),
      text: Object.fromEntries(Object.keys(texts).filter(o => wanted.has(o)).sort(cmp).map(o => [o, texts[o]])),
    };
    orderText.meta.orders = Object.keys(orderText.text).length;
    orderText.meta.of = wanted.size;
    const schedule = scheduleShards(scheduleRows, smeta);
    return { scheduleRows, schedule, control, provision, repairs, orderText, report };
  }

  return { rebuild, scheduleRowsFromDetail, scheduleShards, createMetaCollector, buildControl, buildProvision, buildRepairs,
           statusesFromControl, orderStage, controlStage, phaseOf, contourOf, decodeTable, pyRound, sha256hex, hid, isoDate };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ToroRebuild;
