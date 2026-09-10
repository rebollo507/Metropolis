import { ROAD_CLASS } from '../core/World.js';
import { Noise } from '../core/Rng.js';

/**
 * Lot fitting.
 *
 * Blocks are not derived by half-edge face traversal — a Bezier road graph with
 * dangling organic branches makes that fragile. Instead every street edge is
 * marched: each road segment is flattened to a polyline, offset to the back of
 * the pavement, and lots are laid along it at their own frontage widths with
 * their own setbacks. A building therefore always faces a real street and is
 * always square to it, which is what actually reads as a city.
 *
 * Two coarse rasters keep it honest and fast: one marks the road corridor
 * (nothing may be built in it), one accumulates the footprints already placed
 * (nothing may overlap them).
 */

const SAMPLES = 14;   // polyline samples per road segment

/* --------------------------------------------------------------- raster --- */

export class Mask {
  constructor(minX, minZ, maxX, maxZ, cell = 3) {
    this.cell = cell;
    this.minX = minX - cell * 4;
    this.minZ = minZ - cell * 4;
    this.w = Math.max(1, Math.ceil((maxX - minX) / cell) + 8);
    this.h = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 8);
    this.data = new Uint8Array(this.w * this.h);
  }
  idx(x, z) {
    const i = Math.floor((x - this.minX) / this.cell);
    const j = Math.floor((z - this.minZ) / this.cell);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    return j * this.w + i;
  }
  at(x, z) { const k = this.idx(x, z); return k < 0 ? 1 : this.data[k]; }
  disc(x, z, r, v = 1) {
    const c = this.cell;
    const i0 = Math.floor((x - r - this.minX) / c), i1 = Math.ceil((x + r - this.minX) / c);
    const j0 = Math.floor((z - r - this.minZ) / c), j1 = Math.ceil((z + r - this.minZ) / c);
    const r2 = r * r;
    for (let j = Math.max(0, j0); j <= Math.min(this.h - 1, j1); j++) {
      const cz = this.minZ + (j + 0.5) * c;
      for (let i = Math.max(0, i0); i <= Math.min(this.w - 1, i1); i++) {
        const cx = this.minX + (i + 0.5) * c;
        const dx = cx - x, dz = cz - z;
        if (dx * dx + dz * dz <= r2) this.data[j * this.w + i] = v;
      }
    }
  }
  capsule(x0, z0, x1, z1, r, v = 1) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const n = Math.max(1, Math.ceil(len / (this.cell * 0.7)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      this.disc(x0 + dx * t, z0 + dz * t, r, v);
    }
  }
  /** Oriented rectangle: centre, unit forward (ux,uz), half extents. */
  rect(cx, cz, ux, uz, hu, hv, v = 1) {
    const vx = -uz, vz = ux;
    const step = this.cell * 0.6;
    const nu = Math.max(1, Math.ceil((hu * 2) / step));
    const nv = Math.max(1, Math.ceil((hv * 2) / step));
    for (let a = 0; a <= nu; a++) {
      const su = -hu + (a / nu) * hu * 2;
      for (let b = 0; b <= nv; b++) {
        const sv = -hv + (b / nv) * hv * 2;
        const k = this.idx(cx + ux * su + vx * sv, cz + uz * su + vz * sv);
        if (k >= 0) this.data[k] = v;
      }
    }
  }
  rectHits(cx, cz, ux, uz, hu, hv) {
    const vx = -uz, vz = ux;
    const step = this.cell * 0.6;
    const nu = Math.max(1, Math.ceil((hu * 2) / step));
    const nv = Math.max(1, Math.ceil((hv * 2) / step));
    for (let a = 0; a <= nu; a++) {
      const su = -hu + (a / nu) * hu * 2;
      for (let b = 0; b <= nv; b++) {
        const sv = -hv + (b / nv) * hv * 2;
        if (this.at(cx + ux * su + vx * sv, cz + uz * su + vz * sv)) return true;
      }
    }
    return false;
  }
}

/* ------------------------------------------------------------ frontages --- */

