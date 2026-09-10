import { TILE_M, GLS, interiorCell, roomCell, CELL_CLEAR } from './BuildingMaterials.js';

/**
 * Lighting coherence.
 *
 * A tower whose panes each roll their own lit/unlit die reads as television
 * static. Real buildings light up by floor and by tenancy: whole storeys go
 * dark, a let floor lights most of its bays, and the lamps inside one tenancy
 * share a colour temperature. `lit` carries a per-building warmth plus a
 * per-floor phase (>= 1 means "this floor is empty tonight"); the pane's own
 * die only breaks the tie.
 */
export function paneLit(lit, fi, r1, r2) {
  if (!lit || !lit.floors || !lit.floors.length) return [r1, r2, 1];
  const fp = lit.floors[Math.min(Math.max(0, fi | 0), lit.floors.length - 1)];
  if (fp >= 1) return [1.6, 0.5, 0];                 // this floor is empty tonight
  // 62 % of a floor's panes share the floor's own phase, so storeys switch on
  // and off together; the rest keep their own die. The marginal distribution
  // stays uniform, so the lit *fraction* still tracks the occupancy curve.
  const phase = r2 < 0.62 ? fp : r1;
  const warm = Math.max(0, Math.min(1, lit.warm + (r1 - 0.5) * 0.40));
  return [phase, warm, 1];
}

/** Deterministic-ish pane index into the window-interior atlas. */
export function paneCell(r, fi, i) {
  return Math.floor(r * 977) + fi * 5 + i * 3;
}

/**
 * Facade construction.
 *
 * Everything is emitted in the building's local frame: x along the street
 * frontage, z into the plot, y up, floor 0 at y = 0. Each of the four walls
 * gets a right-handed (du, dv, dw) basis with dw = du × dv pointing **out** of
 * the building, so a quad wound (u0,v0)→(u1,v0)→(u1,v1)→(u0,v1) always faces
 * outwards and every reveal/jamb formula below is side-independent.
 *
 * Windows are real openings: the wall is emitted as bands and piers around the
 * hole, four jamb quads step the reveal inwards, and the glass sits at the back
 * of the reveal. That depth is what stops a facade reading as a painted decal.
 */

/* ------------------------------------------------------------------ walls -- */

/**
 * Four wall frames for a W×D box centred on (cx, cz).
 * order: front (−Z, the street), left (−X), back (+Z), right (+X)
 */
export function makeFrames(W, D, cx = 0, cz = 0) {
  const hw = W / 2, hd = D / 2;
  return [
    { ox: cx + hw, oz: cz - hd, dux: -1, duz: 0, dwx: 0, dwz: -1, len: W, side: 0 },
    { ox: cx - hw, oz: cz - hd, dux: 0, duz: 1, dwx: -1, dwz: 0, len: D, side: 1 },
    { ox: cx - hw, oz: cz + hd, dux: 1, duz: 0, dwx: 0, dwz: 1, len: W, side: 2 },
    { ox: cx + hw, oz: cz + hd, dux: 0, duz: -1, dwx: 1, dwz: 0, len: D, side: 3 },
  ];
}

export class Wall {
  constructor(frame, uBase = 0) {
    this.f = frame;
    this.uBase = uBase;
    this.len = frame.len;
  }
  /** local-space point at (u along wall, v up, w outward from the face) */
  P(u, v, w) {
    const f = this.f;
    return [
      f.ox + f.dux * u + f.dwx * w,
      v,
      f.oz + f.duz * u + f.dwz * w,
    ];
  }
  /** In-plane quad on the face at depth w, UVs in metres/tile. */
  q(b, u0, v0, u1, v1, w, tile) {
    const t = 1 / (tile || 1);
    b.quad(this.P(u0, v0, w), this.P(u1, v0, w), this.P(u1, v1, w), this.P(u0, v1, w),
      (this.uBase + u0) * t, v0 * t, (this.uBase + u1) * t, v1 * t);
    return this;
  }
}

/* --------------------------------------------------------------- openings -- */

/**
 * A recessed opening. Emits four jamb quads (in `jambSlot`) and one glass pane
 * at the back of the reveal.
 */
export function opening(set, wall, {
  ua, ub, va, vb, reveal = 0.22,
  jambSlot = 'paint', jambColor = 0xdad3c6,
  glassColor = 0x2b3742, glassTintJitter = 0,
  win = [0, 0, 0.5, 0], rng = null,
  bar = 0, transomAt = 0,
  gls = GLS.window, cell = 0, tilt = 0,
}) {
  const j = set.get(jambSlot);
  j.colorHex(jambColor);
  const tj = TILE_M[jambSlot] || 1.2;
  const P = (u, v, w) => wall.P(u, v, w);
  const r = -reveal;
  const tt = 1 / tj;

  // The reveal is baked dark, deepest at the head. There is no ambient
  // occlusion anywhere in this project and the fitted shadow cascade is 1.46 m
  // per texel at hero distance, so nothing in the renderer will ever darken a
  // 0.3 m recess. Putting it in the vertex colour makes a window read as a
  // socket rather than a printed square at *any* distance and in any light —
  // which is what the critic's "stamped grid with no depth" is asking for.
  // left jamb (normal → +du)
  j.colorHex(jambColor, 0.62, 0.61, 0.60);
  j.quad(P(ua, va, 0), P(ua, va, r), P(ua, vb, r), P(ua, vb, 0), 0, 0, reveal * tt, (vb - va) * tt);
  // right jamb (normal → −du) — never the same value as its opposite number
  j.colorHex(jambColor, 0.74, 0.73, 0.72);
  j.quad(P(ub, va, r), P(ub, va, 0), P(ub, vb, 0), P(ub, vb, r), 0, 0, reveal * tt, (vb - va) * tt);
  // head (normal → −Y): the deepest shade in any opening
  j.colorHex(jambColor, 0.40, 0.39, 0.39);
  j.quad(P(ua, vb, r), P(ub, vb, r), P(ub, vb, 0), P(ua, vb, 0), 0, 0, (ub - ua) * tt, reveal * tt);
  // cill (normal → +Y): sky-facing, so barely shaded at all
  j.colorHex(jambColor, 0.94, 0.94, 0.93);
  j.quad(P(ua, va, 0), P(ub, va, 0), P(ub, va, r), P(ua, va, r), 0, 0, (ub - ua) * tt, reveal * tt);

  // Frame. Without a visible sash a punched opening is just a black hole; four
  // thin quads at the back of the reveal are what make it read as a window.
  const fw = Math.min(0.10, (ub - ua) * 0.10, (vb - va) * 0.07);
  const fz = r + 0.02;
  j.colorHex(jambColor, 0.97, 0.97, 0.96);
  j.quad(P(ua, va, fz), P(ub, va, fz), P(ub, va + fw, fz), P(ua, va + fw, fz), 0, 0, (ub - ua) * tt, fw * tt);
  j.quad(P(ua, vb - fw, fz), P(ub, vb - fw, fz), P(ub, vb, fz), P(ua, vb, fz), 0, 0, (ub - ua) * tt, fw * tt);
  j.quad(P(ua, va + fw, fz), P(ua + fw, va + fw, fz), P(ua + fw, vb - fw, fz), P(ua, vb - fw, fz), 0, 0, fw * tt, (vb - va) * tt);
  j.quad(P(ub - fw, va + fw, fz), P(ub, va + fw, fz), P(ub, vb - fw, fz), P(ub - fw, vb - fw, fz), 0, 0, fw * tt, (vb - va) * tt);

  // glass — set back behind the frame so the reveal and the frame both cast
  // onto it, with the interior atlas behind and a coated pane's reflectance
  const g = set.get('glass');
  const tint = glassColor;
  if (glassTintJitter && rng) {
    const k = 1 + (rng.next() - 0.5) * glassTintJitter;
    g.colorHex(tint, k, k * (1 + (rng.next() - 0.5) * 0.10), k * (1 + (rng.next() - 0.5) * 0.14));
  } else {
    g.colorHex(tint);
  }
  g.setWin(win[0], win[1], win[2], win[3]);
  g.setGls(gls[0], gls[1]);
  if (tilt) g.setTilt(tilt, tilt * 0.6);
  const c = roomCell(cell);
  const gz = r - 0.012;
  g.quad(P(ua + fw, va + fw, gz), P(ub - fw, va + fw, gz), P(ub - fw, vb - fw, gz), P(ua + fw, vb - fw, gz),
    c[0], c[1], c[2], c[3]);
  if (tilt) g.setTilt(0, 0);

  // glazing bars — cheap, and they are what gives a window its scale
  if (bar > 0) {
    const w2 = r + 0.035;
    const bw = 0.035;
    j.colorHex(jambColor, 0.92, 0.92, 0.92);
    const mu = (ua + ub) / 2;
    j.quad(P(mu - bw, va, w2), P(mu + bw, va, w2), P(mu + bw, vb, w2), P(mu - bw, vb, w2), 0, 0, 0.1, 1);
    if (transomAt > 0) {
      const mv = va + (vb - va) * transomAt;
      j.quad(P(ua, mv - bw, w2), P(ub, mv - bw, w2), P(ub, mv + bw, w2), P(ua, mv + bw, w2), 0, 0, 1, 0.1);
    }
  }
}

