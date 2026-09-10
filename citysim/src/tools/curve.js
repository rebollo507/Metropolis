/**
 * Curve maths for the build tools.
 *
 * `roads` owns the identical algebra internally, but a module may not import a
 * sibling's internals (contract-check rule 3), so the few functions the tools
 * need — evaluation, de Casteljau subdivision, arc-length and segment/segment
 * intersection — live here. Everything is allocation-light: the hot paths write
 * into caller-supplied objects.
 *
 * A "curve" is the same shape `roads` stores: four control points [x, y, z].
 */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------ evaluation -- */

export function bez(c, t, out = { x: 0, z: 0 }) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, d = 3 * mt * t * t, e = t * t * t;
  out.x = a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0];
  out.z = a * c[0][2] + b * c[1][2] + d * c[2][2] + e * c[3][2];
  return out;
}

export function dbez(c, t, out = { x: 0, z: 0 }) {
  const mt = 1 - t;
  const a = 3 * mt * mt, b = 6 * mt * t, d = 3 * t * t;
  out.x = a * (c[1][0] - c[0][0]) + b * (c[2][0] - c[1][0]) + d * (c[3][0] - c[2][0]);
  out.z = a * (c[1][2] - c[0][2]) + b * (c[2][2] - c[1][2]) + d * (c[3][2] - c[2][2]);
  return out;
}

/* ------------------------------------------------------------ construction */

export function straightCurve(a, b) {
  return [
    [a[0], a[1] || 0, a[2]],
    [lerp(a[0], b[0], 1 / 3), 0, lerp(a[2], b[2], 1 / 3)],
    [lerp(a[0], b[0], 2 / 3), 0, lerp(a[2], b[2], 2 / 3)],
    [b[0], b[1] || 0, b[2]],
  ];
}

/** Quadratic (p0, control, p1) raised to the cubic basis `roads` stores. */
export function quadCurve(a, ctrl, b) {
  return [
    [a[0], a[1] || 0, a[2]],
    [a[0] + (2 / 3) * (ctrl[0] - a[0]), 0, a[2] + (2 / 3) * (ctrl[2] - a[2])],
    [b[0] + (2 / 3) * (ctrl[0] - b[0]), 0, b[2] + (2 / 3) * (ctrl[2] - b[2])],
    [b[0], b[1] || 0, b[2]],
  ];
}

/** Cubic through two explicit handles. */
export function cubicCurve(a, h1, h2, b) {
  return [
    [a[0], a[1] || 0, a[2]],
    [h1[0], 0, h1[2]],
    [h2[0], 0, h2[2]],
    [b[0], b[1] || 0, b[2]],
  ];
}

/** A curve that leaves `a` along unit heading `dir` and ends at `b`. */
export function tangentCurve(a, b, dir, tension = 0.45) {
  const L = Math.hypot(b[0] - a[0], b[2] - a[2]) * tension;
  const mx = a[0] + dir[0] * L, mz = a[2] + dir[1] * L;
  return quadCurve(a, [mx, 0, mz], b);
}

/* ------------------------------------------------------------ subdivision -- */

const _mix = (p, q, u) => [lerp(p[0], q[0], u), 0, lerp(p[2], q[2], u)];

/** The half of `c` before Bezier parameter u. */
export function splitLeft(c, u) {
  const a1 = _mix(c[0], c[1], u), a2 = _mix(c[1], c[2], u), a3 = _mix(c[2], c[3], u);
  const b1 = _mix(a1, a2, u), b2 = _mix(a2, a3, u);
  const m = _mix(b1, b2, u);
  return [[c[0][0], c[0][1], c[0][2]], a1, b1, m];
}

/** The half of `c` after Bezier parameter u. */
export function splitRight(c, u) {
  const a1 = _mix(c[0], c[1], u), a2 = _mix(c[1], c[2], u), a3 = _mix(c[2], c[3], u);
  const b1 = _mix(a1, a2, u), b2 = _mix(a2, a3, u);
  const m = _mix(b1, b2, u);
  return [m, b2, a3, [c[3][0], c[3][1], c[3][2]]];
}

/** The piece of `c` between Bezier parameters u0 and u1. */
export function subCurve(c, u0, u1) {
  if (u1 <= u0) return null;
  const right = u0 > 0 ? splitRight(c, u0) : c;
  const u = u0 > 0 ? (u1 - u0) / (1 - u0) : u1;
  return u < 1 ? splitLeft(right, u) : right.map((p) => [p[0], p[1], p[2]]);
}

/* ------------------------------------------------------------- arc length -- */

const LUT_N = 24;

/** {length, lut} — lut[i] is arc length at Bezier parameter i/LUT_N. */
export function arcTable(c) {
  const lut = new Float64Array(LUT_N + 1);
  const p = { x: 0, z: 0 };
  bez(c, 0, p);
  let px = p.x, pz = p.z, acc = 0;
  for (let i = 1; i <= LUT_N; i++) {
    bez(c, i / LUT_N, p);
    acc += Math.hypot(p.x - px, p.z - pz);
    lut[i] = acc;
    px = p.x; pz = p.z;
  }
  return { length: acc, lut };
}

export function curveLength(c) { return arcTable(c).length; }

/** Bezier parameter at normalised arc length s ∈ [0,1]. */
export function paramAt(table, s) {
  const L = table.length || 1;
  const target = clamp(s, 0, 1) * L;
  let lo = 0, hi = LUT_N;
  while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (table.lut[m] <= target) lo = m; else hi = m; }
  const d = table.lut[hi] - table.lut[lo];
  const f = d > 1e-6 ? (target - table.lut[lo]) / d : 0;
  return (lo + f) / LUT_N;
}

/**
 * Flatten to `n+1` XZ stations. Writes into `out` (a Float32Array of 2*(n+1))
 * when supplied, so per-frame previews never allocate.
 */
export function flatten(c, n, out = null) {
  const a = out && out.length >= (n + 1) * 2 ? out : new Float32Array((n + 1) * 2);
  const p = { x: 0, z: 0 };
  for (let i = 0; i <= n; i++) {
    bez(c, i / n, p);
    a[i * 2] = p.x; a[i * 2 + 1] = p.z;
  }
  return a;
}

/* ---------------------------------------------------------- intersection --- */

/**
 * 2-D segment/segment crossing. Returns the parameters {t, u} of the crossing
 * on AB and CD, or null when they do not properly cross.
 */
export function segCross(ax, az, bx, bz, cx, cz, dx, dz, out = { t: 0, u: 0 }) {
  const rx = bx - ax, rz = bz - az;
  const sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;          // parallel or degenerate
  const qpx = cx - ax, qpz = cz - az;
  const t = (qpx * sz - qpz * sx) / den;
  const u = (qpx * rz - qpz * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  out.t = t; out.u = u;
  return out;
}

/** Shortest distance from (px,pz) to the segment AB, plus the parameter. */
export function pointSeg(px, pz, ax, az, bx, bz, out = { d: 0, t: 0, x: 0, z: 0 }) {
  const ex = bx - ax, ez = bz - az;
  const L2 = ex * ex + ez * ez || 1e-9;
  let t = ((px - ax) * ex + (pz - az) * ez) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + ex * t, qz = az + ez * t;
  out.t = t; out.x = qx; out.z = qz;
  out.d = Math.hypot(px - qx, pz - qz);
  return out;
}

/** Signed angle between two headings, wrapped to (-pi, pi]. */
export function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}