/** Flatten every road segment into a polyline with its kerb offset. */
export function frontages(roadsApi, world) {
  const out = [];
  const segs = world?.roads?.segments;
  if (!segs || !segs.size || !roadsApi || typeof roadsApi.pointAt !== 'function') return out;
  const layout = roadsApi.laneLayout || null;
  for (const s of segs.values()) {
    if (s.class === 'highway') continue;          // no frontage onto a motorway
    const cls = ROAD_CLASS[s.class] || ROAD_CLASS.lane2;
    const lay = layout ? layout(s.class) : null;
    const half = (lay ? lay.half : cls.width / 2);
    const walk = cls.sidewalk || 1.6;
    const n = Math.max(2, Math.min(SAMPLES, Math.ceil(s.length / 12) + 1));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const p = roadsApi.pointAt(s.id, i / n);
      pts.push({ x: p.x, y: p.y, z: p.z });
    }
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    out.push({ id: s.id, cls: s.class, pts, half, walk, len, weight: cls.speed });
  }
  return out;
}

/** Straight-street fallback when the roads module is unavailable. */
export function fallbackFrontages(cx, cz, cols = 6, rows = 6, bw = 96, bh = 76) {
  const out = [];
  const xs = [], zs = [];
  for (let i = 0; i < cols; i++) xs.push(cx + (i - (cols - 1) / 2) * bw);
  for (let j = 0; j < rows; j++) zs.push(cz + (j - (rows - 1) / 2) * bh);
  let id = 1;
  for (const z of zs) out.push({ id: id++, cls: 'lane2', pts: [{ x: xs[0], y: 0, z }, { x: xs[cols - 1], y: 0, z }], half: 4.5, walk: 2.2, len: xs[cols - 1] - xs[0] });
  for (const x of xs) out.push({ id: id++, cls: 'lane2', pts: [{ x, y: 0, z: zs[0] }, { x, y: 0, z: zs[rows - 1] }], half: 4.5, walk: 2.2, len: zs[rows - 1] - zs[0] });
  return out;
}

/* --------------------------------------------------------- polyline maths -- */

function polyAt(pts, s) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dz = pts[i].z - pts[i - 1].z;
    const l = Math.hypot(dx, dz) || 1e-6;
    if (acc + l >= s) {
      const t = (s - acc) / l;
      return {
        x: pts[i - 1].x + dx * t, z: pts[i - 1].z + dz * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
        ux: dx / l, uz: dz / l,
      };
    }
    acc += l;
  }
  const a = pts[pts.length - 2] || pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
  return { x: b.x, z: b.z, y: b.y, ux: dx / l, uz: dz / l };
}

/* ------------------------------------------------------------ typologies -- */

const SIZE = {
  house: { w: [9.5, 15], d: [8.5, 12.5], setback: [4.5, 8.5], gap: [2.4, 5.4] },
  rowhouse: { w: [6.0, 9.5], d: [11, 17], setback: [1.2, 3.2], gap: [0, 0.3] },
  midrise: { w: [15, 30], d: [15, 24], setback: [0.4, 1.6], gap: [0.4, 1.6] },
  tower: { w: [26, 44], d: [24, 40], setback: [1.5, 5.0], gap: [3, 8] },
  // A landmark is not a tall tower, it is a *big* one. Slenderness is a ratio,
  // so the only way to a 190 m building is a plot that can carry it (R-demo-2).
  landmark: { w: [38, 56], d: [30, 44], setback: [1.0, 4.5], gap: [3, 8] },
  warehouse: { w: [26, 52], d: [24, 42], setback: [7, 14], gap: [6, 12] },
  civic: { w: [26, 44], d: [20, 32], setback: [6, 12], gap: [6, 12] },
  retail: { w: [12, 22], d: [12, 20], setback: [1.0, 4.0], gap: [1.0, 3.0] },
};

/**
 * How shallow a plot of each kind may be squeezed before it stops working.
 * The landmark floors are deliberately generous: slenderness is a ratio, so a
 * landmark that has been squeezed in plan can no longer carry its own height,
 * which is what R-env-2 measured as the real cap on the skyline.
 */
const MIN_D = {
  house: 8, rowhouse: 9, midrise: 11.5, tower: 17, landmark: 26,
  warehouse: 15, civic: 14, retail: 9,
};
const MIN_W = {
  house: 8, rowhouse: 5.5, midrise: 10, tower: 18, landmark: 30,
  warehouse: 14, civic: 16, retail: 8,
};

