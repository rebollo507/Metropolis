import propTextures from './Textures.js';
import PropMaterials from './Materials.js';
import Library from './Library.js';
import BatchSet from './Batches.js';
import ClusterLights from './Lights.js';
import { populate as runPopulate } from './Populate.js';
import { showcase as runShowcase } from './showcase.js';

/**
 * props — the module that makes the city look inhabited.
 *
 * Street furniture marched off the road graph, four procedural tree species in
 * three LOD tiers, lot dressing placed in each building's own frame, and parked
 * cars in stationary bays only. Everything is instanced: one InstancedMesh per
 * (geometry, material) pair for the whole city, with wind sway and distance
 * collapse done in the vertex shader so `update()` is allocation-free and costs
 * one uniform write per frame.
 */

const S = {
  ctx: null,
  tex: null,
  mats: null,
  lib: null,
  batches: null,
  lights: null,
  group: null,
  extras: [],
  ownedMaterials: [],
  built: false,
  density: 1,
  night: 0,
  forceLights: null,
  lastStats: null,
  offEvents: [],
  buildMs: 0,
};

/* ------------------------------------------------------------------ time -- */

function nightAmount(hours, ctx) {
  const h = ((hours % 24) + 24) % 24;
  let n;
  if (h < 5.4) n = 1;
  else if (h < 7.2) n = 1 - (h - 5.4) / 1.8;
  else if (h < 17.6) n = 0;
  else if (h < 20.2) n = (h - 17.6) / 2.6;
  else n = 1;
  n = Math.pow(Math.max(0, Math.min(1, n)), 1.5);
  const env = ctx && ctx.get ? ctx.get('environment') : null;
  if (env && typeof env.isNight === 'function') {
    try { if (env.isNight()) n = Math.max(n, 0.9); } catch { /* optional */ }
  }
  return n;
}

function applyTime(ctx, hours) {
  if (!S.mats) return;
  S.night = S.forceLights === null ? nightAmount(hours, ctx) : S.forceLights;
  S.mats.setNight(S.night);
  S.lights?.setNight(S.night);
}

function applyWeather(ctx) {
  if (!S.mats) return;
  const w = ctx.world.weather || {};
  S.mats.setWetness(w.wetness ?? 0);
  S.mats.setWind(w.windDir ?? 0.7, w.windSpeed ?? 3.2);
}

/**
 * Bring other modules' materials into the light pass.
 *
 * `buildings` publishes `materials()` so its facades are adopted through a
 * public API. `roads`, `terrain` and `traffic` create their materials directly
 * and expose no accessor, so the carriageway a lamp is *supposed* to light
 * would stay unlit. Integrator pass 5's stated intent for `globalUniforms` is
 * "a light list onto every material in the scene", and `adopt()` is
 * non-destructive — it captures and re-calls whatever hook the module already
 * set, and my patch no-ops on any shader whose anchors it cannot find. So this
 * also walks the scene once and adopts lit materials it has not seen.
 *
 * This is a bridge, not the end state: R-props-8 asks those modules to adopt
 * themselves so props can stop traversing.
 */
function adoptNeighbours(ctx) {
  if (!S.lights) return 0;
  let viaApi = 0, viaScene = 0;
  const b = ctx.get('buildings');
  const bm = b && typeof b.materials === 'function' ? b.materials() : null;
  if (bm && bm.all) for (const m of bm.all) { S.lights.adopt(m); viaApi++; }

  try {
    ctx.scene.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh && !o.isPoints) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (!m || !m.isMaterial) continue;
        // only materials that run the lighting chunks can receive a light
        if (!(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial
          || m.isMeshLambertMaterial || m.isMeshPhongMaterial)) continue;
        if (S.lights.has(m)) continue;
        S.lights.adopt(m);
        viaScene++;
      }
    });
  } catch (err) { ctx.log.warn('scene adoption skipped:', err.message); }

  if (viaApi || viaScene) {
    ctx.log.info(`lamp light adopted ${viaApi} via buildings.materials(), ${viaScene} via scene walk`);
  }
  return viaApi + viaScene;
}

/* --------------------------------------------------------------- staging -- */

function clearExtras() {
  for (const e of S.extras) {
    if (e.isMesh || e.isLine) e.geometry?.dispose();
    e.removeFromParent?.();
  }
  S.extras.length = 0;
  for (const m of S.ownedMaterials) m.dispose?.();
  S.ownedMaterials.length = 0;
}

function clearAll() {
  if (S.batches && S.group) S.batches.clear(S.group);
  clearExtras();
  S.built = false;
  S.lastStats = null;
}

function ensureLibrary(ctx) {
  if (S.lib) return S.lib;
  S.lib = new Library(ctx, S.mats);
  if (S.batches) S.lib.install(S.batches);
  return S.lib;
}

/* ------------------------------------------------------------- lifecycle -- */

