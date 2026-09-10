/**
 * CitySim — the whole simulation, with no three.js and no DOM in sight.
 *
 * It owns:
 *   · the clock (when nobody else is driving it)
 *   · population, households and the job market   (Population)
 *   · every spatial field                          (Fields)
 *   · the budget                                   (Economy)
 *   · RCI demand                                   (Demand)
 *   · the daily rhythm                             (Rhythm)
 *   · rolling series                               (History)
 *
 * The tick contract: a fixed 20 Hz step that does one bounded slice of citizen
 * work and one bounded field phase, plus O(1) bookkeeping. Everything expensive
 * — hiring passes, service planning, field rebuilds — happens on an explicit
 * `rebuild()`, which is an event-driven, off-peak call.
 *
 * Determinism: every random draw comes from the injected `Rng`. `Math.random`
 * appears nowhere. Two runs from the same seed with the same event order
 * produce the same numbers.
 */

import { FieldGrid } from './Grid.js';
import { Population } from './Population.js';
import { Fields } from './Fields.js';
import { Economy } from './Economy.js';
import { DemandModel } from './Demand.js';
import { Rhythm } from './Rhythm.js';
import { History } from './History.js';
import {
  STATE, SERVICES, SERVICE_INDEX, CELL_SIZE, SEED_FILL,
  IMMIGRATION_MAX_DAY, EMIGRATION_MAX_DAY, COMMUTE_TOLERANCE_MIN,
  SLICE_MIN, SLICE_MAX, SLICE_TARGET_TICKS, FIELD_PHASES,
  HIRE_BASE, HIRE_VACANCY_GAIN, JOB_CHURN,
  TAX_NEUTRAL, clamp, clamp01, smoothstep,
} from './constants.js';

const HOURS_PER_TICK = 0.05 / 60;      // 1 in-game minute per real second at speed 1
const DAYS_PER_MONTH = 30;

export class CitySim {
  constructor(world, rng, opts = {}) {
    this.world = world;
    this.rng = rng;
    this.log = opts.log || { info() {}, warn() {}, error() {} };
    this.emit = opts.emit || (() => {});

    const size = (world.terrain && world.terrain.size) || 2048;
    this.grid = new FieldGrid(size, opts.cellSize || CELL_SIZE);
    this.pop = new Population(rng, this.grid);
    this.fields = new Fields(this.grid, rng);
    this.econ = new Economy(world.stats?.budget ?? 100000);
    this.demand = new DemandModel();
    this.rhythm = new Rhythm();
    this.history = new History();

    this.api = {};                  // {traffic, roads, zoning, terrain}
    this.tickCount = 0;
    this.phase = 0;
    this.day = world.time?.day | 0;
    this.hourBucket = Math.floor(world.time?.hours ?? 13);
    this.lastMonthDay = 0;
    this.clockDrive = false;        // set by the module; see index.js
    this.driveTraffic = true;       // …and cleared during another module's showcase
    this.extClockHold = 0;
    this._lastSeenHours = world.time?.hours ?? 13;
    this.built = false;
    this.happiness = 0.5;
    this.commuteMin = 0;
    this.trafficIndex = 0;
    this.tickMs = 0; this.tickMsEma = 0; this.tickMsMax = 0;
    this.centre = [0, 0]; this.radius = 400;
    this._densityPushed = -1;
    this._daily = { births: 0, deaths: 0, in: 0, out: 0 };
    this._emitEvery = 20;           // sim:tick at 1 Hz
  }

  attach(api) { this.api = api || {}; return this; }

  /* ==================================================================== */
  /* build                                                                */
  /* ==================================================================== */

