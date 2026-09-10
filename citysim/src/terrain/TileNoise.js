/**
 * Small periodic (tileable) value-noise generator used to author the procedural
 * PBR layer textures. Periodic on an integer lattice so every texture we bake
 * wraps seamlessly at any power-of-two size — visible seams in a terrain splat
 * are one of the fastest ways to look like programmer art.
 *
 * Deterministic: pure integer hashing off a seed, no Math.random.
 */
export class TileNoise {
  constructor(seed = 1) { this.seed = seed >>> 0; }

  hash2(ix, iy) {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + this.seed) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /** Periodic value noise. `p` is the lattice period in the given coordinates. */
  value(x, y, p) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const x0 = ((ix % p) + p) % p, x1 = ((ix + 1) % p + p) % p;
    const y0 = ((iy % p) + p) % p, y1 = ((iy + 1) % p + p) % p;
    const a = this.hash2(x0, y0), b = this.hash2(x1, y0);
    const c = this.hash2(x0, y1), d = this.hash2(x1, y1);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  }

  /** Tileable fBm. Coordinates are in units of `period` lattice cells. */
  fbm(x, y, period, oct = 4, gain = 0.5) {
    let amp = 1, sum = 0, norm = 0, f = 1;
    for (let o = 0; o < oct; o++) {
      sum += amp * this.value(x * f, y * f, period * f);
      norm += amp;
      amp *= gain; f *= 2;
    }
    return sum / norm;
  }

  /** Tileable ridged noise — cracks, fractures, strata. */
  ridge(x, y, period, oct = 4, gain = 0.5) {
    let amp = 1, sum = 0, norm = 0, f = 1;
    for (let o = 0; o < oct; o++) {
      const v = 1 - Math.abs(this.value(x * f, y * f, period * f) * 2 - 1);
      sum += amp * v * v;
      norm += amp;
      amp *= gain; f *= 2;
    }
    return sum / norm;
  }

  /** Tileable cellular (Worley F1) — pebbles, gravel, clumps. Returns [f1, cellId]. */
  cell(x, y, p) {
    const ix = Math.floor(x), iy = Math.floor(y);
    let best = 8, id = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy;
        const wx = ((cx % p) + p) % p, wy = ((cy % p) + p) % p;
        const jx = this.hash2(wx, wy), jy = this.hash2(wx + 7919, wy + 104729);
        const px = cx + jx, py = cy + jy;
        const d = (px - x) * (px - x) + (py - y) * (py - y);
        if (d < best) { best = d; id = jx; }
      }
    }
    return [Math.sqrt(best), id];
  }
}

export default TileNoise;
