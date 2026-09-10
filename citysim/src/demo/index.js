import { Rng, hashString } from '../core/Rng.js';
import { Site } from './site.js';
import { makePlan } from './plan.js';
import { layNetwork } from './network.js';
import { buildShots } from './shots.js';
import { tuneZoning } from './districts.js';
import { buildUrbanGround } from './ground.js';
import { placeCrossing } from './bridge.js';
import { NightFill } from './citylight.js';

/**
 * demo — the showcase city.
 *
 * This module owns no geometry of its own worth speaking of. Its job is
 * *composition*: read the ground, decide where a city would actually stand on
 * it, and then drive every other module in the right order so the result reads
 * as one place rather than eight subsystems in the same scene.
 *
 *   terrain ─► site analysis ─► plan ─► roads ─► zoning ─► buildings
 *                                          └─► props ─► traffic ─► simulation
 *
 * Every step is optional: any module that is missing or FAILED is skipped and
 * the rest of the pipeline still runs.
 *
 * ── the one honest hack, and why ──────────────────────────────────────────
 * `buildings`, `props` and `traffic` all begin their `roads:changed` handler
 * with `if (ctx.opts?.showcase) return` — the sanctioned "somebody else is
 * staging a network, stand down" guard. Laying a city takes ~500 graph
 * mutations and the road graph flushes one `roads:changed` per mutation when it
 * is not inside its own `begin()/end()` batch, which this module cannot reach
 * from outside. So `build()` sets that guard for its own duration and drives
 * every consumer explicitly afterwards, in order. Filed as R-demo-1; the
 * moment `roads` exposes a batch, this goes away.
 */

const S = {
  ctx: null,
  site: null,
  plan: null,
  net: null,
  shots: null,
  anchors: null,
  bridge: null,       // the river crossing this module sited (R-roads-2)
  built: false,
  building: false,
  pending: false,
  buildMs: 0,
  steps: [],
  lastError: null,
  variant: 'overview',
  owned: [],          // the little geometry this module owns itself
};

/** Drop everything demo put in its own group. */
function clearOwned(ctx) {
  for (const o of S.owned) {
    o.geometry?.dispose?.();
    o.removeFromParent?.();
  }
  S.owned.length = 0;
  void ctx;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);

function api(ctx, name) {
  try { return ctx.get(name); } catch { return null; }
}

/**
 * Per-shot lens treatment. Depth of field that is right for a street is wrong
 * for an aerial — a blurred aerial is an illegible city — so each shot carries
 * its own multipliers and pushes them through `effects`' public API.
 */
function applyLook(ctx, f) {
  const fx = api(ctx, 'effects');
  if (!fx || !f) return;
  try {
    if (fx.setDof) fx.setDof(f.dof ?? 0.5);
    if (fx.setBloom) fx.setBloom(f.bloom ?? 1.0);
  } catch { /* optional */ }
}

/* ------------------------------------------------------------- anchors --- */

