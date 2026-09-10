import * as THREE from 'three';
import { ROAD_CLASS } from '../core/World.js';
import { Builder } from './Mesh.js';
import AmbientCrowd from './Ambient.js';

/**
 * Pedestrians.
 *
 * A walk graph is derived from the same road segments the lane network uses:
 * two pavement polylines per segment, corner links around each junction, and
 * explicit **crossing** edges over each arm. A crossing carries the id of the
 * vehicle lane it conflicts with, so a pedestrian at a signalised junction waits
 * on the kerb while that lane has green and steps off when it goes red — which
 * is the behaviour that makes a junction read as a junction rather than a
 * roundabout of ghosts.
 *
 * Rendering is a single instanced figure per LOD tier with a procedural walk
 * cycle in the vertex shader: legs and arms counter-swing about their pivots and
 * the body bobs, driven by a per-instance phase. No skeletons, no morph targets,
 * three draw calls for the whole city's crowd.
 */

const WALK_SPEED = [1.18, 1.34, 1.02, 1.46];

/* Distance ladder. Round 1 shipped 55 / 145 / 330 m, and every hero camera in
 * the demo stands outside 330 m of most of the pavement it can see — which is
 * the same near-field-LOD finding that drove every other module's fix round.
 * A LOD2 pedestrian is 60 triangles, so reaching 560 m costs triangles, not
 * draw calls. */
const PED_TIER0 = 115, PED_TIER1 = 260, PED_CULL = 560;
const TIER0_2 = PED_TIER0 * PED_TIER0, TIER1_2 = PED_TIER1 * PED_TIER1;
const PED_CULL2 = PED_CULL * PED_CULL;
const CROSS_WAIT_MAX = 22;

/* --------------------------------------------------------------- graph --- */

export class WalkGraph {
  constructor(world, roads) {
    this.world = world;
    this.roads = roads;
    this.reset();
  }

  reset() {
    this.nodes = [];       // {x,y,z, edges:[]}
    this.edges = [];       // {pts:Float32Array, len, a, b, kind, guard}
    this.byZone = [];
  }

