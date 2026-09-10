import { ZONE } from '../core/World.js';
import { Rng, hashString } from '../core/Rng.js';
import { ZONE_NAME } from './Palette.js';
import { chamfer } from './field.js';
import { shapeWidth } from './geom.js';
import { buildChains, pickCorridors } from './Corridors.js';

/**
 * The auto-zoner: a land-use pattern derived from the road network and the
 * terrain, not from noise.
 *
 * The city's centre is found, not assumed — every junction is scored by the
 * class of the streets meeting it, that score is diffused over a 180 m
 * neighbourhood, and the strongest cluster becomes downtown. Everything else is
 * a function of four measured quantities per block: distance to that core,
 * the best road class on its frontage, distance to water, and distance to the
 * highway. That is why moving the highway or the river changes the zoning
 * instead of just re-rolling it.
 */

const CLASS_WEIGHT = { alley: 0.25, lane2: 1.0, lane4: 2.3, boulevard: 3.4, highway: 0.5 };
const CLASS_RANK = { alley: 0, lane2: 1, lane4: 2, boulevard: 3, highway: 4 };

/* --------------------------------------------------------- measurements -- */

function junctionScores(planar) {
  const { verts, edges } = planar;
  const raw = new Float64Array(verts.length);
  for (const v of verts) v._i = -1;
  verts.forEach((v, i) => { v._i = i; });
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    let s = 0, n = 0;
    for (const he of v.he) {
      const e = edges[he >> 1];
      if (e.dead) continue;
      s += CLASS_WEIGHT[e.cls] ?? 1;
      n++;
    }
    raw[i] = n >= 3 ? s * (1 + (n - 3) * 0.18) : s * 0.35;
  }
  // diffuse over a 180 m neighbourhood so a lone boulevard crossing does not win
  const R = 180, R2 = R * R;
  const smooth = new Float64Array(verts.length);
  for (let i = 0; i < verts.length; i++) {
    let acc = raw[i];
    for (let j = 0; j < verts.length; j++) {
      if (i === j) continue;
      const dx = verts[i].x - verts[j].x, dz = verts[i].z - verts[j].z;
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      acc += raw[j] * (1 - Math.sqrt(d2) / R) * 0.55;
    }
    smooth[i] = acc;
  }
  return smooth;
}

function findCore(planar, scores) {
  const { verts } = planar;
  let best = -1, bi = -1;
  for (let i = 0; i < verts.length; i++) if (scores[i] > best) { best = scores[i]; bi = i; }
  if (bi < 0) return { x: 0, z: 0, strength: 0 };
  let wx = 0, wz = 0, wsum = 0;
  for (let i = 0; i < verts.length; i++) {
    const dx = verts[i].x - verts[bi].x, dz = verts[i].z - verts[bi].z;
    if (dx * dx + dz * dz > 240 * 240) continue;
    const w = Math.max(0, scores[i] - best * 0.35);
    wx += verts[i].x * w; wz += verts[i].z * w; wsum += w;
  }
  if (wsum <= 1e-6) return { x: verts[bi].x, z: verts[bi].z, strength: best };
  return { x: wx / wsum, z: wz / wsum, strength: best };
}

function networkExtent(planar) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const v of planar.verts) {
    if (v.x < x0) x0 = v.x; if (v.x > x1) x1 = v.x;
    if (v.z < z0) z0 = v.z; if (v.z > z1) z1 = v.z;
  }
  if (!Number.isFinite(x0)) return { w: 600, h: 600, diag: 850 };
  return { x0, z0, x1, z1, w: x1 - x0, h: z1 - z0, diag: Math.hypot(x1 - x0, z1 - z0) };
}