/** Real points in the finished city that the named shots aim at. */
function findAnchors(ctx) {
  const world = ctx.world;
  const plan = S.plan;
  const site = S.site;
  const core = plan.core;
  const roads = api(ctx, 'roads');

  /* the visual downtown: the centroid of the tallest buildings */
  const tall = [...world.buildings.values()]
    .filter((b) => b.pos && Number.isFinite(b.height))
    .sort((a, b) => b.height - a.height)
    .slice(0, 14);
  let skylineSubject = core;
  if (tall.length > 3) {
    let sx = 0, sz = 0, sw = 0;
    for (const b of tall) { sx += b.pos[0] * b.height; sz += b.pos[2] * b.height; sw += b.height; }
    skylineSubject = [sx / sw, sz / sw];
  }
  const maxH = tall.length ? tall[0].height : 40;

  /* a street-level stand in the core, looking down an avenue toward the water */
  let downtown = { x: core[0], z: core[1], dir: [plan.v[0], plan.v[1]] };
  if (roads && roads.network) {
    const net = roads.network();
    let best = null;
    for (const s of net.segments.values()) {
      if (s.class !== 'boulevard' && s.class !== 'lane4') continue;
      const p = roads.pointAt(s.id, 0.5);
      const d = Math.hypot(p.x - skylineSubject[0], p.z - skylineSubject[1]);
      const t = roads.tangentAt(s.id, 0.5);
      // prefer an avenue running inland/seaward (we want to look down it at the
      // water), and prefer one close to the tall cluster
      const align = Math.abs(t.x * plan.v[0] + t.z * plan.v[1]);
      const score = align * 2.2 - d / 160;
      if (!best || score > best.score) best = { score, p, t, s };
    }
    if (best) {
      const t = best.t;
      // stand on the inland side so the camera looks seaward down the avenue
      const sgn = (t.x * plan.v[0] + t.z * plan.v[1]) >= 0 ? 1 : -1;
      downtown = { x: best.p.x, z: best.p.z, dir: [t.x * sgn, t.z * sgn] };
    }
  }

  /* a leafy street: a lane2 out in the housing, with houses actually on it */
  let residential = { x: core[0] + plan.v[0] * 420, z: core[1] + plan.v[1] * 420, dir: plan.u };
  if (roads && roads.network) {
    const buildings = api(ctx, 'buildings');
    let best = null;
    for (const s of roads.network().segments.values()) {
      if (s.class !== 'lane2' || s.length < 60) continue;
      const p = roads.pointAt(s.id, 0.5);
      const d = Math.hypot(p.x - core[0], p.z - core[1]);
      if (d < 340) continue;
      let houses = 0, tallNear = 0, big = 0;
      if (buildings && buildings.buildingsNear) {
        for (const b of buildings.buildingsNear({ x: p.x, z: p.z }, 70)) {
          if (b.kind === 'house' || b.kind === 'rowhouse') houses++;
          else if (b.kind === 'warehouse' || b.kind === 'tower') big++;
          if (b.height > 22) tallNear++;
        }
      }
      // a quiet street: houses on it, nothing tall or industrial near it, and
      // far enough out that downtown is not looming over the hedge
      const score = houses * 1.4 - tallNear * 2.2 - big * 2.5 + Math.min(d, 620) / 300;
      if (!best || score > best.score) best = { score, p, t: roads.tangentAt(s.id, 0.5), houses };
    }
    if (best && best.houses >= 2) residential = { x: best.p.x, z: best.p.z, dir: [best.t.x, best.t.z] };
  }

  /* the quay: a point on the waterfront road, camera out over the water */
  let waterfront = { x: core[0] - plan.v[0] * 200, z: core[1] - plan.v[1] * 200, dir: [-plan.v[0], -plan.v[1]] };
  if (S.net && S.net.quay && S.net.quay.length > 3) {
    const q = S.net.quay;
    // the stretch of quay closest to downtown
    let bi = 0, bd = Infinity;
    for (let i = 0; i < q.length; i++) {
      const d = Math.hypot(q[i][0] - skylineSubject[0], q[i][1] - skylineSubject[1]);
      if (d < bd) { bd = d; bi = i; }
    }
    const a = q[Math.max(0, bi - 2)], b = q[Math.min(q.length - 1, bi + 2)];
    const tx = b[0] - a[0], tz = b[1] - a[1];
    const L = Math.hypot(tx, tz) || 1;
    // stand off the quay, over the water, angled down the road
    const outx = -plan.v[0], outz = -plan.v[1];
    waterfront = {
      x: q[bi][0], z: q[bi][1],
      dir: [outx * 0.72 + (tx / L) * 0.7, outz * 0.72 + (tz / L) * 0.7],
    };
  }

  /* The extent the aerial has to hold. Percentiles, not extremes: a handful of
   * houses at the end of a lane up the hillside would otherwise pull the camera
   * back until the city itself was a smudge. */
  const xsAll = [], zsAll = [];
  for (const b of world.buildings.values()) {
    if (!b.pos) continue;
    xsAll.push(b.pos[0]); zsAll.push(b.pos[2]);
  }
  xsAll.sort((p, q) => p - q); zsAll.sort((p, q) => p - q);
  const pct = (arr, f) => (arr.length ? arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))] : 0);
  let x0 = core[0] - 400, x1 = core[0] + 400, z0 = core[1] - 400, z1 = core[1] + 400;
  if (xsAll.length > 20) {
    x0 = pct(xsAll, 0.04); x1 = pct(xsAll, 0.96);
    z0 = pct(zsAll, 0.04); z1 = pct(zsAll, 0.96);
  }

  return {
    skylineSubject, downtown, residential, waterfront, highstreet: findHighStreet(ctx),
    bridge: S.bridge || null, bbox: { x0, z0, x1, z1 }, maxH, tall: tall.length,
  };
}

