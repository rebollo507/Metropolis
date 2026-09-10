import { Rng, hashString } from '../core/Rng.js';
import BuildingTextures from './Textures.js';
import BuildingMaterials from './BuildingMaterials.js';
import ChunkManager from './Chunks.js';
import { planLots, frontages, fallbackFrontages } from './Lots.js';
import { stageShowcase, framingFor, clearStage } from './showcase.js';

/**
 * buildings — the module the city is actually read by.
 *
 * Street frontage is marched off the road graph into lots (see Lots.js), each
 * lot is turned into a seeded parameter set and then into real geometry with
 * recessed window reveals, cills, cornices, balconies, fire escapes, shopfronts
 * and roof plant (Generate.js / Facade.js / Roofs.js). Everything is merged per
 * block and per material into three LOD tiers (Chunks.js), and window lights
 * come on at night straight out of a vertex attribute plus two uniforms
 * (BuildingMaterials.js) — no per-frame CPU, no extra draw calls.
 */

const S = {
  ctx: null,
  tex: null,
  mats: null,
  chunks: null,
  offEvents: [],
  night: 0,
  built: false,
  lastPlan: null,
  buildMs: 0,
  stage: [],
};

/* ------------------------------------------------------------------ time -- */

function nightAmount(hours, ctx) {
  const h = ((hours % 24) + 24) % 24;
  let n;
  if (h < 5.2) n = 1;
  else if (h < 7.4) n = 1 - (h - 5.2) / 2.2;
  else if (h < 17.8) n = 0;
  else if (h < 20.4) n = (h - 17.8) / 2.6;
  else n = 1;
  n = Math.pow(Math.max(0, Math.min(1, n)), 1.7);
  const env = ctx && ctx.get ? ctx.get('environment') : null;
  if (env && typeof env.isNight === 'function' && env.isNight()) n = Math.max(n, 0.85);
  return n;
}

function applyTime(ctx, hours) {
  if (!S.mats) return;
  S.night = nightAmount(hours, ctx);
  S.mats.setNight(S.night, hours);
}

/* ------------------------------------------------------------ generation -- */

function terrainApi(ctx) {
  const t = ctx.get('terrain');
  if (t && typeof t.heightAt === 'function') return t;
  return null;
}

function collectFrontages(ctx) {
  const roads = ctx.get('roads');
  const f = frontages(roads, ctx.world);
  if (f.length) return f;
  ctx.log.warn('no road network available — falling back to an internal street grid');
  return fallbackFrontages(0, 0, 6, 6, 96, 76);
}

/**
 * Read the zoning module if it is up, and translate its enum into our kinds.
 * The module works fine without it — this only sharpens district character.
 *
 * This is consulted by `planLots` **before** the plot is sized, so the zone
 * decides *what* and `urban` decides *how tall* (R-demo-2). `'none'` is an
 * explicit no-build: a PARK block is a park, not a slightly greener suburb,
 * and `demo` no longer has to despawn twenty houses afterwards (R-demo-3).
 */
function zoningOverride(ctx) {
  const z = ctx.get('zoning');
  if (!z) return null;
  const zoneAt = z.zoneAt || z.zoneFor || null;
  if (typeof zoneAt !== 'function') return null;
  return (x, zz) => {
    let v;
    try { v = zoneAt(x, zz); } catch { return null; }
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : v.zone;
    switch (n) {
      case 1: return 'house';        // RES_LOW
      case 2: return 'midrise';      // RES_HIGH
      case 3: return 'retail';       // COM_LOW
      case 4: return 'tower';        // COM_HIGH
      case 5: return 'warehouse';    // IND
      case 6: return 'tower';        // OFFICE
      case 7: return 'none';         // PARK   — do not build here
      case 8: return 'civic';        // CIVIC
      case 9: return 'none';         // ROAD
      case 10: return 'none';        // WATER
      case 11: return 'none';        // RESERVED
      default: return null;          // NONE — unzoned, let the typology decide
    }
  };
}

