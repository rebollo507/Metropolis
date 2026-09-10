/**
 * 2D polygon toolkit for zoning. Everything works in the world XZ plane and is
 * expressed as flat arrays of [x, z] pairs.
 *
 * Orientation convention: **positive shoelace area = CCW in (x, z)**, and for a
 * CCW ring the interior lies to the LEFT of every directed edge, i.e. along the
 * normal `(-dz, dx)`. Every routine here assumes (and where useful, enforces)
 * that convention, because the lot builder depends on knowing which side of a
 * frontage line the buildable ground is on.
 *
 * No allocation-heavy cleverness: blocks have tens of vertices, not thousands,
 * so O(n^2) passes (self-intersection removal) are cheap and much easier to make
 * correct than a sweep line.
 */

export const EPS = 1e-7;

export function area2(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

export const isCCW = (pts) => area2(pts) > 0;

/** Reverse in place (and the parallel per-edge tag list, if given) to CCW. */
export function makeCCW(pts, tags = null) {
  if (area2(pts) >= 0) return { pts, tags };
  const rp = pts.slice().reverse();
  // edge i of `pts` runs pts[i]->pts[i+1]; after reversing, that edge becomes
  // the edge leaving index (n-2-i).
  let rt = null;
  if (tags) {
    const n = pts.length;
    rt = new Array(n);
    for (let i = 0; i < n; i++) rt[(n - 2 - i + n) % n] = tags[i];
  }
  return { pts: rp, tags: rt };
}

export function centroid(pts) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c; cx += (p[0] + q[0]) * c; cz += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < EPS) {
    let sx = 0, sz = 0;
    for (const p of pts) { sx += p[0]; sz += p[1]; }
    return [sx / pts.length, sz / pts.length];
  }
  a *= 0.5;
  return [cx / (6 * a), cz / (6 * a)];
}

export function perimeter(pts) {
  let L = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    L += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return L;
}

export function bbox(pts) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < z0) z0 = p[1];
    if (p[1] > z1) z1 = p[1];
  }
  return { x0, z0, x1, z1, w: x1 - x0, h: z1 - z0 };
}

export function pointInPoly(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + (zj === zi ? EPS : 0)) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/* ------------------------------------------------------------ clipping --- */

/**
 * Sutherland–Hodgman against ONE half-plane: keep `n·p <= d`.
 * The subject may be concave; the clip region must be convex, which is why the
 * lot builder always clips with a chain of half-planes rather than a polygon.
 */
export function clipHalfplane(pts, nx, nz, d) {
  const n = pts.length;
  if (n < 3) return [];
  const out = [];
  let P = pts[n - 1];
  let dp = nx * P[0] + nz * P[1] - d;
  for (let i = 0; i < n; i++) {
    const Q = pts[i];
    const dq = nx * Q[0] + nz * Q[1] - d;
    if (dq <= 0) {
      if (dp > 0) {
        const t = dp / (dp - dq);
        out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
      }
      out.push([Q[0], Q[1]]);
    } else if (dp <= 0) {
      const t = dp / (dp - dq);
      out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
    }
    P = Q; dp = dq;
  }
  return out;
}

/** Clip by a chain of half-planes `[{nx,nz,d}, ...]`. */
export function clipHalfplanes(pts, planes) {
  let p = pts;
  for (let i = 0; i < planes.length && p.length >= 3; i++) {
    const h = planes[i];
    p = clipHalfplane(p, h.nx, h.nz, h.d);
  }
  return p.length >= 3 ? p : [];
}

/** Drop vertices closer than `eps` to their predecessor, plus collinear spikes. */
export function dedupe(pts, eps = 0.02) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(p[0] - q[0]) < eps && Math.abs(p[1] - q[1]) < eps) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps) out.pop();
    else break;
  }
  return out;
}

/* ---------------------------------------------------------- simplifying --- */

/**
 * Collapse near-collinear runs while never merging across a tag change.
 * `tags[i]` describes the edge pts[i] -> pts[i+1]; the returned tags follow the
 * same convention. This is what turns a 6 m-sampled block outline into a handful
 * of long straight frontages (and a few chords on curved streets), which is the
 * difference between clean lots and a picket fence of slivers.
 */
export function simplifyTagged(pts, tags, eps = 0.42) {
  let P = pts.slice(), T = tags.slice();
  let changed = true, guard = 0;
  while (changed && guard++ < 64 && P.length > 3) {
    changed = false;
    for (let i = 0; i < P.length; i++) {
      const n = P.length;
      if (n <= 3) break;
      const prev = (i - 1 + n) % n;
      const tA = T[prev], tB = T[i];
      if (!sameTag(tA, tB)) continue;
      const a = P[prev], b = P[i], c = P[(i + 1) % n];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      const L = Math.hypot(dx, dz);
      if (L < EPS) continue;
      const dev = Math.abs((b[0] - a[0]) * dz - (b[1] - a[1]) * dx) / L;
      if (dev > eps) continue;
      P.splice(i, 1);
      T.splice(i, 1);         // the merged edge keeps tag tA (== tB)
      changed = true;
      i--;
    }
  }
  return { pts: P, tags: T };
}

function sameTag(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.segmentId === b.segmentId && a.inset === b.inset;
}

/* ------------------------------------------------------------ offsetting --- */

/** Unit inward normal of CCW edge i. */
export function edgeNormal(pts, i) {
  const a = pts[i], b = pts[(i + 1) % pts.length];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L = Math.hypot(dx, dz) || 1;
  return [-dz / L, dx / L];
}