/** Projecting stone/precast cill under a window. */
export function cill(set, wall, { ua, ub, v, slot = 'stone', color = 0xcfc7b6, proj = 0.10, h = 0.11 }) {
  const b = set.get(slot);
  b.colorHex(color);
  const t = 1 / (TILE_M[slot] || 2);
  const P = (u, vv, w) => wall.P(u, vv, w);
  const u0 = ua - 0.09, u1 = ub + 0.09, v0 = v - h, v1 = v;
  // front
  b.quad(P(u0, v0, proj), P(u1, v0, proj), P(u1, v1, proj), P(u0, v1, proj), 0, 0, (u1 - u0) * t, h * t);
  // top (slight wash)
  b.quad(P(u0, v1, proj), P(u1, v1, proj), P(u1, v1 + 0.012, 0), P(u0, v1 + 0.012, 0), 0, 0, (u1 - u0) * t, proj * t);
  // under
  b.quad(P(u0, v0, 0), P(u1, v0, 0), P(u1, v0, proj), P(u0, v0, proj), 0, 0, (u1 - u0) * t, proj * t);
}

/** Continuous horizontal band (string course, cornice, plinth, parapet coping). */
export function band(set, wall, { v0, v1, proj = 0.18, slot = 'stone', color = 0xc9c1b0, u0 = 0, u1 = null }) {
  const b = set.get(slot);
  b.colorHex(color);
  const t = 1 / (TILE_M[slot] || 2);
  const a = u0, c = u1 === null ? wall.len : u1;
  const P = (u, v, w) => wall.P(u, v, w);
  b.quad(P(a, v0, proj), P(c, v0, proj), P(c, v1, proj), P(a, v1, proj), 0, 0, (c - a) * t, (v1 - v0) * t);
  b.quad(P(a, v1, proj), P(c, v1, proj), P(c, v1, 0), P(a, v1, 0), 0, 0, (c - a) * t, proj * t);
  b.quad(P(a, v0, 0), P(c, v0, 0), P(c, v0, proj), P(a, v0, proj), 0, 0, (c - a) * t, proj * t);
}

/* -------------------------------------------------------------- balconies -- */

export function balcony(set, wall, { ua, ub, v, depth = 1.25, slot = 'concrete', color = 0xbdb8ae, railSlot = 'paint', railColor = 0x3a3c40, glassRail = false, rng = null }) {
  const b = set.get(slot);
  b.colorHex(color);
  const t = 1 / (TILE_M[slot] || 3);
  const P = (u, vv, w) => wall.P(u, vv, w);
  const th = 0.16;
  // slab
  b.quad(P(ua, v, depth), P(ub, v, depth), P(ub, v + th, depth), P(ua, v + th, depth), 0, 0, (ub - ua) * t, th * t);
  b.quad(P(ua, v + th, depth), P(ub, v + th, depth), P(ub, v + th, 0), P(ua, v + th, 0), 0, 0, (ub - ua) * t, depth * t);
  b.quad(P(ua, v, 0), P(ub, v, 0), P(ub, v, depth), P(ua, v, depth), 0, 0, (ub - ua) * t, depth * t);
  b.quad(P(ua, v, 0), P(ua, v, depth), P(ua, v + th, depth), P(ua, v + th, 0), 0, 0, depth * t, th * t);
  b.quad(P(ub, v, depth), P(ub, v, 0), P(ub, v + th, 0), P(ub, v + th, depth), 0, 0, depth * t, th * t);

  const rv0 = v + th, rv1 = v + th + 1.05;
  if (glassRail) {
    const g = set.get('glass');
    g.colorHex(0x9fb3bc, 1, 1, 1);
    g.setWin(1.6, 0, 0.5, 0);   // never lights up
    g.setGls(GLS.rail[0], GLS.rail[1]);
    const c = interiorCell(CELL_CLEAR);
    g.quad(P(ua, rv0, depth), P(ub, rv0, depth), P(ub, rv1, depth), P(ua, rv1, depth), c[0], c[1], c[2], c[3]);
    g.quad(P(ub, rv0, depth), P(ua, rv0, depth), P(ua, rv1, depth), P(ub, rv1, depth), c[0], c[1], c[2], c[3]);
    const r = set.get(railSlot); r.colorHex(railColor);
    r.box(0, 0, 0, 0, 0, 0, 1, 0);   // no-op keeps slot alive
  } else {
    const r = set.get(railSlot);
    r.colorHex(railColor);
    const tr = 1 / (TILE_M[railSlot] || 1.2);
    const rail = (v0, v1) => {
      r.quad(P(ua, v0, depth), P(ub, v0, depth), P(ub, v1, depth), P(ua, v1, depth), 0, 0, (ub - ua) * tr, (v1 - v0) * tr);
      r.quad(P(ub, v0, depth - 0.05), P(ua, v0, depth - 0.05), P(ua, v1, depth - 0.05), P(ub, v1, depth - 0.05), 0, 0, (ub - ua) * tr, (v1 - v0) * tr);
    };
    rail(rv1 - 0.07, rv1);
    rail(rv0 + 0.42, rv0 + 0.49);
    const n = Math.max(3, Math.round((ub - ua) / 0.24));
    for (let i = 0; i <= n; i++) {
      const u = ua + (i / n) * (ub - ua);
      const w = 0.026;
      r.quad(P(u - w, rv0, depth), P(u + w, rv0, depth), P(u + w, rv1, depth), P(u - w, rv1, depth), 0, 0, 0.05, (rv1 - rv0) * tr);
    }
    // returns at each end
    for (const u of [ua, ub]) {
      r.quad(P(u, rv0, depth), P(u, rv0, 0), P(u, rv1, 0), P(u, rv1, depth), 0, 0, depth * tr, (rv1 - rv0) * tr);
    }
    void rng;
  }
}

