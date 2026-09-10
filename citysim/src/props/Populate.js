import * as THREE from 'three';
import { Rng, hashString } from '../core/Rng.js';
import { ZONE } from '../core/World.js';
import { roadFrames, junctions, buildMasks, networkBounds, heightSampler, F } from './Placement.js';
import { SPECIES } from './Vegetation.js';
import { carColor } from './Vehicles.js';

/**
 * Every scatter pass. Placement is *derived*, never random-in-a-box:
 *
 *  - furniture marches along the kerb line of the road graph at real spacings
 *    (30 m lamp columns, 7 m parking meters, ~70 m hydrants), on the side the
 *    segment id selects so a street is consistently lit from one side;
 *  - signals and stop signs are built per junction *arm*, on the near-right
 *    kerb, with the arm reaching over the approach lanes;
 *  - street trees are planted in the verge behind the pavement, one species per
 *    street, and skipped wherever the mask says building/water/steep;
 *  - lot dressing is placed in each building's own frame, so a garden path
 *    starts at the door and a driveway meets the kerb;
 *  - parked cars only go in stationary bays, never on a junction, a crossing,
 *    a hydrant or a bus stop.
 */

const V2 = { x: 0, z: 0 };
const _col = new THREE.Color();
const _col2 = new THREE.Color();

/** Yaw that maps the model's local +X onto (dx,dz). */
const yawX = (dx, dz) => Math.atan2(-dz, dx);
/** Yaw that maps the model's local +Z onto (dx,dz). */
const yawZ = (dx, dz) => Math.atan2(dx, dz);

/* --------------------------------------------------------------- zoning -- */

const KIND_ZONE = {
  house: ZONE.RES_LOW, rowhouse: ZONE.RES_LOW, midrise: ZONE.RES_HIGH,
  retail: ZONE.COM_LOW, tower: ZONE.COM_HIGH, warehouse: ZONE.IND,
  civic: ZONE.CIVIC, office: ZONE.OFFICE,
};

/**
 * Zone lookup. Prefers the zoning module; otherwise stamps a coarse field from
 * the building kinds so the module dresses sensibly on its own.
 */
