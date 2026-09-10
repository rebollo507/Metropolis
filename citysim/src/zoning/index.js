import { ZONE } from '../core/World.js';
import { Rng, hashString } from '../core/Rng.js';
import ZoneGrid from './Grid.js';
import { extractBlocks } from './Blocks.js';
import { subdivideAll } from './Lots.js';
import { autoZone as runAutoZone, applyMixedUse, applyFrontageZones } from './AutoZone.js';
import { retailRuns, frameRun } from './Corridors.js';
import Overlay from './Overlay.js';
import Ribbons from './Ribbons.js';
import { PALETTE, ZONE_NAME, legend, isLandUse } from './Palette.js';
import { pointInPoly, bbox, rayExit } from './geom.js';

/**
 * zoning — land use, blocks and lots.
 *
 * Three products, in dependency order:
 *
 *  1. **the cell grid** (`world.zoning.cells`, 8 m) with ROAD and WATER stamped
 *     as masks and land use painted over the rest — the cheap query surface
 *     (`zoneAt`) and what the paint tools mutate;
 *  2. **blocks and lots** — the faces of the planar road graph, inset by a
 *     per-zone setback and subdivided into street-fronting lots. This is the
 *     contract `buildings` builds against, so it is the part that gets the
 *     effort: owned corner lots instead of overlapping rectangles, depth capped
 *     at half the local block width, and sliver merging instead of sliver
 *     emission;
 *  3. **the overlay** — one terrain-conforming mesh reading three DataTextures,
 *     OFF by default so it never appears in another module's shot.
 */

const S = {
  ctx: null,
  grid: null,
  blocks: [],
  lots: [],
  lotById: new Map(),
  planar: null,
  blockOf: null,
  overlay: null,
  ribbons: null,
  core: null,
  coreR: 0,
  chains: [],
  corridors: null,
  runs: [],
  blockIndex: null,
  dirtyRoads: false,
  built: false,
  buildMs: 0,
  lastCounts: null,
  overlayOn: false,
  ribbonsOn: false,
  variant: null,
  offEvents: [],
  extras: [],
};

/* ---------------------------------------------------------------- utils -- */

function terrainOf(ctx) {
  const t = ctx.get('terrain');
  if (t && typeof t.heightAt === 'function') return t;
  return null;
}

function waterLevel(ctx) {
  return ctx.world.terrain?.water ?? 0;
}

function roadRadiusFn(ctx) {
  const roads = ctx.get('roads');
  const net = roads ? roads.network() : null;
  const cache = new Map();
  return (cls) => {
    let v = cache.get(cls);
    if (v === undefined) {
      const l = net && net.laneLayout ? net.laneLayout(cls) : null;
      v = l ? l.half + (l.sidewalk || 0) : 6;
      cache.set(cls, v);
    }
    return v;
  };
}

function bumpVersion(ctx, reason) {
  const z = ctx.world.zoning;
  z.version++;
  ctx.events.emit('zoning:changed', { version: z.version, cells: z.cells, reason: reason || 'edit' });
}

/** Scanline a polygon into a per-cell callback (used for the block-id map). */
function eachCell(grid, pts, fn) {
  const b = bbox(pts);
  const i0 = Math.max(0, grid.ci(b.x0)), i1 = Math.min(grid.gridW - 1, grid.ci(b.x1));
  const j0 = Math.max(0, grid.cj(b.z0)), j1 = Math.min(grid.gridH - 1, grid.cj(b.z1));
  for (let j = j0; j <= j1; j++) {
    const cz = grid.wz(j);
    for (let i = i0; i <= i1; i++) {
      if (pointInPoly(pts, grid.wx(i), cz)) fn(j * grid.gridW + i);
    }
  }
}

/* --------------------------------------------------------------- rebuild -- */

