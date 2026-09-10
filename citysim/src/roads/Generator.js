import { hermiteCurve, arcCurve, straightCurve } from './RoadGraph.js';

/**
 * Procedural network generation. Everything here is seeded and deterministic —
 * the only randomness comes from the `rng` passed in (ctx.rng, derived per module).
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Terrain gradient at (x,z), metres per metre. */
function gradient(net, x, z, eps = 6) {
  const hL = net.groundAt(x - eps, z), hR = net.groundAt(x + eps, z);
  const hD = net.groundAt(x, z - eps), hU = net.groundAt(x, z + eps);
  return { gx: (hR - hL) / (2 * eps), gz: (hU - hD) / (2 * eps) };
}

function slope(net, x, z) {
  const g = gradient(net, x, z);
  return Math.hypot(g.gx, g.gz);
}

/** Is this a place a road may exist? */
export function buildable(net, x, z, maxSlope = 0.30) {
  const water = net.waterLevel ?? 0;
  const h = net.groundAt(x, z);
  if (h < water + 0.8) return false;
  return slope(net, x, z) <= maxSlope;
}

/* ------------------------------------------------------------- the grid --- */

/**
 * Downtown lattice + arterials + a highway to the north + an organic
 * residential fringe. Returns a small report.
 */
export function generateGrid(net, rng, opts = {}) {
  const o = {
    cx: 0, cz: 0,
    cols: 7, rows: 7,
    blockW: 90, blockH: 70,
    highway: true, ramp: true, organic: true, alleys: true,
    maxSlope: 0.30,
    ...opts,
  };

  net.begin();

  const xs = [], zs = [];
  for (let i = 0; i < o.cols; i++) xs.push(o.cx + (i - (o.cols - 1) / 2) * o.blockW);
  for (let j = 0; j < o.rows; j++) zs.push(o.cz + (j - (o.rows - 1) / 2) * o.blockH);

  const mid = (n) => (n - 1) / 2;
  const rankX = (i) => (i === mid(o.cols) ? 'boulevard' : (Math.abs(i - mid(o.cols)) === 2 ? 'lane4' : 'lane2'));
  const rankZ = (j) => (j === mid(o.rows) ? 'boulevard' : (Math.abs(j - mid(o.rows)) === 2 ? 'lane4' : 'lane2'));

  // --- lattice nodes -------------------------------------------------------
  const ids = [];
  for (let j = 0; j < o.rows; j++) {
    ids.push([]);
    for (let i = 0; i < o.cols; i++) {
      const x = xs[i], z = zs[j];
      ids[j].push(buildable(net, x, z, o.maxSlope + 0.12) ? net.addNode([x, 0, z], 'junction') : null);
    }
  }

  // --- lattice segments ----------------------------------------------------
  const strongest = (a, b) => {
    const rank = { alley: 0, lane2: 1, lane4: 2, boulevard: 3, highway: 4 };
    return rank[a] >= rank[b] ? a : b;
  };
  for (let j = 0; j < o.rows; j++) {
    for (let i = 0; i < o.cols - 1; i++) {
      if (ids[j][i] === null || ids[j][i + 1] === null) continue;
      net.addSegment(ids[j][i], ids[j][i + 1], rankZ(j));
    }
  }
  for (let i = 0; i < o.cols; i++) {
    for (let j = 0; j < o.rows - 1; j++) {
      if (ids[j][i] === null || ids[j + 1][i] === null) continue;
      net.addSegment(ids[j][i], ids[j + 1][i], rankX(i));
    }
  }
  void strongest;

  // --- mid-block alleys ----------------------------------------------------
  if (o.alleys) {
    const picks = [];
    for (let j = 0; j < o.rows - 1; j++) {
      for (let i = 0; i < o.cols - 1; i++) {
        if (rankZ(j) === 'boulevard' || rankZ(j + 1) === 'boulevard') continue;
        picks.push([i, j]);
      }
    }
    rng.shuffle(picks);
    for (const [i, j] of picks.slice(0, Math.min(7, picks.length))) {
      const top = findSegment(net, ids[j][i], ids[j][i + 1]);
      const bot = findSegment(net, ids[j + 1][i], ids[j + 1][i + 1]);
      if (!top || !bot) continue;
      const t = 0.4 + rng.next() * 0.2;
      const a = net.splitSegment(top, t);
      const b = net.splitSegment(bot, t);
      if (a && b) net.addSegment(a.node, b.node, 'alley');
    }
  }

  // --- highway sweeping across the north -----------------------------------
  let highwayNodes = [];
  if (o.highway) {
    const zBase = zs[0] - 118;
    const span = (o.cols - 1) * o.blockW * 0.82;
    const pts = [];
    const N = 6;
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const x = o.cx - span + t * span * 2;
      const z = zBase + Math.sin(t * Math.PI * 1.15 - 0.35) * 46 - 14;
      pts.push([x, 0, z]);
    }
    // Nothing in this module builds bridges, so a highway must not be laid
    // across water: nudge each control point onto buildable ground, and if a
    // stretch cannot be rescued, keep only the longest buildable run rather
    // than floating a carriageway over a river.
    highwayNodes = chain(net, longestBuildableRun(net, pts.map((p) => nudgeToLand(net, p, o.maxSlope))), 'highway', { smooth: true });
  }

  // --- on/off ramp from the highway down onto the central boulevard --------
  if (o.highway && o.ramp && highwayNodes.length > 3) {
    const hIdx = Math.round(highwayNodes.length * 0.62);
    const hn = net.node(highwayNodes[clamp(hIdx, 1, highwayNodes.length - 2)]);
    const target = ids[0][Math.round(mid(o.cols))];
    if (hn && target !== null) {
      const tn = net.node(target);
      const dirH = normalise([1, 0.12]);
      const dirT = normalise([0, 1]);
      const mx = (hn.pos[0] + tn.pos[0]) / 2 + 42;
      const mz = (hn.pos[2] + tn.pos[2]) / 2 - 6;
      const mNode = net.addNode([mx, 0, mz], 'junction');
      net.addSegment(hn.id, mNode, 'lane4',
        hermiteCurve(hn.pos, [mx, 0, mz], dirH, normalise([0.15, 1]), 0.55));
      net.addSegment(mNode, target, 'lane4',
        hermiteCurve([mx, 0, mz], tn.pos, normalise([0.15, 1]), dirT, 0.55));
    }
  }

  // --- organic residential fringe ------------------------------------------
  if (o.organic) {
    const seeds = [];
    const outward = [
      { j: 0, dz: -1 }, { j: o.rows - 1, dz: 1 },
    ];
    for (const e of outward) {
      for (let i = 0; i < o.cols; i++) {
        if (ids[e.j][i] === null) continue;
        if (rankX(i) === 'boulevard') continue;
        if (o.highway && e.dz < 0) continue;         // don't grow into the highway
        seeds.push({ node: ids[e.j][i], dir: [0, e.dz] });
      }
    }
    for (const i of [0, o.cols - 1]) {
      const dx = i === 0 ? -1 : 1;
      for (let j = 0; j < o.rows; j++) {
        if (ids[j][i] === null) continue;
        if (rankZ(j) === 'boulevard') continue;
        seeds.push({ node: ids[j][i], dir: [dx, 0] });
      }
    }
    rng.shuffle(seeds);
    generateOrganic(net, rng, {
      seeds: seeds.slice(0, 14),
      steps: 5,
      stepLen: 62,
      cls: 'lane2',
      branchChance: 0.34,
      bounds: {
        minX: xs[0] - 300, maxX: xs[o.cols - 1] + 300,
        minZ: zs[0] - 240, maxZ: zs[o.rows - 1] + 300,
      },
      maxSlope: o.maxSlope,
    });
  }

  net.end();
  return { lattice: ids, xs, zs, highway: highwayNodes, stats: net.stats() };
}


