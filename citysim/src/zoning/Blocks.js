/**
 * Block extraction — the faces of the planar road graph.
 *
 * The road network is a graph of cubic Beziers, not a planar subdivision, so
 * this file does the three things that turn one into the other:
 *
 *   1. flatten every segment to a polyline (arc-length sampled through the
 *      roads API, so curved streets stay curved),
 *   2. split every polyline at real geometric crossings that have no node
 *      (ramps and organic streets do cross without a junction),
 *   3. walk half-edges with the "next edge clockwise around the destination"
 *      rule, which enumerates every face exactly once. Interior faces come out
 *      CCW; the single largest face per connected component is the outer one
 *      and is discarded.
 *
 * Degree-1 vertices are pruned first: a dangling cul-de-sac would otherwise be
 * traversed in both directions and inject a zero-area spike into its face.
 */

import { area2, centroid, dedupe, simplifyTagged, makeCCW, bbox, perimeter } from './geom.js';

const KEY = (x, z) => `${Math.round(x * 4)},${Math.round(z * 4)}`;

/* ------------------------------------------------------------ flattening -- */

function flatten(roads, net) {
  const polys = new Map();
  for (const seg of net.segments.values()) {
    const L = seg.length || 0;
    if (!(L > 0.5)) continue;
    const n = Math.max(2, Math.min(64, Math.ceil(L / 6)));
    const pts = new Array(n + 1);
    const cum = new Float64Array(n + 1);
    let acc = 0;
    for (let i = 0; i <= n; i++) {
      const p = roads.pointAt(seg.id, i / n);
      pts[i] = [p.x, p.z];
      if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      cum[i] = acc;
    }
    polys.set(seg.id, { id: seg.id, cls: seg.class, a: seg.a, b: seg.b, pts, cum, length: acc || L });
  }
  return polys;
}

/* ------------------------------------------------- crossings without nodes -- */

function findCrossings(polys) {
  const CELL = 40;
  const buckets = new Map();
  const subs = [];
  for (const p of polys.values()) {
    for (let k = 0; k < p.pts.length - 1; k++) {
      const idx = subs.length;
      subs.push({ seg: p.id, k, a: p.pts[k], b: p.pts[k + 1] });
      const x0 = Math.min(p.pts[k][0], p.pts[k + 1][0]), x1 = Math.max(p.pts[k][0], p.pts[k + 1][0]);
      const z0 = Math.min(p.pts[k][1], p.pts[k + 1][1]), z1 = Math.max(p.pts[k][1], p.pts[k + 1][1]);
      for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
        for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
          const key = i + ',' + j;
          let arr = buckets.get(key);
          if (!arr) { arr = []; buckets.set(key, arr); }
          arr.push(idx);
        }
      }
    }
  }

  const splits = new Map();   // segId -> [{k, t, x, z}]
  const seen = new Set();
  const add = (segId, k, t, x, z) => {
    let arr = splits.get(segId);
    if (!arr) { arr = []; splits.set(segId, arr); }
    arr.push({ k, t, x, z });
  };

  for (const arr of buckets.values()) {
    for (let ii = 0; ii < arr.length; ii++) {
      for (let jj = ii + 1; jj < arr.length; jj++) {
        const A = subs[arr[ii]], B = subs[arr[jj]];
        if (A.seg === B.seg) continue;
        const pk = arr[ii] < arr[jj] ? arr[ii] + ':' + arr[jj] : arr[jj] + ':' + arr[ii];
        if (seen.has(pk)) continue;
        seen.add(pk);
        const X = properInt(A.a, A.b, B.a, B.b);
        if (!X) continue;
        add(A.seg, A.k, X.t, X.x, X.z);
        add(B.seg, B.k, X.u, X.x, X.z);
      }
    }
  }
  for (const arr of splits.values()) arr.sort((a, b) => (a.k - b.k) || (a.t - b.t));
  return splits;
}

function properInt(p, p2, q, q2) {
  const r0 = p2[0] - p[0], r1 = p2[1] - p[1];
  const s0 = q2[0] - q[0], s1 = q2[1] - q[1];
  const den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((q[0] - p[0]) * s1 - (q[1] - p[1]) * s0) / den;
  const u = ((q[0] - p[0]) * r1 - (q[1] - p[1]) * r0) / den;
  // endpoints touching is a shared node, not a crossing
  if (t <= 0.02 || t >= 0.98 || u <= 0.02 || u >= 0.98) return null;
  return { x: p[0] + r0 * t, z: p[1] + r1 * t, t, u };
}

