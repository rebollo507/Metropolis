/**
 * Placement substrate: the occupancy masks and the road-graph walk that every
 * scatter pass in Populate.js consults.
 *
 * Nothing is placed by rejection sampling over the map. Street furniture is
 * marched along the kerb line of the road graph at real spacings; lot dressing
 * is placed in the frame of the building it belongs to; park planting comes off
 * the zoning grid. The masks then reject anything that would end up inside a
 * building, in the carriageway, in water, on a slope, or on top of another prop.
 */

export const F = {
  ROAD: 1,        // carriageway — nothing but parked cars and decals
  BUILDING: 2,    // building footprint + a small skirt
  BAD: 4,         // water, steep ground, out of bounds
  TAKEN: 8,       // another prop already claimed this
  WALK: 16,       // pavement — furniture allowed, vehicles not
  JUNCTION: 32,   // near a node — keep sight lines clear
};

export class Mask {
  constructor(x0, z0, x1, z1, cell = 1.5) {
    this.x0 = x0; this.z0 = z0;
    this.cell = cell;
    this.w = Math.max(1, Math.ceil((x1 - x0) / cell) + 2);
    this.h = Math.max(1, Math.ceil((z1 - z0) / cell) + 2);
    this.d = new Uint8Array(this.w * this.h);
  }

  _i(x, z) {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    return j * this.w + i;
  }

  get(x, z) { const i = this._i(x, z); return i < 0 ? F.BAD : this.d[i]; }

  /** true when every flag in `flags` is clear inside radius r. */
  free(x, z, r, flags) {
    const c = this.cell;
    const i0 = Math.floor((x - r - this.x0) / c), i1 = Math.floor((x + r - this.x0) / c);
    const j0 = Math.floor((z - r - this.z0) / c), j1 = Math.floor((z + r - this.z0) / c);
    for (let j = j0; j <= j1; j++) {
      if (j < 0 || j >= this.h) return false;
      for (let i = i0; i <= i1; i++) {
        if (i < 0 || i >= this.w) return false;
        if (this.d[j * this.w + i] & flags) return false;
      }
    }
    return true;
  }

  disc(x, z, r, flag) {
    const c = this.cell;
    const i0 = Math.floor((x - r - this.x0) / c), i1 = Math.floor((x + r - this.x0) / c);
    const j0 = Math.floor((z - r - this.z0) / c), j1 = Math.floor((z + r - this.z0) / c);
    const r2 = r * r;
    for (let j = Math.max(0, j0); j <= Math.min(this.h - 1, j1); j++) {
      const cz = this.z0 + (j + 0.5) * c;
      for (let i = Math.max(0, i0); i <= Math.min(this.w - 1, i1); i++) {
        const cx = this.x0 + (i + 0.5) * c;
        const dx = cx - x, dz = cz - z;
        if (dx * dx + dz * dz <= r2) this.d[j * this.w + i] |= flag;
      }
    }
  }

  capsule(ax, az, bx, bz, r, flag) {
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    const n = Math.max(1, Math.ceil(L / (this.cell * 0.7)));
    for (let i = 0; i <= n; i++) this.disc(ax + dx * (i / n), az + dz * (i / n), r, flag);
  }

  /** Oriented rectangle (building footprints, lot slabs). */
  rect(cx, cz, w, d, rot, flag) {
    const s = Math.sin(rot), c = Math.cos(rot);
    const hw = w / 2, hd = d / 2;
    const step = this.cell * 0.7;
    const nu = Math.max(1, Math.ceil(w / step)), nv = Math.max(1, Math.ceil(d / step));
    for (let j = 0; j <= nv; j++) {
      const v = -hd + (j / nv) * d;
      for (let i = 0; i <= nu; i++) {
        const u = -hw + (i / nu) * w;
        this.disc(cx + u * c - v * s, cz + u * s + v * c, this.cell * 0.6, flag);
      }
    }
  }
}

/* ------------------------------------------------------------- geometry -- */

/**
 * Walk every non-highway segment and emit frames at a fixed arc-length step.
 * A frame is a point on the centreline with its tangent, left normal, road
 * half-width, pavement width and distance to the nearer junction.
 */
export function roadFrames(roads, world, step = 2.0) {
  const out = [];
  const segs = world?.roads?.segments;
  if (!segs || !segs.size || !roads || typeof roads.pointAt !== 'function') return out;
  const layout = roads.laneLayout || (roads.network && roads.network().laneLayout) || null;
  const nodes = world.roads.nodes;

  for (const s of segs.values()) {
    if (s.class === 'highway') continue;
    const lay = layout ? layout(s.class) : null;
    const half = lay ? lay.half : 4.5;
    const walk = lay && lay.sidewalk > 0 ? lay.sidewalk : 2.0;
    const L = s.length || 0;
    if (L < 6) continue;
    const n = Math.max(2, Math.round(L / step));
    const a = nodes.get(s.a), b = nodes.get(s.b);
    const degA = a ? (a.degree || 1) : 1;
    const degB = b ? (b.degree || 1) : 1;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = roads.pointAt(s.id, t);
      const tg = roads.tangentAt(s.id, t);
      pts.push({
        segId: s.id, cls: s.class, t, half, walk,
        x: p.x, y: p.y, z: p.z,
        ux: tg.x, uz: tg.z,
        nx: -tg.z, nz: tg.x,
        s: t * L, len: L,
        dJunc: Math.min(t * L + (degA > 2 ? 0 : 1e4), (1 - t) * L + (degB > 2 ? 0 : 1e4)),
        dEnd: Math.min(t * L, (1 - t) * L),
      });
    }
    out.push({ seg: s, cls: s.class, half, walk, length: L, pts, degA, degB, a, b });
  }
  return out;
}

