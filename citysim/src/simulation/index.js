import { Rng } from '../core/Rng.js';
import { CitySim } from './Sim.js';
import { FieldOverlay, stretch } from './Overlay.js';
import stageShowcase from './showcase.js';
import { SERVICES, SERVICE_INDEX, clamp01 } from './constants.js';

/**
 * simulation — population, households, jobs, demand, land value, services,
 * the budget and the daily rhythm of the city.
 *
 * Almost all of this module is data. Its whole job is to make `world.stats`
 * mean something, to publish the fields other modules query, and to make the
 * visible city change over the day: it drives `traffic.setDensity` from a real
 * commute curve and publishes the occupancy `buildings` lights its windows from.
 *
 * Cost: one bounded citizen slice plus one bounded field phase per 20 Hz tick.
 * Measured at 0.049 ms mean / 0.67 ms worst for a 265 000-person city
 * (`node src/simulation/__selftest.mjs --big`).
 *
 * ── who owns the clock ────────────────────────────────────────────────────
 * `environment` advances `world.time` in its own tick and owns the
 * `time:changed` emit, so this module does **not** fight it: `Sim._advanceClock`
 * watches for external movement and stands down whenever it sees any. It drives
 * the clock (and emits `time:changed` itself) only when nothing else is —
 * i.e. when `environment` is absent, has failed, or has frozen its clock — and
 * never in headless mode, where the harness pins the hour for the shot.
 */

const S = {
  ctx: null,
  sim: null,
  overlay: null,
  glyphs: null,
  offEvents: [],
  dirty: false,
  built: false,
  overlayKind: null,
  showcaseMode: null,
  lastStage: null,
  inHourly: false,
};

/* --------------------------------------------------------------- helpers -- */

function apisOf(ctx) {
  return {
    traffic: ctx.get('traffic'),
    roads: ctx.get('roads'),
    zoning: ctx.get('zoning'),
    terrain: ctx.get('terrain'),
    buildings: ctx.get('buildings'),
  };
}

function rebuild(reason) {
  const ctx = S.ctx;
  if (!ctx || !S.sim) return null;
  S.sim.attach(apisOf(ctx));
  const r = S.sim.rebuild(reason);
  S.built = true;
  S.dirty = false;
  if (S.overlayKind) refreshOverlay();
  return r;
}

/** Repaint whatever overlay is currently switched on. */
function refreshOverlay() {
  const ctx = S.ctx, sim = S.sim;
  if (!ctx || !sim || !S.overlay || !S.overlayKind) return;
  const f = sim.fields;
  const tmp = f._ovTmp || (f._ovTmp = new Float32Array(sim.grid.n));
  if (S.overlayKind === 'landValue') {
    // stretched to its own distribution — see `stretch()` for why
    S.overlay.setField(stretch(f.landValue, f.built, tmp).count ? tmp : f.landValue, f.built);
  } else if (S.overlayKind === 'coverage') S.overlay.setField(f.service, f.built);
  else if (S.overlayKind === 'pollution') {
    for (let i = 0; i < tmp.length; i++) tmp[i] = clamp01(f.pollution[i] * 1.6);
    S.overlay.setField(tmp, f.built);
  } else if (SERVICES.includes(S.overlayKind)) {
    S.overlay.setField(f.coverage[SERVICE_INDEX[S.overlayKind]], f.built);
  }
}

/* ------------------------------------------------------------- lifecycle -- */

