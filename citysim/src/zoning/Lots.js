/**
 * Lot subdivision — the output every building in the city hangs off.
 *
 * Method, per block:
 *   1. inset the block face by (road half-width + sidewalk + per-zone setback),
 *      variable per edge because a boulevard frontage sets back further than an
 *      alley frontage;
 *   2. walk each frontage edge of the inset ring and cut it into spans whose
 *      widths jitter deterministically around the zone's target lot width;
 *   3. build each lot as the intersection of the (concave-capable) inset ring
 *      with four half-planes: the frontage line, a back line at the lot's
 *      depth, and two perpendicular side lines. Because the clip region is
 *      convex, Sutherland–Hodgman is exact even on an L-shaped block;
 *   4. depth is capped at half the local block width (ray-cast inward), so two
 *      opposite frontages meet in the middle instead of interpenetrating; on
 *      blocks too thin to split, the higher-class street wins the whole depth;
 *   5. **corners are owned, not bisected.** At every convex corner one frontage
 *      takes the corner rectangle (the better street, or the pinwheel default)
 *      and the other stands off by that lot's depth. Bisecting instead makes
 *      every corner lot a triangle, which fails the minimum-area test and
 *      cascades into one giant merged lot per block side;
 *   6. anything that comes out below the zone's minimum area or frontage width
 *      is merged into its neighbour rather than emitted as a sliver.
 *
 * `src/zoning/__selftest.mjs` runs this file headless (square, reversed-winding,
 * thin and L-shaped blocks) and asserts coverage, overlap and lot counts.
 */

import {
  area2, centroid, clipHalfplanes, pointInPoly, offsetInward, dedupe, makeCCW,
} from './geom.js';

export const ZONE_PARAMS = {
  //           setback  lotW  minW  depth  minDepth
  RES_LOW:  { setback: 3.4, lotW: 15, minW: 9.5, depth: 26, minDepth: 12, jitter: 0.17 },
  RES_HIGH: { setback: 2.4, lotW: 20, minW: 12, depth: 30, minDepth: 14, jitter: 0.13 },
  COM_LOW:  { setback: 1.4, lotW: 17, minW: 10, depth: 27, minDepth: 12, jitter: 0.15 },
  COM_HIGH: { setback: 1.0, lotW: 18, minW: 12, depth: 34, minDepth: 15, jitter: 0.12 },
  OFFICE:   { setback: 4.0, lotW: 22, minW: 14, depth: 36, minDepth: 17, jitter: 0.11 },
  IND:      { setback: 5.5, lotW: 36, minW: 19, depth: 44, minDepth: 17, jitter: 0.15 },
  CIVIC:    { setback: 6.5, lotW: 38, minW: 20, depth: 44, minDepth: 20, jitter: 0.09 },
  PARK:     { setback: 2.0, lotW: 34, minW: 17, depth: 40, minDepth: 15, jitter: 0.18 },
  NONE:     { setback: 3.4, lotW: 17, minW: 10, depth: 27, minDepth: 12, jitter: 0.16 },
};

const CLASS_RANK = { alley: 0, lane2: 1, lane4: 2, boulevard: 3, highway: 4 };

/* --------------------------------------------------------------- helpers -- */

function rayExitIdx(pts, px, pz, dx, dz, maxD = 500) {
  let best = maxD, idx = -1;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - px) * ez - (a[1] - pz) * ex) / den;
    const u = ((a[0] - px) * dz - (a[1] - pz) * dx) / den;
    if (t > 0.25 && u >= -1e-6 && u <= 1 + 1e-6 && t < best) { best = t; idx = i; }
  }
  return { d: best, idx };
}

/** Half-plane through P whose kept side is the one `dir` points into. */
function planeKeepForward(P, dirx, dirz) {
  return { nx: -dirx, nz: -dirz, d: -(dirx * P[0] + dirz * P[1]) };
}
function planeKeepBackward(P, dirx, dirz) {
  return { nx: dirx, nz: dirz, d: dirx * P[0] + dirz * P[1] };
}