/** Zig-zag fire escape hung on a facade — brick walk-ups are naked without it. */
export function fireEscape(set, wall, { u0, floors, floorH, base = 1, slot = 'paint', color = 0x2e2b28 }) {
  const b = set.get(slot);
  b.colorHex(color);
  const t = 1 / (TILE_M[slot] || 1.2);
  const P = (u, v, w) => wall.P(u, v, w);
  const w = 1.55;            // landing depth
  const lw = 2.5;            // landing width
  const ua = u0, ub = u0 + lw;
  const bar = (x0, y0, z0, x1, y1, z1) => {
    // thin rectangular member as two crossed quads (cheap, reads as steel)
    b.quad(P(x0, y0, z0), P(x1, y1, z1), P(x1, y1 + 0.06, z1), P(x0, y0 + 0.06, z0), 0, 0, 1 * t, 0.06 * t);
    b.quad(P(x0, y0 + 0.03, z0 - 0.03), P(x1, y1 + 0.03, z1 - 0.03), P(x1, y1 + 0.03, z1 + 0.03), P(x0, y0 + 0.03, z0 + 0.03), 0, 0, 1 * t, 0.06 * t);
  };
  for (let f = base; f < floors; f++) {
    const v = f * floorH + 0.15;
    // landing deck
    b.quad(P(ua, v, w), P(ub, v, w), P(ub, v, 0), P(ua, v, 0), 0, 0, lw * t, w * t);
    b.quad(P(ua, v - 0.06, 0), P(ub, v - 0.06, 0), P(ub, v - 0.06, w), P(ua, v - 0.06, w), 0, 0, lw * t, w * t);
    b.quad(P(ua, v - 0.06, w), P(ub, v - 0.06, w), P(ub, v, w), P(ua, v, w), 0, 0, lw * t, 0.06 * t);
    // railings
    for (const vv of [v + 0.52, v + 1.02]) {
      b.quad(P(ua, vv, w), P(ub, vv, w), P(ub, vv + 0.05, w), P(ua, vv + 0.05, w), 0, 0, lw * t, 0.05 * t);
    }
    const n = 7;
    for (let i = 0; i <= n; i++) {
      const u = ua + (i / n) * lw, hw2 = 0.022;
      b.quad(P(u - hw2, v, w), P(u + hw2, v, w), P(u + hw2, v + 1.05, w), P(u - hw2, v + 1.05, w), 0, 0, 0.04, 1.05 * t);
    }
    for (const u of [ua, ub]) {
      b.quad(P(u, v, w), P(u, v, 0), P(u, v + 1.05, 0), P(u, v + 1.05, w), 0, 0, w * t, 1.05 * t);
    }
    // stair stringer down to the landing below
    if (f > base) {
      const dir = (f % 2) ? 1 : -1;
      const sa = dir > 0 ? ua + 0.3 : ub - 0.3;
      const sb = dir > 0 ? ub - 0.3 : ua + 0.3;
      bar(sa, v, w - 0.15, sb, v - floorH, w - 0.15);
      bar(sa, v + 0.9, w - 0.15, sb, v - floorH + 0.9, w - 0.15);
    }
  }
}

/* ------------------------------------------------------------ shopfronts -- */

/**
 * A shopfront that is architecture rather than a decal.
 *
 * The order matters and is the order a real one is built in: stallriser, then
 * a deeply recessed glazing plane behind pilasters, then a transom light, then
 * the entrance set back further again, then the fascia that hides the head of
 * the shop and carries the tenancy's colour. `props` puts the lettered board,
 * the awning and the A-board on top of this — this is the joinery underneath.
 */
