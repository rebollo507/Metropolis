import { ZONE } from '../core/World.js';

/**
 * Streets, not segments — and the retail that runs along them.
 *
 * The road graph splits every street at every junction, so a single road
 * segment is at most one block long (~90 m). Everything in this file exists
 * because the two questions that matter are about *streets*:
 *
 *   "grow 200 m of unbroken shopfront"      (autoZone, R-demo-13)
 *   "where can I point a lens at one?"      (retailFrontages, R-demo-13)
 *
 * Both need segments chained across junctions by collinearity. `buildChains`
 * does that once; `pickCorridors` uses it to choose a high street and a few
 * neighbourhood parades; `retailRuns` uses it to report what actually got
 * built, measured on the lots rather than on the intent.
 */

const CLASS_RANK = { alley: 0, lane2: 1, lane4: 2, boulevard: 3, highway: 4 };

/** How straight a junction has to be to count as "the same street". */
const CHAIN_COS = Math.cos(0.62);        // ~35 degrees

/* ------------------------------------------------------------- chaining -- */

/**
 * Chain road segments into streets.
 * @returns {Array<{id, segs:[{segmentId, flip, length, offset}], segIds:Set,
 *                  cls, rank, length, mid:[x,z], axis:[x,z]}>}
 */
export function buildChains(roads) {
  const net = roads.network();
  if (!net) return [];
  const segments = net.segments;
  const nodes = net.nodes;

  /** Unit direction leaving `node` along `segId` — i.e. pointing INTO the segment. */
  const intoDir = (segId, node) => {
    const s = segments.get(segId);
    if (!s) return [0, 0];
    if (s.a === node) { const t = roads.tangentAt(segId, 0); return [t.x, t.z]; }
    const t = roads.tangentAt(segId, 1); return [-t.x, -t.z];
  };

  const used = new Set();
  const chains = [];

  /** Walk from `segId` leaving node `fromNode`, appending as we go. */
  const walk = (segId, fromNode, out) => {
    let cur = segId, node = fromNode;
    for (let guard = 0; guard < 200; guard++) {
      const s = segments.get(cur);
      if (!s) break;
      const far = s.a === node ? s.b : s.a;
      const n = nodes.get(far);
      if (!n || !n.edges) break;
      // heading with which we ARRIVE at `far` (the reverse of leaving it)
      const back = intoDir(cur, far);
      const inc = [-back[0], -back[1]];
      let best = -1, bestDot = CHAIN_COS;
      for (const eid of n.edges) {
        if (eid === cur || used.has(eid)) continue;
        const e = segments.get(eid);
        if (!e) continue;
        if (Math.abs((CLASS_RANK[e.class] ?? 1) - (CLASS_RANK[s.class] ?? 1)) > 1) continue;
        const outDir = intoDir(eid, far);           // leaving `far` along e
        const d = inc[0] * outDir[0] + inc[1] * outDir[1];
        if (d > bestDot) { bestDot = d; best = eid; }
      }
      if (best < 0) break;
      used.add(best);
      out.push({ id: best, entered: far });
      cur = best; node = far;
    }
  };

  for (const seg of segments.values()) {
    if (used.has(seg.id)) continue;
    used.add(seg.id);
    const fwd = [];
    const bwd = [];
    walk(seg.id, seg.a, fwd);        // leaving a → grows past b
    walk(seg.id, seg.b, bwd);        // leaving b → grows past a
    const ordered = [...bwd.reverse().map((e) => e.id), seg.id, ...fwd.map((e) => e.id)];

    // orient every member so the chain reads start → end
    const segs = [];
    let prevEnd = null;
    for (const id of ordered) {
      const s = segments.get(id);
      if (!s) continue;
      let flip;
      if (prevEnd === null) flip = false;
      else flip = s.b === prevEnd;
      // first element: choose the orientation that connects to the second
      segs.push({ segmentId: id, flip, length: s.length || 0, cls: s.class });
      prevEnd = flip ? s.a : s.b;
    }
    if (segs.length > 1) {
      // fix the head: it must end where the second one starts
      const s0 = segments.get(segs[0].segmentId);
      const s1 = segments.get(segs[1].segmentId);
      const start1 = segs[1].flip ? s1.b : s1.a;
      segs[0].flip = s0.a === start1;
      let end = segs[0].flip ? s0.a : s0.b;
      for (let i = 1; i < segs.length; i++) {
        const s = segments.get(segs[i].segmentId);
        segs[i].flip = s.b === end;
        end = segs[i].flip ? s.a : s.b;
      }
    }

    let offset = 0;
    for (const s of segs) { s.offset = offset; offset += s.length; }
    if (offset < 1) continue;

    const mid = pointOnChain(roads, segs, offset * 0.5);
    const ax = roads.tangentAt(segs[Math.floor(segs.length / 2)].segmentId, 0.5);
    const flipMid = segs[Math.floor(segs.length / 2)].flip;
    let rank = 0, cls = 'lane2';
    const counts = {};
    for (const s of segs) {
      const r = CLASS_RANK[s.cls] ?? 1;
      counts[s.cls] = (counts[s.cls] || 0) + s.length;
      if (r > rank) rank = r;
    }
    cls = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

    chains.push({
      id: chains.length + 1,
      segs,
      segIds: new Set(segs.map((s) => s.segmentId)),
      cls, rank,
      length: offset,
      mid,
      axis: flipMid ? [-ax.x, -ax.z] : [ax.x, ax.z],
    });
  }

  chains.sort((a, b) => b.length - a.length);
  return chains;
}

