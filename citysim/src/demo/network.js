/**
 * Turning the plan into a road network, through the `roads` module's public
 * API only (`generateGrid` to clear, `addNode`/`addSegment` to lay, and one
 * final `generateOrganic` which re-samples every node onto the ground and
 * rebuilds the meshes).
 *
 * Nothing here reaches into another module's internals: the Bezier control
 * points are built locally, because `roads.addSegment(a, b, cls, curve)` takes
 * a plain `[[x,y,z] × 4]` array.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ------------------------------------------------------------- geometry -- */

function unit(dx, dz) {
  const L = Math.hypot(dx, dz) || 1;
  return [dx / L, dz / L];
}

/** Cubic control points leaving `a` along `da` and arriving at `b` along `db`. */
function hermite(a, b, da, db, tension = 0.36) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) * tension;
  return [
    [a[0], 0, a[1]],
    [a[0] + da[0] * L, 0, a[1] + da[1] * L],
    [b[0] - db[0] * L, 0, b[1] - db[1] * L],
    [b[0], 0, b[1]],
  ];
}

/* ---------------------------------------------------------------- laying -- */

export class Layer {
  constructor(ctx, site) {
    this.ctx = ctx;
    this.roads = ctx.get('roads');
    this.site = site;
    this.pos = new Map();          // nodeId -> [x,z]
    this.count = { nodes: 0, segments: 0, skipped: 0 };
  }

  ok() { return !!(this.roads && this.roads.addSegment && this.roads.addNode); }

  /**
   * Nothing in `roads` builds bridges, and its elevation profile is clamped to
   * the ground, so a segment whose span crosses water is drawn as a ribbon of
   * asphalt lying in the river. Refuse those spans outright.
   */
  spanOk(pa, pb, maxSlope = 0.95) {
    if (!this.site) return true;
    const n = Math.max(3, Math.ceil(Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / 12));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = pa[0] + (pb[0] - pa[0]) * t, z = pa[1] + (pb[1] - pa[1]) * t;
      if (this.site.isWater(x, z)) return false;
      if (this.site.heightAt(x, z) < this.site.water + 0.8) return false;
      // only a genuine cliff is rejected: `roads` clamps the running gradient
      // itself, so a merely steep hillside is its problem, not ours
      if (this.site.slopeAt(x, z) > maxSlope) return false;
    }
    return true;
  }

  node(x, z, type = 'junction') {
    const id = this.roads.addNode([x, 0, z], type);
    if (id !== null && id !== undefined) { this.pos.set(id, [x, z]); this.count.nodes++; }
    return id;
  }

  seg(a, b, cls, curve = null) {
    if (a === null || b === null || a === undefined || b === undefined || a === b) return null;
    const id = this.roads.addSegment(a, b, cls, curve);
    if (id !== null && id !== undefined) this.count.segments++;
    return id;
  }

  /**
   * Join a run of nodes with smoothly-continuous curves. Straight runs stay
   * straight (the tangent is the chord), bent ones get a real fillet.
   */
  chain(ids, cls, { loop = false, tension = 0.34 } = {}) {
    const out = [];
    const pts = ids.map((i) => this.pos.get(i));
    const n = ids.length;
    if (n < 2) return out;
    const dirs = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      dirs.push(unit(b[0] - a[0], b[1] - a[1]));
    }
    const last = loop ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = ids[i], b = ids[(i + 1) % n];
      const pa = pts[i], pb = pts[(i + 1) % n];
      if (!this.spanOk(pa, pb)) { out.push(null); this.count.skipped++; continue; }
      const straight = Math.abs(dirs[i][0] * dirs[(i + 1) % n][0] + dirs[i][1] * dirs[(i + 1) % n][1]) > 0.9995;
      const curve = straight ? null : hermite(pa, pb, dirs[i], dirs[(i + 1) % n], tension);
      const id = this.seg(a, b, cls, curve);
      out.push(id);
    }
    return out;
  }

  /** Straight-line join with explicit end tangents. */
  link(a, b, cls, da = null, db = null, tension = 0.4) {
    const pa = this.pos.get(a), pb = this.pos.get(b);
    if (!pa || !pb) return null;
    if (!this.spanOk(pa, pb)) { this.count.skipped++; return null; }
    const chord = unit(pb[0] - pa[0], pb[1] - pa[1]);
    const curve = (da || db) ? hermite(pa, pb, da || chord, db || chord, tension) : null;
    return this.seg(a, b, cls, curve);
  }
}

/* ------------------------------------------------------------ the build --- */

/**
 * @returns {{lattice, quay, highway, ramps, counts, fringe}}
 */
