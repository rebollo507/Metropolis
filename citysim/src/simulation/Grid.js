/**
 * The coarse field grid every simulation field lives on.
 *
 * One square lattice over the whole map (default 32 m cells → 64×64 = 4096
 * cells for the standard 2048 m world). Every field is a Float32Array of
 * length w*h; nothing here allocates after construction, because all of it
 * runs inside the 20 Hz tick budget.
 */

export class FieldGrid {
  constructor(size = 2048, cellSize = 32) {
    this.size = size;
    this.cellSize = cellSize;
    this.w = Math.max(8, Math.round(size / cellSize));
    this.h = this.w;
    this.n = this.w * this.h;
    this.origin = -size / 2;
    this._tmp = new Float32Array(this.n);
    this._tmp2 = new Float32Array(this.n);
  }

  field() { return new Float32Array(this.n); }

  /** Cell column/row for a world position, clamped into range. */
  ix(x) {
    const i = Math.floor((x - this.origin) / this.cellSize);
    return i < 0 ? 0 : i >= this.w ? this.w - 1 : i;
  }
  iz(z) {
    const j = Math.floor((z - this.origin) / this.cellSize);
    return j < 0 ? 0 : j >= this.h ? this.h - 1 : j;
  }
  index(x, z) { return this.iz(z) * this.w + this.ix(x); }

  cx(i) { return this.origin + (i + 0.5) * this.cellSize; }
  cz(j) { return this.origin + (j + 0.5) * this.cellSize; }