/** World point at arc distance `s` along a chain. */
export function pointOnChain(roads, segs, s) {
  for (const seg of segs) {
    if (s <= seg.offset + seg.length || seg === segs[segs.length - 1]) {
      const local = Math.max(0, Math.min(1, (s - seg.offset) / (seg.length || 1)));
      const t = seg.flip ? 1 - local : local;
      const p = roads.pointAt(seg.segmentId, t);
      return [p.x, p.z];
    }
  }
  return [0, 0];
}

/** Arc distance along a chain of a point given as (segmentId, t). */
export function distanceOnChain(chain, segmentId, t) {
  for (const s of chain.segs) {
    if (s.segmentId !== segmentId) continue;
    const local = s.flip ? 1 - t : t;
    return s.offset + local * s.length;
  }
  return -1;
}

/* ------------------------------------------------------ corridor choice -- */

/**
 * Choose the retail corridors: one high street plus a few parades.
 *
 * A high street is a *whole-segment* window of a chain, because a block's
 * frontage is tagged per segment — taking half a segment would leave half a
 * block of shops, which is the discontinuity this whole exercise is fixing.
 *
 * @returns {{high, parades:[], segments:Map<segmentId, zone>}}
 */
export function pickCorridors(chains, blocks, env) {
  const { rng, core, rankOf, terrain, waterLevel = 0, log = null } = env;
  const targetLen = env.targetLength ?? 240;
  const out = { high: null, parades: [], segments: new Map() };
  if (!chains.length) return out;

  // how many blocks front each segment, and how buildable that frontage is
  const frontage = new Map();       // segmentId -> {blocks:Set, rank}
  for (const b of blocks) {
    for (const tag of b.tags) {
      let f = frontage.get(tag.segmentId);
      if (!f) { f = { blocks: new Set(), rank: 0 }; frontage.set(tag.segmentId, f); }
      f.blocks.add(b.id);
      f.rank = Math.max(f.rank, rankOf.get(b.id) ?? 1);
    }
  }

  const blockById = new Map(blocks.map((b) => [b.id, b]));
  /**
   * How many sides of this segment can actually carry a shop. A window scored
   * on raw block count happily runs the high street past a park and a factory,
   * which is exactly the discontinuity the corridor exists to remove.
   */
  const usable = (segId) => {
    const f = frontage.get(segId);
    if (!f) return 0;
    let n = 0;
    for (const id of f.blocks) {
      const b = blockById.get(id);
      if (!b) continue;
      if (b.zone === ZONE.PARK || b.zone === ZONE.IND || b.zone === ZONE.CIVIC) continue;
      if (b.metrics && (b.metrics.wetFrac > 0.25 || b.metrics.slope > 0.28)) continue;
      n++;
    }
    return n;
  };

  /**
   * The window a lens can actually use: the longest contiguous stretch of
   * segments that have a shop-capable block on BOTH sides, trimmed toward
   * `want` metres.
   *
   * Scoring a window on average block density instead put the first high
   * street on a fringe chain where half the segments had nothing opposite —
   * 292 m of corridor that measured 116 m of continuous frontage. Predicting
   * the outcome directly, from the same block/tag data the measurement uses,
   * removes the gap between what is planned and what gets built.
   */
  const window = (chain, want) => {
    const S = chain.segs;
    const runs = [];
    let i = 0;
    while (i < S.length) {
      if (usable(S[i].segmentId) < 2) { i++; continue; }
      let j = i;
      while (j + 1 < S.length && usable(S[j + 1].segmentId) >= 2) j++;
      let len = 0;
      for (let k = i; k <= j; k++) len += S[k].length;
      runs.push({ i, j, len, twoSided: true });
      i = j + 1;
    }
    // fall back to any flanked stretch when nothing is two-sided
    if (!runs.length) {
      let bi = -1, bj = -1, blen = 0;
      let k = 0;
      while (k < S.length) {
        if (usable(S[k].segmentId) < 1) { k++; continue; }
        let j2 = k, len2 = 0;
        while (j2 < S.length && usable(S[j2].segmentId) >= 1) { len2 += S[j2].length; j2++; }
        if (len2 > blen) { blen = len2; bi = k; bj = j2 - 1; }
        k = j2;
      }
      if (bi < 0) return null;
      runs.push({ i: bi, j: bj, len: blen, twoSided: false });
    }

    let best = null;
    for (const r of runs) {
      let { i: a, j: b, len } = r;
      // trim the ends back toward `want`, dropping the shorter end each time
      while (len > want * 1.35 && b > a) {
        const dropA = S[a].length, dropB = S[b].length;
        if (dropA <= dropB) { len -= dropA; a++; } else { len -= dropB; b--; }
      }
      const score = Math.min(len, want * 1.2) - Math.max(0, want * 0.55 - len) * 2.5;
      if (!best || score > best.score) best = { i: a, j: b, len, score, twoSided: r.twoSided };
    }
    if (best) best.density = best.twoSided ? 2 : 1;
    return best;
  };

  const midOf = (chain, w) => {
    const s0 = chain.segs[w.i].offset;
    const s1 = chain.segs[w.j].offset + chain.segs[w.j].length;
    return (s0 + s1) * 0.5;
  };

  /* ---- the high street ------------------------------------------------- */
  const cands = [];
  for (const c of chains) {
    if (c.length < 130) continue;
    if (c.rank > 2 || c.rank < 1) continue;              // lane2 / lane4 only
    const w = window(c, targetLen);
    if (!w) continue;
    const m = pointOnChain(env.roads, c.segs, midOf(c, w));
    const dCore = core ? Math.hypot(m[0] - core.x, m[1] - core.z) : 0;
    const slope = terrain && terrain.slopeAt ? terrain.slopeAt(m[0], m[1], 6) : 0;
    const wet = terrain ? terrain.heightAt(m[0], m[1]) < waterLevel + 0.6 : false;
    if (wet) continue;
    // A high street sits just off the tower district: close enough to be busy,
    // far enough that the frontage is lane2 shopfront rather than plaza.
    const near = env.coreR ? dCore / env.coreR : 1;
    /* Lead on the length that will actually be built, not on a proxy for it. */
    const score = Math.min(w.len, 320) / 55
      + (w.twoSided ? 3.2 : 0)
      // A lane2 high street is the nicer photograph, but continuity beats width:
      // biasing harder toward lane2 picked a chain that measured 178 m against
      // this one's 236 m, so the bonus stays small enough to lose.
      + (c.cls === 'lane2' ? 1.4 : 0.4)
      - Math.abs(near - 0.9) * 1.4
      - slope * 6
      + rng.next() * 0.2;
    cands.push({ chain: c, w, score, len: w.len, mid: m, dCore });
  }
  cands.sort((a, b) => b.score - a.score);

  if (cands.length) {
    const pick = cands[0];
    const segs = pick.chain.segs.slice(pick.w.i, pick.w.j + 1);
    out.high = {
      chain: pick.chain,
      segs,
      length: segs.reduce((a, s) => a + s.length, 0),
      mid: pick.mid,
      cls: pick.chain.cls,
    };
    for (const s of segs) out.segments.set(s.segmentId, ZONE.COM_LOW);
  }

  /* ---- neighbourhood parades ------------------------------------------- */
  const taken = out.high ? [out.high.mid] : [];
  for (const cand of cands) {
    if (out.parades.length >= 3) break;
    if (out.high && cand.chain === out.high.chain) continue;
    const w = window(cand.chain, 110);
    if (!w || w.len < 70) continue;
    const m = pointOnChain(env.roads, cand.chain.segs, midOf(cand.chain, w));
    if (taken.some((p) => Math.hypot(p[0] - m[0], p[1] - m[1]) < 220)) continue;
    const segs = cand.chain.segs.slice(w.i, w.j + 1);
    if (segs.some((s) => out.segments.has(s.segmentId))) continue;
    out.parades.push({ chain: cand.chain, segs, length: segs.reduce((a, s) => a + s.length, 0), mid: m });
    for (const s of segs) out.segments.set(s.segmentId, ZONE.COM_LOW);
    taken.push(m);
  }

  log?.info?.(
    `corridors: high street ${out.high ? out.high.length.toFixed(0) + ' m of ' + out.high.cls : 'none'}`
    + `, ${out.parades.length} parade(s), ${out.segments.size} segment(s) retail`
  );
  return out;
}