function generate(ctx, opts = {}) {
  const t0 = performance.now();
  if (S.chunks) S.chunks.clear();
  ctx.world.buildings.clear();

  const fronts = opts.frontages || collectFrontages(ctx);
  const rng = new Rng(hashString('buildings:plan', ctx.world.seed) >>> 0);
  const terrain = terrainApi(ctx);

  const zOverride = opts.useZoning === false ? null : zoningOverride(ctx);

  const lots = planLots(fronts, {
    rng, terrain, world: ctx.world,
    centre: opts.centre || [0, 0],
    radius: opts.radius ?? 300,
    seed: ctx.world.seed,
    limit: opts.limit ?? 620,
    maxSlope: opts.maxSlope ?? 0.30,
    waterLevel: ctx.world.terrain?.water ?? 0,
    industrialAt: opts.industrialAt || null,
    urbanBias: opts.urbanBias ?? 0,
    kindAt: opts.kindAt || zOverride,
    landmarks: opts.landmarks ?? 7,
  });

  if (opts.forceKind) for (const l of lots) l.kind = opts.forceKind(l);

  const ids = [];
  for (let i = 0; i < lots.length; i++) {
    const l = lots[i];
    const seed = (hashString(`b:${l.segId}:${l.side}:${i}`, ctx.world.seed) ^ (i * 2654435761)) >>> 0;
    S.chunks.add(l, seed);
  }
  const counts = S.chunks.finalize();

  for (const rec of S.chunks.records) {
    const s = rec.spec;
    ctx.world.buildings.set(rec.id, {
      id: rec.id,
      lot: [],
      footprint: [s.W, s.D],
      height: s.height,
      levels: s.levels,
      kind: s.kind,
      zone: s.occ,
      rotation: rec.rot,
      address: { segmentId: rec.lot.segId, t: rec.lot.t },
      seed: rec.seed,
      state: 'built',
      pos: [rec.x, rec.baseY, rec.z],
    });
    ids.push(rec.id);
  }

  S.built = true;
  S.buildMs = performance.now() - t0;
  S.lastPlan = { lots: lots.length, ...counts, tally: lots.tally || null, buildMs: Math.round(S.buildMs) };
  applyTime(ctx, ctx.world.time.hours);
  ctx.events.emit('buildings:spawned', { ids });
  ctx.log.info('generated', S.lastPlan);
  return S.lastPlan;
}

/* ------------------------------------------------------------- lifecycle -- */

