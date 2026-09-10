import * as THREE from 'three';
import { Builder, roundRect } from './Mesh.js';
import { VEH_NAMES, VEH_SPEC } from './Sim.js';

/**
 * Procedural vehicle geometry — six body types, three LOD tiers each.
 *
 * Cars are lofted through rounded-rectangle rings: a wide sill, a shoulder that
 * tucks back in (tumblehome), then a separate glazed band with a painted roof
 * over it. Vans, trucks and buses are the same machinery with a taller, squarer
 * ring stack and a raked screen. Wheels are real cylinders with a hub bore, and
 * they are baked into one geometry per type so a whole vehicle is 3-5 instances,
 * never one per wheel.
 *
 * Lamps live on their own geometry so tail lights can be brightened per instance
 * when a vehicle brakes, and headlights can be switched by time of day without
 * touching the paint material.
 *
 *   tier 0  < 70 m   body + glass + wheels + head lamps + tail lamps
 *   tier 1  < 210 m  body + wheels
 *   tier 2  beyond   body only, coarse rings
 */

const LOD_RES = [
  { corner: 4, wheelSeg: 12, glass: true, lamps: true },
  { corner: 2, wheelSeg: 6, glass: false, lamps: false },
  { corner: 1, wheelSeg: 0, glass: false, lamps: false },
];

/* Per-type shape parameters. All in metres; +Z is the front of the vehicle. */
const SHAPE = {
  car: {
    kind: 'car', ride: 0.235, sill: 0.60, shoulder: 0.98, roof: 1.46,
    cabinAt: -0.18, cabinLen: 2.26, wheelR: 0.345, wheelW: 0.105, axles: [1.36, -1.36],
    nose: 0.90, tail: 0.92, rakeF: 0.42, rakeR: 0.20,
  },
  taxi: {
    kind: 'car', ride: 0.245, sill: 0.62, shoulder: 1.00, roof: 1.50,
    cabinAt: -0.20, cabinLen: 2.44, wheelR: 0.350, wheelW: 0.108, axles: [1.44, -1.42],
    nose: 0.88, tail: 0.94, roofSign: true, rakeF: 0.38, rakeR: 0.17,
  },
  van: {
    kind: 'box', ride: 0.275, sill: 0.74, shoulder: 1.22, roof: 2.24,
    cabinAt: 0.85, cabinLen: 1.42, wheelR: 0.385, wheelW: 0.115, axles: [1.62, -1.46],
    nose: 0.62, tail: 0.99, screenRake: 0.30,
  },
  service: {
    kind: 'pickup', ride: 0.30, sill: 0.80, shoulder: 1.20, roof: 2.06,
    cabinAt: 0.86, cabinLen: 1.55, wheelR: 0.400, wheelW: 0.120, axles: [1.66, -1.52],
    nose: 0.66, tail: 0.99, bedFrom: -0.10, lightBar: true, rakeF: 0.30, rakeR: 0.10,
  },
  truck: {
    kind: 'rigid', ride: 0.42, sill: 1.00, shoulder: 1.42, roof: 3.10,
    cabinAt: 3.00, cabinLen: 2.10, wheelR: 0.520, wheelW: 0.145, axles: [2.60, -1.70, -3.00],
    nose: 0.50, tail: 0.99, boxFrom: 1.60, boxTo: -4.10, boxTop: 3.05,
  },
  bus: {
    kind: 'bus', ride: 0.36, sill: 0.86, shoulder: 1.30, roof: 3.18,
    cabinAt: 0, cabinLen: 0, wheelR: 0.495, wheelW: 0.140, axles: [4.05, -3.20, -4.55],
    nose: 0.985, tail: 0.985, beltline: 1.28, glassTop: 2.42,
  },
};

/* ------------------------------------------------------------- helpers --- */