/* --------------------------------------------------------- measured runs -- */

/**
 * Contiguous runs of commercial frontage, measured on the lots that exist.
 * Lots are grouped by (chain, side), sorted along the chain, and split wherever
 * the gap exceeds `maxGap` — a junction is a gap of one carriageway width, so
 * the default lets a run cross a side street but not a missing block.
 */
export function retailRuns(lots, chains, roads, opts = {}) {
  const {
    zones = [ZONE.COM_LOW, ZONE.COM_HIGH],
    maxGap = 46,
    minLength = 0,
    terrain = null,
  } = opts;

  const zoneSet = new Set(zones);
  const chainOf = new Map();
  for (const c of chains) for (const s of c.segs) chainOf.set(s.segmentId, c);

  // bucket by chain + side
  const buckets = new Map();
  for (const lot of lots) {
    if (!zoneSet.has(lot.zone)) continue;
    const f = lot.frontage;
    const chain = chainOf.get(f.segmentId);
    if (!chain) continue;
    const s = distanceOnChain(chain, f.segmentId, f.t);
    if (s < 0) continue;
    const seg = chain.segs.find((x) => x.segmentId === f.segmentId);
    const tan = roads.tangentAt(f.segmentId, f.t);
    const ax = seg.flip ? -tan.x : tan.x;
    const az = seg.flip ? -tan.z : tan.z;
    // lot direction is opposite its outward (lot -> street) normal
    const side = Math.sign(ax * -f.normal[1] - az * -f.normal[0]) || 1;
    const key = chain.id + ':' + side;
    let arr = buckets.get(key);
    if (!arr) { arr = { chain, side, items: [] }; buckets.set(key, arr); }
    arr.items.push({ lot, s, half: f.width * 0.5, axis: [ax, az] });
  }

  const runs = [];
  for (const b of buckets.values()) {
    b.items.sort((p, q) => p.s - q.s);
    let cur = null;
    const flush = () => {
      if (!cur) return;
      const len = cur.hi - cur.lo;
      if (len >= minLength && cur.items.length) runs.push(finish(cur, b, roads, terrain));
      cur = null;
    };
    for (const it of b.items) {
      const lo = it.s - it.half, hi = it.s + it.half;
      if (cur && lo - cur.hi <= maxGap) {
        cur.gapMax = Math.max(cur.gapMax, Math.max(0, lo - cur.hi));
        cur.hi = Math.max(cur.hi, hi);
        cur.items.push(it);
      } else {
        flush();
        cur = { lo, hi, gapMax: 0, items: [it] };
      }
    }
    flush();
  }

  runs.sort((a, b) => b.length - a.length);
  runs.forEach((r, i) => { r.id = i + 1; });
  return runs;
}