function zoneField(ctx, bounds) {
  const z = ctx.get('zoning');
  const zoneAt = z && typeof z.zoneAt === 'function' ? z.zoneAt : null;

  const cell = 8;
  const [x0, zz0, x1, z1] = bounds;
  const w = Math.ceil((x1 - x0) / cell) + 2;
  const h = Math.ceil((z1 - zz0) / cell) + 2;
  const grid = new Uint8Array(w * h);
  for (const b of ctx.world.buildings.values()) {
    const p = b.pos || [0, 0, 0];
    const kz = KIND_ZONE[b.kind] || ZONE.RES_LOW;
    const fp = b.footprint || [10, 10];
    const r = Math.max(fp[0], fp[1]) * 0.5 + 20;
    const i0 = Math.max(0, Math.floor((p[0] - r - x0) / cell));
    const i1 = Math.min(w - 1, Math.floor((p[0] + r - x0) / cell));
    const j0 = Math.max(0, Math.floor((p[2] - r - zz0) / cell));
    const j1 = Math.min(h - 1, Math.floor((p[2] + r - zz0) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * w + i;
      if (!grid[k]) grid[k] = kz;
    }
  }
  const local = (x, zc) => {
    const i = Math.floor((x - x0) / cell), j = Math.floor((zc - zz0) / cell);
    if (i < 0 || j < 0 || i >= w || j >= h) return ZONE.NONE;
    return grid[j * w + i];
  };
  if (!zoneAt) return local;
  return (x, zc) => {
    let v = ZONE.NONE;
    try { v = zoneAt(x, zc) | 0; } catch { v = ZONE.NONE; }
    if (v === ZONE.NONE || v === ZONE.ROAD || v === ZONE.RESERVED) {
      const l = local(x, zc);
      if (l) return l;
    }
    return v;
  };
}

const isRes = (z) => z === ZONE.RES_LOW || z === ZONE.RES_HIGH;
const isCom = (z) => z === ZONE.COM_LOW || z === ZONE.COM_HIGH || z === ZONE.OFFICE;
const isBuilt = (z) => z >= ZONE.RES_LOW && z <= ZONE.OFFICE;

/* --------------------------------------------------------------- helpers -- */

function walkY(f, d) { return f.y + 0.15 - 0.016 * Math.max(0, d - f.half); }

function tint(out, base, rng, spread = 0.08) {
  out.copy(base);
  const k = 1 + rng.range(-spread, spread);
  out.multiplyScalar(k);
  return out;
}

const _hsl = { h: 0, s: 0, l: 0 };
/** Jitter hue as well as value — a row of trees varying only in brightness
 *  still reads as one repeated object. */
function tintHSL(out, base, rng, dh = 0.02, ds = 0.10, dl = 0.12) {
  base.getHSL(_hsl);
  out.setHSL(
    (_hsl.h + rng.range(-dh, dh) + 1) % 1,
    Math.max(0, Math.min(1, _hsl.s * (1 + rng.range(-ds, ds)))),
    Math.max(0.02, Math.min(1, _hsl.l * (1 + rng.range(-dl, dl))))
  );
  return out;
}

/* ============================================================== the pass == */

export function populate(ctx, S, opts = {}) {
  const t0 = performance.now();
  const B = S.batches;
  const lib = S.lib;
  const seed = ctx.world.seed >>> 0;
  const density = Math.max(0, Math.min(4, opts.density ?? S.density ?? 1));
  const roads = ctx.get('roads');
  const hAt = heightSampler(ctx);

  const frames = roadFrames(roads, ctx.world, 2.0);
  const jcts = junctions(roads, ctx.world);
  const bounds = opts.bounds || networkBounds(ctx.world, 140);
  const { hard } = buildMasks(ctx, frames, { bounds });
  const zoneAt = zoneField(ctx, bounds);

  // Point test rather than a radius test: furniture legitimately stands within
  // a metre of its own kerb, but must never land inside a *crossing* street.
  const onRoad = (x, z) => (hard.get(x, z) & F.ROAD) !== 0;

  const R = (tag) => new Rng(hashString(`props:${tag}`, seed) >>> 0);

  // Real clustered lights replace the round-2 gobo as the *source* of night
  // light; the gobo stays only as a faint ground bloom under each lamp.
  const L = S.lights;
  if (L) L.begin(bounds);
  const counts = { lamps: 0, trees: 0, cars: 0, furniture: 0, dressing: 0, plants: 0 };

  /* ---------------------------------------------------------- 1 · lamps -- */
  // Critic issue 2: from a 300 m aerial the street grid must be the brightest
  // thing in frame. One lamp every 30 m on a single side does not make a
  // continuous chain, so columns now run down BOTH kerbs, staggered by half a
  // span — which is how a real two-lane street is lit, and doubles the light
  // laid on the ground.
  const rl = R('lamps');
  const lampSpots = [];
  for (const f of frames) {
    if (f.cls === 'alley') continue;
    const wide = f.cls === 'lane4' || f.cls === 'boulevard';
    const spacing = (wide ? 32 : 34) / Math.max(0.35, Math.min(2, density));
    const sides = [1, -1];
    for (const side of sides) {
      const nOff = Math.round(f.length / spacing);
      if (nOff < 1) continue;
      const step = f.length / nOff;
      const stagger = side > 0 ? 0 : step * 0.5;
      for (let k = 0; k <= nOff; k++) {
        const s = k * step + stagger;
        if (s < 7 || s > f.length - 7) continue;
        const i = Math.min(f.pts.length - 1, Math.round((s / f.length) * (f.pts.length - 1)));
        const p = f.pts[i];
        const d = f.half + 0.78;
        const x = p.x + p.nx * side * d, z = p.z + p.nz * side * d;
        if (onRoad(x, z)) continue;
        if (!hard.free(x, z, 0.7, F.BUILDING | F.BAD)) continue;
        if (!hard.free(x, z, 0.5, F.TAKEN)) continue;
        const y = walkY(p, d);
        // arm points back across the carriageway
        const yaw = yawX(-p.nx * side, -p.nz * side);
        B.put('lamp', x, y, z, yaw, 1, 1, 1, tint(_col, LAMP_GREY, rl, 0.05));
        B.put('lamp.lens', x, y, z, yaw);
        hard.disc(x, z, 0.9, F.TAKEN);
        counts.lamps++;
        const hd = lib.lampHead;
        lampSpots.push({
          x: x + Math.cos(yaw) * hd[0], z: z - Math.sin(yaw) * hd[0],
          gy: y, ux: p.ux, uz: p.uz,
        });
        // street name plate on the first column after a junction
        if (k === 1 && rl.bool(0.55)) B.put('namePlate', x, y, z, yaw);
      }
    }
  }
  // A real light at each lantern, plus a much smaller ground bloom. Round 2's
  // gobo was 1.5x wide and did the whole job; now the light does the work and
  // the bloom only fakes the scatter in the air right under the lantern.
  for (const l of lampSpots) {
    if (L) L.add(l.x, l.gy + LAMP_H, l.z, 1.00, 0.745, 0.455, 24.0, 58.0);
    B.put('lightPool', l.x, l.gy + 0.05, l.z, yawX(l.ux, l.uz),
      rl.range(0.80, 0.92), 1, rl.range(0.50, 0.60), _col.setRGB(1, 0.82, 0.56));
  }

  /* -------------------------------------------------------- 2 · signals -- */
  const rj = R('junctions');
  for (const j of jcts) {
    const crossHalf = j.half;
    for (const arm of j.arms) {
      const u = { x: arm.ux, z: arm.uz };
      const L = { x: -u.z, z: u.x };                    // left of the outward arm
      const armHalf = arm.cls === 'lane4' ? 8 : arm.cls === 'boulevard' ? 12 : arm.cls === 'alley' ? 3 : 4.5;
      const back = crossHalf + 2.6;
      const lat = armHalf + 0.95;
      const x = j.x + u.x * back + L.x * lat;
      const z = j.z + u.z * back + L.z * lat;
      if (onRoad(x, z) || !hard.free(x, z, 1.0, F.BUILDING | F.BAD)) continue;
      const y = hAt(x, z) + 0.15;
      if (j.signalled && arm.cls !== 'alley') {
        const yaw = yawX(u.z, -u.x);
        B.put('signal', x, y, z, yaw, 1, 1, 1, tint(_col, LAMP_GREY, rj, 0.05));
        B.put('signal.heads', x, y, z, yaw, 1, 1, 1, tint(_col, DARK_GREY, rj, 0.05));
        // one aspect lit per approach; opposite arms of a junction agree
        const phase = (Math.abs(Math.round(arm.bearing * 2)) % 2) === 0 ? 0 : 2;
        const DIM = 0.055;
        B.put('signal.lensR', x, y, z, yaw, 1, 1, 1,
          phase === 0 ? _col.setRGB(1.0, 0.10, 0.06) : _col.setRGB(0.20 * DIM, 0.02, 0.01));
        B.put('signal.lensA', x, y, z, yaw, 1, 1, 1, _col.setRGB(0.22 * DIM, 0.13 * DIM, 0.0));
        B.put('signal.lensG', x, y, z, yaw, 1, 1, 1,
          phase === 2 ? _col.setRGB(0.10, 1.0, 0.34) : _col.setRGB(0.02, 0.16 * DIM, 0.05));
        counts.furniture++;
      } else if (arm.cls !== 'alley' && rj.bool(0.85)) {
        const yaw = yawZ(u.x, u.z);
        B.put('signPost', x, y, z, yaw);
        B.put(j.rank >= 2 ? 'sign.yield' : 'sign.stop', x, y, z, yaw);
        counts.furniture++;
      }
      // crossing warning + no-parking on the far corner of busier junctions
      if (j.rank >= 2 && rj.bool(0.4)) {
        const x2 = j.x + u.x * (back + 9) + L.x * lat;
        const z2 = j.z + u.z * (back + 9) + L.z * lat;
        if (hard.free(x2, z2, 0.8, F.BUILDING | F.BAD | F.TAKEN)) {
          const yaw = yawZ(u.x, u.z);
          B.put('signPost', x2, hAt(x2, z2) + 0.15, z2, yaw);
          B.put(rj.bool(0.5) ? 'sign.noPark' : 'sign.speed', x2, hAt(x2, z2) + 0.15, z2, yaw);
          hard.disc(x2, z2, 0.8, F.TAKEN);
          counts.furniture++;
        }
      }
      // bollards along the corner radius at signalled junctions
      if (j.signalled && arm === j.arms[0]) {
        B.put('lightPool', j.x, hAt(j.x, j.z) + 0.05, j.z, 0, 2.05, 1, 2.05,
          _col.setRGB(0.92, 0.88, 0.78));
      }
      if (j.signalled) {
        for (let b = 0; b < 3; b++) {
          const bx = j.x + u.x * (crossHalf + 1.4 + b * 1.5) + L.x * (armHalf + 0.55);
          const bz = j.z + u.z * (crossHalf + 1.4 + b * 1.5) + L.z * (armHalf + 0.55);
          if (!hard.free(bx, bz, 0.4, F.BUILDING | F.BAD | F.TAKEN)) continue;
          B.put('bollard', bx, hAt(bx, bz) + 0.15, bz, 0, 1, 1, 1, tint(_col, DARK_GREY, rj, 0.06));
          hard.disc(bx, bz, 0.35, F.TAKEN);
        }
      }
    }
  }

  /* ------------------------------------------------- 3 · kerb furniture -- */
  const rf = R('furniture');
  for (const f of frames) {
    if (f.cls === 'highway') continue;
    const mid = f.pts[Math.floor(f.pts.length / 2)];
    const zn = zoneAt(mid.x + mid.nx * (f.half + f.walk + 6), mid.z + mid.nz * (f.half + f.walk + 6));
    const zn2 = zoneAt(mid.x - mid.nx * (f.half + f.walk + 6), mid.z - mid.nz * (f.half + f.walk + 6));
    const commercial = isCom(zn) || isCom(zn2)
      || zn === ZONE.RES_HIGH || zn2 === ZONE.RES_HIGH || zn === ZONE.CIVIC;
    const alley = f.cls === 'alley';

    const walkPlace = (side, s, dOff, r, flags = F.BUILDING | F.BAD | F.TAKEN) => {
      const i = Math.min(f.pts.length - 1, Math.max(0, Math.round((s / f.length) * (f.pts.length - 1))));
      const p = f.pts[i];
      const d = f.half + dOff;
      const x = p.x + p.nx * side * d, z = p.z + p.nz * side * d;
      if (onRoad(x, z)) return null;
      if (!hard.free(x, z, r, flags)) return null;
      return { x, z, y: walkY(p, d), p, side, d };
    };

    if (!alley) {
      // parking meters along commercial kerbs
      if (commercial) {
        for (let s = 9; s < f.length - 9; s += 7.2 / Math.max(0.4, density)) {
          for (const side of [1, -1]) {
            if (!rf.bool(0.62)) continue;
            const q = walkPlace(side, s, 0.62, 0.4);
            if (!q) continue;
            B.put('meter', q.x, q.y, q.z, yawZ(-q.p.nx * side, -q.p.nz * side), 1, 1, 1,
              tint(_col, DARK_GREY, rf, 0.07));
            hard.disc(q.x, q.z, 0.5, F.TAKEN);
            counts.furniture++;
          }
        }
      }
      // hydrants
      for (let s = 24; s < f.length - 18; s += 58) {
        const side = rf.sign();
        const q = walkPlace(side, s + rf.range(-6, 6), 0.85, 0.5);
        if (!q) continue;
        B.put('hydrant', q.x, q.y, q.z, rf.range(0, 6.28), 1, 1, 1,
          _col.setHSL(rf.range(0.99, 1.02) % 1, 0.62, rf.range(0.30, 0.40)));
        hard.disc(q.x, q.z, 0.7, F.TAKEN);
        counts.furniture++;
      }
      // bins, benches, mailboxes, news boxes, planters
      const binStep = (commercial ? 28 : 44) / Math.max(0.4, density);
      for (let s = 16; s < f.length - 14; s += binStep) {
        const side = ((s / binStep) | 0) & 1 ? 1 : -1;
        const q = walkPlace(side, s + rf.range(-4, 4), f.walk > 2.6 ? 1.15 : 0.72, 0.55);
        if (!q) continue;
        B.put('bin', q.x, q.y, q.z, rf.range(0, 6.28), 1, 1, 1, tint(_col, BIN_GREEN, rf, 0.10));
        hard.disc(q.x, q.z, 0.7, F.TAKEN);
        counts.furniture++;
      }
      if (f.walk >= 2.2) {
        const benchStep = (commercial ? 34 : 58) / Math.max(0.4, density);
        for (let s = 26; s < f.length - 20; s += benchStep) {
          const side = rf.sign();
          const q = walkPlace(side, s + rf.range(-5, 5), f.walk - 0.85, 1.1);
          if (!q) continue;
          const yaw = yawZ(-q.p.nx * side, -q.p.nz * side);
          B.put('bench.frame', q.x, q.y, q.z, yaw, 1, 1, 1, tint(_col, DARK_GREY, rf, 0.08));
          B.put('bench.slats', q.x, q.y, q.z, yaw, 1, 1, 1, tint(_col, BENCH_WOOD, rf, 0.10));
          hard.disc(q.x, q.z, 1.2, F.TAKEN);
          counts.furniture++;
        }
      }
      if (commercial && f.walk >= 2.0) {
        for (let s = 30; s < f.length - 24; s += 26 / Math.max(0.4, density)) {
          const side = rf.sign();
          if (!rf.bool(0.5)) continue;
          const q = walkPlace(side, s, 0.95, 0.75);
          if (!q) continue;
          B.put('planter', q.x, q.y, q.z, rf.range(0, 6.28), 1, 1, 1, tint(_col, CONCRETE, rf, 0.07));
          B.put('flowers', q.x, q.y + 0.55, q.z, rf.range(0, 6.28), rf.range(0.8, 1.05), 1, rf.range(0.8, 1.05),
            _col.setHSL(rf.range(0.02, 0.16), rf.range(0.45, 0.8), rf.range(0.42, 0.60)));
          hard.disc(q.x, q.z, 0.85, F.TAKEN);
          counts.furniture++;
        }
      }
      // one mailbox and a pair of news boxes per longer street
      if (f.length > 70 && rf.bool(0.6)) {
        const q = walkPlace(rf.sign(), f.length * rf.range(0.25, 0.75), 0.9, 0.6);
        if (q) {
          B.put('mailbox', q.x, q.y, q.z, yawZ(-q.p.nx * q.side, -q.p.nz * q.side), 1, 1, 1,
            _col.setHSL(0.58, 0.42, 0.30));
          hard.disc(q.x, q.z, 0.8, F.TAKEN);
          counts.furniture++;
        }
      }
      if (commercial && rf.bool(0.5)) {
        const s0 = f.length * rf.range(0.2, 0.8);
        for (let k = 0; k < 2; k++) {
          const q = walkPlace(rf.sign(), s0 + k * 0.55, 0.8, 0.35);
          if (!q) continue;
          B.put('newsBox', q.x, q.y, q.z, yawZ(-q.p.nx * q.side, -q.p.nz * q.side), 1, 1, 1,
            _col.setHSL(rf.range(0, 1), 0.55, 0.42));
          hard.disc(q.x, q.z, 0.45, F.TAKEN);
        }
      }
      // utility cabinet at the back of the pavement
      if (f.length > 90 && f.walk >= 2.2 && rf.bool(0.55)) {
        const q = walkPlace(rf.sign(), f.length * rf.range(0.2, 0.8), f.walk - 0.55, 1.0);
        if (q) {
          B.put('cabinet', q.x, q.y, q.z, yawZ(-q.p.nx * q.side, -q.p.nz * q.side), 1, 1, 1,
            tint(_col, CABINET, rf, 0.06));
          B.put('cabinet.door', q.x, q.y, q.z, yawZ(-q.p.nx * q.side, -q.p.nz * q.side));
          hard.disc(q.x, q.z, 1.1, F.TAKEN);
          counts.furniture++;
        }
      }
      // bus shelter on the wider roads
      if ((f.cls === 'lane4' || f.cls === 'boulevard') && f.walk >= 2.8 && f.length > 110) {
        const side = rf.sign();
        const q = walkPlace(side, f.length * rf.range(0.32, 0.68), f.walk * 0.55 + 0.2, 2.4);
        if (q) {
          const yaw = yawZ(-q.p.nx * side, -q.p.nz * side);
          B.put('shelter', q.x, q.y, q.z, yaw, 1, 1, 1, tint(_col, DARK_GREY, rf, 0.05));
          B.put('shelter.glass', q.x, q.y, q.z, yaw);
          const fx = q.x + q.p.nx * side * -1.9, fz = q.z + q.p.nz * side * -1.9;
          B.put('signPost', fx, walkY(q.p, f.half + 0.6), fz, yaw, 1, 1.05, 1);
          B.put('sign.bus', fx, walkY(q.p, f.half + 0.6), fz, yaw);
          hard.disc(q.x, q.z, 2.6, F.TAKEN);
          counts.furniture++;
        }
      }
    }
  }

  /* ---------------------------------------------------- 4 · street trees -- */
  const rt = R('trees');
  const streetSpecies = new Map();
  for (const f of frames) {
    if (f.cls === 'alley') continue;
    let sp = streetSpecies.get(f.seg.id);
    if (!sp) {
      sp = rt.weighted([['plane', 3], ['oak', 3], ['birch', 2.6], ['conifer', 1.5]]);
      streetSpecies.set(f.seg.id, sp);
    }
    const spacing = (f.cls === 'boulevard' ? 14.5 : 12.5) / Math.max(0.4, Math.min(1.8, density));
    for (const side of [1, -1]) {
      const n = Math.floor(f.length / spacing);
      if (n < 1) continue;
      for (let k = 0; k <= n; k++) {
        const s = (k + 0.5) * (f.length / (n + 1));
        const i = Math.min(f.pts.length - 1, Math.round((s / f.length) * (f.pts.length - 1)));
        const p = f.pts[i];
        const zn = zoneAt(p.x + p.nx * side * (f.half + f.walk + 8), p.z + p.nz * side * (f.half + f.walk + 8));
        if (!isBuilt(zn) && zn !== ZONE.PARK && zn !== ZONE.CIVIC) continue;
        if (zn === ZONE.IND && !rt.bool(0.25)) continue;
        const d = f.half + f.walk + rt.range(1.35, 1.85);
        const x = p.x + p.nx * side * d + rt.range(-0.35, 0.35);
        const z = p.z + p.nz * side * d + rt.range(-0.35, 0.35);
        if (onRoad(x, z)) continue;
        if (!hard.free(x, z, 1.6, F.BUILDING | F.BAD)) continue;
        if (!hard.free(x, z, 3.0, F.TAKEN)) continue;
        const spHere = rt.bool(0.12)
          ? rt.weighted([['oak', 2], ['plane', 2], ['birch', 2], ['conifer', 1]]) : sp;
        plantTree(B, lib, rt, spHere, x, hAt(x, z), z, rt.range(0.80, 1.12), true);
        hard.disc(x, z, 2.4, F.TAKEN);
        counts.trees++;
      }
    }
  }

  /* -------------------------------------------------- 5 · park planting -- */
  const rp = R('park');
  const parks = findParks(ctx, zoneAt, bounds, hard);
  for (const park of parks) {
    dressPark(B, lib, rp, park, hard, hAt, counts, L);
  }

  /* --------------------------------------------------- 6 · lot dressing -- */
  const rd = R('lots');
  for (const b of ctx.world.buildings.values()) {
    dressLot(ctx, B, lib, rd, b, zoneAt, hard, hAt, roads, counts, density, L);
  }

  /* ---------------------------------------------------- 7 · parked cars -- */
  const rc = R('cars');
  for (const f of frames) {
    if (f.cls === 'boulevard' || f.cls === 'lane4') continue;   // no bay: traffic uses the full width
    const mid = f.pts[Math.floor(f.pts.length / 2)];
    const zn = zoneAt(mid.x, mid.z);
    if (!isBuilt(zn) && zn !== ZONE.PARK) continue;
    const occupancy = f.cls === 'alley' ? 0.22 : (isCom(zn) ? 0.62 : 0.5);
    const bay = 6.4;
    for (const side of [1, -1]) {
      for (let s = 12; s < f.length - 12; s += bay) {
        if (!rc.bool(occupancy * Math.min(1.4, density))) continue;
        const i = Math.min(f.pts.length - 1, Math.round((s / f.length) * (f.pts.length - 1)));
        const p = f.pts[i];
        if (p.dEnd < 11) continue;
        const d = Math.max(1.3, f.half - 1.02);
        const x = p.x + p.nx * side * d, z = p.z + p.nz * side * d;
        if (!hard.free(x, z, 1.1, F.BUILDING | F.BAD | F.JUNCTION | F.TAKEN)) continue;
        const type = rc.weighted([['sedan', 5], ['hatch', 4], ['van', 1.4]]);
        // parked with the flow: +Z of the model points along travel on that side
        const dir = side > 0 ? -1 : 1;
        const yaw = yawZ(p.ux * dir, p.uz * dir) + rc.range(-0.035, 0.035);
        const y = p.y + 0.01;
        carColor(rc, _col);
        B.put(`car.${type}`, x, y, z, yaw, 1, 1, 1, _col);
        B.put(`car.${type}.glass`, x, y, z, yaw);
        B.put(`car.${type}.wheels`, x, y, z, yaw);
        hard.disc(x, z, 2.6, F.TAKEN);
        counts.cars++;
      }
    }
  }

  /* -------------------------------------------------- 8 · ground cover -- */
  const rg = R('ground');
  scatterGround(ctx, B, rg, frames, zoneAt, hard, hAt, bounds, counts, density);

  /* ------------------------------------------------ 9 · overhead wires -- */
  const wires = overheadWires(ctx, S, frames, zoneAt, hard, hAt, B, R('wires'));

  const lightStats = L ? L.commit() : null;
  const built = B.build(S.group, S.mats);
  if (wires) { S.group.add(wires); S.extras.push(wires); built.drawCalls += 1; }

  return {
    ...built,
    ...counts,
    lights: lightStats ? lightStats.lights : 0,
    lightCells: lightStats ? lightStats.cells : 0,
    lightsDropped: lightStats ? lightStats.dropped : 0,
    kinds: B.report(),
    ms: Math.round(performance.now() - t0),
  };
}

/* ------------------------------------------------------------- palettes -- */

const LAMP_H = 8.18;       // lantern height above the column base
const LAMP_GREY = new THREE.Color(0x6f7479);
const DARK_GREY = new THREE.Color(0x3d4147);
const BIN_GREEN = new THREE.Color(0x3c5245);
const BENCH_WOOD = new THREE.Color(0x9a7145);
const CONCRETE = new THREE.Color(0xb6b2a8);
const CABINET = new THREE.Color(0x8b8f89);
// Critic: "one tree species, one saturated yellow-green ... reading as plastic".
// These are now genuinely different greens, all pulled down in value and
// saturation so they sit with the masonry and asphalt instead of on top of it.
const LEAF_TINTS = {
  oak: new THREE.Color(0x74895a),      // deep, slightly blue mid-green
  plane: new THREE.Color(0x93a066),    // olive
  birch: new THREE.Color(0xafbe83),    // pale yellow-green
  conifer: new THREE.Color(0x55684f),  // dark blue-green
};
const BARK_TINTS = {
  oak: new THREE.Color(0xa89880), plane: new THREE.Color(0xc4bda8),
  birch: new THREE.Color(0xe4e0d4), conifer: new THREE.Color(0x8c7358),
};

/* ---------------------------------------------------------------- trees -- */

function plantTree(B, lib, rng, sp, x, y, z, scale, pit) {
  const v = rng.int(2);
  const yaw = rng.range(0, 6.283);
  const lean = rng.range(-0.045, 0.045);
  const leanZ = rng.range(-0.045, 0.045);
  tint(_col, BARK_TINTS[sp] || BARK_TINTS.oak, rng, 0.12);
  tintHSL(_col2, LEAF_TINTS[sp] || LEAF_TINTS.oak, rng, 0.030, 0.22, 0.20);
  const sy = scale * rng.range(0.94, 1.08);
  B.put(`tree.${sp}.${v}.bark`, x, y, z, yaw, scale, sy, scale, _col, lean, leanZ);
  B.put(`tree.${sp}.${v}.leaf`, x, y, z, yaw, scale, sy, scale, _col2, lean, leanZ);
  B.put(`tree.${sp}.mid`, x, y, z, yaw, scale, sy, scale, _col2, lean, leanZ);
  B.put(`tree.${sp}.far`, x, y, z, yaw, scale, sy, scale, _col2);
  if (pit) {
    B.put('decal', x, y + 0.035, z, rng.range(0, 6.28), rng.range(2.2, 3.0), 1, rng.range(2.2, 3.0),
      _col.setRGB(0.85, 0.80, 0.72));
  }
}

/* ----------------------------------------------------------------- park -- */

function findParks(ctx, zoneAt, bounds, hard) {
  const [x0, z0, x1, z1] = bounds;
  const step = 8;
  const w = Math.floor((x1 - x0) / step) + 1;
  const h = Math.floor((z1 - z0) / step) + 1;
  const grid = new Uint8Array(w * h);
  let any = false;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = x0 + i * step, z = z0 + j * step;
      if (zoneAt(x, z) === ZONE.PARK && hard.free(x, z, 1.0, F.ROAD | F.BUILDING | F.BAD)) {
        grid[j * w + i] = 1; any = true;
      }
    }
  }
  if (!any) return [];
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (!grid[k] || seen[k]) continue;
      stack.length = 0; stack.push(k); seen[k] = 1;
      const cells = [];
      while (stack.length) {
        const c = stack.pop();
        cells.push(c);
        const ci = c % w, cj = (c / w) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
          const nk = nj * w + ni;
          if (grid[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
        }
      }
      if (cells.length < 6) continue;
      let sx = 0, sz = 0, mnx = Infinity, mnz = Infinity, mxx = -Infinity, mxz = -Infinity;
      for (const c of cells) {
        const x = x0 + (c % w) * step, z = z0 + (((c / w) | 0)) * step;
        sx += x; sz += z;
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
      out.push({
        cx: sx / cells.length, cz: sz / cells.length,
        rx: Math.max(6, (mxx - mnx) / 2), rz: Math.max(6, (mxz - mnz) / 2),
        cells: cells.map((c) => [x0 + (c % w) * step, z0 + (((c / w) | 0)) * step]),
        area: cells.length * step * step,
      });
    }
  }
  return out;
}

