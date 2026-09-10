import { TILE_M } from './BuildingMaterials.js';
import { makeFrames, Wall, opening } from './Facade.js';

/**
 * Roofs and the junk that lives on them. A city skyline is read from its roof
 * line: flat roofs need a parapet, a coping and real plant; pitched roofs need
 * eaves, fascia, dormers and a chimney. A bare extruded box top is the single
 * fastest way to make a building look like a programmer drew it.
 */

/* --------------------------------------------------------------- flat roof -- */

export function flatRoof(set, p) {
  const {
    W, D, cx = 0, cz = 0, y,
    parapet = 1.0, copingSlot = 'concrete', copingColor = 0xa8a49c,
    wallSlot = 'concrete', wallColor = 0x8e8b85, wallTint = [1, 1, 1],
    deckSlot = 'membrane', deckColor = 0x53565a, thickness = 0.26,
  } = p;

  const d = set.get(deckSlot);
  d.colorHex(deckColor);
  const dt = 1 / (TILE_M[deckSlot] || 4);
  const hw = W / 2 - thickness, hd = D / 2 - thickness;
  d.quad([cx - hw, y, cz + hd], [cx + hw, y, cz + hd], [cx + hw, y, cz - hd], [cx - hw, y, cz - hd],
    0, 0, (hw * 2) * dt, (hd * 2) * dt);

  if (parapet <= 0) return;
  const frames = makeFrames(W, D, cx, cz);
  let uBase = 0;
  const b = set.get(wallSlot);
  const tile = TILE_M[wallSlot] || 3;
  for (const f of frames) {
    const w = new Wall(f, uBase);
    uBase += f.len;
    b.colorHex(wallColor, wallTint[0], wallTint[1], wallTint[2]);
    // outer face
    w.q(b, 0, y, f.len, y + parapet, 0, tile);
    // inner face
    const P = (u, v, ww) => w.P(u, v, ww);
    b.colorHex(wallColor, wallTint[0] * 0.8, wallTint[1] * 0.8, wallTint[2] * 0.8);
    b.quad(P(f.len, y, -thickness), P(0, y, -thickness), P(0, y + parapet - 0.08, -thickness), P(f.len, y + parapet - 0.08, -thickness),
      0, 0, f.len / tile, parapet / tile);
    // coping
    const c = set.get(copingSlot);
    const ct = 1 / (TILE_M[copingSlot] || 3);
    c.colorHex(copingColor);
    c.quad(P(0, y + parapet, 0.06), P(f.len, y + parapet, 0.06), P(f.len, y + parapet, -thickness), P(0, y + parapet, -thickness),
      0, 0, f.len * ct, (thickness + 0.06) * ct);
    c.quad(P(0, y + parapet - 0.14, 0.06), P(f.len, y + parapet - 0.14, 0.06), P(f.len, y + parapet, 0.06), P(0, y + parapet, 0.06),
      0, 0, f.len * ct, 0.14 * ct);
  }
}

/* ------------------------------------------------------------- pitched roof -- */

/**
 * Gable roof. `axis:'x'` puts the ridge parallel to the street frontage.
 * Emits slopes, gable-end walls, fascia boards and soffits.
 */
