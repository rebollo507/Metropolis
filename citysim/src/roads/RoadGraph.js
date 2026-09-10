import { ROAD_CLASS, nextId } from '../core/World.js';

/**
 * The road network: nodes + cubic-Bezier segments living in `world.roads`.
 *
 * Conventions
 *  - `t` in the public API is **normalised arc length** in [0,1], not the raw
 *    Bezier parameter. Traffic and props want distance, not parameter.
 *  - X/Z come from the Bezier; **Y comes from a smoothed elevation profile**
 *    sampled off the terrain, so roads follow the ground without rippling.
 *  - Derived caches hang off non-enumerable properties so `World.serialize()`
 *    stays clean.
 */

/* ------------------------------------------------------------------ maths -- */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

export function bez(p0, p1, p2, p3, t) {
  const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return {
    x: a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    z: a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2],
  };
}

export function dbez(p0, p1, p2, p3, t) {
  const mt = 1 - t, a = 3 * mt * mt, b = 6 * mt * t, c = 3 * t * t;
  return {
    x: a * (p1[0] - p0[0]) + b * (p2[0] - p1[0]) + c * (p3[0] - p2[0]),
    z: a * (p1[2] - p0[2]) + b * (p2[2] - p1[2]) + c * (p3[2] - p2[2]),
  };
}

export function ddbez(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return {
    x: 6 * mt * (p2[0] - 2 * p1[0] + p0[0]) + 6 * t * (p3[0] - 2 * p2[0] + p1[0]),
    z: 6 * mt * (p2[2] - 2 * p1[2] + p0[2]) + 6 * t * (p3[2] - 2 * p2[2] + p1[2]),
  };
}

/** Straight segment control points. */
export function straightCurve(a, b) {
  return [
    [a[0], a[1], a[2]],
    [lerp(a[0], b[0], 1 / 3), 0, lerp(a[2], b[2], 1 / 3)],
    [lerp(a[0], b[0], 2 / 3), 0, lerp(a[2], b[2], 2 / 3)],
    [b[0], b[1], b[2]],
  ];
}

/** Segment that bows sideways by `bulge` metres at its midpoint. */
export function arcCurve(a, b, bulge) {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const L = Math.hypot(dx, dz) || 1;
  const nx = -dz / L, nz = dx / L;
  const k = bulge * 4 / 3;
  return [
    [a[0], a[1], a[2]],
    [lerp(a[0], b[0], 1 / 3) + nx * k, 0, lerp(a[2], b[2], 1 / 3) + nz * k],
    [lerp(a[0], b[0], 2 / 3) + nx * k, 0, lerp(a[2], b[2], 2 / 3) + nz * k],
    [b[0], b[1], b[2]],
  ];
}

/** Control points that leave `a` heading `da` and arrive at `b` heading `db`. */
export function hermiteCurve(a, b, da, db, tension = 0.42) {
  const L = Math.hypot(b[0] - a[0], b[2] - a[2]) * tension;
  return [
    [a[0], a[1], a[2]],
    [a[0] + da[0] * L, 0, a[2] + da[1] * L],
    [b[0] - db[0] * L, 0, b[2] - db[1] * L],
    [b[0], b[1], b[2]],
  ];
}

const LUT_N = 32;

/* ------------------------------------------------------------------- net --- */

export class RoadNet {
  constructor(world, opts = {}) {
    this.world = world;
    this.roads = world.roads;
    this.events = opts.events || null;
    this.log = opts.log || null;
    /** terrain sampler; replaced whenever the terrain module appears */
    this.heightFn = opts.heightFn || (() => 0);
    this.waterLevel = opts.waterLevel ?? 0;
    /** roads sit this far proud of the ground so they never z-fight terrain */
    this.raise = opts.raise ?? 0.13;
    this.maxGrade = 0.075;
    /* When terrain can be cut for us (R-6 / R-terr-1 shipped `flattenAlong`),
     * the profile is a purely engineered smoothing and the ground is brought to
     * meet it. Without it we fall back to lift-and-resmooth, which can only ever
     * put a road on or above grade. */
    this.conform = false;
    this.waterClearance = opts.waterClearance ?? 5.0;

    this._depth = 0;
    this._added = [];
    this._removed = [];
    this._grid = null;
    this._cellSize = 64;
  }