const mod = {
  name: 'buildings',
  version: '1.0.0',
  dependsOn: ['terrain', 'roads', 'zoning'],
  provides: ['spawnOnLot', 'despawn', 'buildingsNear', 'generateForNetwork', 'setLodBias', 'stats'],

  async init(ctx) {
    S.ctx = ctx;
    try {
      S.tex = new BuildingTextures(ctx.renderer, ctx.world.seed, ctx.opts?.quality === 'low' ? 'low' : 'high');
    } catch (err) {
      ctx.log.warn('texture generation failed:', err.message);
      S.tex = new BuildingTextures(null, ctx.world.seed, 'low');
    }
    S.mats = new BuildingMaterials(ctx, S.tex);
    // A 200 m merge cell holds a whole downtown block rather than a corner of
    // one, which is where the module's draw-call count actually lives (R-demo-5).
    // The LOD rings reach past every hero camera on purpose — see Chunks.js.
    S.chunks = new ChunkManager(ctx, S.mats, { cellSize: 200, dist: [820, 1500] });

    S.offEvents.push(ctx.events.on('time:changed', (p) => {
      applyTime(ctx, p && p.hours !== undefined ? p.hours : ctx.world.time.hours);
    }, 'buildings'));

    S.offEvents.push(ctx.events.on('weather:changed', (p) => {
      S.mats?.setWetness(p?.wetness ?? ctx.world.weather?.wetness ?? 0);
    }, 'buildings'));

    // R-sim-4: light the windows from the city that is actually in them.
    S.offEvents.push(ctx.events.on('sim:rhythm', (p) => {
      if (!S.mats || !p || !p.occupancy) return;
      S.mats.setOccupancy(p.occupancy);
      S.mats.setNight(S.night, p.hours !== undefined ? p.hours : ctx.world.time.hours);
    }, 'buildings'));

    S.offEvents.push(ctx.events.on('roads:changed', () => {
      if (!S.built || ctx.opts?.showcase) return;
      generate(ctx, {});
    }, 'buildings'));

    applyTime(ctx, ctx.world.time.hours);

    if (!ctx.opts?.showcase && ctx.world.roads.segments.size > 0) {
      generate(ctx, {});
    }
    ctx.log.info('ready', S.lastPlan || { buildings: 0 });
  },

  rebuild(ctx, what) {
    if ((what === 'roads' || what === 'zoning') && S.built && !ctx.opts?.showcase) generate(ctx, {});
  },

  update(ctx) {
    if (S.chunks) S.chunks.update(ctx.camera.position);
  },

  showcase(ctx, variant = 'default') {
    S.ctx = ctx;
    clearStage(ctx, S);
    const plan = stageShowcase(ctx, variant, S, generate);
    applyTime(ctx, ctx.world.time.hours);
    if (S.chunks) S.chunks.update(ctx.camera.position, true);
    return framingFor(ctx, variant, S, plan);
  },

  dispose(ctx) {
    for (const off of S.offEvents) { try { off(); } catch { /* ignore */ } }
    S.offEvents.length = 0;
    clearStage(ctx, S);
    S.chunks?.dispose();
    S.mats?.dispose();
    S.tex?.dispose();
    S.chunks = null; S.mats = null; S.tex = null; S.built = false;
    ctx.world.buildings.clear();
  },

  /* ------------------------------------------------------------- API --- */

  /** Place one building on an explicit lot. Returns its id (or null). */
  spawnOnLot(lot) {
    const ctx = S.ctx;
    if (!ctx || !S.chunks || !lot) return null;
    const terrain = terrainApi(ctx);
    const hAt = terrain ? (x, z) => terrain.heightAt(x, z) : (x, z) => ctx.world.heightAt(x, z);
    const l = {
      x: lot.x, z: lot.z, rot: lot.rot ?? 0,
      w: lot.w ?? 16, d: lot.d ?? 14,
      kind: lot.kind || 'midrise',
      urban: lot.urban ?? 0.5,
      segId: lot.segId ?? 0, side: lot.side ?? 1, t: lot.t ?? 0.5,
      baseY: lot.baseY ?? hAt(lot.x, lot.z),
      minY: lot.minY ?? (lot.baseY ?? hAt(lot.x, lot.z)) - 1,
    };
    const seed = (lot.seed ?? hashString(`spawn:${l.x.toFixed(1)}:${l.z.toFixed(1)}`, ctx.world.seed)) >>> 0;
    const rec = S.chunks.add(l, seed);
    const c = S.chunks.cellFor(l.x, l.z);
    S.chunks.rebuildCell(c);        // assigns rec.id from the chunk id counter
    ctx.world.buildings.set(rec.id, {
      id: rec.id, lot: [], footprint: [rec.spec.W, rec.spec.D],
      height: rec.spec.height, levels: rec.spec.levels, kind: rec.spec.kind,
      zone: rec.spec.occ, rotation: rec.rot,
      address: { segmentId: l.segId, t: l.t }, seed, state: 'built',
      pos: [l.x, l.baseY, l.z],
    });
    ctx.events.emit('buildings:spawned', { ids: [rec.id] });
    return rec.id;
  },

  despawn(ids) {
    const ctx = S.ctx;
    if (!ctx || !S.chunks) return 0;
    const list = Array.isArray(ids) ? ids : [ids];
    const n = S.chunks.remove(list);
    for (const id of list) ctx.world.buildings.delete(id);
    if (list.length) ctx.events.emit('buildings:removed', { ids: list });
    return n;
  },

  buildingsNear(pos, r = 60) {
    if (!S.chunks) return [];
    const x = pos.x ?? pos[0] ?? 0;
    const z = pos.z ?? pos[2] ?? 0;
    return S.chunks.near(x, z, r).map((rec) => ({
      id: rec.id, kind: rec.spec.kind, height: rec.spec.height, levels: rec.spec.levels,
      pos: [rec.x, rec.baseY, rec.z], rotation: rec.rot,
      footprint: [rec.spec.W, rec.spec.D],
    }));
  },

  generateForNetwork(opts = {}) {
    const ctx = S.ctx;
    if (!ctx) return null;
    return generate(ctx, opts);
  },

  /** >1 keeps full detail further out, <1 pulls the LOD rings in. */
  setLodBias(b) {
    if (!S.chunks) return 1;
    S.chunks.bias = Math.max(0.15, Math.min(6, b || 1));
    S.chunks.update(S.ctx.camera.position, true);
    return S.chunks.bias;
  },

  stats() {
    return {
      ...(S.chunks ? S.chunks.stats() : { buildings: 0 }),
      night: +S.night.toFixed(3),
      buildMs: Math.round(S.buildMs),
      plan: S.lastPlan,
    };
  },
};

mod.api = {
  materials: () => S.mats,
  chunks: () => S.chunks,
  nightAmount: () => S.night,
  regenerate: (o) => (S.ctx ? generate(S.ctx, o || {}) : null),
};

export default mod;