export function gableRoof(set, p) {
  const {
    W, D, cx = 0, cz = 0, y, h = 2.6, over = 0.45, axis = 'x',
    slot = 'shingle', color = 0x4a4340,
    wallSlot = 'stucco', wallColor = 0xd8cfbc, wallTint = [1, 1, 1],
    trimSlot = 'paint', trimColor = 0xe8e2d6,
  } = p;

  const r = set.get(slot);
  r.colorHex(color);
  const rt = 1 / (TILE_M[slot] || 1.5);
  const g = set.get(wallSlot);
  const t = set.get(trimSlot);
  const tt = 1 / (TILE_M[trimSlot] || 1.2);
  const fasciaH = 0.22;

  const hw = W / 2, hd = D / 2;
  const ex = axis === 'x' ? hw + over : hw + over;
  const ez = hd + over;

  if (axis === 'x') {
    const slopeLen = Math.hypot(hd + over, h);
    // front slope (−Z side) and back slope (+Z)
    r.quad([cx - ex, y, cz + ez], [cx + ex, y, cz + ez], [cx + ex, y + h, cz], [cx - ex, y + h, cz],
      0, 0, (ex * 2) * rt, slopeLen * rt);
    r.quad([cx + ex, y, cz - ez], [cx - ex, y, cz - ez], [cx - ex, y + h, cz], [cx + ex, y + h, cz],
      0, 0, (ex * 2) * rt, slopeLen * rt);
    // ridge cap
    r.colorHex(color, 1.15, 1.15, 1.15);
    r.quad([cx - ex, y + h, cz - 0.09], [cx + ex, y + h, cz - 0.09], [cx + ex, y + h + 0.05, cz], [cx - ex, y + h + 0.05, cz], 0, 0, (ex * 2) * rt, 0.2 * rt);
    r.quad([cx + ex, y + h, cz + 0.09], [cx - ex, y + h, cz + 0.09], [cx - ex, y + h + 0.05, cz], [cx + ex, y + h + 0.05, cz], 0, 0, (ex * 2) * rt, 0.2 * rt);
    // gable end walls
    g.colorHex(wallColor, wallTint[0], wallTint[1], wallTint[2]);
    const gt = 1 / (TILE_M[wallSlot] || 3);
    g.tri([cx - hw, y, cz - hd], [cx - hw, y, cz + hd], [cx - hw, y + h, cz], 0, 0, D * gt, 0, D * gt * 0.5, h * gt);
    g.tri([cx + hw, y, cz + hd], [cx + hw, y, cz - hd], [cx + hw, y + h, cz], 0, 0, D * gt, 0, D * gt * 0.5, h * gt);
    // fascia + soffit along both eaves
    t.colorHex(trimColor);
    for (const s of [-1, 1]) {
      const z = cz + s * ez;
      t.quad([cx - ex, y - fasciaH, z], [cx + ex, y - fasciaH, z], [cx + ex, y, z], [cx - ex, y, z], 0, 0, (ex * 2) * tt, fasciaH * tt);
      const zi = cz + s * hd;
      if (s > 0) t.quad([cx - ex, y - fasciaH, z], [cx - ex, y - fasciaH, zi], [cx + ex, y - fasciaH, zi], [cx + ex, y - fasciaH, z], 0, 0, (ex * 2) * tt, over * tt);
      else t.quad([cx + ex, y - fasciaH, z], [cx + ex, y - fasciaH, zi], [cx - ex, y - fasciaH, zi], [cx - ex, y - fasciaH, z], 0, 0, (ex * 2) * tt, over * tt);
    }
    // verge boards on the gable ends
    for (const s of [-1, 1]) {
      const x = cx + s * ex;
      t.quad([x, y - fasciaH, cz + ez], [x, y, cz + ez], [x, y + h, cz], [x, y + h - fasciaH, cz], 0, 0, 1, fasciaH * tt);
      t.quad([x, y - fasciaH, cz - ez], [x, y + h - fasciaH, cz], [x, y + h, cz], [x, y, cz - ez], 0, 0, 1, fasciaH * tt);
    }
  } else {
    const slopeLen = Math.hypot(hw + over, h);
    r.quad([cx - ex, y, cz - ez], [cx - ex, y, cz + ez], [cx, y + h, cz + ez], [cx, y + h, cz - ez],
      0, 0, (ez * 2) * rt, slopeLen * rt);
    r.quad([cx + ex, y, cz + ez], [cx + ex, y, cz - ez], [cx, y + h, cz - ez], [cx, y + h, cz + ez],
      0, 0, (ez * 2) * rt, slopeLen * rt);
    g.colorHex(wallColor, wallTint[0], wallTint[1], wallTint[2]);
    const gt = 1 / (TILE_M[wallSlot] || 3);
    g.tri([cx - hw, y, cz + hd], [cx + hw, y, cz + hd], [cx, y + h, cz + hd], 0, 0, W * gt, 0, W * gt * 0.5, h * gt);
    g.tri([cx + hw, y, cz - hd], [cx - hw, y, cz - hd], [cx, y + h, cz - hd], 0, 0, W * gt, 0, W * gt * 0.5, h * gt);
    t.colorHex(trimColor);
    for (const s of [-1, 1]) {
      const x = cx + s * ex;
      t.quad([x, y - fasciaH, cz - ez], [x, y - fasciaH, cz + ez], [x, y, cz + ez], [x, y, cz - ez], 0, 0, (ez * 2) * tt, fasciaH * tt);
    }
  }
}