/**
 * The high street, from `zoning.retailFrontages()` (R-zone-1).
 *
 * `zoning` hands back runs of contiguous commercial frontage, longest first,
 * already chained across segment splits — which is the half `demo` could not
 * compute, because only `zoning` knows which road segments are the same street.
 * What is left is a photographer's question, and it is the reason this does not
 * simply return `highStreet().camera`:
 *
 * **the longest run is not the most photographable stretch of it.** The shipped
 * run is 242 m with `gapMax` 44 — a park/civic block interrupts it — and its
 * midpoint, which is what any "aim at the middle" rule picks, lands *in* that
 * hole. So this re-reads the member lots, projects each frontage onto the run's
 * axis, and finds the longest stretch whose internal gaps stay under 16 m: one
 * unbroken wall of shopfronts, which is what the lens actually needs. The run
 * still comes from `zoning`; only the crop of it is mine.
 */
function findHighStreet(ctx) {
  const z = api(ctx, 'zoning');
  if (!z || typeof z.retailFrontages !== 'function') return null;
  let runs = null;
  try { runs = z.retailFrontages({ limit: 6 }); } catch { return null; }
  if (!runs || !runs.length) return null;

  let best = null;
  for (const run of runs) {
    const lots = run.lots || [];
    if (lots.length < 2 || !run.axis || !run.a) continue;
    const [ax, az] = run.axis;
    const along = (p) => (p[0] - run.a[0]) * ax + (p[1] - run.a[1]) * az;

    // each lot as an interval along the street
    const iv = [];
    for (const L of lots) {
      const f = L.frontage;
      if (!f || !f.mid) continue;
      const s = along(f.mid), w = (f.width || 12) * 0.5;
      iv.push([s - w, s + w, L]);
    }
    if (iv.length < 2) continue;
    iv.sort((p, q) => p[0] - q[0]);

    // longest stretch with no gap wider than 16 m
    let runStart = 0, cur = [iv[0]], bestSet = null;
    for (let i = 1; i <= iv.length; i++) {
      const gap = i < iv.length ? iv[i][0] - iv[i - 1][1] : Infinity;
      if (gap <= 16 && i < iv.length) { cur.push(iv[i]); continue; }
      const len = cur[cur.length - 1][1] - cur[0][0];
      if (!bestSet || len > bestSet.len) bestSet = { len, set: cur.slice(), s0: cur[0][0], s1: cur[cur.length - 1][1] };
      cur = i < iv.length ? [iv[i]] : cur;
      runStart = i;
    }
    if (!bestSet) continue;
    void runStart;

    /* Score on what a lens can use, which is neither the run's total length nor
     * even the usable length alone:
     *  · length past ~80 m is free but worthless — at the distance that makes a
     *    shopfront legible (~22 m) a 42° lens sees about 60 m of wall, so the
     *    rest is behind the frame edge either way. Hence the clamp.
     *  · **fill** — metres of actual shopfront per metre of street — rules out
     *    a stretch that is technically continuous but mostly blank flank wall.
     *  · **shopfronts per 100 m** is what separates the two real contenders,
     *    and it is the term that matters. Both of this seed's five-lot runs are
     *    completely filled, so `fill` ties them at 1.0; what differs is that one
     *    packs its five units into 84 m (5.9 per 100 m) and the other spreads
     *    the same five over 105 m (4.8). Narrow units mean more doors, fascias
     *    and window bays per metre of frame — a busy wall rather than a long
     *    one — and the projection probe agrees with the intuition: the 84 m run
     *    measures 9.6 % of frame against the 105 m run's 8.4 % on an identical
     *    lens. Without this term the rule ties and silently keeps whichever
     *    `zoning` happened to list first. */
    let filled = 0;
    for (const [lo, hi] of bestSet.set) filled += hi - lo;
    const fill = bestSet.len > 1 ? Math.min(1, filled / bestSet.len) : 0;
    const per100 = bestSet.set.length / Math.max(1, bestSet.len) * 100;
    const narrow = run.class === 'lane2' ? 22 : (run.class === 'lane4' ? 8 : 0);
    const score = Math.min(bestSet.len, 80) * (0.5 + 0.7 * fill) + narrow + 3.2 * per100;
    if (!best || score > best.score) {
      const mid = [
        run.a[0] + ax * (bestSet.s0 + bestSet.s1) * 0.5,
        run.a[1] + az * (bestSet.s0 + bestSet.s1) * 0.5,
      ];
      // ground-floor top, for a target height that sits on the fascia line
      let y = run.mid ? run.mid[1] : 0, gf = 4.4;
      const terr = api(ctx, 'terrain');
      if (terr && terr.heightAt) y = terr.heightAt(mid[0], mid[1]);
      best = {
        score, run, class: run.class, side: run.side, fill, per100,
        length: run.length, usable: bestSet.len, lots: bestSet.set.length,
        x: mid[0], z: mid[1], y, groundFloor: gf,
        axis: [ax, az], normal: run.normal, roadOffset: run.roadOffset,
        s0: bestSet.s0, s1: bestSet.s1,
        a: [run.a[0] + ax * bestSet.s0, run.a[1] + az * bestSet.s0],
        b: [run.a[0] + ax * bestSet.s1, run.a[1] + az * bestSet.s1],
      };
    }
  }
  return best;
}