  /**
   * (Re)derive everything that depends on the city's geometry.
   * Safe to call whenever roads or buildings change; citizens survive it.
   */
  rebuild(reason = 'init') {
    const t0 = now();
    const world = this.world;

    this.fields.rebuildRoads(world, this.api.roads);
    const info = this.pop.setBuildings(world.buildings);
    const bb = this.fields.rebuildBuildings(this.pop);

    // the city centre, used by the centrality term, is the job-weighted centroid
    let sx = 0, sz = 0, sw = 0;
    for (let i = 0; i < this.pop.nb; i++) {
      const w = this.pop.bJobs[i] * 2 + this.pop.bCap[i];
      sx += this.pop.bX[i] * w; sz += this.pop.bZ[i] * w; sw += w;
    }
    if (sw > 0) this.centre = [sx / sw, sz / sw];
    this.radius = bb.valid ? Math.max(140, Math.hypot(bb.x1 - bb.x0, bb.z1 - bb.z0) * 0.32) : 400;

    // water reads as amenity; ask terrain if it is there
    this._waterMask = this._buildWaterMask();

    this.fields.planServices(this.pop, { maxPer: 4 });

    if (!this.built && this.pop.capTotal > 0) {
      this.pop.seed(SEED_FILL, this.day, this.fields.landValue);
      this.built = true;
    } else if (this.built) {
      this.pop.hireAll(this.fields.congestion);
    }

    // prime the fields so the very first frame is not a flat grey plate
    for (let k = 0; k < 3; k++) this._refreshAllFields();
    this._hourly(true);

    this.buildMs = now() - t0;
    this.log.info(`rebuilt (${reason})`, {
      buildings: info.buildings, housing: info.capacity, jobs: info.jobs,
      population: this.pop.count, installations: this.fields.installations.length,
      laneKm: +(this.fields.laneKm || 0).toFixed(2), ms: Math.round(this.buildMs),
    });
    return this.stats();
  }

  _buildWaterMask() {
    const t = this.api.terrain;
    const g = this.grid;
    const m = g.field();
    const level = this.world.terrain?.water ?? 0;
    if (!t || typeof t.heightAt !== 'function') return null;
    let any = false;
    for (let j = 0; j < g.h; j++) {
      for (let i = 0; i < g.w; i++) {
        const hgt = t.heightAt(g.cx(i), g.cz(j));
        if (hgt <= level + 0.4) { m[j * g.w + i] = 1; any = true; }
      }
    }
    if (!any) return null;
    g.blur(m, 2, 1);
    for (let i = 0; i < m.length; i++) m[i] = clamp01(m[i] * 1.6);
    return m;
  }

  _refreshAllFields() {
    for (let p = 0; p < FIELD_PHASES; p++) this._fieldPhase(p);
  }

  /* ==================================================================== */
  /* the tick                                                             */
  /* ==================================================================== */

  tick(dt = 0.05) {
    const t0 = now();
    this.tickCount++;

    this._advanceClock(dt);

    /* --- amortised citizen slice ------------------------------------- */
    if (this.built && this.pop.count > 0) {
      const slice = clamp(Math.ceil(this.pop.count / SLICE_TARGET_TICKS), SLICE_MIN, SLICE_MAX);
      this.pop.stepSlice(slice, this.day, this._sliceEnv());
    }

    /* --- one field phase --------------------------------------------- */
    this._fieldPhase(this.phase);
    this.phase = (this.phase + 1) % FIELD_PHASES;

    /* --- periodic publishing ----------------------------------------- */
    if (this.tickCount % this._emitEvery === 0) {
      this._publishStats();
      this.emit('sim:tick', { tick: this.tickCount, stats: this.world.stats });
    }

    const ms = now() - t0;
    this.tickMs = ms;
    this.tickMsEma = this.tickMsEma * 0.94 + ms * 0.06;
    if (ms > this.tickMsMax) this.tickMsMax = ms;
    return ms;
  }

  _sliceEnv() {
    const env = this._env || (this._env = {});
    env.congestion = this.fields.congestion;
    env.value = this.fields.landValue;
    env.eduQuality = this.fields.coverage[SERVICE_INDEX.education];
    env.mortality = this.econ.bankrupt ? 1.25 : 1;
    env.churn = JOB_CHURN;
    env.commuteQuit = COMMUTE_TOLERANCE_MIN * 2.4;
    env.birthScale = this.econ.bankrupt ? 0.4 : 1;
    env.hiring = true;
    // how easy it is to find work depends on how many vacancies there are
    env.hireChance = HIRE_BASE + HIRE_VACANCY_GAIN * clamp01(this.pop.jobVacancy() * 3);
    return env;
  }

  /* ---------------------------------------------------------- clock --- */