/** Hip roof — four slopes meeting a short ridge. Reads as suburban. */
export function hipRoof(set, p) {
  const {
    W, D, cx = 0, cz = 0, y, h = 2.4, over = 0.5,
    slot = 'shingle', color = 0x4a4340,
    trimSlot = 'paint', trimColor = 0xe8e2d6,
  } = p;
  const r = set.get(slot);
  r.colorHex(color);
  const rt = 1 / (TILE_M[slot] || 1.5);
  const hw = W / 2 + over, hd = D / 2 + over;
  const ridge = Math.max(0.6, W * 0.42);
  const rz = 0;
  const a = [cx - ridge / 2, y + h, cz + rz], b = [cx + ridge / 2, y + h, cz + rz];
  const c0 = [cx - hw, y, cz - hd], c1 = [cx + hw, y, cz - hd];
  const c2 = [cx + hw, y, cz + hd], c3 = [cx - hw, y, cz + hd];
  const sl = Math.hypot(hd, h);
  r.quad(c3, c2, b, a, 0, 0, (hw * 2) * rt, sl * rt);       // front (+Z)
  r.quad(c1, c0, a, b, 0, 0, (hw * 2) * rt, sl * rt);       // back (−Z)
  r.tri(c0, c3, a, 0, 0, (hd * 2) * rt, 0, hd * rt, sl * rt);
  r.tri(c2, c1, b, 0, 0, (hd * 2) * rt, 0, hd * rt, sl * rt);
  r.colorHex(color, 1.15, 1.15, 1.15);
  r.quad([a[0], a[1], a[2] - 0.09], [b[0], b[1], b[2] - 0.09], [b[0], b[1] + 0.05, b[2]], [a[0], a[1] + 0.05, a[2]], 0, 0, ridge * rt, 0.2 * rt);
  r.quad([b[0], b[1], b[2] + 0.09], [a[0], a[1], a[2] + 0.09], [a[0], a[1] + 0.05, a[2]], [b[0], b[1] + 0.05, b[2]], 0, 0, ridge * rt, 0.2 * rt);
  // fascia band all round
  const t = set.get(trimSlot);
  t.colorHex(trimColor);
  const tt = 1 / (TILE_M[trimSlot] || 1.2), fh = 0.22;
  t.box(cx - hw, y - fh, cz - hd, cx + hw, y, cz + hd, 1 / tt, 1 | 2 | 4 | 8 | 32);
}

/** A gabled dormer sitting on the front slope of a pitched roof. */
export function dormer(set, p) {
  const {
    x, y, z, w = 1.5, h = 1.5, d = 1.3,
    slot = 'shingle', color = 0x4a4340,
    wallSlot = 'stucco', wallColor = 0xd8cfbc,
    trimSlot = 'paint', trimColor = 0xe8e2d6,
    rng, occ = 0,
  } = p;
  const g = set.get(wallSlot);
  g.colorHex(wallColor);
  const gt = TILE_M[wallSlot] || 3;
  // cheek walls + front
  g.box(x - w / 2, y, z - d / 2, x + w / 2, y + h, z + d / 2, gt, 1 | 2 | 8);
  // little gable
  const r = set.get(slot);
  r.colorHex(color);
  const rt = 1 / (TILE_M[slot] || 1.5);
  const ph = 0.55, ov = 0.14;
  r.quad([x - w / 2 - ov, y + h, z - d / 2 - ov], [x - w / 2 - ov, y + h, z + d / 2], [x, y + h + ph, z + d / 2], [x, y + h + ph, z - d / 2 - ov], 0, 0, 1, 1);
  r.quad([x + w / 2 + ov, y + h, z + d / 2], [x + w / 2 + ov, y + h, z - d / 2 - ov], [x, y + h + ph, z - d / 2 - ov], [x, y + h + ph, z + d / 2], 0, 0, 1, 1);
  g.tri([x - w / 2, y + h, z - d / 2], [x + w / 2, y + h, z - d / 2], [x, y + h + ph, z - d / 2], 0, 0, w / gt, 0, w / gt / 2, ph / gt);
  void rt;
  // window
  const frame = { ox: x + w / 2, oz: z - d / 2, dux: -1, duz: 0, dwx: 0, dwz: -1, len: w, side: 0 };
  const wall = new Wall(frame, 0);
  opening(set, wall, {
    ua: w * 0.22, ub: w * 0.78, va: y + 0.34, vb: y + h - 0.22,
    reveal: 0.14, jambSlot: trimSlot, jambColor: trimColor,
    glassColor: 0x2b3742, rng,
    win: [rng ? rng.next() : 0.5, occ, rng ? rng.next() : 0.5, 0.2],
    bar: 1, transomAt: 0.55,
  });
}

