/* Ядро вкладок «Аналитика» и «Контроль отделов»: чистые расчёты без DOM.

   Входы — витрины отчёта: control (заказ × год PM-06 со стадией и статусами,
   build/build_control.py), provision, stock, fleet. Контекст — те же фильтры,
   что в шапке отчёта: площадка, модель, машина, заказ.

   Правила расчёта совпадают с презентацией (build/build_wk_status_data.py) и
   PM06_STATUSES.md:
     * план = МТР Полюса + МТР подрядчика (УСО); позиции графика ППР без
       заказа SAP (stage noOrder) в план не входят и показываются отдельно;
     * у оригинала БЕ, перенесённого копией в «Развитие», неисполненный план
       не учитывается: план = min(план, факт);
     * оценка планирования АО «Развитие» — только заказы групп планирования
       ТОРО 100 Механика и 200 Энергетика (pg = «завод/группа»); группы
       300–900 — службы БЕ (заказчика), в неё не входят;
     * обеспеченность — склад своей площадки и закупка к сроку; перемещение
       между площадками ограничено и в покрытие НЕ входит, это возможность
       (transferPotential).

   Каждое число, на которое опирается автовывод, лежит в evidence вывода, а
   сверки (checks) проверяют, что разрезы сходятся к итогам. Тот же модуль
   проверяется в tests/test_analytics.mjs против независимого пересчёта
   tests/verify_analytics.py. */