export function shopfront(set, wall, {
  ua, ub, v0, v1, rng,
  frameSlot = 'paint', frameColor = 0x23262a,
  bulkhead = 0.52, fasciaH = 0.78,
  signHue = null, awning = false, awningColor = 0x8a2f34, door = false,
  stallSlot = 'stone', stallColor = 0xbdb5a6, blade = false,
}) {
  const g = set.get('glass');
  const f = set.get(frameSlot);
  const t = 1 / (TILE_M[frameSlot] || 1.2);
  const P = (u, v, w) => wall.P(u, v, w);
  const W = ub - ua;
  if (W < 1.2) return;
  const glassTop = v1 - fasciaH - 0.10;
  const glassBot = v0 + bulkhead;
  const rev = 0.26;                       // deep enough to shade, not a cave

  /* ---- stallriser: a real plinth, in its own material ------------------ */
  const sr = set.get(stallSlot);
  const st = 1 / (TILE_M[stallSlot] || 2.6);
  sr.colorHex(stallColor);
  sr.quad(P(ua, v0, 0.055), P(ub, v0, 0.055), P(ub, glassBot, 0.055), P(ua, glassBot, 0.055), 0, 0, W * st, bulkhead * st);
  sr.colorHex(stallColor, 1.08, 1.08, 1.07);
  sr.quad(P(ua, glassBot, 0.055), P(ub, glassBot, 0.055), P(ub, glassBot + 0.05, 0), P(ua, glassBot + 0.05, 0), 0, 0, W * st, 0.09 * st);
  sr.colorHex(stallColor, 0.62, 0.61, 0.60);
  sr.quad(P(ua, glassBot + 0.05, 0), P(ub, glassBot + 0.05, 0), P(ub, glassBot + 0.05, -rev), P(ua, glassBot + 0.05, -rev), 0, 0, W * st, rev * st);

  /* ---- reveal: jambs and head, shaded like any other opening ----------- */
  f.colorHex(frameColor, 0.74, 0.74, 0.76);
  f.quad(P(ua, glassBot, 0), P(ua, glassBot, -rev), P(ua, glassTop, -rev), P(ua, glassTop, 0), 0, 0, rev * t, (glassTop - glassBot) * t);
  f.colorHex(frameColor, 0.80, 0.80, 0.82);
  f.quad(P(ub, glassBot, -rev), P(ub, glassBot, 0), P(ub, glassTop, 0), P(ub, glassTop, -rev), 0, 0, rev * t, (glassTop - glassBot) * t);
  f.colorHex(frameColor, 0.52, 0.52, 0.54);
  f.quad(P(ua, glassTop, -rev), P(ub, glassTop, -rev), P(ub, glassTop, 0), P(ua, glassTop, 0), 0, 0, W * t, rev * t);

  /* ---- the entrance: one bay set back again, with a door and a threshold */
  const hasDoor = door && W > 2.6;
  const du = hasDoor ? ua + W * (0.18 + (rng ? rng.next() : 0.4) * 0.6) : 0;
  const dw = 1.15, dRev = rev + 0.30;
  if (hasDoor) {
    const da = Math.max(ua + 0.25, du - dw / 2), db = Math.min(ub - 0.25, du + dw / 2);
    // the reveal walls of the recess
    f.colorHex(frameColor, 0.68, 0.68, 0.70);
    f.quad(P(da, v0, -rev), P(da, v0, -dRev), P(da, glassTop, -dRev), P(da, glassTop, -rev), 0, 0, 0.30 * t, (glassTop - v0) * t);
    f.quad(P(db, v0, -dRev), P(db, v0, -rev), P(db, glassTop, -rev), P(db, glassTop, -dRev), 0, 0, 0.30 * t, (glassTop - v0) * t);
    f.colorHex(frameColor, 0.48, 0.48, 0.50);
    f.quad(P(da, glassTop, -dRev), P(db, glassTop, -dRev), P(db, glassTop, -rev), P(da, glassTop, -rev), 0, 0, dw * t, 0.30 * t);
    // threshold slab, catching light
    const th = set.get(stallSlot);
    th.colorHex(stallColor, 1.02, 1.02, 1.0);
    th.quad(P(da, v0 + 0.02, -dRev), P(db, v0 + 0.02, -dRev), P(db, v0 + 0.02, 0.14), P(da, v0 + 0.02, 0.14), 0, 0, dw * st, (dRev + 0.14) * st);
    // door leaf + fanlight
    const dTop = Math.min(glassTop - 0.25, v0 + 2.35);
    f.colorHex(frameColor, 0.30, 0.30, 0.33);
    f.quad(P(da + 0.06, v0 + 0.03, -dRev + 0.03), P(db - 0.06, v0 + 0.03, -dRev + 0.03),
      P(db - 0.06, dTop, -dRev + 0.03), P(da + 0.06, dTop, -dRev + 0.03), 0, 0, dw * t, (dTop - v0) * t);
    g.setGls(GLS.shop[0], GLS.shop[1]);
    g.colorHex(0x8497a2, 1, 1, 1.02);
    g.setWin(rng ? rng.next() * 0.4 : 0.2, 2, 0.55, 0.72);
    const dc = interiorCell(CELL_CLEAR);
    g.quad(P(da + 0.16, v0 + 0.55, -dRev + 0.05), P(db - 0.16, v0 + 0.55, -dRev + 0.05),
      P(db - 0.16, dTop - 0.10, -dRev + 0.05), P(da + 0.16, dTop - 0.10, -dRev + 0.05), dc[0], dc[1], dc[2], dc[3]);
  }

  /* ---- shop glazing: big clean panes, split by slim mullions ----------- */
  const nm = Math.max(1, Math.round(W / 1.45));
  g.setGls(GLS.shop[0], GLS.shop[1]);
  for (let i = 0; i < nm; i++) {
    const pa = ua + (i / nm) * W, pb = ua + ((i + 1) / nm) * W;
    if (hasDoor && pb > du - dw / 2 - 0.1 && pa < du + dw / 2 + 0.1) continue;
    // A shop window is the brightest thing at street level, not the darkest:
    // it is a lit interior seen through clean glass. The reserved neutral cell
    // stands in for a shopfitted interior rather than a bedroom blind.
    const k = 1 + (rng ? (rng.next() - 0.5) * 0.16 : 0);
    g.colorHex(0x9db0ba, k, k, k * 1.02);
    g.setWin(rng ? rng.next() * 0.45 : 0.2, 2, rng ? rng.next() * 0.5 + 0.4 : 0.6, 0.72);
    const c = interiorCell(CELL_CLEAR);
    g.quad(P(pa, glassBot, -rev), P(pb, glassBot, -rev), P(pb, glassTop, -rev), P(pa, glassTop, -rev), c[0], c[1], c[2], c[3]);
  }
  f.colorHex(frameColor, 1.15, 1.15, 1.15);
  for (let i = 1; i < nm; i++) {
    const u = ua + (i / nm) * W, hw = 0.05;
    f.quad(P(u - hw, glassBot, -rev + 0.04), P(u + hw, glassBot, -rev + 0.04), P(u + hw, glassTop, -rev + 0.04), P(u - hw, glassTop, -rev + 0.04), 0, 0, 0.10 * t, (glassTop - glassBot) * t);
  }
  // transom bar across the head of the glazing
  f.colorHex(frameColor, 0.95, 0.95, 0.97);
  const tv = glassTop - Math.min(0.55, (glassTop - glassBot) * 0.22);
  f.quad(P(ua, tv, -rev + 0.05), P(ub, tv, -rev + 0.05), P(ub, tv + 0.08, -rev + 0.05), P(ua, tv + 0.08, -rev + 0.05), 0, 0, W * t, 0.08 * t);

  /* ---- fascia: the tenancy's colour, on a board that projects ---------- */
  if (signHue !== null) {
    const sg = set.get('sign');
    const H = [0.015, 0.045, 0.075, 0.115, 0.30, 0.36, 0.47, 0.56, 0.61];
    const hh = H[Math.floor(Math.abs(signHue) * H.length) % H.length];
    const sat = 0.34 + (signHue * 7 % 1) * 0.40;
    const lit = 0.30 + (signHue * 13 % 1) * 0.26;
    const fy0 = v1 - fasciaH, fy1 = v1 - 0.07, pr = 0.16;
    sg.colorHSL(hh, sat, lit);
    sg.quad(P(ua, fy0, pr), P(ub, fy0, pr), P(ub, fy1, pr), P(ua, fy1, pr), 0, 0, 1, 1);
    sg.colorHSL(hh, sat * 0.55, lit * 0.45);
    sg.quad(P(ua, fy0, pr), P(ub, fy0, pr), P(ub, fy0, 0), P(ua, fy0, 0), 0, 0, 1, 1);   // soffit
    sg.colorHSL(hh, sat * 0.7, Math.min(0.9, lit * 1.5));
    sg.quad(P(ua, fy1, 0), P(ub, fy1, 0), P(ub, fy1, pr), P(ua, fy1, pr), 0, 0, 1, 1);   // top
    for (const u of [ua, ub]) {
      sg.colorHSL(hh, sat * 0.6, lit * 0.7);
      sg.quad(P(u, fy0, 0), P(u, fy0, pr), P(u, fy1, pr), P(u, fy1, 0), 0, 0, 1, 1);
    }
    // a projecting blade sign: the thing that actually reads down a street
    if (blade) {
      const bu = ua + W * 0.22, bw = 0.05, bp0 = 0.20, bp1 = 1.05;
      const by0 = fy0 - 1.15, by1 = fy0 - 0.12;
      sg.colorHSL(hh, sat * 0.95, Math.min(0.86, lit * 1.7));
      sg.quad(P(bu - bw, by0, bp0), P(bu - bw, by0, bp1), P(bu - bw, by1, bp1), P(bu - bw, by1, bp0), 0, 0, 1, 1);
      sg.quad(P(bu + bw, by0, bp1), P(bu + bw, by0, bp0), P(bu + bw, by1, bp0), P(bu + bw, by1, bp1), 0, 0, 1, 1);
      sg.colorHSL(hh, sat * 0.5, lit * 0.5);
      sg.quad(P(bu - bw, by1, bp0), P(bu - bw, by1, bp1), P(bu + bw, by1, bp1), P(bu + bw, by1, bp0), 0, 0, 1, 1);
      const br = set.get(frameSlot);
      br.colorHex(frameColor, 0.7, 0.7, 0.72);
      br.quad(P(bu - 0.02, by1, bp0), P(bu + 0.02, by1, bp0), P(bu + 0.02, by1 + 0.55, bp0 - 0.06), P(bu - 0.02, by1 + 0.55, bp0 - 0.06), 0, 0, 0.1, 0.6);
    }
  }

  if (awning) {
    const sg = set.get('sign');
    const proj = 1.15, av = glassTop - 0.10;
    const c = awningColor;
    sg.colorHex(c, 0.34, 0.34, 0.34);
    sg.quad(P(ua + 0.08, av + 0.66, 0.02), P(ub - 0.08, av + 0.66, 0.02), P(ub - 0.08, av - 0.05, proj), P(ua + 0.08, av - 0.05, proj), 0, 0, 1, 1);
    sg.colorHex(c, 0.15, 0.15, 0.15);
    sg.quad(P(ua + 0.08, av - 0.05, proj), P(ub - 0.08, av - 0.05, proj), P(ub - 0.08, av + 0.66, 0.02), P(ua + 0.08, av + 0.66, 0.02), 0, 0, 1, 1);
    sg.colorHex(c, 0.38, 0.38, 0.38);
    sg.quad(P(ua + 0.08, av - 0.34, proj), P(ub - 0.08, av - 0.34, proj), P(ub - 0.08, av - 0.05, proj), P(ua + 0.08, av - 0.05, proj), 0, 0, 1, 1);
    sg.quad(P(ub - 0.08, av - 0.34, proj - 0.02), P(ua + 0.08, av - 0.34, proj - 0.02), P(ua + 0.08, av - 0.05, proj - 0.02), P(ub - 0.08, av - 0.05, proj - 0.02), 0, 0, 1, 1);
    sg.colorHex(c, 0.26, 0.26, 0.26);
    sg.tri(P(ua + 0.08, av - 0.34, proj), P(ua + 0.08, av + 0.66, 0.02), P(ua + 0.08, av - 0.05, proj), 0, 0, 1, 0, 0, 1);
    sg.tri(P(ub - 0.08, av - 0.34, proj), P(ub - 0.08, av - 0.05, proj), P(ub - 0.08, av + 0.66, 0.02), 0, 0, 1, 0, 0, 1);
  }
}

