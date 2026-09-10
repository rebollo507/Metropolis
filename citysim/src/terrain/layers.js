/**
 * Procedural PBR layer set for the terrain splat.
 *
 * Four layers — grass, dry soil, rock, sand/gravel — each baked to two textures:
 *   albedo  : RGB, sRGB
 *   surf    : R,G = tangent-space normal xy   B = roughness   A = micro-AO   (linear)
 *
 * Every layer is authored from tileable value/cellular noise so it repeats
 * without a seam, and the shader samples each one at two very different world
 * scales blended by a low-frequency mask, which is what actually kills the
 * "wallpaper" look at grazing angles.
 */

import * as THREE from 'three';
import TileNoise from './TileNoise.js';

const TEX = 256;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Layer colours are authored as LINEAR reflectance; the canvas is sRGB-tagged. */
const toSRGB = (c) => {
  c = clamp01(c);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
};
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Bake one layer. `field(u, v, out)` writes:
 *   out.h    micro height  (0..1)
 *   out.r/g/b linear albedo (0..1)
 *   out.rough roughness    (0..1)
 */
function bakeLayer(assets, key, field, normalStrength) {
  const size = TEX;
  const hbuf = new Float32Array(size * size);
  const col = new Float32Array(size * size * 3);
  const rgh = new Float32Array(size * size);
  const out = { h: 0, r: 0, g: 0, b: 0, rough: 0.9 };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      field(x / size, y / size, out);
      const k = y * size + x;
      hbuf[k] = out.h;
      col[k * 3] = out.r; col[k * 3 + 1] = out.g; col[k * 3 + 2] = out.b;
      rgh[k] = out.rough;
    }
  }

  // --- albedo (with a touch of baked micro-AO from the height field) -------
  const albedo = assets.canvasTexture(`terrain:${key}:albedo`, size, (c2d) => {
    const img = c2d.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const k = y * size + x;
        const ao = 0.78 + 0.22 * hbuf[k];
        d[k * 4] = toSRGB(col[k * 3] * ao) * 255;
        d[k * 4 + 1] = toSRGB(col[k * 3 + 1] * ao) * 255;
        d[k * 4 + 2] = toSRGB(col[k * 3 + 2] * ao) * 255;
        d[k * 4 + 3] = 255;
      }
    }
    c2d.putImageData(img, 0, 0);
  }, { srgb: true });

  // --- surface: normal.xy + roughness + AO --------------------------------
  const surf = assets.canvasTexture(`terrain:${key}:surf`, size, (c2d) => {
    const img = c2d.createImageData(size, size);
    const d = img.data;
    const at = (x, y) => hbuf[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const k = y * size + x;
        const dx = (at(x + 1, y) - at(x - 1, y)) * normalStrength;
        const dy = (at(x, y + 1) - at(x, y - 1)) * normalStrength;
        const nx = clamp01(-dx * 0.5 + 0.5);
        const ny = clamp01(-dy * 0.5 + 0.5);
        // cheap curvature AO: darker where the local height sits below its neighbours
        const around = (at(x + 2, y) + at(x - 2, y) + at(x, y + 2) + at(x, y - 2)) * 0.25;
        const ao = clamp01(0.48 + 0.42 * hbuf[k] + (hbuf[k] - around) * 1.8);
        d[k * 4] = nx * 255;
        d[k * 4 + 1] = ny * 255;
        d[k * 4 + 2] = clamp01(rgh[k]) * 255;
        d[k * 4 + 3] = ao * 255;
      }
    }
    c2d.putImageData(img, 0, 0);
  }, { srgb: false });

  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
  surf.wrapS = surf.wrapT = THREE.RepeatWrapping;
  return { albedo, surf };
}

/* ------------------------------------------------------------------ */