/* ------------------------------------------------------------ the planar -- */

export function buildPlanar(roads, log) {
  const net = roads.network();
  if (!net || net.segments.size === 0) return null;

  const polys = flatten(roads, net);
  const splits = findCrossings(polys);

  const verts = [];
  const vindex = new Map();
  const vertOf = (x, z) => {
    const k = KEY(x, z);
    let i = vindex.get(k);
    if (i === undefined) { i = verts.length; verts.push({ x, z, he: [] }); vindex.set(k, i); }
    return i;
  };
  for (const n of net.nodes.values()) vertOf(n.pos[0], n.pos[2]);

  const edges = [];
  for (const p of polys.values()) {
    const cuts = splits.get(p.id) || [];
    // build the ordered list of break points along the polyline
    const marks = [{ k: 0, t: 0, x: p.pts[0][0], z: p.pts[0][1] }];
    for (const c of cuts) {
      const last = marks[marks.length - 1];
      if (c.k === last.k && Math.abs(c.t - last.t) < 1e-3) continue;
      marks.push(c);
    }
    const lastK = p.pts.length - 2;
    marks.push({ k: lastK, t: 1, x: p.pts[lastK + 1][0], z: p.pts[lastK + 1][1] });

    for (let m = 0; m < marks.length - 1; m++) {
      const A = marks[m], B = marks[m + 1];
      const pts = [[A.x, A.z]];
      for (let k = A.k + 1; k <= B.k; k++) pts.push([p.pts[k][0], p.pts[k][1]]);
      pts.push([B.x, B.z]);
      const clean = dedupe(pts, 0.15);
      if (clean.length < 2) continue;
      let len = 0;
      for (let i = 1; i < clean.length; i++) len += Math.hypot(clean[i][0] - clean[i - 1][0], clean[i][1] - clean[i - 1][1]);
      if (len < 1.0) continue;
      const v0 = vertOf(clean[0][0], clean[0][1]);
      const v1 = vertOf(clean[clean.length - 1][0], clean[clean.length - 1][1]);
      if (v0 === v1) continue;
      edges.push({ v0, v1, pts: clean, segmentId: p.id, cls: p.cls, dead: false, len });
    }
  }

  for (let i = 0; i < edges.length; i++) {
    verts[edges[i].v0].he.push(i * 2);
    verts[edges[i].v1].he.push(i * 2 + 1);
  }

  // prune dangling ends — they cannot bound a block
  let pruned = 0;
  for (let pass = 0; pass < 40; pass++) {
    let any = false;
    for (const v of verts) {
      const live = v.he.filter((h) => !edges[h >> 1].dead);
      if (live.length === 1) { edges[live[0] >> 1].dead = true; any = true; pruned++; }
    }
    if (!any) break;
  }

  log?.info?.(`planar graph: ${verts.length} vertices, ${edges.length} edges (${pruned} dangling pruned), ${splits.size} segment(s) split at crossings`);
  return { verts, edges, polys, net };
}

/* ------------------------------------------------------- face enumeration -- */