export function layNetwork(ctx, plan, site, rng, log) {
  const L = new Layer(ctx, site);
  if (!L.ok()) { log?.warn?.('roads module unavailable — no network laid'); return null; }

  // Clear the existing network through the public generator (cols/rows 0 lays
  // nothing but still runs the module's own clear + version bump).
  try {
    L.roads.generateGrid({ cols: 0, rows: 0, highway: false, ramp: false, organic: false, alleys: false });
  } catch (err) { log?.warn?.('clear failed:', err.message); }

  const { us, vs, uMid, toWorld } = plan;

  /* --------------------------------------------------------- 1. lattice -- */
  const grid = [];                       // grid[j][i]
  const coreDist = (x, z) => Math.hypot(x - plan.core[0], z - plan.core[1]);
  for (let j = 0; j < vs.length; j++) {
    grid.push([]);
    for (let i = 0; i < us.length; i++) {
      // jitter grows with distance from downtown: a CBD is surveyed, a suburb
      // grew
      const p0 = toWorld(us[i], vs[j]);
      const wob = clamp(coreDist(p0[0], p0[1]) / 460, 0, 1) ** 1.4 * 9;
      const x = p0[0] + rng.range(-wob, wob);
      const z = p0[1] + rng.range(-wob, wob);
      const good = site.buildable(x, z, 0.26) && !site.isWater(x, z);
      grid[j].push(good ? L.node(x, z) : null);
      if (good) L.count.lattice = (L.count.lattice || 0) + 1;
      else L.count.latticeCulled = (L.count.latticeCulled || 0) + 1;
    }
  }

  // rows (streets, running along the shore)
  const rowSegs = [];
  for (let j = 0; j < vs.length; j++) {
    rowSegs.push([]);
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        const ids = L.chain(run.map((r) => r.id), plan.vClass(j));
        for (let k = 0; k < ids.length; k++) rowSegs[j][run[k].i] = ids[k];
      }
      run = [];
    };
    for (let i = 0; i < us.length; i++) {
      const id = grid[j][i];
      if (id === null) flush(); else run.push({ id, i });
    }
    flush();
  }

  // columns (avenues, running inland)
  const colSegs = [];
  for (let i = 0; i < us.length; i++) {
    colSegs.push([]);
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        const ids = L.chain(run.map((r) => r.id), plan.uClass(i));
        for (let k = 0; k < ids.length; k++) colSegs[i][run[k].j] = ids[k];
      }
      run = [];
    };
    for (let j = 0; j < vs.length; j++) {
      const id = grid[j][i];
      if (id === null) flush(); else run.push({ id, j });
    }
    flush();
  }

  /* ------------------------------------------------------------ 2. quay -- */
  const quayIds = [];
  for (const p of plan.quay) {
    if (!site.buildable(p[0], p[1], 0.30)) { quayIds.push(null); continue; }
    quayIds.push(L.node(p[0], p[1]));
  }
  // chain the contiguous runs
  {
    let run = [];
    const flush = () => { if (run.length > 1) L.chain(run, 'lane4', { tension: 0.32 }); run = []; };
    for (const id of quayIds) { if (id === null) flush(); else run.push(id); }
    flush();
  }

  /* -------------------------------------- 3. avenues meet the waterfront -- */
  const quayReal = quayIds.filter((q) => q !== null);
  for (let i = 0; i < us.length; i++) {
    // the node at the water end of this avenue
    let head = null;
    for (let j = 0; j < vs.length; j++) if (grid[j][i] !== null) { head = grid[j][i]; break; }
    if (head === null) continue;
    const ph = L.pos.get(head);
    let best = null, bd = Infinity;
    for (const q of quayReal) {
      const pq = L.pos.get(q);
      const d = Math.hypot(pq[0] - ph[0], pq[1] - ph[1]);
      if (d < bd) { bd = d; best = q; }
    }
    if (best === null || bd > 165 || bd < 26) continue;
    const inward = plan.v;
    L.link(head, best, plan.uClass(i), [-inward[0], -inward[1]], null, 0.42);
  }

  /* --------------------------------------------------------- 4. highway -- */
  const hwIds = [];
  for (const p of plan.highway) {
    hwIds.push(site.buildable(p[0], p[1], 0.42) ? L.node(p[0], p[1], 'highway') : null);
  }
  L.count.highwayNodes = hwIds.filter((h) => h !== null).length;
  {
    let run = [];
    const flush = () => { if (run.length > 1) L.chain(run, 'highway', { tension: 0.42 }); run = []; };
    for (const id of hwIds) { if (id === null) flush(); else run.push(id); }
    flush();
  }

  /* ------------------------------------------------------------ 5. ramps -- */
  const ramps = [];
  const hwReal = hwIds.filter((h) => h !== null);
  if (hwReal.length > 4) {
    // ramp onto the boulevard's inland end, and onto one flanking arterial
    const candidates = [];
    for (let i = 0; i < us.length; i++) {
      const cls = plan.uClass(i);
      if (cls === 'lane2') continue;
      let tail = null;
      for (let j = vs.length - 1; j >= 0; j--) if (grid[j][i] !== null) { tail = grid[j][i]; break; }
      if (tail !== null) candidates.push({ tail, i, cls });
    }
    candidates.sort((a, b) => Math.abs(a.i - uMid) - Math.abs(b.i - uMid));
    for (const c of candidates.slice(0, 3)) {
      const pt = L.pos.get(c.tail);
      let best = null, bd = Infinity;
      for (const h of hwReal) {
        const ph = L.pos.get(h);
        const d = Math.hypot(ph[0] - pt[0], ph[1] - pt[1]);
        if (d < bd) { bd = d; best = h; }
      }
      if (best === null || bd > 340 || bd < 30) continue;
      const ph = L.pos.get(best);
      // a real ramp curves: leave the arterial heading inland, arrive tangent
      // to the highway
      const inward = plan.v;
      const hi = hwReal.indexOf(best);
      const pa = L.pos.get(hwReal[Math.max(0, hi - 1)]);
      const pb = L.pos.get(hwReal[Math.min(hwReal.length - 1, hi + 1)]);
      const tan = unit(pb[0] - pa[0], pb[1] - pa[1]);
      const mid = [(pt[0] + ph[0]) / 2 + tan[0] * 26, (pt[1] + ph[1]) / 2 + tan[1] * 26];
      if (!site.buildable(mid[0], mid[1], 0.32)) continue;
      const m = L.node(mid[0], mid[1]);
      L.link(c.tail, m, 'lane4', inward, tan, 0.5);
      L.link(m, best, 'lane4', tan, tan, 0.5);
      ramps.push(m);
    }
  }

  /* ---------------------------------------------------------- 6. alleys -- */
  // Mid-block service alleys, downtown only — they are what stops a CBD block
  // looking like a single extruded slab.
  {
    const picks = [];
    for (let j = 0; j < vs.length - 1; j++) {
      for (let i = 0; i < us.length - 1; i++) {
        if (!rowSegs[j][i] || !rowSegs[j + 1][i]) continue;
        if (plan.vClass(j) === 'boulevard') continue;
        picks.push([i, j]);
      }
    }
    rng.shuffle(picks);
    // Frontage is what a city is made of: a mid-block service alley doubles the
    // street edge of the block it splits, and that is the cheapest density there
    // is. Downtown gets most of them.
    for (const [i, j] of picks.slice(0, Math.min(14, picks.length))) {
      const top = rowSegs[j][i], bot = rowSegs[j + 1][i];
      if (!top || !bot) continue;
      const t = 0.42 + rng.next() * 0.16;
      let a = null, b = null;
      try { a = L.roads.splitSegment(top, t); b = L.roads.splitSegment(bot, t); } catch { /* fine */ }
      if (!a || !b) continue;
      const na = L.roads.network().nodes.get(a.node);
      const nb = L.roads.network().nodes.get(b.node);
      if (na) L.pos.set(a.node, [na.pos[0], na.pos[2]]);
      if (nb) L.pos.set(b.node, [nb.pos[0], nb.pos[2]]);
      // splitting invalidates the row's segment ids
      rowSegs[j][i] = a.b; rowSegs[j + 1][i] = b.b;
      L.seg(a.node, b.node, 'alley');
    }
  }

  /* --------------------------------------------- 7. organic hill fringe --- */
  // Seeds: fringe nodes on the land side that still have room to grow. The
  // generator itself bends the lanes along the contours and refuses to climb.
  const seeds = [];
  const pushSeed = (id, dir) => {
    const p = L.pos.get(id);
    if (!p) return;
    seeds.push({ node: id, dir });
  };
  for (let i = 0; i < us.length; i++) {
    let tail = null;
    for (let j = vs.length - 1; j >= 0; j--) if (grid[j][i] !== null) { tail = grid[j][i]; break; }
    if (tail !== null && plan.uClass(i) === 'lane2') pushSeed(tail, [plan.v[0], plan.v[1]]);
  }
  for (let j = 2; j < vs.length; j++) {
    const left = grid[j].find((x) => x !== null);
    const right = [...grid[j]].reverse().find((x) => x !== null);
    if (left) pushSeed(left, [-plan.u[0], -plan.u[1]]);
    if (right && right !== left) pushSeed(right, [plan.u[0], plan.u[1]]);
  }
  rng.shuffle(seeds);

  const bb = site.basin.bbox;
  try {
    L.roads.generateOrganic({
      seeds: seeds.slice(0, 14),
      steps: 3,
      stepLen: 58,
      cls: 'lane2',
      minorCls: 'alley',
      branchChance: 0.38,
      snapRadius: 30,
      maxSlope: 0.235,
      wander: 0.46,
      bounds: {
        minX: bb.x0 - 170, maxX: bb.x1 + 170,
        minZ: bb.z0 - 170, maxZ: bb.z1 + 170,
      },
    });
  } catch (err) {
    log?.warn?.('organic fringe failed:', err.message);
    try { L.roads.rebuildMeshes(); } catch { /* ignore */ }
  }

  return {
    grid, rowSegs, colSegs,
    quay: quayReal.map((q) => L.pos.get(q)),
    highway: hwReal.map((h) => L.pos.get(h)),
    ramps: ramps.map((m) => L.pos.get(m)),
    counts: L.count,
    layer: L,
  };
}

export default layNetwork;
