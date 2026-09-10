/**
 * One guarded read of the world per refresh.
 *
 * Every other module is optional: `ctx.get()` returns null for a module that is
 * absent or FAILED, and every field here has a defined value in that case, so a
 * panel never has to ask whether something exists — it asks whether the value is
 * finite. The snapshot object is allocated once and mutated in place.
 */

export const WATCHED = [
  'terrain', 'environment', 'roads', 'zoning', 'buildings',
  'props', 'traffic', 'simulation', 'effects', 'tools', 'demo',
];

export function makeState() {
  return {
    modules: {},            // name -> 'ok' | 'failed' | 'absent' | 'pending'
    failed: [],
    hours: 13, day: 0, speed: 1, paused: false,
    population: NaN, jobs: NaN, happiness: NaN, budget: NaN,
    demand: { r: NaN, c: NaN, i: NaN },
    traffic: NaN, vehicles: NaN, worstTraffic: NaN,
    unemployment: NaN, households: NaN, employed: NaN,
    housingVacancy: NaN, jobVacancy: NaN, commute: NaN,
    landValue: NaN, pollution: NaN, coverage: NaN,
    services: {},           // per-service coverage means
    net: NaN, income: NaN, expense: NaN, bankrupt: false, month: 0,
    buildings: NaN, lots: NaN, roadKm: NaN,
    weekend: false,
    hasSim: false, hasZoning: false, hasTraffic: false, hasDemo: false,
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/** Traffic is published as an object `{index,…}` but was once a plain number. */
export function trafficIndex(t) {
  if (t && typeof t === 'object') return num(t.index);
  return num(t);
}

export function readState(ctx, S) {
  const world = ctx.world || {};

  /* --- module health -------------------------------------------------- */
  let states = null;
  try { states = ctx.engine?.host?.states?.() || null; } catch { states = null; }
  S.failed.length = 0;
  for (const name of WATCHED) {
    const e = states ? states[name] : undefined;
    const st = e ? e.state : 'absent';
    S.modules[name] = st;
    if (st === 'failed') S.failed.push(name);
  }

  const api = (name) => {
    try { return ctx.get(name); } catch { return null; }
  };
  const sim = api('simulation');
  const zon = api('zoning');
  const traf = api('traffic');
  const bld = api('buildings');
  S.hasSim = !!sim; S.hasZoning = !!zon; S.hasTraffic = !!traf; S.hasDemo = !!api('demo');

  /* --- clock ---------------------------------------------------------- */
  const t = world.time || {};
  S.hours = num(t.hours);
  S.day = num(t.day) || 0;
  S.speed = num(t.speed) || 1;
  S.paused = !!t.paused;

  /* --- headline numbers ----------------------------------------------- */
  const st = world.stats || {};
  S.population = num(st.population);
  S.jobs = num(st.jobs);
  S.happiness = num(st.happiness);
  S.budget = num(st.budget);
  const d = st.demand || {};
  S.demand.r = num(d.r); S.demand.c = num(d.c); S.demand.i = num(d.i);
  S.traffic = trafficIndex(st.traffic);
  S.vehicles = st.traffic && typeof st.traffic === 'object' ? num(st.traffic.vehicles) : NaN;
  S.worstTraffic = st.traffic && typeof st.traffic === 'object' ? num(st.traffic.worst) : NaN;

  /* --- the simulation's own slice ------------------------------------- */
  const ss = st.sim || null;
  if (ss) {
    S.unemployment = num(ss.unemployment);
    S.households = num(ss.households);
    S.employed = num(ss.employed);
    S.housingVacancy = num(ss.housingVacancy);
    S.jobVacancy = num(ss.jobVacancy);
    S.commute = num(ss.commuteMin);
    S.landValue = num(ss.landValue);
    S.pollution = num(ss.pollution);
    S.coverage = num(ss.coverageMean);
    S.services = ss.coverage || {};
    S.weekend = !!ss.weekend;
    const e = ss.economy || {};
    S.net = num(e.net); S.income = num(e.income); S.expense = num(e.expense);
    S.bankrupt = !!e.bankrupt; S.month = num(e.month) || 0;
  } else {
    S.unemployment = NaN; S.households = NaN; S.employed = NaN;
    S.housingVacancy = NaN; S.jobVacancy = NaN; S.commute = NaN;
    S.landValue = NaN; S.pollution = NaN; S.coverage = NaN; S.services = {};
    S.net = NaN; S.income = NaN; S.expense = NaN; S.bankrupt = false;
  }

  /* --- city size ------------------------------------------------------- */
  S.buildings = world.buildings ? world.buildings.size : NaN;
  try { S.lots = zon && zon.lots ? zon.lots().length : NaN; } catch { S.lots = NaN; }
  try {
    let m = 0;
    if (world.roads?.segments) for (const s of world.roads.segments.values()) m += s.length || 0;
    S.roadKm = m > 0 ? m / 1000 : NaN;
  } catch { S.roadKm = NaN; }

  void bld; void traf;
  return S;
}

/** `simulation.history()` — the whole bundle, or null if there is no sim yet. */
export function readHistory(ctx) {
  try {
    const sim = ctx.get('simulation');
    if (!sim || typeof sim.history !== 'function') return null;
    const h = sim.history();
    if (!h || !h.population || h.population.length < 2) return null;
    return h;
  } catch { return null; }
}

export default readState;