export function buildLayers(assets, seed) {
  const N = new TileNoise(seed ^ 0x9e37);
  const M = new TileNoise((seed * 2246822519) >>> 0);

  /* ---------------- grass ------------------------------------------
     Rule for every layer: the LOWEST-frequency feature inside a tile must stay
     small relative to the tile, otherwise the repeat reads as a lattice at
     grazing angles. All the big patchiness lives in the shader's aperiodic
     macro noise instead. -------------------------------------------------- */
  const grass = bakeLayer(assets, 'grass', (u, v, o) => {
    const [f1] = N.cell(u * 24, v * 24, 24);
    const tuft = 1 - clamp01(f1 * 1.55);
    const [f2] = M.cell(u * 52, v * 52, 52);
    const small = 1 - clamp01(f2 * 1.7);
    const fine = N.fbm(u * 34, v * 34, 34, 3);
    const blade = M.fbm(u * 120, v * 120, 120, 2);
    o.h = tuft * 0.42 + small * 0.24 + fine * 0.22 + blade * 0.12;

    const dry = clamp01(0.24 + (N.fbm(u * 13, v * 13, 13, 3) - 0.5) * 1.15
                             + (M.fbm(u * 29, v * 29, 29, 2) - 0.5) * 0.55);
    const lush = [0.021, 0.082, 0.013];
    const dead = [0.138, 0.122, 0.038];
    const shade = 0.74 + 0.42 * o.h;
    const spec = M.fbm(u * 62, v * 62, 62, 2);
    o.r = lerp(lush[0], dead[0], dry) * shade * (0.86 + 0.28 * spec);
    o.g = lerp(lush[1], dead[1], dry) * shade * (0.88 + 0.24 * spec);
    o.b = lerp(lush[2], dead[2], dry) * shade * (0.80 + 0.40 * spec);
    // soil showing between the tufts
    const bare = smoothstep(0.62, 0.14, o.h);
    o.r = lerp(o.r, 0.062, bare * 0.55);
    o.g = lerp(o.g, 0.047, bare * 0.55);
    o.b = lerp(o.b, 0.031, bare * 0.55);
    o.rough = 0.91 - 0.07 * o.h + 0.04 * spec;
  }, 1.5);

  /* ---------------- dry soil: crumbs, grit, hairline cracks --------- */
  const soil = bakeLayer(assets, 'soil', (u, v, o) => {
    const [f1, id] = N.cell(u * 30, v * 30, 30);
    const crumb = 1 - clamp01(f1 * 1.7);
    const [gf, gid] = M.cell(u * 62, v * 62, 62);
    const pebble = smoothstep(0.34, 0.05, gf) * smoothstep(0.66, 0.86, gid);
    const grit = M.fbm(u * 86, v * 86, 86, 3);
    const crack = 1 - smoothstep(0.0, 0.085, 1 - N.ridge(u * 16, v * 16, 16, 3));
    o.h = crumb * 0.36 + grit * 0.30 + pebble * 0.28 + 0.22 - crack * 0.36;

    const tone = 0.80 + 0.40 * id;
    const t = clamp01(0.30 + (M.fbm(u * 17, v * 17, 17, 3) - 0.5) * 1.1 + grit * 0.5);
    const base = [0.070, 0.046, 0.028];
    const pale = [0.164, 0.120, 0.078];
    o.r = lerp(base[0], pale[0], t) * tone;
    o.g = lerp(base[1], pale[1], t) * tone;
    o.b = lerp(base[2], pale[2], t) * tone;
    if (pebble > 0.2) {
      const p = pebble * (0.45 + 0.6 * gid);
      o.r = lerp(o.r, 0.150 + 0.07 * gid, p);
      o.g = lerp(o.g, 0.136 + 0.07 * gid, p);
      o.b = lerp(o.b, 0.118 + 0.07 * gid, p);
    }
    o.r *= 1 - crack * 0.42; o.g *= 1 - crack * 0.42; o.b *= 1 - crack * 0.42;
    o.rough = 0.94 - 0.07 * grit - 0.10 * pebble;
  }, 3.0);

  /* ---------------- rock: strata + fractures + lichen --------------- */
  const rock = bakeLayer(assets, 'rock', (u, v, o) => {
    const warp = N.fbm(u * 10, v * 10, 10, 3) - 0.5;
    const strat = 0.5 + 0.5 * Math.sin((v * 13 + warp * 2.6) * Math.PI * 2);
    const frac = N.ridge(u * 12, v * 12, 12, 4);
    const grain = M.fbm(u * 64, v * 64, 64, 3);
    const chunk = 1 - clamp01(N.cell(u * 15, v * 15, 15)[0] * 1.4);
    o.h = clamp01(0.26 + strat * 0.18 + chunk * 0.32 + grain * 0.22 - Math.pow(frac, 3) * 0.6);

    const dark = [0.021, 0.019, 0.017];
    const light = [0.116, 0.101, 0.081];
    const t = clamp01(0.22 + strat * 0.40 + grain * 0.38 + chunk * 0.22);
    o.r = lerp(dark[0], light[0], t);
    o.g = lerp(dark[1], light[1], t);
    o.b = lerp(dark[2], light[2], t);
    const stain = smoothstep(0.55, 0.92, N.fbm(u * 11 + 3, v * 11 + 7, 11, 3));
    o.r = lerp(o.r, o.r * 1.7 + 0.022, stain * 0.65);
    o.g = lerp(o.g, o.g * 1.18 + 0.008, stain * 0.65);
    o.b = lerp(o.b, o.b * 0.82, stain * 0.65);
    const lich = smoothstep(0.60, 0.85, M.fbm(u * 19 + 11, v * 19 - 5, 19, 3)) * (0.35 + 0.65 * strat);
    o.r = lerp(o.r, 0.058, lich * 0.5);
    o.g = lerp(o.g, 0.074, lich * 0.5);
    o.b = lerp(o.b, 0.042, lich * 0.5);
    o.rough = 0.74 + 0.18 * grain + 0.06 * frac;
  }, 4.6);

  /* ---------------- sand / gravel bank ------------------------------ */
  const sand = bakeLayer(assets, 'sand', (u, v, o) => {
    const warp = N.fbm(u * 12, v * 12, 12, 3) - 0.5;
    const ripple = 0.5 + 0.5 * Math.sin((u * 21 + warp * 4.0 + v * 4) * Math.PI * 2);
    const grain = M.fbm(u * 104, v * 104, 104, 3);
    const [gf, gid] = N.cell(u * 44, v * 44, 44);
    const pebble = smoothstep(0.40, 0.05, gf) * smoothstep(0.60, 0.82, gid);
    o.h = ripple * 0.28 + grain * 0.38 + pebble * 0.42 + 0.12;

    const t = clamp01(0.38 + ripple * 0.24 + grain * 0.46 + (N.fbm(u * 15 + 9, v * 15 - 2, 15, 3) - 0.5) * 0.7);
    const wetS = [0.086, 0.068, 0.046];
    const dryS = [0.250, 0.206, 0.138];
    o.r = lerp(wetS[0], dryS[0], t);
    o.g = lerp(wetS[1], dryS[1], t);
    o.b = lerp(wetS[2], dryS[2], t);
    if (pebble > 0.22) {
      const p = pebble * (0.45 + 0.7 * gid);
      o.r = lerp(o.r, 0.135 + 0.09 * gid, p);
      o.g = lerp(o.g, 0.128 + 0.09 * gid, p);
      o.b = lerp(o.b, 0.120 + 0.09 * gid, p);
    }
    o.rough = 0.89 - 0.14 * pebble + 0.05 * grain;
  }, 2.2);

  return { grass, soil, rock, sand };
}