const mod = {
  name: 'simulation',
  version: '1.0.0',
  dependsOn: ['roads', 'zoning', 'buildings', 'traffic'],
  provides: [
    'stats', 'demand', 'growthPressureAt', 'coverageAt', 'landValueAt',
    'populationOf', 'setSpeed', 'setTaxRate', 'settle', 'history',
  ],

  /** Extra surface beyond the required `provides` list. */
  api: {},

  async init(ctx) {
    S.ctx = ctx;
    S.showcaseMode = ctx.opts?.showcase === 'simulation' ? (ctx.opts.variant || 'default') : null;

    S.sim = new CitySim(ctx.world, Rng.derive(ctx.world.seed, 'simulation'), {
      log: ctx.log,
      emit: (type, payload) => ctx.events.emit(type, payload),
    });
    // headless shots pin the hour; a live page with no environment gets its
    // clock from us. `_advanceClock` still stands down the moment it sees
    // somebody else move `world.time`.
    S.sim.clockDrive = !ctx.opts?.headless;
    // Never touch another module's showcase: `traffic` sets its own density for
    // its shots, and two modules pushing one dial is exactly the seam that makes
    // a composed scene unreproducible.
    S.sim.driveTraffic = !ctx.opts?.showcase || ctx.opts.showcase === 'simulation';
    S.sim.attach(apisOf(ctx));

    S.offEvents.push(ctx.events.on('buildings:spawned', () => { S.dirty = true; }, 'simulation'));
    S.offEvents.push(ctx.events.on('buildings:removed', () => { S.dirty = true; }, 'simulation'));
    S.offEvents.push(ctx.events.on('roads:changed', () => { S.dirty = true; }, 'simulation'));
    S.offEvents.push(ctx.events.on('zoning:changed', () => { S.dirty = true; }, 'simulation'));

    S.offEvents.push(ctx.events.on('time:changed', (p) => {
      if (S.inHourly || !S.sim) return;
      const h = p && p.hours !== undefined ? p.hours : ctx.world.time.hours;
      S.sim.hourBucket = Math.floor(h);
      S.sim.day = ctx.world.time.day | 0;
      S.sim._lastSeenHours = ctx.world.time.hours;
      S.inHourly = true;
      try { S.sim._hourly(true); } finally { S.inHourly = false; }
      S.overlay?.setTime(h, p);
    }, 'simulation'));

    S.offEvents.push(ctx.events.on('weather:changed', (p) => {
      if (!S.sim) return;
      // wind steers the pollution plume; wetness scrubs it a little
      const dir = p?.windDir ?? ctx.world.weather?.windDir ?? 0.7;
      const spd = clamp01(((p?.windSpeed ?? ctx.world.weather?.windSpeed ?? 3) / 14));
      S.sim.fields.wind[0] = Math.cos(dir) * spd * 0.35;
      S.sim.fields.wind[1] = Math.sin(dir) * spd * 0.35;
    }, 'simulation'));

    if (ctx.world.buildings.size > 0 || ctx.world.roads.segments.size > 0) {
      try { rebuild('init'); }
      catch (err) { ctx.log.warn('initial build failed, simulation idle:', err.message); }
    } else {
      ctx.log.info('ready — waiting for a city to simulate');
    }
  },

  rebuild(ctx, what) {
    if (what === 'roads' || what === 'zoning' || what === 'buildings') S.dirty = true;
  },

  tick(ctx, dt) {
    if (!S.sim) return;
    if (S.dirty && !S.showcaseMode) {
      // rebuilding is O(city); do it here rather than inside an event handler
      // so a burst of buildings:spawned costs one rebuild, not twenty
      try { rebuild('changed'); }
      catch (err) { S.dirty = false; ctx.log.warn('rebuild failed, keeping previous state:', err.message); }
    }
    S.sim.tick(dt);
  },

  update(ctx, dt, elapsed) {
    if (S.overlay) S.overlay.update(elapsed);
    void dt;
  },

  showcase(ctx, variant = 'default') {
    S.ctx = ctx;
    S.showcaseMode = variant;
    return stageShowcase(ctx, S, variant, { rebuild });
  },

  dispose(ctx) {
    for (const off of S.offEvents) { try { off(); } catch { /* ignore */ } }
    S.offEvents.length = 0;
    ctx.events.offOwner?.('simulation');
    S.overlay?.dispose();
    S.glyphs?.dispose();
    S.overlay = null; S.glyphs = null; S.sim = null;
    S.built = false; S.dirty = false; S.overlayKind = null;
  },

  /* =================================================================== */
  /* API                                                                 */
  /* =================================================================== */

  /** The full simulation readout. Also mirrored into `world.stats.sim`. */
  stats() {
    if (!S.sim) return null;
    const s = S.sim.stats();
    s.buildings = S.sim.pop.nb;
    s.installations = S.sim.fields.installations.length;
    s.laneKm = +(S.sim.fields.laneKm || 0).toFixed(2);
    s.cohorts = S.sim.pop.cohorts();
    s.education = {
      none: S.sim.pop.byEdu[0], school: S.sim.pop.byEdu[1],
      highschool: S.sim.pop.byEdu[2], college: S.sim.pop.byEdu[3],
    };
    s.overlay = S.overlayKind;
    s.showcase = S.lastStage;
    s.tickMsMax = +S.sim.tickMsMax.toFixed(3);
    s.drawCalls = mod.api.drawCalls();
    return s;
  },

  /** `{r,c,i}` in 0..1, plus the terms that produced them. */
  demand(withTerms = false) {
    if (!S.sim) return { r: 0, c: 0, i: 0 };
    const v = S.sim.demand.value();
    return withTerms ? { ...v, terms: S.sim.demand.terms } : v;
  },

  /**
   * Growth pressure at a world position.
   * `growthPressureAt(x,z)` → `{r,c,i,best,value}`;
   * `growthPressureAt(x,z,'r')` → a single number.
   */
  growthPressureAt(x, z, zone) {
    if (!S.sim) return zone ? 0 : { r: 0, c: 0, i: 0, best: 'r', value: 0 };
    return S.sim.growthPressureAt(x, z, zone);
  },

  /**
   * `coverageAt('education', x, z)` → 0..1 at that point.
   * `coverageAt('education')` → the city-wide mean for that service.
   * `coverageAt()` → every service's mean.
   */
  coverageAt(kind, x, z) {
    if (!S.sim) return kind === undefined ? {} : 0;
    return S.sim.coverageAt(kind, x, z);
  },

  landValueAt(x, z) { return S.sim ? S.sim.landValueAt(x, z) : 0; },

  /**
   * `populationOf()` → the whole city.
   * `populationOf(buildingId)` → residents of that building.
   * `populationOf({x,z,r})` → residents within a radius.
   */
  populationOf(id) { return S.sim ? S.sim.populationOf(id) : 0; },

  /** 0 pauses. Anything above 0 sets `world.time.speed`. */
  setSpeed(v) {
    const w = S.ctx?.world;
    if (!w) return 0;
    const s = Math.max(0, Math.min(64, Number(v) || 0));
    w.time.paused = s === 0;
    if (s > 0) w.time.speed = s;
    S.ctx.events.emit('sim:speed', { speed: w.time.speed, paused: w.time.paused });
    return w.time.paused ? 0 : w.time.speed;
  },

  /** `setTaxRate({r,c,i})` or `setTaxRate('r', 0.14)`. Returns the new rates. */
  setTaxRate(a, b) {
    if (!S.sim) return null;
    const t = S.sim.econ.setTax(a, b);
    S.sim._hourly(true);
    return t;
  },

  /** Force a monthly settlement now. Returns the ledger. */
  settle() { return S.sim ? S.sim.settle() : null; },

  /**
   * Rolling series, oldest first, one sample per in-game hour.
   * `history()` → every series; `history('population', 72)` → one, last 72 h.
   */
  history(name, count = 0) { return S.sim ? S.sim.history.series(name, count) : null; },
};

