import * as THREE from 'three';
import { Noise, Rng } from '../core/Rng.js';

/**
 * The terrain control map — the answer to "the ground outside the city is a
 * smooth low-frequency wash at 300–800 m".
 *
 * More noise does not fix that, because noise has no *shape*: it looks the same
 * on a ridge nose as in a valley floor, so from the air it reads as dirt on the
 * lens rather than as land. What reads from a helicopter is **structure that
 * agrees with the landform** — drainage lines picking out every gully, damp dark
 * hollows, dry pale ridge noses, rock breaking out where slopes steepen, forest
 * massing on the shaded mid-slopes, and field parcels quilting the flat ground.
 *
 * All of that is derivable from the heightfield we already have. This module
 * bakes it once into a single RGBA texture on the same 513² lattice:
 *
 *   R  flow accumulation, log-scaled  — the drainage network
 *   G  curvature, 0 concave … 1 convex — hollows vs ridge noses
 *   B  field/forest parcel tone        — quilting on workable ground
 *   A  rock exposure                   — outcrop probability
 *
 * The splat shader reads it in terrain space, so every macro feature it draws
 * is anchored to the actual terrain rather than floating over it.
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * D8 flow accumulation. Cells are visited highest-first so every cell's own
 * catchment has already drained into it by the time it is processed; that gives
 * a real dendritic network in one pass instead of an iterative relaxation.
 */
function flowAccumulation(h, n, step) {
  const order = new Int32Array(n * n);
  for (let k = 0; k < n * n; k++) order[k] = k;
  // counting sort into 4096 height buckets — far cheaper than a comparison sort
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < n * n; k++) { const v = h[k]; if (v < min) min = v; if (v > max) max = v; }
  const BUCKETS = 4096;
  const scale = (BUCKETS - 1) / Math.max(1e-4, max - min);
  const count = new Int32Array(BUCKETS + 1);
  const bucket = new Int32Array(n * n);
  for (let k = 0; k < n * n; k++) {
    const b = (BUCKETS - 1) - ((h[k] - min) * scale) | 0;   // descending
    bucket[k] = b < 0 ? 0 : b > BUCKETS - 1 ? BUCKETS - 1 : b;
    count[bucket[k] + 1]++;
  }
  for (let b = 0; b < BUCKETS; b++) count[b + 1] += count[b];
  const cursor = count.slice();
  for (let k = 0; k < n * n; k++) order[cursor[bucket[k]]++] = k;

  const acc = new Float32Array(n * n).fill(1);
  const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
  const DZ = [-1, -1, -1, 0, 0, 1, 1, 1];
  const INV = [0.70710678, 1, 0.70710678, 1, 1, 0.70710678, 1, 0.70710678];

  for (let o = 0; o < order.length; o++) {
    const k = order[o];
    const i = k % n, j = (k / n) | 0;
    if (i === 0 || j === 0 || i === n - 1 || j === n - 1) continue;
    const hc = h[k];
    // multiple-flow-direction: share downhill by slope weight, which gives
    // convergent valleys without the single-pixel staircase D8 produces
    let total = 0;
    const w = _w;
    for (let d = 0; d < 8; d++) {
      const nk = k + DZ[d] * n + DX[d];
      const drop = (hc - h[nk]) * INV[d];
      w[d] = drop > 0 ? drop : 0;
      total += w[d];
    }
    if (total <= 0) continue;
    const a = acc[k] / total;
    for (let d = 0; d < 8; d++) if (w[d] > 0) acc[k + DZ[d] * n + DX[d]] += a * w[d];
  }
  return acc;
}
const _w = new Float32Array(8);