/**
 * A residential or office entrance: the thing every non-retail building in this
 * city was missing. A recessed door bay with a surround, a canopy over it and
 * steps down to the pavement, scaled by `grand` — a walk-up door is 1.1 m wide,
 * a tower lobby is 4 m and two storeys tall.
 */
export function entrance(set, wall, {
  uc, v0, h = 2.6, grand = 0,
  slot = 'paint', color = 0x33363a,
  stoneSlot = 'stone', stoneColor = 0xc9c1b0,
  glassColor = 0x4a5a64, rng = null,
}) {
  const P = (u, v, w) => wall.P(u, v, w);
  const w = 1.15 + grand * 2.9;            // leaf width
  const rev = 0.30 + grand * 0.55;
  const ua = uc - w / 2, ub = uc + w / 2;
  const sur = 0.28 + grand * 0.30;         // surround width
  const f = set.get(slot);
  const t = 1 / (TILE_M[slot] || 1.2);
  const st = set.get(stoneSlot);
  const ts = 1 / (TILE_M[stoneSlot] || 2.6);

  // stone surround, standing proud of the wall
  st.colorHex(stoneColor, 1.04, 1.04, 1.02);
  st.quad(P(ua - sur, v0, 0.10), P(ua, v0, 0.10), P(ua, v0 + h + sur, 0.10), P(ua - sur, v0 + h + sur, 0.10), 0, 0, sur * ts, (h + sur) * ts);
  st.quad(P(ub, v0, 0.10), P(ub + sur, v0, 0.10), P(ub + sur, v0 + h + sur, 0.10), P(ub, v0 + h + sur, 0.10), 0, 0, sur * ts, (h + sur) * ts);
  st.quad(P(ua, v0 + h, 0.10), P(ub, v0 + h, 0.10), P(ub, v0 + h + sur, 0.10), P(ua, v0 + h + sur, 0.10), 0, 0, w * ts, sur * ts);
  st.colorHex(stoneColor, 0.72, 0.71, 0.70);
  st.quad(P(ua - sur, v0, 0.10), P(ua - sur, v0, 0), P(ua - sur, v0 + h + sur, 0), P(ua - sur, v0 + h + sur, 0.10), 0, 0, 0.1 * ts, (h + sur) * ts);
  st.quad(P(ub + sur, v0, 0), P(ub + sur, v0, 0.10), P(ub + sur, v0 + h + sur, 0.10), P(ub + sur, v0 + h + sur, 0), 0, 0, 0.1 * ts, (h + sur) * ts);

  // the recess itself, baked dark — a doorway is the deepest shade on a facade
  f.colorHex(color, 0.44, 0.44, 0.46);
  f.quad(P(ua, v0, 0), P(ua, v0, -rev), P(ua, v0 + h, -rev), P(ua, v0 + h, 0), 0, 0, rev * t, h * t);
  f.colorHex(color, 0.56, 0.56, 0.58);
  f.quad(P(ub, v0, -rev), P(ub, v0, 0), P(ub, v0 + h, 0), P(ub, v0 + h, -rev), 0, 0, rev * t, h * t);
  f.colorHex(color, 0.30, 0.30, 0.32);
  f.quad(P(ua, v0 + h, -rev), P(ub, v0 + h, -rev), P(ub, v0 + h, 0), P(ua, v0 + h, 0), 0, 0, w * t, rev * t);

  // leaf (or a glazed lobby screen when grand)
  if (grand > 0.4) {
    const g = set.get('glass');
    g.setGls(GLS.shop[0], GLS.shop[1]);
    g.colorHex(0x7f929d, 1, 1, 1.04);
    g.setWin(rng ? rng.next() * 0.3 : 0.1, 2, 0.62, 0.72);
    const c = interiorCell(CELL_CLEAR);
    g.quad(P(ua + 0.10, v0 + 0.05, -rev), P(ub - 0.10, v0 + 0.05, -rev), P(ub - 0.10, v0 + h - 0.12, -rev), P(ua + 0.10, v0 + h - 0.12, -rev), c[0], c[1], c[2], c[3]);
    f.colorHex(color, 1.1, 1.1, 1.12);
    const mid = (ua + ub) / 2;
    for (const u of [mid - 0.6, mid + 0.6]) {
      f.quad(P(u - 0.05, v0, -rev + 0.03), P(u + 0.05, v0, -rev + 0.03), P(u + 0.05, v0 + h - 0.12, -rev + 0.03), P(u - 0.05, v0 + h - 0.12, -rev + 0.03), 0, 0, 0.1 * t, h * t);
    }
  } else {
    f.colorHex(color, 0.86, 0.86, 0.88);
    f.quad(P(ua + 0.07, v0 + 0.02, -rev + 0.04), P(ub - 0.07, v0 + 0.02, -rev + 0.04),
      P(ub - 0.07, v0 + h - 0.16, -rev + 0.04), P(ua + 0.07, v0 + h - 0.16, -rev + 0.04), 0, 0, w * t, h * t);
    const g = set.get('glass');   // fanlight
    g.setGls(GLS.window[0], GLS.window[1]);
    g.colorHex(0x3d4a53); g.setWin(rng ? rng.next() : 0.5, 0, 0.35, 0.2);
    const c = roomCell(rng ? rng.next() * 977 : 3);
    g.quad(P(ua + 0.16, v0 + h - 0.72, -rev + 0.02), P(ub - 0.16, v0 + h - 0.72, -rev + 0.02),
      P(ub - 0.16, v0 + h - 0.24, -rev + 0.02), P(ua + 0.16, v0 + h - 0.24, -rev + 0.02), c[0], c[1], c[2], c[3]);
  }

  // canopy on a bracket, and the steps below
  const cw = w + sur * 2 + 0.3, cp = 0.85 + grand * 0.9;
  st.colorHex(stoneColor, 0.95, 0.95, 0.94);
  st.quad(P(uc - cw / 2, v0 + h + sur, cp), P(uc + cw / 2, v0 + h + sur, cp), P(uc + cw / 2, v0 + h + sur + 0.16, cp), P(uc - cw / 2, v0 + h + sur + 0.16, cp), 0, 0, cw * ts, 0.16 * ts);
  st.quad(P(uc - cw / 2, v0 + h + sur + 0.16, cp), P(uc + cw / 2, v0 + h + sur + 0.16, cp), P(uc + cw / 2, v0 + h + sur + 0.16, 0.1), P(uc - cw / 2, v0 + h + sur + 0.16, 0.1), 0, 0, cw * ts, cp * ts);
  st.colorHex(stoneColor, 0.50, 0.49, 0.49);
  st.quad(P(uc + cw / 2, v0 + h + sur, 0.1), P(uc - cw / 2, v0 + h + sur, 0.1), P(uc - cw / 2, v0 + h + sur, cp), P(uc + cw / 2, v0 + h + sur, cp), 0, 0, cw * ts, cp * ts);
  const nst = grand > 0.4 ? 3 : 2;
  st.colorHex(stoneColor, 0.90, 0.90, 0.88);
  for (let i = 0; i < nst; i++) {
    const hh = 0.16 * (nst - i);
    st.box(uc - cw / 2 - 0.1, 0, 0, 0, 0, 0, 1, 0);   // keep the slot warm
    const z0 = 0.10 + 0.34 * i, z1 = z0 + 0.34;
    st.quad(P(uc - cw / 2, v0 - 0.02 + hh, z1), P(uc + cw / 2, v0 - 0.02 + hh, z1), P(uc + cw / 2, v0 - 0.02 + hh, z0), P(uc - cw / 2, v0 - 0.02 + hh, z0), 0, 0, cw * ts, 0.34 * ts);
    st.colorHex(stoneColor, 0.66, 0.65, 0.65);
    st.quad(P(uc - cw / 2, v0 - 0.02 + hh - 0.17, z1), P(uc + cw / 2, v0 - 0.02 + hh - 0.17, z1), P(uc + cw / 2, v0 - 0.02 + hh, z1), P(uc - cw / 2, v0 - 0.02 + hh, z1), 0, 0, cw * ts, 0.17 * ts);
    st.colorHex(stoneColor, 0.90, 0.90, 0.88);
  }
}

