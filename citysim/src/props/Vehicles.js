import { Builder } from './Geo.js';

/**
 * Parked cars. `traffic` owns anything that moves — these only ever go into
 * stationary bays (legal kerbside parking away from junctions, crossings and
 * hydrants, plus off-street lot parking), so the two modules cannot fight over
 * the same metre of road.
 *
 * Each car is three parts: painted body (tinted per instance), glazing, and a
 * wheel set with all four wheels baked in so a car is one instance, not five.
 * Bodies are lofted from real-ish cross sections — a tumblehome at the shoulder
 * and a raked screen are what stop a "car" from reading as a rounded box.
 */

/** Rounded rectangle in the XZ plane, centred on the origin. */
function roundRect(len, wid, r, n = 5) {
  const hx = wid / 2 - r, hz = len / 2 - r;
  const pts = [];
  const corners = [[hx, hz], [-hx, hz], [-hx, -hz], [hx, -hz]];
  const start = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i <= n; i++) {
      const a = start[c] + (i / n) * (Math.PI / 2);
      pts.push([corners[c][0] + Math.cos(a) * r, corners[c][1] + Math.sin(a) * r]);
    }
  }
  return pts;
}

/**
 * Stitch a stack of equal-length rings into a shell, with exact normals taken
 * from the two surface tangents (around the ring, and up the stack). Doing it
 * here rather than with computeVertexNormals keeps the hard edges of the boxes
 * that share the same geometry (lamps, pillars, arch lips) crisp.
 */