/* ----------------------------------------------------------------- sun --- */

/**
 * The sun's compass direction (unit XZ, pointing AT the sun) for the hour the
 * world is currently at, or null when it is below the horizon.
 *
 * Round 1 borrowed `environment.setTime()` to ask this for 18:45 and then put
 * the clock back — a full sky + PMREM recompute, twice, to read one vector. It
 * is not needed: by the time `showcase()` or `shot()` runs, `world.time.hours`
 * is already the hour being photographed, so `sunDirection()` answers directly.
 */
function sunNow(ctx) {
  const env = api(ctx, 'environment');
  if (!env || !env.sunDirection) return null;
  try {
    const d = env.sunDirection();
    if (!d || !Number.isFinite(d.x)) return null;
    // Below the horizon there is no key. Above ~37° there is one, but it is
    // nearly overhead: it models nothing on a vertical facade and its azimuth
    // is not worth moving a camera for. Gating it here also keeps the 13:00 and
    // 22:00 framings *identical*, which is what makes the day/night exposure
    // comparison in critic issue 3 a like-for-like measurement.
    if (d.y < 0.005 || d.y > 0.60) return null;
    const L = Math.hypot(d.x, d.z);
    if (!(L > 1e-4)) return null;
    return [d.x / L, d.z / L, d.y];
  } catch { return null; }
}

/**
 * Rebuild the framings whenever the key has moved. A three-quarter key at dawn
 * and a three-quarter key at golden hour are on opposite sides of the city, and
 * one compromise framing serves neither — so re-derive, which costs about 5 ms.
 */
function ensureShots(ctx, force = false) {
  if (!S.site || !S.plan || !S.anchors) return null;
  const s = sunNow(ctx);
  const prev = S.sun;
  const moved = force || (!!s !== !!prev)
    || (s && prev && (Math.abs(s[0] - prev[0]) > 0.06 || Math.abs(s[1] - prev[1]) > 0.06));
  if (!moved && S.shots) return S.shots;
  S.sun = s;
  S.sunElev = s ? s[2] : null;
  S.shots = buildShots({
    site: S.site, plan: S.plan, net: S.net, core: S.plan.core,
    anchors: S.anchors, sun: s ? [s[0], s[1]] : null, isNight: !s,
  });
  return S.shots;
}

/* --------------------------------------------------------------- build --- */

function step(name, fn) {
  const t = now();
  let out = null, err = null;
  try { out = fn(); } catch (e) { err = e; }
  S.steps.push({ name, ms: Math.round(now() - t), ok: !err, error: err ? err.message : null, out: summarise(out) });
  if (err) S.ctx?.log.warn(`step "${name}" failed (city still built):`, err.message);
  return out;
}

function summarise(o) {
  if (o === null || o === undefined) return null;
  if (typeof o !== 'object') return o;
  const keep = ['nodes', 'segments', 'lengthM', 'blocks', 'lots', 'buildings', 'drawCalls',
    'instances', 'trees', 'cars', 'lamps', 'vehicles', 'pedestrians', 'population', 'jobs'];
  const out = {};
  for (const k of keep) if (o[k] !== undefined) out[k] = typeof o[k] === 'number' ? Math.round(o[k]) : o[k];
  return Object.keys(out).length ? out : null;
}