  /** Bilinear sample of a field at a world position. */
  sample(f, x, z) {
    const fx = (x - this.origin) / this.cellSize - 0.5;
    const fz = (z - this.origin) / this.cellSize - 0.5;
    let i0 = Math.floor(fx), j0 = Math.floor(fz);
    let tx = fx - i0, tz = fz - j0;
    const w = this.w, h = this.h;
    if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > w - 2) { i0 = w - 2; tx = 1; }
    if (j0 < 0) { j0 = 0; tz = 0; } else if (j0 > h - 2) { j0 = h - 2; tz = 1; }
    const a = f[j0 * w + i0], b = f[j0 * w + i0 + 1];
    const c = f[(j0 + 1) * w + i0], d = f[(j0 + 1) * w + i0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  /** Add `v` at a world position (nearest cell). */
  splat(f, x, z, v) { f[this.index(x, z)] += v; }

  /**
   * Add `v` spread over a disc of world radius r with a smooth falloff.
   * Used for service installations and pollution sources.
   */
  splatDisc(f, x, z, r, v, falloff = 2) {
    const cs = this.cellSize;
    const rc = Math.max(1, Math.ceil(r / cs));
    const ci = this.ix(x), cj = this.iz(z);
    const inv = 1 / (r * r);
    for (let j = cj - rc; j <= cj + rc; j++) {
      if (j < 0 || j >= this.h) continue;
      const dz = this.cz(j) - z;
      for (let i = ci - rc; i <= ci + rc; i++) {
        if (i < 0 || i >= this.w) continue;
        const dx = this.cx(i) - x;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        let a = 1 - d2 * inv;
        if (falloff === 2) a *= a;
        f[j * this.w + i] += v * a;
      }
    }
  }

  fill(f, v) { f.fill(v); }

  /** Separable box blur, `passes` repetitions of a (2r+1) window. */
  blur(f, radius = 1, passes = 1) {
    const w = this.w, h = this.h, r = Math.max(1, radius | 0);
    const tmp = this._tmp;
    for (let p = 0; p < passes; p++) {
      // horizontal
      for (let j = 0; j < h; j++) {
        const row = j * w;
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += f[row + clampi(i, 0, w - 1)];
        const invN = 1 / (2 * r + 1);
        for (let i = 0; i < w; i++) {
          tmp[row + i] = sum * invN;
          sum += f[row + clampi(i + r + 1, 0, w - 1)] - f[row + clampi(i - r, 0, w - 1)];
        }
      }
      // vertical
      for (let i = 0; i < w; i++) {
        let sum = 0;
        for (let j = -r; j <= r; j++) sum += tmp[clampi(j, 0, h - 1) * w + i];
        const invN = 1 / (2 * r + 1);
        for (let j = 0; j < h; j++) {
          f[j * w + i] = sum * invN;
          sum += tmp[clampi(j + r + 1, 0, h - 1) * w + i] - tmp[clampi(j - r, 0, h - 1) * w + i];
        }
      }
    }
    return f;
  }

  /**
   * One explicit diffusion step with a wind bias — used for pollution, where a
   * plume should lean downwind rather than spreading as a perfect disc.
   */
  diffuseWind(f, k = 0.16, windX = 0, windZ = 0, decay = 0.985) {
    const w = this.w, h = this.h, tmp = this._tmp2;
    const bx = Math.max(-0.4, Math.min(0.4, windX));
    const bz = Math.max(-0.4, Math.min(0.4, windZ));
    for (let j = 0; j < h; j++) {
      const jm = (j > 0 ? j - 1 : 0) * w, jp = (j < h - 1 ? j + 1 : h - 1) * w, jc = j * w;
      for (let i = 0; i < w; i++) {
        const im = i > 0 ? i - 1 : 0, ip = i < w - 1 ? i + 1 : w - 1;
        const c = f[jc + i];
        const l = f[jc + im], rr = f[jc + ip], u = f[jm + i], d = f[jp + i];
        const lap = (l + rr + u + d) * 0.25 - c;
        const adv = (l - rr) * bx + (u - d) * bz;
        tmp[jc + i] = (c + k * lap + adv * k) * decay;
      }
    }
    f.set(tmp);
    return f;
  }

  /** Rescale a field so its 98th-percentile-ish maximum maps to 1. */
  normalize(f, floor = 1e-6) {
    let max = 0;
    for (let i = 0; i < f.length; i++) if (f[i] > max) max = f[i];
    if (max <= floor) { f.fill(0); return 0; }
    const inv = 1 / max;
    for (let i = 0; i < f.length; i++) f[i] *= inv;
    return max;
  }

  mean(f, mask = null) {
    let s = 0, k = 0;
    for (let i = 0; i < f.length; i++) {
      if (mask && mask[i] <= 0) continue;
      s += f[i]; k++;
    }
    return k ? s / k : 0;
  }

  max(f) { let m = 0; for (let i = 0; i < f.length; i++) if (f[i] > m) m = f[i]; return m; }
}

function clampi(v, a, b) { return v < a ? a : v > b ? b : v; }

/**
 * Two-pass chamfer (3-4 kernel) signed distance transform, in metres.
 * Positive inside the mask, negative outside. Used both for the "how far am I
 * from the built-up area" mask and for the overlay's soft boundary.
 */
export function signedChamfer(mask, w, h, cellSize, out) {
  const BIG = 1e9, n = w * h;
  const din = out || new Float32Array(n);
  const dout = new Float32Array(n);
  for (let i = 0; i < n; i++) { din[i] = mask[i] ? BIG : 0; dout[i] = mask[i] ? 0 : BIG; }
  chamferPass(din, w, h);
  chamferPass(dout, w, h);
  for (let i = 0; i < n; i++) din[i] = (mask[i] ? din[i] : -dout[i]) * cellSize;
  return din;
}

/** Unsigned distance (metres) to the nearest set cell. */
export function chamferDistance(mask, w, h, cellSize, out) {
  const BIG = 1e9, n = w * h;
  const d = out || new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = mask[i] ? 0 : BIG;
  chamferPass(d, w, h);
  for (let i = 0; i < n; i++) d[i] *= cellSize;
  return d;
}

function chamferPass(d, w, h) {
  const A = 1, B = 1.41421356;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + A);
      if (j > 0) {
        v = Math.min(v, d[k - w] + A);
        if (i > 0) v = Math.min(v, d[k - w - 1] + B);
        if (i < w - 1) v = Math.min(v, d[k - w + 1] + B);
      }
      d[k] = v;
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      let v = d[k];
      if (i < w - 1) v = Math.min(v, d[k + 1] + A);
      if (j < h - 1) {
        v = Math.min(v, d[k + w] + A);
        if (i > 0) v = Math.min(v, d[k + w - 1] + B);
        if (i < w - 1) v = Math.min(v, d[k + w + 1] + B);
      }
      d[k] = v;
    }
  }
}

export default FieldGrid;
