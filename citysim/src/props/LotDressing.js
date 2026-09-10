import { Builder, cell4 } from './Geo.js';

/**
 * Lot dressing — the things that make a plot read as *occupied* rather than as a
 * building standing on grass: boundary treatment, a driveway, a garden path,
 * outbuildings, garden furniture on residential; docks, skips, pallets and
 * tanks on industrial; awnings, fascias, A-boards and café seating on
 * commercial frontage.
 *
 * Roof plant is deliberately absent: `src/buildings/Roofs.js` already emits HVAC
 * units, tanks, dishes, bulkheads and pipe runs inside the parapet, and doing it
 * twice would double-dress every roof in the city.
 */

const TAU = Math.PI * 2;

/* ------------------------------------------------------------ boundaries -- */

/** 2 m of picket fence, origin centred, running along X. */
export function fencePanel(rng) {
  const b = new Builder();
  const L = 2.0;
  for (const x of [-L / 2, L / 2]) {
    b.box(x, 0.52, 0, 0.09, 1.04, 0.09, 0.4);
    b.push(); b.translate(x, 1.06, 0); b.rotY(Math.PI / 4);
    b.box(0, 0, 0, 0.10, 0.06, 0.10, 0.3); b.pop();
  }
  for (const y of [0.28, 0.78]) b.box(0, y, 0, L, 0.07, 0.035, 0.5);
  const n = 11;
  for (let i = 0; i < n; i++) {
    const x = -L / 2 + 0.09 + (i + 0.5) * ((L - 0.18) / n);
    const h = 0.94 + (rng ? rng.range(-0.02, 0.02) : 0);
    b.box(x, h / 2, 0.035, 0.072, h, 0.022, 0.4);
    // pointed top
    b.push(); b.translate(x, h, 0.035); b.rotZ(Math.PI / 4);
    b.box(0, 0, 0, 0.051, 0.051, 0.022, 0.3); b.pop();
  }
  return b.build('props:fence');
}

/** 2 m of low garden wall with a coping. */
export function gardenWall() {
  const b = new Builder();
  b.box(0, 0.42, 0, 2.0, 0.84, 0.24, 0.9);
  return b.build('props:wall');
}

export function wallCoping() {
  const b = new Builder();
  b.box(0, 0.885, 0, 2.02, 0.09, 0.32, 0.5);
  return b.build('props:coping');
}

/* ---------------------------------------------------------- outbuildings -- */

export function shed() {
  const b = new Builder();
  const W = 2.4, D = 1.9, H = 2.0;
  b.box(0, H / 2, 0, W, H, D, 0.8);
  // mono-pitch roof
  b.push();
  b.translate(0, H, 0);
  b.rotX(0.20);
  b.box(0, 0.06, 0, W + 0.22, 0.09, D + 0.26, 0.7);
  b.pop();
  // door + window frame relief
  b.box(-0.5, 0.92, D / 2 + 0.015, 0.78, 1.84, 0.035, 0.5);
  b.box(0.62, 1.30, D / 2 + 0.015, 0.56, 0.52, 0.035, 0.4);
  return b.build('props:shed');
}

export function garage() {
  const b = new Builder();
  const W = 3.3, D = 5.6, H = 2.5;
  b.box(0, H / 2, 0, W, H, D, 1.2);
  b.push(); b.translate(0, H, 0); b.rotX(0.13);
  b.box(0, 0.08, 0, W + 0.3, 0.12, D + 0.3, 1.0);
  b.pop();
  return b.build('props:garage');
}

export function garageDoor() {
  const b = new Builder();
  const W = 2.7, H = 2.05;
  for (let i = 0; i < 6; i++) {
    b.box(0, 0.06 + (i + 0.5) * (H / 6), 0, W, H / 6 - 0.02, 0.055, 0.4);
  }
  return b.build('props:garageDoor');
}

/* ---------------------------------------------------------------- garden -- */

export function poolCoping() {
  const b = new Builder();
  const W = 4.4, D = 2.8, t = 0.34;
  b.box(0, 0.06, D / 2 + t / 2, W + t * 2, 0.12, t, 0.6);
  b.box(0, 0.06, -D / 2 - t / 2, W + t * 2, 0.12, t, 0.6);
  b.box(W / 2 + t / 2, 0.06, 0, t, 0.12, D, 0.6);
  b.box(-W / 2 - t / 2, 0.06, 0, t, 0.12, D, 0.6);
  // basin walls so it is not a floating puddle
  b.prism([[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]], -1.3, 0.02, 0.8);
  return b.build('props:poolCoping');
}

export function poolWater() {
  const b = new Builder();
  b.quadXZ(0, 0, 4.4, 2.8, [0, 0, 3, 2], -0.16);
  return b.build('props:poolWater');
}

export function patioTableTop() {
  const b = new Builder();
  const n = 12, R = 0.44;
  const poly = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * TAU; poly.push([Math.cos(a) * R, Math.sin(a) * R]); }
  b.prism(poly, 0.70, 0.745, 0.5);
  return b.build('props:tableTop');
}