/** Slide a point along +/-z until it stands on buildable ground. */
function nudgeToLand(net, p, maxSlope = 0.34) {
  if (buildable(net, p[0], p[2], maxSlope)) return p;
  for (let d = 14; d <= 140; d += 14) {
    for (const s of [-1, 1]) {
      const z = p[2] + s * d;
      if (buildable(net, p[0], z, maxSlope)) return [p[0], 0, z];
    }
  }
  return null;
}

/** Longest contiguous run of non-null points. */
function longestBuildableRun(net, pts) {
  let best = [], cur = [];
  for (const p of pts) {
    if (p) { cur.push(p); if (cur.length > best.length) best = cur; }
    else cur = [];
  }
  return best.length >= 2 ? best : pts.filter(Boolean);
}

function findSegment(net, a, b) {
  if (a === null || b === null) return null;
  const na = net.node(a);
  if (!na) return null;
  for (const sid of na.edges) {
    const s = net.segment(sid);
    if (s && (s.a === b || s.b === b)) return sid;
  }
  return null;
}

function normalise(v) {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/** Connect a polyline of points with smoothly-joined Bezier segments. */
export function chain(net, pts, cls, { smooth = true, loop = false } = {}) {
  const nodes = pts.map((p) => net.nodeAt(p, 6, 'junction'));
  const dirs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    dirs.push(normalise([b[0] - a[0], b[2] - a[2]]));
  }
  const n = pts.length;
  const last = loop ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = nodes[i], b = nodes[(i + 1) % n];
    if (a === b) continue;
    const pa = net.node(a).pos, pb = net.node(b).pos;
    const curve = smooth
      ? hermiteCurve(pa, pb, dirs[i], dirs[(i + 1) % n], 0.34)
      : straightCurve(pa, pb);
    net.addSegment(a, b, cls, curve);
  }
  return nodes;
}

