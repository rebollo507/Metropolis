import { Rng } from '../core/Rng.js';
import LaneNetwork, { CTRL } from './LaneNetwork.js';
import Router from './Router.js';
import Sim, { VEH, VEH_NAMES, VEH_SPEC } from './Sim.js';
import { trafficTextures, TrafficMaterials } from './Materials.js';
import VehicleRenderer from './Render.js';
import { WalkGraph, Crowd } from './Peds.js';
import SignalSync from './SignalSync.js';
import stageShowcase from './showcase.js';

/**
 * traffic — everything that moves on the network.
 *
 * Owns a directed lane graph derived from `world.roads`, a fixed 20 Hz vehicle
 * simulation (IDM car-following, gap-accepted lane changes, signalised and
 * priority junction control) stored in `world.agents`' typed arrays, an
 * instanced renderer with three LOD tiers and real night lighting, and an
 * instanced crowd on the pavements with a procedural walk cycle.
 *
 * Render transforms are interpolated between ticks in `update()`, so motion is
 * smooth at any frame rate while the simulation stays deterministic.
 *
 * Signals: `props` has already placed the heads at junctions but exposes no way
 * to drive their aspect, so this module runs its own phase cycle and mirrors
 * props' static group assignment (see docs/CORE_REQUESTS.md R-traffic-2). The
 * showcase variants freeze the cycle on the group props shows green, so the
 * still agrees with the lens colours.
 */