const AnalyticsCore = (() => {
  "use strict";

  const YEARS = ["2024", "2025", "2026", "2027"];
  const STAGES = [
    ["noOrder", "Позиция ППР, заказа нет"], ["approving", "Открыт, на согласовании"],
    ["approved", "Открыт, согласован (СГГС)"], ["released", "Деблокирован, без факта"],
    ["inWork", "В работе"], ["factDone", "Факт проведён (ФХСМ)"], ["techClosed", "Тех. закрыт (ТЗКР)"],
    ["accepted", "Принят СЗ (ПРСЗ)"], ["billed", "Выставлен в БЕ (ВСБЕ)"], ["closed", "Закрыт (ЗАКР)"],
    ["unknown", "Нет в выгрузке статусов"],
  ];
  const GROUP = {
    noOrder: "ППР без заказа", approving: "Согласование", approved: "Согласование",
    released: "Деблокирован, пусто", inWork: "В работе", factDone: "В работе",
    techClosed: "Тех. закрыт", accepted: "Тех. закрыт", billed: "Тех. закрыт", closed: "Закрыт", unknown: "Нет статуса",
  };
  const GROUPS = ["Закрыт", "Тех. закрыт", "В работе", "Деблокирован, пусто", "Согласование", "ППР без заказа", "Нет статуса"];
  const CLOSED = new Set(["techClosed", "accepted", "billed", "closed"]);
  const OPEN_WORK = new Set(["released", "inWork", "factDone"]);
  const NOT_RELEASED = new Set(["approving", "approved"]);

  /* Пороги автовыводов — одни и те же для расчёта, схемы и тестов. */
  const T = {
    execLow: 0.90, execHigh: 1.10,          // исполнение закрытого года
    paceGap: 0.15,                           // отставание текущего года от доли прошедшего времени
    releasedEmptyShare: 0.05,                // деблокировано без факта, доля плана года
    approvingShareLate: 0.10,                // план текущего года ещё на согласовании
    nextYearApprovedMin: 0.50,               // план следующего года согласован (СГГС и дальше)
    coverageBad: 0.70, coverageWarn: 0.90,   // обеспеченность к сроку
    ktgGap: 0.05,                            // факт КТГ ниже плана
    overrunRatio: 1.10, overrunMin: 100000,  // перерасход заказа
    concentration: 0.25,                     // доля одного борта в факте
    planAccuracyTol: 0.20,                   // точность планирования ±20 %
    unplannedShare: 0.40,                    // доля внеплановых (AVS1) в факте
    closeLagDays: 30,                        // базисный конец прошёл, заказ не закрыт
  };

  /* группы планирования ТОРО, которые планирует АО «Развитие»; 300–900 — службы БЕ */
  const DEV_GROUPS = ["100", "200"];
  const PG_NAMES = { "100": "Механика", "200": "Энергетика", "300": "Метрология", "400": "ЗиС", "500": "Пожарная охрана",
    "600": "АГиТО", "700": "Эксплуатация", "800": "ГПМ", "900": "КИПиА" };
  const pgGroup = pg => String(pg || "").split("/").pop();
  const isDevGroup = pg => DEV_GROUPS.includes(pgGroup(pg));
  /* фильтр «Группа планирования»: dev — «Развитие» (100, 200), be — службы БЕ и не присвоенные,
     иначе — код группы (100…900 или # — не присвоена) */
  const pgMatch = (pg, f) => (!f ? true : f === "dev" ? isDevGroup(pg) : f === "be" ? !isDevGroup(pg) : pgGroup(pg) === String(f));
  // заказ → группа планирования (из последней разобранной витрины control): для обеспеченности, УСО, графика
  let PG_OF = new Map();
  // заказ → строки control (год × заказ): статус и факт МТР подрядчика берутся из заказа ТОРО
  let CTL_OF = new Map();
  const pgOfOrder = order => PG_OF.get(String(order)) || "";
  const N = v => (typeof v === "number" && isFinite(v) ? v : 0);
  const sum = (a, f) => a.reduce((s, x) => s + N(f(x)), 0);
  const round2 = v => Math.round(v * 100) / 100;
  const ratio = (a, b) => (b ? a / b : null);
  const dayMs = 86400000;
  const toDate = s => (s ? new Date(String(s).slice(0, 10) + "T00:00:00Z") : null);

  /* ---------- витрина control ---------- */
  function decodeControl(control) {
    const cols = control.columns, dic = control.dictionaries;
    const pgOf = new Map(), ctlOf = new Map();
    const rows = control.rows.map(v => {
      const r = {};
      cols.forEach((k, i) => { r[k] = dic[k] ? dic[k][v[i]] : v[i]; });
      r.flagSet = new Set(r.flags ? r.flags.split(" ") : []);
      r.plan = N(r.p) + N(r.up);
      r.fact = N(r.a) + N(r.uf);
      r.noOrder = r.stage === "noOrder";
      // правило копий: у оригинала БЕ неисполненный план не учитывается
      r.planCounted = r.noOrder ? 0 : (r.copy ? Math.min(r.plan, r.fact) : r.plan);
      r.group = GROUP[r.stage] || "Нет статуса";
      r.pg = r.pg || "";
      r.dev = isDevGroup(r.pg);
      if (r.pg) pgOf.set(String(r.order), r.pg);
      const k = String(r.order); (ctlOf.get(k) || ctlOf.set(k, []).get(k)).push(r);
      return r;
    });
    PG_OF = pgOf; CTL_OF = ctlOf;
    return rows;
  }

  function inContext(o, ctx) {
    if (!ctx) return true;
    if (ctx.site && o.site !== ctx.site) return false;
    if (ctx.model && o.model !== ctx.model) return false;
    if (ctx.unit && o.unit !== ctx.unit) return false;
    if (ctx.order && !String(o.order).includes(String(ctx.order))) return false;
    if (ctx.pg && !pgMatch(o.pg != null ? o.pg : pgOfOrder(o.order), ctx.pg)) return false;
    return true;
  }

  function blankYear() {
    const g = {}, gn = {}, st = {}, sn = {};
    GROUPS.forEach(k => { g[k] = 0; gn[k] = 0; });
    STAGES.forEach(([k]) => { st[k] = 0; sn[k] = 0; });
    return { plan: 0, fact: 0, mtrPlan: 0, mtrFact: 0, usoPlan: 0, usoFact: 0, orders: 0,
             noOrderPlan: 0, noOrderN: 0, copyExcluded: 0, closedPlan: 0,
             groups: g, groupN: gn, stages: st, stageN: sn };
  }
  function addYear(t, r) {
    t.groups[r.group] += r.plan; t.groupN[r.group] += 1;
    t.stages[r.stage] += r.plan; t.stageN[r.stage] += 1;
    if (r.noOrder) { t.noOrderPlan += r.plan; t.noOrderN += 1; return; }
    t.orders += 1;
    t.plan += r.planCounted; t.fact += r.fact;
    t.copyExcluded += r.plan - r.planCounted;
    const share = r.plan ? r.planCounted / r.plan : 0;
    t.mtrPlan += N(r.p) * share; t.usoPlan += N(r.up) * share;
    t.mtrFact += N(r.a); t.usoFact += N(r.uf);
    if (CLOSED.has(r.stage)) t.closedPlan += r.planCounted;
  }
  function finishYear(t) {
    t.exec = ratio(t.fact, t.plan);
    t.closedShare = ratio(t.closedPlan, t.plan);
    return t;
  }
  function byYear(rows) {
    const out = {};
    YEARS.forEach(y => { out[y] = blankYear(); });
    rows.forEach(r => { if (out[r.y]) addYear(out[r.y], r); });
    YEARS.forEach(y => finishYear(out[y]));
    return out;
  }
  function cut(rows, keyFn) {
    const m = new Map();
    rows.forEach(r => {
      const k = keyFn(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    });
    return [...m].map(([key, a]) => ({ key, years: byYear(a) }));
  }

  /* ---------- исполнение ---------- */
  function execution(rows) {
    const years = byYear(rows);
    const bySite = cut(rows, r => r.site).sort((a, b) => a.key.localeCompare(b.key));
    const byModel = cut(rows, r => r.model).sort((a, b) => a.key.localeCompare(b.key));
    const byUnit = cut(rows, r => r.unit);
    const work = new Map(), reason = new Map();
    rows.forEach(r => {
      if (r.noOrder) return;
      for (const [m, k] of [[work, r.work || "—"], [reason, r.reason || "—"]]) {
        if (!m.has(k)) m.set(k, {});
        const t = m.get(k);
        if (!t[r.y]) t[r.y] = { plan: 0, fact: 0 };
        t[r.y].plan += r.planCounted; t[r.y].fact += r.fact;
      }
    });
    const pack = m => [...m].map(([key, ys]) => ({ key, years: ys,
      fact3: ["2024", "2025", "2026"].reduce((s, y) => s + N(ys[y] && ys[y].fact), 0),
      plan27: N(ys["2027"] && ys["2027"].plan) })).sort((a, b) => (b.fact3 + b.plan27) - (a.fact3 + a.plan27));
    return { years, bySite, byModel, byUnit, byWork: pack(work), byReason: pack(reason) };
  }

  /* ---------- дни и доля прошедшего года ---------- */
  function yearElapsed(asOf) {
    const d = toDate(asOf), y = d.getUTCFullYear();
    const start = Date.UTC(y, 0, 1), end = Date.UTC(y + 1, 0, 1);
    return (d - start) / (end - start);
  }

  /* ---------- контроль исполнения ---------- */
  function executionControl(rows, asOf) {
    const cur = asOf.slice(0, 4), today = toDate(asOf);
    const curRows = rows.filter(r => r.y === cur && !r.noOrder);
    const funnel = STAGES.filter(([k]) => k !== "noOrder" && k !== "unknown").map(([key, label]) => {
      const a = curRows.filter(r => r.stage === key);
      return { key, label, n: a.length, plan: sum(a, r => r.planCounted), fact: sum(a, r => r.fact) };
    });
    const list = (pred) => {
      const a = curRows.filter(pred).sort((x, y) => y.planCounted - x.planCounted);
      return { n: a.length, plan: sum(a, r => r.planCounted), fact: sum(a, r => r.fact), top: a.slice(0, 12), all: a };
    };
    const lagDate = new Date(today - T.closeLagDays * dayMs);
    const res = {
      year: cur,
      funnel,
      notReleasedStarted: list(r => NOT_RELEASED.has(r.stage) && r.start && toDate(r.start) < today),
      releasedEmpty: list(r => r.stage === "released"),
      closeOverdue: list(r => OPEN_WORK.has(r.stage) && r.end && toDate(r.end) < lagDate),
      readyToClose: list(r => r.stage === "factDone"),
      acceptPending: list(r => r.stage === "techClosed"),
      billPending: list(r => r.stage === "accepted"),
      tails: {},
    };
    ["2024", "2025"].forEach(y => {
      const a = rows.filter(r => r.y === y && !r.noOrder && !CLOSED.has(r.stage)).sort((x, z) => z.planCounted - x.planCounted);
      res.tails[y] = { n: a.length, plan: sum(a, r => r.planCounted), fact: sum(a, r => r.fact), top: a.slice(0, 8), all: a };
    });
    // S-кривая текущего года: план и факт по месяцу базисного начала заказа, нарастающим итогом
    // (начало раньше года или без даты — в январе, позже года — в декабре: итог = план года)
    const months = [];
    for (let m = 1; m <= 12; m++) months.push(`${cur}-${String(m).padStart(2, "0")}`);
    const pm = months.map(() => 0), fm = months.map(() => 0);
    curRows.forEach(r => {
      const i = months.indexOf((r.start || "").slice(0, 7));
      const j = i < 0 ? ((r.start || "") < months[0] ? 0 : 11) : i;
      pm[j] += r.planCounted; fm[j] += r.fact;
    });
    let cp = 0, cf = 0;
    res.sCurve = months.map((m, i) => { cp += pm[i]; cf += fm[i]; return { month: m, plan: pm[i], fact: fm[i], planCum: cp, factCum: cf }; });
    const asOfMonth = asOf.slice(0, 7);
    const upto = res.sCurve.filter(x => x.month <= asOfMonth);
    res.dueToDate = upto.length ? upto[upto.length - 1].planCum : 0;
    res.factDueToDate = sum(curRows.filter(r => (r.start || "").slice(0, 7) <= asOfMonth), r => r.fact);
    res.execDue = ratio(res.factDueToDate, res.dueToDate);
    // внеплановые работы (AVS1) — доля факта по годам
    res.unplanned = {};
    YEARS.slice(0, 3).forEach(y => {
      const a = rows.filter(r => r.y === y && !r.noOrder);
      const f = sum(a, r => r.fact), u = sum(a.filter(r => r.kind === "AVS1"), r => r.fact);
      res.unplanned[y] = { fact: f, unplannedFact: u, share: ratio(u, f) };
    });
    return res;
  }

  /* ---------- контроль планирования ---------- */
  function planningControl(rows, asOf) {
    const cur = asOf.slice(0, 4), next = String(+cur + 1), today = toDate(asOf);
    const nextRows = rows.filter(r => r.y === next);
    const approvalOf = r => r.noOrder ? "ППР без заказа"
      : r.stage === "approving" ? (r.flagSet.has("ССПЛ") ? "ССПЛ" : r.flagSet.has("СГПЛ") ? "СГПЛ" : "ПЛАН")
      : r.stage === "approved" ? "СГГС" : "Деблокирован";
    const chain = ["ППР без заказа", "ПЛАН", "СГПЛ", "ССПЛ", "СГГС", "Деблокирован"].map(k => {
      const a = nextRows.filter(r => approvalOf(r) === k);
      // позиции ППР — полный объём графика; заказы — по правилу копии, как весь план
      return { key: k, n: a.length, plan: sum(a, r => r.noOrder ? r.plan : r.planCounted) };
    });
    const nextOrders = nextRows.filter(r => !r.noOrder);
    const nextPlan = sum(nextOrders, r => r.planCounted);
    const approvedPlan = sum(nextOrders.filter(r => !["approving"].includes(r.stage)), r => r.planCounted);
    const planned = nextOrders.filter(r => r.kind === "APP1");
    const plannedPlan = sum(planned, r => r.planCounted);
    const annual = ["ГОД", "ПТОГ", "ГИП", "УТВГ", "УТВП"].map(c => ({
      code: c, plan: sum(planned.filter(r => r.flagSet.has(c)), r => r.planCounted), share: null }));
    annual.forEach(a => { a.share = ratio(a.plan, plannedPlan); });
    // месячный и недельный план: заказы текущего года с началом в ближайшие 31 день
    const soon = rows.filter(r => r.y === cur && !r.noOrder && r.start && toDate(r.start) >= today && toDate(r.start) <= new Date(+today + 31 * dayMs));
    const soonPlan = sum(soon, r => r.planCounted);
    const operative = ["МЕС", "УТВМ", "НЕД", "УТВН"].map(c => ({ code: c, n: soon.filter(r => r.flagSet.has(c)).length,
      plan: sum(soon.filter(r => r.flagSet.has(c)), r => r.planCounted) }));
    operative.forEach(a => { a.share = ratio(a.plan, soonPlan); });
    // материалы в заказах текущего и следующего года
    const openRows = rows.filter(r => (r.y === cur || r.y === next) && !r.noOrder && !CLOSED.has(r.stage));
    const mat = ["МТРН", "СРОЧ", "НВСО", "ТОПЗ", "СОПЗ"].map(c => {
      const a = openRows.filter(r => r.flagSet.has(c));
      return { code: c, n: a.length, plan: sum(a, r => r.planCounted), top: a.sort((x, y) => y.planCounted - x.planCounted).slice(0, 8) };
    });
    // точность планирования закрытых лет: факт в пределах ±20 % плана
    const accuracy = {};
    ["2024", "2025"].forEach(y => {
      const a = rows.filter(r => r.y === y && CLOSED.has(r.stage) && r.planCounted > 0);
      const ok = a.filter(r => Math.abs(r.fact - r.planCounted) <= T.planAccuracyTol * r.planCounted);
      const noFact = a.filter(r => r.fact <= 0);
      accuracy[y] = { n: a.length, ok: ok.length, share: ratio(ok.length, a.length),
                      planOk: sum(ok, r => r.planCounted), plan: sum(a, r => r.planCounted),
                      noFactN: noFact.length, noFactPlan: sum(noFact, r => r.planCounted) };
    });
    const badDates = rows.filter(r => (r.y === cur || r.y === next) && r.badDates > 0);
    // текущий год: доля плана на согласовании; начало прошло, а заказ не деблокирован
    const yrs = byYear(rows), curYear = yrs[cur], nextYear = yrs[next];
    const nrs = rows.filter(r => r.y === cur && !r.noOrder && NOT_RELEASED.has(r.stage) && r.start && toDate(r.start) < today)
      .sort((x, y) => y.planCounted - x.planCounted);
    const notReleasedStarted = { n: nrs.length, plan: sum(nrs, r => r.planCounted), fact: sum(nrs, r => r.fact), top: nrs.slice(0, 12), all: nrs };
    // внеплановые работы (AVS1) — доля факта по годам
    const unplanned = {};
    YEARS.slice(0, 3).forEach(y => {
      const a = rows.filter(r => r.y === y && !r.noOrder);
      const f = sum(a, r => r.fact), u = sum(a.filter(r => r.kind === "AVS1"), r => r.fact);
      unplanned[y] = { fact: f, unplannedFact: u, share: ratio(u, f) };
    });
    return { cur, next, chain, curYear, nextYear, notReleasedStarted, unplanned, nextPlan, approvedPlan, approvedShare: ratio(approvedPlan, nextPlan),
             noOrder: chain[0], annual, plannedPlan, soon: { n: soon.length, plan: soonPlan }, operative,
             materials: mat, accuracy, badDates: { n: badDates.length, lines: sum(badDates, r => r.badDates) } };
  }

  /* ---------- контроль бюджета ---------- */
  function budgetControl(rows, asOf) {
    const cur = asOf.slice(0, 4), next = String(+cur + 1);
    const years = byYear(rows);
    const overrun = {}, underrun = {}, noPlan = {};
    ["2024", "2025", cur].forEach(y => {
      const a = rows.filter(r => r.y === y && !r.noOrder);
      const o = a.filter(r => r.fact > r.planCounted * T.overrunRatio && r.fact - r.planCounted >= T.overrunMin && r.planCounted > 0)
        .sort((x, z) => (z.fact - z.planCounted) - (x.fact - x.planCounted));
      overrun[y] = { n: o.length, value: sum(o, r => r.fact - r.planCounted), top: o.slice(0, 10), all: o };
      const u = a.filter(r => CLOSED.has(r.stage) && r.planCounted > 0 && r.fact < 0.5 * r.planCounted)
        .sort((x, z) => (z.planCounted - z.fact) - (x.planCounted - x.fact));
      underrun[y] = { n: u.length, value: sum(u, r => r.planCounted - r.fact), top: u.slice(0, 8), all: u };
      const np = a.filter(r => r.planCounted <= 0 && r.fact > 0);
      noPlan[y] = { n: np.length, value: sum(np, r => r.fact) };
    });
    const statusOf = y => {
      const a = rows.filter(r => r.y === y && !r.noOrder && r.kind === "APP1");
      const base = sum(a, r => r.planCounted);
      return ["ТКБЕ", "УТВП", "СГЛБ", "ПЗТГ", "ПЗТМ", "КОРБ", "ТРКБ", "ОТКБ", "КРМТ"].map(c => {
        const b = a.filter(r => r.flagSet.has(c));
        return { code: c, n: b.length, plan: sum(b, r => r.planCounted), share: ratio(sum(b, r => r.planCounted), base) };
      });
    };
    // риск неосвоения текущего года: базисное начало уже наступило, а факта
    // нет (не деблокирован или деблокирован пусто); будущие заказы — отдельно
    const today = toDate(asOf);
    const curRows = rows.filter(r => r.y === cur && !r.noOrder);
    const noFact = curRows.filter(r => (NOT_RELEASED.has(r.stage) || r.stage === "released") && r.fact <= 0);
    const due = noFact.filter(r => r.start && toDate(r.start) <= today);
    const riskUnspent = sum(due, r => r.planCounted);
    const ahead = sum(noFact.filter(r => !(r.start && toDate(r.start) <= today)), r => r.planCounted);
    return { cur, next, years, overrun, underrun, noPlan, statusCur: statusOf(cur), statusNext: statusOf(next),
             riskUnspent, riskN: due.length, riskShare: ratio(riskUnspent, years[cur].plan), ahead,
             riskTop: due.sort((a, b) => b.planCounted - a.planCounted).slice(0, 10), riskAll: due };
  }

  /* ---------- обеспеченность и запасы ---------- */
  const SEG_KEYS = ["fromStock", "fromBuy", "late", "undated", "gap", "transferPotential"];
  function provBlank() { const t = { value: 0, orders: 0 }; SEG_KEYS.forEach(k => { t[k] = 0; }); return t; }
  function provAdd(t, o) { t.value += N(o.value); t.orders += 1; SEG_KEYS.forEach(k => { t[k] += N(o[k]); }); }
  function provFinish(t) {
    t.covered = t.fromStock + t.fromBuy;
    t.uncovered = t.late + t.undated + t.gap;
    t.coverage = ratio(t.covered, t.value);
    t.coverageWithMove = ratio(t.covered + t.transferPotential, t.value);
    // разрез для графика: потенциал перемещения вырезается из непокрытого
    const potGap = Math.min(t.transferPotential, t.gap);
    t.seg = { own: t.fromStock, buy: t.fromBuy, late: t.late + t.undated - (t.transferPotential - potGap),
              pot: t.transferPotential, gap: t.gap - potGap };
    return t;
  }
  function provision(prov, stock, ctx, asOf) {
    const orders = (prov.orders || []).filter(o => inContext(o, ctx));
    const byYearP = {}, bySite = {}, byUnit = {};
    const yearOf = o => String((o.years || [])[0] || (o.date || "").slice(0, 4));
    orders.forEach(o => {
      const y = yearOf(o);
      (byYearP[y] = byYearP[y] || provBlank());
      provAdd(byYearP[y], o);
      const sk = o.site + "|" + y;
      (bySite[sk] = bySite[sk] || provBlank()); provAdd(bySite[sk], o);
      const uk = o.unit + "|" + y;
      (byUnit[uk] = byUnit[uk] || provBlank()); provAdd(byUnit[uk], o);
    });
    const total = provBlank();
    orders.forEach(o => provAdd(total, o));
    [total, ...Object.values(byYearP), ...Object.values(bySite), ...Object.values(byUnit)].forEach(provFinish);
    // перемещения (возможность) и признак ППМ — по строкам
    const moves = {}, moveItems = new Map(), ppm = {};
    const itemBy = new Map((prov.items || []).map(i => [String(i.code), i]));
    const lead0 = (prov.meta || {}).leadMedianDays || 0;
    const today = toDate(asOf);
    const feas = { inTime: 0, late3: 0, lateMore: 0, past: 0, nodate: 0 };
    const feasCode = {};   // «успеем, если заказать сейчас» по коду — пакет «Заказать сегодня» в контексте
    const lineCode = {};   // непокрытое по коду в контексте — «Критичные позиции дефицита»
    orders.forEach(o => {
      const y = yearOf(o);
      (o.lines || []).forEach(l => {
        const pk = y + "|" + (l.ppm || "immediate");
        const p = (ppm[pk] = ppm[pk] || { value: 0, uncovered: 0, covered: 0, potential: 0 });
        p.value += N(l.value);
        p.covered += N(l.fromStockValue) + N(l.fromBuyValue);
        p.uncovered += N(l.lateValue) + N(l.undatedValue) + N(l.gapValue);
        p.potential += N(l.transferPotentialValue);
        const tr = N(l.transferPotential);
        if (tr > 0) {
          Object.entries(l.transferFrom || {}).forEach(([from, q]) => {
            const v = N(l.transferPotentialValue) * q / tr;
            const k = from + ">" + o.site;
            moves[k] = (moves[k] || 0) + v;
            const it = moveItems.get(l.code) || { code: l.code, name: l.name, value: 0, qty: 0, routes: {} };
            it.value += v; it.qty += q; it.routes[k] = (it.routes[k] || 0) + q;
            moveItems.set(l.code, it);
          });
        }
        // можно ли ещё успеть заказом — построчно, как build_provision.py
        const openQ = N(l.gap) + N(l.late) + N(l.undated);
        if (openQ <= 0) return;
        const it = itemBy.get(String(l.code)) || {};
        const lead = it.leadDays || lead0;
        const ov = N(l.gapValue) + N(l.lateValue) + N(l.undatedValue);
        const start = toDate(l.date);
        let k = "nodate";
        if (start) {
          const eta = new Date(+today + lead * dayMs);
          if (start < today) k = "past";
          else if (eta <= start) k = "inTime";
          else k = (eta - start) / dayMs <= 92 ? "late3" : "lateMore";
        }
        feas[k] += ov;
        if (k === "inTime") feasCode[l.code] = (feasCode[l.code] || 0) + ov;
        const lc = (lineCode[l.code] = lineCode[l.code] || { gapValue: 0, needQty: 0 });
        lc.gapValue += ov;
      });
      (o.lines || []).forEach(l => { const lc = lineCode[l.code]; if (lc) lc.needQty += N(l.qty); });
    });
    const moveTop = [...moveItems.values()].sort((a, b) => b.value - a.value).slice(0, 10);
    return { orders: orders.length, total, byYear: byYearP, bySite, byUnit, moves, moveTop, ppm, feasible: feas, feasCode, lineCode };
  }

  function stockView(stock, ctx) {
    const sites = (stock.meta && stock.meta.sites) || {};
    const items = stock.items || [];
    const bySite = Object.entries(sites).map(([site, t]) => ({ site, ...t }));
    const val = (i, k) => {
      if (!ctx || !ctx.site || !i.bySite) return N(i[k]);
      const o = i.bySite[ctx.site]; return o ? N(o[k]) : 0;
    };
    return {
      bySite,
      value: sum(items, i => val(i, "value")), availValue: sum(items, i => val(i, "availValue")),
      restrictedValue: sum(items, i => val(i, "restrictedValue")),
      codes: items.filter(i => val(i, "qty") > 0).length,
    };
  }

  /* ---------- КТГ ---------- */
  function ktgView(fleet, ctx, cur) {
    const months = fleet.meta.months;
    const units = fleet.units.filter(u => (!ctx || ((!ctx.site || u.site === ctx.site) && (!ctx.model || u.model === ctx.model) && (!ctx.unit || u.name === ctx.unit))));
    const avg = a => { const v = a.filter(x => x > 0); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    const yearAvg = (arr, y) => {
      const v = avg(arr.filter((_, i) => months[i].startsWith(y)));
      return v != null && v >= 0.99999 ? null : v;   // ровно 100 % за год — заглушка витрины
    };
    const byUnit = units.map(u => {
      const r = { unit: u.name, site: u.site, model: u.model };
      YEARS.filter(y => y <= cur).forEach(y => { r[y] = { plan: yearAvg(u.ktgByMonth, y), fact: yearAvg(u.kioByMonth, y) }; });
      return r;
    });
    const monthly = months.map((m, i) => ({
      month: m,
      plan: avg(units.map(u => u.ktgByMonth[i])),
      fact: avg(units.map(u => u.kioByMonth[i])),
    }));
    const below = byUnit.filter(r => r[cur].plan != null && r[cur].fact != null && r[cur].fact < r[cur].plan - T.ktgGap)
      .sort((a, b) => (a[cur].fact - a[cur].plan) - (b[cur].fact - b[cur].plan));
    return { units: units.length, byUnit, monthly, below };
  }

  /* ---------- модель вкладки ---------- */
  /* кто планирует: план по группам планирования ТОРО — «Развитие» (100, 200) и службы БЕ */
  function planScope(rows, asOf) {
    const cur = asOf.slice(0, 4), next = String(+cur + 1);
    const by = new Map();
    rows.forEach(r => {
      const g = r.pg ? pgGroup(r.pg) : "";
      let t = by.get(g);
      if (!t) by.set(g, (t = { group: g, name: !g ? "нет в выгрузке" : g === "#" ? "не присвоена" : (PG_NAMES[g] || g), dev: DEV_GROUPS.includes(g), codes: new Set(), years: {} }));
      if (r.pg) t.codes.add(r.pg);
      const y = (t.years[r.y] = t.years[r.y] || { n: 0, plan: 0, fact: 0 });
      y.n += 1; y.plan += r.noOrder ? r.plan : r.planCounted; y.fact += r.fact;
    });
    const groups = [...by.values()].map(t => ({ ...t, codes: [...t.codes].sort() }))
      .sort((a, b) => (a.dev === b.dev ? (a.group || "999").localeCompare(b.group || "999") : a.dev ? -1 : 1));
    const tot = k => y => sum(groups.filter(k), g => (g.years[y] || {}).plan);
    const devPlan = Object.fromEntries(YEARS.map(y => [y, tot(g => g.dev)(y)]));
    const allPlan = Object.fromEntries(YEARS.map(y => [y, tot(() => true)(y)]));
    return { devGroups: DEV_GROUPS.slice(), groups, devPlan, allPlan,
             devShareNext: ratio(devPlan[next], allPlan[next]), devShareCur: ratio(devPlan[cur], allPlan[cur]) };
  }

  function buildModel(src, ctx) {
    const rowsAll = src.controlRows || decodeControl(src.control);
    const rows = rowsAll.filter(r => inContext(r, ctx));
    const asOf = src.provision.meta.asOf;
    const m = {
      ctx: ctx || {}, asOf, elapsed: yearElapsed(asOf),
      rows, exec: execution(rows),
      execCtl: executionControl(rows, asOf),
      // оценка планирования «Развития» — только группы 100 Механика и 200 Энергетика
      plan: planningControl(rows.filter(r => r.dev), asOf),
      planScope: planScope(rows, asOf),
      budget: budgetControl(rows, asOf),
      prov: provision(src.provision, src.stock, ctx, asOf),
      stock: stockView(src.stock, ctx),
      ktg: ktgView(src.fleet, ctx, asOf.slice(0, 4)),
    };
    m.conclusions = conclusions(m);
    m.checks = checks(m, src, ctx);
    return m;
  }

  /* ---------- автовыводы ---------- */
  const RULES = [
    { id: "exec-closed", group: "Исполнение", title: "Исполнение закрытых лет", test: `факт/план 2024–2025 вне ${T.execLow * 100}–${T.execHigh * 100}%` },
    { id: "exec-pace", group: "Исполнение", title: "Темп текущего года", test: `освоение отстаёт от доли прошедшего года более чем на ${T.paceGap * 100} п.п.` },
    { id: "exec-released-empty", group: "Исполнение", title: "Деблокировано без факта", test: `> ${T.releasedEmptyShare * 100}% плана года` },
    { id: "exec-close-overdue", group: "Исполнение", title: "Просрочено закрытие", test: `базисный конец прошёл > ${T.closeLagDays} дн., заказ не закрыт` },
    { id: "exec-tails", group: "Исполнение", title: "Хвосты прошлых лет", test: "заказы 2024–2025 не закрыты технически" },
    { id: "exec-ready-close", group: "Исполнение", title: "Готовы к ТЗКР", test: "ФХСМ проставлен, ТЗКР нет" },
    { id: "plan-approving", group: "Планирование", title: "Согласование текущего года", test: `> ${T.approvingShareLate * 100}% плана ещё на согласовании` },
    { id: "plan-next-approved", group: "Планирование", title: "Готовность плана следующего года", test: `согласовано (СГГС и дальше) < ${T.nextYearApprovedMin * 100}%` },
    { id: "plan-no-order", group: "Планирование", title: "Позиции ППР без заказа", test: "есть позиции графика без заказа SAP" },
    { id: "plan-not-released-started", group: "Планирование", title: "Начало прошло, не деблокирован", test: "базисное начало в прошлом, заказ открыт" },
    { id: "plan-accuracy", group: "Планирование", title: "Точность планирования", test: `меньше половины закрытых заказов в пределах ±${T.planAccuracyTol * 100}% плана` },
    { id: "plan-unplanned", group: "Планирование", title: "Внеплановые работы", test: `внеплановые (AVS1) > ${T.unplannedShare * 100}% факта` },
    { id: "plan-materials", group: "Планирование", title: "МТР без цены", test: "есть заказы со статусом МТРН" },
    { id: "supply-coverage", group: "Обеспеченность", title: "Обеспеченность следующего года", test: `< ${T.coverageBad * 100}% — плохо, < ${T.coverageWarn * 100}% — внимание` },
    { id: "supply-ppm", group: "Обеспеченность", title: "Закупка не видит потребность", test: "строки «Начиная с деблок.» с непокрытым остатком" },
    { id: "supply-order-now", group: "Обеспеченность", title: "Успеем, если заказать сейчас", test: "дефицит, который ещё закрывается заказом" },
    { id: "supply-too-late", group: "Обеспеченность", title: "Заказом уже не успеть", test: "дефицит с опозданием или прошедшим сроком" },
    { id: "supply-move", group: "Обеспеченность", title: "Возможность перемещения", test: "запас другой площадки сверх её потребности (ограничено)" },
    { id: "budget-overrun", group: "Бюджет", title: "Перерасход по заказам", test: `факт > плана × ${T.overrunRatio} и > ${T.overrunMin / 1000} тыс. ₽` },
    { id: "budget-correction", group: "Бюджет", title: "Корректировки бюджета", test: "ТРКБ (нужна) или ОТКБ (отклонена)" },
    { id: "budget-next-approved", group: "Бюджет", title: "Бюджет следующего года", test: "доля плановых заказов с утверждённым бюджетом (ТКБЕ/УТВП)" },
    { id: "budget-unspent", group: "Бюджет", title: "Риск неосвоения", test: "начало заказа наступило, факта нет: > 10% плана — внимание, > 25% — плохо" },
    { id: "fleet-ktg", group: "Техника", title: "КТГ ниже плана", test: `факт текущего года ниже плана более чем на ${T.ktgGap * 100} п.п.` },
    { id: "fleet-concentration", group: "Техника", title: "Концентрация затрат", test: `один борт > ${T.concentration * 100}% факта 2024 – текущего года` },
  ];

  const pctTxt = v => (v == null ? "—" : `${Math.round(v * 100)}%`);
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  }
  const ord = n => `${n} ${plural(n, "заказ", "заказа", "заказов")}`;
  const mln = v => `${(v / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: v < 1e7 ? 1 : 0 })} млн ₽`;

  function conclusions(m) {
    const out = [];
    const add = (id, level, text, evidence, go) => {
      const r = RULES.find(x => x.id === id);
      out.push({ id, group: r.group, title: r.title, test: r.test, level, text, evidence: evidence || [], go: go || null });
    };
    const Y = m.exec.years, cur = m.asOf.slice(0, 4), next = String(+cur + 1);
    // Исполнение
    ["2024", "2025"].forEach(y => {
      const t = Y[y];
      if (!t.plan) return;
      const lvl = t.exec < T.execLow ? "warn" : t.exec > T.execHigh ? "warn" : "ok";
      add("exec-closed", lvl, `${y}: исполнено ${pctTxt(t.exec)} плана${t.exec > T.execHigh ? " — факт выше плана" : t.exec < T.execLow ? " — недовыполнение" : ""}.`,
        [{ label: `план ${y}`, value: t.plan }, { label: `факт ${y}`, value: t.fact }, { label: "исполнение", value: t.exec, kind: "pct" }], { tab: "repairs" });
    });
    const tc = Y[cur];
    if (tc.plan) {
      const gap = m.elapsed - (tc.exec || 0);
      add("exec-pace", gap > T.paceGap ? "bad" : gap > T.paceGap / 2 ? "warn" : "ok",
        `${cur}: освоено ${pctTxt(tc.exec)} плана при ${pctTxt(m.elapsed)} прошедшего года; по заказам с началом до ${m.asOf.slice(5, 7)}.${cur} — ${pctTxt(m.execCtl.execDue)}.`,
        [{ label: "план года", value: tc.plan }, { label: "факт", value: tc.fact }, { label: "доля года", value: m.elapsed, kind: "pct" },
         { label: "план к дате", value: m.execCtl.dueToDate }, { label: "факт к дате", value: m.execCtl.factDueToDate }], { tab: "control" });
      const re = m.execCtl.releasedEmpty, reShare = ratio(re.plan, tc.plan);
      if (re.n) add("exec-released-empty", reShare > T.releasedEmptyShare ? "bad" : "warn",
        `${ord(re.n)} ${cur} на ${mln(re.plan)} ${plural(re.n, 'деблокирован', 'деблокированы', 'деблокированы')}, но без факта и подтверждений (${pctTxt(reShare)} плана).`,
        [{ label: "заказов", value: re.n, kind: "n" }, { label: "план", value: re.plan }, { label: "доля плана", value: reShare, kind: "pct" }], { tab: "control" });
      else add("exec-released-empty", "ok", "Нет деблокированных заказов без факта.", []);
      const co = m.execCtl.closeOverdue;
      add("exec-close-overdue", co.n ? "warn" : "ok",
        co.n ? `${ord(co.n)} на ${mln(co.plan)}: базисный конец прошёл более ${T.closeLagDays} дней назад, заказ не закрыт технически.` : "Просроченных закрытий нет.",
        [{ label: "заказов", value: co.n, kind: "n" }, { label: "план", value: co.plan }], { tab: "control" });
      const rc = m.execCtl.readyToClose;
      add("exec-ready-close", rc.n ? "info" : "ok",
        rc.n ? `${ord(rc.n)} с ФХСМ (факт проведён) ${plural(rc.n, 'ждёт', 'ждут', 'ждут')} технического закрытия.` : "Все заказы с проведённым фактом закрыты.",
        [{ label: "заказов", value: rc.n, kind: "n" }, { label: "план", value: rc.plan }], { tab: "control" });
    }
    const tails = ["2024", "2025"].map(y => ({ y, ...m.execCtl.tails[y] })).filter(t => t.n);
    add("exec-tails", tails.length ? "warn" : "ok",
      tails.length ? tails.map(t => `${t.y}: ${ord(t.n)} на ${mln(t.plan)} не ${plural(t.n, 'закрыт', 'закрыты', 'закрыты')} технически`).join("; ") + " (статус на дату годовой выгрузки)." : "Хвостов прошлых лет нет.",
      tails.flatMap(t => [{ label: `заказов ${t.y}`, value: t.n, kind: "n" }, { label: `план ${t.y}`, value: t.plan }]), { tab: "control" });
    // Планирование
    const pc = m.plan.curYear;
    if (pc.plan) {
      const ap = pc.groups["Согласование"], share = ratio(ap, GROUPS.reduce((s2, k) => s2 + pc.groups[k], 0));
      add("plan-approving", share > T.approvingShareLate ? "warn" : "ok",
        `${cur}: на согласовании ${mln(ap)} (${pctTxt(share)} плана групп 100/200) — ${ord(pc.groupN["Согласование"])}.`,
        [{ label: "на согласовании", value: ap }, { label: "доля", value: share, kind: "pct" }], { tab: "control" });
    }
    const P = m.plan;
    if (P.nextPlan) add("plan-next-approved", P.approvedShare < T.nextYearApprovedMin ? "warn" : "ok",
      `${next}: согласовано (СГГС и дальше) ${pctTxt(P.approvedShare)} плана в заказах (${mln(P.approvedPlan)} из ${mln(P.nextPlan)}).`,
      [{ label: "план в заказах", value: P.nextPlan }, { label: "согласовано", value: P.approvedPlan }, { label: "доля", value: P.approvedShare, kind: "pct" }], { tab: "control" });
    if (P.noOrder.n) add("plan-no-order", "info",
      `${next}: ${P.noOrder.n} ${plural(P.noOrder.n, "позиция", "позиции", "позиций")} графика ППР на ${mln(P.noOrder.plan)} без заказа SAP — в план и потребность не входят.`,
      [{ label: "позиций", value: P.noOrder.n, kind: "n" }, { label: "сумма", value: P.noOrder.plan }], { tab: "control" });
    const nr = m.plan.notReleasedStarted;
    add("plan-not-released-started", nr.n ? "warn" : "ok",
      nr.n ? `${ord(nr.n)} ${cur} на ${mln(nr.plan)}: базисное начало уже прошло, а заказ не деблокирован.` : "Все начавшиеся заказы деблокированы.",
      [{ label: "заказов", value: nr.n, kind: "n" }, { label: "план", value: nr.plan }], { tab: "control" });
    const acc = P.accuracy["2025"];
    if (acc && acc.n) add("plan-accuracy", acc.share < 0.5 ? "warn" : "ok",
      `2025: факт в пределах ±${T.planAccuracyTol * 100}% плана у ${pctTxt(acc.share)} закрытых заказов (${acc.ok} из ${acc.n}); закрыто без факта — ${acc.noFactN}.`,
      [{ label: "закрытых заказов", value: acc.n, kind: "n" }, { label: "в пределах ±20%", value: acc.ok, kind: "n" }, { label: "доля", value: acc.share, kind: "pct" }], { tab: "control" });
    const un = m.plan.unplanned["2025"];
    if (un && un.fact) add("plan-unplanned", un.share > T.unplannedShare ? "warn" : "ok",
      `2025: внеплановые работы (AVS1) — ${pctTxt(un.share)} факта (${mln(un.unplannedFact)}).`,
      [{ label: "факт 2025", value: un.fact }, { label: "внеплановые", value: un.unplannedFact }, { label: "доля", value: un.share, kind: "pct" }], { tab: "control" });
    const mtrn = P.materials.find(x => x.code === "МТРН");
    add("plan-materials", mtrn.n ? "warn" : "ok",
      mtrn.n ? `${mtrn.n} ${plural(mtrn.n, 'открытый заказ', 'открытых заказа', 'открытых заказов')} на ${mln(mtrn.plan)} ${plural(mtrn.n, 'содержит', 'содержат', 'содержат')} МТР без цены (МТРН) — план занижен.` : "МТР без цены нет.",
      [{ label: "заказов", value: mtrn.n, kind: "n" }, { label: "план", value: mtrn.plan }], { tab: "control" });
    // Обеспеченность
    const pv = m.prov.byYear[next];
    if (pv && pv.value) add("supply-coverage", pv.coverage < T.coverageBad ? "bad" : pv.coverage < T.coverageWarn ? "warn" : "ok",
      `${next}: обеспечено к сроку ${pctTxt(pv.coverage)} потребности (${mln(pv.covered)} из ${mln(pv.value)}), не покрыто ${mln(pv.uncovered)}.`,
      [{ label: "потребность", value: pv.value }, { label: "обеспечено", value: pv.covered }, { label: "не покрыто", value: pv.uncovered }, { label: "обеспеченность", value: pv.coverage, kind: "pct" }], { tab: "provision" });
    const onR = m.prov.ppm[next + "|onRelease"];
    if (onR && onR.uncovered > 0) add("supply-ppm", "bad",
      `${next}: ${mln(onR.value)} потребности «Начиная с деблок.» закупка не видит до деблокирования; из них не покрыто ${mln(onR.uncovered)}.`,
      [{ label: "потребность", value: onR.value }, { label: "не покрыто", value: onR.uncovered }], { tab: "provision" });
    const f = m.prov.feasible;
    add("supply-order-now", f.inTime > 0 ? "info" : "ok",
      f.inTime > 0 ? `${mln(f.inTime)} дефицита ещё закрывается заказом, если разместить его сейчас.` : "Дефицита, который ещё успевает заказ, нет.",
      [{ label: "успеем", value: f.inTime }], { tab: "sum" });
    const late = f.late3 + f.lateMore + f.past;
    add("supply-too-late", late > 0 ? "bad" : "ok",
      late > 0 ? `${mln(late)} дефицита заказом уже не закрыть: опоздание до 3 мес. ${mln(f.late3)}, больше 3 мес. ${mln(f.lateMore)}, срок прошёл ${mln(f.past)} — аналоги, перенос или ремонт узла.` : "Опаздывающего дефицита нет.",
      [{ label: "до 3 мес.", value: f.late3 }, { label: "> 3 мес.", value: f.lateMore }, { label: "срок прошёл", value: f.past }], { tab: "provision" });
    if (m.prov.total.transferPotential > 0) add("supply-move", "info",
      `До ${mln(m.prov.total.transferPotential)} непокрытой потребности есть на других площадках. Перемещение ограничено: в обеспеченность не входит, это возможность её улучшить.`,
      [{ label: "возможность", value: m.prov.total.transferPotential }, { label: "обеспеченность", value: m.prov.total.coverage, kind: "pct" },
       { label: "с перемещением", value: m.prov.total.coverageWithMove, kind: "pct" }], { tab: "analytics" });
    // Бюджет
    const B = m.budget, ov = B.overrun[cur], ov25 = B.overrun["2025"];
    const ovTotal = (ov ? ov.value : 0) + (ov25 ? ov25.value : 0);
    add("budget-overrun", ovTotal > 0 ? "warn" : "ok",
      ovTotal > 0 ? `Перерасход по заказам: 2025 — ${ord(ov25.n)} на ${mln(ov25.value)}, ${cur} — ${ord(ov.n)} на ${mln(ov.value)} сверх плана.` : "Перерасхода по заказам нет.",
      [{ label: "2025", value: ov25 ? ov25.value : 0 }, { label: cur, value: ov ? ov.value : 0 }], { tab: "control" });
    const corr = [...B.statusCur, ...B.statusNext].filter(x => (x.code === "ТРКБ" || x.code === "ОТКБ") && x.n);
    add("budget-correction", corr.length ? "warn" : "ok",
      corr.length ? corr.map(x => `${x.code}: ${ord(x.n)} на ${mln(x.plan)}`).join("; ") + "." : "Запросов на корректировку и отказов нет.",
      corr.map(x => ({ label: x.code, value: x.plan })), { tab: "control" });
    const tk = B.statusNext.find(x => x.code === "ТКБЕ"), up = B.statusNext.find(x => x.code === "УТВП");
    if (tk && (tk.plan || up.plan || m.plan.plannedPlan)) add("budget-next-approved", (tk.share || 0) < 0.5 ? "info" : "ok",
      `${next}: бюджет утверждён ТК БЕ (ТКБЕ) для ${pctTxt(tk.share || 0)} плана плановых заказов, в программе и бюджете (УТВП) — ${pctTxt(up.share || 0)}.`,
      [{ label: "ТКБЕ", value: tk.plan }, { label: "УТВП", value: up.plan }], { tab: "control" });
    if (tc.plan) add("budget-unspent", B.riskShare > 0.25 ? "bad" : B.riskShare > 0.1 ? "warn" : "ok",
      `${cur}: ${mln(B.riskUnspent)} плана (${pctTxt(B.riskShare)}, ${ord(B.riskN)}) — базисное начало наступило, а факта нет. Ещё ${mln(B.ahead)} без факта приходится на заказы с началом до конца года.`,
      [{ label: "наступило, без факта", value: B.riskUnspent }, { label: "доля плана", value: B.riskShare, kind: "pct" }, { label: "впереди", value: B.ahead }], { tab: "control" });
    // Техника
    const kb = m.ktg.below;
    add("fleet-ktg", kb.length ? "warn" : "ok",
      kb.length ? `КТГ ${cur} ниже плана более чем на ${T.ktgGap * 100} п.п.: ${kb.slice(0, 5).map(r => `${r.unit.replace("Экскаватор электрический ", "")} (${pctTxt(r[cur].fact)} при плане ${pctTxt(r[cur].plan)})`).join(", ")}.` : "Все борта в контексте держат план КТГ.",
      kb.slice(0, 5).map(r => ({ label: r.unit.replace("Экскаватор электрический ", ""), value: r[cur].fact - r[cur].plan, kind: "pp" })), { tab: "fleet" });
    const factYears = YEARS.filter(y => y <= cur);
    const units = m.exec.byUnit.map(u => ({ unit: u.key, fact: factYears.reduce((s, y) => s + u.years[y].fact, 0) }))
      .sort((a, b) => b.fact - a.fact);
    const tot = sum(units, u => u.fact);
    if (units.length > 1 && tot) {
      const top = units[0], sh = top.fact / tot;
      add("fleet-concentration", sh > T.concentration ? "warn" : "ok",
        `${top.unit.replace("Экскаватор электрический ", "")}: ${pctTxt(sh)} факта ${factYears[0]}–${cur} (${mln(top.fact)} из ${mln(tot)}).`,
        [{ label: "борт", value: top.fact }, { label: "всего", value: tot }, { label: "доля", value: sh, kind: "pct" }], { tab: "repairs" });
    }
    const order = { bad: 0, warn: 1, info: 2, ok: 3 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  /* ---------- сверки: разрезы сходятся к итогам ---------- */
  function checks(m, src, ctx) {
    const out = [];
    const near = (a, b, tol = 1) => Math.abs(N(a) - N(b)) <= tol;
    const add = (label, ok, detail) => out.push({ label, ok: !!ok, detail });
    YEARS.forEach(y => {
      const t = m.exec.years[y];
      const g = GROUPS.reduce((s, k) => s + t.groups[k], 0);
      add(`${y}: сумма стадий = план + позиции ППР + исключённое копиями`, near(g, t.plan + t.noOrderPlan + t.copyExcluded, 2),
        `${Math.round(g)} = ${Math.round(t.plan + t.noOrderPlan + t.copyExcluded)}`);
      const sites = m.exec.bySite.reduce((s, x) => s + x.years[y].plan, 0);
      add(`${y}: сумма площадок = итог`, near(sites, t.plan, 2), `${Math.round(sites)} = ${Math.round(t.plan)}`);
      add(`${y}: МТР + УСО = итог (план и факт)`, near(t.mtrPlan + t.usoPlan, t.plan, 2) && near(t.mtrFact + t.usoFact, t.fact, 2), "");
    });
    // цепочка согласования — оценка планирования, только группы 100/200: сверяется с планом тех же групп
    const nx = m.plan.nextYear, cu = m.exec.years[m.execCtl.year];
    const chainOrders = m.plan.chain.slice(1).reduce((s, c) => s + c.plan, 0);
    add(`${m.plan.next}: цепочка согласования = план года + позиции ППР (группы 100/200)`, near(chainOrders, nx.plan, 2) && near(m.plan.chain[0].plan, nx.noOrderPlan, 2),
      `${Math.round(chainOrders)} = ${Math.round(nx.plan)}`);
    const fun = m.execCtl.funnel.reduce((s, f) => s + f.plan, 0), funF = m.execCtl.funnel.reduce((s, f) => s + f.fact, 0);
    add(`${m.execCtl.year}: воронка исполнения = план и факт года`, near(fun, cu.plan, 2) && near(funF, cu.fact, 2), `${Math.round(fun)} = ${Math.round(cu.plan)}`);
    const sc = m.execCtl.sCurve, last = sc[sc.length - 1] || { planCum: 0, factCum: 0 };
    add(`${m.execCtl.year}: S-кривая на декабрь = план и факт года`, near(last.planCum, cu.plan, 2) && near(last.factCum, cu.fact, 2), `${Math.round(last.planCum)} = ${Math.round(cu.plan)}`);
    if (!ctx || !ctx.site) {
      const st = m.stock.bySite.reduce((s, x) => s + N(x.value), 0);
      add("Запасы: сумма площадок = итог склада", near(st, m.stock.value, 5), `${Math.round(st)} = ${Math.round(m.stock.value)}`);
    }
    const p = m.prov.total;
    add("Обеспеченность: склад + закупка + опоздание + без срока + не покрыто = потребность",
      near(p.fromStock + p.fromBuy + p.late + p.undated + p.gap, p.value, 5), `${Math.round(p.value)}`);
    add("Возможность перемещения не больше непокрытого", p.transferPotential <= p.uncovered + 1, "");
    const segSum = p.seg.own + p.seg.buy + p.seg.late + p.seg.pot + p.seg.gap;
    add("Сегменты графика обеспеченности = потребность", near(segSum, p.value, 5), "");
    const ppmSum = Object.values(m.prov.ppm).reduce((s, x) => s + x.value, 0);
    add("Признак ППМ: сумма строк = потребность", near(ppmSum, p.value, 5), "");
    // группы 100/200 + службы БЕ = весь план года
    const ps = m.planScope;
    YEARS.forEach(y => {
      const t = m.exec.years[y], all = t.plan + t.noOrderPlan;
      add(`${y}: план групп «Развития» + служб БЕ = план года`, near(ps.allPlan[y], all, 2), `${Math.round(ps.allPlan[y])} = ${Math.round(all)}`);
    });
    const noCtx = !ctx || !(ctx.site || ctx.model || ctx.unit || ctx.order || ctx.pg);
    if (noCtx && src.provision.meta && src.provision.meta.wk) {
      const w = src.provision.meta.wk;
      add("Потребность = итог витрины обеспеченности", near(p.value, w.value, 5) && near(p.gap, w.gap, 5), `${Math.round(w.value)}`);
      const f = src.provision.meta.feasible || {};
      const fe = m.prov.feasible;
      add("«Успеем / не успеем» = расчёт витрины", ["inTime", "late3", "lateMore", "past"].every(k => near(fe[k], (f[k] || {}).value || 0, 5)), "");
      const ex = src.provision.execution || [];
      ["2026", "2027"].forEach(y => {
        const a = ex.filter(r => String(r.year) === y);
        const plan = a.reduce((s, r) => s + N(r.plan), 0);
        const t = m.exec.years[y];
        add(`${y}: план по стадиям совпадает с provision.execution`, near(plan, t.plan + t.noOrderPlan + t.copyExcluded, 5), `${Math.round(plan)}`);
      });
    }
    return out;
  }


  /* ---------- слайды презентации (build/build_wk_status_data.py) в контексте фильтров ---------- */
  const shortUnit = u => String(u || "").replace("Экскаватор электрический ", "");
  function deck(src, ctx, m) {
    m = m || buildModel(src, ctx);
    const fleet = src.fleet, cur = m.asOf.slice(0, 4), next = String(+cur + 1);
    const unitSite = new Map(fleet.units.map(u => [u.name, u.site]));
    const avgPos = a => { const v = a.filter(x => x > 0); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    const months = fleet.meta.months;
    const units = fleet.units.filter(u => (!ctx || ((!ctx.site || u.site === ctx.site) && (!ctx.model || u.model === ctx.model) && (!ctx.unit || u.name === ctx.unit))));
    const factYears = YEARS.filter(y => y < next);
    // КТГ: по борту — среднее положительных месяцев года; площадка — среднее помесячных средних
    const ktgUnit = {};
    units.forEach(u => {
      ktgUnit[shortUnit(u.name)] = Object.fromEntries(factYears.map(y => {
        const idx = months.map((mm, i) => [mm, i]).filter(([mm]) => mm.startsWith(y)).map(([, i]) => i);
        return [y, { plan: avgPos(idx.map(i => u.ktgByMonth[i])), fact: avgPos(idx.map(i => u.kioByMonth[i])) }];
      }));
    });
    const sites = [...new Set(units.map(u => u.site))].sort();
    const siteMonth = {}, siteYear = {};
    sites.forEach(st => {
      const us = units.filter(u => u.site === st);
      siteMonth[st] = { plan: months.map((_, i) => avgPos(us.map(u => u.ktgByMonth[i]))), fact: months.map((_, i) => avgPos(us.map(u => u.kioByMonth[i]))) };
      siteYear[st] = Object.fromEntries(factYears.map(y => [y, {
        plan: avgPos(months.map((mm, i) => (mm.startsWith(y) ? siteMonth[st].plan[i] : null)).filter(v => v != null)),
        fact: avgPos(months.map((mm, i) => (mm.startsWith(y) ? siteMonth[st].fact[i] : null)).filter(v => v != null)) }]));
    });
    const fleetMonth = { plan: months.map((_, i) => avgPos(units.map(u => u.ktgByMonth[i]))), fact: months.map((_, i) => avgPos(units.map(u => u.kioByMonth[i]))) };
    // исполнение: по борту / модели / виду работ / статье
    const years = t => Object.fromEntries(YEARS.map(y => [y, t.years[y]]));
    const unitY = Object.fromEntries(m.exec.byUnit.map(u => [shortUnit(u.key), years(u)]));
    const modelY = Object.fromEntries(m.exec.byModel.map(x => [x.key, years(x)]));
    const siteY = Object.fromEntries(m.exec.bySite.map(x => [x.key, years(x)]));
    const pair = t => Object.fromEntries(YEARS.map(y => [y, [N(t[y] && t[y].plan), N(t[y] && t[y].fact)]]));
    const work = Object.fromEntries(m.exec.byWork.map(w => [w.key, pair(w.years)]));
    const reason = Object.fromEntries(m.exec.byReason.map(w => [w.key, pair(w.years)]));
    // обеспеченность по площадке борта и по борту
    const pv0 = () => ({ value: 0, fromStock: 0, fromBuy: 0, late: 0, undated: 0, gap: 0, transferPotential: 0, orders: 0 });
    const provSite = {}, provUnit = {};
    (src.provision.orders || []).filter(o => inContext(o, ctx)).forEach(o => {
      const st = unitSite.get(o.unit) || o.site, y = String((o.years || [])[0] || (o.date || "").slice(0, 4));
      for (const t of [((provSite[st] = provSite[st] || {})[y] = provSite[st][y] || pv0()),
                       ((provUnit[shortUnit(o.unit)] = provUnit[shortUnit(o.unit)] || {})[y] = provUnit[shortUnit(o.unit)][y] || pv0())]) {
        t.orders += 1;
        for (const k of ["value", "fromStock", "fromBuy", "late", "undated", "gap", "transferPotential"]) t[k] += N(o[k]);
      }
    });
    // критичные позиции и «заказать сегодня»: весь парк — по позициям витрины, в контексте — по строкам контекста
    const items = src.provision.items || [], noCtx = !ctx || !(ctx.site || ctx.model || ctx.unit || ctx.order || ctx.pg);
    const itemBy = new Map(items.map(i => [String(i.code), i]));
    let deficit, orderToday, orderTodaySum, orderTodayN;
    if (noCtx) {
      deficit = items.slice().sort((a, b) => N(b.gapValue) - N(a.gapValue)).slice(0, 12);
      const ot = items.filter(i => N(i.canOrder) > 0).sort((a, b) => b.canOrder - a.canOrder);
      orderToday = ot.slice(0, 10); orderTodaySum = ot.reduce((s, i) => s + i.canOrder, 0); orderTodayN = ot.length;
    } else {
      deficit = Object.entries(m.prov.lineCode).map(([code, x]) => ({ ...(itemBy.get(String(code)) || { code, name: "" }), gapValue: x.gapValue, needQty: x.needQty }))
        .filter(x => x.gapValue > 0).sort((a, b) => b.gapValue - a.gapValue).slice(0, 12);
      const ot = Object.entries(m.prov.feasCode).map(([code, v]) => ({ ...(itemBy.get(String(code)) || { code, name: "" }), canOrder: v,
        gapValue: (m.prov.lineCode[code] || {}).gapValue || 0 })).filter(x => x.canOrder > 0).sort((a, b) => b.canOrder - a.canOrder);
      orderToday = ot.slice(0, 10); orderTodaySum = ot.reduce((s, i) => s + i.canOrder, 0); orderTodayN = ot.length;
    }
    // материалы: факт 2024–2026 и план следующего года по коду (строки графика)
    let topFact = null, topPlan = null;
    if (src.scheduleRows) {
      const st = new Map((src.controlRows || decodeControl(src.control)).map(r => [r.y + "|" + r.order, r.stage]));
      const mat = new Map();
      src.scheduleRows.forEach(r => {
        if (!YEARS.includes(r.year) || !r.code) return;
        const row = { site: unitSite.get(r.unit) || r.site, model: r.model, unit: r.unit, order: r.order };
        if (!inContext(row, ctx)) return;
        let x = mat.get(r.code);
        if (!x) mat.set(r.code, (x = { code: r.code, name: "", fact: 0, plan27: 0, qf: 0, qp27: 0, units: new Set() }));
        if (r.name && r.name.length > x.name.length) x.name = r.name;
        const stage = st.get(r.year + "|" + r.order);
        if (r.year < next) { x.fact += N(r.a); x.qf += N(r.qf); }
        else if (stage && stage !== "unknown" && stage !== "noOrder") { x.plan27 += N(r.p); x.qp27 += N(r.qp); x.units.add(shortUnit(r.unit)); }
      });
      const arr = [...mat.values()].map(x => ({ ...x, units: x.units.size }));
      topFact = arr.slice().sort((a, b) => b.fact - a.fact).slice(0, 12);
      topPlan = arr.slice().sort((a, b) => b.plan27 - a.plan27).slice(0, 12);
    }
    // запасы по складам
    const WH = (src.stock.meta && src.stock.meta.warehouses) || {};
    const whV = {};
    (src.stock.items || []).forEach(i => Object.entries(i.byWarehouseValue || {}).forEach(([w, v]) => { whV[w] = (whV[w] || 0) + N(v); }));
    const byWarehouse = Object.entries(whV).filter(([w]) => !ctx || !ctx.site || (WH[w] || {}).site === ctx.site)
      .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w, v]) => ({ key: w, name: (WH[w] || {}).name || w, value: v, site: (WH[w] || {}).site || "", plant: (WH[w] || {}).plant || "", kind: (WH[w] || {}).kind || "" }));
    // закупка (общая, к площадке не привязана)
    const asOfMonth = m.asOf.slice(0, 7), needCodes = new Set(items.map(i => String(i.code)));
    const pur = (src.stock.items || []).filter(i => i.purchase);
    const purchase = { items: pur.length, openQty: 0, transitQty: 0, overdue: 0, undated: 0, byMonth: {}, lead: [], needCodes: pur.filter(i => needCodes.has(String(i.code))).length };
    pur.forEach(i => {
      const p = i.purchase;
      purchase.openQty += N(p.openQty); purchase.transitQty += N(p.transitQty);
      Object.entries(p.byMonth || {}).forEach(([mm, q]) => {
        purchase.byMonth[mm || "без даты"] = (purchase.byMonth[mm || "без даты"] || 0) + N(q);
        if (!mm) purchase.undated += N(q); else if (mm < asOfMonth) purchase.overdue += N(q);
      });
      if (p.leadDays) purchase.lead.push(p.leadDays);
    });
    purchase.lead.sort((a, b) => a - b);
    purchase.leadMedian = purchase.lead.length ? purchase.lead[Math.floor(purchase.lead.length / 2)] : null;
    purchase.leadHist = {};
    purchase.lead.forEach(d => { const k = Math.min(Math.floor(d / 90), 5); purchase.leadHist[k] = (purchase.leadHist[k] || 0) + 1; });
    purchase.leadN = purchase.lead.length;
    delete purchase.lead;
    // МТР подрядчика по площадке борта
    const uso = {};
    ((src.usoWk && src.usoWk.orders) || []).forEach(o => {
      const st = unitSite.get(o.unit) || o.site;
      if (!inContext({ site: st, model: o.model, unit: o.unit, order: o.order }, ctx) || !YEARS.includes(String(o.year))) return;
      const t = ((uso[st] = uso[st] || {})[o.year] = uso[st][o.year] || { plan: 0, fact: 0, open: 0, orders: 0, closed: 0 });
      const u = usoStatus(o);   // состав — реестр, статус и факт — заказ ТОРО
      t.plan += u.plan; t.fact += u.sapFact; t.open += u.open; t.orders += 1; t.closed += u.closed ? 1 : 0;
    });
    return {
      cur, next, factYears, units: units.map(u => ({ unit: shortUnit(u.name), site: u.site, model: u.model, book: u.book || "" })),
      ktg: { months, unit: ktgUnit, siteMonth, siteYear, fleetMonth },
      total: m.exec.years, site: siteY, unit: unitY, model: modelY, work, reason,
      prov: { byYear: m.prov.byYear, site: provSite, unit: provUnit, ppm: m.prov.ppm, feasible: m.prov.feasible, total: m.prov.total,
              moves: m.prov.moves, moveTop: m.prov.moveTop, deficit, orderToday, orderTodaySum, orderTodayN,
              leadMedianDays: (src.provision.meta || {}).leadMedianDays },
      topFact, topPlan,
      stock: { sites: (src.stock.meta && src.stock.meta.sites) || {}, total: m.stock.value, restricted: m.stock.restrictedValue, byWarehouse },
      purchase, uso,
    };
  }

  /* МТР подрядчика (УСО) по заказу. Реестр МТР УСО задаёт состав: материал, количество, цену и сумму (план);
     его «Стоимость факт» — плановая цена в валюте по курсу, не факт. Статус — стадия заказа ТОРО того же года
     (иначе — последнего года заказа): не закрыт заказ ТОРО — не закрыто и УСО. Факт — строка PM-06
     «ТОиР. Материалы подрядчика» (uf), план в заказе SAP — up. */
  function usoStatus(o) {
    const rs = CTL_OF.get(String(o.order)) || [];
    const same = rs.filter(r => String(r.y) === String(o.year));
    const use = same.length ? same : rs.filter(r => r.y === rs.reduce((m, x) => (x.y > m ? x.y : m), ""));
    const main = use.find(r => !r.copy) || use[0];
    const stage = main ? main.stage : "";
    const closed = CLOSED.has(stage);
    const plan = N(o.planValue != null ? o.planValue : (o.lines || []).reduce((x, l) => x + N(l.p), 0));
    return { stage, closed, year: main ? main.y : "", plan, open: closed ? 0 : plan,
             sapPlan: use.reduce((x, r) => x + N(r.up), 0), sapFact: use.reduce((x, r) => x + N(r.uf), 0) };
  }

  return { YEARS, STAGES, GROUP, GROUPS, T, RULES, DEV_GROUPS, PG_NAMES, isDevGroup, pgMatch, pgOfOrder, usoStatus, CLOSED, planScope, decodeControl, inContext, byYear, execution, deck,
           executionControl, planningControl, budgetControl, provision, stockView, ktgView,
           buildModel, conclusions, checks, yearElapsed };
})();

if (typeof module !== "undefined" && module.exports) module.exports = AnalyticsCore;