/** Extent of `poly` along `dir` restricted to points lying on the frontage line. */
function frontageSpan(poly, A, nx, nz, dirx, dirz, tol = 0.12) {
  const base = nx * A[0] + nz * A[1];
  let lo = Infinity, hi = -Infinity;
  for (const p of poly) {
    if (Math.abs(nx * p[0] + nz * p[1] - base) > tol) continue;
    const s = dirx * (p[0] - A[0]) + dirz * (p[1] - A[1]);
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  if (!Number.isFinite(lo)) return null;
  return { lo, hi, width: hi - lo };
}

/** Nearest position along a segment polyline, returned as normalised arc length. */
function tOnSegment(poly, x, z) {
  if (!poly) return 0.5;
  const pts = poly.pts, cum = poly.cum;
  let bestD = Infinity, bestS = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], az = pts[i][1];
    const bx = pts[i + 1][0], bz = pts[i + 1][1];
    const ex = bx - ax, ez = bz - az;
    const L2 = ex * ex + ez * ez;
    let u = L2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / L2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = ax + ex * u, pz = az + ez * u;
    const d = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d < bestD) { bestD = d; bestS = cum[i] + Math.sqrt(L2) * u; }
  }
  const L = poly.length || cum[cum.length - 1] || 1;
  return Math.max(0, Math.min(1, bestS / L));
}

/* ------------------------------------------------------------ the builder -- */

/**
 * @param {object} block  from Blocks.extractBlocks, with `.zone`/`.zoneName` set
 * @param {object} env    {terrain, waterLevel, polys, rngFor, maxSlope}
 */
