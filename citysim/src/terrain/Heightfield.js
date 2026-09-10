/**
 * Deterministic heightfield generation for the city site.
 *
 * Composition, in order (order matters — each stage assumes the previous one):
 *   1. broad landform  (low-frequency fbm)
 *   2. ridged multifractal mountains, masked to the map rim
 *   3. a few seeded "landmark" hills in the mid ring so the aerial read has form
 *   4. thermal (talus) relaxation + droplet hydraulic erosion  → gullies, alluvial fans
 *   5. a near-flat buildable basin blended into the middle    → the city site
 *   6. a meandering river carved with a real valley profile   → channel + banks + floodplain
 *   7. shoreline relaxation                                   → beaches / soft banks
 *
 * Everything is driven by `Noise` + `Rng` from core, so the same seed always
 * produces the same site.
 */

import { Noise } from '../core/Rng.js';

export const SITE = {
  water: 0.0,
  /* basin */
  basinH: 7.2,
  basinCx: 0, basinCz: 40,
  basinR0: 200,          // fully flat inside this radius
  basinR1: 520,          // fully "hills" beyond this radius
  /* river */
  riverBase: -235,
  riverHalfW: 26,
  riverBed: -6.2,
  riverBank: 64,
  valleyWidth: 235,
  valleyDepth: 5.5,
};

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const smoother = (t) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** River centreline: z as a function of x (single-valued, big lazy meanders). */
export function riverZ(x, noise) {
  return SITE.riverBase
    + 132 * Math.sin(x / 305 + 0.6)
    + 54 * Math.sin(x / 141 - 1.1)
    + 24 * Math.sin(x / 68 + 2.2)
    + 26 * noise.simplex2(x / 520 + 11.3, 4.7);
}

/* ------------------------------------------------------------------ */
/* erosion                                                             */
/* ------------------------------------------------------------------ */

function thermalPass(h, n, talus, rate) {
  const d = new Float32Array(n * n);
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const k = j * n + i;
      const c = h[k];
      let total = 0;
      const dh = [0, 0, 0, 0];
      const nb = [k - 1, k + 1, k - n, k + n];
      for (let a = 0; a < 4; a++) {
        const diff = c - h[nb[a]];
        if (diff > talus) { dh[a] = diff - talus; total += dh[a]; }
      }
      if (total <= 0) continue;
      const move = Math.min(total * rate, (c - h[nb[0]] + c - h[nb[1]] + c - h[nb[2]] + c - h[nb[3]]) * 0.12);
      if (move <= 0) continue;
      d[k] -= move;
      for (let a = 0; a < 4; a++) if (dh[a] > 0) d[nb[a]] += move * (dh[a] / total);
    }
  }
  for (let k = 0; k < h.length; k++) h[k] += d[k];
}

/**
 * Droplet hydraulic erosion (Hans Beyer's formulation, trimmed).
 * Carves gullies and deposits fans at the foot of slopes — this is the single
 * biggest "reads as a real landscape" win per millisecond spent.
 */
