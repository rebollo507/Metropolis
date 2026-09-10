/**
 * Seeded deterministic randomness. Math.random() is banned project-wide.
 * sfc32 — small, fast, passes PractRand. Derived streams keep modules independent.
 */

export function hashString(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed = 1337) {
    this.seed = seed >>> 0;
    this.reset();
  }

  reset() {
    let s = this.seed;
    // splitmix32 to spread the seed across the four state words
    const nx = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = nx(); this.b = nx(); this.c = nx(); this.d = nx();
    for (let i = 0; i < 12; i++) this.next();
    return this;
  }

  /** float in [0,1) */
  next() {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  range(min, max) { return min + (max - min) * this.next(); }
  int(n) { return Math.floor(this.next() * n); }
  intRange(min, max) { return min + Math.floor(this.next() * (max - min + 1)); }
  bool(p = 0.5) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  sign() { return this.next() < 0.5 ? -1 : 1; }

  /** Gaussian via Box-Muller (cached pair). */
  gauss(mean = 0, sd = 1) {
    if (this._g !== undefined) { const g = this._g; this._g = undefined; return mean + g * sd; }
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this._g = r * Math.sin(2 * Math.PI * v);
    return mean + r * Math.cos(2 * Math.PI * v) * sd;
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** Weighted pick: entries [[value, weight], ...] */
  weighted(entries) {
    let total = 0;
    for (const e of entries) total += e[1];
    let r = this.next() * total;
    for (const e of entries) { r -= e[1]; if (r <= 0) return e[0]; }
    return entries[entries.length - 1][0];
  }

  static derive(seed, name) { return new Rng((hashString(name, seed >>> 0) ^ (seed >>> 0)) >>> 0); }
}

/* --------------------------------------------------------------------------
   Deterministic value + simplex noise (seeded permutation table)
   -------------------------------------------------------------------------- */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD2 = [1,1, -1,1, 1,-1, -1,-1, 1,0, -1,0, 0,1, 0,-1];

export class Noise {
  constructor(seed = 1337) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    rng.shuffle(p);
    this.perm = new Uint8Array(512);
    this.permMod8 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod8[i] = this.perm[i] % 8;
    }
  }

  /** 2D simplex noise, output in roughly [-1,1] */
  simplex2(xin, yin) {
    const perm = this.perm, permMod8 = this.permMod8;
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi = permMod8[ii + perm[jj]] * 2;
      t0 *= t0; n0 = t0 * t0 * (GRAD2[gi] * x0 + GRAD2[gi + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi = permMod8[ii + i1 + perm[jj + j1]] * 2;
      t1 *= t1; n1 = t1 * t1 * (GRAD2[gi] * x1 + GRAD2[gi + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi = permMod8[ii + 1 + perm[jj + 1]] * 2;
      t2 *= t2; n2 = t2 * t2 * (GRAD2[gi] * x2 + GRAD2[gi + 1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }

  /** Fractal Brownian motion. */
  fbm(x, y, octaves = 5, lacunarity = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex2(x * freq, y * freq);
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal — good for mountain spines. */
  ridged(x, y, octaves = 5, lacunarity = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.simplex2(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }
}

export default Rng;