function rasterize(ctx) {
  const grid = S.grid;
  if (!grid) return;
  // R-tools-6: only the cells autoZone owns are wiped; hand-painted land stays.
  const kept = grid.clearDerived();
  S.authoredKept = kept;
  const terrain = terrainOf(ctx);
  if (terrain) grid.stampWater(terrain, waterLevel(ctx));
  if (S.planar) grid.stampRoads(S.planar.polys, roadRadiusFn(ctx));

  // The base zone is painted over the whole block FACE (out to the road
  // centrelines). ROAD and WATER are masks that painting will not overwrite, so
  // the colour stops exactly at the kerb instead of leaving a bald verge.
  S.blockOf = new Uint16Array(grid.cells.length);
  for (const b of S.blocks) {
    const P = b.poly;
    if (!P || P.length < 3) continue;
    grid.paintPolygon(P, b.zone, { record: false, respectAuthored: true, authored: 0 });
    eachCell(grid, P, (k) => { S.blockOf[k] = b.id; });
  }
  // lots overpaint their block's base zone, which is what makes a mixed-use
  // block read as commercial frontage with residential behind it
  for (const lot of S.lots) {
    grid.paintPolygon(lot.poly, lot.zone, { record: false, respectAuthored: true, authored: 0 });
  }
  grid.undoStack.length = 0;
}

/**
 * Full pipeline: planar graph → blocks → zones → lots → cells → textures.
 * Safe to call at any time; never throws on a missing dependency.
 */
function rebuildAll(ctx, { zone = true, seed = null } = {}) {
  const t0 = performance.now();
  const roads = ctx.get('roads');
  S.dirtyRoads = false;

  if (!roads || !roads.network || !roads.network()) {
    S.blocks = []; S.lots = []; S.lotById.clear(); S.planar = null;
    return null;
  }

  const r = extractBlocks(roads, { minArea: 420 }, ctx.log);
  S.blocks = r.blocks;
  S.planar = r.planar;

  if (!S.blocks.length) {
    S.lots = []; S.lotById.clear();
    if (S.grid) { rasterize(ctx); }
    return null;
  }

  // the water mask has to exist before the auto-zoner can measure distance to it
  if (S.grid) {
    S.grid.clearDerived();
    const terrain = terrainOf(ctx);
    if (terrain) S.grid.stampWater(terrain, waterLevel(ctx));
    if (S.planar) S.grid.stampRoads(S.planar.polys, roadRadiusFn(ctx));
  }

  if (zone) {
    const info = runAutoZone(S.blocks, S.planar, {
      terrain: terrainOf(ctx),
      waterLevel: waterLevel(ctx),
      grid: S.grid,
      roads,
      seed: seed ?? ctx.world.seed,
      log: ctx.log,
    });
    S.core = info.core; S.coreR = info.coreR;
    S.chains = info.chains || [];
    S.corridors = info.corridors || null;
  } else {
    for (const b of S.blocks) if (!b.zoneName) { b.zone = ZONE.RES_LOW; b.zoneName = 'RES_LOW'; }
  }

  const lotSeed = (hashString('zoning:lots', (seed ?? ctx.world.seed) >>> 0)) >>> 0;
  S.lots = subdivideAll(S.blocks, {
    terrain: terrainOf(ctx),
    waterLevel: waterLevel(ctx),
    polys: S.planar.polys,
    maxSlope: 0.46,
    rngFor: (blockId) => new Rng((lotSeed ^ Math.imul(blockId, 2654435761)) >>> 0),
  }, ctx.log);

  applyMixedUse(S.blocks, S.lots);
  const forced = applyFrontageZones(S.blocks, S.lots);

  S.lotById.clear();
  for (const l of S.lots) S.lotById.set(l.id, l);

  // measured, not intended: what contiguous retail actually exists
  S.runs = S.chains.length
    ? retailRuns(S.lots, S.chains, roads, { terrain: terrainOf(ctx) })
    : [];
  S.blockIndex = null;

  rasterize(ctx);
  refreshVisuals(ctx);

  S.built = true;
  S.buildMs = performance.now() - t0;
  S.lastCounts = {
    blocks: S.blocks.length,
    lots: S.lots.length,
    corners: S.lots.filter((l) => l.corner).length,
    meanLotArea: S.lots.length ? Math.round(S.lots.reduce((a, l) => a + l.area, 0) / S.lots.length) : 0,
    retailForced: forced,
    longestRetailRun: S.runs.length ? Math.round(S.runs[0].length) : 0,
    authoredKept: S.authoredKept || 0,
    buildMs: Math.round(S.buildMs),
  };
  ctx.log.info('rebuilt', S.lastCounts);
  bumpVersion(ctx, 'rebuild');
  return S.lastCounts;
}

/* -------------------------------------------------------------- visuals -- */

function zonedArea() {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const b of S.blocks) {
    const bb = b.bbox;
    if (bb.x0 < x0) x0 = bb.x0;
    if (bb.z0 < z0) z0 = bb.z0;
    if (bb.x1 > x1) x1 = bb.x1;
    if (bb.z1 > z1) z1 = bb.z1;
  }
  if (!Number.isFinite(x0)) return { x0: -300, z0: -300, x1: 300, z1: 300 };
  return { x0, z0, x1, z1 };
}