function dropletErosion(h, n, step, rng, opts = {}) {
  const {
    count = 26000, maxSteps = 46, inertia = 0.05, capacity = 3.4,
    minSlope = 0.008, erode = 0.28, deposit = 0.24, evaporate = 0.018,
    gravity = 6, radius = 3,
  } = opts;

  // precompute the deposition brush (weights inside `radius` cells)
  const brushDx = [], brushDy = [], brushW = [];
  let wsum = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      const w = 1 - d / radius;
      brushDx.push(dx); brushDy.push(dy); brushW.push(w); wsum += w;
    }
  }
  for (let i = 0; i < brushW.length; i++) brushW[i] /= wsum;
  const bn = brushW.length;

  const sampleGrad = (fx, fy, out) => {
    const i0 = Math.min(n - 2, Math.max(0, Math.floor(fx)));
    const j0 = Math.min(n - 2, Math.max(0, Math.floor(fy)));
    const u = fx - i0, v = fy - j0;
    const k = j0 * n + i0;
    const h00 = h[k], h10 = h[k + 1], h01 = h[k + n], h11 = h[k + n + 1];
    out[0] = (h10 - h00) * (1 - v) + (h11 - h01) * v;   // dh/di
    out[1] = (h01 - h00) * (1 - u) + (h11 - h10) * u;   // dh/dj
    out[2] = (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
    return out;
  };

  const g = [0, 0, 0];
  for (let d = 0; d < count; d++) {
    let px = rng.range(1.5, n - 2.5);
    let py = rng.range(1.5, n - 2.5);
    let dx = 0, dy = 0, speed = 1, water = 1, sediment = 0;

    for (let s = 0; s < maxSteps; s++) {
      const ni = Math.floor(px), nj = Math.floor(py);
      const cu = px - ni, cv = py - nj;
      sampleGrad(px, py, g);
      const hOld = g[2];

      dx = dx * inertia - g[0] * (1 - inertia);
      dy = dy * inertia - g[1] * (1 - inertia);
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) break;
      dx /= len; dy /= len;
      px += dx; py += dy;
      if (px < 1 || px >= n - 2 || py < 1 || py >= n - 2) break;

      const hNew = sampleGrad(px, py, g)[2];
      const dh = hNew - hOld;

      const cap = Math.max(-dh, minSlope) * speed * water * capacity;

      if (dh > 0 || sediment > cap) {
        // deposit — fill the pit we just climbed into, bilinearly
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * deposit;
        sediment -= amount;
        const k = nj * n + ni;
        h[k] += amount * (1 - cu) * (1 - cv);
        h[k + 1] += amount * cu * (1 - cv);
        h[k + n] += amount * (1 - cu) * cv;
        h[k + n + 1] += amount * cu * cv;
      } else {
        const amount = Math.min((cap - sediment) * erode, -dh);
        let taken = 0;
        for (let b = 0; b < bn; b++) {
          const bi = ni + brushDx[b], bj = nj + brushDy[b];
          if (bi < 0 || bj < 0 || bi >= n || bj >= n) continue;
          const k = bj * n + bi;
          const del = amount * brushW[b];
          h[k] -= del; taken += del;
        }
        sediment += taken;
      }

      speed = Math.sqrt(Math.max(0, speed * speed + -dh * gravity));
      water *= (1 - evaporate);
      if (water < 0.02) break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* main generator                                                      */
/* ------------------------------------------------------------------ */

/**
 * Fills `world.terrain.heights` and sets `world.terrain.water`.
 * @returns {{ms:number, min:number, max:number, river:{poly:Float32Array}}}
 */
export function generate(world, rng, log) {
  const t0 = performance.now();
  const T = world.terrain;
  const n = T.resolution;              // 513
  const size = T.size;                 // 2048
  const step = size / (n - 1);         // 4 m
  const half = size / 2;

  const noise = new Noise(world.seed ^ 0x5eed1a);
  const noiseB = new Noise((world.seed * 2654435761) >>> 0);

  const h = new Float32Array(n * n);
  const rimMask = new Float32Array(n * n);

  /* --- landmark hills: a few real forms in the mid ring ------------- */
  const bumps = [];
  for (let b = 0; b < 7; b++) {
    // spread around the basin but always inside the ring the aerial camera sees,
    // so the site reads as a valley floor with walls, not an endless plain
    const a = (b / 7) * Math.PI * 2 + rng.range(-0.32, 0.32);
    const r = rng.range(330, 640);
    bumps.push({
      x: SITE.basinCx + Math.cos(a) * r,
      z: SITE.basinCz + Math.sin(a) * r,
      rad: rng.range(140, 260),
      amp: rng.range(34, 88),
    });
  }

  /* --- 1..3 : landform ---------------------------------------------- */
  for (let j = 0; j < n; j++) {
    const z = -half + j * step;
    for (let i = 0; i < n; i++) {
      const x = -half + i * step;
      const k = j * n + i;

      const dx = x - SITE.basinCx, dz = z - SITE.basinCz;
      // lobe the basin outline so it never reads as a stamped disc
      const lobe = 1
        + 0.30 * noiseB.simplex2(x / 430 + 2.2, z / 430 - 1.4)
        + 0.14 * noiseB.simplex2(x / 165 - 5.1, z / 165 + 3.7);
      const d = Math.sqrt(dx * dx + dz * dz) / Math.max(0.4, lobe);
      const m = smoothstep(SITE.basinR0, SITE.basinR1, d);
      rimMask[k] = m;

      let hh = 16
        + noise.fbm(x / 760, z / 760, 5) * 23
        + noise.fbm(x / 205, z / 205, 4) * 7.5;

      // the valley opens downstream to the west: the range is tallest to the
      // east/south, low in the west. Without this the whole site sits in the
      // range's shadow from about 18:00 onward.
      const dirW = d > 1 ? dx / d : 0;
      const openW = 0.42 + 0.58 * smoothstep(-0.85, 0.20, dirW);
      const rg = noise.ridged(x / 455 + 3.1, z / 455 - 2.4, 6, 2.02, 0.5);
      hh += Math.pow(rg, 1.7) * 138 * (0.25 + 0.75 * m) * openW;

      for (const bp of bumps) {
        const bd = Math.hypot(x - bp.x, z - bp.z) / bp.rad;
        if (bd < 1) {
          const f = Math.cos(bd * Math.PI) * 0.5 + 0.5;
          hh += bp.amp * f * f * (0.55 + 0.45 * noiseB.fbm(x / 95, z / 95, 3)) * (bp.x < SITE.basinCx ? 0.5 : 1);
        }
      }

      // push the outer 140 m up so the map edge does not read as a cut-off slab
      const edge = Math.max(Math.abs(x), Math.abs(z));
      hh += smoothstep(half - 190, half, edge) * 45 * (x < SITE.basinCx ? 0.45 : 1.0);

      h[k] = hh;
    }
  }

  /* --- 4 : erosion --------------------------------------------------- */
  const tErode = performance.now();
  thermalPass(h, n, 0.55 * step, 0.5);
  thermalPass(h, n, 0.55 * step, 0.5);
  dropletErosion(h, n, step, rng, { count: 24000, maxSteps: 44, radius: 4 });
  thermalPass(h, n, 0.9 * step, 0.35);

  // Droplet erosion happily carves gullies at the grid's Nyquist limit. Those
  // are invisible from above but, under a 6-degree golden-hour sun, they throw
  // razor-straight sawtooth shadows a hundred metres long. Two mild low-pass
  // passes keep the drainage pattern and drop the aliased spikes.
  {
    const sm = new Float32Array(h.length);
    for (let pass = 0; pass < 2; pass++) {
      sm.set(h);
      for (let j = 1; j < n - 1; j++) {
        for (let i = 1; i < n - 1; i++) {
          const k = j * n + i;
          const avg = (sm[k] * 4
            + (sm[k - 1] + sm[k + 1] + sm[k - n] + sm[k + n]) * 2
            + sm[k - n - 1] + sm[k - n + 1] + sm[k + n - 1] + sm[k + n + 1]) / 16;
          h[k] = sm[k] + (avg - sm[k]) * 0.85;
        }
      }
    }
  }
  const erodeMs = performance.now() - tErode;

  /* --- 5 : buildable basin ------------------------------------------- */
  for (let j = 0; j < n; j++) {
    const z = -half + j * step;
    for (let i = 0; i < n; i++) {
      const x = -half + i * step;
      const k = j * n + i;
      if (rimMask[k] > 0.9995) continue;      // pure hills — nothing to blend
      const basin = SITE.basinH
        + noise.fbm(x / 310 + 5.5, z / 310 - 8.2, 3) * 2.1
        + noise.fbm(x / 88 + 1.7, z / 88 + 4.4, 3) * 0.55;
      const m = rimMask[k];
      h[k] = basin * (1 - m) + h[k] * m;
    }
  }

  /* --- 6 : river ------------------------------------------------------ */
  const polyStep = 10;   // 10 m sampling is well inside the meander's radius of curvature
  const polyN = Math.ceil((size + 600) / polyStep) + 1;
  const poly = new Float32Array(polyN * 2);
  for (let p = 0; p < polyN; p++) {
    const x = -half - 300 + p * polyStep;
    poly[p * 2] = x;
    poly[p * 2 + 1] = riverZ(x, noise);
  }

  // no polyline point further than valleyWidth*1.6 along x can be the nearest one
  const win = Math.ceil((SITE.valleyWidth * 1.6) / polyStep) + 2;
  for (let j = 0; j < n; j++) {
    const z = -half + j * step;
    for (let i = 0; i < n; i++) {
      const x = -half + i * step;
      const k = j * n + i;

      const c = Math.round((x + half + 300) / polyStep);
      let best = 1e9;
      const p0 = Math.max(0, c - win), p1 = Math.min(polyN - 2, c + win);
      for (let p = p0; p <= p1; p++) {
        const ax = poly[p * 2], az = poly[p * 2 + 1];
        const bx = poly[p * 2 + 2], bz = poly[p * 2 + 3];
        const ex = bx - ax, ez = bz - az;
        let t = ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = x - (ax + ex * t), qz = z - (az + ez * t);
        const dd = qx * qx + qz * qz;
        if (dd < best) best = dd;
      }
      const dist = Math.sqrt(best);
      if (dist > SITE.valleyWidth * 1.6) continue;

      const hOrig = h[k];

      // broad, shallow valley floor
      const uv = Math.max(0, Math.min(1, dist / SITE.valleyWidth));
      const valley = hOrig - SITE.valleyDepth * (1 - smoother(uv));

      // the channel itself
      const wob = 1 + 0.28 * noise.simplex2(x / 130 + 7.7, z / 130 - 3.3);
      const halfW = SITE.riverHalfW * wob;
      const bankW = SITE.riverBank * (0.8 + 0.4 * wob);
      const u = Math.max(0, Math.min(1, (dist - halfW) / bankW));
      let bed = SITE.riverBed;
      if (dist < halfW) bed -= 1.6 * (1 - (dist / halfW) * (dist / halfW));
      bed += 0.5 * noise.simplex2(x / 70 + 21.0, z / 70 + 5.0);
      const channel = bed + (valley - bed) * smoother(u);

      h[k] = Math.min(hOrig, Math.min(valley, channel));
    }
  }

  /* --- 7 : shoreline relaxation (beaches / soft banks) --------------- */
  const tmp = new Float32Array(h.length);
  for (let pass = 0; pass < 7; pass++) {
    tmp.set(h);
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        const dh = (tmp[k] - SITE.water) / 4.5;
        if (dh > 2.0 || dh < -2.0) continue;   // outside the shore band
        const w = Math.exp(-dh * dh) * 0.80;
        const avg = (tmp[k - 1] + tmp[k + 1] + tmp[k - n] + tmp[k + n]
          + tmp[k - n - 1] + tmp[k - n + 1] + tmp[k + n - 1] + tmp[k + n + 1]) / 8;
        h[k] = tmp[k] * (1 - w) + avg * w;
      }
    }
  }

  /* --- 8 : extra relaxation on the basin rim --------------------------
     This is the band the low-sun golden-hour shadows fall across, and it is
     also the coarse (4 m) LOD ring, so Nyquist-scale gullies there turn into
     hard sawtooth shadow edges. Smooth it a little harder than the mountains. */
  {
    const sm = new Float32Array(h.length);
    for (let pass = 0; pass < 3; pass++) {
      sm.set(h);
      for (let j = 1; j < n - 1; j++) {
        const z = -half + j * step;
        for (let i = 1; i < n - 1; i++) {
          const x = -half + i * step;
          const k = j * n + i;
          const d = Math.hypot(x - SITE.basinCx, z - SITE.basinCz);
          const t = (d - 340) / 240;
          // rim band + everything beyond the 8 m LOD ring, whose faceted ridge
          // silhouettes are what turn a low sun into sawtooth shadow edges
          const w = Math.max(Math.exp(-t * t) * 0.7, smoothstep(520, 760, d) * 0.62);
          if (w < 0.03) continue;
          const avg = (sm[k - 1] + sm[k + 1] + sm[k - n] + sm[k + n]
            + sm[k - n - 1] + sm[k - n + 1] + sm[k + n - 1] + sm[k + n + 1]) / 8;
          h[k] = sm[k] + (avg - sm[k]) * w;
        }
      }
    }
  }

  /* --- finalise ------------------------------------------------------- */
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < h.length; k++) {
    const v = h[k];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  T.heights = h;
  T.water = SITE.water;
  T.version = (T.version || 0) + 1;

  const ms = performance.now() - t0;
  log?.info?.(`heightfield ${n}x${n} in ${ms.toFixed(0)} ms (erosion ${erodeMs.toFixed(0)} ms), y ${min.toFixed(1)}..${max.toFixed(1)} m`);
  return { ms, min, max, poly, polyStep, step, half, n };
}

/* ------------------------------------------------------------------ */
/* sampling helpers (used by the mesh builder and by provides())        */
/* ------------------------------------------------------------------ */

export function makeSampler(T) {
  const n = T.resolution, size = T.size, half = size / 2, step = size / (n - 1);
  const h = T.heights;

  const heightAt = (x, z) => {
    if (!h) return 0;
    const fx = (x + half) / step, fz = (z + half) / step;
    let i0 = Math.floor(fx), j0 = Math.floor(fz);
    if (i0 < 0) i0 = 0; else if (i0 > n - 2) i0 = n - 2;
    if (j0 < 0) j0 = 0; else if (j0 > n - 2) j0 = n - 2;
    let tx = fx - i0, tz = fz - j0;
    tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;
    tz = tz < 0 ? 0 : tz > 1 ? 1 : tz;
    const k = j0 * n + i0;
    const h00 = h[k], h10 = h[k + 1], h01 = h[k + n], h11 = h[k + n + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  };

  return { heightAt, n, size, half, step };
}