function dressPark(B, lib, rng, park, hard, hAt, counts, L) {
  const { cx, cz, rx, rz } = park;
  const pathR = 0.66;
  const ring = [];
  const N = Math.max(14, Math.round((rx + rz) * 0.5));
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    ring.push([cx + Math.cos(a) * rx * pathR, cz + Math.sin(a) * rz * pathR, a]);
  }
  // gravel path laid as overlapping slabs along the ring
  for (let i = 0; i < N; i++) {
    const [x, z, a] = ring[i];
    if (!hard.free(x, z, 1.0, F.ROAD | F.BUILDING | F.BAD)) continue;
    const step = (2 * Math.PI / N) * Math.max(rx, rz) * pathR;
    // local +X must lie along the ring tangent, which is -(a + pi/2)
    B.put('gravel', x, hAt(x, z) + 0.035, z, -(a + Math.PI / 2), Math.max(2.4, step * 1.5), 1, 2.6,
      _col.setRGB(0.92, 0.90, 0.86));
    hard.disc(x, z, 1.4, F.TAKEN);
  }
  // a straight path across the middle
  const cross = Math.max(rx, rz) * 1.2;
  const ca = rng.range(0, Math.PI);
  for (let s = -cross; s <= cross; s += 2.2) {
    const x = cx + Math.cos(ca) * s, z = cz + Math.sin(ca) * s;
    if (!hard.free(x, z, 1.0, F.ROAD | F.BUILDING | F.BAD)) continue;
    B.put('gravel', x, hAt(x, z) + 0.035, z, -ca, 2.6, 1, 2.2, _col.setRGB(0.92, 0.90, 0.86));
    hard.disc(x, z, 1.3, F.TAKEN);
  }
  // benches + lamps along the ring, facing in
  for (let i = 0; i < N; i += Math.max(2, Math.round(N / 8))) {
    const [x, z, a] = ring[i];
    const bx = x + Math.cos(a) * 2.2, bz = z + Math.sin(a) * 2.2;
    if (hard.free(bx, bz, 1.2, F.ROAD | F.BUILDING | F.BAD | F.TAKEN)) {
      const yaw = yawZ(-Math.cos(a), -Math.sin(a));
      B.put('bench.frame', bx, hAt(bx, bz), bz, yaw, 1, 1, 1, tint(_col, DARK_GREY, rng, 0.08));
      B.put('bench.slats', bx, hAt(bx, bz), bz, yaw, 1, 1, 1, tint(_col, BENCH_WOOD, rng, 0.10));
      hard.disc(bx, bz, 1.4, F.TAKEN);
      counts.furniture++;
    }
    if (i % (Math.max(2, Math.round(N / 8)) * 2) === 0) {
      const lx = x - Math.cos(a) * 2.0, lz = z - Math.sin(a) * 2.0;
      if (hard.free(lx, lz, 0.8, F.ROAD | F.BUILDING | F.BAD | F.TAKEN)) {
        const ly = hAt(lx, lz);
        B.put('parkLamp', lx, ly, lz, 0, 1, 1, 1, tint(_col, DARK_GREY, rng, 0.05));
        B.put('parkLamp.lens', lx, ly, lz, 0);
        if (L) L.add(lx, ly + 4.4, lz, 1.00, 0.80, 0.56, 13.0, 22.0);
        B.put('lightPool', lx, ly + 0.05, lz, 0, 0.46, 1, 0.46, _col.setRGB(1, 0.88, 0.74));
        hard.disc(lx, lz, 1.0, F.TAKEN);
        counts.lamps++;
      }
    }
  }
  // Planting: groves around a handful of centres plus a few specimen trees,
  // with the middle of the park left as open lawn. A park planted by uniform
  // rejection sampling reads as a plantation, not as a park.
  const nGrove = 3 + rng.int(3);
  const groves = [];
  for (let g = 0; g < nGrove; g++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(0.55, 0.95);
    groves.push([cx + Math.cos(a) * rx * r, cz + Math.sin(a) * rz * r,
      rng.range(0.16, 0.32) * Math.max(rx, rz)]);
  }
  const nTrees = Math.min(120, Math.round(park.area / 420));
  for (let i = 0; i < nTrees; i++) {
    let x, z;
    if (rng.bool(0.78)) {
      const g = groves[rng.int(groves.length)];
      const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next()) * g[2];
      x = g[0] + Math.cos(a) * r; z = g[1] + Math.sin(a) * r;
    } else {
      const a = rng.range(0, Math.PI * 2), r = 0.35 + rng.next() * 0.6;
      x = cx + Math.cos(a) * rx * r; z = cz + Math.sin(a) * rz * r;
    }
    if (!hard.free(x, z, 2.2, F.ROAD | F.BUILDING | F.BAD | F.TAKEN)) continue;
    const sp = rng.weighted([['oak', 4], ['plane', 2], ['birch', 2.5], ['conifer', 2]]);
    plantTree(B, lib, rng, sp, x, hAt(x, z), z, rng.range(0.7, 1.35), false);
    hard.disc(x, z, 4.2, F.TAKEN);
    counts.trees++;
  }
  const nShrub = Math.min(200, Math.round(park.area / 150));
  for (let i = 0; i < nShrub; i++) {
    const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next());
    const x = cx + Math.cos(a) * rx * r, z = cz + Math.sin(a) * rz * r;
    if (!hard.free(x, z, 1.1, F.ROAD | F.BUILDING | F.BAD | F.TAKEN)) continue;
    if (rng.bool(0.72)) {
      B.put('shrub', x, hAt(x, z), z, rng.range(0, 6.28), rng.range(0.7, 1.3), rng.range(0.7, 1.2), rng.range(0.7, 1.3),
        _col.setHSL(rng.range(0.24, 0.32), rng.range(0.30, 0.52), rng.range(0.24, 0.40)));
    } else {
      B.put('flowers', x, hAt(x, z), z, rng.range(0, 6.28), rng.range(0.9, 1.5), 1, rng.range(0.9, 1.5),
        _col.setHSL(rng.range(0.0, 0.18), rng.range(0.5, 0.85), rng.range(0.44, 0.62)));
    }
    hard.disc(x, z, 1.3, F.TAKEN);
    counts.plants++;
  }
}