/* ----------------------------------------------------- the punched facade -- */

/**
 * A masonry wall with punched window openings, floor by floor.
 * `plan` is an array of floors: { y0, y1, type } where type is one of
 * 'retail' | 'res' | 'office' | 'blank' | 'lobby'.
 */
export function punchedFacade(set, wall, p) {
  const {
    plan, wallSlot, wallColor, wallTint = [1, 1, 1],
    rng, occ = 0, isStreet = false, isVisible = true,
    bayW = 3.2, winFrac = 0.52, winTop = 0.30, sillH = 0.90,
    reveal = 0.24, jambColor = 0xe6e0d4, cillSlot = 'stone', cillColor = 0xcdc5b4,
    glassColor = 0x2b3742,
    shopHue = null, awningColor = 0x8a2f34, awnings = false,
    balconies = 0, balconyEvery = 3, glassRail = false,
    stringCourse = false, courseColor = 0xcdc5b4,
    barChance = 0.0, lintel = false, lod = 0,
    spandrelTint = null,
    lit = null, gls = null, tilt = 0.012, floor0 = 0,
    frontFace = false, baseCourse = null, entranceAt = null, groundKind = 'res',
  } = p;
  const GW = gls || (occ === 1 ? GLS.office : GLS.window);

  const L = wall.len;
  const b = set.get(wallSlot);
  const tile = TILE_M[wallSlot] || 2;
  const nb = Math.max(1, Math.round(L / bayW));
  const bw = L / nb;

  if (!isVisible) {
    // A blank flank — a party wall, or an elevation nobody can reach. It still
    // has to read as masonry rather than as one painted sheet, so it is built
    // storey by storey with a slab-line shadow and a little tonal drift.
    for (let fi = 0; fi < plan.length; fi++) {
      const fl = plan[fi];
      const k = 0.955 + ((fi * 0.41) % 1) * 0.09;
      b.colorHex(wallColor, wallTint[0] * k, wallTint[1] * k, wallTint[2] * k);
      wall.q(b, 0, fl.y0, L, fl.y1 - 0.09, 0, tile);
      b.colorHex(wallColor, wallTint[0] * k * 0.80, wallTint[1] * k * 0.80, wallTint[2] * k * 0.80);
      wall.q(b, 0, fl.y1 - 0.09, L, fl.y1, 0, tile);
    }
    if (lod === 0 && L > 6) {
      // one expansion / party joint, off-centre
      b.colorHex(wallColor, wallTint[0] * 0.72, wallTint[1] * 0.72, wallTint[2] * 0.72);
      const u = L * 0.38;
      wall.q(b, u, plan[0].y0, u + 0.14, plan[plan.length - 1].y1, 0.01, tile);
    }
    return;
  }

  for (let fi = 0; fi < plan.length; fi++) {
    const fl = plan[fi];
    const y0 = fl.y0, y1 = fl.y1;
    b.colorHex(wallColor, wallTint[0], wallTint[1], wallTint[2]);

    if (fl.type === 'blank') {
      wall.q(b, 0, y0, L, y1, 0, tile);
      continue;
    }

    if (lod >= 1) {
      // Simplified tier: bands, piers and a flat glass pane — no reveal, no
      // cill, no lintel. Roughly a fifth of the triangles, same silhouette.
      const fh1 = y1 - y0;
      const isShop = fl.type === 'retail' || fl.type === 'lobby';
      const sh = isShop ? 0.45 : (sillH ?? 0.9);
      const th = isShop ? 0.55 : winTop;
      const ww1 = isShop ? bw * 0.90 : bw * winFrac;
      const va1 = y0 + sh, vb1 = Math.max(va1 + 0.6, y0 + fh1 - th);
      wall.q(b, 0, y0, L, va1, 0, tile);
      wall.q(b, 0, vb1, L, y1, 0, tile);
      for (let i = 0; i <= nb; i++) {
        const u = i * bw;
        const a = Math.max(0, u - (bw - ww1) / 2), c = Math.min(L, u + (bw - ww1) / 2);
        if (c > a) wall.q(b, a, va1, c, vb1, 0, tile);
      }
      // The simplified tier has no reveal geometry, so it gets the reveal's
      // *shadow* instead: a dark band at the head of every opening and a
      // lighter one at the cill. Two quads per bay, and it is the difference
      // between a window and a printed rectangle.
      const hb = Math.min(0.34, (vb1 - va1) * 0.16);
      for (let i = 0; i < nb; i++) {
        const uc = (i + 0.5) * bw;
        b.colorHex(wallColor, wallTint[0] * 0.42, wallTint[1] * 0.41, wallTint[2] * 0.41);
        wall.q(b, uc - ww1 / 2, vb1 - hb, uc + ww1 / 2, vb1, -0.02, tile);
        b.colorHex(wallColor, wallTint[0] * 1.06, wallTint[1] * 1.05, wallTint[2] * 1.03);
        wall.q(b, uc - ww1 / 2 - 0.09, va1 - 0.10, uc + ww1 / 2 + 0.09, va1, 0.06, tile);
      }
      b.colorHex(wallColor, wallTint[0], wallTint[1], wallTint[2]);
      const g1 = set.get('glass');
      g1.setGls(isShop ? GLS.shop[0] : GW[0], isShop ? GLS.shop[1] : GW[1]);
      for (let i = 0; i < nb; i++) {
        const uc = (i + 0.5) * bw;
        const k = 1 + (rng.next() - 0.5) * 0.14;
        g1.colorHex(isShop ? 0x46535c : glassColor, k, k, k * 1.02);
        const [ph, wm] = paneLit(lit, floor0 + fi, rng.next(), rng.next());
        g1.setWin(ph, isShop ? 2 : occ, wm, isShop ? 0.72 : (rng.next() < 0.08 ? 0.97 : rng.next() * 0.45));
        const c1 = roomCell(paneCell(rng.next(), floor0 + fi, i));
        g1.quad(
          wall.P(uc - ww1 / 2, va1, -0.10), wall.P(uc + ww1 / 2, va1, -0.10),
          wall.P(uc + ww1 / 2, vb1, -0.10), wall.P(uc - ww1 / 2, vb1, -0.10),
          c1[0], c1[1], c1[2], c1[3]);
      }
      b.colorHex(wallColor, wallTint[0], wallTint[1], wallTint[2]);
      continue;
    }

    if (fl.type === 'retail' && isStreet) {
      // Tenancies, not a repeat. Real frontage is a run of leases of different
      // widths, each with its own fascia colour, divided by a structural pier —
      // the varied rhythm is most of what makes a block read as inhabited.
      const cuts = [0];
      let u = 0;
      while (u < L - 3.4) {
        u += Math.min(L - u, 4.4 + rng.next() * rng.next() * 5.4);
        if (L - u < 3.4) u = L;
        cuts.push(Math.min(u, L));
      }
      if (cuts[cuts.length - 1] < L) cuts.push(L);
      const pier = Math.min(0.95, L / Math.max(2, cuts.length - 1) * 0.14);
      for (const c0 of cuts) {
        const a = Math.max(0, c0 - pier / 2), c = Math.min(L, c0 + pier / 2);
        if (c > a) wall.q(b, a, y0, c, y1, 0, tile);
      }
      for (let sI = 0; sI < cuts.length - 1; sI++) {
        const ua = cuts[sI] + pier / 2, ub = cuts[sI + 1] - pier / 2;
        if (ub - ua < 1.4) continue;
        shopfront(set, wall, {
          ua, ub, v0: y0, v1: y1, rng,
          bulkhead: 0.42 + rng.next() * 0.28,
          fasciaH: 0.62 + rng.next() * 0.34,
          signHue: shopHue === null ? null : (shopHue + sI * 0.37 + rng.next() * 0.06) % 1,
          awning: awnings && rng.next() < 0.42,
          awningColor,
          door: rng.next() < 0.86,
          blade: rng.next() < 0.34,
          stallSlot: cillSlot, stallColor: cillColor,
        });
      }
      continue;
    }

    if (fl.type === 'lobby' && isStreet) {
      // A lobby is not a shop: full-height glazing between stone piers, with a
      // revolving-door-scale entrance set into the middle of it.
      const pier = 1.35;
      wall.q(b, 0, y0, pier, y1, 0, tile);
      wall.q(b, L - pier, y0, L, y1, 0, tile);
      wall.q(b, pier, y1 - 0.85, L - pier, y1, 0, tile);
      shopfront(set, wall, {
        ua: pier, ub: L - pier, v0: y0, v1: y1 - 0.85, rng,
        frameColor: 0x2a2d31, bulkhead: 0.22, fasciaH: 0.22,
        signHue: null, door: false,
        stallSlot: cillSlot, stallColor: cillColor,
      });
      if (frontFace && L > 7) {
        entrance(set, wall, {
          uc: L * 0.5, v0: y0, h: Math.min(y1 - y0 - 1.1, 4.2), grand: 1, rng,
          slot: 'paint', color: 0x2a2d31, stoneSlot: cillSlot, stoneColor: cillColor,
        });
      }
      continue;
    }

    // A base course: the building visibly sits on the street instead of being
    // extruded through it. Different material, projecting, with its own shadow.
    if (fi === 0 && baseCourse && lod === 0) {
      const bs = set.get(baseCourse.slot);
      const bt = 1 / (TILE_M[baseCourse.slot] || 2.6);
      const bh = baseCourse.h;
      const Pb = (u, v, w) => wall.P(u, v, w);
      bs.colorHex(baseCourse.color);
      bs.quad(Pb(0, y0, 0.09), Pb(L, y0, 0.09), Pb(L, y0 + bh, 0.09), Pb(0, y0 + bh, 0.09), 0, 0, L * bt, bh * bt);
      bs.colorHex(baseCourse.color, 1.06, 1.06, 1.04);
      bs.quad(Pb(0, y0 + bh, 0.09), Pb(L, y0 + bh, 0.09), Pb(L, y0 + bh + 0.04, 0), Pb(0, y0 + bh + 0.04, 0), 0, 0, L * bt, 0.11 * bt);
      bs.colorHex(baseCourse.color, 0.58, 0.57, 0.56);
      bs.quad(Pb(0, y0 + bh + 0.04, 0), Pb(L, y0 + bh + 0.04, 0), Pb(L, y0 + bh + 0.16, 0), Pb(0, y0 + bh + 0.16, 0), 0, 0, L * bt, 0.12 * bt);
    }

    // ---- ordinary punched floor -----------------------------------------
    const fh = y1 - y0;
    const ww = bw * winFrac;
    const wh = Math.max(0.9, fh - sillH - winTop);
    const va = y0 + sillH, vb = va + wh;

    // band below the windows and above them — a slightly different tone under
    // the cill run is what stops six storeys reading as one flat sheet
    if (spandrelTint) b.colorHex(wallColor, wallTint[0] * spandrelTint[0], wallTint[1] * spandrelTint[1], wallTint[2] * spandrelTint[2]);
    wall.q(b, 0, y0, L, va, 0, tile);
    b.colorHex(wallColor, wallTint[0], wallTint[1], wallTint[2]);
    wall.q(b, 0, vb, L, y1, 0, tile);
    // piers
    for (let i = 0; i <= nb; i++) {
      const u = i * bw;
      const a = Math.max(0, u - (bw - ww) / 2), c = Math.min(L, u + (bw - ww) / 2);
      if (c > a) wall.q(b, a, va, c, vb, 0, tile);
      b.colorHex(wallColor, wallTint[0], wallTint[1], wallTint[2]);
    }

    for (let i = 0; i < nb; i++) {
      const uc = (i + 0.5) * bw;
      const ua = uc - ww / 2, ub = uc + ww / 2;
      const [phase, warm] = paneLit(lit, floor0 + fi, rng.next(), rng.next());
      const special = rng.next() < 0.09 ? 0.97 : rng.next() * 0.45;
      opening(set, wall, {
        ua, ub, va, vb, reveal,
        jambColor, glassColor, glassTintJitter: 0.16, rng,
        win: [phase, occ, warm, special],
        bar: rng.next() < barChance ? 1 : 0,
        transomAt: 0.62,
        gls: GW, cell: paneCell(rng.next(), floor0 + fi, i),
        tilt: (rng.next() - 0.5) * tilt * 2,
      });
      cill(set, wall, { ua, ub, v: va, slot: cillSlot, color: cillColor, proj: 0.10 });
      if (lintel) {
        const lb = set.get(cillSlot);
        lb.colorHex(cillColor, 1.03, 1.03, 1.03);
        const t = 1 / (TILE_M[cillSlot] || 2);
        const P = (u, v, w) => wall.P(u, v, w);
        lb.quad(P(ua - 0.12, vb, 0.05), P(ub + 0.12, vb, 0.05), P(ub + 0.12, vb + 0.2, 0.05), P(ua - 0.12, vb + 0.2, 0.05), 0, 0, (ub - ua) * t, 0.2 * t);
        lb.quad(P(ua - 0.12, vb + 0.2, 0.05), P(ub + 0.12, vb + 0.2, 0.05), P(ub + 0.12, vb + 0.2, 0), P(ua - 0.12, vb + 0.2, 0), 0, 0, (ub - ua) * t, 0.05 * t);
      }
      if (balconies > 0 && fi >= 1 && (fi % balconyEvery === 0) && rng.next() < balconies) {
        balcony(set, wall, {
          ua: ua - 0.35, ub: ub + 0.35, v: va - 0.16,
          depth: 1.15, glassRail, rng,
          color: 0xbfb9ad,
        });
      }
      b.colorHex(wallColor, wallTint[0], wallTint[1], wallTint[2]);
    }

    // A door. Every building in this city used to meet the pavement with a
    // blank wall; a residential block gets a walk-up entrance, an office one
    // gets a taller surround, and both get steps and a canopy.
    if (fi === 0 && isStreet && frontFace && entranceAt !== null && lod === 0 && L > 5) {
      entrance(set, wall, {
        uc: Math.min(L - 1.6, Math.max(1.6, entranceAt * L)),
        v0: y0 + 0.02,
        h: Math.min(fh - 0.55, groundKind === 'office' ? 3.4 : 2.55),
        grand: groundKind === 'office' ? 0.55 : 0,
        rng, slot: 'paint', color: jambColor,
        stoneSlot: cillSlot, stoneColor: cillColor,
      });
    }

    if (stringCourse && fi < plan.length - 1) {
      band(set, wall, { v0: y1 - 0.22, v1: y1 - 0.02, proj: 0.11, slot: cillSlot, color: courseColor });
    }
  }
}