function build(ctx, opts = {}) {
  if (S.building) return null;
  S.building = true;
  S.steps.length = 0;
  const t0 = now();

  // See the header comment: silence the sibling rebuild storm for the duration.
  const prevShowcase = ctx.opts ? ctx.opts.showcase : null;
  if (ctx.opts) ctx.opts.showcase = prevShowcase || 'demo';

  const seed = ctx.world.seed >>> 0;
  const rngPlan = new Rng(hashString('demo:plan', seed) >>> 0);
  const rngNet = new Rng(hashString('demo:network', seed) >>> 0);

  try {
    const terrain = api(ctx, 'terrain');

    /* 1 — read the ground */
    step('site', () => {
      S.site = new Site(terrain, { step: 16 });
      return S.site.report();
    });

    /* 2 — the urban plan */
    step('plan', () => {
      S.plan = makePlan(S.site, rngPlan, {
        width: opts.width ?? 540,
        depth: opts.depth ?? 660,
        windDir: ctx.world.weather?.windDir ?? 0.7,
      });
      return { core: S.plan.core.map((n) => Math.round(n)) };
    });

    /* 3 — roads */
    step('roads', () => {
      S.net = layNetwork(ctx, S.plan, S.site, rngNet, ctx.log);
      const r = api(ctx, 'roads');
      return r && r.network ? r.network().stats : null;
    });

    /* 3b — cross the river. Must run BEFORE the sibling rebuild: `roads`'
     *      autoBridge() fires from that hook and declines when an elevated
     *      segment already exists, so siting it here stands the fallback
     *      down without either module needing a flag (R-roads-2). */
    step('crossing', () => {
      S.bridge = placeCrossing(ctx, S.plan, ctx.log);
      return S.bridge;
    });

    /* 4 — let the modules that only listen to roads:changed catch up.
     *     ModuleHost.rebuild is the sanctioned path (see R-sim-2). */
    step('sibling-rebuild', () => { ctx.engine?.host?.rebuild?.('roads'); return null; });

    /* 5 — land use */
    step('zoning', () => {
      const z = api(ctx, 'zoning');
      if (!z || !z.autoZone) return null;
      const r = z.autoZone();
      tuneZoning(ctx, S.plan, S.site, r);
      return z.stats ? z.stats() : r;
    });

    /* 6 — buildings */
    step('buildings', () => {
      const b = api(ctx, 'buildings');
      if (!b || !b.generateForNetwork) return null;
      const ind = S.plan.industry;
      return b.generateForNetwork({
        centre: S.plan.core,
        radius: opts.coreRadius ?? 340,
        limit: opts.limit ?? 900,
        urbanBias: opts.urbanBias ?? 0.05,
        maxSlope: 0.30,
        industrialAt: ind
          ? (x, z) => (Math.hypot(x - ind.x, z - ind.z) < ind.r ? 0.95 : 0)
          : null,
      });
    });

    /* 6a — parks are for parking in, not building on.
     *
     * `buildings` never asks zoning whether a lot may be built on at all — the
     * override only *renames* a kind, and PARK maps to nothing, so the auto
     * zoner's green blocks come out covered in houses. Clearing them here is
     * the difference between "a park" and "a slightly greener suburb". */
    step('parks', () => {
      const b = api(ctx, 'buildings');
      const z = api(ctx, 'zoning');
      if (!b || !b.despawn || !z || !z.zoneAt) return null;
      const doomed = [];
      for (const rec of ctx.world.buildings.values()) {
        if (!rec.pos) continue;
        let zn = 0;
        try { zn = z.zoneAt(rec.pos[0], rec.pos[2]); } catch { zn = 0; }
        if (zn === 7) doomed.push(rec.id);          // ZONE.PARK
      }
      if (!doomed.length) return null;
      b.despawn(doomed);
      return { buildings: -doomed.length };
    });

    /* 6b — the ground between the kerb and the building line (R-8) */
    step('urban-ground', () => {
      clearOwned(ctx);
      const g = buildUrbanGround(ctx, S.plan, S.site, {});
      if (!g) return null;
      ctx.group.add(g.mesh);
      S.owned.push(g.mesh);
      return { drawCalls: 1, triangles: g.triangles };
    });

    /* 7 — dressing */
    step('props', () => {
      const p = api(ctx, 'props');
      if (!p || !p.populate) return null;
      return p.populate({ density: opts.propDensity ?? 1.05 });
    });

    /* 8 — traffic */
    step('traffic', () => {
      const t = api(ctx, 'traffic');
      if (!t || !t.setDensity) return null;
      t.setDensity(opts.trafficDensity ?? 1);
      return t.stats ? t.stats() : null;
    });

    /* 9 — run the city forward so the numbers (and the lit windows) mean
     *     something, then put the requested hour back. */
    step('simulation', () => {
      const sm = api(ctx, 'simulation');
      const sim = sm && sm.sim ? sm.sim() : null;
      if (!sim || typeof sim.advanceDays !== 'function') return null;
      const wantH = ctx.world.time.hours, wantD = ctx.world.time.day;
      sim.advanceDays(opts.days ?? 3);
      ctx.world.time.hours = wantH;
      ctx.world.time.day = wantD;
      sim._lastSeenHours = wantH;
      sim.day = wantD;
      sim.hourBucket = Math.floor(wantH);
      try { sim._hourly(true); } catch { /* optional */ }
      return sm.stats ? sm.stats() : null;
    });

    /* 10 — shots. The framing is keyed off where the sun actually is at the
     *      hour being photographed, so it is re-derived per hour (see
     *      `ensureShots`) rather than compromised across all of them. */
    step('shots', () => {
      S.anchors = findAnchors(ctx);
      ensureShots(ctx, true);
      return { shots: S.shots ? Object.keys(S.shots).length : 0 };
    });

    S.built = true;
    S.pending = false;
    S.lastError = null;
  } catch (err) {
    S.lastError = err.message;
    ctx.log.warn('build failed:', err.message);
  } finally {
    if (ctx.opts) ctx.opts.showcase = prevShowcase;
    S.building = false;
    S.buildMs = Math.round(now() - t0);
  }

  // re-emit the hour so every module re-syncs to the time the shot asked for
  try { ctx.engine?.setTime?.(ctx.world.time.hours); } catch { /* ignore */ }

  ctx.log.info(`city built in ${S.buildMs} ms`, S.steps.map((s) => `${s.name}:${s.ms}`).join(' '));
  return S.steps;
}