/** Kinds that are built shoulder-to-shoulder once a district is dense enough. */
// Deliberately NOT midrise: a blank 40 m flank is a bigger visual cost than
// the small gain of a shared wall, and downtown mid-rises are seen end-on.
const PARTY = new Set(['rowhouse', 'retail']);

function pickKind(urban, cls, rng, industrial) {
  if (industrial > 0.55) return rng.weighted([['warehouse', 6], ['retail', 1.2], ['midrise', 0.6]]);
  const big = cls === 'boulevard' || cls === 'lane4';
  if (urban > 0.80) {
    return rng.weighted([['tower', big ? 6 : 2.2], ['midrise', 5], ['civic', 0.5]]);
  }
  if (urban > 0.58) {
    return rng.weighted([['tower', big ? 2.2 : 0.7], ['midrise', 7], ['rowhouse', 1.6], ['retail', 1.0], ['civic', 0.35]]);
  }
  if (urban > 0.36) {
    return rng.weighted([['midrise', 4], ['rowhouse', 5], ['retail', 2.2], ['house', 1.6], ['civic', 0.3]]);
  }
  if (urban > 0.18) {
    return rng.weighted([['rowhouse', 3.4], ['house', 6], ['retail', 1.4], ['midrise', 1.0]]);
  }
  return rng.weighted([['house', 10], ['rowhouse', 1.2], ['retail', 0.4]]);
}

/* ------------------------------------------------------------- the plan --- */

/**
 * @returns array of lots: {x, z, rot, w, d, kind, urban, segId, side, t, baseY, minY}
 */