export function chimney(set, p) {
  const {
    x, y, z, w = 0.85, d = 0.7, h = 2.4,
    slot = 'brickRed', color = 0x8a4a38, capSlot = 'concrete', capColor = 0x9a968e,
  } = p;
  const b = set.get(slot);
  b.colorHex(color);
  const tile = TILE_M[slot] || 2;
  b.box(x - w / 2, y, z - d / 2, x + w / 2, y + h, z + d / 2, tile, 1 | 2 | 4 | 8);
  const c = set.get(capSlot);
  c.colorHex(capColor);
  c.box(x - w / 2 - 0.09, y + h, z - d / 2 - 0.09, x + w / 2 + 0.09, y + h + 0.16, z + d / 2 + 0.09, TILE_M[capSlot] || 3);
  c.colorHex(capColor, 0.5, 0.5, 0.5);
  c.box(x - 0.11, y + h + 0.16, z - 0.10, x + 0.11, y + h + 0.42, z + 0.10, 1);
}

/* ------------------------------------------------------------ roof clutter -- */

/**
 * HVAC plant, vents, tanks, dishes, stair bulkheads, pipe runs. Placed on the
 * roof deck inside the parapet, deterministic from `rng`.
 */
export function roofClutter(set, p) {
  const {
    W, D, cx = 0, cz = 0, y, rng, density = 1, tall = false,
    metalSlot = 'metal', metalColor = 0x9aa0a6,
    boxSlot = 'concrete', boxColor = 0x93908a,
  } = p;
  const m = set.get(metalSlot);
  const bx = set.get(boxSlot);
  const mt = TILE_M[metalSlot] || 1.8;
  const bt = TILE_B(boxSlot);
  const hw = W / 2 - 1.4, hd = D / 2 - 1.4;
  if (hw <= 0.6 || hd <= 0.6) return;

  const area = (hw * 2) * (hd * 2);
  const n = Math.max(1, Math.min(9, Math.round(area / 150 * density)));

  // stair / lift bulkhead — the big one, near a corner
  if (area > 90) {
    const bw = Math.min(hw * 0.9, 3.4 + rng.next() * 2.4);
    const bd = Math.min(hd * 0.9, 3.0 + rng.next() * 2.0);
    const bh = tall ? 3.4 + rng.next() * 1.6 : 2.5 + rng.next() * 0.8;
    const px = (rng.next() - 0.5) * (hw * 2 - bw) * 0.75 + cx;
    const pz = (rng.next() - 0.5) * (hd * 2 - bd) * 0.75 + cz;
    bx.colorHex(boxColor, 0.94, 0.94, 0.96);
    bx.box(px - bw / 2, y, pz - bd / 2, px + bw / 2, y + bh, pz + bd / 2, bt);
    m.colorHex(metalColor, 0.7, 0.7, 0.7);
    m.box(px - bw / 2 - 0.1, y + bh, pz - bd / 2 - 0.1, px + bw / 2 + 0.1, y + bh + 0.14, pz + bd / 2 + 0.1, mt, 16 | 1 | 2 | 4 | 8);
  }

  for (let i = 0; i < n; i++) {
    const px = cx + (rng.next() * 2 - 1) * hw * 0.86;
    const pz = cz + (rng.next() * 2 - 1) * hd * 0.86;
    const kind = rng.weighted([['ac', 5], ['vent', 4], ['tank', 1.6], ['dish', 1.4], ['duct', 2.4], ['fan', 3]]);
    const rot = rng.next() < 0.6 ? 0 : (rng.next() - 0.5) * 0.6;
    if (kind === 'ac') {
      const w = 1.5 + rng.next() * 2.6, d = 1.1 + rng.next() * 1.6, h = 0.85 + rng.next() * 0.9;
      m.colorHex(metalColor, 0.88 + rng.next() * 0.3, 0.9, 0.92);
      m.boxRot(px, y + h / 2, pz, w, h, d, rot, mt);
      // fan grilles on top
      m.colorHex(metalColor, 0.45, 0.46, 0.48);
      const fans = Math.max(1, Math.round(w / 1.3));
      for (let k = 0; k < fans; k++) {
        const fx = px + (k - (fans - 1) / 2) * (w / fans) * Math.cos(rot);
        const fz = pz - (k - (fans - 1) / 2) * (w / fans) * Math.sin(rot);
        m.cyl(fx, y + h, fz, Math.min(0.42, d * 0.32), 0.10, 6, mt, false);
      }
      // steel skid
      m.colorHex(metalColor, 0.5, 0.5, 0.52);
      m.boxRot(px, y + 0.06, pz, w + 0.3, 0.12, d + 0.3, rot, mt);
    } else if (kind === 'vent') {
      const r = 0.22 + rng.next() * 0.3, h = 0.6 + rng.next() * 1.3;
      m.colorHex(metalColor, 0.95, 0.95, 0.95);
      m.cyl(px, y, pz, r, h, 6, mt, false);
      m.colorHex(metalColor, 0.6, 0.6, 0.62);
      m.cyl(px, y + h, pz, r * 1.35, 0.14, 6, mt);
    } else if (kind === 'fan') {
      const w = 0.8 + rng.next() * 0.7;
      m.colorHex(metalColor, 0.8, 0.82, 0.84);
      m.boxRot(px, y + 0.30, pz, w, 0.6, w, rot, mt);
      m.colorHex(metalColor, 0.4, 0.4, 0.42);
      m.cyl(px, y + 0.60, pz, w * 0.42, 0.16, 6, mt);
    } else if (kind === 'duct') {
      const len = 1.6 + rng.next() * 4.5;
      const dirX = rng.next() < 0.5;
      m.colorHex(metalColor, 0.85, 0.86, 0.88);
      if (dirX) m.box(px - len / 2, y + 0.3, pz - 0.32, px + len / 2, y + 0.92, pz + 0.32, mt);
      else m.box(px - 0.32, y + 0.3, pz - len / 2, px + 0.32, y + 0.92, pz + len / 2, mt);
      m.colorHex(metalColor, 0.5, 0.5, 0.52);
      m.box(px - 0.1, y, pz - 0.1, px + 0.1, y + 0.32, pz + 0.1, mt);
    } else if (kind === 'tank') {
      const r = 0.9 + rng.next() * 0.8, h = 1.6 + rng.next() * 1.6;
      const legs = 0.9 + rng.next() * 0.8;
      m.colorHex(0x6a5a48, 1, 1, 1);
      m.cyl(px, y + legs, pz, r, h, 9, mt);
      m.colorHex(metalColor, 0.4, 0.4, 0.42);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4;
        m.box(px + Math.cos(a) * r * 0.72 - 0.07, y, pz + Math.sin(a) * r * 0.72 - 0.07,
          px + Math.cos(a) * r * 0.72 + 0.07, y + legs, pz + Math.sin(a) * r * 0.72 + 0.07, mt);
      }
    } else {
      // satellite dish on a stand
      m.colorHex(metalColor, 1.15, 1.15, 1.15);
      const r = 0.5 + rng.next() * 0.5;
      m.cyl(px, y, pz, 0.09, 0.7 + rng.next() * 0.5, 6, mt);
      const yy = y + 0.9;
      const tilt = 0.5;
      m.quad(
        [px - r, yy - r * tilt, pz - r * 0.2], [px + r, yy - r * tilt, pz - r * 0.2],
        [px + r, yy + r * tilt, pz + r * 0.9], [px - r, yy + r * tilt, pz + r * 0.9], 0, 0, 1, 1);
    }
  }

  // parapet-edge pipe run
  if (rng.next() < 0.5 * density) {
    m.colorHex(metalColor, 0.6, 0.6, 0.62);
    const z = cz + (rng.next() < 0.5 ? -1 : 1) * hd;
    m.box(cx - hw, y + 0.18, z - 0.1, cx + hw, y + 0.32, z + 0.1, mt);
  }
}