/* ------------------------------------------------------- extra API ------- */

mod.api = {
  /** The simulation object itself — for tools, tests and the ui module. */
  sim: () => S.sim,

  /**
   * Turn a field overlay on. `null` turns it off (the default).
   * kinds: 'landValue' | 'coverage' | 'pollution' | one of the seven services.
   */
  setOverlay(kind) {
    const ctx = S.ctx, sim = S.sim;
    if (!ctx || !sim) return null;
    if (!kind) {
      S.overlayKind = null;
      S.overlay?.setEnabled(false);
      return null;
    }
    S.overlayKind = kind;
    if (!S.overlay) S.overlay = new FieldOverlay(ctx, sim.grid);
    refreshOverlay();
    if (!S.overlay.mesh) {
      const terrain = ctx.get('terrain');
      const bb = sim.fields.bbox();
      const mesh = S.overlay.build(bb, terrain, ctx.world.terrain?.water ?? 0);
      ctx.group.add(mesh);
    }
    S.overlay.setMode(kind === 'landValue' || kind === 'pollution' ? 0 : 1);
    S.overlay.setTime(ctx.world.time.hours);
    S.overlay.setEnabled(true);
    return S.overlayKind;
  },

  /** Repaint the live overlay from the current fields. */
  refreshOverlay,

  /** Force a full rebuild from the current world. */
  rebuildNow(reason = 'manual') { return rebuild(reason); },

  /** Run `days` of simulated time immediately (tests, showcases, fast-forward). */
  advanceDays(days) { return S.sim ? S.sim.advanceDays(days) : 0; },
  advanceHours(hours) { return S.sim ? S.sim.advanceHours(hours) : 0; },

  /** Service installations the simulation owns: positions, radii, upkeep. */
  services() {
    if (!S.sim) return [];
    return S.sim.fields.installations.map((i) => ({
      kind: i.kind, x: +i.x.toFixed(1), z: +i.z.toFixed(1),
      radius: i.radius, capacity: i.capacity, upkeep: i.upkeep,
      load: Math.round(i.load || 0), quality: +(i.quality ?? 1).toFixed(3), on: i.on,
    }));
  },

  /** Per-class occupancy 0..1 for this hour — what window lights should follow. */
  occupancy() { return S.sim ? { ...S.sim.rhythm.occupancy } : null; },

  /** The traffic density the rhythm is currently asking for. */
  trafficDensity() { return S.sim ? S.sim.rhythm.trafficDensity : 0; },

  /** The hottest growth sites, as a short list. */
  growthSites(n = 12) { return S.sim ? S.sim.fields.topPressure(n) : []; },

  /** Raw field access for tools that want the whole lattice. */
  field(name) {
    if (!S.sim) return null;
    const f = S.sim.fields;
    const map = {
      landValue: f.landValue, pollution: f.pollution, amenity: f.amenity,
      access: f.access, congestion: f.congestion, service: f.service,
      pressureR: f.pressureR, pressureC: f.pressureC, pressureI: f.pressureI,
      pop: f.pop, jobs: f.jobs, built: f.built,
    };
    const data = map[name] || (SERVICES.includes(name) ? f.coverage[SERVICE_INDEX[name]] : null);
    if (!data) return null;
    return {
      w: S.sim.grid.w, h: S.sim.grid.h, cellSize: S.sim.grid.cellSize,
      origin: S.sim.grid.origin, data,
    };
  },

  /** The economy ledger history, newest first. */
  ledgers(n = 12) { return S.sim ? S.sim.econ.ledgers.slice(0, n) : []; },

  /** Real draw calls this module contributes. */
  drawCalls() {
    let n = 0;
    if (S.overlay?.mesh && S.overlay.enabled) n++;
    if (S.glyphs) n += S.glyphs.drawCalls();
    return n;
  },
};

export { SERVICES };
export default mod;