export function planLots(fronts, opts) {
  const {
    rng, terrain = null, world = null,
    centre = [0, 0], radius = 340,
    maxSlope = 0.30, waterLevel = 0,
    seed = 1337, limit = 700,
    industrialAt = null, urbanBias = 0,
    // R-demo-2 / R-demo-3: the zone decides *what* before the plot is sized,
    // and it may veto the plot outright by returning 'none'.
    kindAt = null,
    landmarks = 5,
  } = opts;

  if (!fronts.length) return [];

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const f of fronts) for (const p of f.pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  const pad = 90;
  // 1.6 m cells, not 2.5: a cell is set when its *centre* falls inside the
  // corridor, so a coarse raster silently inflates the corridor by up to
  // cell*sqrt(2)/2. At 2.5 m that is 1.8 m of phantom road, which is more than
  // an urban setback — and it rejected essentially every downtown lot.
  const road = new Mask(minX - pad, minZ - pad, maxX + pad, maxZ + pad, 1.6);
  const built = new Mask(minX - pad, minZ - pad, maxX + pad, maxZ + pad, 1.6);

  for (const f of fronts) {
    const r = f.half + f.walk + 0.55;
    for (let i = 1; i < f.pts.length; i++) {
      road.capsule(f.pts[i - 1].x, f.pts[i - 1].z, f.pts[i].x, f.pts[i].z, r);
    }
    // widen at the ends so nothing sits inside a junction
    road.disc(f.pts[0].x, f.pts[0].z, r + 3.0);
    road.disc(f.pts[f.pts.length - 1].x, f.pts[f.pts.length - 1].z, r + 3.0);
  }

  const noise = new Noise(seed ^ 0x51ed);
  const hAt = terrain && terrain.heightAt ? (x, z) => terrain.heightAt(x, z)
    : (world ? (x, z) => world.heightAt(x, z) : () => 0);
  const slopeAt = terrain && terrain.slopeAt ? (x, z) => terrain.slopeAt(x, z) : null;
  const isWater = terrain && terrain.isWater ? (x, z) => terrain.isWater(x, z)
    : (x, z) => hAt(x, z) < waterLevel + 0.4;

  const coreAt = (x, z) => {
    const dx = x - centre[0], dz = z - centre[1];
    return Math.max(0, 1 - Math.hypot(dx, dz) / radius);
  };
  const urbanAt = (x, z) => {
    const core = coreAt(x, z);
    const n = noise.fbm(x * 0.0022, z * 0.0022, 3) * 0.5 + 0.5;
    return Math.max(0, Math.min(1, core * 0.82 + n * 0.34 - 0.10 + urbanBias));
  };
  const indAt = industrialAt || ((x, z) => {
    const n = noise.fbm(x * 0.0016 + 91.3, z * 0.0016 - 40.7, 2) * 0.5 + 0.5;
    const dx = x - centre[0], dz = z - centre[1];
    const far = Math.min(1, Math.hypot(dx, dz) / (radius * 1.6));
    return n * far * 1.5;
  });

  const lots = [];
  const order = fronts.slice().sort((a, b) => b.len - a.len);
  let landmarksLeft = landmarks;
  // reported through `buildings.stats().plan` — a lot plan is invisible
  // otherwise, and the last round's flat skyline took a histogram to find
  const tally = { veto: 0, probes: 0, rejected: 0, zoned: 0, kinds: {}, want: {}, why: { road: 0, built: 0, water: 0, slope: 0 }, failBy: {} };

  for (const f of order) {
    if (lots.length >= limit) break;
    for (const side of [-1, 1]) {
      let s = 6;
      let guard = 0;
      while (s < f.len - 7 && guard++ < 400 && lots.length < limit) {
        const probe = polyAt(f.pts, s);
        const nx = -probe.uz * side, nz = probe.ux * side;
        const urban = urbanAt(probe.x, probe.z);
        const ind = indAt(probe.x, probe.z);

        // ---- WHAT, before HOW BIG. -------------------------------------
        // `zoningOverride` used to rename the kind *after* the plot had been
        // sized from `pickKind`'s choice, so an OFFICE lot kept a house's
        // 14x11 m footprint and the slenderness cap held it to ~13 storeys.
        // That single ordering bug is why the demo skyline was flat.
        let kind = null;
        if (kindAt) {
          // Sample *inside the block*, not on the polyline: the polyline is the
          // road centreline and every point on it is zoned ROAD.
          const probeOff = f.half + f.walk + 9;
          const k = kindAt(probe.x + nx * probeOff, probe.z + nz * probeOff);
          tally.probes++;
          if (k === 'none') { tally.veto++; s += 6; continue; }   // park / water
          if (k) { kind = k; tally.zoned++; }
        }
        if (!kind) kind = pickKind(urban, f.cls, rng, ind);

        // A handful of genuine landmarks carry the skyline; the rest of the
        // core is their shoulder. Promotion happens here so the plot is sized
        // for what it has to hold.
        let tier = null;
        const core = coreAt(probe.x, probe.z);
        if (kind === 'tower' && landmarksLeft > 0 && core > 0.40
            && (f.cls === 'boulevard' || f.cls === 'lane4' || rng.next() < 0.55)
            && rng.next() < 0.42 + core * 0.34) {
          kind = 'landmark';
          tier = 'landmark';
        }

        tally.want[kind] = (tally.want[kind] || 0) + 1;
        const dense = Math.max(0, Math.min(1, (urban - 0.40) / 0.42));
        const sz = SIZE[kind];
        let w = rng.range(sz.w[0], sz.w[1]);
        const d = rng.range(sz.d[0], sz.d[1]);
        let setback = rng.range(sz.setback[0], sz.setback[1]);
        let gap = rng.range(sz.gap[0], sz.gap[1]);
        // A CBD is nearly wall-to-wall; a suburb is not. Squeeze the setback
        // and the side gap as the district gets denser, so downtown blocks
        // stop reading as towers standing about on a lawn.
        if (kind !== 'house' && kind !== 'warehouse') {
          // 2.6 m is the floor, not a style choice: the road corridor raster
          // blocks out to ~1.7 m past the pavement and the overlap test adds
          // another 0.5 m, so a building line any tighter than this is rejected
          // outright — which is how the last round got an under-filled downtown.
          setback = Math.max(2.6, setback * (1 - dense * 0.62));
          gap *= 1 - dense * 0.86;
        }
        if (kind === 'tower') w = Math.min(w, 40) * (0.78 + urban * 0.34);
        const wMin = MIN_W[kind] ?? 8;
        // Do not abandon the rest of the frontage because the roll came up wide:
        // clamp to what is left. This is most of the end-of-block infill.
        if (s + wMin > f.len - 5) break;
        w = Math.min(w, f.len - 5 - s);

        // ---- fit the plot to the block, do not just reject it -----------
        // A deep plot on a grid with back alleys will not fit at its first-choice
        // depth; rejecting it outright is what left downtown a quarter full.
        // Try progressively shallower (and slightly narrower) until it fits.
        const dMin = MIN_D[kind] ?? 9;
        let ok = false, cx = 0, cz = 0, hi = 0, lo = 0;
        let dUse = d, wUse = w, mid = null, mnx = 0, mnz = 0;
        for (let a = 0; a < 5 && !ok; a++) {
          dUse = Math.max(dMin, d * (1 - a * 0.17));
          wUse = w * (1 - a * 0.17);
          if (wUse < wMin) break;
          if (a > 0 && dUse === dMin && wUse < wMin * 1.02) break;
          mid = polyAt(f.pts, s + wUse / 2);
          mnx = -mid.uz * side; mnz = mid.ux * side;
          const off = f.half + f.walk + setback + dUse / 2;
          cx = mid.x + mnx * off; cz = mid.z + mnz * off;

          // reject: inside a road corridor, overlapping an existing footprint,
          // in the water, or on ground too steep to sit a slab on
          const hu = wUse / 2 + 0.5, hv = dUse / 2 + 0.5;
          if (road.rectHits(cx, cz, mid.ux, mid.uz, hu, hv)) { if (!a) { tally.why.road++; } continue; }
          if (built.rectHits(cx, cz, mid.ux, mid.uz, hu, hv)) { if (!a) tally.why.built++; continue; }
          const corners = [
            [cx + mid.ux * hu + mnx * hv, cz + mid.uz * hu + mnz * hv],
            [cx - mid.ux * hu + mnx * hv, cz - mid.uz * hu + mnz * hv],
            [cx + mid.ux * hu - mnx * hv, cz + mid.uz * hu - mnz * hv],
            [cx - mid.ux * hu - mnx * hv, cz - mid.uz * hu - mnz * hv],
            [cx, cz],
          ];
          lo = Infinity; hi = -Infinity;
          let good = true;
          for (const [px, pz] of corners) {
            if (isWater(px, pz)) { good = false; if (!a) tally.why.water++; break; }
            const h = hAt(px, pz);
            if (!Number.isFinite(h)) { good = false; break; }
            if (h < lo) lo = h;
            if (h > hi) hi = h;
          }
          if (!good) continue;
          const slope = slopeAt ? slopeAt(cx, cz) : (hi - lo) / Math.max(1, dUse);
          if (slope > maxSlope || hi - lo > 5.5) { if (!a) tally.why.slope++; continue; }
          ok = true;
        }

        if (ok) {
          if (tier === 'landmark') landmarksLeft--;
          const key = tier === 'landmark' ? 'landmark' : kind;
          tally.kinds[key] = (tally.kinds[key] || 0) + 1;
          lots.push({
            x: cx, z: cz,
            // local −Z must point back at the street: rotY(θ)·(0,0,−1) = −n
            rot: Math.atan2(mnx, mnz),
            w: wUse, d: dUse,
            kind: kind === 'landmark' ? 'tower' : kind, tier, urban, dense,
            // a shared side wall once the block is dense enough to warrant
            // one — and it saves the openings on two elevations nobody sees
            party: dense > 0.55 && gap < 1.2 && PARTY.has(kind),
            // how much of the frontage width the building itself takes:
            // downtown it is nearly all of it
            trim: dense > 0.55 ? 0.25 : 1.0,
            segId: f.id, side, t: (s + wUse / 2) / f.len,
            // distance from the building line back to the kerb — the
            // forecourt that has to be paved, not left as lawn
            pave: setback + f.walk + 1.0,
            baseY: hi, minY: lo,
            cls: f.cls,
          });
          built.rect(cx, cz, mid.ux, mid.uz,
            wUse / 2 + gap * 0.5 + (dense > 0.55 ? 0.12 : 0.4), dUse / 2 + 0.6);
        }
        if (!ok) { tally.rejected++; tally.failBy[kind] = (tally.failBy[kind]||0)+1; }
        s += ok ? wUse + gap : (dense > 0.55 ? 3 : 5);
        void nx; void nz;
      }
    }
  }
  lots.tally = tally;
  return lots;
}

export default { planLots, frontages, fallbackFrontages, Mask };
