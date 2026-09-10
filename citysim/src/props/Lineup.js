import * as THREE from 'three';
import { Rng, hashString } from '../core/Rng.js';
import { SPECIES } from './Vegetation.js';
import { CAR_TYPES, carColor } from './Vehicles.js';
import { heightSampler } from './Placement.js';

/**
 * The `trees` showcase: one row per species, four size classes across, with the
 * ground furniture that shares the vegetation materials (hedge run, shrubs,
 * grass tufts, a bed of flowers) laid in front so the canopy quality, the bark
 * and the alpha-tested foliage can all be judged from three metres.
 */

const SIZE = [0.55, 0.78, 1.0, 1.32];

export function plantLineup(ctx, S, api) {
  const B = S.batches;
  const hAt = heightSampler(ctx);
  const rng = new Rng(hashString('props:lineup', ctx.world.seed >>> 0) >>> 0);
  const _c = new THREE.Color();
  const _c2 = new THREE.Color();

  const colX = 11.5, rowZ = 13.0;
  const nS = SPECIES.length;
  const cx = 0, cz = 0;

  for (let r = 0; r < nS; r++) {
    const sp = SPECIES[r];
    for (let c = 0; c < SIZE.length; c++) {
      const x = cx + (c - (SIZE.length - 1) / 2) * colX;
      const z = cz + (r - (nS - 1) / 2) * rowZ;
      const y = hAt(x, z);
      const v = c & 1;
      const s = SIZE[c] * rng.range(0.96, 1.05);
      _c.setHSL(0.09, 0.16, rng.range(0.44, 0.56));
      _c2.setHSL(rng.range(0.22, 0.27), rng.range(0.34, 0.52), rng.range(0.44, 0.56));
      const yaw = rng.range(0, 6.283);
      const tx = rng.range(-0.05, 0.05), tz = rng.range(-0.05, 0.05);
      B.put(`tree.${sp}.${v}.bark`, x, y, z, yaw, s, s, s, _c, tx, tz);
      B.put(`tree.${sp}.${v}.leaf`, x, y, z, yaw, s, s, s, _c2, tx, tz);
      B.put(`tree.${sp}.mid`, x, y, z, yaw, s, s, s, _c2, tx, tz);
      B.put(`tree.${sp}.far`, x, y, z, yaw, s, s, s, _c2);
      B.put('decal', x, y + 0.04, z, yaw, 2.6 * s, 1, 2.6 * s, _c.setRGB(0.86, 0.81, 0.73));
    }
  }

  // a hedge run and ground planting across the front of the lineup
  const frontZ = cz + (nS / 2) * rowZ - 1.0;
  for (let x = -26; x <= 26; x += 2.0) {
    const y = hAt(x, frontZ);
    B.put('hedge', x, y, frontZ, 0, 1.02, rng.range(0.9, 1.1), rng.range(0.95, 1.1),
      _c.setHSL(rng.range(0.25, 0.31), rng.range(0.32, 0.48), rng.range(0.20, 0.30)));
  }
  for (let i = 0; i < 260; i++) {
    const x = rng.range(-30, 30), z = rng.range(frontZ + 1.4, frontZ + 9);
    const y = hAt(x, z);
    if (rng.bool(0.72)) {
      B.put('grass', x, y, z, rng.range(0, 6.28), rng.range(0.8, 1.6), rng.range(0.7, 1.4), rng.range(0.8, 1.6),
        _c.setHSL(rng.range(0.20, 0.28), rng.range(0.24, 0.46), rng.range(0.26, 0.44)));
    } else if (rng.bool(0.5)) {
      B.put('shrub', x, y, z, rng.range(0, 6.28), rng.range(0.6, 1.1), rng.range(0.6, 1.0), rng.range(0.6, 1.1),
        _c.setHSL(rng.range(0.23, 0.31), rng.range(0.28, 0.46), rng.range(0.22, 0.34)));
    } else {
      B.put('flowers', x, y, z, rng.range(0, 6.28), rng.range(0.9, 1.4), 1, rng.range(0.9, 1.4),
        _c.setHSL(rng.range(0.0, 0.16), rng.range(0.5, 0.85), rng.range(0.44, 0.60)));
    }
  }
  // a bench and a park lamp for scale
  for (const x of [-15, 15]) {
    const y = hAt(x, frontZ + 4);
    B.put('bench.frame', x, y, frontZ + 4, Math.PI, 1, 1, 1, _c.setRGB(0.24, 0.26, 0.28));
    B.put('bench.slats', x, y, frontZ + 4, Math.PI, 1, 1, 1, _c.setRGB(0.60, 0.44, 0.27));
  }
  const ly = hAt(0, frontZ + 5);
  B.put('parkLamp', 0, ly, frontZ + 5, 0, 1, 1, 1, _c.setRGB(0.24, 0.26, 0.28));
  B.put('parkLamp.lens', 0, ly, frontZ + 5, 0);

  const stats = B.build(S.group, S.mats);
  S.lastStats = { ...stats, kinds: B.report() };
  void api;
  return { cx, cy: hAt(cx, cz), cz, ...stats };
}