function TILE_B(slot) { return TILE_M[slot] || 3; }

/**
 * A tapered crown: a glazed or clad lantern stepping in over four stages to a
 * finial. A skyline is read from its tops — a row of flat parapets at slightly
 * different heights is the single clearest tell that a city was extruded.
 */
export function crownPlant(set, p) {
  const {
    cx = 0, cz = 0, W, D, y, rng,
    slot = 'concrete', color = 0xffffff,
    glassy = false, glassColor = 0x33474f,
    metalSlot = 'metal', metalColor = 0xb2b8be,
  } = p;
  const b = set.get(slot);
  const tile = TILE_M[slot] || 3;
  const g = glassy ? set.get('glass') : null;
  const stages = 4;
  let w = W - 2.4, d = D - 2.4, yy = y;
  for (let i = 0; i < stages && w > 3.2 && d > 3.2; i++) {
    const h = 2.6 + rng.next() * 2.4;
    b.colorHex(color, 0.96 - i * 0.04, 0.96 - i * 0.04, 0.99 - i * 0.03);
    b.box(cx - w / 2, yy, cz - d / 2, cx + w / 2, yy + h, cz + d / 2, tile, 1 | 2 | 4 | 8 | 16);
    if (g) {
      // a glazed slot in each stage — lanterns are lit all night, which is
      // exactly what a landmark needs to hold the skyline after dark
      const gy0 = yy + h * 0.22, gy1 = yy + h * 0.80;
      const hw = w / 2 + 0.03, hd = d / 2 + 0.03;
      g.colorHex(glassColor, 1.1, 1.1, 1.15);
      g.setWin(0.02, 1, 0.62, 0.55);
      g.setGls(9.0, 0.11);
      g.quad([cx + hw, gy0, cz - hd], [cx - hw, gy0, cz - hd], [cx - hw, gy1, cz - hd], [cx + hw, gy1, cz - hd], 0, 0, 1, 1);
      g.quad([cx - hw, gy0, cz + hd], [cx + hw, gy0, cz + hd], [cx + hw, gy1, cz + hd], [cx - hw, gy1, cz + hd], 0, 0, 1, 1);
      g.quad([cx + hw, gy0, cz + hd], [cx + hw, gy0, cz - hd], [cx + hw, gy1, cz - hd], [cx + hw, gy1, cz + hd], 0, 0, 1, 1);
      g.quad([cx - hw, gy0, cz - hd], [cx - hw, gy0, cz + hd], [cx - hw, gy1, cz + hd], [cx - hw, gy1, cz - hd], 0, 0, 1, 1);
    }
    yy += h;
    w -= 2.0 + rng.next() * 1.4;
    d -= 2.0 + rng.next() * 1.4;
  }
  // finial
  const m = set.get(metalSlot);
  m.colorHex(metalColor, 0.95, 0.95, 0.97);
  m.cyl(cx, yy, cz, Math.max(0.4, w * 0.16), 3.0 + rng.next() * 5.0, 8, TILE_M[metalSlot] || 1.8);
  const sg = set.get('sign');
  sg.colorHex(0xff2a1c);
  sg.box(cx - 0.18, yy + 3.0, cz - 0.18, cx + 0.18, yy + 3.4, cz + 0.18, 1);
}

/** A rooftop antenna mast + aircraft-warning light. Towers only. */
export function mast(set, p) {
  const { x, y, z, h = 12, rng, slot = 'metal', color = 0xb0b6bc } = p;
  const m = set.get(slot);
  const t = TILE_M[slot] || 1.8;
  m.colorHex(color, 0.9, 0.9, 0.92);
  m.cyl(x, y, z, 0.24, h * 0.55, 6, t);
  m.cyl(x, y + h * 0.55, z, 0.13, h * 0.45, 6, t);
  // guy struts
  m.colorHex(color, 0.55, 0.55, 0.58);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + (rng ? rng.next() : 0.3);
    m.box(x - 0.05, y, z - 0.05, x + Math.cos(a) * 1.6 + 0.05, y + h * 0.36, z + Math.sin(a) * 1.6 + 0.05, t, 1 | 2 | 4 | 8);
  }
  // beacon
  const s = set.get('sign');
  s.colorHex(0xff2a1c);
  s.box(x - 0.16, y + h, z - 0.16, x + 0.16, y + h + 0.32, z + 0.16, 1);
}

export default { flatRoof, gableRoof, hipRoof, dormer, chimney, roofClutter, mast, crownPlant };