function departDir(edges, he) {
  const e = edges[he >> 1];
  const p = e.pts;
  const [a, b] = (he & 1) ? [p[p.length - 1], p[p.length - 2]] : [p[0], p[1]];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

export function extractFaces(planar, log) {
  const { verts, edges } = planar;

  for (const v of verts) {
    // v.he already holds only the half-edges that DEPART from v
    v.live = v.he.filter((h) => !edges[h >> 1].dead);
    v.live.sort((h1, h2) => departDir(edges, h1) - departDir(edges, h2));
    v.pos = new Map();
    v.live.forEach((h, i) => v.pos.set(h, i));
  }

  const originVert = (he) => ((he & 1) ? edges[he >> 1].v1 : edges[he >> 1].v0);

  const next = (he) => {
    const twin = he ^ 1;
    const v = verts[originVert(twin)];
    const m = v.live.length;
    if (!m) return -1;
    const p = v.pos.get(twin);
    if (p === undefined) return -1;
    return v.live[(p - 1 + m) % m];
  };

  const visited = new Uint8Array(edges.length * 2);
  const faces = [];
  for (let h0 = 0; h0 < edges.length * 2; h0++) {
    if (visited[h0] || edges[h0 >> 1].dead) continue;
    const loop = [];
    let h = h0, guard = 0;
    while (!visited[h] && guard++ < 20000) {
      visited[h] = 1;
      loop.push(h);
      const nh = next(h);
      if (nh < 0) break;
      h = nh;
      if (h === h0) break;
    }
    if (loop.length < 3) continue;
    faces.push(loop);
  }

  // Build geometry + tags for each face, then drop the outer face per component.
  const built = [];
  for (const loop of faces) {
    const pts = [], tags = [];
    for (const he of loop) {
      const e = edges[he >> 1];
      const p = (he & 1) ? e.pts.slice().reverse() : e.pts;
      const tag = { segmentId: e.segmentId, cls: e.cls };
      for (let i = 0; i < p.length - 1; i++) { pts.push([p[i][0], p[i][1]]); tags.push(tag); }
    }
    if (pts.length < 3) continue;
    const a = area2(pts);
    built.push({ pts, tags, signed: a, comp: componentOf(planar, loop[0]) });
  }

  // one outer face per connected component: the one with the largest |area|
  const maxByComp = new Map();
  for (const f of built) {
    const cur = maxByComp.get(f.comp);
    if (!cur || Math.abs(f.signed) > Math.abs(cur.signed)) maxByComp.set(f.comp, f);
  }
  const outer = new Set([...maxByComp.values()]);

  const out = built.filter((f) => !outer.has(f) && f.signed > 0);
  log?.info?.(`faces: ${built.length} traversed, ${outer.size} outer discarded, ${out.length} candidate blocks`);
  return out;
}

/** Union-find over edges so multi-component networks each drop their own outer face. */
function componentOf(planar, he) {
  if (!planar._comp) {
    const { verts, edges } = planar;
    const parent = new Int32Array(verts.length);
    for (let i = 0; i < verts.length; i++) parent[i] = i;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (const e of edges) { if (e.dead) continue; const ra = find(e.v0), rb = find(e.v1); if (ra !== rb) parent[ra] = rb; }
    planar._comp = { find };
  }
  const e = planar.edges[he >> 1];
  return planar._comp.find(e.v0);
}

/* --------------------------------------------------------------- blocks --- */

/**
 * Faces → clean, tagged, CCW block polygons with per-edge road metadata.
 * @returns array of `{id, poly, tags, area, perimeter, centroid, bbox, classes}`
 */
export function extractBlocks(roads, opts = {}, log = null) {
  const {
    minArea = 420,
    maxArea = 260000,
    simplifyEps = 0.45,
  } = opts;

  const planar = buildPlanar(roads, log);
  if (!planar) return { blocks: [], planar: null };

  const net = planar.net;
  const layouts = new Map();
  const layout = (cls) => {
    let l = layouts.get(cls);
    if (!l) { l = net.laneLayout(cls) || { half: 5, sidewalk: 2 }; layouts.set(cls, l); }
    return l;
  };

  const faces = extractFaces(planar, log);
  const blocks = [];
  let id = 1;
  let rejected = 0;

  for (const f of faces) {
    let { pts, tags } = f;
    ({ pts, tags } = makeCCW(pts, tags));
    ({ pts, tags } = simplifyTagged(pts, tags, simplifyEps));
    if (pts.length < 3) { rejected++; continue; }
    const A = area2(pts);
    if (A < minArea || A > maxArea) { rejected++; continue; }
    const P = perimeter(pts);
    // a face whose perimeter is wildly out of proportion with its area is a
    // sliver between two near-parallel roads, not a block
    if (P * P / Math.max(A, 1) > 260) { rejected++; continue; }

    const classes = new Set();
    const roadDist = new Array(tags.length);
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      classes.add(t.cls);
      const l = layout(t.cls);
      roadDist[i] = l.half + (l.sidewalk || 0);
    }

    blocks.push({
      id: id++,
      poly: pts,
      tags,
      roadDist,
      area: A,
      perimeter: P,
      centroid: centroid(pts),
      bbox: bbox(pts),
      classes: [...classes],
    });
  }

  log?.info?.(`blocks: ${blocks.length} kept, ${rejected} rejected (area/shape)`);
  return { blocks, planar };
}

export default extractBlocks;