/* ------------------------------------------------------------------ */
/* animated water surface normal map (tileable, two-scale in the shader) */

export function buildWaterNormal(assets, seed) {
  const size = 256;
  const N = new TileNoise((seed ^ 0x77aa) >>> 0);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // criss-crossing capillary wave trains + a little chop
      const a = Math.sin((u * 6 + v * 2.4) * Math.PI * 2 + N.fbm(u * 4, v * 4, 4, 2) * 6.0);
      const b = Math.sin((u * -3.2 + v * 7.1) * Math.PI * 2 + N.fbm(u * 5 + 3, v * 5, 5, 2) * 5.0);
      const c = N.fbm(u * 22, v * 22, 22, 3) - 0.5;
      h[y * size + x] = a * 0.34 + b * 0.28 + c * 0.6;
    }
  }
  const tex = assets.canvasTexture('terrain:waternormal', size, (c2d) => {
    const img = c2d.createImageData(size, size);
    const d = img.data;
    const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const k = y * size + x;
        const dx = (at(x + 1, y) - at(x - 1, y)) * 0.9;
        const dy = (at(x, y + 1) - at(x, y - 1)) * 0.9;
        d[k * 4] = clamp01(-dx * 0.5 + 0.5) * 255;
        d[k * 4 + 1] = clamp01(-dy * 0.5 + 0.5) * 255;
        d[k * 4 + 2] = clamp01(h[k] * 0.5 + 0.5) * 255;
        d[k * 4 + 3] = 255;
      }
    }
    c2d.putImageData(img, 0, 0);
  }, { srgb: false });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