export function subdivideBlock(block, env) {
  const { terrain, waterLevel, polys, rngFor } = env;
  const params = ZONE_PARAMS[block.zoneName] || ZONE_PARAMS.NONE;

  // the face must be CCW for "interior is to the left of every edge" to hold
  const face = makeCCW(block.poly.map((p) => [p[0], p[1]]), block.tags.slice());
  const roadDist = block.roadDist.slice();
  if (face.pts !== block.poly) {
    // makeCCW reversed: rebuild the per-edge distances the same way
    const nOld = block.poly.length;
    const rd = new Array(nOld);
    for (let i = 0; i < nOld; i++) rd[(nOld - 2 - i + nOld) % nOld] = block.roadDist[i];
    if (face.pts.length === nOld && area2(block.poly) < 0) for (let i = 0; i < nOld; i++) roadDist[i] = rd[i];
  }

  const dists = roadDist.map((d) => d + params.setback);
  const inset = offsetInward(face.pts, dists, face.tags);
  if (!inset) return { inset: null, lots: [] };

  const P = inset.pts;
  const T = inset.tags;
  const n = P.length;
  if (n < 3 || area2(P) < 60) return { inset: null, lots: [] };

  // per-edge frame
  const dir = new Array(n), nrm = new Array(n), len = new Array(n), base = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1e-6;
    dir[i] = [dx / L, dz / L];
    nrm[i] = [-dz / L, dx / L];
    len[i] = L;
    base[i] = nrm[i][0] * a[0] + nrm[i][1] * a[1];
  }

  /* ---- pass 1: how deep may each frontage go? -------------------------- */
  const depth = new Float64Array(n);
  /** the measured distance across the block from each frontage — R-bldg-2 */
  const across = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const A = P[i], d = dir[i], nn = nrm[i];
    const mx = A[0] + d[0] * len[i] * 0.5, mz = A[1] + d[1] * len[i] * 0.5;
    const hit = rayExitIdx(P, mx + nn[0] * 0.05, mz + nn[1] * 0.05, nn[0], nn[1]);
    across[i] = hit.d;
    let dep = params.depth;
    if (hit.d < params.depth * 2) {
      const half = hit.d * 0.5;
      if (half >= params.minDepth) dep = half;
      else {
        // too thin to share: the better street takes the whole depth
        const opp = hit.idx >= 0 ? T[hit.idx] : null;
        const tag = T[i];
        const mine = CLASS_RANK[tag ? tag.cls : 'lane2'] ?? 1;
        const theirs = opp ? (CLASS_RANK[opp.cls] ?? 1) : -1;
        const win = mine > theirs
          || (mine === theirs && (!opp || !tag || tag.segmentId <= opp.segmentId));
        dep = win ? Math.max(params.minDepth * 0.7, hit.d - 0.35) : 0;
      }
    }
    depth[i] = dep;
  }

  /* ---- pass 2: who owns each convex corner? ---------------------------- */
  /* Real corner lots are rectangles fronting the better street; the side street
   * sets back behind them. Cutting both on the angle bisector instead (the
   * "equidistant" answer) turns every corner lot into a triangle and forces the
   * whole frontage to merge into one giant lot — which is exactly what the
   * first version of this file did. */
  const ownsStart = new Uint8Array(n);   // edge i owns the corner at P[i]
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const cross = dir[prev][0] * dir[i][1] - dir[prev][1] * dir[i][0];
    if (cross <= 0.02) { ownsStart[i] = 1; continue; }   // reflex/straight: no contest
    const tPrev = T[prev], tCur = T[i];
    const rPrev = CLASS_RANK[tPrev ? tPrev.cls : 'lane2'] ?? 1;
    const rCur = CLASS_RANK[tCur ? tCur.cls : 'lane2'] ?? 1;
    // Class decides where the streets differ; otherwise every edge takes its
    // START corner and yields its END one. That single rule is the pinwheel
    // block you see on any cadastral map, and it is what keeps lots on all four
    // sides of a block instead of letting the two long frontages swallow it.
    if (rCur !== rPrev) ownsStart[i] = rCur > rPrev ? 1 : 0;
    else ownsStart[i] = 1;
  }

  /**
   * How far in from a corner edge `i` must stand so it does not invade the
   * strip owned by edge `j`. `dx,dz` is the direction of travel INTO edge i
   * from that corner (+dir at its start, −dir at its end) — getting that sign
   * wrong silently deletes every short frontage in the city.
   */
  const clearance = (j, dx, dz) => {
    const dot = nrm[j][0] * dx + nrm[j][1] * dz;
    if (dot < 0.18) return depth[j] * 2.4;
    return Math.min(depth[j] / dot, depth[j] * 2.4);
  };

  const rng = rngFor(block.id);
  const lots = [];
  const builders = new Array(n).fill(null);
  const minArea = Math.max(105, params.minW * params.minDepth * 0.95);

  /* ---- pass 3: cut each usable frontage into lots ---------------------- */
  for (let i = 0; i < n; i++) {
    const tag = T[i] || block.tags[Math.min(i, block.tags.length - 1)];
    const dep = depth[i];
    if (dep < params.minDepth * 0.7) continue;

    const prev = (i - 1 + n) % n, next = (i + 1) % n;
    const A = P[i], d = dir[i], nn = nrm[i];

    const sStart = ownsStart[i] ? 0 : clearance(prev, d[0], d[1]);
    const sEnd = ownsStart[next] ? clearance(next, -d[0], -d[1]) : 0;
    const usable = len[i] - sStart - sEnd;
    if (usable < params.minW * 0.85) continue;

    const frontPlane = { nx: -nn[0], nz: -nn[1], d: -base[i] + 0.08 };

    let count = Math.max(1, Math.round(usable / params.lotW));
    if (usable / count < params.minW && count > 1) count = Math.max(1, Math.floor(usable / params.minW));
    const w = new Float64Array(count);
    let wsum = 0;
    for (let k = 0; k < count; k++) { w[k] = 1 + (rng.next() * 2 - 1) * params.jitter; wsum += w[k]; }
    const cuts = new Float64Array(count + 1);
    cuts[0] = sStart;
    for (let k = 0; k < count; k++) cuts[k + 1] = cuts[k] + (w[k] / wsum) * usable;
    cuts[count] = len[i] - sEnd;

    const cornerHere = (v, ea, eb) => {
      const ta = T[ea], tb = T[eb];
      return turnAngle(dir[ea], dir[eb]) > 0.62 && !!ta && !!tb && ta.segmentId !== tb.segmentId && v;
    };

    /* ---- build one candidate lot spanning cuts[ka]..cuts[kb] ---- */
    const buildLot = (ka, kb, depthOverride) => {
      const s0 = cuts[ka], s1 = cuts[kb];
      if (s1 - s0 < params.minW * 0.85) return null;
      const useDepth = depthOverride === undefined ? dep : depthOverride;
      if (useDepth < params.minDepth * 0.7) return null;

      const planes = [
        frontPlane,
        { nx: nn[0], nz: nn[1], d: base[i] + useDepth },
        planeKeepForward([A[0] + d[0] * s0, A[1] + d[1] * s0], d[0], d[1]),
        planeKeepBackward([A[0] + d[0] * s1, A[1] + d[1] * s1], d[0], d[1]),
      ];

      let poly = clipHalfplanes(P, planes);
      poly = dedupe(poly, 0.06);
      if (poly.length < 3) return null;
      const a = area2(poly);
      if (a < minArea) return null;

      const span = frontageSpan(poly, A, nn[0], nn[1], d[0], d[1]);
      if (!span || span.width < params.minW * 0.85) return null;

      let dmax = 0;
      for (const p of poly) dmax = Math.max(dmax, nn[0] * p[0] + nn[1] * p[1] - base[i]);
      if (dmax < params.minDepth * 0.7) return null;
      // reject shapes that are all frontage and no ground behind it
      if (a < span.width * dmax * 0.42) return null;

      const fa = [A[0] + d[0] * span.lo, A[1] + d[1] * span.lo];
      const fb = [A[0] + d[0] * span.hi, A[1] + d[1] * span.hi];
      const fmid = [(fa[0] + fb[0]) * 0.5, (fa[1] + fb[1]) * 0.5];
      const c = centroid(poly);

      let yMin = Infinity, yMax = -Infinity, slope = 0, wet = false;
      if (terrain) {
        const probes = [c, fmid, ...poly];
        for (const p of probes) {
          const hh = terrain.heightAt(p[0], p[1]);
          if (Number.isFinite(hh)) { if (hh < yMin) yMin = hh; if (hh > yMax) yMax = hh; }
          if (hh <= waterLevel + 0.35) wet = true;
        }
        slope = terrain.slopeAt ? terrain.slopeAt(c[0], c[1], 5) : 0;
      }
      if (!Number.isFinite(yMin)) { yMin = 0; yMax = 0; }

      const corner = cornerHere(ka === 0 && !!ownsStart[i], prev, i)
        || cornerHere(kb === count && !ownsStart[next], i, next);

      return {
        _edge: i, _k0: ka, _k1: kb,
        blockId: block.id,
        zone: block.zone,
        zoneName: block.zoneName,
        poly,
        area: a,
        center: [c[0], terrain ? terrain.heightAt(c[0], c[1]) : 0, c[1]],
        depth: dmax,
        /** metres of buildable ground between this frontage and the far side of
         *  the block, measured not inferred — R-bldg-2 */
        blockDepth: across[i],
        corner: !!corner,
        yMin, yMax,
        slope,
        water: wet,
        frontage: {
          segmentId: tag ? tag.segmentId : -1,
          class: tag ? tag.cls : 'lane2',
          t: tag ? tOnSegment(polys.get(tag.segmentId), fmid[0], fmid[1]) : 0.5,
          a: fa, b: fb, mid: fmid,
          width: span.width,
          normal: [-nn[0], -nn[1]],
          rotation: Math.atan2(-nn[0], -nn[1]),
          roadOffset: (roadDist[Math.min(i, roadDist.length - 1)] ?? 6) + params.setback,
        },
      };
    };

    builders[i] = buildLot;

    // greedy: grow a span until it yields a real lot, otherwise merge onward
    let k0 = 0;
    while (k0 < count) {
      let made = null, k1 = k0 + 1;
      for (; k1 <= count; k1++) {
        const cand = buildLot(k0, k1);
        if (cand) { made = cand; break; }
      }
      if (made) { lots.push(made); k0 = k1; continue; }
      // nothing from here on works — fold the remainder into the last lot
      if (lots.length && lots[lots.length - 1]._edge === i) {
        const last = lots[lots.length - 1];
        const grown = buildLot(last._k0, count);
        if (grown) lots[lots.length - 1] = grown;
      }
      break;
    }
  }

  /* ---- pass 4: repair the residual overlaps -----------------------------
   * Corner ownership and the half-block depth cap remove the systematic
   * overlaps, but on a curved or re-entrant block an edge's inward ray can miss
   * the frontage it actually collides with. Rather than accept ~2% of lots
   * sitting on top of each other (which would put two buildings in one place),
   * binary-search the offending lot's depth down until it clears, and drop it
   * only if no legal depth exists. */
  for (let i = 1; i < lots.length; i++) {
    for (let j = 0; j < i; j++) {
      if (!lotsOverlap(lots[i], lots[j])) continue;
      const build = builders[lots[i]._edge];
      let lo = 0, hi = lots[i].depth, fixed = null;
      if (build) {
        for (let it = 0; it < 7; it++) {
          const mid = (lo + hi) * 0.5;
          const cand = build(lots[i]._k0, lots[i]._k1, mid);
          if (cand && !lotsOverlap(cand, lots[j])) { lo = mid; fixed = cand; } else hi = mid;
        }
      }
      if (fixed) { lots[i] = fixed; j = -1; continue; }   // re-test against all
      lots.splice(i, 1); i--; break;
    }
  }

  return { inset: P, insetTags: T, lots };
}