function refreshVisuals(ctx) {
  if (!S.overlay) return;
  S.overlay.refresh(S.blockOf);
  if (!S.overlay.mesh) {
    const mesh = S.overlay.build(zonedArea(), terrainOf(ctx), waterLevel(ctx));
    if (mesh) ctx.group.add(mesh);
    S.overlay.setTime(ctx.world.time.hours);
    S.overlay.setEnabled(S.overlayOn);
  }
  if (S.ribbonsOn) buildRibbons(ctx);
}

function buildRibbons(ctx) {
  if (!S.ribbons) S.ribbons = new Ribbons(ctx);
  const m = S.ribbons.build(S.lots, S.blocks, terrainOf(ctx));
  if (m) ctx.group.add(m);
}

/** Uniform 96 m hash over block bounding boxes — `blockAt` is a hot query. */
function buildBlockIndex() {
  const m = new Map();
  for (const b of S.blocks) {
    const bb = b.bbox;
    for (let j = Math.floor(bb.z0 / 96); j <= Math.floor(bb.z1 / 96); j++) {
      for (let i = Math.floor(bb.x0 / 96); i <= Math.floor(bb.x1 / 96); i++) {
        const k = i + ',' + j;
        let arr = m.get(k);
        if (!arr) { arr = []; m.set(k, arr); }
        arr.push(b);
      }
    }
  }
  S.blockIndex = m;
}

/* -------------------------------------------------------- showcase glue -- */

function clearShowcase(ctx) {
  for (const e of S.extras) { e.geometry?.dispose?.(); e.removeFromParent?.(); }
  S.extras.length = 0;
}

/**
 * A hand-painted district for the `paint` variant: this is exactly the sequence
 * a player would draw with the zone brush, run through the public API.
 */
function paintDistrict(ctx) {
  const grid = S.grid;
  if (!grid || !S.blocks.length) return;
  const a = zonedArea();
  const inset = 26;                     // keep every stroke off the overlay's own edge
  const x0 = a.x0 + inset, x1 = a.x1 - inset, z0 = a.z0 + inset, z1 = a.z1 - inset;
  const W = Math.max(80, x1 - x0), H = Math.max(80, z1 - z0);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const rng = new Rng((hashString('zoning:paint', ctx.world.seed >>> 0)) >>> 0);
  const clampX = (v) => Math.max(x0, Math.min(x1, v));
  const clampZ = (v) => Math.max(z0, Math.min(z1, v));
  const dab = (x, z, r, zone) => grid.paintCircle(clampX(x), clampZ(z), r, zone, { record: false, onlyZoned: true });
  const band = (ax, az, bx, bz, r, zone, n = 14) => {
    for (let i = 0; i <= n; i++) dab(ax + (bx - ax) * (i / n), az + (bz - az) * (i / n), r, zone);
  };

  // 1 — wipe the auto plan, then lay the district down block by block. Every
  // later stroke uses `onlyZoned`, so the brush can never spill onto raw
  // hillside no matter how loosely it is swung.
  grid.paintRect(x0 - inset * 3, z0 - inset * 3, x1 + inset * 3, z1 + inset * 3, ZONE.NONE, { record: false });
  for (const b of S.blocks) grid.paintPolygon(b.poly, ZONE.RES_LOW, { record: false });

  // 3 — a commercial spine down the long axis, with offices at the crossing
  const along = W >= H;
  const half = (along ? W : H) * 0.42;
  const jitter = (t) => Math.sin(t * 3.1) * (along ? H : W) * 0.045;
  for (let i = -1; i <= 1; i += 2 / 18) {
    const t = i;
    if (along) dab(cx + t * half, cz + jitter(t), 44, ZONE.COM_HIGH);
    else dab(cx + jitter(t), cz + t * half, 44, ZONE.COM_HIGH);
  }
  dab(cx, cz, 78, ZONE.OFFICE);

  // 4 — denser housing flanking the spine, low-rise beyond it
  for (const side of [-1, 1]) {
    for (let k = -2; k <= 2; k++) {
      const u = k * 0.21;
      const v = side * 0.20;
      dab(cx + (along ? u * W : v * W) + rng.range(-14, 14),
        cz + (along ? v * H : u * H) + rng.range(-14, 14), 62, ZONE.RES_HIGH);
    }
  }

  // 5 — a green wedge on one flank and a civic square beside the spine
  band(cx - W * 0.42, cz + H * 0.40, cx - W * 0.12, cz + H * 0.46, 56, ZONE.PARK, 6);
  grid.paintRect(clampX(cx + W * 0.10), clampZ(cz - H * 0.20),
    clampX(cx + W * 0.24), clampZ(cz - H * 0.07), ZONE.CIVIC, { record: false, onlyZoned: true });

  // 6 — light industry in the far corner, away from the green and the river
  grid.paintRect(clampX(cx + W * 0.24), clampZ(cz + H * 0.24),
    clampX(x1), clampZ(z1), ZONE.IND, { record: false, onlyZoned: true });

  /* 7 — snap the brush to the cadastre. A zoning brush in a city builder does
   * not leave circular blobs on the ground: it selects lots, and the lots are
   * what get coloured. Re-tagging from the painted grid and then re-stamping
   * every lot polygon does exactly that, leaving the soft brush only in the
   * block interiors that carry no frontage. */
  retagLots();
  for (const lot of S.lots) {
    grid.paintPolygon(lot.poly, lot.zone, { record: false, respectAuthored: true, authored: 0 });
  }
  grid.undoStack.length = 0;
}