function lowerBody(b, len, wid, p, n) {
  const rings = [
    { y: p.ride * 0.5, pts: roundRect(len * 0.52, wid * 0.70, 0.20, n) },
    { y: p.ride, pts: roundRect(len * 0.93, wid * 0.905, 0.22, n) },
    { y: p.sill * 0.70, pts: roundRect(len * 0.995, wid * 1.00, 0.26, n) },
    { y: p.shoulder * 0.88, pts: roundRect(len * (p.nose === 0.985 ? 1.0 : 0.998), wid, 0.30, n) },
    { y: p.shoulder, pts: roundRect(len * 0.965, wid * 0.945, 0.32, n) },
  ];
  // taper the nose and tail by scaling the corresponding half of each ring
  for (const r of rings) {
    for (const q of r.pts) {
      if (q[1] > 0) q[0] *= p.nose < 1 ? (1 - (1 - p.nose) * (q[1] / (len / 2)) * 0.55) : 1;
      else q[0] *= p.tail < 1 ? (1 - (1 - p.tail) * (-q[1] / (len / 2)) * 0.55) : 1;
    }
  }
  b.loft(rings, true, true, 1.4);
  return rings;
}

/**
 * The greenhouse. The thing that separates a car from a bread van is that the
 * windscreen rakes back hard and the backlight rakes rather less, so the cabin
 * leans: each ring above the beltline loses more length off its front than its
 * back and its centre shifts rearward with it.
 */
function greenhouse(bBody, bGlass, len, wid, p, n, withGlass) {
  const cl = p.cabinLen, cz = p.cabinAt;
  const gw = 0.905;
  const rakeF = p.rakeF ?? 0.40;   // fraction of cabin length eaten by the screen
  const rakeR = p.rakeR ?? 0.19;
  const ring = (u, w, r) => {
    const f = rakeF * u * cl, b = rakeR * u * cl;
    return { len: cl - f - b, cz: cz + (b - f) / 2, w, r };
  };
  const defs = [
    { y: p.shoulder - 0.02, u: 0.00, w: gw, r: 0.22 },
    { y: p.shoulder + (p.roof - p.shoulder) * 0.48, u: 0.46, w: gw - 0.045, r: 0.24 },
    { y: p.roof - 0.085, u: 0.92, w: gw - 0.115, r: 0.26 },
    { y: p.roof, u: 1.00, w: gw - 0.19, r: 0.26 },
  ];
  const rings = defs.map((d) => {
    const g = ring(d.u, wid * d.w, d.r);
    const pts = roundRect(Math.max(0.3, g.len * 1.02), g.w, d.r, n);
    for (const q of pts) q[1] += g.cz;
    return { y: d.y, pts };
  });
  if (withGlass) {
    bGlass.loft([rings[0], rings[1], rings[2]], false, false, 1.2);
    bBody.loft([rings[2], rings[3]], true, false, 1.2);
    // beltline lip so the glazing is not floating in the paint
    bBody.loft([
      { y: rings[0].y - 0.085, pts: rings[0].pts.map((q) => [q[0] * 1.03, q[1] * 1.005]) },
      { y: rings[0].y + 0.02, pts: rings[0].pts.map((q) => [q[0] * 1.015, q[1] * 1.002]) },
    ], false, false, 1.2);
  } else {
    bBody.loft(rings, true, false, 1.2);
  }
}

function boxBody(b, len, wid, p, n, fromZ, toZ, topY, baseY) {
  const cz = (fromZ + toZ) / 2, cl = Math.abs(fromZ - toZ);
  const rings = [
    { y: baseY, pts: roundRect(cl, wid * 0.99, 0.14, n) },
    { y: baseY + (topY - baseY) * 0.5, pts: roundRect(cl, wid, 0.16, n) },
    { y: topY - 0.10, pts: roundRect(cl * 0.998, wid * 0.99, 0.18, n) },
    { y: topY, pts: roundRect(cl * 0.97, wid * 0.94, 0.20, n) },
  ];
  for (const r of rings) for (const q of r.pts) q[1] += cz;
  b.loft(rings, true, true, 1.6);
}

/**
 * Wheels, plus the dark arch collar around each one. The collar goes on the
 * *rubber* builder, not the paint: a body-coloured ring is invisible, whereas a
 * near-black annulus reads exactly like the shadowed opening of a wheel arch and
 * is what stops a car looking as though it is riding on castors.
 */
/** Wing mirrors — tiny, but the strongest cheap silhouette cue a car has. */
function mirrors(b, len, wid, p) {
  const zy = p.kind === 'car' ? p.cabinAt + p.cabinLen * 0.42 : p.cabinAt + p.cabinLen * 0.34;
  const y = p.kind === 'car' ? p.shoulder + 0.05 : p.shoulder + 0.22;
  for (const sx of [-1, 1]) {
    b.box(sx * (wid * 0.50 + 0.045), y, zy, 0.09, 0.045, 0.10, 0.3);
    b.box(sx * (wid * 0.50 + 0.115), y + 0.015, zy, 0.075, 0.115, 0.16, 0.3);
  }
  void len;
}