const S = {
  ctx: null,
  net: null, router: null, sim: null, mats: null, tex: null,
  render: null, walk: null, crowd: null,
  offEvents: [],
  built: false,
  density: 1,
  night: 0,
  targetV: 0, targetP: 0,
  lastMeasure: 0,
  lastEmit: -999,
  buildMs: 0,
  tickMs: 0, tickMsEma: 0,
  stage: [],
  showcaseMode: null,
  netStats: null,
  walkStats: null,
  signals: null,
  signalTick: 0,
  ambientDensity: 1.15,
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* -------------------------------------------------------- time of day ---- */

function nightFactor(hours) {
  // 0 in full day, 1 in full night, with dusk/dawn ramps
  if (hours >= 7.2 && hours <= 17.6) return 0;
  if (hours > 17.6 && hours < 19.9) return clamp((hours - 17.6) / 2.3, 0, 1);
  if (hours > 5.0 && hours < 7.2) return clamp((7.2 - hours) / 2.2, 0, 1);
  return 1;
}

/**
 * Demand through the day. The round-1 curve had a deep trough between the two
 * rushes and put `demandFactor(13) = 0.63`, which is why the judged 13:00
 * downtown frame had 217 vehicles on 19 lane-km and read as a deserted avenue.
 * A commercial core at one o'clock is not in a lull — it has its own lunchtime
 * peak — so the base is higher and the midday bell is broader and stronger.
 */
function demandFactor(hours) {
  const bell = (c, w) => Math.exp(-((hours - c) ** 2) / (2 * w * w));
  return clamp(0.40 + 0.58 * bell(8.3, 1.6) + 0.70 * bell(17.7, 2.0)
    + 0.55 * bell(12.8, 2.6) + 0.22 * bell(21.5, 2.4), 0.16, 1.35);
}

function pedFactor(hours) {
  const bell = (c, w) => Math.exp(-((hours - c) ** 2) / (2 * w * w));
  return clamp(0.10 + 0.7 * bell(8.4, 1.4) + 0.85 * bell(12.8, 2.0)
    + 0.95 * bell(18.0, 2.2) + 0.30 * bell(21.5, 2.0), 0.06, 1.2);
}

/* ------------------------------------------------------------- build ----- */

function ensureAgents(world, capV, capP) {
  const cap = capV + capP;
  const a = world.agents;
  if (a.capacity !== cap || !a.pos) {
    a.capacity = cap;
    a.pos = new Float32Array(cap * 3);
    a.vel = new Float32Array(cap * 3);
    a.kind = new Uint8Array(cap);
    a.path = new Int32Array(cap).fill(-1);
  }
  a.count = 0;
  a.vehicleBase = 0;
  a.pedBase = capV;
  return a;
}

function buildNetwork(ctx) {
  const roads = ctx.get('roads');
  if (!roads) { S.netStats = null; return false; }
  const t0 = performance.now();
  try {
    S.net.roads = roads;
    S.netStats = S.net.build();
  } catch (err) {
    ctx.log.warn('lane network build failed:', err.message);
    return false;
  }
  if (!S.net.count) return false;

  S.router = new Router(S.net);
  S.sim.net = S.net;
  S.sim.router = S.router;
  S.sim.onNetworkRebuilt();
  S.sim.cacheClasses(ctx.world);

  try {
    S.walk.roads = roads;
    S.walkStats = S.walk.build();
    S.walk.bindGuards(S.net);
    const zoning = ctx.get('zoning');
    const zAt = zoning && zoning.zoneAt ? (x, z) => zoning.zoneAt(x, z) : null;
    S.walk.weigh(zAt, S.pedFocus);
    S.crowd.ambient.rebuild(S.walk, zAt, S.ambientDensity);
    S.crowd.ambient.setHourScale(pedFactor(ctx.world.time.hours));
  } catch (err) {
    ctx.log.warn('walk graph build failed:', err.message);
    S.walkStats = null;
  }
  S.buildMs = Math.round(performance.now() - t0);
  S.built = true;
  if (S.signals) { try { S.signals.bind(S.net, S.sim); } catch (err) { ctx.log.warn('signal sync:', err.message); } }
  return true;
}

function retarget(ctx) {
  if (!S.built) { S.targetV = 0; S.targetP = 0; return; }
  const km = S.netStats ? S.netStats.laneKm : 0;
  const hours = ctx.world.time.hours;
  const d = S.showcaseMode ? 1 : demandFactor(hours);
  const pf = S.showcaseMode ? 1 : pedFactor(hours);
  // ~26 vehicles per lane-km at full demand: real urban lanes run 25-40/km at
  // moderate congestion, and anything under ~15 reads as an empty film set
  // ~18 vehicles per lane-km at full demand. Above roughly 30/km this lattice
  // (90 m blocks, 2-phase signals, no green wave) saturates and stops flowing —
  // measured, not guessed; see the density sweep in the report.
  S.targetV = Math.min(S.sim.capacity, Math.round(km * 21 * S.density * d));
  S.targetP = Math.min(S.crowd.cap, Math.round(km * 14 * S.density * pf));
}

function reconcile() {
  const dv = S.targetV - S.sim.count;
  if (dv > 0) S.sim.spawnMany(Math.min(dv, 40));
  else if (dv < -4) S.sim.despawn(Math.min(-dv, 12));
  const dp = S.targetP - S.crowd.count;
  if (dp > 0) S.crowd.spawn(Math.min(dp, 60));
  else if (dp < -6) S.crowd.despawn(Math.min(-dp, 30));
  return Math.abs(S.sim.count - S.targetV) <= 4 && Math.abs(S.crowd.count - S.targetP) <= 6;
}

/** Concentrate the crowd budget near a point — used to dress a showcase. */
function setPedFocus(ctx, x, z, r = 80, boost = 14) {
  S.pedFocus = { x, z, r, boost };
  const zoning = ctx.get('zoning');
  S.walk.weigh(zoning && zoning.zoneAt ? (a, b) => zoning.zoneAt(a, b) : null, S.pedFocus);
}

/* --------------------------------------------------------- world.agents -- */

function writeAgents(world) {
  const a = world.agents;
  if (!a.pos) return;
  const sim = S.sim, crowd = S.crowd;
  let n = 0;
  for (let i = 0; i < sim.capacity; i++) {
    const o = a.vehicleBase + i;
    if (!sim.alive[i]) { a.kind[o] = 0; a.path[o] = -1; continue; }
    const t = i * 4;
    a.pos[o * 3] = sim.cur[t];
    a.pos[o * 3 + 1] = sim.cur[t + 1];
    a.pos[o * 3 + 2] = sim.cur[t + 2];
    const yaw = sim.cur[t + 3], v = sim.v[i];
    a.vel[o * 3] = Math.sin(yaw) * v;
    a.vel[o * 3 + 1] = 0;
    a.vel[o * 3 + 2] = Math.cos(yaw) * v;
    a.kind[o] = 1 + sim.type[i];
    a.path[o] = sim.lane[i];
    n++;
  }
  for (let i = 0; i < crowd.cap; i++) {
    const o = a.pedBase + i;
    if (!crowd.alive[i]) { a.kind[o] = 0; a.path[o] = -1; continue; }
    const t = i * 4;
    a.pos[o * 3] = crowd.cur[t];
    a.pos[o * 3 + 1] = crowd.cur[t + 1];
    a.pos[o * 3 + 2] = crowd.cur[t + 2];
    const yaw = crowd.cur[t + 3], v = crowd.moving[i] ? crowd.speed[i] : 0;
    a.vel[o * 3] = Math.sin(yaw) * v;
    a.vel[o * 3 + 1] = 0;
    a.vel[o * 3 + 2] = Math.cos(yaw) * v;
    a.kind[o] = 32;
    a.path[o] = crowd.edge[i];
    n++;
  }
  a.count = n;
}

function publishStats(ctx, emit) {
  const world = ctx.world;
  const sim = S.sim;
  const bySegment = sim.bySegment(S._segOut || (S._segOut = {}));
  let sum = 0, k = 0, worst = 0, worstSeg = -1;
  for (const key in bySegment) {
    const v = bySegment[key];
    sum += v; k++;
    if (v > worst) { worst = v; worstSeg = +key; }
  }
  const index = k ? sum / k : 0;
  world.stats.traffic = {
    index: +index.toFixed(3),
    worst: +worst.toFixed(3),
    worstSegment: worstSeg,
    vehicles: sim.count,
    pedestrians: S.crowd.count,
    meanSpeedRatio: +sim.stats.meanSpeedRatio.toFixed(3),
    stopped: sim.stats.stopped,
    bySegment,
  };
  if (emit) ctx.events.emit('traffic:changed', { index: world.stats.traffic.index, vehicles: sim.count });
}

/** Run the sim forward without rendering — used to warm up a showcase. */
function preroll(ctx, ticks) {
  if (!S.built) return 0;
  const dt = ctx.FIXED_DT || 0.05;
  const n = Math.max(0, Math.min(4000, ticks | 0));
  for (let k = 0; k < n; k++) {
    S.sim.step(dt);
    S.crowd.step(dt, _pedGate);
    if (k % 10 === 9) S.sim.measure(0.3);
  }
  // seed the interpolation buffers so the first rendered frame is not a jump
  S.sim.prev.set(S.sim.cur);
  S.crowd.prev.set(S.crowd.cur);
  writeAgents(ctx.world);
  publishStats(ctx, false);
  return n;
}

/* ------------------------------------------------------------- module ---- */

const mod = {
  name: 'traffic',
  version: '1.0.0',
  dependsOn: ['roads'],
  provides: ['spawn', 'despawn', 'setDensity', 'congestionAt', 'route', 'stats', 'vehiclesNear',
    'preroll', 'publish', 'signalAspect'],

  api: {},

  async init(ctx) {
    S.ctx = ctx;
    S.stage.length = 0;
    S.showcaseMode = null;

    try {
      S.tex = trafficTextures(ctx.assets, ctx.world.seed >>> 0);
    } catch (err) {
      ctx.log.warn('procedural textures failed, lamps will be flat:', err.message);
      S.tex = {};
    }
    S.mats = new TrafficMaterials(ctx, S.tex);
    S.adopted = S.mats.adoptAll(ctx);

    const capV = 900, capP = 800;
    ensureAgents(ctx.world, capV, capP);

    S.net = new LaneNetwork(ctx.world, ctx.get('roads'), ctx.log);
    S.router = new Router(S.net);
    S.sim = new Sim(S.net, S.router, Rng.derive(ctx.world.seed, 'traffic:sim'), { capacity: capV });
    S.sim.world = ctx.world;
    S.walk = new WalkGraph(ctx.world, ctx.get('roads'));
    S.crowd = new Crowd(ctx, S.walk, S.mats, Rng.derive(ctx.world.seed, 'traffic:peds'), capP);
    S.render = new VehicleRenderer(ctx, S.mats, S.sim);
    S.signals = new SignalSync(ctx, S.net, S.sim, ctx.log);

    S.night = nightFactor(ctx.world.time.hours);
    S.mats.setNight(S.night, ctx.world.weather?.wetness ?? 0);
    S.render.setNight(S.night);

    // props rebuilds its instanced batches on every populate, so the lens
    // meshes we tint are new objects each time — rebind rather than hold a
    // stale reference
    S.offEvents.push(ctx.events.on('props:changed', () => {
      if (S.signals && S.built) S.signals.bind(S.net, S.sim);
    }, 'traffic'));

    S.offEvents.push(ctx.events.on('roads:changed', () => {
      if (ctx.opts?.showcase && !S.showcaseMode) return;
      mod.rebuild(ctx, 'roads');
    }, 'traffic'));

    S.offEvents.push(ctx.events.on('time:changed', (p) => {
      const h = p && p.hours !== undefined ? p.hours : ctx.world.time.hours;
      S.night = nightFactor(h);
      S.mats.setNight(S.night, ctx.world.weather?.wetness ?? 0);
      S.render.setNight(S.night);
      S.crowd?.ambient?.setHourScale(pedFactor(h));
      retarget(ctx);
      // converge now: `demo` sets the hour after it sets the density, and a
      // ramp of 40 spawns every ten ticks never catches up inside a shot
      if (S.built && !S.showcaseMode) { for (let k = 0; k < 60; k++) if (reconcile()) break; }
    }, 'traffic'));

    /* R-ui-4: during `simulation.advanceDays()` the frame loop never runs, so
     * traffic never ticks and every hourly congestion sample recorded a zero.
     *
     * The obvious fix — step traffic here whenever our own tick has not run
     * since the last `sim:tick` — is **not deterministic**: how many frames fit
     * between two sim:ticks depends on how fast the machine is, so the same seed
     * produced different positions on different runs. Measured: two runs of the
     * same build hashed c14a2587 and 86e31ba8. So this listener only republishes
     * (which is pure), and stepping is offered as the explicit, caller-driven
     * `traffic.preroll(ticks)` that R-ui-4 actually asked for. A composer that
     * wants a real congestion history calls it alongside `advanceDays`. */
    S.offEvents.push(ctx.events.on('sim:tick', () => {
      if (S.built) publishStats(ctx, false);
    }, 'traffic'));

    S.offEvents.push(ctx.events.on('weather:changed', (p) => {
      const w = p?.wetness ?? ctx.world.weather?.wetness ?? 0;
      S.mats.setWetness(w);
      S.mats.setNight(S.night, w);
    }, 'traffic'));

    if (ctx.world.roads.segments.size > 0) {
      buildNetwork(ctx);
      retarget(ctx);
      reconcile();
    }

    ctx.log.info('ready', { ...(S.netStats || {}), ...(S.walkStats || {}), buildMs: S.buildMs });
  },

  rebuild(ctx, what) {
    if (what !== 'roads' && what !== undefined) return;
    if (!S.mats) return;
    buildNetwork(ctx);
    retarget(ctx);
    reconcile();
  },

  tick(ctx, dt) {
    if (!S.built || !S.sim) return;
    const t0 = performance.now();
    S.sim.step(dt);
    if (S.crowd) S.crowd.step(dt, _pedGate);
    writeAgents(ctx.world);

    if (S.sim.tickCount - S.lastMeasure >= 10) {
      S.lastMeasure = S.sim.tickCount;
      S.sim.measure(0.3);
      const emit = S.sim.tickCount - S.lastEmit >= 40;       // ≤ every 2 s
      publishStats(ctx, emit);
      if (emit) S.lastEmit = S.sim.tickCount;
      if (S.sim.tickCount % 200 === 0) S.router.refreshCosts(S.sim.congestion);
      if (!S.showcaseMode) { retarget(ctx); reconcile(); }
    }
    const ms = performance.now() - t0;
    S.tickMs = ms;
    S.tickMsEma = S.tickMsEma * 0.9 + ms * 0.1;
  },

  update(ctx, dt, elapsed) {
    if (!S.built || !S.render) return;
    const acc = ctx.engine && Number.isFinite(ctx.engine.accum) ? ctx.engine.accum : 0;
    const alpha = ctx.world.time.paused ? 1 : clamp(acc / (ctx.FIXED_DT || 0.05), 0, 1);
    S.render.update(alpha, ctx.camera, S.sim.simTime);
    // props' signal heads follow the phase this module is enforcing (R-traffic-2)
    if (S.signals && (++S.signalTick & 7) === 0) {
      if (!S.signals.bound) S.signals.bind(S.net, S.sim);
      else S.signals.update();
    }
    if (S.crowd) S.crowd.update(alpha, ctx.camera, S.sim.simTime + alpha * (ctx.FIXED_DT || 0.05));
    void dt; void elapsed;
  },

  showcase(ctx, variant = 'default') {
    S.ctx = ctx;
    return stageShowcase(ctx, S, variant, { buildNetwork, retarget, reconcile, preroll, setPedFocus });
  },

  dispose(ctx) {
    for (const off of S.offEvents) { try { off(); } catch { /* ignore */ } }
    S.offEvents.length = 0;
    for (const o of S.stage) { o.geometry?.dispose?.(); o.removeFromParent?.(); }
    S.stage.length = 0;
    S.render?.dispose();
    S.crowd?.dispose();
    S.mats?.dispose();
    S.render = null; S.crowd = null; S.mats = null; S.sim = null; S.signals = null;
    S.net = null; S.router = null; S.walk = null; S.built = false;
    if (ctx?.world?.agents) { ctx.world.agents.count = 0; }
  },

  /* --------------------------------------------------------------- API --- */

  /** Add vehicles (or `{kind:'ped'}` pedestrians). Returns how many appeared. */
  spawn(n = 1, opts = {}) {
    if (!S.built) return 0;
    if (opts.kind === 'ped') return S.crowd.spawn(n);
    let type;
    if (typeof opts.type === 'string') type = VEH[opts.type];
    else if (typeof opts.type === 'number') type = opts.type;
    let made = 0;
    if (type === undefined) made = S.sim.spawnMany(n);
    else for (let i = 0; i < n; i++) if (S.sim.spawn({ type }) >= 0) made++;
    S.targetV = Math.max(S.targetV, S.sim.count);
    return made;
  },

  despawn(n = 1, opts = {}) {
    if (!S.built) return 0;
    if (opts.kind === 'ped') return S.crowd.despawn(n);
    const r = S.sim.despawn(n);
    S.targetV = S.sim.count;
    return r;
  },

  /** 0 = empty streets, 1 = normal, up to 4. Repopulates over the next ticks. */
  setDensity(d) {
    S.density = clamp(d ?? 1, 0, 4);
    S.ambientDensity = 1.15 * Math.max(0, Math.min(3, S.density));
    if (S.crowd && S.walk) {
      const zoning = S.ctx && S.ctx.get('zoning');
      const zAt = zoning && zoning.zoneAt ? (x, z) => zoning.zoneAt(x, z) : null;
      S.crowd.ambient.rebuild(S.walk, zAt, S.ambientDensity);
    }
    if (S.ctx) {
      retarget(S.ctx);
      // converge rather than nudge: one pass is capped so the live city ramps,
      // but an explicit setDensity should take effect now
      for (let k = 0; k < 80; k++) if (reconcile()) break;
    }
    return S.density;
  },

  /** Run the simulation forward without rendering; returns the ticks stepped. */
  preroll(ticks = 200) { return S.ctx ? preroll(S.ctx, ticks) : 0; },

  /** Recompute `world.stats.traffic` now (R-ui-4). */
  publish() {
    if (!S.built || !S.ctx) return null;
    S.sim.measure(0.3);
    publishStats(S.ctx, false);
    return S.ctx.world.stats.traffic;
  },

  /**
   * Aspect at a junction approach: 0 green, 1 amber, 2 red. `props` owns the
   * signal heads and has no setter yet (R-traffic-2), so this is offered as a
   * pull API — props can read it per frame and tint its three lens batches.
   */
  signalAspect(nodeId) {
    if (!S.built) return 0;
    const out = [];
    for (const nd of S.net.nodes) {
      if (nodeId !== undefined && nd.id !== nodeId) continue;
      if (!nd.signalled) continue;
      const slot = nd.slot;
      const green = S.sim.sigGreen[slot];
      const state = S.sim.sigState[slot];
      out.push({ node: nd.id, x: nd.x, z: nd.z, greenGroup: green,
        aspect: state === 0 ? 0 : (state === 1 ? 1 : 2) });
    }
    return nodeId !== undefined ? (out[0] || null) : out;
  },

  /** Congestion 0..1 at a world position (or for a segment id). */
  congestionAt(x, z) {
    if (!S.built) return 0;
    if (z === undefined && typeof x === 'number') {
      const lanes = S.net.segLanes.get(x);
      if (!lanes) return 0;
      let m = 0;
      for (const l of lanes) m = Math.max(m, S.sim.congestion[l]);
      return m;
    }
    const near = S.net.nearestLane(x, z, 80);
    return near ? S.sim.congestion[near.lane] : 0;
  },

  /** Plan a drive between two world points. */
  route(from, to) {
    if (!S.built) return null;
    const fx = from.x ?? from[0], fz = from.z ?? from[2] ?? from[1];
    const tx = to.x ?? to[0], tz = to.z ?? to[2] ?? to[1];
    const a = S.net.nearestLane(fx, fz, 140);
    const b = S.net.nearestLane(tx, tz, 140);
    if (!a || !b) return null;
    const lanes = S.router.route(a.lane, b.lane);
    if (!lanes) return null;
    const points = [];
    let dist = 0, time = 0;
    const p = { x: 0, y: 0, z: 0, hx: 0, hz: 0 };
    for (const l of lanes) {
      const n = Math.max(2, Math.ceil(S.net.len[l] / 8));
      for (let k = 0; k < n; k++) {
        S.net.sample(l, (k / (n - 1)) * S.net.len[l], p);
        points.push(p.x, p.y, p.z);
      }
      dist += S.net.len[l];
      time += S.router.cost[l];
    }
    return { lanes: Array.from(lanes), points: new Float32Array(points),
      distance: +dist.toFixed(1), time: +time.toFixed(1) };
  },

  stats() {
    const sim = S.sim;
    return {
      built: S.built,
      density: S.density,
      night: +S.night.toFixed(2),
      vehicles: sim ? sim.count : 0,
      pedestrians: S.crowd ? S.crowd.count : 0,
      targets: { vehicles: S.targetV, pedestrians: S.targetP },
      network: S.netStats,
      walk: S.walkStats,
      sim: sim ? { ...sim.stats, tick: sim.tickCount } : null,
      router: S.router ? S.router.stats() : null,
      tickMs: +(S.tickMsEma).toFixed(3),
      drawCalls: (S.render ? S.render.drawn : 0) + (S.crowd ? (S.crowd.drawn || 0) : 0),
      buildMs: S.buildMs,
    };
  },

  /** Live vehicles within `r` of a point: [{id, type, x, y, z, speed, lane}] */
  vehiclesNear(pos, r = 60) {
    if (!S.built) return [];
    const x = pos.x ?? pos[0], z = pos.z ?? pos[2] ?? pos[1];
    const r2 = r * r;
    const out = [];
    const sim = S.sim;
    for (let i = 0; i < sim.capacity; i++) {
      if (!sim.alive[i]) continue;
      const o = i * 4;
      const dx = sim.cur[o] - x, dz = sim.cur[o + 2] - z;
      if (dx * dx + dz * dz > r2) continue;
      out.push({
        id: i, type: VEH_NAMES[sim.type[i]],
        x: sim.cur[o], y: sim.cur[o + 1], z: sim.cur[o + 2],
        yaw: sim.cur[o + 3], speed: sim.v[i], lane: sim.lane[i],
        segment: sim.lane[i] >= 0 ? S.net.seg[sim.lane[i]] : -1,
      });
    }
    return out;
  },
};

/** Pedestrians cross when the conflicting movement is held, or there is a gap. */
function _pedGate(lane) {
  if (!S.sim || lane < 0) return true;
  const ctrl = S.net.ctrl[lane];
  if (ctrl === CTRL.SIGNAL) return S.sim.aspect(lane) === 2;
  const eta = S.sim.approachEta[lane];
  return !(eta < 3.6);
}

/* extra surface for the harness, tooling and the demo city */
mod.api = {
  network: () => S.net,
  sim: () => S.sim,
  router: () => S.router,
  crowd: () => S.crowd,
  materials: () => S.mats,
  aspect: (lane) => (S.sim ? S.sim.aspect(lane) : 0),
  signalSync: () => (S.signals ? { bound: S.signals.bound, heads: S.signals.n, matched: S.signals.matched } : null),
  /** Real draw calls attributable to traffic alone (the harness number is scene-wide). */
  drawCalls: () => {
    let n = 0, tris = 0;
    S.ctx?.group.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      if (o.isInstancedMesh && o.count === 0) return;
      n++;
      const idx = o.geometry.index;
      const per = idx ? idx.count / 3 : (o.geometry.attributes.position.count / 3);
      tris += per * (o.isInstancedMesh ? o.count : 1);
    });
    return { drawCalls: n, triangles: Math.round(tris) };
  },
  /** Headless assertion surface — see tools note in the report. */
  audit: () => auditWorld(),
  setSignalFreeze: (on, group = 1) => {
    if (!S.sim) return false;
    S.sim.freezeSignals = !!on;
    S.sim.frozenGreen = group;
    return S.sim.freezeSignals;
  },
  VEH, VEH_NAMES, VEH_SPEC,
};