function finish(cur, bucket, roads, terrain) {
  const chain = bucket.chain;
  const lots = cur.items.map((i) => i.lot);
  const a = pointOnChain(roads, chain.segs, cur.lo);
  const b = pointOnChain(roads, chain.segs, cur.hi);
  const midS = (cur.lo + cur.hi) * 0.5;
  const m = pointOnChain(roads, chain.segs, midS);

  // the constituent segments and their t ranges
  const parts = [];
  for (const seg of chain.segs) {
    const s0 = Math.max(cur.lo, seg.offset);
    const s1 = Math.min(cur.hi, seg.offset + seg.length);
    if (s1 - s0 < 0.5) continue;
    const L = seg.length || 1;
    let t0 = (s0 - seg.offset) / L, t1 = (s1 - seg.offset) / L;
    if (seg.flip) { const a2 = 1 - t1, b2 = 1 - t0; t0 = a2; t1 = b2; }
    parts.push({ segmentId: seg.segmentId, class: seg.cls, t0, t1, length: s1 - s0 });
  }
  parts.sort((p, q) => q.length - p.length);
  const dominant = parts[0] || { segmentId: -1, class: chain.cls, t0: 0, t1: 1 };

  // averaged outward normal (lot -> street) and street axis at the middle
  let nx = 0, nz = 0, axx = 0, azz = 0;
  for (const it of cur.items) {
    nx += it.lot.frontage.normal[0]; nz += it.lot.frontage.normal[1];
    axx += it.axis[0]; azz += it.axis[1];
  }
  const nl = Math.hypot(nx, nz) || 1;
  const al = Math.hypot(axx, azz) || 1;
  const normal = [nx / nl, nz / nl];
  const axis = [axx / al, azz / al];

  const zones = {};
  for (const l of lots) zones[l.zoneName] = (zones[l.zoneName] || 0) + 1;
  const blockIds = [...new Set(lots.map((l) => l.blockId))];
  const y = terrain ? terrain.heightAt(m[0], m[1]) : 0;

  // Depth of the frontage line from the street centreline, so a lens can stand
  // on the pavement rather than inside a shop.
  const off = lots.reduce((s, l) => s + (l.frontage.roadOffset || 8), 0) / lots.length;

  return {
    id: 0,
    length: cur.hi - cur.lo,
    lots,
    lotIds: lots.map((l) => l.id),
    count: lots.length,
    side: bucket.side,
    chainId: chain.id,
    class: dominant.class,
    segmentId: dominant.segmentId,
    t0: dominant.t0,
    t1: dominant.t1,
    segments: parts,
    a, b,
    mid: [m[0], y, m[1]],
    normal,
    axis,
    roadOffset: off,
    gapMax: cur.gapMax,
    zones,
    blockIds,
  };
}