  /**
   * Advance `world.time` — but only when nobody else is.
   *
   * `environment` also advances the hour in its own tick (and owns the
   * `time:changed` emit). Two modules driving one clock would double its speed,
   * so this watches for external movement and stands down for a second whenever
   * it sees any. When it *is* driving, it emits `time:changed` itself so the
   * modules that listen keep working with no environment present.
   */
  _advanceClock(dt) {
    const t = this.world.time;
    const moved = Math.abs(t.hours - this._lastSeenHours) > 1e-9;
    if (moved) this.extClockHold = 30;
    else if (this.extClockHold > 0) this.extClockHold--;

    const drive = this.clockDrive && this.extClockHold === 0;
    if (drive) {
      t.hours += (dt / 0.05) * HOURS_PER_TICK;
      while (t.hours >= 24) { t.hours -= 24; t.day++; }
    }
    this._lastSeenHours = t.hours;

    const day = t.day | 0;
    const bucket = Math.floor(t.hours);
    if (day !== this.day) {
      const skipped = day - this.day;
      this.day = day;
      this._daily.births = this.pop.births; this._daily.deaths = this.pop.deaths;
      this._dailyStep();
      if (day - this.lastMonthDay >= DAYS_PER_MONTH) {
        this.lastMonthDay = day;
        this.settle();
      }
      if (drive) this.emit('sim:day', { day, weekend: this.rhythm.weekend });
      void skipped;
    }
    if (bucket !== this.hourBucket) {
      this.hourBucket = bucket;
      this._hourly(false);
      if (drive) this.emit('time:changed', { hours: t.hours, day: t.day });
    }
  }

  /* --------------------------------------------------------- hourly --- */

  _hourly(force) {
    const pop = this.pop, f = this.fields, world = this.world;
    pop.classTotals();
    this.commuteMin = pop.meanCommute(384);

    /* congestion index published by traffic, tolerant of both shapes */
    const tstat = world.stats.traffic;
    this.trafficIndex = typeof tstat === 'number' ? tstat
      : (tstat && typeof tstat.index === 'number' ? tstat.index : 0);

    this.demand.update(pop, f, this.econ, {
      commuteMin: this.commuteMin,
      bankrupt: this.econ.bankrupt,
    });

    this.happiness = this._happiness();

    /* daily rhythm → traffic density + occupancy */
    const employRate = pop.workforce > 0 ? pop.employed / pop.workforce : 0;
    const scale = clamp(0.45 + Math.sqrt(Math.max(0, pop.count)) / 55, 0.35, 1.6);
    this.rhythm.update(world.time.hours, this.day, 0.35 + 0.65 * employRate, scale);
    this._pushTrafficDensity();

    this._publishStats();
    this.history.push({
      population: pop.count,
      households: pop.hcount,
      jobs: pop.jobsTotal,
      employed: pop.employed,
      unemployment: pop.unemployment(),
      budget: this.econ.budget,
      income: this.econ.last.income.total,
      expense: this.econ.last.expense.total,
      demandR: this.demand.r, demandC: this.demand.c, demandI: this.demand.i,
      landValue: f.stats.landValueMean,
      pollution: f.stats.pollutionMean,
      coverage: f.stats.coverageMean,
      traffic: this.trafficIndex,
      commute: this.commuteMin,
      happiness: this.happiness,
    }, this.day, world.time.hours);

    this.emit('sim:demand', {
      demand: this.demand.value(),
      terms: this.demand.terms,
      grid: { w: this.grid.w, h: this.grid.h, cellSize: this.grid.cellSize, origin: this.grid.origin },
      pressure: { r: f.pressureR, c: f.pressureC, i: f.pressureI },
      top: f.topPressure(8),
      budget: Math.round(this.econ.budget),
      bankrupt: this.econ.bankrupt,
    });
    this.emit('sim:rhythm', {
      hours: world.time.hours, day: this.day, weekend: this.rhythm.weekend,
      occupancy: { ...this.rhythm.occupancy },
      trafficDensity: +this.rhythm.trafficDensity.toFixed(3),
      activity: +this.rhythm.activity.toFixed(3),
    });
    void force;
  }

  _happiness() {
    const pop = this.pop, f = this.fields;
    const employ = pop.workforce > 0 ? pop.employed / pop.workforce : 0.5;
    const commute = 1 - smoothstep(COMMUTE_TOLERANCE_MIN * 0.5, COMMUTE_TOLERANCE_MIN * 2.2, this.commuteMin);
    const service = clamp01(f.stats.coverageMean);
    const clean = 1 - clamp01(f.stats.pollutionMean);
    const value = clamp01(f.stats.landValueMean);
    const taxPain = clamp01((this.econ.tax.r - TAX_NEUTRAL) * 4.2);
    const crowd = 1 - clamp01(this.trafficIndex * 0.9);
    let h = 0.20 * employ + 0.18 * service + 0.16 * commute + 0.14 * clean
      + 0.12 * value + 0.10 * crowd + 0.10;
    h -= taxPain * 0.22;
    if (this.econ.bankrupt) h -= 0.20;
    return clamp01(h);
  }

