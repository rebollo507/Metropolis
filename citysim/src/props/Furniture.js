import { Builder, cell4 } from './Geo.js';

/**
 * Street furniture geometry. Every entry returns one or more *parts*; a part is
 * a (geometry, material) pair and therefore exactly one draw call for the whole
 * city. Parts that share a material still need their own geometry, so the count
 * here is the real cost — it is kept down by merging everything that shares a
 * material into a single builder (a whole lamp column, arm, collar and head are
 * one geometry, not four primitives).
 *
 * All dimensions are metres and chosen from real street furniture: an 8 m
 * column with a 1.9 m outreach for a 2-lane carriageway, a 6.4 m signal mast
 * with a 6.5 m arm so the primary head sits over the far lane, 0.9 m bollards,
 * 1.8 m bench, 2.4 m shelter roof.
 */

const TAU = Math.PI * 2;

/* -------------------------------------------------------------- helpers -- */

/** Tapered column with a base collar, built along +Y. */
function column(b, h, r0, r1, sides = 8, segs = 4) {
  const pts = [], rad = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push([0, t * h, 0]);
    rad.push(r0 + (r1 - r0) * Math.pow(t, 0.85));
  }
  b.tube(pts, rad, sides, 0.55, 0, 0, true);
  b.tube([[0, 0, 0], [0, 0.10, 0], [0, 0.42, 0]], [r0 * 1.55, r0 * 1.5, r0 * 1.12], sides, 0.4);
}

/** Quarter-circle outreach arm from (0,y0) to (reach, y1). */
function arm(b, y0, reach, rise, r0, r1, sides = 6) {
  const pts = [], rad = [];
  const N = 6;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const s = Math.sin(t * Math.PI * 0.5);
    const c = 1 - Math.cos(t * Math.PI * 0.5);
    pts.push([reach * s, y0 + rise * c, 0]);
    rad.push(r0 + (r1 - r0) * t);
  }
  b.tube(pts, rad, sides, 0.5);
}

/* --------------------------------------------------------------- lights -- */

export function streetLamp() {
  const body = new Builder();
  const H = 8.2, REACH = 1.95;
  column(body, H - 0.9, 0.135, 0.082, 8, 4);
  body.push();
  body.translate(0, H - 0.9, 0);
  arm(body, 0, REACH, 0.82, 0.078, 0.058, 6);
  body.pop();

  // lantern: a tapered flat-topped housing, nose down-street
  body.push();
  body.translate(REACH, H, 0);
  body.rotZ(-0.10);
  body.prism([
    [-0.36, -0.15], [0.44, -0.11], [0.44, 0.11], [-0.36, 0.15],
  ], -0.055, 0.135, 0.6);
  // cowl over the top so it is not a floating slab
  body.prism([
    [-0.30, -0.12], [0.38, -0.09], [0.38, 0.09], [-0.30, 0.12],
  ], 0.135, 0.185, 0.6);
  body.pop();

  const lens = new Builder();
  lens.push();
  lens.translate(REACH, H, 0);
  lens.rotZ(-0.10);
  lens.rotX(Math.PI / 2);
  lens.quadXY(0.04, 0, 0.72, 0.22, [0.02, 0.02, 0.30, 0.10], null, 0.062);
  lens.pop();

  return {
    body: body.build('props:lamp'),
    lens: lens.build('props:lampLens'),
    head: [REACH, H - 0.02, 0],
  };
}

export function parkLamp() {
  const body = new Builder();
  const H = 4.1;
  column(body, H, 0.085, 0.062, 8, 3);
  // four-sided lantern cage
  body.push();
  body.translate(0, H, 0);
  body.prism([[-0.16, -0.16], [0.16, -0.16], [0.16, 0.16], [-0.16, 0.16]], 0.0, 0.05, 0.4);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    body.push();
    body.translate(Math.cos(a) * 0.155, 0.28, Math.sin(a) * 0.155);
    body.box(0, 0, 0, 0.022, 0.5, 0.022, 0.3);
    body.pop();
  }
  // pyramid cap
  const cap = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    cap.push(body.v(Math.cos(a) * 0.21, 0.53, Math.sin(a) * 0.21, 0, 0.4, 0, i * 0.3, 0));
  }
  const apex = body.v(0, 0.72, 0, 0, 1, 0, 0.5, 0.5);
  for (let i = 0; i < 4; i++) body.tri(cap[i], cap[(i + 1) % 4], apex);
  body.pop();

  const lens = new Builder();
  lens.push();
  lens.translate(0, H + 0.30, 0);
  lens.blob(0, 0, 0, 0.135, 0.20, 0.135, 8, 0.4);
  lens.pop();

  return { body: body.build('props:parkLamp'), lens: lens.build('props:parkLampLens'), head: [0, H + 0.3, 0] };
}