/* ------------------------------------------------------------- lot work -- */

function dressLot(ctx, B, lib, rng, b, zoneAt, hard, hAt, roads, counts, density, L) {
  const p = b.pos || [0, 0, 0];
  const fp = b.footprint || [12, 10];
  const rot = b.rotation || 0;
  const W = fp[0], D = fp[1];
  const n = [-Math.sin(rot), -Math.cos(rot)];       // outward front normal
  const t = [-n[1], n[0]];                          // along the frontage
  const y0 = p[1];
  // The building's own kind is the most reliable signal — zoning may not be up,
  // and a midrise on a retail street still wants a shopfront dressed.
  const kind = b.kind || null;
  let zn = zoneAt(p[0], p[2]);
  if (kind === 'house' || kind === 'rowhouse') zn = ZONE.RES_LOW;
  else if (kind === 'retail') zn = ZONE.COM_LOW;
  else if (kind === 'midrise') zn = isBuilt(zn) ? zn : ZONE.RES_HIGH;
  else if (kind === 'tower') zn = ZONE.COM_HIGH;
  else if (kind === 'warehouse') zn = ZONE.IND;
  else if (kind === 'civic') zn = ZONE.CIVIC;

  // where is the kerb in front of this building?
  let front = 6;
  try {
    const fx = p[0] + n[0] * (D / 2 + 1), fz = p[2] + n[1] * (D / 2 + 1);
    const np = roads && roads.nearestPoint ? roads.nearestPoint({ x: fx, z: fz }) : null;
    if (np && np.dist < 60) front = np.dist - 1;
  } catch { front = 6; }
  const gap = Math.max(0, front - 2.6);             // usable depth in front of the building

  const at = (u, v, out) => {                        // u along frontage, v outward
    out.x = p[0] + t[0] * u + n[0] * v;
    out.z = p[2] + t[1] * u + n[1] * v;
    return out;
  };
  const free = (x, z, r) => hard.free(x, z, r, F.ROAD | F.BUILDING | F.BAD | F.TAKEN);
  const yawFront = Math.atan2(n[0], n[1]);

  /* --- ground-floor shopfront, whatever the plot is zoned -------------
     R-bldg-7: `buildings` now cuts a frontage into 3-6 tenancies of 4.4-9.8 m,
     each with its own pier, stallriser and fascia board. Round 2 put ONE fixed
     3.0 m sign per *building*, which floated over a 7 m tenancy. Take the cuts
     from `buildings.tenanciesNear()` when it exists, and otherwise derive the
     same subdivision so the lettering lands on a board either way. */
  const shopfront = kind === 'retail' || isCom(zn)
    || ((kind === 'midrise' || kind === 'rowhouse') && rng.bool(0.45));
  if (shopfront && zn !== ZONE.IND && front < 22) {
    const facadeY0 = y0 + 3.35;
    let tenancies = null;
    const bapi = ctx.get('buildings');
    if (bapi && typeof bapi.tenanciesNear === 'function') {
      try {
        const got = bapi.tenanciesNear([p[0], p[1], p[2]], Math.max(W, D) * 0.75);
        if (Array.isArray(got) && got.length) tenancies = got;
      } catch { tenancies = null; }
    }
    if (!tenancies) {
      // same rule as buildings: 3-6 bays of 4.4-9.8 m across the frontage
      tenancies = [];
      const nT = Math.max(1, Math.min(6, Math.round(W / rng.range(5.4, 7.6))));
      let acc = -W / 2;
      const share = W / nT;
      for (let i = 0; i < nT; i++) {
        const wid = Math.max(3.6, Math.min(9.8, share * rng.range(0.82, 1.18)));
        const u0 = acc, u1 = Math.min(W / 2, acc + wid);
        if (u1 - u0 < 3.0) break;
        tenancies.push({ u0, u1, y: facadeY0 });
        acc = u1;
        if (acc >= W / 2 - 2.0) break;
      }
    }

    for (const t2 of tenancies) {
      const uMid = ((t2.u0 ?? 0) + (t2.u1 ?? 0)) * 0.5;
      const tw = Math.abs((t2.u1 ?? 3) - (t2.u0 ?? 0));
      if (tw < 2.6) continue;
      const fy = Number.isFinite(t2.y) ? t2.y : facadeY0;
      // the lettered board is scaled to the bay it sits on, never fixed at 3 m
      const sxSign = Math.max(0.62, Math.min(3.0, (tw * 0.88) / 3.0));
      at(uMid, D / 2 + 0.10, V2);
      B.put(`shopSign.${8 + rng.int(3)}`, V2.x, fy, V2.z, yawFront, sxSign, 1, 1);
      if (L) {
        // the fascia is back-lit: a small warm light in front of the shopfront
        at(uMid, D / 2 + 1.5, V2);
        L.add(V2.x, hAt(V2.x, V2.z) + 3.1, V2.z, 1.00, 0.83, 0.60,
          Math.max(9, tw * 1.6), 16.0);
      }
      if (rng.bool(0.55)) {
        at(uMid, D / 2 + 0.06, V2);
        const aw = hAt(V2.x, V2.z);
        const sxAw = Math.max(0.62, Math.min(2.6, (tw * 0.9) / 3.1));
        B.put('awning', V2.x, Math.max(aw + 2.9, fy - 0.55), V2.z, yawFront, sxAw, 1, 1,
          _col.setHSL(rng.range(0, 1), rng.range(0.35, 0.62), rng.range(0.30, 0.46)));
        B.put('awning.frame', V2.x, Math.max(aw + 2.9, fy - 0.55), V2.z, yawFront, sxAw, 1, 1,
          tint(_col, DARK_GREY, rng, 0.05));
      }
      // an A-board outside about half the bays
      if (gap > 1.0 && rng.bool(0.42)) {
        at(uMid + rng.range(-tw * 0.25, tw * 0.25), D / 2 + Math.min(1.1, gap * 0.6), V2);
        if (free(V2.x, V2.z, 0.5)) {
          B.put('aBoard', V2.x, hAt(V2.x, V2.z), V2.z, yawFront + rng.range(-0.4, 0.4));
          hard.disc(V2.x, V2.z, 0.6, F.TAKEN);
        }
      }
      counts.dressing++;
    }
  }

  /* --- residential ---------------------------------------------------- */
  if (isRes(zn) || zn === ZONE.NONE) {
    if (gap > 1.5) {
      // garden path from the door out to the pavement
      const pu = rng.range(-W * 0.18, W * 0.18);
      for (let v = D / 2 + 0.6; v < D / 2 + gap; v += 1.1) {
        at(pu, v, V2);
        if (!hard.free(V2.x, V2.z, 0.5, F.ROAD | F.BUILDING | F.BAD)) break;
        B.put('slab', V2.x, hAt(V2.x, V2.z) + 0.035, V2.z, yawFront, 1.15, 1, 1.2,
          _col.setRGB(0.90, 0.88, 0.84));
      }
      // driveway to one side, meeting the kerb
      if (gap > 3.4 && W > 9 && rng.bool(0.62)) {
        const du = (rng.bool() ? 1 : -1) * (W / 2 - 1.6);
        for (let v = D / 2 - 0.4; v < D / 2 + gap + 0.6; v += 1.4) {
          at(du, v, V2);
          if (!hard.free(V2.x, V2.z, 0.9, F.BUILDING | F.BAD)) break;
          B.put('slab', V2.x, hAt(V2.x, V2.z) + 0.03, V2.z, yawFront, 2.9, 1, 1.5,
            _col.setRGB(0.80, 0.79, 0.77));
        }
        // a car on the drive
        if (rng.bool(0.5)) {
          at(du, D / 2 + Math.min(gap - 0.4, 3.0), V2);
          if (free(V2.x, V2.z, 1.4)) {
            const ty = rng.weighted([['sedan', 4], ['hatch', 4], ['van', 1]]);
            carColor(rng, _col);
            const yy = hAt(V2.x, V2.z) + 0.01;
            B.put(`car.${ty}`, V2.x, yy, V2.z, yawFront, 1, 1, 1, _col);
            B.put(`car.${ty}.glass`, V2.x, yy, V2.z, yawFront);
            B.put(`car.${ty}.wheels`, V2.x, yy, V2.z, yawFront);
            hard.disc(V2.x, V2.z, 2.4, F.TAKEN);
            counts.cars++;
          }
        }
      }
      // boundary treatment along the frontage
      const style = zn === ZONE.RES_HIGH
        ? rng.weighted([['hedge', 5], ['wall', 4], ['none', 3]])
        : rng.weighted([['fence', 4], ['hedge', 4], ['wall', 2], ['none', 1.4]]);
      if (style !== 'none') {
        const bv = D / 2 + gap - 0.5;
        const halfW = W / 2 + 1.2;
        for (let u = -halfW; u <= halfW; u += 2.0) {
          at(u, bv, V2);
          if (!hard.free(V2.x, V2.z, 0.55, F.ROAD | F.BUILDING | F.BAD)) continue;
          const yy = hAt(V2.x, V2.z);
          const yawT = Math.atan2(t[0], t[1]) + Math.PI / 2;
          if (style === 'fence') {
            B.put('fence', V2.x, yy, V2.z, yawT, 1, rng.range(0.94, 1.05), 1,
              tint(_col, FENCE_WOOD, rng, 0.09));
          } else if (style === 'hedge') {
            B.put('hedge', V2.x, yy, V2.z, yawT, 1.02, rng.range(0.85, 1.15), rng.range(0.9, 1.15),
              _col.setHSL(rng.range(0.25, 0.31), rng.range(0.30, 0.48), rng.range(0.20, 0.32)));
          } else {
            B.put('wall', V2.x, yy, V2.z, yawT, 1, rng.range(0.85, 1.0), 1, tint(_col, BRICK, rng, 0.08));
            B.put('wall.coping', V2.x, yy, V2.z, yawT, 1, rng.range(0.85, 1.0), 1, tint(_col, CONCRETE, rng, 0.06));
          }
          hard.disc(V2.x, V2.z, 0.6, F.TAKEN);
          counts.dressing++;
        }
      }
      // front-garden shrubs
      for (let i = 0; i < 3; i++) {
        at(rng.range(-W * 0.42, W * 0.42), D / 2 + rng.range(0.8, Math.max(1.0, gap - 0.8)), V2);
        if (!free(V2.x, V2.z, 0.9)) continue;
        B.put(rng.bool(0.7) ? 'shrub' : 'flowers', V2.x, hAt(V2.x, V2.z), V2.z, rng.range(0, 6.28),
          rng.range(0.55, 0.95), rng.range(0.5, 0.9), rng.range(0.55, 0.95),
          _col.setHSL(rng.range(0.22, 0.33), rng.range(0.28, 0.5), rng.range(0.22, 0.38)));
        hard.disc(V2.x, V2.z, 1.0, F.TAKEN);
        counts.plants++;
      }
    }
    // rear garden
    const rv = -(D / 2 + 3.0);
    if (rng.bool(0.7 * Math.min(1.5, density))) {
      at(rng.range(-W * 0.3, W * 0.3), rv, V2);
      if (free(V2.x, V2.z, 2.0)) {
        const yy = hAt(V2.x, V2.z);
        const pick = rng.weighted([['shed', 5], ['garage', 2], ['pool', 1.1], ['patio', 3]]);
        const yaw = yawFront + Math.PI;
        if (pick === 'shed') {
          B.put('shed', V2.x, yy, V2.z, yaw, 1, 1, 1, tint(_col, SHED_WOOD, rng, 0.10));
          hard.disc(V2.x, V2.z, 2.0, F.TAKEN);
        } else if (pick === 'garage') {
          // long axis along the front normal, door on the face toward the house
          B.put('garage', V2.x, yy, V2.z, yawFront, 1, 1, 1, tint(_col, CONCRETE, rng, 0.07));
          B.put('garage.door', V2.x + n[0] * 2.81, yy, V2.z + n[1] * 2.81, yawFront, 1, 1, 1,
            tint(_col, LAMP_GREY, rng, 0.09));
          hard.disc(V2.x, V2.z, 3.2, F.TAKEN);
        } else if (pick === 'pool') {
          B.put('pool.coping', V2.x, yy, V2.z, yaw, 1, 1, 1, tint(_col, CONCRETE, rng, 0.05));
          B.put('pool.water', V2.x, yy, V2.z, yaw);
          hard.disc(V2.x, V2.z, 3.0, F.TAKEN);
        } else {
          B.put('slab', V2.x, yy + 0.03, V2.z, yaw, 3.6, 1, 3.0, _col.setRGB(0.86, 0.84, 0.80));
          B.put('table.top', V2.x, yy, V2.z, yaw, 1, 1, 1, tint(_col, BENCH_WOOD, rng, 0.1));
          B.put('table.base', V2.x, yy, V2.z, yaw, 1, 1, 1, tint(_col, DARK_GREY, rng, 0.06));
          for (let c = 0; c < 3; c++) {
            const a = rng.range(0, 6.28);
            B.put('chair', V2.x + Math.cos(a) * 0.95, yy, V2.z + Math.sin(a) * 0.95,
              yawZ(-Math.cos(a), -Math.sin(a)), 1, 1, 1, tint(_col, DARK_GREY, rng, 0.08));
          }
          if (rng.bool(0.45)) {
            B.put('parasol', V2.x, yy, V2.z, rng.range(0, 6.28), 1, 1, 1,
              _col.setHSL(rng.range(0.0, 0.18), rng.range(0.28, 0.55), rng.range(0.40, 0.58)));
            B.put('parasol.pole', V2.x, yy, V2.z, 0, 1, 1, 1, tint(_col, LAMP_GREY, rng, 0.05));
          }
          hard.disc(V2.x, V2.z, 2.6, F.TAKEN);
        }
        counts.dressing++;
      }
    }
    // a garden tree out the back
    if (rng.bool(0.55)) {
      at(rng.range(-W * 0.45, W * 0.45), -(D / 2 + rng.range(3.5, 7)), V2);
      if (free(V2.x, V2.z, 2.2)) {
        plantTree(B, lib, rng, rng.pick(SPECIES), V2.x, hAt(V2.x, V2.z), V2.z, rng.range(0.7, 1.15), false);
        hard.disc(V2.x, V2.z, 2.8, F.TAKEN);
        counts.trees++;
      }
    }
    return;
  }

  /* --- commercial ------------------------------------------------------ */
  if (isCom(zn) || zn === ZONE.CIVIC) {
    if (gap > 1.6) {
      // paved forecourt with café seating and an A-board
      for (let u = -W * 0.4; u <= W * 0.4; u += 2.4) {
        at(u, D / 2 + gap * 0.5, V2);
        if (!hard.free(V2.x, V2.z, 1.0, F.ROAD | F.BUILDING | F.BAD)) continue;
        B.put('slab', V2.x, hAt(V2.x, V2.z) + 0.032, V2.z, yawFront, 2.5, 1, Math.max(1.2, gap * 0.9),
          _col.setRGB(0.88, 0.87, 0.85));
      }
      if (rng.bool(0.7)) {
        at(rng.range(-W * 0.35, W * 0.35), D / 2 + 0.9, V2);
        if (free(V2.x, V2.z, 0.5)) {
          B.put('aBoard', V2.x, hAt(V2.x, V2.z), V2.z, yawFront + rng.range(-0.4, 0.4));
          hard.disc(V2.x, V2.z, 0.6, F.TAKEN);
        }
      }
      const nT = 1 + rng.int(3);
      for (let i = 0; i < nT; i++) {
        at(rng.range(-W * 0.4, W * 0.4), D / 2 + rng.range(1.2, Math.max(1.4, gap - 0.6)), V2);
        if (!free(V2.x, V2.z, 1.3)) continue;
        const yy = hAt(V2.x, V2.z);
        B.put('table.top', V2.x, yy, V2.z, 0, 0.82, 1, 0.82, tint(_col, BENCH_WOOD, rng, 0.1));
        B.put('table.base', V2.x, yy, V2.z, 0, 0.82, 1, 0.82, tint(_col, DARK_GREY, rng, 0.06));
        for (let c = 0; c < 2; c++) {
          const a = rng.range(0, 6.28);
          B.put('chair', V2.x + Math.cos(a) * 0.8, yy, V2.z + Math.sin(a) * 0.8,
            yawZ(-Math.cos(a), -Math.sin(a)), 0.9, 0.9, 0.9, tint(_col, DARK_GREY, rng, 0.08));
        }
        hard.disc(V2.x, V2.z, 1.5, F.TAKEN);
        counts.dressing++;
      }
    }
    // bollard run protecting a wide civic / office forecourt
    if ((zn === ZONE.CIVIC || zn === ZONE.OFFICE || zn === ZONE.COM_HIGH) && gap > 2.2) {
      for (let u = -W * 0.45; u <= W * 0.45; u += 1.6) {
        at(u, D / 2 + gap - 0.7, V2);
        if (!free(V2.x, V2.z, 0.4)) continue;
        B.put('bollard', V2.x, hAt(V2.x, V2.z), V2.z, 0, 1, 1, 1, tint(_col, DARK_GREY, rng, 0.06));
        hard.disc(V2.x, V2.z, 0.5, F.TAKEN);
      }
      counts.dressing++;
    }
    // service yard behind
    at(rng.range(-W * 0.3, W * 0.3), -(D / 2 + 2.4), V2);
    if (free(V2.x, V2.z, 1.6) && rng.bool(0.6)) {
      const yy = hAt(V2.x, V2.z);
      B.put('dumpster', V2.x, yy, V2.z, yawFront + rng.range(-0.3, 0.3), 1, 1, 1, tint(_col, SKIP, rng, 0.10));
      B.put('dumpster.lid', V2.x, yy, V2.z, yawFront + rng.range(-0.3, 0.3), 1, 1, 1, tint(_col, SKIP, rng, 0.10));
      hard.disc(V2.x, V2.z, 1.8, F.TAKEN);
      counts.dressing++;
    }
    return;
  }

  /* --- industrial ------------------------------------------------------ */
  if (zn === ZONE.IND) {
    const yard = Math.max(4, gap);
    // hardstanding
    for (let u = -W * 0.55; u <= W * 0.55; u += 3.0) {
      for (let v = D / 2 + 1.5; v < D / 2 + yard; v += 3.0) {
        at(u, v, V2);
        if (!hard.free(V2.x, V2.z, 1.4, F.ROAD | F.BUILDING | F.BAD)) continue;
        B.put('gravel', V2.x, hAt(V2.x, V2.z) + 0.028, V2.z, yawFront, 3.1, 1, 3.1,
          _col.setRGB(0.86, 0.85, 0.82));
      }
    }
    at(rng.range(-W * 0.25, W * 0.25), D / 2 + 1.0, V2);
    if (free(V2.x, V2.z, 2.4)) {
      B.put('dock', V2.x, hAt(V2.x, V2.z), V2.z, yawFront, 1, 1, 1, tint(_col, CONCRETE, rng, 0.06));
      hard.disc(V2.x, V2.z, 2.6, F.TAKEN);
      counts.dressing++;
    }
    for (let i = 0; i < 4; i++) {
      at(rng.range(-W * 0.55, W * 0.55), D / 2 + rng.range(3, Math.max(3.5, yard)), V2);
      if (!free(V2.x, V2.z, 3.2)) continue;
      const yy = hAt(V2.x, V2.z);
      const pick = rng.weighted([['container', 4], ['pallets', 3.4], ['tank', 1.2], ['dumpster', 2]]);
      const yaw = yawFront + (rng.bool(0.5) ? 0 : Math.PI / 2) + rng.range(-0.06, 0.06);
      if (pick === 'container') {
        B.put('container', V2.x, yy, V2.z, yaw, 1, 1, 1,
          _col.setHSL(rng.range(0, 1), rng.range(0.2, 0.55), rng.range(0.18, 0.36)));
        hard.disc(V2.x, V2.z, 3.4, F.TAKEN);
      } else if (pick === 'pallets') {
        B.put('pallets', V2.x, yy, V2.z, yaw, 1, 1, 1, tint(_col, SHED_WOOD, rng, 0.1));
        hard.disc(V2.x, V2.z, 1.2, F.TAKEN);
      } else if (pick === 'tank') {
        B.put('tank', V2.x, yy, V2.z, yaw, 1, 1, 1, tint(_col, TANK, rng, 0.06));
        hard.disc(V2.x, V2.z, 2.0, F.TAKEN);
      } else {
        B.put('dumpster', V2.x, yy, V2.z, yaw, 1, 1, 1, tint(_col, SKIP, rng, 0.1));
        B.put('dumpster.lid', V2.x, yy, V2.z, yaw, 1, 1, 1, tint(_col, SKIP, rng, 0.1));
        hard.disc(V2.x, V2.z, 1.6, F.TAKEN);
      }
      counts.dressing++;
    }
    // a couple of vans in the yard
    for (let i = 0; i < 2; i++) {
      at(rng.range(-W * 0.4, W * 0.4), D / 2 + rng.range(2.5, Math.max(3, yard - 1)), V2);
      if (!free(V2.x, V2.z, 2.0)) continue;
      carColor(rng, _col);
      const yy = hAt(V2.x, V2.z) + 0.01;
      const yaw = yawFront + rng.range(-0.2, 0.2);
      B.put('car.van', V2.x, yy, V2.z, yaw, 1, 1, 1, _col);
      B.put('car.van.glass', V2.x, yy, V2.z, yaw);
      B.put('car.van.wheels', V2.x, yy, V2.z, yaw);
      hard.disc(V2.x, V2.z, 3.0, F.TAKEN);
      counts.cars++;
    }
    // ground-level plant against the flank
    at(W / 2 + 1.2, 0, V2);
    if (free(V2.x, V2.z, 0.8)) {
      B.put('ac', V2.x, hAt(V2.x, V2.z), V2.z, yawFront + Math.PI / 2, 1, 1, 1, tint(_col, LAMP_GREY, rng, 0.06));
      hard.disc(V2.x, V2.z, 0.9, F.TAKEN);
    }
  }
}