/**
 * Variable-distance inward offset of a CCW ring: edge i moves in by `dists[i]`.
 * Mitred corners, mitre length clamped, then self-intersections removed.
 * Returns `{pts, tags}` where the tag list is inherited per surviving edge, or
 * null when the ring collapses.
 */
export function offsetInward(pts, dists, tags = null) {
  const n = pts.length;
  if (n < 3) return null;

  const lines = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz);
    if (L < EPS) { lines[i] = null; continue; }
    const nx = -dz / L, nz = dx / L;
    lines[i] = { nx, nz, d: nx * a[0] + nz * a[1] + dists[i], dx: dx / L, dz: dz / L };
  }

  const outPts = [];
  const outTags = [];
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const A = lines[prev], B = lines[i];
    if (!A && !B) continue;
    if (!A || !B) {
      const L = A || B;
      outPts.push([pts[i][0] + L.nx * (dists[A ? prev : i]), pts[i][1] + L.nz * (dists[A ? prev : i])]);
      outTags.push(tags ? tags[i] : null);
      continue;
    }
    const den = A.nx * B.nz - A.nz * B.nx;
    let vx, vz;
    if (Math.abs(den) < 1e-6) {
      const d = (dists[prev] + dists[i]) * 0.5;
      vx = pts[i][0] + B.nx * d; vz = pts[i][1] + B.nz * d;
    } else {
      vx = (A.d * B.nz - B.d * A.nz) / den;
      vz = (B.d * A.nx - A.d * B.nx) / den;
      // clamp runaway mitres on very acute corners
      const mx = vx - pts[i][0], mz = vz - pts[i][1];
      const mL = Math.hypot(mx, mz);
      const cap = 3.2 * Math.max(dists[prev], dists[i], 1);
      if (mL > cap) { vx = pts[i][0] + (mx / mL) * cap; vz = pts[i][1] + (mz / mL) * cap; }
    }
    outPts.push([vx, vz]);
    outTags.push(tags ? tags[i] : null);
  }

  const cleaned = deloop(dedupe(outPts, 0.05), outTags);
  if (!cleaned || cleaned.pts.length < 3) return null;
  if (area2(cleaned.pts) <= 1) return null;
  return cleaned;
}

/** Proper segment intersection (excludes shared endpoints). */
export function segInt(p, p2, q, q2) {
  const r0 = p2[0] - p[0], r1 = p2[1] - p[1];
  const s0 = q2[0] - q[0], s1 = q2[1] - q[1];
  const den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((q[0] - p[0]) * s1 - (q[1] - p[1]) * s0) / den;
  const u = ((q[0] - p[0]) * r1 - (q[1] - p[1]) * r0) / den;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return { x: p[0] + r0 * t, z: p[1] + r1 * t, t, u };
}

/**
 * Remove self-intersection loops from a (possibly mitre-folded) ring, keeping
 * the largest surviving loop. Bounded iterations; O(n^2) per pass.
 */
export function deloop(pts, tags = null) {
  let P = pts, T = tags;
  for (let iter = 0; iter < 10; iter++) {
    const n = P.length;
    if (n < 4) break;
    let hit = null;
    outer:
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const X = segInt(P[i], P[(i + 1) % n], P[j], P[(j + 1) % n]);
        if (X) { hit = { i, j, X }; break outer; }
      }
    }
    if (!hit) break;
    const { i, j, X } = hit;
    // loop A: i+1..j then X ; loop B: X then j+1..n-1, 0..i
    const A = [], AT = [];
    for (let k = i + 1; k <= j; k++) { A.push(P[k]); AT.push(T ? T[k] : null); }
    A.push([X.x, X.z]); AT.push(T ? T[i] : null);
    const B = [[X.x, X.z]], BT = [T ? T[j] : null];
    for (let k = j + 1; k < n; k++) { B.push(P[k]); BT.push(T ? T[k] : null); }
    for (let k = 0; k <= i; k++) { B.push(P[k]); BT.push(T ? T[k] : null); }
    const aA = Math.abs(area2(A)), aB = Math.abs(area2(B));
    if (aA >= aB) { P = A; T = T ? AT : null; } else { P = B; T = T ? BT : null; }
  }
  return { pts: P, tags: T };
}

/* -------------------------------------------------------------- sampling --- */

/**
 * Distance from `p` to the polygon boundary, travelling inward along `dir`,
 * i.e. how far it is to the far side of the block. Used to stop opposite
 * frontages from eating each other on thin blocks.
 */
export function rayExit(pts, px, pz, dx, dz, maxD = 400) {
  let best = maxD;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - px) * ez - (a[1] - pz) * ex) / den;
    const u = ((a[0] - px) * dz - (a[1] - pz) * dx) / den;
    if (t > 0.05 && u >= -1e-6 && u <= 1 + 1e-6 && t < best) best = t;
  }
  return best;
}

/** Longest inscribed span through the centroid, used as a "how fat is it" test. */
export function shapeWidth(pts) {
  const c = centroid(pts);
  let min = Infinity;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI;
    const d1 = rayExit(pts, c[0], c[1], Math.cos(a), Math.sin(a));
    const d2 = rayExit(pts, c[0], c[1], -Math.cos(a), -Math.sin(a));
    min = Math.min(min, d1 + d2);
  }
  return min;
}