/** Dark bumper bars. On the rubber builder so they contrast with the paint. */
function bumpers(b, len, wid, p) {
  const y = p.kind === 'car' ? p.sill - 0.10 : p.sill + 0.02;
  b.box(0, y, len / 2 - 0.055, wid * 0.955, 0.20, 0.11, 0.4);
  b.box(0, y, -len / 2 + 0.055, wid * 0.955, 0.20, 0.11, 0.4);
}

function wheels(b, len, wid, p, seg, withArch) {
  if (!seg) return;
  const track = wid * 0.5 - p.wheelW - 0.012;
  const steerZ = Math.max(...p.axles);          // the front axle steers
  b.extra = b.extra || [];
  for (const z of p.axles) {
    for (const sx of [-1, 1]) {
      // aWheel = (hub xyz, flags) where flags is 1 for a wheel and 3 if it also
      // steers. The hub has to carry its own x or a steered wheel swings out
      // sideways instead of turning on the spot.
      const hx = sx * track;
      b.extraValue = [hx, p.wheelR, z, z === steerZ ? 3 : 1];
      b.wheel(hx, p.wheelR, z, p.wheelR, p.wheelW, seg, p.wheelR * 0.44);
      if (!withArch) continue;
      // the arch collar belongs to the body, so it must NOT turn with the wheel
      b.extraValue = [0, 0, 0, 0];
      b.push();
      b.translate(hx + sx * (p.wheelW - 0.02), p.wheelR, z);
      b.wheel(0, 0, 0, p.wheelR * 1.20, 0.035, Math.max(8, seg), p.wheelR * 1.02);
      b.pop();
    }
  }
  b.extraValue = [0, 0, 0, 0];
  void len;
}

/**
 * Panel shut-lines. Two thin dark slots per side at the door gaps plus a bonnet
 * and boot seam. They go on the dark trim builder rather than the paint, because
 * a body-coloured groove of this depth is invisible: what reads at twenty metres
 * is the dark line, not the geometry.
 */
function shutLines(b, len, wid, p) {
  const y0 = p.sill * 0.55, y1 = p.shoulder - 0.03;
  const h = Math.max(0.12, y1 - y0);
  const cy = (y0 + y1) / 2;
  const seams = p.kind === 'car'
    ? [p.cabinAt + p.cabinLen * 0.46, p.cabinAt - p.cabinLen * 0.10, p.cabinAt - p.cabinLen * 0.56]
    : [p.cabinAt - p.cabinLen * 0.52];
  for (const sx of [-1, 1]) {
    for (const z of seams) {
      b.box(sx * (wid * 0.5 - 0.004), cy, z, 0.014, h, 0.022, 0.3);
    }
  }
  if (p.kind === 'car') {
    b.box(0, p.sill * 0.86, p.cabinAt + p.cabinLen * 0.62, wid * 0.80, 0.02, 0.018, 0.3);
    b.box(0, p.shoulder - 0.02, p.cabinAt - p.cabinLen * 0.62, wid * 0.72, 0.02, 0.018, 0.3);
  }
}

/* ------------------------------------------------------------- lamps ----- */

function lamps(bF, bR, len, wid, p) {
  const zF = len / 2 - 0.015, zR = -len / 2 + 0.015;
  const y = p.kind === 'car' ? p.sill + 0.06 : p.sill + 0.22;
  const w = wid * 0.235, h = p.kind === 'car' ? 0.155 : 0.20;
  for (const sx of [-1, 1]) {
    bF.push(); bF.translate(sx * wid * 0.315, y, zF); bF.plate(0, 0, 0, w, h); bF.pop();
    bR.push(); bR.translate(sx * wid * 0.325, y + 0.06, zR); bR.rotY(Math.PI); bR.plate(0, 0, 0, w, h * 1.15); bR.pop();
  }
  // high-level brake lamp
  if (p.kind === 'car') {
    bR.push(); bR.translate(0, p.roof - 0.08, p.cabinAt - p.cabinLen * 0.5 + 0.04);
    bR.rotY(Math.PI); bR.plate(0, 0, 0, wid * 0.34, 0.045); bR.pop();
  }
}