  build() {
    this.reset();
    const world = this.world, roads = this.roads;
    if (!roads || world.roads.segments.size === 0) return this.stats();
    const segs = world.roads.segments;
    const nodes = world.roads.nodes;

    const nodeR = new Map();
    for (const n of nodes.values()) {
      let r = 3;
      for (const sid of n.edges || []) {
        const s = segs.get(sid);
        const c = s && ROAD_CLASS[s.class];
        if (c) r = Math.max(r, c.width / 2 + (c.sidewalk || 0) * 0.5);
      }
      nodeR.set(n.id, r + 1.2);
    }

    const key = new Map();
    const addNode = (k, x, y, z) => {
      if (key.has(k)) return key.get(k);
      const id = this.nodes.length;
      this.nodes.push({ x, y, z, edges: [] });
      key.set(k, id);
      return id;
    };
    const addEdge = (a, b, pts, kind = 0, guard = -1, owner = -1, side = 0) => {
      if (a === b) return -1;
      let len = 0;
      for (let i = 3; i < pts.length; i += 3) {
        len += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2], pts[i + 2] - pts[i - 1]);
      }
      if (len < 0.4) return -1;
      const id = this.edges.length;
      this.edges.push({ pts: new Float32Array(pts), len, a, b, kind, guard, owner, side });
      this.nodes[a].edges.push(id);
      this.nodes[b].edges.push(id);
      return id;
    };

    const P = { x: 0, y: 0, z: 0 }, T = { x: 0, y: 0, z: 0 };
    const walkOffset = (cls) => {
      const c = ROAD_CLASS[cls] || ROAD_CLASS.lane2;
      return c.width / 2 + Math.max(1.0, (c.sidewalk || 1.5)) * 0.52;
    };

    /* pavement runs */
    for (const s of segs.values()) {
      if (s.class === 'highway') continue;
      const L = s.length || 0;
      const trimA = Math.min(nodeR.get(s.a) ?? 3, L * 0.34);
      const trimB = Math.min(nodeR.get(s.b) ?? 3, L * 0.34);
      const usable = L - trimA - trimB;
      if (usable < 3) continue;
      const t0 = trimA / L, t1 = 1 - trimB / L;
      const off = walkOffset(s.class);
      const n = Math.max(2, Math.min(28, Math.ceil(usable / 7) + 1));
      for (const side of [1, -1]) {
        const pts = [];
        for (let k = 0; k < n; k++) {
          const t = t0 + (t1 - t0) * (k / (n - 1));
          roads.pointAt(s.id, t, P);
          roads.tangentAt(s.id, t, T);
          pts.push(P.x + -T.z * off * side, P.y + 0.14, P.z + T.x * off * side);
        }
        const a = addNode(`${s.id}:${side}:0`, pts[0], pts[1], pts[2]);
        const b = addNode(`${s.id}:${side}:1`, pts[pts.length - 3], pts[pts.length - 2], pts[pts.length - 1]);
        addEdge(a, b, pts, 0, -1, s.id, side);
      }
    }

    /* junction corners + crossings */
    for (const nd of nodes.values()) {
      const arms = [];
      for (const sid of nd.edges || []) {
        const s = segs.get(sid);
        if (!s || s.class === 'highway') continue;
        const atA = s.a === nd.id;
        roads.pointAt(s.id, atA ? 0.08 : 0.92, P);
        const dx = P.x - nd.pos[0], dz = P.z - nd.pos[2];
        const l = Math.hypot(dx, dz) || 1;
        // outward-left / outward-right pavement ends
        const leftKey = atA ? `${s.id}:1:0` : `${s.id}:-1:1`;
        const rightKey = atA ? `${s.id}:-1:0` : `${s.id}:1:1`;
        if (!key.has(leftKey) || !key.has(rightKey)) continue;
        arms.push({
          seg: s, bearing: Math.atan2(dx, dz),
          ux: dx / l, uz: dz / l,
          left: key.get(leftKey), right: key.get(rightKey),
        });
      }
      if (!arms.length) continue;
      arms.sort((a, b) => a.bearing - b.bearing);

      // corner links: pick whichever pair of ends is actually adjacent
      for (let i = 0; i < arms.length; i++) {
        const A = arms[i], B = arms[(i + 1) % arms.length];
        if (arms.length < 2) break;
        const cand = [[A.left, B.right], [A.right, B.left]];
        let best = null, bestD = Infinity;
        for (const [p, q] of cand) {
          const np = this.nodes[p], nq = this.nodes[q];
          const d = (np.x - nq.x) ** 2 + (np.z - nq.z) ** 2;
          if (d < bestD) { bestD = d; best = [p, q]; }
        }
        if (!best || bestD > 60 * 60) continue;
        const np = this.nodes[best[0]], nq = this.nodes[best[1]];
        // bow the corner out around the junction so it does not cut the kerb
        const mx = (np.x + nq.x) / 2, mz = (np.z + nq.z) / 2;
        const vx = mx - nd.pos[0], vz = mz - nd.pos[2];
        const vl = Math.hypot(vx, vz) || 1;
        const r = Math.max(vl, nodeR.get(nd.id) ?? 4);
        const pts = [];
        for (let k = 0; k <= 4; k++) {
          const t = k / 4;
          const x = np.x + (nq.x - np.x) * t;
          const z = np.z + (nq.z - np.z) * t;
          const bulge = Math.sin(t * Math.PI) * Math.max(0, r - vl) * 0.7;
          pts.push(x + (vx / vl) * bulge, (np.y + nq.y) / 2, z + (vz / vl) * bulge);
        }
        addEdge(best[0], best[1], pts, 0, -1);
      }

      // crossings: over each arm, set back from the node
      if (arms.length >= 2) {
        for (const A of arms) {
          const np = this.nodes[A.left], nq = this.nodes[A.right];
          const pts = [];
          for (let k = 0; k <= 3; k++) {
            const t = k / 3;
            pts.push(np.x + (nq.x - np.x) * t, (np.y + nq.y) / 2 - 0.02, np.z + (nq.z - np.z) * t);
          }
          addEdge(A.left, A.right, pts, 1, A.seg.id);
        }
      }
    }

    // prune orphan nodes' bookkeeping and precompute a flat point buffer
    this.flatten();
    return this.stats();
  }

  flatten() {
    let total = 0;
    for (const e of this.edges) total += e.pts.length;
    this.pts = new Float32Array(total);
    this.eOff = new Int32Array(this.edges.length);
    this.eCount = new Int32Array(this.edges.length);
    this.eLen = new Float32Array(this.edges.length);
    this.eA = new Int32Array(this.edges.length);
    this.eB = new Int32Array(this.edges.length);
    this.eKind = new Uint8Array(this.edges.length);
    this.eSeg = new Int32Array(this.edges.length);
    this.eOwner = new Int32Array(this.edges.length).fill(-1);
    this.eSide = new Int8Array(this.edges.length);
    this.eGuard = new Int32Array(this.edges.length).fill(-1);
    let o = 0;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      this.pts.set(e.pts, o);
      this.eOff[i] = o / 3;
      this.eCount[i] = e.pts.length / 3;
      this.eLen[i] = e.len;
      this.eA[i] = e.a; this.eB[i] = e.b;
      this.eKind[i] = e.kind;
      this.eSeg[i] = e.guard;
      this.eOwner[i] = e.owner ?? -1;
      this.eSide[i] = e.side ?? 0;
      o += e.pts.length;
    }
    this.nodeEdgeOff = new Int32Array(this.nodes.length + 1);
    let t = 0;
    for (let i = 0; i < this.nodes.length; i++) { this.nodeEdgeOff[i] = t; t += this.nodes[i].edges.length; }
    this.nodeEdgeOff[this.nodes.length] = t;
    this.nodeEdges = new Int32Array(t);
    let k = 0;
    for (const n of this.nodes) for (const e of n.edges) this.nodeEdges[k++] = e;
  }

  /**
   * Per-edge spawn weight from the zone it fronts. A city's pavements are not
   * uniformly busy: a retail frontage carries several times the footfall of a
   * suburban street, and spreading a fixed crowd budget evenly over 40 km of
   * pavement makes every street look deserted.
   */
  weigh(zoneAt, focus) {
    const n = this.edges.length;
    this.eWeight = new Float32Array(n);
    this.eCum = new Float32Array(n + 1);
    const Z = { 0: 0.30, 1: 0.75, 2: 1.7, 3: 2.6, 4: 3.4, 5: 0.45, 6: 2.2, 7: 1.4, 8: 1.8 };
    let acc = 0;
    for (let i = 0; i < n; i++) {
      let w = this.eKind[i] === 1 ? 0 : 1;         // never start life mid-crossing
      if (w > 0) {
        const o = this.eOff[i] * 3;
        const mx = this.pts[o], mz = this.pts[o + 2];
        if (zoneAt) {
          let z = 0;
          try { z = zoneAt(mx, mz) | 0; } catch { z = 0; }
          w *= Z[z] ?? 0.6;
        }
        w *= Math.max(0.2, Math.min(3, this.eLen[i] / 40));
        if (focus) {
          const d = Math.hypot(mx - focus.x, mz - focus.z);
          w *= 1 + focus.boost * Math.exp(-(d * d) / (2 * focus.r * focus.r));
        }
      }
      this.eWeight[i] = w;
      acc += w;
      this.eCum[i + 1] = acc;
    }
    this.weightTotal = acc;
    return this;
  }

  /** Weighted edge pick in O(log n). */
  pickEdge(u) {
    if (!this.eCum || this.weightTotal <= 0) return -1;
    const target = u * this.weightTotal;
    let lo = 0, hi = this.edges.length;
    while (lo + 1 < hi) {
      const m = (lo + hi) >> 1;
      if (this.eCum[m] <= target) lo = m; else hi = m;
    }
    return this.eWeight[lo] > 0 ? lo : -1;
  }

  /** Bind each crossing to a vehicle lane whose aspect gates it. */
  bindGuards(net) {
    for (let i = 0; i < this.eKind.length; i++) {
      if (this.eKind[i] !== 1) continue;
      const segId = this.eSeg[i];
      const lanes = net.segLanes.get(segId);
      if (!lanes || !lanes.length) continue;
      // the approach lane into the nearest junction is the one that matters
      let pick = -1;
      for (const l of lanes) if (net.ctrl[l] !== 0) { pick = l; break; }
      this.eGuard[i] = pick >= 0 ? pick : lanes[0];
    }
  }

  sample(edge, s, out) {
    const n = this.eCount[edge];
    const base = this.eOff[edge];
    const len = this.eLen[edge];
    if (n < 2) { out.x = 0; out.y = 0; out.z = 0; out.hx = 1; out.hz = 0; return out; }
    const u = Math.max(0, Math.min(1, s / Math.max(0.001, len))) * (n - 1);
    const i = Math.min(n - 2, Math.floor(u));
    const f = u - i;
    const a = (base + i) * 3, b = (base + i + 1) * 3;
    const p = this.pts;
    out.x = p[a] + (p[b] - p[a]) * f;
    out.y = p[a + 1] + (p[b + 1] - p[a + 1]) * f;
    out.z = p[a + 2] + (p[b + 2] - p[a + 2]) * f;
    const dx = p[b] - p[a], dz = p[b + 2] - p[a + 2];
    const d = Math.hypot(dx, dz) || 1;
    out.hx = dx / d; out.hz = dz / d;
    return out;
  }

  stats() {
    return { walkNodes: this.nodes.length, walkEdges: this.edges.length,
      crossings: this.edges.filter((e) => e.kind === 1).length };
  }
}