const FENCE_WOOD = new THREE.Color(0xb59a72);
const SHED_WOOD = new THREE.Color(0x8f7147);
const BRICK = new THREE.Color(0xc8b6a4);
const SKIP = new THREE.Color(0x4c6a52);
const TANK = new THREE.Color(0xb9bcbd);

/* -------------------------------------------------------- ground cover -- */

function scatterGround(ctx, B, rng, frames, zoneAt, hard, hAt, bounds, counts, density) {
  // verge tufts hugging the road, where the eye actually lands
  const budget = Math.round(1800 * Math.min(1.6, density));
  let placed = 0;
  for (const f of frames) {
    if (placed >= budget) break;
    for (const side of [1, -1]) {
      const step = 2.6;
      for (let s = 2; s < f.length - 2 && placed < budget; s += step) {
        if (!rng.bool(0.55)) continue;
        const i = Math.min(f.pts.length - 1, Math.round((s / f.length) * (f.pts.length - 1)));
        const p = f.pts[i];
        const d = f.half + f.walk + rng.range(0.35, 2.6);
        const x = p.x + p.nx * side * d + rng.range(-0.6, 0.6);
        const z = p.z + p.nz * side * d + rng.range(-0.6, 0.6);
        if (!hard.free(x, z, 0.4, F.ROAD | F.BUILDING | F.BAD)) continue;
        B.put('grass', x, hAt(x, z), z, rng.range(0, 6.28),
          rng.range(0.7, 1.5), rng.range(0.6, 1.35), rng.range(0.7, 1.5),
          _col.setHSL(rng.range(0.20, 0.28), rng.range(0.22, 0.45), rng.range(0.26, 0.44)));
        placed++;
      }
    }
  }
  counts.plants += placed;

  // scrub + hedgerow on undeveloped land inside the network
  const [x0, z0, x1, z1] = bounds;
  const step = 11;
  let scrub = 0;
  for (let z = z0; z < z1 && scrub < 600; z += step) {
    for (let x = x0; x < x1 && scrub < 600; x += step) {
      const jx = x + rng.range(-4, 4), jz = z + rng.range(-4, 4);
      const zn = zoneAt(jx, jz);
      if (zn !== ZONE.NONE && zn !== ZONE.RESERVED) continue;
      if (!hard.free(jx, jz, 2.0, F.ROAD | F.BUILDING | F.BAD | F.TAKEN)) continue;
      if (rng.bool(0.45)) {
        B.put('scrub', jx, hAt(jx, jz), jz, rng.range(0, 6.28), rng.range(0.8, 1.6), rng.range(0.7, 1.4),
          rng.range(0.8, 1.6), _col.setHSL(rng.range(0.16, 0.26), rng.range(0.20, 0.40), rng.range(0.26, 0.42)));
      } else if (rng.bool(0.35)) {
        const sp = rng.weighted([['oak', 3], ['conifer', 3], ['birch', 2]]);
        plantTree(B, null, rng, sp, jx, hAt(jx, jz), jz, rng.range(0.6, 1.1), false);
        counts.trees++;
      } else {
        B.put('shrub', jx, hAt(jx, jz), jz, rng.range(0, 6.28), rng.range(0.8, 1.5), rng.range(0.7, 1.3),
          rng.range(0.8, 1.5), _col.setHSL(rng.range(0.22, 0.30), rng.range(0.25, 0.44), rng.range(0.20, 0.34)));
      }
      hard.disc(jx, jz, 3.0, F.TAKEN);
      scrub++;
    }
  }
  counts.plants += scrub;
}