/** Junction records: node, its arms sorted by bearing, and the widest class. */
export function junctions(roads, world) {
  const out = [];
  const nodes = world?.roads?.nodes;
  const segs = world?.roads?.segments;
  if (!nodes || !segs || typeof roads?.pointAt !== 'function') return out;
  const RANK = { alley: 0, lane2: 1, lane4: 2, boulevard: 3, highway: 4 };
  for (const nd of nodes.values()) {
    const edges = (nd.edges || []).map((id) => segs.get(id)).filter(Boolean);
    if (edges.length < 3) continue;
    if (edges.some((s) => s.class === 'highway')) continue;
    const arms = [];
    let rank = 0, half = 4.5;
    for (const s of edges) {
      const atA = s.a === nd.id;
      const t = atA ? 0.06 : 0.94;
      const p = roads.pointAt(s.id, t);
      const dx = p.x - nd.pos[0], dz = p.z - nd.pos[2];
      const l = Math.hypot(dx, dz) || 1;
      arms.push({ seg: s, ux: dx / l, uz: dz / l, bearing: Math.atan2(dx, dz), cls: s.class, atA });
      rank = Math.max(rank, RANK[s.class] ?? 1);
      half = Math.max(half, (s.class === 'lane4' ? 8 : s.class === 'boulevard' ? 12 : 4.5));
    }
    arms.sort((p, q) => p.bearing - q.bearing);
    out.push({
      node: nd, x: nd.pos[0], y: nd.pos[1], z: nd.pos[2],
      arms, rank, half, signalled: rank >= 2 && arms.length >= 3,
    });
  }
  return out;
}

/** Bounds of the road network, padded. */
export function networkBounds(world, pad = 120) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const s of world.roads.segments.values()) {
    for (const p of s.curve) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[2] < z0) z0 = p[2]; if (p[2] > z1) z1 = p[2];
    }
  }
  if (!Number.isFinite(x0)) { x0 = -200; z0 = -200; x1 = 200; z1 = 200; }
  return [x0 - pad, z0 - pad, x1 + pad, z1 + pad];
}

/** Build the occupancy masks for the whole populated area. */
export function buildMasks(ctx, frames, opts = {}) {
  const [x0, z0, x1, z1] = opts.bounds || networkBounds(ctx.world);
  const hard = new Mask(x0, z0, x1, z1, opts.cell ?? 1.4);
  const soft = new Mask(x0, z0, x1, z1, opts.softCell ?? 1.0);

  // carriageway + pavement
  for (const f of frames) {
    const p = f.pts;
    for (let i = 1; i < p.length; i++) {
      hard.capsule(p[i - 1].x, p[i - 1].z, p[i].x, p[i].z, f.half + 0.25, F.ROAD);
      hard.capsule(p[i - 1].x, p[i - 1].z, p[i].x, p[i].z, f.half + f.walk + 0.15, F.WALK);
    }
  }
  // junction clear zones
  for (const j of junctions(ctx.get('roads'), ctx.world)) {
    hard.disc(j.x, j.z, j.half + 5.0, F.JUNCTION);
  }

  // buildings
  for (const b of ctx.world.buildings.values()) {
    const p = b.pos || [0, 0, 0];
    const fp = b.footprint || [10, 10];
    hard.rect(p[0], p[2], fp[0] + 1.0, fp[1] + 1.0, b.rotation || 0, F.BUILDING);
  }

  // water + steep ground
  const t = ctx.get('terrain');
  if (t && (t.isWater || t.slopeAt)) {
    const step = 4;
    for (let z = z0; z <= z1; z += step) {
      for (let x = x0; x <= x1; x += step) {
        let bad = false;
        try {
          if (t.isWater && t.isWater(x, z)) bad = true;
          else if (t.slopeAt && t.slopeAt(x, z) > (opts.maxSlope ?? 0.42)) bad = true;
        } catch { bad = false; }
        if (bad) hard.disc(x, z, step * 0.8, F.BAD);
      }
    }
  }

  return { hard, soft, bounds: [x0, z0, x1, z1] };
}

/** Terrain sampler that degrades to the world heightfield and then to zero. */
export function heightSampler(ctx) {
  const t = ctx.get('terrain');
  if (t && typeof t.heightAt === 'function') {
    return (x, z) => { const h = t.heightAt(x, z); return Number.isFinite(h) ? h : 0; };
  }
  const w = ctx.world;
  if (w && w.terrain && w.terrain.heights && typeof w.heightAt === 'function') {
    return (x, z) => { const h = w.heightAt(x, z); return Number.isFinite(h) ? h : 0; };
  }
  return () => 0;
}

export default { Mask, F, roadFrames, junctions, buildMasks, networkBounds, heightSampler };