/* ----------------------------------------------------------- figure ------ */

/**
 * One walking figure, at three levels of detail.
 *
 *   tier 0  < 115 m   torso, head, two legs, two arms — ~500 triangles
 *   tier 1  < 260 m   torso, head, two legs, no arms  — ~250
 *   tier 2  < 560 m   one tapered column and a head    — ~70
 *
 * `aPart` selects the limb and `aPivotY` its hinge height; the walk cycle in the
 * vertex shader reads both. Tier 2 leaves every vertex on part 0, so the shader
 * costs nothing there and the figure is a silhouette — which at 260 m and beyond
 * is all it ever was.
 */
export function buildPed(lod) {
  const b = new Builder();
  b.extra = [];
  b.extraValue = [0, 0];
  const set = (part, pivot) => { b.extraValue = [part, pivot]; };
  const corners = lod === 0 ? 2 : 1;

  const ring = (len, wid, r) => {
    const pts = [];
    const hx = wid / 2 - r, hz = len / 2 - r;
    const cs = [[hx, hz], [-hx, hz], [-hx, -hz], [hx, -hz]];
    const start = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i <= corners; i++) {
        const a = start[c] + (i / corners) * (Math.PI / 2);
        pts.push([cs[c][0] + Math.cos(a) * r, cs[c][1] + Math.sin(a) * r]);
      }
    }
    return pts;
  };

  if (lod === 2) {
    // a silhouette: legs, body and head in one column, no limbs to animate
    set(0, 0);
    b.loft([
      { y: 0.02, pts: ring(0.24, 0.30, 0.08) },
      { y: 0.46, pts: ring(0.20, 0.26, 0.07) },
      { y: 0.88, pts: ring(0.21, 0.33, 0.09) },
      { y: 1.34, pts: ring(0.22, 0.38, 0.10) },
      { y: 1.44, pts: ring(0.16, 0.26, 0.07) },
      { y: 1.58, pts: ring(0.17, 0.18, 0.07) },
      { y: 1.71, pts: ring(0.11, 0.12, 0.05) },
    ], true, true, 1);
    const g2 = b.build('traffic:ped:2');
    g2.setAttribute('aPart', new THREE.Float32BufferAttribute(b.extra.filter((_, i) => i % 2 === 0), 1));
    g2.setAttribute('aPivotY', new THREE.Float32BufferAttribute(b.extra.filter((_, i) => i % 2 === 1), 1));
    return g2;
  }

  // torso + head (part 0)
  set(0, 0);
  b.loft([
    { y: 0.82, pts: ring(0.21, 0.31, 0.06) },
    { y: 0.94, pts: ring(0.23, 0.35, 0.07) },
    { y: 1.10, pts: ring(0.23, 0.38, 0.07) },
    { y: 1.33, pts: ring(0.22, 0.425, 0.07) },   // shoulders, wider than the waist
    { y: 1.40, pts: ring(0.18, 0.32, 0.06) },
  ], true, true, 1);
  // a neck gap, so the head reads as a head and not as the top of a column
  b.loft([
    { y: 1.40, pts: ring(0.10, 0.115, 0.035) },
    { y: 1.485, pts: ring(0.105, 0.12, 0.04) },
    { y: 1.545, pts: ring(0.15, 0.155, 0.055) },
    { y: 1.655, pts: ring(0.17, 0.175, 0.065) },
    { y: 1.725, pts: ring(0.115, 0.13, 0.05) },
  ], true, false, 1);

  // legs (parts 1, 2) — pivot at the hip
  for (const [sx, part] of [[-1, 1], [1, 2]]) {
    set(part, 0.86);
    b.push();
    b.translate(sx * 0.098, 0, 0);
    b.loft(lod === 0 ? [
      { y: 0.015, pts: ring(0.235, 0.115, 0.035) },   // foot, longer than it is wide
      { y: 0.095, pts: ring(0.145, 0.12, 0.04) },
      { y: 0.44, pts: ring(0.128, 0.125, 0.045) },
      { y: 0.86, pts: ring(0.17, 0.165, 0.055) },
    ] : [
      { y: 0.02, pts: ring(0.20, 0.12, 0.04) },
      { y: 0.86, pts: ring(0.17, 0.165, 0.055) },
    ], true, true, 1);
    b.pop();
  }

  // arms (parts 3, 4) — pivot at the shoulder, swinging opposite the legs.
  // Dropped past tier 0: they are under a pixel wide by 120 m.
  if (lod === 0) {
    for (const [sx, part] of [[-1, 4], [1, 3]]) {
      set(part, 1.34);
      b.push();
      b.translate(sx * 0.212, 0, 0);
      b.loft([
        { y: 0.86, pts: ring(0.095, 0.078, 0.028) },
        { y: 1.06, pts: ring(0.10, 0.085, 0.032) },
        { y: 1.32, pts: ring(0.115, 0.108, 0.042) },
      ], true, true, 1);
      b.pop();
    }
  }

  const g = b.build(`traffic:ped:${lod}`);
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(b.extra.filter((_, i) => i % 2 === 0), 1));
  g.setAttribute('aPivotY', new THREE.Float32BufferAttribute(b.extra.filter((_, i) => i % 2 === 1), 1));
  return g;
}