/* --------------------------------------------------------------- signals -- */

export function trafficSignal() {
  const mast = new Builder();
  const MH = 6.6, REACH = 6.4;
  column(mast, MH, 0.165, 0.115, 10, 4);
  mast.push();
  mast.translate(0, MH - 1.1, 0);
  arm(mast, 0, REACH, 0.55, 0.115, 0.075, 8);
  mast.pop();

  const heads = new Builder();
  // one builder per aspect so each can be tinted (and dimmed) independently
  const lens = [new Builder(), new Builder(), new Builder()];
  // primary head over the far lane, secondary near the kerb
  const at = [REACH - 0.5, REACH * 0.44];
  for (let k = 0; k < 2; k++) {
    const x = at[k];
    const y = MH - 1.1 + 0.55 * (1 - Math.cos((x / REACH) * Math.PI * 0.5)) - 0.55;
    heads.push();
    heads.translate(x, y, 0);
    heads.box(0, 0, 0, 0.34, 1.02, 0.30, 0.5);       // housing
    heads.box(0, 0.58, 0, 0.38, 0.10, 0.34, 0.5);    // top cap
    heads.box(0, -0.58, 0, 0.30, 0.08, 0.28, 0.5);   // bottom
    heads.box(-0.20, 0, 0, 0.06, 1.02, 0.30, 0.4);   // mounting spine
    for (let i = 0; i < 3; i++) {                     // visors + aspects
      const yy = 0.30 - i * 0.30;
      heads.push();
      heads.translate(0, yy, 0.15);
      heads.prism([[-0.15, 0], [0.15, 0], [0.13, 0.20], [-0.13, 0.20]], -0.005, 0.03, 0.3);
      heads.pop();
      const L = lens[i];
      L.push();
      L.translate(x, y + yy, 0.162);
      L.blob(0, 0, 0, 0.105, 0.105, 0.035, 8, 0.3);
      L.pop();
    }
    heads.pop();
  }
  return {
    mast: mast.build('props:signalMast'),
    heads: heads.build('props:signalHeads'),
    lensR: lens[0].build('props:signalLensR'),
    lensA: lens[1].build('props:signalLensA'),
    lensG: lens[2].build('props:signalLensG'),
  };
}

/* ----------------------------------------------------------------- signs -- */

export function signPost({ h = 2.4, r = 0.032 } = {}) {
  const b = new Builder();
  column(b, h, r * 1.35, r, 6, 2);
  return b.build('props:signPost');
}

/** A flat sign face on one atlas cell, double-sided by the material. */
export function signFace(cellIndex, w, h, y) {
  const b = new Builder();
  b.quadXY(0, y, w, h, cell4(cellIndex));
  // thin back plate so it is not a zero-thickness card in raking light
  b.quadXY(0, y, w * 0.98, h * 0.98, cell4(15), null, -0.012);
  return b.build(`props:sign${cellIndex}`);
}

/** Street-name plate cantilevered off a lamp/sign post. */
export function namePlate() {
  const b = new Builder();
  b.push();
  b.translate(0.52, 2.55, 0);
  b.quadXY(0, 0, 1.05, 0.24, cell4(2));
  b.quadXY(0, 0, 1.05, 0.24, cell4(2), null, -0.02);
  b.pop();
  return b.build('props:namePlate');
}

/* ------------------------------------------------------ small furniture -- */

export function parkingMeter() {
  const b = new Builder();
  column(b, 1.05, 0.045, 0.040, 6, 1);
  b.push();
  b.translate(0, 1.05, 0);
  b.box(0, 0.20, 0, 0.19, 0.40, 0.14, 0.3);
  b.rotX(-0.30);
  b.box(0, 0.40, 0.05, 0.15, 0.14, 0.03, 0.3);   // display bezel
  b.pop();
  return b.build('props:meter');
}

export function hydrant() {
  const b = new Builder();
  b.tube([[0, 0, 0], [0, 0.07, 0], [0, 0.10, 0]], [0.20, 0.19, 0.145], 8, 0.3);
  b.tube([[0, 0.10, 0], [0, 0.52, 0], [0, 0.62, 0]], [0.135, 0.125, 0.10], 8, 0.3);
  b.blob(0, 0.64, 0, 0.135, 0.11, 0.135, 8, 0.3);
  b.push(); b.translate(0, 0.74, 0); b.tube([[0, 0, 0], [0, 0.10, 0]], [0.055, 0.045], 6, 0.2, 0, 0, true); b.pop();
  for (const s of [-1, 1]) {
    b.push();
    b.translate(s * 0.13, 0.42, 0);
    b.rotZ(s * Math.PI / 2);
    b.tube([[0, 0, 0], [0, 0.10, 0]], [0.075, 0.062], 6, 0.2, 0, 0, true);
    b.pop();
  }
  b.push();
  b.translate(0, 0.42, 0.13);
  b.rotX(-Math.PI / 2);
  b.tube([[0, 0, 0], [0, 0.11, 0]], [0.085, 0.070], 6, 0.2, 0, 0, true);
  b.pop();
  return b.build('props:hydrant');
}