/* ------------------------------------------------------ the curtain wall -- */

/**
 * A glazed curtain wall: continuous vertical mullions, per-floor transoms,
 * spandrel bands hiding the slab edge, and per-bay vision glass so night
 * lighting stays per-office rather than per-floor.
 */
export function curtainWall(set, wall, p) {
  const {
    levels, floorH, y0 = 0,
    spandrelSlot = 'concreteDk', spandrelColor = 0x2f3338,
    mullionSlot = 'paint', mullionColor = 0x8e949a,
    glassColor = 0x33474f, tintJitter = 0.22,
    bayW = 3.0, rng, occ = 1, spandrelH = 0.95,
    isVisible = true, vertical = true, lod = 0,
    lit = null, floor0 = 0,
  } = p;

  const L = wall.len;
  const top = y0 + levels * floorH;
  const sp = set.get(spandrelSlot);
  const spTile = TILE_M[spandrelSlot] || 3.6;

  if (!isVisible) {
    sp.colorHex(spandrelColor);
    wall.q(sp, 0, y0, L, top, 0, spTile);
    return;
  }

  const nb = Math.max(1, Math.round(L / (lod >= 1 ? bayW * 2.2 : bayW)));
  const bw = L / nb;
  const g = set.get('glass');
  const mu = set.get(mullionSlot);
  const muTile = TILE_M[mullionSlot] || 1.2;
  const P = (u, v, w) => wall.P(u, v, w);

  // The glazing plane sits behind the face, so the spandrel returns, the
  // transoms and the mullions all self-shadow onto it. That reveal is most of
  // what separates a curtain wall from a striped box.
  const GZ = lod === 0 ? -0.085 : -0.04;
  g.setGls(GLS.curtain[0], GLS.curtain[1]);

  // spandrel bands + vision glass, per floor
  for (let f = 0; f < levels; f++) {
    const fy0 = y0 + f * floorH;
    const sy1 = fy0 + spandrelH;
    const gy1 = fy0 + floorH;
    // panel runs are cast in batches: neighbouring floors are never identical
    const sk = 0.93 + ((f * 0.37) % 1) * 0.14;
    sp.colorHex(spandrelColor, sk, sk, sk * 1.01);
    wall.q(sp, 0, fy0, L, sy1, 0.03, spTile);
    if (lod === 0) {
      // spandrel return down to the glazing plane — the shadow line under
      // every floor band, which is what gives a tower its horizontal rhythm
      sp.colorHex(spandrelColor, sk * 0.62, sk * 0.62, sk * 0.64);
      sp.quad(P(0, sy1, 0.03), P(L, sy1, 0.03), P(L, sy1, GZ), P(0, sy1, GZ), 0, 0, L / spTile, 0.12 / spTile);
      sp.quad(P(L, fy0, 0.03), P(0, fy0, 0.03), P(0, fy0, GZ), P(L, fy0, GZ), 0, 0, L / spTile, 0.12 / spTile);
    }
    for (let i = 0; i < nb; i++) {
      const ua = i * bw + 0.055, ub = (i + 1) * bw - 0.055;
      const k = 1 + (rng.next() - 0.5) * tintJitter;
      g.colorHex(glassColor, k, k * (1 + (rng.next() - 0.5) * 0.12), k * (1 + (rng.next() - 0.5) * 0.16));
      const special = rng.next() < 0.05 ? 0.97 : rng.next() * 0.42;
      const [ph, wm] = paneLit(lit, floor0 + f, rng.next(), rng.next());
      g.setWin(ph, occ, wm, special);
      // sealed units are never dead flat: a fraction of a degree of bow is
      // what makes one pane flare at golden hour while its neighbour does not
      g.setTilt((rng.next() - 0.5) * 0.017, (rng.next() - 0.5) * 0.011);
      const c = roomCell(paneCell(rng.next(), f, i));
      g.quad(P(ua, sy1, GZ), P(ub, sy1, GZ), P(ub, gy1 - 0.02, GZ), P(ua, gy1 - 0.02, GZ),
        c[0], c[1], c[2], c[3]);
      g.setTilt(0, 0);
    }
    // transom rib at the head of each floor
    if (lod === 0) {
      mu.colorHex(mullionColor);
      const tv = gy1 - 0.02;
      mu.quad(P(0, tv, 0.07), P(L, tv, 0.07), P(L, tv + 0.09, 0.07), P(0, tv + 0.09, 0.07), 0, 0, L / muTile, 0.09 / muTile);
      mu.quad(P(0, tv + 0.09, 0.07), P(L, tv + 0.09, 0.07), P(L, tv + 0.09, 0), P(0, tv + 0.09, 0), 0, 0, L / muTile, 0.07 / muTile);
    }
  }

  // continuous vertical mullions, standing proud of the glazing plane
  if (vertical) {
    mu.colorHex(mullionColor, 1.05, 1.05, 1.05);
    const proj = 0.17, hw = 0.055;
    for (let i = 0; i <= nb; i++) {
      const u = Math.min(L - hw, Math.max(hw, i * bw));
      mu.quad(P(u - hw, y0, proj), P(u + hw, y0, proj), P(u + hw, top, proj), P(u - hw, top, proj), 0, 0, 0.11 / muTile, (top - y0) / muTile);
      // the two returns are the shadow catchers: one side is always dark
      mu.colorHex(mullionColor, 0.72, 0.72, 0.74);
      mu.quad(P(u + hw, y0, proj), P(u + hw, y0, GZ), P(u + hw, top, GZ), P(u + hw, top, proj), 0, 0, (proj - GZ) / muTile, (top - y0) / muTile);
      mu.quad(P(u - hw, y0, GZ), P(u - hw, y0, proj), P(u - hw, top, proj), P(u - hw, top, GZ), 0, 0, (proj - GZ) / muTile, (top - y0) / muTile);
      mu.colorHex(mullionColor, 1.05, 1.05, 1.05);
    }
  }
}

export default { makeFrames, Wall, punchedFacade, curtainWall, opening, cill, band, balcony, fireEscape, shopfront };