/** After a paint edit, lots inherit whatever zone now covers their centre. */
function retagLots(region = null) {
  const grid = S.grid;
  if (!grid) return 0;
  let n = 0;
  for (const lot of S.lots) {
    const c = lot.center;
    if (region && !region(c[0], c[2])) continue;
    let z = grid.zoneAt(c[0], c[2]);
    if (!isLandUse(z)) {
      // the centre landed on a road/water cell — probe the lot's own interior
      const f = lot.frontage.mid, nn = lot.frontage.normal;
      z = grid.zoneAt(f[0] - nn[0] * lot.depth * 0.5, f[1] - nn[1] * lot.depth * 0.5);
    }
    if (isLandUse(z) && z !== lot.zone) { lot.zone = z; lot.zoneName = ZONE_NAME[z]; n++; }
  }
  return n;
}

/* ------------------------------------------------------------- lifecycle -- */

const mod = {
  name: 'zoning',
  version: '1.0.0',
  dependsOn: ['terrain', 'roads'],
  provides: [
    'zoneAt', 'paint', 'paintCircle', 'erase', 'autoZone',
    'lots', 'lotsInBlock', 'lotsOfZone', 'blocks', 'setOverlay', 'stats',
    // round 2: what `demo` needs to point a lens at a shopfront (R-demo-13)
    'retailFrontages', 'highStreet',
    // round 2: what `buildings` needs to stop guessing block depth (R-bldg-2)
    'blockAt', 'depthToRoad',
  ],

  api: {},

  async init(ctx) {
    S.ctx = ctx;
    S.grid = new ZoneGrid(ctx.world, ctx.log);
    S.overlay = new Overlay(ctx, S.grid);
    S.overlayOn = false;

    const terrain = terrainOf(ctx);
    if (terrain) S.grid.stampWater(terrain, waterLevel(ctx));

    S.offEvents.push(ctx.events.on('time:changed', (p) => {
      S.overlay?.setTime(p?.hours ?? ctx.world.time.hours, p);
    }, 'zoning'));
    S.offEvents.push(ctx.events.on('roads:changed', () => { S.dirtyRoads = true; }, 'zoning'));
    S.offEvents.push(ctx.events.on('terrain:changed', () => { S.dirtyRoads = true; }, 'zoning'));

    if (!ctx.opts?.showcase && ctx.world.roads.segments.size > 0) {
      rebuildAll(ctx, { zone: true });
    }

    ctx.log.info(`ready — ${S.grid.gridW}×${S.grid.gridH} cells @ ${S.grid.cellSize} m`
      + (S.lastCounts ? `, ${S.lastCounts.blocks} blocks / ${S.lastCounts.lots} lots` : ''));
  },

  rebuild(ctx, what) {
    if (what === 'roads' || what === 'terrain') S.dirtyRoads = true;
  },

  update(ctx, dt, elapsed) {
    if (S.dirtyRoads) {
      S.dirtyRoads = false;
      try { rebuildAll(ctx, { zone: true }); }
      catch (err) { ctx.log.warn('rebuild failed, keeping previous zoning:', err.message); }
    }
    if (S.overlay) S.overlay.update(elapsed);
  },

  /* --------------------------------------------------------------- API -- */

  zoneAt(x, z) { return S.grid ? S.grid.zoneAt(x, z) : ZONE.NONE; },

  /** paint(polygon | {x,z,r} | {x0,z0,x1,z1} | {points}, zone) */
  paint(shape, zone) {
    if (!S.grid) return 0;
    const n = S.grid.paintShape(shape, zone);
    if (n) { retagLots(); refreshOverlayOnly(); bumpVersion(S.ctx, 'paint'); }
    return n;
  },

  paintCircle(x, z, r, zone) {
    if (!S.grid) return 0;
    const n = S.grid.paintCircle(x, z, r, zone);
    if (n) {
      const r2 = (r + 40) * (r + 40);
      retagLots((px, pz) => (px - x) * (px - x) + (pz - z) * (pz - z) < r2);
      refreshOverlayOnly(); bumpVersion(S.ctx, 'paint');
    }
    return n;
  },

  paintRect(x0, z0, x1, z1, zone) {
    if (!S.grid) return 0;
    const n = S.grid.paintRect(x0, z0, x1, z1, zone);
    if (n) { retagLots(); refreshOverlayOnly(); bumpVersion(S.ctx, 'paint'); }
    return n;
  },

  erase(shape) { return mod.paint(shape, ZONE.NONE); },

  undo() {
    if (!S.grid || !S.grid.undo()) return false;
    retagLots(); refreshOverlayOnly(); bumpVersion(S.ctx, 'undo');
    return true;
  },

  cellsOfZone(zone) { return S.grid ? S.grid.cellsOfZone(zone) : new Int32Array(0); },

  /** Re-derive the whole land-use plan from the road network and terrain. */
  autoZone(seed = null) {
    if (!S.ctx) return null;
    return rebuildAll(S.ctx, { zone: true, seed });
  },

  lots() { return S.lots; },
  lotsInBlock(id) {
    const b = S.blocks.find((x) => x.id === id);
    if (!b || !b.lotIds) return [];
    return b.lotIds.map((i) => S.lotById.get(i)).filter(Boolean);
  },
  blocks() { return S.blocks; },

  setOverlay(on) {
    S.overlayOn = !!on;
    if (S.overlay) {
      if (!S.overlay.mesh && S.ctx && S.blocks.length) refreshVisuals(S.ctx);
      S.overlay.setEnabled(S.overlayOn);
    }
    return S.overlayOn;
  },

  /**
   * Every lot of a zone. Accepts an enum value, a name ('COM_LOW'), or an array
   * of either. R-demo-13 asked for exactly this; `retailFrontages()` below is
   * the version that already did the search.
   */
  lotsOfZone(zone) {
    const want = new Set();
    for (const z of Array.isArray(zone) ? zone : [zone]) {
      if (typeof z === 'number') want.add(z);
      else if (typeof z === 'string' && ZONE[z] !== undefined) want.add(ZONE[z]);
    }
    if (!want.size) return [];
    return S.lots.filter((l) => want.has(l.zone));
  },

  /**
   * Contiguous runs of commercial frontage along one street, longest first.
   *
   * A run is what a street lens needs and a lot list is not: lots grouped by
   * street (segments chained across junctions by collinearity) and by side,
   * ordered along the kerb, split wherever the gap exceeds `maxGap`.
   *
   * @param {object} [opts] `{zones, maxGap = 34, minLength = 0, limit}`
   * @returns {Array} see the run shape documented in `Corridors.finish`
   */
  retailFrontages(opts = {}) {
    if (!S.chains.length || !S.lots.length) return [];
    const roads = S.ctx && S.ctx.get('roads');
    if (!roads) return [];
    let runs = S.runs;
    // re-measure only when the caller wants different rules
    if (opts.zones || opts.maxGap !== undefined || opts.terrain) {
      runs = retailRuns(S.lots, S.chains, roads, {
        terrain: terrainOf(S.ctx), ...opts,
      });
    }
    const out = opts.minLength ? runs.filter((r) => r.length >= opts.minLength) : runs;
    return opts.limit ? out.slice(0, opts.limit) : out;
  },

  /**
   * The single best street to photograph a shopfront on: the longest retail run,
   * plus a ready-made street framing (`{target, dist, az, pol, fov}`) that a
   * showcase may return verbatim.
   */
  highStreet() {
    const run = S.runs[0] || null;
    if (!run) return null;
    return {
      run,
      length: run.length,
      segmentId: run.segmentId,
      class: run.class,
      t0: run.t0, t1: run.t1,
      side: run.side,
      mid: run.mid,
      lotIds: run.lotIds,
      camera: frameRun(run),
      planned: S.corridors && S.corridors.high
        ? { length: S.corridors.high.length, class: S.corridors.high.cls, mid: S.corridors.high.mid }
        : null,
    };
  },

  /**
   * The block containing (x, z) — polygon, buildable ring and measured depth.
   * R-bldg-2: `buildings` was inferring this by trying five footprints.
   */
  blockAt(x, z) {
    if (!S.blocks.length) return null;
    if (!S.blockIndex) buildBlockIndex();
    const key = Math.floor(x / 96) + ',' + Math.floor(z / 96);
    const cand = S.blockIndex.get(key);
    if (!cand) return null;
    for (const b of cand) {
      const bb = b.bbox;
      if (x < bb.x0 || x > bb.x1 || z < bb.z0 || z > bb.z1) continue;
      if (pointInPoly(b.poly, x, z)) return b;
    }
    return null;
  },

  /**
   * How much buildable ground lies between (x, z) and the building line, going
   * in direction (dx, dz). Polygon-exact — deliberately NOT a cell-grid answer,
   * because R-bldg-2 was caused by an 8 m raster inflating every road.
   * @returns {{d, blockId, inSetback, hit}} `d` in metres, `Infinity` outside any block
   */
  depthToRoad(x, z, dx = 1, dz = 0) {
    const L = Math.hypot(dx, dz) || 1;
    const ux = dx / L, uz = dz / L;
    const b = mod.blockAt(x, z);
    if (!b) return { d: 0, blockId: null, inSetback: false, hit: 'nowhere' };
    const ring = b.inset && b.inset.length >= 3 ? b.inset : b.poly;
    const inBuildable = pointInPoly(ring, x, z);
    if (!inBuildable) {
      // between the kerb and the building line: no room in this direction
      return { d: 0, blockId: b.id, inSetback: true, hit: 'setback' };
    }
    return {
      d: rayExit(ring, x, z, ux, uz, 500),
      blockId: b.id,
      inSetback: false,
      hit: 'buildingLine',
    };
  },

  /** Hand-paint mode: when off, strokes are treated as derived (R-tools-6). */
  setAuthoring(on) {
    if (S.grid) S.grid.authoring = !!on;
    return !!on;
  },

  /** Give hand-painted cells back to the auto-zoner. */
  clearAuthored(shape = null) {
    if (!S.grid) return 0;
    const n = S.grid.clearAuthored(shape);
    refreshOverlayOnly();
    bumpVersion(S.ctx, 'authored');
    return n;
  },

  stats() {
    const counts = S.grid ? S.grid.counts() : new Int32Array(16);
    const cellArea = S.grid ? S.grid.cellSize * S.grid.cellSize : 64;
    const byZone = {};
    for (let z = 0; z < 12; z++) {
      const name = ZONE_NAME[z];
      if (!name) continue;
      byZone[name] = { cells: counts[z], area: counts[z] * cellArea };
    }
    const lotsByZone = {};
    for (const l of S.lots) lotsByZone[l.zoneName] = (lotsByZone[l.zoneName] || 0) + 1;
    return {
      version: S.ctx ? S.ctx.world.zoning.version : 0,
      grid: { w: S.grid?.gridW || 0, h: S.grid?.gridH || 0, cellSize: S.grid?.cellSize || 8 },
      blocks: S.blocks.length,
      lots: S.lots.length,
      cornerLots: S.lots.filter((l) => l.corner).length,
      meanLotArea: S.lastCounts?.meanLotArea || 0,
      core: S.core ? { x: +S.core.x.toFixed(1), z: +S.core.z.toFixed(1), radius: Math.round(S.coreR || 0) } : null,
      byZone,
      lotsByZone,
      authoredCells: S.grid ? S.grid.authoredCount() : 0,
      retail: {
        runs: S.runs.length,
        longest: S.runs.length ? +S.runs[0].length.toFixed(1) : 0,
        top5: S.runs.slice(0, 5).map((r) => +r.length.toFixed(1)),
        plannedHighStreet: S.corridors && S.corridors.high ? +S.corridors.high.length.toFixed(1) : 0,
        parades: S.corridors ? S.corridors.parades.length : 0,
        streets: S.chains.length,
      },
      buildMs: Math.round(S.buildMs),
      overlay: S.overlayOn,
      drawCalls: (S.overlay?.mesh && S.overlayOn ? 1 : 0) + (S.ribbons?.mesh ? 1 : 0),
    };
  },

  /* ---------------------------------------------------------- showcase -- */

  showcase(ctx, variant = 'default') {
    S.ctx = ctx;
    S.variant = variant;
    clearShowcase(ctx);
    S.ribbons?.dispose();
    S.ribbonsOn = false;

    const roads = ctx.get('roads');
    if (roads && roads.generateGrid) {
      // odd cols/rows: the generator's rank() puts a boulevard on the middle
      // row and column only when the middle index is an integer, and without
      // that hierarchy the auto-zoner has no centre to find.
      roads.generateGrid({
        cols: 7, rows: 7, blockW: 106, blockH: 88,
        highway: true, ramp: true, organic: true, alleys: true,
      });
    }

    S.overlayOn = true;
    S.ribbonsOn = variant === 'lots';
    rebuildAll(ctx, { zone: true });

    if (variant === 'paint') paintDistrict(ctx);
    if (S.ribbonsOn) buildRibbons(ctx);
    refreshOverlayOnly();
    if (S.overlay) { S.overlay.setTime(ctx.world.time.hours); S.overlay.setEnabled(S.overlayOn); }
    S.dirtyRoads = false;

    const terrain = terrainOf(ctx);
    const area = zonedArea();
    // frame the whole plan, not the core: the point of the aerial variants is
    // the land-use pattern across the city
    const mid = [(area.x0 + area.x1) * 0.5, (area.z0 + area.z1) * 0.5];
    const span = Math.max(area.x1 - area.x0, area.z1 - area.z0);
    const yMid = terrain ? terrain.heightAt(mid[0], mid[1]) : 0;
    const c = S.core || { x: mid[0], z: mid[1] };
    const yCore = terrain ? terrain.heightAt(c.x, c.z) : 0;
    const tx0 = () => mid[0] + span * 0.055;
    const tz0 = () => mid[1] + span * 0.055;
    const yT0 = () => (terrain ? terrain.heightAt(tx0(), tz0()) : yMid);

    /* `street` — stand in the high street the auto-zoner grew and look down it.
     * This is the frame R-demo-13 says the city could not produce: a continuous
     * run of retail frontage filling the width of a 50 mm lens. The framing is
     * computed from the measured run, not hand-tuned, so it follows the plan
     * wherever the seed puts it. */
    if (variant === 'street' || variant === 'highstreet') {
      const hs = mod.highStreet();
      // The overlay is a plan instrument; on a pavement it is paint on the road.
      // The lot ribbons stay, faintly, because the continuity of the frontage is
      // the thing being claimed and they are what shows it.
      S.overlayOn = false;
      if (S.overlay) S.overlay.setEnabled(false);
      S.ribbons?.dispose();
      buildRibbons(ctx);
      if (S.ribbons?.material) S.ribbons.material.uniforms.uOpacity.value = 0.42;
      // The whole point of this variant is whether a SHOPFRONT is photographable,
      // and shopfronts belong to `buildings`. R-7/R-8 shipped `reveal`, so ask
      // for the modules that make the claim checkable instead of asserting it.
      const withCity = ['roads', 'buildings', 'props', 'traffic'];
      // `buildings` skips generation under a showcase, so ask it directly —
      // a claim about whether a shopfront can be photographed is only checkable
      // with the shopfronts in the frame.
      try {
        const B = ctx.get('buildings');
        if (B && typeof B.generateForNetwork === 'function') {
          const plan = B.generateForNetwork({});
          ctx.log.info('showcase:street — buildings staged for the proof frame', plan || '');
        }
      } catch (err) { ctx.log.warn('showcase:street — buildings unavailable:', err.message); }
      if (!hs || !hs.camera) {
        ctx.log.warn('showcase:street — no retail run found, falling back to the plan view');
        return { target: [tx0(), yT0(), tz0()], dist: 420, reveal: withCity };
      }
      ctx.log.info(`showcase:street — ${hs.length.toFixed(0)} m run of ${hs.class}, `
        + `${hs.lotIds.length} lots, side ${hs.side}`);
      return { ...hs.camera, reveal: withCity };
    }

    if (variant === 'lots') {
      // a low-opacity fill under the outlines: the zone of each lot is part of
      // what has to be judgeable, and bare wireframe on grass is not readable
      if (S.overlay) {
        S.overlay.setOpacity(0.15);
        S.overlay.material.uniforms.uHatchGain.value = 0.10;
        S.overlay.material.uniforms.uRimGain.value = 0.25;
        S.overlay.setEnabled(true);
      }
      // sit between downtown and the residential body so both densities of
      // subdivision are in the same frame
      const tx = c.x + (mid[0] - c.x) * 0.5, tz = c.z + (mid[1] - c.z) * 0.5;
      return {
        target: [tx, terrain ? terrain.heightAt(tx, tz) : 0, tz],
        dist: 255, pol: 0.76, az: 0.86, fov: 40,
        reveal: ['roads'],
      };
    }
    // The aerial preset looks down the +x/+z diagonal, so the near edge of the
    // plan is the one that runs off the bottom of the frame: bias the target
    // that way rather than pulling the camera further back into the fog.
    const bias = span * 0.055;
    const tx = mid[0] + bias, tz = mid[1] + bias;
    const yT = terrain ? terrain.heightAt(tx, tz) : yMid;
    void tx0; void tz0; void yT0;
    if (variant === 'paint') {
      if (S.overlay) { S.overlay.setOpacity(0.82); S.overlay.material.uniforms.uHatchGain.value = 0.36; }
      return { target: [tx, yT, tz], dist: Math.max(360, span * 1.0), fov: 42, reveal: ['roads'] };
    }
    if (S.overlay) S.overlay.setOpacity(0.80);
    return { target: [tx, yT, tz], dist: Math.max(360, span * 1.0), reveal: ['roads'] };
  },

  dispose(ctx) {
    for (const off of S.offEvents) { try { off(); } catch { /* ignore */ } }
    S.offEvents.length = 0;
    ctx.events.offOwner?.('zoning');
    clearShowcase(ctx);
    S.ribbons?.dispose();
    S.overlay?.dispose();
    S.overlay?.disposeTextures();
    S.overlay = null; S.ribbons = null;
    S.blocks = []; S.lots = []; S.lotById.clear();
    S.planar = null; S.grid = null; S.built = false;
  },
};

