import * as THREE from 'three';

/**
 * environment/procedural.js — tileable procedural surfaces.
 *
 * The egress proxy blocks every CC0 texture host, so the reference ground is
 * generated here: a weathered pale-concrete albedo, a matching roughness map
 * (worn/polished patches, damp seams) and a normal map derived from the same
 * height field, all built on *periodic* value noise so a 400× repeat has no
 * seams. Albedo/roughness/normal come out of one pixel loop because they share
 * the same fBm evaluations.
 */

function ihash(x, y, s) {
  let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise on an integer lattice that wraps every `period` units. */
function pvalue(x, y, period, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = fade(x - xi), v = fade(y - yi);
  const p = period | 0;
  const x0 = ((xi % p) + p) % p, x1 = (x0 + 1) % p;
  const y0 = ((yi % p) + p) % p, y1 = (y0 + 1) % p;
  const a = ihash(x0, y0, s), b = ihash(x1, y0, s);
  const c = ihash(x0, y1, s), d = ihash(x1, y1, s);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

function pfbm(x, y, period, oct, s) {
  let amp = 0.5, sum = 0, norm = 0, p = period, f = 1;
  for (let o = 0; o < oct; o++) {
    sum += amp * pvalue(x * f, y * f, p * f, s + o * 101);
    norm += amp;
    amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

/**
 * Build albedo / roughness / normal for a neutral weathered concrete.
 * @returns {{map:THREE.DataTexture, roughnessMap:THREE.DataTexture, normalMap:THREE.DataTexture}}
 */
export function concreteSet(assets, { size = 512, seed = 7, repeat = 400, aniso = 8 } = {}) {
  const key = `env:concrete:${size}:${seed}`;
  const N = size;
  const period = 8;                 // lattice cells across the whole texture

  const albedo = new Uint8Array(N * N * 4);
  const rough = new Uint8Array(N * N * 4);
  const height = new Float32Array(N * N);

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = (i / N) * period, v = (j / N) * period;

      // structure: broad pours, medium mottling, fine aggregate
      const broad = pfbm(u * 0.5, v * 0.5, period, 3, seed);
      const mid = pfbm(u * 2.0, v * 2.0, period * 4, 4, seed + 17);
      const fine = pfbm(u * 4.0, v * 4.0, period * 8, 3, seed + 53);
      const grit = ihash(i * 3 + 1, j * 7 + 5, seed + 91);

      // Aggregate speckle. Every lattice here is kept at >= 8 px per cell in the
      // 512² map: a finer lattice is under-sampled once the ground plane is
      // minified across a kilometre and moirés into a regular diamond quilt.
      const stone = pvalue(u * 5, v * 5, period * 10, seed + 131);
      const stoneMask = stone > 0.78 ? (stone - 0.78) / 0.22 : 0;

      // Mid-grey city concrete (~0.16 linear). Anything lighter blows the whole
      // frame out at noon and leaves no headroom for the sky to read brighter
      // than the ground, which is what makes a render look washed.
      let l = 0.425 + (broad - 0.5) * 0.11 + (mid - 0.5) * 0.10 + (fine - 0.5) * 0.07;
      l += (grit - 0.5) * 0.014;   // white noise: averages cleanly in mips
      l -= stoneMask * 0.07;
      l = Math.max(0.08, Math.min(0.80, l));

      // faint warm/cool drift so it never reads as a flat grey
      const warm = (broad - 0.5) * 0.06;
      const r = l * (1 + warm * 0.9);
      const g = l * (1 + warm * 0.25);
      const b = l * (1 - warm * 0.55) * 0.985;

      const o = (j * N + i) * 4;
      albedo[o] = Math.round(Math.min(1, r) * 255);
      albedo[o + 1] = Math.round(Math.min(1, g) * 255);
      albedo[o + 2] = Math.round(Math.min(1, b) * 255);
      albedo[o + 3] = 255;

      // roughness: polished traffic lanes vs. rough pours, plus stone specks
      let rg = 0.86 - (broad - 0.5) * 0.30 + (mid - 0.5) * 0.14 - stoneMask * 0.16;
      rg = Math.max(0.30, Math.min(0.99, rg));
      const ro = Math.round(rg * 255);
      rough[o] = ro; rough[o + 1] = ro; rough[o + 2] = ro; rough[o + 3] = 255;

      height[j * N + i] = broad * 0.35 + mid * 0.4 + fine * 0.6 + stoneMask * 1.4 + grit * 0.12;
    }
  }

  // normal from central differences on the height field (wrapping)
  const normal = new Uint8Array(N * N * 4);
  const strength = 1.8;
  for (let j = 0; j < N; j++) {
    const jm = (j - 1 + N) % N, jp = (j + 1) % N;
    for (let i = 0; i < N; i++) {
      const im = (i - 1 + N) % N, ip = (i + 1) % N;
      const dx = (height[j * N + ip] - height[j * N + im]) * strength;
      const dy = (height[jp * N + i] - height[jm * N + i]) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const o = (j * N + i) * 4;
      normal[o] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normal[o + 3] = 255;
    }
  }

  const mk = (name, data, srgb) => {
    const t = assets.dataTexture(`${key}:${name}`, data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = aniso;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  };

  return {
    map: mk('a', albedo, true),
    roughnessMap: mk('r', rough, false),
    normalMap: mk('n', normal, false),
  };
}

/**
 * Macro colour variation baked into a ground plane's vertex colours. Breaks up
 * texture tiling at the 40–300 m scale, which is where repetition is obvious.
 */
export function paintGroundVertexColors(geometry, { scale = 0.006, seed = 3, amount = 0.16 } = {}) {
  const pos = geometry.attributes.position;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), z = -pos.getY(i);   // plane is still in XY at this point
    const a = pfbm(x * scale, z * scale, 4096, 4, seed);
    const b = pfbm(x * scale * 5.3 + 11, z * scale * 5.3 - 7, 4096, 3, seed + 29);
    const l = 1 + (a - 0.5) * amount * 2 + (b - 0.5) * amount * 0.7;
    const warm = (a - 0.5) * 0.10;
    col[i * 3] = Math.max(0.35, l * (1 + warm));
    col[i * 3 + 1] = Math.max(0.35, l);
    col[i * 3 + 2] = Math.max(0.35, l * (1 - warm * 0.8));
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geometry;
}

export default { concreteSet, paintGroundVertexColors };