  /* ---------------------------------------------------------- batching --- */

  begin() { this._depth++; return this; }

  end() {
    this._depth = Math.max(0, this._depth - 1);
    if (this._depth === 0) this._flush();
    return this;
  }

  _flush() {
    const added = this._added, removed = this._removed;
    this._added = []; this._removed = [];
    this._grid = null;
    if (!added.length && !removed.length) return;
    this.events?.emit('roads:changed', { version: this.roads.version, added, removed });
  }

  _mutated(addedId, removedId) {
    this.roads.version++;
    if (addedId !== undefined && addedId !== null) this._added.push(addedId);
    if (removedId !== undefined && removedId !== null) this._removed.push(removedId);
    this._grid = null;
    if (this._depth === 0) this._flush();
  }

  /* ------------------------------------------------------------- nodes --- */

  groundAt(x, z) {
    let y = 0;
    try { y = this.heightFn(x, z); } catch { y = 0; }
    return Number.isFinite(y) ? y : 0;
  }

  addNode(pos, type = 'junction') {
    const x = pos[0], z = pos[2] !== undefined ? pos[2] : pos[1];
    const id = nextId();
    const n = { id, pos: [x, this.groundAt(x, z), z], type, degree: 0, edges: [] };
    this.roads.nodes.set(id, n);
    this._mutated();
    return id;
  }

  node(id) { return this.roads.nodes.get(id) || null; }
  segment(id) { return this.roads.segments.get(id) || null; }

  removeNode(id) {
    const n = this.node(id);
    if (!n) return false;
    for (const sid of [...n.edges]) this.removeSegment(sid);
    this.roads.nodes.delete(id);
    this._mutated();
    return true;
  }