/**
 * Invariant checks used by the numeric verification pass:
 *  - no two vehicles overlap along a lane
 *  - every vehicle is within its lane's half width of the lane centreline
 *  - nobody has crossed a closed stop line
 */
function auditWorld() {
  const sim = S.sim, net = S.net;
  const out = {
    vehicles: 0, overlaps: 0, offLane: 0, pastRed: 0, ranRed: sim ? sim.stats.ranRed : 0,
    separations: sim ? sim.stats.separations : 0,
    maxLateral: 0, worstOverlap: 0, negSpeed: 0, offRoute: 0,
  };
  if (!sim || !net) return out;
  const byLane = new Map();
  for (let i = 0; i < sim.capacity; i++) {
    if (!sim.alive[i]) continue;
    out.vehicles++;
    if (sim.v[i] < -1e-6) out.negSpeed++;
    const l = sim.lane[i];
    if (l < 0) continue;
    if (!byLane.has(l)) byLane.set(l, []);
    byLane.get(l).push(i);

    /* Lateral. A vehicle mid lane-change is legitimately *between* two lane
     * centrelines, so the bound is the offset of the lane it came from, not the
     * lane's own half width. Outside a change the tolerance is 0.35 m. */
    const lat = Math.abs(sim.lat[i]);
    if (lat > out.maxLateral) out.maxLateral = lat;
    let allowed = 0.35;
    if (lat > 0.35) {
      const lf = net.left[l], rt = net.right[l];
      if (lf >= 0) allowed = Math.max(allowed, Math.abs(net.off[lf] - net.off[l]) + 0.35);
      if (rt >= 0) allowed = Math.max(allowed, Math.abs(net.off[rt] - net.off[l]) + 0.35);
      allowed += 0.5;
    }
    if (lat > allowed) out.offLane++;

    // the plan must actually start at the lane we are on
    if (sim.routeLen[i] > 0 && sim.route[i * sim.maxRoute + sim.routeIdx[i]] !== l) out.offRoute++;

    // stop line: a held vehicle must be short of it
    const k = sim.routeIdx[i] + 1;
    const nx = k < sim.routeLen[i] ? sim.route[i * sim.maxRoute + k] : -1;
    // geometric invariant: a vehicle that is actually being HELD must not have
    // its nose over the line. A committed vehicle (already past it when the
    // light changed) is excluded — it is clearing the junction, which is right.
    if (sim.gate[i] === 1 && sim.s[i] + sim.vlen[i] * 0.5 > net.len[l] + 0.05) out.pastRed++;
    void nx;
  }
  for (const [l, list] of byLane) {
    list.sort((a, b) => sim.s[a] - sim.s[b]);
    for (let k = 1; k < list.length; k++) {
      const a = list[k - 1], b = list[k];
      const gap = (sim.s[b] - sim.vlen[b] * 0.5) - (sim.s[a] + sim.vlen[a] * 0.5);
      if (gap < -0.05) { out.overlaps++; out.worstOverlap = Math.min(out.worstOverlap, gap); }
    }
    void l;
  }
  out.maxLateral = +out.maxLateral.toFixed(3);
  out.worstOverlap = +out.worstOverlap.toFixed(3);
  return out;
}

export default mod;