/* --------------------------------------------------------------- build --- */

export function buildVehicle(typeIndex, lod) {
  const name = VEH_NAMES[typeIndex];
  const spec = VEH_SPEC[typeIndex];
  const p = SHAPE[name];
  const res = LOD_RES[lod];
  const n = res.corner;
  const len = spec.len, wid = spec.wid;

  const body = new Builder();
  const glass = new Builder();
  const wh = new Builder();
  const lampF = new Builder();
  const lampR = new Builder();

  if (p.kind === 'car') {
    lowerBody(body, len, wid, p, n);
    greenhouse(body, glass, len, wid, p, n, res.glass);
    if (lod === 0) {
      // grille + bumper relief
      body.box(0, p.sill - 0.05, len * 0.485, wid * 0.56, 0.17, 0.05, 0.3);
      body.box(0, p.sill - 0.02, -len * 0.487, wid * 0.60, 0.14, 0.05, 0.3);
      if (p.roofSign) body.box(0, p.roof + 0.075, p.cabinAt + 0.15, 0.62, 0.15, 0.24, 0.3);
    }
  } else if (p.kind === 'box') {
    // van: a cab that flows straight into a tall body
    const rings = [
      { y: p.ride * 0.55, pts: roundRect(len * 0.55, wid * 0.72, 0.22, n) },
      { y: p.ride, pts: roundRect(len * 0.94, wid * 0.92, 0.28, n) },
      { y: p.sill * 0.72, pts: roundRect(len * 0.998, wid, 0.30, n) },
      { y: p.shoulder, pts: roundRect(len * 0.998, wid, 0.30, n) },
      { y: p.roof * 0.62, pts: roundRect(len * 0.99, wid, 0.28, n) },
      { y: p.roof - 0.10, pts: roundRect(len * 0.97, wid * 0.99, 0.26, n) },
      { y: p.roof, pts: roundRect(len * 0.93, wid * 0.92, 0.26, n) },
    ];
    // rake the screen: pull the top-front of the upper rings back
    for (let i = 4; i < rings.length; i++) {
      const f = (i - 3) / 3;
      for (const q of rings[i].pts) if (q[1] > 0) q[1] -= p.screenRake * f * len * 0.16;
    }
    body.loft(rings, true, true, 1.6);
    if (res.glass) {
      const gy0 = p.shoulder + 0.10, gy1 = p.roof - 0.34;
      glass.push();
      glass.translate(0, 0, p.cabinAt);
      const gr = [
        { y: gy0, pts: roundRect(p.cabinLen * 1.10, wid * 1.006, 0.18, n) },
        { y: (gy0 + gy1) / 2, pts: roundRect(p.cabinLen * 1.06, wid * 1.008, 0.18, n) },
        { y: gy1, pts: roundRect(p.cabinLen * 0.92, wid * 1.002, 0.18, n) },
      ];
      glass.loft(gr, false, false, 1.2);
      glass.pop();
      // raked windscreen across the front face
      glass.push();
      glass.translate(0, (gy0 + gy1) / 2 + 0.06, len / 2 - 0.30);
      glass.rotX(-0.30);
      glass.plate(0, 0, 0.06, wid * 0.90, (gy1 - gy0) * 1.35);
      glass.pop();
    }
  } else if (p.kind === 'pickup') {
    // service utility: cab plus an open bed with a headboard
    const rings = [
      { y: p.ride * 0.55, pts: roundRect(len * 0.56, wid * 0.72, 0.22, n) },
      { y: p.ride, pts: roundRect(len * 0.95, wid * 0.92, 0.28, n) },
      { y: p.sill * 0.74, pts: roundRect(len * 0.998, wid, 0.30, n) },
      { y: p.shoulder, pts: roundRect(len * 0.998, wid, 0.30, n) },
    ];
    body.loft(rings, true, true, 1.6);
    // cab
    body.push();
    body.translate(0, 0, p.cabinAt);
    const cr = [
      { y: p.shoulder - 0.02, pts: roundRect(p.cabinLen * 1.04, wid * 0.96, 0.24, n) },
      { y: p.shoulder + (p.roof - p.shoulder) * 0.55, pts: roundRect(p.cabinLen, wid * 0.94, 0.24, n) },
      { y: p.roof - 0.06, pts: roundRect(p.cabinLen * 0.90, wid * 0.90, 0.22, n) },
      { y: p.roof, pts: roundRect(p.cabinLen * 0.80, wid * 0.84, 0.20, n) },
    ];
    if (res.glass) {
      glass.push(); glass.translate(0, 0, p.cabinAt);
      glass.loft([cr[0], cr[1], cr[2]], false, false, 1.2);
      glass.pop();
      body.loft([cr[2], cr[3]], true, false, 1.2);
    } else body.loft(cr, true, false, 1.2);
    body.pop();
    // bed sides
    const bz0 = p.bedFrom, bz1 = -len / 2 + 0.10;
    for (const sx of [-1, 1]) {
      body.box(sx * wid * 0.455, p.shoulder + 0.19, (bz0 + bz1) / 2, wid * 0.09, 0.40, Math.abs(bz1 - bz0), 0.4);
    }
    body.box(0, p.shoulder + 0.19, bz1, wid * 0.96, 0.40, 0.10, 0.4);
    body.box(0, p.shoulder + 0.20, bz0 + 0.02, wid * 0.94, 0.42, 0.08, 0.4);
    if (p.lightBar && lod === 0) body.box(0, p.roof + 0.055, p.cabinAt - 0.30, wid * 0.66, 0.11, 0.16, 0.3);
  } else if (p.kind === 'rigid') {
    // rigid box truck: chassis rails, a cab-over cab, a body
    body.box(0, p.ride + 0.28, 0.2, wid * 0.72, 0.22, len * 0.90, 0.5);
    body.push(); body.translate(0, 0, p.cabinAt);
    const cr = [
      { y: p.ride + 0.36, pts: roundRect(p.cabinLen * 0.98, wid * 0.94, 0.22, n) },
      { y: p.sill + 0.20, pts: roundRect(p.cabinLen, wid, 0.26, n) },
      { y: p.roof * 0.62, pts: roundRect(p.cabinLen, wid, 0.26, n) },
      { y: p.roof * 0.86 - 0.06, pts: roundRect(p.cabinLen * 0.97, wid * 0.98, 0.24, n) },
      { y: p.roof * 0.86, pts: roundRect(p.cabinLen * 0.88, wid * 0.90, 0.22, n) },
    ];
    body.loft(cr, true, true, 1.6);
    body.pop();
    if (res.glass) {
      glass.push(); glass.translate(0, 0, p.cabinAt + p.cabinLen * 0.30);
      glass.loft([
        { y: p.sill + 0.42, pts: roundRect(p.cabinLen * 0.50, wid * 0.955, 0.18, n) },
        { y: p.roof * 0.72, pts: roundRect(p.cabinLen * 0.46, wid * 0.95, 0.18, n) },
      ], false, false, 1.2);
      glass.pop();
    }
    boxBody(body, len, wid, p, n, p.boxFrom, p.boxTo, p.boxTop, p.sill + 0.10);
    if (lod === 0) {
      // side skirt + rear bumper
      body.box(0, p.sill + 0.02, (p.boxTo - 0.16), wid * 0.90, 0.16, 0.14, 0.4);
    }
  } else {
    // bus: one long shell with a deep glazed band
    const rings = [
      { y: p.ride * 0.6, pts: roundRect(len * 0.90, wid * 0.80, 0.30, n) },
      { y: p.ride + 0.10, pts: roundRect(len * 0.97, wid * 0.94, 0.36, n) },
      { y: p.sill, pts: roundRect(len * 0.999, wid, 0.42, n) },
      { y: p.beltline, pts: roundRect(len, wid, 0.44, n) },
      { y: p.glassTop, pts: roundRect(len * 0.998, wid * 0.995, 0.44, n) },
      { y: p.roof - 0.16, pts: roundRect(len * 0.99, wid * 0.98, 0.44, n) },
      { y: p.roof, pts: roundRect(len * 0.96, wid * 0.90, 0.42, n) },
    ];
    body.loft(rings, true, true, 1.8);
    if (res.glass) {
      glass.loft([
        { y: p.beltline + 0.02, pts: roundRect(len * 0.985, wid * 1.006, 0.44, n) },
        { y: (p.beltline + p.glassTop) / 2, pts: roundRect(len * 0.99, wid * 1.008, 0.44, n) },
        { y: p.glassTop - 0.04, pts: roundRect(len * 0.982, wid * 1.004, 0.44, n) },
      ], false, false, 1.4);
    }
    if (lod === 0) {
      body.box(0, p.roof + 0.10, 1.2, wid * 0.62, 0.20, 2.2, 0.5);   // AC pod
    }
  }

  wheels(wh, len, wid, p, res.wheelSeg, lod === 0);
  if (lod === 0) { bumpers(wh, len, wid, p); mirrors(body, len, wid, p); shutLines(wh, len, wid, p); }
  if (res.lamps) lamps(lampF, lampR, len, wid, p);

  const out = {
    body: body.build(`traffic:${name}:body:${lod}`),
    tris: body.triangles + wh.triangles + glass.triangles,
  };
  if (res.wheelSeg) {
    out.wheels = wh.build(`traffic:${name}:wheels:${lod}`);
    if (wh.extra && wh.extra.length) {
      const n = out.wheels.attributes.position.count;
      const a = new Float32Array(n * 4);
      a.set(wh.extra.subarray ? wh.extra.subarray(0, n * 4) : wh.extra.slice(0, n * 4));
      out.wheels.setAttribute('aWheel', new THREE.Float32BufferAttribute(a, 4));
    }
  }
  if (res.glass && glass.pos.length) out.glass = glass.build(`traffic:${name}:glass:${lod}`);
  if (res.lamps) {
    out.lampF = lampF.build(`traffic:${name}:lampF`);
    out.lampR = lampR.build(`traffic:${name}:lampR`);
  }
  out.length = len;
  out.width = wid;
  out.wheelR = p.wheelR;
  out.height = p.roof;
  return out;
}