function highwayDistanceFn(planar) {
  const pts = [];
  for (const e of planar.edges) {
    if (e.cls !== 'highway') continue;
    for (const p of e.pts) pts.push(p);
  }
  if (!pts.length) return () => Infinity;
  return (x, z) => {
    let best = Infinity;
    for (const p of pts) {
      const d = (p[0] - x) * (p[0] - x) + (p[1] - z) * (p[1] - z);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
}

/** Distance-to-water sampler built from the grid's WATER mask. */
export function waterDistanceFn(grid) {
  const w = grid.gridW, h = grid.gridH;
  const seed = new Uint8Array(w * h);
  let any = 0;
  for (let i = 0; i < seed.length; i++) if (grid.cells[i] === ZONE.WATER) { seed[i] = 1; any++; }
  if (!any) return () => Infinity;
  const d = chamfer(seed, w, h, grid.cellSize);
  return (x, z) => {
    const i = Math.max(0, Math.min(w - 1, grid.ci(x)));
    const j = Math.max(0, Math.min(h - 1, grid.cj(z)));
    return d[j * w + i];
  };
}

function blockTerrain(block, terrain, waterLevel) {
  if (!terrain) return { slope: 0, wetFrac: 0, steepFrac: 0, yMin: 0, yMax: 0, y: 0 };
  const pts = [block.centroid, ...block.poly];
  let wet = 0, steep = 0, sSum = 0, yMin = Infinity, yMax = -Infinity;
  const c = block.centroid;
  // interior probes on a small lattice so a big block is judged by its middle
  const probes = [];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    const r = Math.min(40, Math.sqrt(block.area) * 0.22);
    probes.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  const all = pts.concat(probes);
  for (const p of all) {
    const hh = terrain.heightAt(p[0], p[1]);
    const sl = terrain.slopeAt ? terrain.slopeAt(p[0], p[1], 5) : 0;
    if (hh < yMin) yMin = hh;
    if (hh > yMax) yMax = hh;
    if (hh <= waterLevel + 0.4) wet++;
    if (sl > 0.34) steep++;
    sSum += sl;
  }
  return {
    slope: sSum / all.length,
    wetFrac: wet / all.length,
    steepFrac: steep / all.length,
    yMin: Number.isFinite(yMin) ? yMin : 0,
    yMax: Number.isFinite(yMax) ? yMax : 0,
    y: terrain.heightAt(c[0], c[1]),
  };
}

/* ------------------------------------------------------------- the plan -- */

/**
 * Assign a zone to every block. Mutates `block.zone`, `block.zoneName`,
 * `block.mixedZone` and `block.metrics`.
 */
export function autoZone(blocks, planar, env) {
  const { terrain, waterLevel = 0, grid, seed = 1337, log = null } = env;
  if (!blocks.length) return { core: null, counts: {} };

  const rng = new Rng((hashString('zoning:autozone', seed >>> 0) ^ (seed >>> 0)) >>> 0);
  const chains = env.roads ? buildChains(env.roads) : [];
  const scores = junctionScores(planar);
  const core = findCore(planar, scores);
  const ext = networkExtent(planar);
  const dHwy = highwayDistanceFn(planar);
  const dWat = grid ? waterDistanceFn(grid) : () => Infinity;

  const coreR = Math.max(105, Math.min(340, ext.diag * 0.155));

  // per-block features
  for (const b of blocks) {
    const c = b.centroid;
    const t = blockTerrain(b, terrain, waterLevel);
    let maxRank = 0, ranks = new Set();
    for (const tag of b.tags) {
      const r = CLASS_RANK[tag.cls] ?? 1;
      if (r > maxRank) maxRank = r;
      ranks.add(r);
    }
    b.metrics = {
      dCore: Math.hypot(c[0] - core.x, c[1] - core.z),
      dWater: dWat(c[0], c[1]),
      dHighway: dHwy(c[0], c[1]),
      maxRank, rankCount: ranks.size,
      width: shapeWidth(b.poly),
      ...t,
    };
    b.yMin = t.yMin; b.yMax = t.yMax; b.slope = t.slope;
  }

  const set = (b, z) => { b.zone = z; b.zoneName = ZONE_NAME[z]; };

  /* Rings are quantiles of distance-to-core, not fixed radii. A fixed radius
   * put every block of a compact town in one ring and left a sprawling one with
   * a two-block downtown; ranking guarantees the same silhouette — a dense
   * core, a mixed ring, a residential body, a green fringe — at any size. */
  const buildable = blocks.filter((b) => b.metrics.wetFrac <= 0.32
    && b.metrics.steepFrac <= 0.42 && b.metrics.slope <= 0.32
    && b.metrics.width >= 26 && b.area >= 900);
  const order = buildable.slice().sort((p, q) => p.metrics.dCore - q.metrics.dCore);
  const rankOf = new Map();
  order.forEach((b, i) => rankOf.set(b.id, order.length > 1 ? i / (order.length - 1) : 0));

  for (const b of blocks) {
    const m = b.metrics;
    b.mixedZone = null;

    // 1 — land that should never be built on
    if (!rankOf.has(b.id)) { set(b, ZONE.PARK); continue; }
    const rank = rankOf.get(b.id);
    const arterial = m.maxRank >= 2;

    // 2 — riverside: a green edge, then low-rise behind it
    if (m.dWater < 54 && rank > 0.3) { set(b, rng.next() < 0.62 ? ZONE.PARK : ZONE.RES_LOW); continue; }

    // 3 — the core: offices on the best-connected frontages, retail beside them
    if (rank < 0.11) {
      set(b, (m.maxRank >= 3 || rng.next() < 0.5) ? ZONE.OFFICE : ZONE.COM_HIGH);
      continue;
    }
    // 4 — the downtown ring
    if (rank < 0.30) {
      if (arterial) set(b, rng.next() < 0.55 ? ZONE.COM_HIGH : ZONE.OFFICE);
      else { set(b, ZONE.RES_HIGH); b.mixedZone = ZONE.COM_HIGH; }
      continue;
    }
    // 5 — the mixed-use body: high-density housing with retail on the arterials
    if (rank < 0.62) {
      if (arterial && rng.next() < 0.34) set(b, ZONE.COM_LOW);
      else { set(b, rng.next() < 0.6 ? ZONE.RES_HIGH : ZONE.RES_LOW); if (arterial) b.mixedZone = ZONE.COM_LOW; }
      continue;
    }
    // 6 — the fringe
    const r = rng.next();
    if (r < 0.10) set(b, ZONE.PARK);
    else if (r < 0.30) { set(b, ZONE.RES_HIGH); if (arterial) b.mixedZone = ZONE.COM_LOW; }
    else { set(b, ZONE.RES_LOW); if (arterial && r > 0.82) b.mixedZone = ZONE.COM_LOW; }
  }

  /* 7 — industry.
   * A hard distance threshold on the highway produced zero industrial blocks on
   * a compact site and a whole quarter of it on a sprawling one. Scoring and
   * taking a fixed share instead means every city gets an industrial district,
   * and it always lands on the highway side, away from the river and the core. */
  {
    const pool = blocks
      .filter((b) => b.zone !== ZONE.PARK && b.zone !== ZONE.CIVIC
        && (rankOf.get(b.id) ?? 1) > 0.42 && b.metrics.dWater > 80
        && b.metrics.slope < 0.24 && b.area > 1600 && b.metrics.width > 56)
      .map((b) => ({
        b,
        s: -Math.min(b.metrics.dHighway, 900) / 220
           + b.metrics.dCore / coreR * 0.85
           + Math.min(b.metrics.dWater, 320) / 320 * 0.7
           + (b.metrics.maxRank >= 2 ? 0.35 : 0),
      }))
      .sort((p, q) => q.s - p.s);
    const want = Math.min(pool.length, Math.round(blocks.length * 0.16));
    // keep the district contiguous: seed on the best block, then grow by nearness
    if (want > 0) {
      const taken = [pool[0].b];
      set(pool[0].b, ZONE.IND);
      while (taken.length < want) {
        let bestI = -1, bestD = Infinity;
        for (let i = 0; i < pool.length; i++) {
          const cand = pool[i].b;
          if (cand.zone === ZONE.IND) continue;
          for (const t of taken) {
            const d = Math.hypot(t.centroid[0] - cand.centroid[0], t.centroid[1] - cand.centroid[1])
              - pool[i].s * 26;
            if (d < bestD) { bestD = d; bestI = i; }
          }
        }
        if (bestI < 0) break;
        set(pool[bestI].b, ZONE.IND);
        pool[bestI].b.mixedZone = null;
        taken.push(pool[bestI].b);
      }
    }
  }

  /* 8 — civic buildings claim prominent corners, spaced apart */
  const civicPool = blocks
    .filter((b) => b.zone !== ZONE.PARK && b.zone !== ZONE.IND
      && b.area > 1400 && b.area < 14000
      && b.metrics.maxRank >= 2 && b.metrics.rankCount >= 2
      && (rankOf.get(b.id) ?? 1) > 0.12 && (rankOf.get(b.id) ?? 1) < 0.75)
    .map((b) => ({
      b,
      s: b.metrics.maxRank * 2.2 + b.metrics.rankCount * 1.1
         - Math.abs((rankOf.get(b.id) ?? 1) - 0.3) * 3.4
         - b.metrics.slope * 4 + rng.next() * 0.7,
    }))
    .sort((p, q) => q.s - p.s);

  const chosen = [];
  const target = Math.max(1, Math.min(4, Math.round(blocks.length / 22)));
  for (const { b } of civicPool) {
    if (chosen.length >= target) break;
    if (chosen.some((o) => Math.hypot(o.centroid[0] - b.centroid[0], o.centroid[1] - b.centroid[1]) < 190)) continue;
    set(b, ZONE.CIVIC);
    b.mixedZone = null;
    chosen.push(b);
  }

  /* 9 — the high street.
   * Retail scattered a parcel at a time is a land-use tell and it is also
   * unphotographable: `demo` measured three street lenses against it and got
   * shopfronts at 4% of frame (R-demo-13). Real retail is linear. This pass
   * picks one lane2/lane4 street just off the core and turns a contiguous
   * whole-segment window of it commercial on BOTH sides, plus a few shorter
   * neighbourhood parades further out. It runs last so it can override the
   * ring rules, which is the point: a high street cuts across them. */
  const corridors = pickCorridors(chains, blocks, {
    rng, core, coreR, rankOf, terrain, waterLevel, roads: env.roads, log,
    targetLength: env.highStreetLength ?? 265,
  });
  for (const b of blocks) {
    b.frontageZones = null;
    let hits = 0;
    for (const tag of b.tags) {
      const z = corridors.segments.get(tag.segmentId);
      if (z === undefined) continue;
      if (!b.frontageZones) b.frontageZones = new Map();
      b.frontageZones.set(tag.segmentId, z);
      hits++;
    }
    if (!hits) continue;
    // A block that is mostly high-street frontage becomes commercial outright;
    // one that only touches it keeps its base and takes retail on that edge.
    if (b.zone === ZONE.PARK || b.zone === ZONE.CIVIC) { b.frontageZones = null; continue; }
    if (b.zone === ZONE.IND) { b.frontageZones = null; continue; }
    if (hits >= Math.max(2, b.tags.length * 0.34) && b.zone !== ZONE.OFFICE && b.zone !== ZONE.COM_HIGH) {
      set(b, ZONE.COM_LOW);
    }
  }

  const counts = {};
  for (const b of blocks) counts[b.zoneName] = (counts[b.zoneName] || 0) + 1;
  log?.info?.(
    `autoZone: core at (${core.x.toFixed(0)}, ${core.z.toFixed(0)}) r=${coreR.toFixed(0)} m — ` +
    Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')
  );
  return { core, coreR, counts, chains, corridors };
}

/** Per-lot refinement: arterial frontages in a mixed block go commercial. */
export function applyMixedUse(blocks, lots) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  let n = 0;
  for (const lot of lots) {
    const b = byId.get(lot.blockId);
    if (!b || !b.mixedZone) continue;
    if ((CLASS_RANK[lot.frontage.class] ?? 1) < 2) continue;
    lot.zone = b.mixedZone;
    lot.zoneName = ZONE_NAME[b.mixedZone];
    n++;
  }
  return n;
}

/**
 * Per-lot corridor override — this is what actually makes the shopfronts
 * contiguous. Every lot whose frontage sits on a corridor segment goes retail
 * regardless of what ring its block is in, so the run does not break where the
 * block behind it happens to be residential.
 */
export function applyFrontageZones(blocks, lots) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  let n = 0;
  for (const lot of lots) {
    const b = byId.get(lot.blockId);
    if (!b || !b.frontageZones) continue;
    const z = b.frontageZones.get(lot.frontage.segmentId);
    if (z === undefined || z === lot.zone) continue;
    if (lot.water || lot.slope > 0.3) continue;
    lot.zone = z;
    lot.zoneName = ZONE_NAME[z];
    lot.highStreet = true;
    n++;
  }
  return n;
}

export default autoZone;
