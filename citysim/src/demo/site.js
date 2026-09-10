/**
 * Site analysis — what the land is telling us to build.
 *
 * Everything the demo city's layout depends on is *measured* from the terrain
 * module at run time rather than hard-coded for one seed: the flat basin, its
 * centroid, the shoreline nearest it, and the direction that shoreline runs.
 * Change the seed and the plan follows the new ground.
 *
 * One coarse lattice (default 16 m) over the buildable window is sampled once
 * and reused; every query below is a table lookup or a short walk over it.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Site {
  /**
   * @param {object} terrain  the `terrain` module API (heightAt/slopeAt/isWater/bounds)
   * @param {object} opts     { step, extent }
   */
  constructor(terrain, opts = {}) {
    this.t = terrain || null;
    this.step = opts.step ?? 16;
    const b = terrain && terrain.bounds ? terrain.bounds() : null;
    const half = b ? Math.min(900, b.size / 2 - 60) : 900;
    this.x0 = -half; this.z0 = -half;
    this.nx = Math.floor((half * 2) / this.step) + 1;
    this.nz = this.nx;
    this.water = b ? b.water : 0;

    const n = this.nx * this.nz;
    this.h = new Float32Array(n);
    this.slope = new Float32Array(n);
    this.wet = new Uint8Array(n);
    this.flat = new Uint8Array(n);

    const hAt = terrain && terrain.heightAt ? (x, z) => terrain.heightAt(x, z) : () => 0;
    const sAt = terrain && terrain.slopeAt ? (x, z) => terrain.slopeAt(x, z, 8) : () => 0;

    for (let j = 0; j < this.nz; j++) {
      const z = this.z0 + j * this.step;
      for (let i = 0; i < this.nx; i++) {
        const x = this.x0 + i * this.step;
        const k = j * this.nx + i;
        const y = hAt(x, z);
        const s = sAt(x, z);
        this.h[k] = y;
        this.slope[k] = s;
        this.wet[k] = y <= this.water + 0.35 ? 1 : 0;
        // "flat" = ground a city can actually be laid on
        this.flat[k] = (!this.wet[k] && y > this.water + 1.2 && s < 0.115) ? 1 : 0;
      }
    }

    this.basin = this._largestFlatBlob();
    this.shore = this._traceShore(this.basin);
    this.axis = this._shoreAxis();
  }

  idx(x, z) {
    const i = Math.round((x - this.x0) / this.step);
    const j = Math.round((z - this.z0) / this.step);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return -1;
    return j * this.nx + i;
  }

  wx(i) { return this.x0 + i * this.step; }
  wz(j) { return this.z0 + j * this.step; }

  heightAt(x, z) { return this.t ? this.t.heightAt(x, z) : 0; }
  slopeAt(x, z) { return this.t ? this.t.slopeAt(x, z, 8) : 0; }
  isWater(x, z) { return this.t ? this.t.isWater(x, z) : false; }

  /** Cheap lattice lookups (no terrain call) — used inside hot search loops. */
  flatAt(x, z) { const k = this.idx(x, z); return k < 0 ? 0 : this.flat[k]; }

  /** Is (x,z) ground a road may be laid on? */
  buildable(x, z, maxSlope = 0.26) {
    if (!this.t) return true;
    const y = this.heightAt(x, z);
    if (y < this.water + 1.1) return false;
    return this.slopeAt(x, z) <= maxSlope;
  }

  /* ------------------------------------------------------------------ */

  /** Flood-fill the flat mask, keep the biggest component, return its stats. */
  _largestFlatBlob() {
    const { nx, nz, flat } = this;
    const lab = new Int32Array(nx * nz).fill(-1);
    const stack = new Int32Array(nx * nz);
    let best = { count: 0, cells: null, x: 0, z: 0 };
    let id = 0;
    for (let s = 0; s < flat.length; s++) {
      if (!flat[s] || lab[s] >= 0) continue;
      let sp = 0, count = 0, sx = 0, sz = 0;
      const cells = [];
      stack[sp++] = s; lab[s] = id;
      while (sp > 0) {
        const k = stack[--sp];
        const i = k % nx, j = (k / nx) | 0;
        count++; cells.push(k);
        sx += this.wx(i); sz += this.wz(j);
        if (i > 0 && flat[k - 1] && lab[k - 1] < 0) { lab[k - 1] = id; stack[sp++] = k - 1; }
        if (i < nx - 1 && flat[k + 1] && lab[k + 1] < 0) { lab[k + 1] = id; stack[sp++] = k + 1; }
        if (j > 0 && flat[k - nx] && lab[k - nx] < 0) { lab[k - nx] = id; stack[sp++] = k - nx; }
        if (j < nz - 1 && flat[k + nx] && lab[k + nx] < 0) { lab[k + nx] = id; stack[sp++] = k + nx; }
      }
      if (count > best.count) best = { count, cells, x: sx / count, z: sz / count };
      id++;
    }
    if (!best.cells) return { x: 0, z: 0, count: 0, cells: [], area: 0, bbox: { x0: -200, z0: -200, x1: 200, z1: 200 } };
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const k of best.cells) {
      const x = this.wx(k % nx), z = this.wz((k / nx) | 0);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    this.basinMask = new Uint8Array(nx * nz);
    for (const k of best.cells) this.basinMask[k] = 1;
    return {
      x: best.x, z: best.z, count: best.count,
      area: best.count * this.step * this.step,
      bbox: { x0, z0, x1, z1 },
      cells: best.cells,
    };
  }

  /** Is this cell dry land touching water? */
  _isEdge(k) {
    const { nx, nz, wet } = this;
    if (wet[k]) return false;
    const i = k % nx, j = (k / nx) | 0;
    if (i > 0 && wet[k - 1]) return true;
    if (i < nx - 1 && wet[k + 1]) return true;
    if (j > 0 && wet[k - nx]) return true;
    if (j < nz - 1 && wet[k + nx]) return true;
    return false;
  }

  /**
   * The stretch of shoreline that belongs to the basin: start from the water
   * edge nearest the basin centroid and walk greedily in both directions,
   * never straying more than `reach` from the basin.
   */
  _traceShore(basin, reach = 420) {
    const { nx, nz } = this;
    const edges = [];
    for (let k = 0; k < nx * nz; k++) if (this._isEdge(k)) edges.push(k);
    if (!edges.length) return [];

    const px = (k) => this.wx(k % nx);
    const pz = (k) => this.wz((k / nx) | 0);
    const near = edges.filter((k) => Math.hypot(px(k) - basin.x, pz(k) - basin.z) < reach);
    const pool = near.length > 6 ? near : edges;

    let seed = pool[0], bd = Infinity;
    for (const k of pool) {
      const d = Math.hypot(px(k) - basin.x, pz(k) - basin.z);
      if (d < bd) { bd = d; seed = k; }
    }

    const used = new Set([seed]);
    const walk = (dirSeed) => {
      const chain = [];
      let cur = dirSeed;
      for (let n = 0; n < 400; n++) {
        let next = -1, best = Infinity;
        for (const k of pool) {
          if (used.has(k)) continue;
          const d = Math.hypot(px(k) - px(cur), pz(k) - pz(cur));
          if (d < best && d <= this.step * 2.2) { best = d; next = k; }
        }
        if (next < 0) break;
        used.add(next); chain.push(next); cur = next;
      }
      return chain;
    };
    const a = walk(seed);
    const b = walk(seed);
    const order = [...a.reverse(), seed, ...b];
    const pts = order.map((k) => [px(k), pz(k)]);
    return simplify(smoothPoly(pts, 3), 12);
  }

  /** Unit direction the shoreline runs, near the basin centroid. */
  _shoreAxis() {
    const s = this.shore;
    if (!s || s.length < 4) return { ux: 1, uz: 0, theta: 0, inward: [0, 1] };
    // fit a direction over the 240 m of shore nearest the basin
    const c = this.basin;
    let best = 0, bd = Infinity;
    for (let i = 0; i < s.length; i++) {
      const d = Math.hypot(s[i][0] - c.x, s[i][1] - c.z);
      if (d < bd) { bd = d; best = i; }
    }
    const a = s[Math.max(0, best - 5)], b = s[Math.min(s.length - 1, best + 5)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    // inward normal: the one that points at the basin centroid
    let nx2 = -dz, nz2 = dx;
    const px = s[best][0], pz = s[best][1];
    if ((c.x - px) * nx2 + (c.z - pz) * nz2 < 0) { nx2 = -nx2; nz2 = -nz2; }
    return { ux: dx, uz: dz, theta: Math.atan2(dz, dx), inward: [nx2, nz2], point: s[best] };
  }

  /** Outward (water-facing) unit normal of the traced shore at index i. */
  shoreNormal(i) {
    const s = this.shore;
    const a = s[Math.max(0, i - 2)], b = s[Math.min(s.length - 1, i + 2)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    let nx = -dz, nz = dx;
    // the outward normal is the one that gets wetter
    const p = s[i];
    const wet = (sx, sz) => (this.isWater(p[0] + sx * 40, p[1] + sz * 40) ? 1 : 0)
      + (this.isWater(p[0] + sx * 90, p[1] + sz * 90) ? 1 : 0);
    if (wet(nx, nz) < wet(-nx, -nz)) { nx = -nx; nz = -nz; }
    return [nx, nz];
  }

  /**
   * Where should downtown stand?
   *
   * A skyline needs *open water in front of it*: enough fetch that a camera can
   * stand off and see the whole city rise from the far bank. And it needs flat,
   * dry hinterland behind it. Score every point of the traced shoreline on both
   * and take the best — that is the difference between a city on a river bend
   * and a city on a bay.
   *
   * @returns {{point:[x,z], outward:[nx,nz], inward:[nx,nz], fetch, land, i}}
   */
  bestVista(inset = 190) {
    const s = this.shore;
    if (!s || s.length < 4) {
      return { point: [this.basin.x, this.basin.z], outward: [0, -1], inward: [0, 1], fetch: 0, land: 1, i: 0 };
    }
    let best = null;
    for (let i = 1; i < s.length - 1; i++) {
      const p = s[i];
      const out = this.shoreNormal(i);
      // how far can we see over water from here?
      let fetch = 0;
      for (let d = 20; d <= 720; d += 20) {
        if (!this.isWater(p[0] + out[0] * d, p[1] + out[1] * d)) break;
        fetch = d;
      }
      // how much buildable land is behind it?
      const c = [p[0] - out[0] * inset, p[1] - out[1] * inset];
      let land = 0, n = 0;
      for (let a = 0; a < 12; a++) {
        const t = (a / 12) * Math.PI * 2;
        for (const r of [70, 150, 240]) {
          land += this.flatAt(c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r);
          n++;
        }
      }
      land = land / n;
      if (land < 0.33) continue;
      // Fetch is weighted hard on purpose: a downtown with 140 m of water in
      // front of it can never be photographed as a skyline, because there is
      // nowhere to stand. Buildable hinterland is necessary but a shoreline
      // with a real reach in front of it is what decides the site.
      const score = Math.min(fetch, 520) / 520 * 1.9 + land * 1.0;
      if (!best || score > best.score) {
        best = { score, point: p, outward: out, inward: [-out[0], -out[1]], fetch, land, i };
      }
    }
    if (!best) {
      const ns = this.nearestShore(this.basin.x, this.basin.z);
      const out = this.shoreNormal(ns.i);
      return { point: [ns.x, ns.z], outward: out, inward: [-out[0], -out[1]], fetch: 0, land: 0.5, i: ns.i };
    }
    return best;
  }

  /**
   * Nearest point on the traced shoreline to (x,z).
   * @returns {{x,z,i,d}}
   */
  nearestShore(x, z) {
    const s = this.shore;
    if (!s || !s.length) return null;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < s.length; i++) {
      const d = (s[i][0] - x) ** 2 + (s[i][1] - z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return { x: s[bi][0], z: s[bi][1], i: bi, d: Math.sqrt(bd) };
  }

  /**
   * Push a point to buildable ground by searching along `dir` (and its
   * opposite) up to `reach` metres. Returns null if nothing is found.
   */
  nudge(p, dir, reach = 150, maxSlope = 0.26) {
    if (this.buildable(p[0], p[1], maxSlope)) return p;
    const L = Math.hypot(dir[0], dir[1]) || 1;
    const dx = dir[0] / L, dz = dir[1] / L;
    for (let d = this.step; d <= reach; d += this.step) {
      for (const s of [1, -1]) {
        const x = p[0] + dx * d * s, z = p[1] + dz * d * s;
        if (this.buildable(x, z, maxSlope)) return [x, z];
      }
    }
    return null;
  }

  report() {
    return {
      step: this.step,
      basin: {
        x: Math.round(this.basin.x), z: Math.round(this.basin.z),
        areaHa: Math.round(this.basin.area / 10000),
        bbox: this.basin.bbox,
      },
      shorePoints: this.shore.length,
      axisDeg: Math.round((this.axis.theta * 180) / Math.PI),
      water: this.water,
    };
  }
}

/* ------------------------------------------------------------- polylines -- */

export function smoothPoly(pts, passes = 1) {
  let p = pts;
  for (let k = 0; k < passes; k++) {
    if (p.length < 3) return p;
    const q = [p[0]];
    for (let i = 1; i < p.length - 1; i++) {
      q.push([
        p[i - 1][0] * 0.25 + p[i][0] * 0.5 + p[i + 1][0] * 0.25,
        p[i - 1][1] * 0.25 + p[i][1] * 0.5 + p[i + 1][1] * 0.25,
      ]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

/** Drop points closer together than `minD`. */
export function simplify(pts, minD = 20) {
  if (pts.length < 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const l = out[out.length - 1];
    if (Math.hypot(pts[i][0] - l[0], pts[i][1] - l[1]) >= minD) out.push(pts[i]);
  }
  if (out.length < 2) out.push(pts[pts.length - 1]);
  return out;
}

/** Resample a polyline at a fixed arc-length spacing (endpoints preserved). */
export function resample(pts, spacing) {
  if (pts.length < 2) return pts.map((p) => p.slice());
  // cumulative length
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  if (total < 1e-6) return [pts[0].slice()];
  const n = Math.max(1, Math.round(total / spacing));
  const out = [];
  let j = 1;
  for (let k = 0; k <= n; k++) {
    const s = (k / n) * total;
    while (j < cum.length - 1 && cum[j] < s) j++;
    const a = pts[j - 1], b = pts[j];
    const seg = cum[j] - cum[j - 1] || 1;
    const t = (s - cum[j - 1]) / seg;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Offset a polyline sideways by `d` metres (positive = left of travel). */
export function offsetPoly(pts, d) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    out.push([pts[i][0] - dz * d, pts[i][1] + dx * d]);
  }
  return out;
}

export { clamp };
export default Site;