/* ---------------------------------------------------------- organic net --- */

/**
 * Growth-based residential streets. Branches bend to follow terrain contours,
 * refuse to climb steep ground or enter water, and snap onto existing nodes.
 */
export function generateOrganic(net, rng, opts = {}) {
  const o = {
    seeds: null,
    origin: [0, 0, 0],
    steps: 6,
    stepLen: 58,
    cls: 'lane2',
    minorCls: 'alley',
    branchChance: 0.3,
    snapRadius: 26,
    maxSlope: 0.30,
    wander: 0.42,
    bounds: { minX: -900, maxX: 900, minZ: -900, maxZ: 900 },
    ...opts,
  };

  net.begin();

  const frontier = [];
  if (o.seeds && o.seeds.length) {
    for (const s of o.seeds) {
      const nodeId = s.node !== undefined ? s.node : net.addNode(s.pos, 'junction');
      frontier.push({ node: nodeId, dir: normalise(s.dir || [1, 0]), depth: 0, cls: o.cls });
    }
  } else {
    const root = net.nodeAt(o.origin, 6, 'junction');
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + rng.next() * 0.4;
      frontier.push({ node: root, dir: [Math.cos(a), Math.sin(a)], depth: 0, cls: o.cls });
    }
  }

  const inBounds = (x, z) => x > o.bounds.minX && x < o.bounds.maxX && z > o.bounds.minZ && z < o.bounds.maxZ;
  let guard = 0;
  const created = [];

  while (frontier.length && guard++ < 900) {
    const f = frontier.shift();
    if (f.depth >= o.steps) continue;
    const from = net.node(f.node);
    if (!from) continue;

    // steer: wander a little, then bend toward the local contour if it is steep
    let ang = Math.atan2(f.dir[1], f.dir[0]) + rng.gauss(0, o.wander * 0.34);
    const g = gradient(net, from.pos[0], from.pos[2]);
    const steep = Math.hypot(g.gx, g.gz);
    if (steep > 0.05) {
      const contour = [-g.gz, g.gx];
      const cl = Math.hypot(contour[0], contour[1]) || 1;
      let cx = contour[0] / cl, cz = contour[1] / cl;
      if (cx * Math.cos(ang) + cz * Math.sin(ang) < 0) { cx = -cx; cz = -cz; }
      const w = clamp(steep * 3.4, 0, 0.72);
      const tx = Math.cos(ang) * (1 - w) + cx * w;
      const tz = Math.sin(ang) * (1 - w) + cz * w;
      ang = Math.atan2(tz, tx);
    }

    const len = o.stepLen * (0.78 + rng.next() * 0.5);
    let nx = from.pos[0] + Math.cos(ang) * len;
    let nz = from.pos[2] + Math.sin(ang) * len;

    if (!inBounds(nx, nz)) continue;
    if (!buildable(net, nx, nz, o.maxSlope)) {
      // one retry, steered harder along the contour
      ang += rng.sign() * 0.9;
      nx = from.pos[0] + Math.cos(ang) * len * 0.8;
      nz = from.pos[2] + Math.sin(ang) * len * 0.8;
      if (!inBounds(nx, nz) || !buildable(net, nx, nz, o.maxSlope)) continue;
    }

    const dir = [Math.cos(ang), Math.sin(ang)];
    const snap = net.snapToExisting([nx, 0, nz], o.snapRadius);
    const target = snap !== null && snap !== f.node ? snap : net.addNode([nx, 0, nz], 'junction');
    const tp = net.node(target).pos;

    const seg = net.addSegment(f.node, target, f.cls,
      hermiteCurve(from.pos, tp, f.dir, dir, 0.36));
    if (seg) created.push(seg);

    if (snap === null || snap === f.node) {
      frontier.push({ node: target, dir, depth: f.depth + 1, cls: f.cls });
      if (rng.next() < o.branchChance && f.depth < o.steps - 1) {
        const s = rng.sign();
        const ba = ang + s * (Math.PI / 2 + rng.gauss(0, 0.22));
        frontier.push({
          node: target,
          dir: [Math.cos(ba), Math.sin(ba)],
          depth: f.depth + 2,
          cls: rng.next() < 0.35 ? o.minorCls : f.cls,
        });
      }
    }
  }

  net.end();
  return { created };
}