export function patioTableBase() {
  const b = new Builder();
  b.tube([[0, 0, 0], [0, 0.70, 0]], [0.055, 0.042], 6, 0.3);
  b.tube([[0, 0, 0], [0, 0.035, 0]], [0.26, 0.24], 10, 0.3, 0, 0, true);
  return b.build('props:tableBase');
}

export function patioChair() {
  const b = new Builder();
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.tube([[sx * 0.19, 0, sz * 0.19], [sx * 0.19, 0.44, sz * 0.19]], [0.022, 0.02], 5, 0.25);
  }
  b.box(0, 0.45, 0, 0.44, 0.035, 0.44, 0.4);
  b.push(); b.translate(0, 0.46, -0.20); b.rotX(-0.16);
  b.box(0, 0.24, 0, 0.44, 0.48, 0.03, 0.4);
  b.pop();
  return b.build('props:chair');
}

export function parasolCanopy() {
  const b = new Builder();
  const n = 8, R = 1.35, H = 2.20;
  const rim = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    rim.push(b.v(Math.cos(a) * R, H - 0.34, Math.sin(a) * R, Math.cos(a) * 0.4, 0.9, Math.sin(a) * 0.4,
      (i / n) * 2.4, 1.0));
  }
  const apex = b.v(0, H + 0.08, 0, 0, 1, 0, 1.2, 0);
  for (let i = 0; i < n; i++) b.tri(apex, rim[i], rim[(i + 1) % n]);
  for (let i = 0; i < n; i++) b.tri(apex, rim[(i + 1) % n], rim[i]);   // underside
  return b.build('props:parasol');
}

export function parasolPole() {
  const b = new Builder();
  b.tube([[0, 0, 0], [0, 2.28, 0]], [0.038, 0.030], 6, 0.3);
  b.tube([[0, 0, 0], [0, 0.06, 0]], [0.28, 0.26], 10, 0.3, 0, 0, true);
  return b.build('props:parasolPole');
}

/* ------------------------------------------------------------ commercial -- */

/** Shop fascia sign above a doorway; `cellIndex` picks the painted board. */
export function shopSign(cellIndex) {
  const b = new Builder();
  b.quadXY(0, 0, 3.0, 0.72, cell4(cellIndex));
  b.quadXY(0, 0, 2.96, 0.68, cell4(15), null, -0.05);
  return b.build(`props:shopSign${cellIndex}`);
}

/** Sloped canvas awning over a shopfront. */
export function awning() {
  const b = new Builder();
  const W = 3.1, P = 1.35;
  b.push();
  b.rotX(0.42);
  b.box(0, 0, -P / 2, W, 0.035, P, 1.1);
  b.pop();
  // scalloped valance
  b.push();
  b.translate(0, -0.50, -P * 0.90);
  b.box(0, 0, 0, W, 0.30, 0.03, 0.8);
  b.pop();
  return b.build('props:awning');
}

export function awningFrame() {
  const b = new Builder();
  const W = 3.1;
  for (const s of [-1, 1]) {
    b.tube([[s * W / 2, 0.1, 0], [s * W / 2, -0.42, -1.22]], [0.028, 0.024], 5, 0.3);
  }
  b.tube([[-W / 2, 0.1, 0], [W / 2, 0.1, 0]], [0.03, 0.03], 5, 0.3);
  return b.build('props:awningFrame');
}

export function aBoard() {
  const b = new Builder();
  for (const s of [-1, 1]) {
    b.push();
    b.translate(0, 0, 0);
    b.rotX(s * 0.16);
    b.quadXY(0, 0.45, 0.62, 0.90, cell4(12), null, s * 0.10);
    b.pop();
  }
  return b.build('props:aBoard');
}

/* ------------------------------------------------------------ industrial -- */

export function dumpster() {
  const b = new Builder();
  const W = 1.85, D = 1.25, H = 1.15;
  // tapered skip body
  b.prism([[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]], 0.16, H, 0.9);
  b.prism([[-W / 2 * 0.86, -D / 2 * 0.86], [W / 2 * 0.86, -D / 2 * 0.86],
    [W / 2 * 0.86, D / 2 * 0.86], [-W / 2 * 0.86, D / 2 * 0.86]], 0.08, 0.18, 0.5);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.push(); b.translate(sx * (W / 2 - 0.16), 0.08, sz * (D / 2 - 0.12));
    b.rotX(Math.PI / 2);
    b.tube([[0, -0.04, 0], [0, 0.04, 0]], [0.08, 0.08], 8, 0.2, 0, 0, true);
    b.pop();
  }
  return b.build('props:dumpster');
}

export function dumpsterLid() {
  const b = new Builder();
  const W = 1.9, D = 1.3;
  b.push(); b.rotX(-0.06);
  b.box(-W / 4, 1.20, 0, W / 2 - 0.02, 0.07, D, 0.8);
  b.pop();
  b.push(); b.rotX(0.06);
  b.box(W / 4, 1.20, 0, W / 2 - 0.02, 0.07, D, 0.8);
  b.pop();
  return b.build('props:dumpsterLid');
}