function loft(b, rings, uvS = 1.2, capTop = true, capBottom = true) {
  const R = rings.length, N = rings[0].pts.length;
  const P = rings.map((r) => r.pts.map((p) => [p[0], r.y, p[1]]));
  const ids = [];
  let flip = 0;
  for (let j = 0; j < R; j++) {
    const row = [];
    for (let i = 0; i < N; i++) {
      const p = P[j][i];
      const a = P[j][(i + 1) % N], c = P[j][(i - 1 + N) % N];
      const tu = [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
      const hi = P[Math.min(R - 1, j + 1)][i], lo = P[Math.max(0, j - 1)][i];
      const tv = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
      let n = [
        tv[1] * tu[2] - tv[2] * tu[1],
        tv[2] * tu[0] - tv[0] * tu[2],
        tv[0] * tu[1] - tv[1] * tu[0],
      ];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      n = [n[0] / l, n[1] / l, n[2] / l];
      // fix the winding sign once, from the first vertex of the first ring,
      // where the outward direction is unambiguously radial
      if (j === 0 && i === 0) flip = (n[0] * p[0] + n[2] * p[2]) < 0 ? -1 : 1;
      row.push(b.v(p[0], p[1], p[2], n[0] * flip, n[1] * flip, n[2] * flip,
        (i / N) * 3 / uvS, p[1] / uvS));
    }
    ids.push(row);
  }
  for (let j = 0; j < R - 1; j++) {
    const A = ids[j], B = ids[j + 1];
    for (let i = 0; i < N; i++) {
      const k = (i + 1) % N;
      // CCW in (x,z) becomes CW once lifted into 3D — wind up the stack first
      b.face(A[i], B[i], B[k], A[k]);
    }
  }
  const fan = (ring, y, up) => {
    const c = [];
    for (let i = 0; i < N; i++) {
      const p = ring[i];
      c.push(b.v(p[0], p[1], p[2], 0, up, 0, (p[0] + 4) / uvS, (p[2] + 4) / uvS));
    }
    const centre = b.v(0, y, 0, 0, up, 0, 0.5, 0.5);
    for (let i = 0; i < N; i++) {
      const k = (i + 1) % N;
      if (up > 0) b.tri(centre, c[k], c[i]); else b.tri(centre, c[i], c[k]);
    }
  };
  if (capTop) fan(P[R - 1], rings[R - 1].y, 1);
  if (capBottom) fan(P[0], rings[0].y, -1);
  return ids;
}

const TYPES = {
  // cabinAt = centre of the greenhouse along Z (+Z is the front of the car)
  sedan: { len: 4.62, wid: 1.81, wheelbase: 2.72, ride: 0.24, sill: 0.62, shoulder: 0.98, roof: 1.47,
    cabinAt: -0.16, cabinLen: 2.32, wheelR: 0.33 },
  hatch: { len: 4.06, wid: 1.77, wheelbase: 2.58, ride: 0.23, sill: 0.63, shoulder: 1.00, roof: 1.52,
    cabinAt: -0.34, cabinLen: 2.46, wheelR: 0.32 },
  van:   { len: 5.28, wid: 1.96, wheelbase: 3.08, ride: 0.28, sill: 0.76, shoulder: 1.20, roof: 2.28,
    cabinAt: 0.60, cabinLen: 1.60, wheelR: 0.37 },
};

export const CAR_TYPES = Object.keys(TYPES);

export function buildCar(type) {
  const t = TYPES[type] || TYPES.sedan;
  const body = new Builder();
  const glass = new Builder();
  const wheels = new Builder();
  const van = type === 'van';

  /* --- lower body: 4 rings with a tumblehome ------------------------- */
  const rings = [
    { y: t.ride * 0.55, pts: roundRect(t.len * 0.50, t.wid * 0.70, 0.28), ny: -0.9 },
    { y: t.ride, pts: roundRect(t.len * 0.94, t.wid * 0.90, 0.34), ny: -0.4 },
    { y: t.sill * 0.72, pts: roundRect(t.len * 0.995, t.wid, 0.42), ny: 0.05 },
    { y: t.shoulder * 0.86, pts: roundRect(t.len, t.wid * 0.995, 0.50), ny: 0.2 },
    { y: t.shoulder, pts: roundRect(t.len * 0.965, t.wid * 0.93, 0.52), ny: 0.9 },
  ];
  loft(body, rings, 1.4, true, true);

  /* --- greenhouse ------------------------------------------------------
     Built as a *band* of glazing with a painted roof over it, not a closed
     shell: an opaque cabin with the panes tucked inside is what makes a car
     read as a doorstop. Bands 0-2 go on the glass material, band 2-3 plus the
     top cap go on the paint. */
  const cl = t.cabinLen;
  const cz = t.cabinAt;
  const gw = van ? 0.94 : 0.90;
  const cabin = [
    { y: t.shoulder - 0.02, pts: roundRect(cl * 1.02, t.wid * gw, 0.40), ny: 0 },
    { y: t.shoulder + (t.roof - t.shoulder) * 0.52, pts: roundRect(cl * 0.97, t.wid * (gw - 0.05), 0.42), ny: 0.15 },
    { y: t.roof - 0.10, pts: roundRect(cl * 0.86, t.wid * (gw - 0.14), 0.42), ny: 0.55 },
    { y: t.roof, pts: roundRect(cl * 0.74, t.wid * (gw - 0.22), 0.38), ny: 1 },
  ];
  for (const r of cabin) for (const p of r.pts) p[1] += cz;

  // glazed band (beltline -> just under the roof), no caps
  loft(glass, [cabin[0], cabin[1], cabin[2]], 1.2, false, false);
  // painted roof panel + a beltline lip so the glass is not floating
  loft(body, [cabin[2], cabin[3]], 1.2, true, false);
  {
    const lip = [
      { y: cabin[0].y - 0.09, pts: cabin[0].pts.map((q) => [q[0] * 1.02, q[1]]), ny: -0.2 },
      { y: cabin[0].y + 0.02, pts: cabin[0].pts.map((q) => [q[0] * 1.01, q[1]]), ny: 0.3 },
    ];
    loft(body, lip, 1.2, false, false);
  }

  /* --- lamps + grille as shallow relief ------------------------------ */
  for (const s of [-1, 1]) {
    body.box(s * (t.wid * 0.34), t.sill + 0.10, t.len * 0.485, t.wid * 0.22, 0.16, 0.05, 0.3);
    body.box(s * (t.wid * 0.34), t.sill + 0.14, -t.len * 0.485, t.wid * 0.24, 0.14, 0.05, 0.3);
  }
  body.box(0, t.sill - 0.06, t.len * 0.487, t.wid * 0.52, 0.18, 0.04, 0.3);

  /* --- wheels + arches ------------------------------------------------ */
  const track = t.wid * 0.428;
  for (const sz of [1, -1]) {
    for (const sx of [-1, 1]) {
      const zz = sz * t.wheelbase / 2;
      wheels.push();
      wheels.translate(sx * track, t.wheelR, zz);
      wheels.rotZ(Math.PI / 2);
      wheels.tube([[0, -0.11, 0], [0, 0.11, 0]], [t.wheelR, t.wheelR], 12, 0.5, 0, 0, false);
      // sidewalls + a hub so a wheel is not an open tube
      wheels.tube([[0, 0.10, 0], [0, 0.115, 0]], [t.wheelR, t.wheelR * 0.55], 12, 0.4, 0, 0, true);
      wheels.tube([[0, -0.115, 0], [0, -0.10, 0]], [t.wheelR * 0.55, t.wheelR], 12, 0.4, 0, 0, true);
      wheels.pop();
      // arch lip, on the paint
      body.push();
      body.translate(sx * (t.wid * 0.47), t.wheelR, zz);
      body.rotZ(Math.PI / 2);
      body.tube([[0, -0.02, 0], [0, 0.02, 0]], [t.wheelR * 1.28, t.wheelR * 1.28], 10, 0.4);
      body.pop();
    }
  }

  return {
    body: body.build(`props:car:${type}`),
    glass: glass.build(`props:carGlass:${type}`),
    wheels: wheels.build(`props:carWheels:${type}`),
    length: t.len,
    width: t.wid,
  };
}

/** Deterministic, plausible car paint. Mostly greys — bright cars are rare. */
export function carColor(rng, out) {
  const roll = rng.next();
  let h, s, l;
  if (roll < 0.20) { h = rng.range(0, 1); s = rng.range(0.0, 0.04); l = rng.range(0.56, 0.80); }      // white/silver
  else if (roll < 0.48) { h = rng.range(0.55, 0.66); s = rng.range(0.02, 0.12); l = rng.range(0.11, 0.26); } // dark grey
  else if (roll < 0.68) { h = rng.range(0.0, 0.06); s = rng.range(0.0, 0.05); l = rng.range(0.03, 0.09); }   // black
  else if (roll < 0.80) { h = rng.range(0.55, 0.63); s = rng.range(0.35, 0.62); l = rng.range(0.16, 0.34); } // blue
  else if (roll < 0.88) { h = rng.range(0.98, 1.02); s = rng.range(0.45, 0.72); l = rng.range(0.20, 0.34); } // red
  else if (roll < 0.94) { h = rng.range(0.28, 0.42); s = rng.range(0.18, 0.42); l = rng.range(0.16, 0.30); } // green
  else { h = rng.range(0.08, 0.14); s = rng.range(0.30, 0.60); l = rng.range(0.30, 0.52); }                  // beige/tan
  out.setHSL(((h % 1) + 1) % 1, s, l);
  return out;
}

export default { buildCar, carColor, CAR_TYPES };