function refreshOverlayOnly() {
  if (!S.overlay || !S.ctx) return;
  S.overlay.refresh(S.blockOf);
  if (!S.overlay.mesh && S.blocks.length) {
    const mesh = S.overlay.build(zonedArea(), terrainOf(S.ctx), waterLevel(S.ctx));
    if (mesh) S.ctx.group.add(mesh);
    S.overlay.setTime(S.ctx.world.time.hours);
    S.overlay.setEnabled(S.overlayOn);
  }
}

/* Extra surface beyond the required `provides` list, resolved via ctx.get(). */
mod.api = {
  paintRect: (...a) => mod.paintRect(...a),
  setAuthoring: (on) => mod.setAuthoring(on),
  clearAuthored: (shape) => mod.clearAuthored(shape),
  authoredCells: () => (S.grid ? S.grid.authoredCount() : 0),
  chains: () => S.chains,
  corridors: () => S.corridors,
  frameRun: (run, o) => frameRun(run, o),
  cellsOfZone: (z) => mod.cellsOfZone(z),
  undo: () => mod.undo(),
  legend: () => legend(),
  palette: () => PALETTE,
  grid: () => S.grid,
  core: () => (S.core ? { ...S.core, radius: S.coreR } : null),
  lotById: (id) => S.lotById.get(id) || null,
  /** Lot whose polygon contains (x,z), or null. */
  lotAt: (x, z) => {
    for (const l of S.lots) {
      const bb = l._bb || (l._bb = bbox(l.poly));
      if (x < bb.x0 || x > bb.x1 || z < bb.z0 || z > bb.z1) continue;
      if (pointInPoly(l.poly, x, z)) return l;
    }
    return null;
  },
  lotsNear: (x, z, r = 60) => {
    const r2 = r * r;
    return S.lots.filter((l) => {
      const dx = l.center[0] - x, dz = l.center[2] - z;
      return dx * dx + dz * dz <= r2;
    });
  },
  setOverlayOpacity: (v) => S.overlay?.setOpacity(v),
  counts: () => S.lastCounts,
  rebuild: () => (S.ctx ? rebuildAll(S.ctx, { zone: true }) : null),
};

export { ZONE, PALETTE };
export default mod;