  /** Nearest existing node within `radius`, or null. */
  snapToExisting(pos, radius = 8) {
    const x = pos[0], z = pos[2] !== undefined ? pos[2] : pos[1];
    let best = null, bestD = radius * radius;
    for (const n of this.roads.nodes.values()) {
      const dx = n.pos[0] - x, dz = n.pos[2] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = n.id; }
    }
    return best;
  }

  /** Node at `pos`, reusing one nearby if there is one. */
  nodeAt(pos, snap = 6, type = 'junction') {
    const found = this.snapToExisting(pos, snap);
    return found !== null ? found : this.addNode(pos, type);
  }

  /* ---------------------------------------------------------- segments --- */

  addSegment(a, b, cls = 'lane2', curve = null, opts = {}) {
    const na = this.node(a), nb = this.node(b);
    if (!na || !nb || a === b) return null;
    if (!ROAD_CLASS[cls]) cls = 'lane2';
    // reject an exact duplicate
    for (const sid of na.edges) {
      const s = this.segment(sid);
      if (s && ((s.a === a && s.b === b) || (s.a === b && s.b === a))) return sid;
    }
    const id = nextId();
    const seg = {
      id, a, b, class: cls,
      curve: curve ? curve.map((p) => [p[0], p[1] || 0, p[2]]) : straightCurve(na.pos, nb.pos),
      length: 0,
      elevation: null,
      /* R-demo-6: an elevated span is a bridge deck — its profile interpolates
       * its abutments instead of being lifted to clear the ground under it. */
      elevated: !!opts.elevated,
    };
    seg.curve[0] = [na.pos[0], na.pos[1], na.pos[2]];
    seg.curve[3] = [nb.pos[0], nb.pos[1], nb.pos[2]];
    this.roads.segments.set(id, seg);
    na.edges.push(id); nb.edges.push(id);
    na.degree = na.edges.length; nb.degree = nb.edges.length;
    this.resample(seg);
    this._mutated(id);
    return id;
  }

  removeSegment(id) {
    const s = this.segment(id);
    if (!s) return false;
    for (const nid of [s.a, s.b]) {
      const n = this.node(nid);
      if (!n) continue;
      const i = n.edges.indexOf(id);
      if (i >= 0) n.edges.splice(i, 1);
      n.degree = n.edges.length;
    }
    this.roads.segments.delete(id);
    this._mutated(null, id);
    return true;
  }

  /** Split `id` at normalised arc length `t`, returning `{node, a, b}`. */
  splitSegment(id, t = 0.5) {
    const s = this.segment(id);
    if (!s) return null;
    t = clamp(t, 0.02, 0.98);
    const bt = this._tOfS(s, t * s.length);
    const [c0, c1, c2, c3] = s.curve;
    // de Casteljau
    const mix = (p, q, u) => [lerp(p[0], q[0], u), 0, lerp(p[2], q[2], u)];
    const a1 = mix(c0, c1, bt), a2 = mix(c1, c2, bt), a3 = mix(c2, c3, bt);
    const b1 = mix(a1, a2, bt), b2 = mix(a2, a3, bt);
    const mid = mix(b1, b2, bt);

    this.begin();
    const cls = s.class;
    const na = s.a, nb = s.b;
    this.removeSegment(id);
    const nm = this.addNode(mid, 'junction');
    const s1 = this.addSegment(na, nm, cls, [this.node(na).pos, a1, b1, mid]);
    const s2 = this.addSegment(nm, nb, cls, [mid, b2, a3, this.node(nb).pos]);
    this.end();
    return { node: nm, a: s1, b: s2 };
  }

  /* --------------------------------------------- arc length & elevation --- */

  /** Rebuild the arc-length LUT and elevation profile for one segment. */
  resample(seg) {
    const [p0, p1, p2, p3] = seg.curve;
    const lut = new Float64Array(LUT_N + 1);
    let prev = bez(p0, p1, p2, p3, 0), acc = 0;
    lut[0] = 0;
    for (let i = 1; i <= LUT_N; i++) {
      const t = i / LUT_N;
      const p = bez(p0, p1, p2, p3, t);
      acc += Math.hypot(p.x - prev.x, p.z - prev.z);
      lut[i] = acc;
      prev = p;
    }
    seg.length = acc;
    Object.defineProperty(seg, '_lut', { value: lut, enumerable: false, configurable: true, writable: true });
    this._computeElevation(seg);
    return seg;
  }

  /** Bezier parameter for a given arc length. */
  _tOfS(seg, s) {
    const lut = seg._lut;
    if (!lut) return clamp(s / (seg.length || 1), 0, 1);
    const L = seg.length || 1;
    s = clamp(s, 0, L);
    let lo = 0, hi = LUT_N;
    while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (lut[m] <= s) lo = m; else hi = m; }
    const d = lut[hi] - lut[lo];
    const f = d > 1e-6 ? (s - lut[lo]) / d : 0;
    return (lo + f) / LUT_N;
  }

  /**
   * Sample the terrain along the segment, then smooth it hard, pin the ends to
   * the node heights and clamp the gradient. Without this, roads ripple.
   */
  /** Highest ground under the road's full width at Bezier parameter t. */
  _groundAcross(seg, t, half) {
    const [p0, p1, p2, p3] = seg.curve;
    const p = bez(p0, p1, p2, p3, t);
    const d = dbez(p0, p1, p2, p3, t);
    const l = Math.hypot(d.x, d.z) || 1;
    const nx = -d.z / l, nz = d.x / l;
    let g = this.groundAt(p.x, p.z);
    for (const k of [-1, -0.55, 0.55, 1]) {
      g = Math.max(g, this.groundAt(p.x + nx * half * k, p.z + nz * half * k));
    }
    return g;
  }

  _computeElevation(seg) {
    const na = this.node(seg.a), nb = this.node(seg.b);
    const L = seg.length || 1;
    const n = clamp(Math.ceil(L / 4) + 1, 2, 320);
    const ys = new Float32Array(n);
    const raw = new Float32Array(n);
    const cls = ROAD_CLASS[seg.class] || ROAD_CLASS.lane2;
    const half = cls.width / 2;

    for (let i = 0; i < n; i++) {
      const t = this._tOfS(seg, (i / (n - 1)) * L);
      raw[i] = this._groundAcross(seg, t, half);
      ys[i] = raw[i];
    }

    const grounded = !seg.elevated;
    const ya = grounded ? Math.max(na ? na.pos[1] : raw[0], raw[0]) : (na ? na.pos[1] : raw[0]);
    const yb = grounded ? Math.max(nb ? nb.pos[1] : raw[n - 1], raw[n - 1]) : (nb ? nb.pos[1] : raw[n - 1]);

    /* An elevated span ignores the ground entirely — over water the "ground" is
     * the river bed, and lifting to clear it is what R-demo-6 describes as a
     * ribbon of asphalt lying in the river. The deck is a shallow hog curve
     * between its abutments, held above the water line. */
    if (seg.elevated) {
      const rise = clamp(L * 0.014, 0.4, 3.2);
      const clear = (this.world.terrain?.water ?? 0) + this.waterClearance;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        ys[i] = Math.max(lerp(ya, yb, t) + rise * 4 * t * (1 - t), clear);
      }
      ys[0] = ya; ys[n - 1] = yb;
      seg.elevation = { n, ds: L / Math.max(1, n - 1), ys: Array.from(ys) };
      Object.defineProperty(seg, '_ys', { value: ys, enumerable: false, configurable: true, writable: true });
      return seg;
    }

    if (n > 2) {
      const tmp = new Float32Array(n);
      const smooth = (passes) => {
        for (let k = 0; k < passes; k++) {
          tmp[0] = ya; tmp[n - 1] = yb;
          for (let i = 1; i < n - 1; i++) tmp[i] = ys[i - 1] * 0.25 + ys[i] * 0.5 + ys[i + 1] * 0.25;
          ys.set(tmp);
        }
      };
      smooth(clamp(Math.round(n / 6), 3, 24));
      // blend the smoothed profile toward a straight ramp between the endpoints;
      // this is what makes a road read as engineered rather than draped
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        ys[i] = lerp(ys[i], lerp(ya, yb, t), 0.30);
      }
      // gradient limit, then re-pin the ends
      const ds = L / (n - 1), maxD = this.maxGrade * ds;
      for (let i = 1; i < n; i++) ys[i] = clamp(ys[i], ys[i - 1] - maxD, ys[i - 1] + maxD);
      for (let i = n - 2; i >= 0; i--) ys[i] = clamp(ys[i], ys[i + 1] - maxD, ys[i + 1] + maxD);
      const eA = ya - ys[0], eB = yb - ys[n - 1];
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        ys[i] += eA * (1 - t) + eB * t;
      }
      /* Nothing may cut BELOW the ground: terrain is not carved for us, so a
       * smoothed profile that dips into a hillside would simply be swallowed by
       * the terrain mesh (and worse, by its coarse LODs). Lift-and-resmooth
       * converges on a profile that is everywhere on or above the ground, which
       * the graded verge then ties back into the slope. */
      if (!this.conform) {
        for (let round = 0; round < 4; round++) {
          for (let i = 0; i < n; i++) ys[i] = Math.max(ys[i], raw[i]);
          smooth(2);
        }
        for (let i = 0; i < n; i++) ys[i] = Math.max(ys[i], raw[i]);
      }
      ys[0] = ya; ys[n - 1] = yb;
    } else {
      ys[0] = ya; ys[n - 1] = yb;
    }

    seg.elevation = { n, ds: L / Math.max(1, n - 1), ys: Array.from(ys) };
    Object.defineProperty(seg, '_ys', { value: ys, enumerable: false, configurable: true, writable: true });
    return seg;
  }

  yAt(seg, s) {
    const ys = seg._ys;
    if (!ys) return (this.node(seg.a)?.pos[1] ?? 0) + this.raise;
    const n = ys.length, L = seg.length || 1;
    const f = clamp(s / L, 0, 1) * (n - 1);
    const i = Math.min(n - 2, Math.floor(f));
    const u = f - i;
    return lerp(ys[i], ys[i + 1], u) + this.raise;
  }

  /** Re-sample every segment (call after terrain arrives or nodes move). */
  /** Widest half-width of anything meeting this node. */
  _nodeRadius(n) {
    let r = 4;
    for (const sid of n.edges) {
      const s = this.segment(sid);
      const c = s && ROAD_CLASS[s.class];
      if (c) r = Math.max(r, c.width / 2 + (c.sidewalk || 0));
    }
    return r;
  }

  resampleAll() {
    for (const n of this.roads.nodes.values()) {
      // Deck and abutment levels are structural, not sampled from the ground.
      if (n.deckY !== undefined) { n.pos[1] = n.deckY; continue; }
      n.pos[1] = this.groundAt(n.pos[0], n.pos[2]);
    }
    this.relaxNodes(2, 0.22);
    // A junction is a flat slab. Without terrain cutting it must clear the
    // highest ground it covers; with cutting, the ground is brought to it.
    if (!this.conform) for (const n of this.roads.nodes.values()) {
      if (n.deckY !== undefined) continue;
      const r = this._nodeRadius(n);
      let y = Math.max(n.pos[1], this.groundAt(n.pos[0], n.pos[2]));
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        y = Math.max(y, this.groundAt(n.pos[0] + Math.cos(a) * r, n.pos[2] + Math.sin(a) * r));
      }
      n.pos[1] = y;
    }
    for (const s of this.roads.segments.values()) {
      const na = this.node(s.a), nb = this.node(s.b);
      if (na) s.curve[0] = [na.pos[0], na.pos[1], na.pos[2]];
      if (nb) s.curve[3] = [nb.pos[0], nb.pos[1], nb.pos[2]];
      this.resample(s);
    }
    this._mutated();
    return this;
  }

  /** Laplacian relaxation of node heights so junctions sit level. */
  relaxNodes(iters = 2, w = 0.25) {
    for (let k = 0; k < iters; k++) {
      const next = new Map();
      for (const n of this.roads.nodes.values()) {
        if (!n.edges.length || n.deckY !== undefined) continue;
        let sum = 0, c = 0;
        for (const sid of n.edges) {
          const s = this.segment(sid);
          if (!s) continue;
          const o = this.node(s.a === n.id ? s.b : s.a);
          if (o) { sum += o.pos[1]; c++; }
        }
        if (c) next.set(n.id, lerp(n.pos[1], sum / c, w));
      }
      for (const [id, y] of next) this.node(id).pos[1] = y;
    }
    return this;
  }

  /* --------------------------------------------------------- evaluation --- */

  /** Point on the centreline at normalised arc length t. */
  pointAt(segId, t = 0.5, out = null) {
    const s = typeof segId === 'object' ? segId : this.segment(segId);
    const o = out || { x: 0, y: 0, z: 0 };
    if (!s) return o;
    const dist = clamp(t, 0, 1) * s.length;
    const bt = this._tOfS(s, dist);
    const p = bez(s.curve[0], s.curve[1], s.curve[2], s.curve[3], bt);
    o.x = p.x; o.z = p.z; o.y = this.yAt(s, dist);
    return o;
  }

  /** Unit tangent (XZ) at normalised arc length t; y is the running grade. */
  tangentAt(segId, t = 0.5, out = null) {
    const s = typeof segId === 'object' ? segId : this.segment(segId);
    const o = out || { x: 0, y: 0, z: 0 };
    if (!s) { o.x = 1; o.y = 0; o.z = 0; return o; }
    const dist = clamp(t, 0, 1) * s.length;
    const bt = this._tOfS(s, dist);
    const d = dbez(s.curve[0], s.curve[1], s.curve[2], s.curve[3], bt);
    const l = Math.hypot(d.x, d.z) || 1;
    o.x = d.x / l; o.z = d.z / l;
    const e = Math.min(2, s.length * 0.1) || 0.5;
    o.y = (this.yAt(s, Math.min(s.length, dist + e)) - this.yAt(s, Math.max(0, dist - e))) / (2 * e);
    return o;
  }

  /** Signed curvature (1/m) in XZ; positive = turning left. */
  curvatureAt(segId, t = 0.5) {
    const s = typeof segId === 'object' ? segId : this.segment(segId);
    if (!s) return 0;
    const bt = this._tOfS(s, clamp(t, 0, 1) * s.length);
    const d = dbez(s.curve[0], s.curve[1], s.curve[2], s.curve[3], bt);
    const dd = ddbez(s.curve[0], s.curve[1], s.curve[2], s.curve[3], bt);
    const den = Math.pow(d.x * d.x + d.z * d.z, 1.5);
    if (den < 1e-6) return 0;
    return (d.x * dd.z - d.z * dd.x) / den * -1;
  }

  /** Lane geometry for a class: drivable half-width and per-lane centres. */
  laneLayout(cls) {
    const c = ROAD_CLASS[cls] || ROAD_CLASS.lane2;
    const half = c.width / 2;
    const median = c.median || 0;
    const lanes = c.lanes;
    const perSide = Math.max(1, lanes / 2);
    const drivable = (c.width - median) / 2;          // per direction
    const lw = drivable / perSide;
    const centres = [];
    // lane 0..perSide-1 on the -x (right-hand traffic heading +d) side, then the other side
    for (let i = 0; i < perSide; i++) centres.push(-(median / 2) - lw * (i + 0.5));
    for (let i = 0; i < perSide; i++) centres.push((median / 2) + lw * (i + 0.5));
    return { half, lanes, perSide, laneWidth: lw, median, centres, sidewalk: c.sidewalk };
  }

  /**
   * Centre of a lane. laneIndex 0..lanes-1; the first half are the lanes on the
   * left of the direction of travel-of-record, the second half mirror them.
   */
  laneCenter(segId, laneIndex = 0, t = 0.5, out = null) {
    const s = typeof segId === 'object' ? segId : this.segment(segId);
    const o = out || { x: 0, y: 0, z: 0 };
    if (!s) return o;
    const lay = this.laneLayout(s.class);
    const a = lay.centres[clamp(laneIndex | 0, 0, lay.centres.length - 1)];
    this.pointAt(s, t, o);
    const tan = this.tangentAt(s, t, _tmpT);
    // left normal of (x,z) heading
    o.x += -tan.z * a;
    o.z += tan.x * a;
    return o;
  }

  /* ----------------------------------------------------------- queries --- */

  _buildGrid() {
    const g = new Map();
    const cs = this._cellSize;
    for (const s of this.roads.segments.values()) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of s.curve) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
      }
      const i0 = Math.floor(minX / cs), i1 = Math.floor(maxX / cs);
      const j0 = Math.floor(minZ / cs), j1 = Math.floor(maxZ / cs);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = i + ',' + j;
          let arr = g.get(k);
          if (!arr) { arr = []; g.set(k, arr); }
          arr.push(s.id);
        }
      }
    }
    this._grid = g;
    return g;
  }

  /** Ids of segments whose control hull is within `r` of `pos`. */
  segmentsNear(pos, r = 40) {
    const x = pos[0] ?? pos.x ?? 0;
    const z = pos[2] ?? pos.z ?? 0;
    const g = this._grid || this._buildGrid();
    const cs = this._cellSize;
    const i0 = Math.floor((x - r) / cs), i1 = Math.floor((x + r) / cs);
    const j0 = Math.floor((z - r) / cs), j1 = Math.floor((z + r) / cs);
    const seen = new Set();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const arr = g.get(i + ',' + j);
        if (!arr) continue;
        for (const id of arr) seen.add(id);
      }
    }
    const out = [];
    const r2 = r * r;
    for (const id of seen) {
      const s = this.segment(id);
      if (!s) continue;
      let best = Infinity;
      const N = 8;
      for (let k = 0; k <= N; k++) {
        const p = bez(s.curve[0], s.curve[1], s.curve[2], s.curve[3], k / N);
        const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
        if (d < best) best = d;
      }
      if (best <= r2) out.push(id);
    }
    return out;
  }

  /** Closest point on the whole network: {segmentId, t, pos, dist, class}. */
  nearestPoint(pos, maxR = 220) {
    const x = pos[0] ?? pos.x ?? 0;
    const z = pos[2] ?? pos.z ?? 0;
    let ids = this.segmentsNear([x, 0, z], 60);
    if (!ids.length) ids = this.segmentsNear([x, 0, z], maxR);
    if (!ids.length) ids = [...this.roads.segments.keys()];

    let bestSeg = null, bestT = 0, bestD = Infinity;
    for (const id of ids) {
      const s = this.segment(id);
      if (!s) continue;
      const N = Math.max(8, Math.min(48, Math.round(s.length / 6)));
      for (let k = 0; k <= N; k++) {
        const t = k / N;
        const p = bez(s.curve[0], s.curve[1], s.curve[2], s.curve[3], t);
        const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
        if (d < bestD) { bestD = d; bestSeg = s; bestT = t; }
      }
    }
    if (!bestSeg) return null;
    // refine in Bezier parameter, then convert to normalised arc length
    let lo = Math.max(0, bestT - 1 / 24), hi = Math.min(1, bestT + 1 / 24);
    for (let it = 0; it < 20; it++) {
      const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      const p1 = bez(bestSeg.curve[0], bestSeg.curve[1], bestSeg.curve[2], bestSeg.curve[3], m1);
      const p2 = bez(bestSeg.curve[0], bestSeg.curve[1], bestSeg.curve[2], bestSeg.curve[3], m2);
      const d1 = (p1.x - x) ** 2 + (p1.z - z) ** 2;
      const d2 = (p2.x - x) ** 2 + (p2.z - z) ** 2;
      if (d1 < d2) hi = m2; else lo = m1;
    }
    const bt = (lo + hi) / 2;
    const sDist = this._sOfT(bestSeg, bt);
    const t = clamp(sDist / (bestSeg.length || 1), 0, 1);
    const p = this.pointAt(bestSeg, t);
    return {
      segmentId: bestSeg.id, t, pos: p,
      dist: Math.hypot(p.x - x, p.z - z),
      class: bestSeg.class,
    };
  }

  _sOfT(seg, bt) {
    const lut = seg._lut;
    if (!lut) return bt * seg.length;
    const f = clamp(bt, 0, 1) * LUT_N;
    const i = Math.min(LUT_N - 1, Math.floor(f));
    return lerp(lut[i], lut[i + 1], f - i);
  }

  /* ------------------------------------------------------------ summary --- */

  /**
   * Road corridors for `terrain.flattenAlong`, grouped into width buckets so
   * a boulevard carves a wider shelf than an alley. Points carry the designed
   * carriageway level, so the ground is brought to the road rather than the
   * road lifted to clear the ground. Elevated spans are excluded — nothing
   * should carve a river bed under a bridge.
   */
  corridors(step = 8) {
    const buckets = new Map();
    for (const seg of this.roads.segments.values()) {
      if (seg.elevated) continue;
      const c = ROAD_CLASS[seg.class] || ROAD_CLASS.lane2;
      const w = c.width + (c.sidewalk || 0) * 2 + 3;
      const key = Math.round(w / 4) * 4;
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      const L = seg.length || 1;
      const n = Math.max(2, Math.ceil(L / step) + 1);
      const line = [];
      for (let i = 0; i < n; i++) {
        const p = this.pointAt(seg, i / (n - 1));
        line.push({ x: p.x, y: p.y - this.raise + 0.02, z: p.z });
      }
      arr.push(line);
    }
    return [...buckets.entries()].map(([width, lines]) => ({ width, lines }));
  }

  bounds() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const n of this.roads.nodes.values()) {
      minX = Math.min(minX, n.pos[0]); maxX = Math.max(maxX, n.pos[0]);
      minZ = Math.min(minZ, n.pos[2]); maxZ = Math.max(maxZ, n.pos[2]);
    }
    if (!Number.isFinite(minX)) return { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    return { minX, maxX, minZ, maxZ };
  }

  clear() {
    this.begin();
    for (const id of [...this.roads.segments.keys()]) this.removeSegment(id);
    for (const id of [...this.roads.nodes.keys()]) this.roads.nodes.delete(id);
    this._mutated();
    this.end();
    return this;
  }

  stats() {
    let len = 0;
    const byClass = {};
    for (const s of this.roads.segments.values()) {
      len += s.length;
      byClass[s.class] = (byClass[s.class] || 0) + 1;
    }
    return { nodes: this.roads.nodes.size, segments: this.roads.segments.size, lengthM: Math.round(len), byClass };
  }
}

const _tmpT = { x: 0, y: 0, z: 0 };

export default RoadNet;