  _pushTrafficDensity() {
    if (this.driveTraffic === false) return;
    const t = this.api.traffic;
    if (!t || typeof t.setDensity !== 'function') return;
    const d = +this.rhythm.trafficDensity.toFixed(2);
    if (Math.abs(d - this._densityPushed) < 0.04) return;
    this._densityPushed = d;
    try { t.setDensity(d); } catch (e) { void e; }
  }

  /* ---------------------------------------------------------- daily --- */

  _dailyStep() {
    const pop = this.pop, f = this.fields;
    if (!this.built) return;
    const vacancy = pop.capTotal > 0 ? 1 - pop.count / pop.capTotal : 0;
    const unemployment = pop.unemployment();
    const base = Math.max(40, pop.count);

    const pull = clamp01(this.demand.r * 1.15 + this.happiness * 0.35 - unemployment * 0.9
      - (this.econ.bankrupt ? 0.5 : 0));
    const inFrac = IMMIGRATION_MAX_DAY * pull * clamp01(vacancy * 3.2);
    let inflow = Math.round(inFrac * base);
    const room = Math.max(0, pop.capTotal - pop.count);
    inflow = Math.min(inflow, room);
    if (inflow > 0) pop.immigrate(inflow, this.day, f.landValue);

    const push = clamp01(unemployment * 1.7 + (1 - this.happiness) * 0.65
      - this.demand.r * 0.5 + (this.econ.bankrupt ? 0.35 : 0) - 0.30);
    const outflow = Math.round(EMIGRATION_MAX_DAY * push * base);
    if (outflow > 0) pop.emigrate(outflow, this.day);

    this._daily.in = pop.movedIn; this._daily.out = pop.movedOut;
  }

  /* -------------------------------------------------------- monthly --- */

  /** Run a settlement now. Returns the ledger. Never throws. */
  settle() {
    let led;
    try {
      led = this.econ.settle(this.pop, this.fields, this.world);
      const changed = this.econ.enforceBankruptcy(this.fields);
      if (changed) this.log.warn(this.econ.bankrupt
        ? `bankrupt — ${changed} service installation(s) shut down`
        : `solvent again — ${changed} installation(s) restored`);
      this.emit('sim:budget', { ledger: led, bankrupt: this.econ.bankrupt });
    } catch (err) {
      this.log.warn('settlement failed, budget unchanged:', err.message);
      led = this.econ.last;
    }
    return led;
  }

  /* ---------------------------------------------------- field phases --- */

  _fieldPhase(p) {
    const f = this.fields, pop = this.pop;
    switch (p) {
      case 0:
        f.updateCongestion(this.world.stats.traffic, this.api.traffic?.congestionAt);
        break;
      case 1: f.stepPollution(this.trafficIndex); break;
      case 2: case 3: case 4: case 5: case 6: case 7: case 8: {
        const occ = pop.capTotal > 0 ? clamp(pop.count / pop.capTotal, 0.05, 2) : 1;
        f.stepCoverage(p - 2, occ);
        break;
      }
      case 9: f.stepService(); break;
      case 10: f.stepAmenity(this._waterMask); break;
      case 11: f.stepLandValue(this.centre, this.radius); break;
      case 12: f.stepPressure(this.demand, pop); break;
      default: break;                    // spare phases keep the average cost low
    }
  }

  /* ==================================================================== */
  /* published state                                                      */
  /* ==================================================================== */