/* ---------------------------------------------- purpose-built showpieces --- */

/** A single generous 4-way junction: boulevard crossing a 4-lane avenue. */
export function buildIntersection(net, opts = {}) {
  const o = { arm: 105, mainCls: 'boulevard', crossCls: 'lane4', ...opts };
  net.begin();
  const c = net.addNode([0, 0, 0], 'junction');
  const e = net.addNode([o.arm, 0, 0], 'junction');
  const w = net.addNode([-o.arm, 0, 0], 'junction');
  const n = net.addNode([0, 0, -o.arm], 'junction');
  const s = net.addNode([0, 0, o.arm], 'junction');
  net.addSegment(c, e, o.mainCls);
  net.addSegment(c, w, o.mainCls);
  net.addSegment(c, n, o.crossCls);
  net.addSegment(c, s, o.crossCls);
  // side streets hanging off the arms so the shot has depth
  const e2 = net.addNode([o.arm, 0, -68], 'junction');
  const w2 = net.addNode([-o.arm, 0, 68], 'junction');
  net.addSegment(e, e2, 'lane2');
  net.addSegment(w, w2, 'lane2');
  const n2 = net.addNode([74, 0, -o.arm], 'junction');
  net.addSegment(n, n2, 'lane2');
  net.end();
  return { centre: c };
}

/** A long curved highway with a widening merge lane. */
export function buildHighway(net, rng, opts = {}) {
  const o = { length: 720, amp: 130, ...opts };
  net.begin();
  const wave = (t) => Math.sin(t * Math.PI * 1.5 - 0.55) * o.amp;
  // run the sweep THROUGH the origin so the camera presets frame it
  const z0 = wave(0.5);
  const pts = [];
  const N = 9;
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    pts.push([-o.length / 2 + t * o.length, 0, wave(t) - z0]);
  }
  const nodes = chain(net, pts, 'highway', { smooth: true });

  // slip road merging in from the south-east
  const j = Math.round(N * 0.62);
  const host = net.node(nodes[j]);
  if (host) {
    const dir = normalise([1, 0.2]);
    const a = [host.pos[0] - 240, 0, host.pos[2] + 150];
    const b = [host.pos[0] - 70, 0, host.pos[2] + 34];
    const na = net.addNode(a, 'junction');
    const nb = net.addNode(b, 'junction');
    net.addSegment(na, nb, 'lane4', hermiteCurve(a, b, normalise([1, -0.35]), normalise([1, -0.55]), 0.5));
    net.addSegment(nb, host.id, 'lane4', hermiteCurve(b, host.pos, normalise([1, -0.55]), dir, 0.55));
  }
  net.end();
  return { nodes };
}

export default { generateGrid, generateOrganic, buildIntersection, buildHighway, chain, buildable };