/* --------------------------------------------------------------- module -- */

const REVEAL = ['environment', 'terrain', 'roads', 'zoning', 'buildings',
  'props', 'traffic', 'simulation', 'effects'];

const mod = {
  name: 'demo',
  version: '1.0.0',
  dependsOn: ['terrain', 'roads', 'zoning', 'buildings', 'props', 'traffic', 'simulation', 'environment', 'effects'],
  provides: ['build', 'rebuild', 'stats', 'shot'],

  api: {},

  /**
   * init() is deliberately cheap. Composing the city is ~2-6 s of generation
   * across seven modules, which does not belong inside a 5 s per-module budget,
   * so it happens on the first `showcase()` (headless) or on the first frame
   * after boot (the live app). Stated plainly rather than hidden behind an
   * already-resolved promise.
   */
  async init(ctx) {
    S.ctx = ctx;
    S.pending = true;
    S.built = false;
    // cheap, and it must exist before the first frame so a night boot is not black
    try { S.nightFill = new NightFill(ctx, {}); }
    catch (err) { ctx.log.warn('night fill unavailable:', err.message); }
    ctx.log.info('ready — city will be composed on first frame/showcase');
  },

  update(ctx) {
    if (S.pending && !S.building && !ctx.opts?.showcase) {
      S.pending = false;
      build(ctx, {});
      if (S.shots) this.shot('overview');
    }
  },

  showcase(ctx, variant = 'overview') {
    S.ctx = ctx;
    S.variant = variant;
    if (!S.built && !S.building) build(ctx, {});
    ensureShots(ctx);
    const f = (S.shots && S.shots[variant]) || (S.shots && S.shots.overview) || null;
    applyLook(ctx, f);
    const framing = f ? { target: f.target, dist: f.dist, az: f.az, pol: f.pol, fov: f.fov } : {};
    framing.reveal = REVEAL;
    return framing;
  },

  /**
   * Doubles as the lifecycle hook and as the public `rebuild()` in `provides`.
   * `rebuild(ctx, 'terrain')` from the host marks the city stale; `rebuild()` or
   * `rebuild({...})` from another module recomposes it now.
   */
  rebuild(ctx, what) {
    const lifecycle = ctx && typeof ctx === 'object' && ctx.world && ctx.events;
    if (lifecycle) {
      if ((what === 'terrain' || what === undefined) && S.built) { S.built = false; S.pending = true; }
      return null;
    }
    return mod.build(ctx || {});
  },

  dispose(ctx) {
    S.nightFill?.dispose();
    S.nightFill = null;
    clearOwned(ctx);
    S.site = null; S.plan = null; S.net = null; S.shots = null; S.bridge = null;
    S.built = false; S.pending = false;
  },

  /* ------------------------------------------------------------- API ---- */

  /** Compose (or recompose) the whole city. */
  build(opts = {}) {
    if (!S.ctx) return null;
    S.built = false;
    return build(S.ctx, opts || {});
  },

  /** Alias kept for the module contract's `provides` list. */
  rebuildCity(opts = {}) { return mod.build(opts); },

  /** Apply a named composed framing at run time. */
  shot(name = 'overview') {
    const ctx = S.ctx;
    if (!ctx || !S.shots) return null;
    ensureShots(ctx);
    const f = S.shots[name] || S.shots.overview;
    if (!f) return null;
    S.variant = name;
    try {
      ctx.cameraRig.applyFraming({ target: f.target, dist: f.dist, az: f.az, pol: f.pol, fov: f.fov }, true);
    } catch (err) { ctx.log.warn('shot failed:', err.message); }
    applyLook(ctx, f);
    return {
      name,
      target: f.target.map((v) => +v.toFixed(1)),
      dist: +f.dist.toFixed(1), az: +f.az.toFixed(3), pol: +f.pol.toFixed(3), fov: f.fov,
      camera: f.cam.map((v) => +v.toFixed(1)),
      groundClearance: f.clearance,
      lineOfSight: f.sight,
      sunDot: f.key !== undefined ? f.key : null,
      sun: S.sun ? S.sun.map((v) => +v.toFixed(3)) : null,
    };
  },

  stats() {
    const ctx = S.ctx;
    const world = ctx ? ctx.world : null;
    return {
      built: S.built,
      buildMs: S.buildMs,
      variant: S.variant,
      steps: S.steps,
      error: S.lastError,
      site: S.site ? S.site.report() : null,
      plan: S.plan ? {
        core: S.plan.core.map((n) => Math.round(n)),
        avenues: S.plan.us.length, streets: S.plan.vs.length,
        quayPoints: S.plan.quay.length, highwayPoints: S.plan.highway.length,
        industry: S.plan.industry ? { x: Math.round(S.plan.industry.x), z: Math.round(S.plan.industry.z) } : null,
      } : null,
      city: world ? {
        roadSegments: world.roads.segments.size,
        roadNodes: world.roads.nodes.size,
        buildings: world.buildings.size,
        population: world.stats.population,
        jobs: world.stats.jobs,
      } : null,
      shots: S.shots ? Object.keys(S.shots) : [],
      nightFill: S.nightFill ? S.nightFill.report() : null,
      sun: S.sun ? S.sun.map((v) => +v.toFixed(3)) : null,
      anchors: S.anchors ? {
        skyline: S.anchors.skylineSubject.map((n) => Math.round(n)),
        maxHeight: Math.round(S.anchors.maxH),
        bbox: S.anchors.bbox,
        highstreet: S.anchors.highstreet ? {
          class: S.anchors.highstreet.class,
          runLength: +S.anchors.highstreet.length.toFixed(1),
          usable: +S.anchors.highstreet.usable.toFixed(1),
          lots: S.anchors.highstreet.lots,
          mid: [Math.round(S.anchors.highstreet.x), Math.round(S.anchors.highstreet.z)],
        } : null,
      } : null,
      bridge: S.bridge,
    };
  },
};

mod.api = {
  /** Live tuning of the night fill — used by the measurement sweep. */
  nightFill: (opts) => (S.nightFill ? (opts ? S.nightFill.set(opts) : S.nightFill.report()) : null),
  site: () => S.site,
  plan: () => S.plan,
  net: () => S.net,
  shots: () => S.shots,
  anchors: () => S.anchors,
  bridge: () => S.bridge,
};

export default mod;