/**
 * Deterministic, plausible paint. Mostly greys; bright cars are rare.
 *
 * Colours are authored as **sRGB** and converted: three's working colour space
 * is linear-sRGB, so a bare `setHSL(h, s, 0.28)` writes 0.28 *linear*, which
 * displays around 0.58 sRGB — every car comes out chalky. Passing the colour
 * space explicitly is what keeps a black car black.
 */
const SRGB = THREE.SRGBColorSpace;

export function paint(rng, out, typeIndex) {
  if (typeIndex === 1) { out.setHSL(0.125, 0.88, 0.50, SRGB); return out; }   // taxi
  if (typeIndex === 5) {                                                // bus livery
    const r = rng.next();
    if (r < 0.5) out.setHSL(0.02, 0.58, 0.36, SRGB);
    else if (r < 0.8) out.setHSL(0.56, 0.45, 0.34, SRGB);
    else out.setHSL(0.33, 0.32, 0.32, SRGB);
    return out;
  }
  if (typeIndex === 3) {                                                // service white/orange
    const r = rng.next();
    if (r < 0.6) out.setHSL(0.1, 0.03, 0.80, SRGB);
    else out.setHSL(0.08, 0.66, 0.48, SRGB);
    return out;
  }
  const roll = rng.next();
  let h, s, l;
  if (roll < 0.22) { h = rng.range(0, 1); s = rng.range(0.0, 0.04); l = rng.range(0.58, 0.82); }
  else if (roll < 0.50) { h = rng.range(0.55, 0.66); s = rng.range(0.02, 0.12); l = rng.range(0.12, 0.27); }
  else if (roll < 0.70) { h = rng.range(0.0, 0.06); s = rng.range(0.0, 0.05); l = rng.range(0.035, 0.09); }
  else if (roll < 0.81) { h = rng.range(0.55, 0.63); s = rng.range(0.35, 0.62); l = rng.range(0.16, 0.34); }
  else if (roll < 0.89) { h = rng.range(0.98, 1.02); s = rng.range(0.45, 0.72); l = rng.range(0.20, 0.34); }
  else if (roll < 0.95) { h = rng.range(0.28, 0.42); s = rng.range(0.18, 0.42); l = rng.range(0.16, 0.30); }
  else { h = rng.range(0.08, 0.14); s = rng.range(0.30, 0.60); l = rng.range(0.30, 0.52); }
  out.setHSL(((h % 1) + 1) % 1, s, l, SRGB);
  return out;
}

export default { buildVehicle, paint };