export function litterBin() {
  const b = new Builder();
  // perforated drum on a stub post
  b.tube([[0, 0.28, 0], [0, 0.95, 0]], [0.235, 0.255], 10, 0.35);
  b.tube([[0, 0.95, 0], [0, 1.02, 0]], [0.275, 0.255], 10, 0.25, 0, 0, true);
  b.tube([[0, 0, 0], [0, 0.30, 0]], [0.055, 0.055], 6, 0.25);
  b.tube([[0, 0, 0], [0, 0.03, 0]], [0.15, 0.14], 8, 0.25, 0, 0, true);
  // banding
  for (const y of [0.40, 0.62, 0.84]) b.tube([[0, y, 0], [0, y + 0.035, 0]], [0.262, 0.262], 10, 0.25);
  return b.build('props:bin');
}

export function bench() {
  const frame = new Builder();
  const slats = new Builder();
  const L = 1.85;
  for (const s of [-1, 1]) {
    frame.push();
    frame.translate(s * (L / 2 - 0.16), 0, 0);
    // cast-iron end frame: two legs + a scrolled arm
    frame.box(0, 0.21, 0.22, 0.055, 0.42, 0.055, 0.3);
    frame.box(0, 0.21, -0.18, 0.055, 0.42, 0.055, 0.3);
    frame.box(0, 0.42, 0.02, 0.055, 0.045, 0.50, 0.3);
    frame.push();
    frame.translate(0, 0.44, -0.20);
    frame.rotX(-0.22);
    frame.box(0, 0.22, 0, 0.05, 0.48, 0.05, 0.3);
    frame.pop();
    frame.box(0, 0.66, 0.18, 0.05, 0.05, 0.42, 0.3);   // arm rest
    frame.pop();
  }
  for (let i = 0; i < 4; i++) {      // seat slats
    slats.box(0, 0.445, 0.20 - i * 0.135, L, 0.035, 0.105, 0.5);
  }
  for (let i = 0; i < 3; i++) {      // back slats
    slats.push();
    slats.translate(0, 0.55 + i * 0.16, -0.235 - i * 0.036);
    slats.rotX(-0.22);
    slats.box(0, 0, 0, L, 0.10, 0.032, 0.5);
    slats.pop();
  }
  return { frame: frame.build('props:benchFrame'), slats: slats.build('props:benchSlats') };
}

export function busShelter() {
  const frame = new Builder();
  const glass = new Builder();
  const W = 3.9, D = 1.55, H = 2.45;
  for (const x of [-W / 2 + 0.07, W / 2 - 0.07]) {
    for (const z of [-D / 2 + 0.06, D / 2 - 0.06]) {
      frame.tube([[x, 0, z], [x, H, z]], [0.055, 0.05], 6, 0.4);
    }
  }
  // roof: slight forward fall, with a fascia
  frame.push();
  frame.translate(0, H + 0.06, 0);
  frame.rotX(0.045);
  frame.box(0, 0, 0, W + 0.28, 0.09, D + 0.42, 0.7);
  frame.box(0, -0.075, (D + 0.42) / 2 - 0.03, W + 0.28, 0.10, 0.05, 0.4);
  frame.pop();
  // bench inside
  frame.box(0, 0.44, -D / 2 + 0.28, W - 0.5, 0.05, 0.36, 0.5);
  for (const x of [-W / 2 + 0.5, 0, W / 2 - 0.5]) frame.box(x, 0.22, -D / 2 + 0.28, 0.06, 0.42, 0.06, 0.3);
  // rear + side glazing bars
  frame.box(0, H / 2, -D / 2 + 0.06, W - 0.16, 0.045, 0.045, 0.4);

  glass.push();
  glass.translate(0, H / 2 + 0.1, -D / 2 + 0.06);
  glass.quadXY(0, 0, W - 0.22, H - 0.30, [0, 0, 1, 1]);
  glass.pop();
  for (const s of [-1, 1]) {
    glass.push();
    glass.translate(s * (W / 2 - 0.07), H / 2 + 0.1, 0);
    glass.rotY(Math.PI / 2);
    glass.quadXY(0, 0, D - 0.18, H - 0.30, [0, 0, 1, 1]);
    glass.pop();
  }
  return { frame: frame.build('props:shelter'), glass: glass.build('props:shelterGlass') };
}