const mod = {
  name: 'props',
  version: '1.0.0',
  dependsOn: ['terrain', 'roads', 'zoning', 'buildings'],
  provides: ['populate', 'clear', 'stats', 'setDensity', 'lightsOn'],

  api: {},

  async init(ctx) {
    S.ctx = ctx;
    S.group = ctx.group;

    try {
      S.tex = propTextures(ctx.assets, ctx.world.seed >>> 0);
    } catch (err) {
      ctx.log.warn('texture generation failed, props will look flat:', err.message);
      S.tex = {};
    }
    S.mats = new PropMaterials(ctx, S.tex);
    S.batches = new BatchSet(ctx);

    // Real street lighting (R-props-6), on the core shader-patch chain that
    // integrator pass 5 shipped. Adopt props' own materials so the props
    // standing in a pool are lit by it, and buildings' materials through their
    // public `materials()` accessor so facades catch it too — that accessor is
    // the only sanctioned way to reach another module's materials.
    S.lights = new ClusterLights(ctx);
    S.lights.install();
    S.mats.adoptAll(ctx);
    adoptNeighbours(ctx);

    applyWeather(ctx);
    applyTime(ctx, ctx.world.time.hours);

    S.offEvents.push(ctx.events.on('time:changed', (p) => {
      applyTime(ctx, p && p.hours !== undefined ? p.hours : ctx.world.time.hours);
    }, 'props'));

    S.offEvents.push(ctx.events.on('weather:changed', () => applyWeather(ctx), 'props'));

    S.offEvents.push(ctx.events.on('buildings:spawned', () => {
      adoptNeighbours(ctx);
      if (ctx.opts?.showcase || !S.built) return;
      mod.populate({});
    }, 'props'));

    S.offEvents.push(ctx.events.on('roads:changed', () => {
      if (ctx.opts?.showcase || !S.built) return;
      mod.populate({});
    }, 'props'));

    // In the composed app, dress whatever already exists.
    if (!ctx.opts?.showcase && ctx.world.roads.segments.size > 0) {
      mod.populate({});
    }
    ctx.log.info('ready', { density: S.density });
  },

  rebuild(ctx, what) {
    if (ctx.opts?.showcase) return;
    if (what === 'roads' || what === 'buildings' || what === 'zoning' || what === 'terrain') {
      if (S.built) mod.populate({});
    }
  },

  update(ctx, dt, elapsed) {
    if (S.mats) S.mats.advance(elapsed, ctx.camera);
  },

  showcase(ctx, variant = 'default') {
    S.ctx = ctx;
    S.group = ctx.group;
    clearAll();
    ensureLibrary(ctx);
    const r = runShowcase(ctx, variant, S, mod);
    adoptNeighbours(ctx);
    applyTime(ctx, ctx.world.time.hours);
    S.built = true;
    ctx.events.emit('props:changed', { stats: S.lastStats });
    return r;
  },

  dispose(ctx) {
    for (const off of S.offEvents) { try { off(); } catch { /* ignore */ } }
    S.offEvents.length = 0;
    clearAll();
    if (S.batches && ctx.group) S.batches.dispose(ctx.group);
    S.lights?.dispose();
    S.lib?.dispose();
    S.mats?.dispose();
    S.batches = null; S.lib = null; S.mats = null; S.tex = null; S.lights = null;
  },

  /* ------------------------------------------------------------- API --- */

  /** Dress the whole current city. Returns the build stats. */
  populate(opts = {}) {
    const ctx = S.ctx;
    if (!ctx || !S.mats) return null;
    if (opts.density !== undefined) S.density = Math.max(0, Math.min(4, opts.density));
    try {
      ensureLibrary(ctx);
      S.batches.clear(S.group);
      clearExtras();
      const t0 = performance.now();
      const stats = runPopulate(ctx, S, { ...opts, density: S.density });
      S.buildMs = Math.round(performance.now() - t0);
      adoptNeighbours(ctx);
      S.lastStats = { ...stats, buildMs: S.buildMs, definitions: S.lib.defs.length };
      S.built = true;
      applyTime(ctx, ctx.world.time.hours);
      ctx.events.emit('props:changed', { stats: S.lastStats });
      ctx.log.info('populated', {
        drawCalls: stats.drawCalls, meshes: stats.meshes, instances: stats.instances,
        trees: stats.trees, cars: stats.cars, lamps: stats.lamps, ms: S.buildMs,
      });
      return S.lastStats;
    } catch (err) {
      ctx.log.warn('populate failed:', err.message);
      return null;
    }
  },

  /** Remove every prop but keep the geometry library warm. */
  clear() {
    clearAll();
    S.ctx?.events.emit('props:changed', { stats: null });
    return true;
  },

  stats() {
    return {
      built: S.built,
      density: S.density,
      night: +S.night.toFixed(3),
      buildMs: S.buildMs,
      definitions: S.lib ? S.lib.defs.length : 0,
      clusterLights: S.lights ? S.lights.stats() : null,
      libraryTriangles: S.lib ? Math.round(S.lib.tris) : 0,
      ...(S.lastStats || {}),
    };
  },

  /** 0 = nothing, 1 = a full city's worth. Repopulates. */
  setDensity(d) {
    S.density = Math.max(0, Math.min(4, d ?? 1));
    if (S.built) mod.populate({});
    return S.density;
  },

  /**
   * Force the lamps on/off, or hand control back to the clock with `null`.
   * `lightsOn(0.5)` is a usable dusk.
   */
  lightsOn(v) {
    if (v === null || v === undefined) S.forceLights = null;
    else S.forceLights = typeof v === 'number' ? Math.max(0, Math.min(1, v)) : (v ? 1 : 0);
    applyTime(S.ctx, S.ctx ? S.ctx.world.time.hours : 13);
    return S.night;
  },
};

mod.api = {
  materials: () => S.mats,
  library: () => S.lib,
  batches: () => S.batches,
  setLodBias: (b) => (S.mats ? S.mats.setLodBias(b) : 1),
  kinds: () => (S.batches ? S.batches.report() : {}),
};

export default mod;