export default { plantLineup };

/** Diagnostic lineup: one row of each car type, plus a lamp and a signal. */
export function carLineup(ctx, S) {
  const B = S.batches;
  const hAt = heightSampler(ctx);
  const rng = new Rng(hashString('props:carline', ctx.world.seed >>> 0) >>> 0);
  const _c = new THREE.Color();
  let i = 0;
  for (const t of CAR_TYPES) {
    for (let k = 0; k < 3; k++) {
      const x = (k - 1) * 7.0;
      const z = (i - 1) * 6.5;
      const y = hAt(x, z);
      const yaw = k === 1 ? Math.PI / 2 : (k === 0 ? 0 : Math.PI * 0.75);
      carColor(rng, _c);
      B.put(`car.${t}`, x, y, z, yaw, 1, 1, 1, _c);
      B.put(`car.${t}.glass`, x, y, z, yaw);
      B.put(`car.${t}.wheels`, x, y, z, yaw);
    }
    i++;
  }
  const ly = hAt(-11, -8);
  B.put('lamp', -11, ly, -8, 0, 1, 1, 1, _c.setRGB(0.42, 0.44, 0.46));
  B.put('lamp.lens', -11, ly, -8, 0);
  const sy = hAt(11, -8);
  B.put('signal', 11, sy, -8, Math.PI, 1, 1, 1, _c.setRGB(0.42, 0.44, 0.46));
  B.put('signal.heads', 11, sy, -8, Math.PI, 1, 1, 1, _c.setRGB(0.22, 0.24, 0.26));
  B.put('signal.lensR', 11, sy, -8, Math.PI, 1, 1, 1, _c.setRGB(1, 0.1, 0.06));
  B.put('signal.lensA', 11, sy, -8, Math.PI, 1, 1, 1, _c.setRGB(0.02, 0.01, 0));
  B.put('signal.lensG', 11, sy, -8, Math.PI, 1, 1, 1, _c.setRGB(0.01, 0.02, 0.01));
  const by = hAt(-6, 8);
  B.put('bench.frame', -6, by, 8, 0, 1, 1, 1, _c.setRGB(0.24, 0.26, 0.28));
  B.put('bench.slats', -6, by, 8, 0, 1, 1, 1, _c.setRGB(0.60, 0.44, 0.27));
  B.put('bin', -3, hAt(-3, 8), 8, 0, 1, 1, 1, _c.setRGB(0.22, 0.32, 0.27));
  B.put('hydrant', 0, hAt(0, 8), 8, 0, 1, 1, 1, _c.setRGB(0.62, 0.14, 0.11));
  B.put('meter', 3, hAt(3, 8), 8, 0, 1, 1, 1, _c.setRGB(0.24, 0.26, 0.28));
  B.put('bollard', 6, hAt(6, 8), 8, 0, 1, 1, 1, _c.setRGB(0.24, 0.26, 0.28));
  B.put('signPost', 9, hAt(9, 8), 8, 0);
  B.put('sign.stop', 9, hAt(9, 8), 8, 0);
  const stats = B.build(S.group, S.mats);
  S.lastStats = { ...stats, kinds: B.report() };
  return { cx: 0, cy: hAt(0, 0), cz: 0, ...stats };
}