export function mailbox() {
  const b = new Builder();
  b.box(0, 0.62, 0, 0.52, 0.86, 0.46, 0.5);
  b.push();
  b.translate(0, 1.05, 0);
  b.blob(0, 0, 0, 0.26, 0.16, 0.23, 10, 0.4);
  b.pop();
  b.box(0, 0.94, 0.24, 0.34, 0.10, 0.04, 0.3);    // slot lip
  b.box(0, 0.10, 0, 0.30, 0.20, 0.30, 0.3);       // plinth
  return b.build('props:mailbox');
}

export function bollard() {
  const b = new Builder();
  b.tube([[0, 0, 0], [0, 0.05, 0], [0, 0.86, 0]], [0.13, 0.115, 0.088], 8, 0.3);
  b.blob(0, 0.88, 0, 0.088, 0.075, 0.088, 8, 0.3);
  b.tube([[0, 0.66, 0], [0, 0.71, 0]], [0.098, 0.098], 8, 0.2);
  return b.build('props:bollard');
}

export function utilityCabinet() {
  const box = new Builder();
  const door = new Builder();
  const W = 1.05, H = 1.35, D = 0.46;
  box.box(0, H / 2 + 0.06, 0, W, H, D, 0.6);
  box.box(0, 0.03, 0, W + 0.10, 0.06, D + 0.10, 0.4);   // plinth
  box.push();
  box.translate(0, H + 0.10, 0);
  box.rotX(0.06);
  box.box(0, 0, 0, W + 0.09, 0.055, D + 0.09, 0.4);     // weather cap
  box.pop();
  door.quadXY(0, H / 2 + 0.06, W - 0.10, H - 0.14, cell4(14), null, D / 2 + 0.006);
  return { box: box.build('props:cabinet'), door: door.build('props:cabinetDoor') };
}

export function planter() {
  const b = new Builder();
  const n = 8, R = 0.62;
  const poly = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    poly.push([Math.cos(a) * R, Math.sin(a) * R]);
  }
  b.prism(poly, 0, 0.62, 0.7);
  const inner = poly.map(([x, z]) => [x * 0.86, z * 0.86]);
  b.prism(inner, 0.5, 0.66, 0.7);
  return b.build('props:planter');
}

export function newsBox() {
  const b = new Builder();
  b.box(0, 0.62, 0, 0.44, 0.80, 0.40, 0.4);
  b.push(); b.translate(0, 1.05, 0.02); b.rotX(-0.22);
  b.box(0, 0, 0, 0.44, 0.30, 0.36, 0.4);
  b.pop();
  for (const s of [-1, 1]) b.box(s * 0.16, 0.11, 0, 0.06, 0.22, 0.30, 0.3);
  return b.build('props:newsBox');
}

/** Wooden distribution pole with crossarm — carries the overhead wires. */
export function utilityPole() {
  const b = new Builder();
  const H = 8.6;
  b.tube([[0, 0, 0], [0, H * 0.5, 0], [0, H, 0]], [0.17, 0.145, 0.115], 7, 1.2, 0, 0, true);
  b.push();
  b.translate(0, H - 0.55, 0);
  b.box(0, 0, 0, 2.0, 0.10, 0.10, 0.5);
  b.box(0, -0.30, 0, 0.10, 0.36, 0.10, 0.4);
  b.pop();
  b.push();
  b.translate(0, H - 1.35, 0);
  b.box(0, 0, 0, 1.5, 0.09, 0.09, 0.5);
  b.pop();
  // insulators
  for (const x of [-0.85, -0.28, 0.28, 0.85]) {
    b.push(); b.translate(x, H - 0.42, 0);
    b.tube([[0, 0, 0], [0, 0.16, 0]], [0.055, 0.045], 6, 0.2, 0, 0, true);
    b.pop();
  }
  return b.build('props:utilityPole');
}

/** Light-pool gobo laid on the ground under a lamp. */
export function lightPool(size = 9.5) {
  const b = new Builder();
  b.quadXZ(0, 0, size, size, [0.001, 0.001, 0.999, 0.999], 0);
  return b.build('props:lightPool');
}

export default {
  streetLamp, parkLamp, trafficSignal, signPost, signFace, namePlate,
  parkingMeter, hydrant, litterBin, bench, busShelter, mailbox, bollard,
  utilityCabinet, planter, newsBox, utilityPole, lightPool,
};