/* ------------------------------------------------------ overhead wires -- */

function overheadWires(ctx, S, frames, zoneAt, hard, hAt, B, rng) {
  const onRoad = (x, z) => (hard.get(x, z) & F.ROAD) !== 0;
  const pts = [];
  const poles = [];
  for (const f of frames) {
    if (f.cls !== 'lane2' && f.cls !== 'alley') continue;
    const mid = f.pts[Math.floor(f.pts.length / 2)];
    const zn = zoneAt(mid.x, mid.z);
    if (zn !== ZONE.RES_LOW && zn !== ZONE.IND) continue;
    const side = (f.seg.id & 2) ? 1 : -1;
    const spacing = 38;
    const n = Math.floor(f.length / spacing);
    if (n < 1) continue;
    const run = [];
    for (let k = 0; k <= n; k++) {
      const s = (k / n) * f.length;
      const i = Math.min(f.pts.length - 1, Math.round((s / f.length) * (f.pts.length - 1)));
      const p = f.pts[i];
      const d = f.half + f.walk + 0.9;
      const x = p.x + p.nx * side * d, z = p.z + p.nz * side * d;
      if (onRoad(x, z) || !hard.free(x, z, 0.8, F.BUILDING | F.BAD | F.TAKEN)) { run.length = 0; continue; }
      const y = hAt(x, z);
      const yaw = Math.atan2(p.ux, p.uz);
      B.put('utilityPole', x, y, z, yaw, 1, rng.range(0.95, 1.06), 1, tint(_col, POLE_WOOD, rng, 0.08));
      hard.disc(x, z, 1.0, F.TAKEN);
      poles.push({ x, y, z, yaw });
      run.push({ x, y, z, yaw });
      if (run.length >= 2) {
        const a = run[run.length - 2], b = run[run.length - 1];
        for (const off of [-0.85, -0.28, 0.28, 0.85]) {
          const ax = a.x + Math.cos(a.yaw) * off, az = a.z - Math.sin(a.yaw) * off;
          const bx = b.x + Math.cos(b.yaw) * off, bz = b.z - Math.sin(b.yaw) * off;
          const ay = a.y + 8.05, by = b.y + 8.05;
          const SEG = 6;
          const span = Math.hypot(bx - ax, bz - az);
          const sag = Math.min(1.1, span * 0.018);
          for (let i = 0; i < SEG; i++) {
            const t0 = i / SEG, t1 = (i + 1) / SEG;
            const dip = (t) => -sag * 4 * t * (1 - t);
            pts.push(
              ax + (bx - ax) * t0, ay + (by - ay) * t0 + dip(t0), az + (bz - az) * t0,
              ax + (bx - ax) * t1, ay + (by - ay) * t1 + dip(t1), az + (bz - az) * t1
            );
          }
        }
      }
    }
  }
  if (!pts.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const m = new THREE.LineBasicMaterial({ color: 0x14161a, transparent: true, opacity: 0.85, fog: true });
  const line = new THREE.LineSegments(g, m);
  line.name = 'props:wires';
  line.frustumCulled = true;
  S.ownedMaterials.push(m);
  void poles;
  return line;
}

const POLE_WOOD = new THREE.Color(0x9c8058);

export default { populate };