/**
 * A street-level framing that puts `run` across the frame: stand back from the
 * frontage on the far pavement, at eye height, looking along the shop line.
 */
export function frameRun(run, opts = {}) {
  if (!run) return null;
  const {
    fov = 46,
    height = 0.7,        // metres above the target: a standing eye, not a drone
    back = null,         // metres along the street; default scales with the run
    lateral = 0.78,      // multiples of the setback — step across the road
    lift = 2.9,          // metres above grade to aim at — the fascia band
  } = opts;

  /* Aim AT the shop line and stand back ALONG it, across the carriageway.
   *
   * Two framings were tried and rejected against the shipped frames: standing
   * mid-carriageway looking down the street put the frontage at a grazing angle
   * with the bottom 45% of frame dead asphalt (the critic's own complaint about
   * demo's shot), and standing 30 m back from a target 24 m behind the midpoint
   * left the camera level with the run, so the nearest awning filled the lens.
   * What works is the ordinary way a high street is photographed: target the
   * frontage at the middle of the run, retreat along the street far enough that
   * the nearest shop is off to the side rather than in front, and step just
   * across the road so the elevations turn toward the camera. */
  const b = back === null ? Math.max(26, Math.min(46, run.length * 0.185)) : back;
  const across = run.roadOffset * lateral;

  const target = [
    run.mid[0] - run.normal[0] * 1.5,
    run.mid[1] + lift,
    run.mid[2] - run.normal[1] * 1.5,
  ];
  const camX = target[0] + run.axis[0] * b + run.normal[0] * across;
  const camZ = target[2] + run.axis[1] * b + run.normal[1] * across;
  const dx = camX - target[0], dz = camZ - target[2];
  const dist = Math.hypot(dx, dz, height);
  return {
    target,
    dist,
    az: Math.atan2(dx, dz),
    pol: Math.acos(Math.max(-1, Math.min(1, height / dist))),
    fov,
  };
}

export default buildChains;