/** Patch a standard material with the walk cycle. */
export function patchWalk(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aPart;
attribute float aPivotY;
attribute vec2 aPhase;
vec3 walkRot(vec3 p, float pivot, float ang) {
  float c = cos(ang), s = sin(ang);
  vec3 q = p - vec3(0.0, pivot, 0.0);
  return vec3(q.x, q.y * c - q.z * s, q.y * s + q.z * c) + vec3(0.0, pivot, 0.0);
}
float walkAngle(float part, float ph, float amp) {
  if (part < 0.5) return 0.0;
  float dir = (part == 1.0 || part == 3.0) ? 1.0 : -1.0;
  float reach = (part < 2.5) ? 0.62 : 0.40;
  return sin(ph) * amp * reach * dir;
}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
{
  float ang = walkAngle(aPart, aPhase.x, aPhase.y);
  if (abs(ang) > 0.0001) objectNormal = walkRot(objectNormal, 0.0, ang);
}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float ang = walkAngle(aPart, aPhase.x, aPhase.y);
  if (abs(ang) > 0.0001) transformed = walkRot(transformed, aPivotY, ang);
  transformed.y += (cos(aPhase.x * 2.0) * 0.021 - 0.021) * aPhase.y;
  transformed.x += sin(aPhase.x) * 0.012 * aPhase.y;
}`);
  };
  mat.customProgramCacheKey = () => 'traffic-walk-v1';
  return mat;
}

/* ------------------------------------------------------------ crowd ------ */

export class Crowd {
  constructor(ctx, graph, mats, rng, capacity = 700) {
    this.ctx = ctx;
    this.g = graph;
    this.mats = mats;
    this.rng = rng;
    this.cap = capacity;
    this.count = 0;

    this.alive = new Uint8Array(capacity);
    this.edge = new Int32Array(capacity).fill(-1);
    this.s = new Float32Array(capacity);
    this.dir = new Int8Array(capacity);
    this.speed = new Float32Array(capacity);
    this.phase = new Float32Array(capacity);
    this.wait = new Float32Array(capacity);
    this.lat = new Float32Array(capacity);
    this.scale = new Float32Array(capacity);
    this.prev = new Float32Array(capacity * 4);
    this.cur = new Float32Array(capacity * 4);
    this.moving = new Uint8Array(capacity);
    this.color = new Float32Array(capacity * 3);
    this.free = new Int32Array(capacity);
    this.freeN = capacity;
    for (let i = 0; i < capacity; i++) this.free[i] = capacity - 1 - i;

    this.ambient = new AmbientCrowd();
    this.visible = 0;
    this.ambientDrawn = 0;
    this._pickColors();
    this._build();
  }

  _pickColors() {
    const r = this.rng;
    const c = new THREE.Color();
    for (let i = 0; i < this.cap; i++) {
      const roll = r.next();
      const S = THREE.SRGBColorSpace;
      if (roll < 0.34) c.setHSL(r.range(0.55, 0.68), r.range(0.05, 0.25), r.range(0.16, 0.34), S);
      else if (roll < 0.55) c.setHSL(r.range(0.0, 1.0), r.range(0.0, 0.05), r.range(0.14, 0.28), S);
      else if (roll < 0.72) c.setHSL(r.range(0.05, 0.12), r.range(0.12, 0.36), r.range(0.30, 0.55), S);
      else if (roll < 0.86) c.setHSL(r.range(0.55, 0.66), r.range(0.30, 0.55), r.range(0.26, 0.44), S);
      else if (roll < 0.94) c.setHSL(r.range(0.97, 1.02) % 1, r.range(0.35, 0.6), r.range(0.28, 0.44), S);
      else c.setHSL(r.range(0.25, 0.42), r.range(0.20, 0.45), r.range(0.24, 0.40), S);
      this.color[i * 3] = c.r; this.color[i * 3 + 1] = c.g; this.color[i * 3 + 2] = c.b;
      this.scale[i] = r.range(0.93, 1.07);
      this.phase[i] = r.range(0, 6.283);
      this.speed[i] = WALK_SPEED[r.int(WALK_SPEED.length)] * r.range(0.9, 1.1);
      this.lat[i] = r.range(-0.72, 0.72);
    }
  }

  _build() {
    this.group = new THREE.Group();
    this.group.name = 'traffic:peds';
    this.ctx.group.add(this.group);
    this.meshes = [];
    const mat = this.mats.ped;
    patchWalk(mat);
    this.tiers = [];
    // Instance budget per tier. These are not the *agent* budget: the simulated
    // crowd and the stateless ambient crowd both write into these three batches,
    // so the whole city's people cost three draw calls no matter how many there
    // are. LOD2 is a 60-triangle figure, so a generous far cap is nearly free.
    const CAPS = [900, 1100, 1600];
    for (let lod = 0; lod < 3; lod++) {
      const g = buildPed(lod);
      const c = CAPS[lod];
      const im = new THREE.InstancedMesh(g, mat, c);
      im.name = `traffic:peds:${lod}`;
      im.count = 0;
      im.castShadow = lod === 0;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(c * 3), 3);
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      const ph = new THREE.InstancedBufferAttribute(new Float32Array(c * 2), 2);
      ph.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aPhase', ph);
      im.userData.phase = ph;
      this.group.add(im);
      this.meshes.push(im);
      this.tiers.push({ mesh: im, cap: c, count: 0, phase: ph });
    }
  }

  spawn(n) {
    const g = this.g;
    if (!g.edges.length) return 0;
    let made = 0;
    for (let k = 0; k < n && this.freeN > 0; k++) {
      const e = g.eCum ? g.pickEdge(this.rng.next())
        : (g.eKind[this.rng.int(g.edges.length)] === 1 ? -1 : this.rng.int(g.edges.length));
      if (e < 0 || g.eKind[e] === 1) continue;
      const i = this.free[--this.freeN];
      this.alive[i] = 1;
      this.edge[i] = e;
      this.s[i] = this.rng.range(0, g.eLen[e]);
      this.dir[i] = this.rng.bool() ? 1 : -1;
      this.wait[i] = 0;
      this.count++;
      made++;
      this._write(i, true);
    }
    return made;
  }

  despawn(n) {
    let removed = 0;
    for (let i = 0; i < this.cap && removed < n; i++) {
      if (!this.alive[i]) continue;
      this.alive[i] = 0; this.edge[i] = -1;
      this.free[this.freeN++] = i;
      this.count--; removed++;
    }
    return removed;
  }

  /** `gate(laneId)` returns true when a crossing guarded by that lane is safe. */
  step(dt, gate) {
    const g = this.g;
    if (!g.edges.length) return;
    this.prev.set(this.cur);
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const e = this.edge[i];
      const len = g.eLen[e];
      let s = this.s[i];
      const d = this.dir[i];

      // waiting at the kerb for a crossing?
      if (this.wait[i] > 0) {
        this.wait[i] -= dt;
        this.moving[i] = 0;
        this._write(i, false);
        continue;
      }

      const v = this.speed[i];
      s += v * d * dt;
      this.moving[i] = 1;
      this.phase[i] += v * dt * 3.4;
      if (this.phase[i] > 6.283185) this.phase[i] -= 6.283185;

      if (s > len || s < 0) {
        const at = s > len ? g.eB[e] : g.eA[e];
        const off = g.nodeEdgeOff[at], cnt = g.nodeEdgeOff[at + 1] - off;
        if (cnt === 0) { this.dir[i] = -d; this.s[i] = Math.max(0, Math.min(len, s)); this._write(i, false); continue; }
        // pick a continuation, preferring not to turn straight back
        let choice = -1;
        for (let attempt = 0; attempt < 5; attempt++) {
          const cand = g.nodeEdges[off + this.rng.int(cnt)];
          if (cand === e && cnt > 1) continue;
          choice = cand; break;
        }
        if (choice < 0) choice = g.nodeEdges[off];
        // a crossing needs a green pedestrian phase (= red for the vehicles)
        if (g.eKind[choice] === 1) {
          const guard = g.eGuard[choice];
          if (guard >= 0 && !gate(guard)) {
            // wait on the kerb rather than stepping into traffic
            this.wait[i] = 0.6 + this.rng.range(0, 0.8);
            this.s[i] = s > len ? len : 0;
            this.moving[i] = 0;
            this._write(i, false);
            continue;
          }
        }
        const fromA = g.eA[choice] === at;
        this.edge[i] = choice;
        this.dir[i] = fromA ? 1 : -1;
        this.s[i] = fromA ? 0 : g.eLen[choice];
      } else {
        this.s[i] = s;
      }
      this._write(i, false);
    }
  }

  _write(i, alsoPrev) {
    const e = this.edge[i];
    if (e < 0) return;
    const p = this.g.sample(e, this.s[i], _sp);
    const o = i * 4;
    const nx = -p.hz * this.dir[i], nz = p.hx * this.dir[i];
    this.cur[o] = p.x + nx * this.lat[i];
    this.cur[o + 1] = p.y;
    this.cur[o + 2] = p.z + nz * this.lat[i];
    this.cur[o + 3] = Math.atan2(p.hx * this.dir[i], p.hz * this.dir[i]);
    if (alsoPrev) {
      this.prev[o] = this.cur[o]; this.prev[o + 1] = this.cur[o + 1];
      this.prev[o + 2] = this.cur[o + 2]; this.prev[o + 3] = this.cur[o + 3];
    } else {
      // keep yaw on the same branch so a turn does not spin the figure
      const pv = this.prev[o + 3];
      let dd = this.cur[o + 3] - pv;
      while (dd > Math.PI) dd -= Math.PI * 2;
      while (dd < -Math.PI) dd += Math.PI * 2;
      this.cur[o + 3] = pv + dd;
    }
  }

  update(alpha, camera, simTime = 0) {
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    for (const t of this.tiers) t.count = 0;
    const m = _m4, q = _q, pos = _v3, sc = _v3b;
    const up = _up;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const o = i * 4;
      const px = this.prev[o] + (this.cur[o] - this.prev[o]) * alpha;
      const py = this.prev[o + 1] + (this.cur[o + 1] - this.prev[o + 1]) * alpha;
      const pz = this.prev[o + 2] + (this.cur[o + 2] - this.prev[o + 2]) * alpha;
      const yaw = this.prev[o + 3] + (this.cur[o + 3] - this.prev[o + 3]) * alpha;
      const dx = px - cx, dy = py - cy, dz = pz - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > PED_CULL2) continue;
      const lod = d2 < TIER0_2 ? 0 : (d2 < TIER1_2 ? 1 : 2);
      const t = this.tiers[lod];
      if (t.count >= t.cap) continue;
      const k = t.count++;
      pos.set(px, py, pz);
      q.setFromAxisAngle(up, yaw);
      sc.set(this.scale[i], this.scale[i], this.scale[i]);
      m.compose(pos, q, sc);
      t.mesh.setMatrixAt(k, m);
      t.mesh.instanceColor.setXYZ(k, this.color[i * 3], this.color[i * 3 + 1], this.color[i * 3 + 2]);
      t.phase.setXY(k, this.phase[i], this.moving[i] ? 1 : 0.06);
    }
    /* --- the ambient crowd fills the same three batches ------------------
     * Emitted nearest-cell-first so the remaining instance budget lands on the
     * pavement actually in shot rather than on a street behind the camera. */
    this.ambientDrawn = 0;
    if (this.ambient && this.ambient.count) {
      const self = this;
      this.ambient.emit(simTime, cx, cz, PED_CULL, (x, y, z, yaw, ph, amp, r, g, b, sc2) => {
        const ddx = x - cx, ddy = y - cy, ddz = z - cz;
        const dd = ddx * ddx + ddy * ddy + ddz * ddz;
        if (dd > PED_CULL2) return true;
        const lod = dd < TIER0_2 ? 0 : (dd < TIER1_2 ? 1 : 2);
        const t = self.tiers[lod];
        if (t.count >= t.cap) return lod !== 0;      // full near tier ends the walk
        const k = t.count++;
        pos.set(x, y, z);
        q.setFromAxisAngle(up, yaw);
        sc.set(sc2, sc2, sc2);
        m.compose(pos, q, sc);
        t.mesh.setMatrixAt(k, m);
        t.mesh.instanceColor.setXYZ(k, r, g, b);
        t.phase.setXY(k, ph, amp);
        self.ambientDrawn++;
        return true;
      });
    }

    let calls = 0;
    this.visible = 0;
    for (const t of this.tiers) {
      t.mesh.count = t.count;
      t.mesh.visible = t.count > 0;
      this.visible += t.count;
      if (t.count > 0) {
        t.mesh.instanceMatrix.needsUpdate = true;
        t.mesh.instanceColor.needsUpdate = true;
        t.phase.needsUpdate = true;
        calls++;
      }
    }
    this.drawn = calls;
  }

  dispose() {
    for (const m of this.meshes) { m.geometry.dispose(); m.dispose?.(); m.removeFromParent(); }
    this.meshes.length = 0;
    this.group?.removeFromParent();
  }
}

const _sp = { x: 0, y: 0, z: 0, hx: 1, hz: 0 };
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

export default { WalkGraph, Crowd, buildPed, patchWalk, CROSS_WAIT_MAX };