export function palletStack(rng) {
  const b = new Builder();
  const n = rng ? rng.intRange(3, 6) : 4;
  for (let i = 0; i < n; i++) {
    const y = i * 0.155;
    const j = rng ? rng.range(-0.05, 0.05) : 0;
    b.push();
    b.translate(j, y, j * 0.6);
    b.rotY(rng ? rng.range(-0.06, 0.06) : 0);
    for (let k = 0; k < 3; k++) b.box(0, 0.035, -0.4 + k * 0.4, 1.2, 0.07, 0.14, 0.4);
    for (let k = 0; k < 5; k++) b.box(-0.48 + k * 0.24, 0.10, 0, 0.11, 0.024, 0.98, 0.4);
    b.pop();
  }
  return b.build('props:pallets');
}

export function shippingContainer() {
  const b = new Builder();
  const W = 6.06, H = 2.59, D = 2.44;
  b.box(0, H / 2, 0, W, H, D, 1.4);
  // corrugation ribs
  for (let i = 0; i < 22; i++) {
    const x = -W / 2 + 0.16 + i * ((W - 0.32) / 21);
    b.box(x, H / 2, D / 2 + 0.018, 0.07, H - 0.22, 0.036, 0.4);
    b.box(x, H / 2, -D / 2 - 0.018, 0.07, H - 0.22, 0.036, 0.4);
  }
  // corner castings + door bars
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const sy of [0, 1]) {
    b.box(sx * (W / 2 - 0.09), 0.09 + sy * (H - 0.18), sz * (D / 2 - 0.09), 0.19, 0.19, 0.19, 0.3);
  }
  for (const x of [-W / 2 - 0.01]) {
    for (const z of [-0.75, -0.28, 0.28, 0.75]) b.box(x, H / 2, z, 0.05, H - 0.3, 0.07, 0.3);
  }
  return b.build('props:container');
}

export function storageTank() {
  const b = new Builder();
  const R = 1.35, H = 3.6;
  b.tube([[0, 0.75, 0], [0, 0.75 + H, 0]], [R, R], 14, 1.1);
  b.blob(0, 0.75 + H, 0, R, R * 0.42, R, 14, 1.0);
  b.blob(0, 0.75, 0, R, R * 0.32, R, 14, 1.0);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    b.tube([[Math.cos(a) * R * 0.8, 0, Math.sin(a) * R * 0.8],
      [Math.cos(a) * R * 0.8, 0.78, Math.sin(a) * R * 0.8]], [0.10, 0.09], 6, 0.4);
  }
  // banding + ladder
  for (const y of [1.5, 2.6, 3.7]) b.tube([[0, y, 0], [0, y + 0.06, 0]], [R + 0.02, R + 0.02], 14, 0.4);
  for (const s of [-1, 1]) b.tube([[s * 0.22, 0.8, R + 0.10], [s * 0.22, H + 0.8, R + 0.10]], [0.025, 0.025], 4, 0.3);
  return b.build('props:tank');
}

export function loadingDock() {
  const b = new Builder();
  const W = 4.6, D = 2.2, H = 1.15;
  b.box(0, H / 2, 0, W, H, D, 1.2);
  // rubber bumpers
  for (const x of [-W / 2 + 0.8, W / 2 - 0.8]) b.box(x, H - 0.20, D / 2 + 0.06, 0.5, 0.22, 0.12, 0.3);
  // steps at one end
  for (let i = 0; i < 4; i++) {
    b.box(W / 2 + 0.42, (i + 0.5) * (H / 4), D / 2 - 0.36 - i * 0.30, 0.9, H / 4, 0.30, 0.5);
  }
  return b.build('props:dock');
}

export function acUnit() {
  const b = new Builder();
  b.box(0, 0.42, 0, 0.95, 0.78, 0.42, 0.5);
  b.push(); b.translate(0, 0.42, 0.215); b.rotX(Math.PI / 2);
  b.tube([[0, -0.02, 0], [0, 0.02, 0]], [0.30, 0.30], 12, 0.3, 0, 0, true);
  b.pop();
  for (const s of [-1, 1]) b.box(s * 0.4, 0.03, 0, 0.12, 0.06, 0.42, 0.3);
  return b.build('props:ac');
}

/* --------------------------------------------------------------- ground -- */

/** Unit slab, scaled per instance — driveways, paths, hardstanding, patios. */
export function slab() {
  const b = new Builder();
  b.quadXZ(0, 0, 1, 1, [0, 0, 1, 1], 0);
  return b.build('props:slab');
}

/** Unit soft-edged decal — tree pits, worn grass, oil stains. */
export function decalQuad() {
  const b = new Builder();
  b.quadXZ(0, 0, 1, 1, [0.001, 0.001, 0.999, 0.999], 0);
  return b.build('props:decal');
}

export default {
  fencePanel, gardenWall, wallCoping, shed, garage, garageDoor,
  poolCoping, poolWater, patioTableTop, patioTableBase, patioChair,
  parasolCanopy, parasolPole, shopSign, awning, awningFrame, aBoard,
  dumpster, dumpsterLid, palletStack, shippingContainer, storageTank,
  loadingDock, acUnit, slab, decalQuad,
};