  _publishStats() {
    const w = this.world, pop = this.pop, f = this.fields;
    const s = w.stats;
    s.population = pop.count;
    s.jobs = pop.jobsTotal;
    s.happiness = +this.happiness.toFixed(3);
    s.budget = Math.round(this.econ.budget);
    if (!s.demand) s.demand = { r: 0, c: 0, i: 0 };
    s.demand.r = +this.demand.r.toFixed(3);
    s.demand.c = +this.demand.c.toFixed(3);
    s.demand.i = +this.demand.i.toFixed(3);
    // `traffic` is the traffic module's slice — never written here.
    s.sim = {
      day: this.day,
      hours: +w.time.hours.toFixed(3),
      weekend: this.rhythm.weekend,
      households: pop.hcount,
      employed: pop.employed,
      unemployed: pop.byState[STATE.UNEMPLOYED],
      workforce: pop.workforce,
      students: pop.byState[STATE.STUDENT],
      retired: pop.byState[STATE.RETIRED],
      children: pop.byState[STATE.CHILD],
      unemployment: +pop.unemployment().toFixed(4),
      housingCapacity: pop.capTotal,
      housingVacancy: +pop.vacancy().toFixed(4),
      jobsFilled: pop.jobsFilled,
      jobVacancy: +pop.jobVacancy().toFixed(4),
      commuteMin: +this.commuteMin.toFixed(2),
      landValue: +f.stats.landValueMean.toFixed(4),
      pollution: +f.stats.pollutionMean.toFixed(4),
      coverage: f.coverageMeans(),
      coverageMean: +f.stats.coverageMean.toFixed(4),
      occupancy: {
        res: +this.rhythm.occupancy.res.toFixed(3),
        office: +this.rhythm.occupancy.office.toFixed(3),
        retail: +this.rhythm.occupancy.retail.toFixed(3),
        ind: +this.rhythm.occupancy.ind.toFixed(3),
      },
      trafficDensity: +this.rhythm.trafficDensity.toFixed(3),
      economy: {
        month: this.econ.month,
        income: this.econ.last.income.total,
        expense: this.econ.last.expense.total,
        net: this.econ.last.net,
        bankrupt: this.econ.bankrupt,
        tax: { ...this.econ.tax },
      },
      tickMs: +this.tickMsEma.toFixed(4),
    };
  }

  stats() { this._publishStats(); return JSON.parse(JSON.stringify(this.world.stats.sim)); }

  /* ==================================================================== */
  /* queries                                                              */
  /* ==================================================================== */

  landValueAt(x, z) { return this.grid.sample(this.fields.landValue, x, z); }

  coverageAt(kind, x, z) {
    if (kind === undefined) return this.fields.coverageMeans();
    const k = SERVICE_INDEX[kind];
    if (k === undefined) return 0;
    if (x === undefined) return this.fields._cover[k];
    return this.grid.sample(this.fields.coverage[k], x, z);
  }

  growthPressureAt(x, z, zone) {
    const f = this.fields, g = this.grid;
    const r = g.sample(f.pressureR, x, z);
    const c = g.sample(f.pressureC, x, z);
    const i = g.sample(f.pressureI, x, z);
    if (zone) return zone === 'r' ? r : zone === 'c' ? c : zone === 'i' ? i : 0;
    const best = r >= c && r >= i ? 'r' : c >= i ? 'c' : 'i';
    return { r, c, i, best, value: Math.max(r, c, i) };
  }

  pollutionAt(x, z) { return clamp01(this.grid.sample(this.fields.pollution, x, z) * 1.6); }
  accessAt(x, z) { return this.grid.sample(this.fields.access, x, z); }

  populationOf(id) {
    if (id === undefined || id === null) return this.pop.count;
    if (typeof id === 'object') {
      // {x,z,r} — residents within a radius
      const x = id.x ?? 0, z = id.z ?? 0, r = id.r ?? 100, r2 = r * r;
      let n = 0;
      for (let s = 0; s < this.pop.nb; s++) {
        if (this.pop.bCap[s] === 0) continue;
        const dx = this.pop.bX[s] - x, dz = this.pop.bZ[s] - z;
        if (dx * dx + dz * dz <= r2) n += this.pop.bOcc[s];
      }
      return n;
    }
    return this.pop.residentsOf(id);
  }

  /* ==================================================================== */
  /* fast-forward (verification + showcase preroll)                       */
  /* ==================================================================== */

  /**
   * Run `hours` of simulated time at full tick fidelity. Used by showcases to
   * settle the city before a shot, and by the numeric self-test.
   */
  advanceHours(hours, dt = 0.05) {
    const ticks = Math.max(0, Math.round(hours / HOURS_PER_TICK));
    const prevDrive = this.clockDrive, prevHold = this.extClockHold;
    this.clockDrive = true; this.extClockHold = 0;
    for (let k = 0; k < ticks; k++) {
      this.tick(dt);
      this.extClockHold = 0;         // we are the clock for the duration
    }
    this.clockDrive = prevDrive;
    this.extClockHold = prevHold;
    this._lastSeenHours = this.world.time.hours;
    return ticks;
  }

  advanceDays(days) { return this.advanceHours(days * 24); }
}

/** performance.now() where it exists, a monotonic fallback where it does not. */
const now = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Number(process.hrtime.bigint() / 1000n) / 1000;

export { SERVICES };
export default CitySim;