/**
 * Do two lots share ground? Vertices pulled 18% toward the centroid keep a
 * shared edge (which is normal and wanted) from counting as an overlap.
 */
function lotsOverlap(A, B) {
  const probe = (p, q) => {
    const c = centroid(p);
    for (const v of p) {
      if (pointInPoly(q, v[0] + (c[0] - v[0]) * 0.18, v[1] + (c[1] - v[1]) * 0.18)) return true;
    }
    return pointInPoly(q, c[0], c[1]);
  };
  return probe(A.poly, B.poly) || probe(B.poly, A.poly);
}

function turnAngle(a, b) {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]));
  return Math.acos(dot);
}

/**
 * Subdivide every block. Lots that sit in water or on unbuildable slopes are
 * dropped; `blocks` gets `lotIds` and `inset` written back onto it.
 */
export function subdivideAll(blocks, env, log = null) {
  const lots = [];
  let id = 1, dropped = 0;
  for (const b of blocks) {
    const r = subdivideBlock(b, env);
    b.inset = r.inset;
    b.lotIds = [];
    for (const lot of r.lots) {
      if (lot.water || lot.slope > env.maxSlope) { dropped++; continue; }
      lot.id = id++;
      lot.seed = (((b.id * 2654435761) ^ (lot.id * 40503)) >>> 0);
      delete lot._edge; delete lot._k0; delete lot._k1;
      b.lotIds.push(lot.id);
      lots.push(lot);
    }
  }
  log?.info?.(`lots: ${lots.length} across ${blocks.length} blocks (${dropped} dropped: water/slope)`);
  return lots;
}

/** Point-in-lot test used by paint() to retint lots under a brush. */
export function lotContains(lot, x, z) {
  return pointInPoly(lot.poly, x, z);
}

export default subdivideAll;