/** @returns {{tex: THREE.DataTexture, data: Uint8Array, ms:number}} */
export function buildControlMap(world, seed, log) {
  const t0 = performance.now();
  const T = world.terrain;
  const n = T.resolution, size = T.size, half = size / 2;
  const step = size / (n - 1);
  const h = T.heights;
  const water = T.water;

  const acc = flowAccumulation(h, n, step);
  const noise = new Noise((seed ^ 0x1f2e3d) >>> 0);
  const rng = new Rng((seed ^ 0x77c1) >>> 0);

  /* field parcels: a jittered lattice of ~110 m cells, each with its own tone.
     Real farmland is a quilt of irregular parcels, not a noise field. */
  const CELL = 112;
  const PC = Math.ceil(size / CELL) + 2;
  const px = new Float32Array(PC * PC), pz = new Float32Array(PC * PC), pv = new Float32Array(PC * PC);
  for (let j = 0; j < PC; j++) {
    for (let i = 0; i < PC; i++) {
      const k = j * PC + i;
      px[k] = (-half - CELL) + i * CELL + rng.range(0.12, 0.88) * CELL;
      pz[k] = (-half - CELL) + j * CELL + rng.range(0.12, 0.88) * CELL;
      pv[k] = rng.next();
    }
  }

  const data = new Uint8Array(n * n * 4);

  for (let j = 0; j < n; j++) {
    const z = -half + j * step;
    for (let i = 0; i < n; i++) {
      const x = -half + i * step;
      const k = j * n + i;
      const hc = h[k];

      const i0 = i > 0 ? i - 1 : i, i1 = i < n - 1 ? i + 1 : i;
      const j0 = j > 0 ? j - 1 : j, j1 = j < n - 1 ? j + 1 : j;
      const hL = h[j * n + i0], hR = h[j * n + i1];
      const hD = h[j0 * n + i], hU = h[j1 * n + i];

      const gx = (hR - hL) / (2 * step), gz = (hU - hD) / (2 * step);
      const slope = Math.hypot(gx, gz);

      // curvature on a WIDE stencil (+/- 3 cells = 12 m). A one-cell Laplacian
      // on a 4 m field is all Nyquist grain and reads as a binary mask; at 12 m
      // it reads as landform relief, which is what a 300-800 m camera sees.
      const iw0 = Math.max(0, i - 3), iw1 = Math.min(n - 1, i + 3);
      const jw0 = Math.max(0, j - 3), jw1 = Math.min(n - 1, j + 3);
      const wL = h[j * n + iw0], wR = h[j * n + iw1];
      const wD = h[jw0 * n + i], wU = h[jw1 * n + i];

      /* --- R : drainage network ------------------------------------- */
      // log of catchment area, normalised so a first-order gully already reads
      const a = Math.log(1 + acc[k]) / Math.log(1 + n * n * 0.02);
      // a channel is a big catchment on ground that is not itself steep
      const chan = clamp01(a * 1.35) * (1 - smoothstep(0.55, 1.2, slope) * 0.5);

      /* --- G : curvature -------------------------------------------- */
      const lap = (wL + wR + wD + wU - 4 * hc) / (9 * step * step);
      // convex (noses, ridges) -> >0.5, concave (hollows, gullies) -> <0.5
      const curv = clamp01(0.5 - lap * 42);

      /* --- A : rock exposure ---------------------------------------- */
      // rock breaks out where the slope steepens AND the surface is convex —
      // hollows fill with scree and soil, noses strip back to bedrock
      const alt = hc - water;
      // 0.30 rise/run is a 17 degree slope — grassland, not bare rock. Bedrock
      // strips back somewhere past 32 degrees, so the band starts there.
      let rock = smoothstep(0.62, 1.25, slope) * (0.45 + 0.55 * smoothstep(0.42, 0.75, curv));
      rock += smoothstep(118, 178, alt) * 0.45;
      rock *= 0.78 + 0.44 * noise.fbm(x / 190 + 7.1, z / 190 - 3.2, 3);
      rock = clamp01(rock - chan * 0.35);

      /* --- B : parcel tone ------------------------------------------ */
      // fields only on ground a farmer would actually work
      const workable = (1 - smoothstep(0.10, 0.26, slope))
        * (1 - smoothstep(60, 130, alt))
        * smoothstep(1.5, 6.0, alt);
      let parcel = 0.5;
      if (workable > 0.02) {
        const ci = Math.floor((x + half + CELL) / CELL), cj = Math.floor((z + half + CELL) / CELL);
        let best = 1e9, bv = 0.5;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const c = (cj + dj) * PC + (ci + di);
            if (c < 0 || c >= PC * PC) continue;
            const d2 = (px[c] - x) * (px[c] - x) + (pz[c] - z) * (pz[c] - z);
            if (d2 < best) { best = d2; bv = pv[c]; }
          }
        }
        parcel = 0.5 + (bv - 0.5) * workable;
      }

      data[k * 4] = chan * 255;
      data[k * 4 + 1] = curv * 255;
      data[k * 4 + 2] = parcel * 255;
      data[k * 4 + 3] = rock * 255;
    }
  }

  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;

  const ms = performance.now() - t0;
  log?.info?.(`control map ${n}x${n} (flow + curvature + parcels + rock) in ${ms.toFixed(0)} ms`);
  return { tex, data, ms };
}

/** Re-bake a rectangular region after a heightfield edit. Cheap: no flow re-solve. */
export function refreshControlRegion(world, ctl, i0, j0, i1, j1) {
  const T = world.terrain;
  const n = T.resolution, size = T.size, half = size / 2, step = size / (n - 1);
  const h = T.heights, water = T.water, data = ctl.data;
  for (let j = Math.max(1, j0); j <= Math.min(n - 2, j1); j++) {
    for (let i = Math.max(1, i0); i <= Math.min(n - 2, i1); i++) {
      const k = j * n + i, hc = h[k];
      const hL = h[k - 1], hR = h[k + 1], hD = h[k - n], hU = h[k + n];
      const gx = (hR - hL) / (2 * step), gz = (hU - hD) / (2 * step);
      const slope = Math.hypot(gx, gz);
      const iw0 = Math.max(0, i - 3), iw1 = Math.min(n - 1, i + 3);
      const jw0 = Math.max(0, j - 3), jw1 = Math.min(n - 1, j + 3);
      const lap = (h[j * n + iw0] + h[j * n + iw1] + h[jw0 * n + i] + h[jw1 * n + i] - 4 * hc) / (9 * step * step);
      const curv = clamp01(0.5 - lap * 42);
      const alt = hc - water;
      let rock = smoothstep(0.62, 1.25, slope) * (0.45 + 0.55 * smoothstep(0.42, 0.75, curv));
      rock += smoothstep(118, 178, alt) * 0.45;
      data[k * 4 + 1] = curv * 255;
      data[k * 4 + 3] = clamp01(rock) * 255;
    }
  }
  ctl.tex.needsUpdate = true;
}

export default buildControlMap;
