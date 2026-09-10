/**
 * Grid distance fields. Two-pass 3×3 chamfer with the Borgefors-optimal
 * weights (0.9619 / 1.3604) — max relative error ~4%, which is far below the
 * 8 m cell size and costs two linear sweeps instead of a full EDT.
 */

const A = 0.9619, B = 1.3604;

/**
 * @param {Uint8Array} seed 1 where distance is 0
 * @returns {Float32Array} distance in metres
 */
export function chamfer(seed, w, h, cell = 1, cap = 1e6) {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = seed[i] ? 0 : cap;

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      let v = d[k];
      if (v === 0) continue;
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
      if (v === 0) continue;
      if (i < w - 1) v = Math.min(v, d[k + 1] + A);
      if (j < h - 1) {
        v = Math.min(v, d[k + w] + A);
        if (i < w - 1) v = Math.min(v, d[k + w + 1] + B);
        if (i > 0) v = Math.min(v, d[k + w - 1] + B);
      }
      d[k] = v;
    }
  }
  if (cell !== 1) for (let i = 0; i < d.length; i++) d[i] *= cell;
  return d;
}

/** Signed field: + inside the flagged set, − outside, zero-crossing on the cell edge. */
export function signedChamfer(inside, w, h, cell = 1) {
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < outside.length; i++) outside[i] = inside[i] ? 0 : 1;
  const dOut = chamfer(inside, w, h, cell);      // 0 where inside
  const dIn = chamfer(outside, w, h, cell);      // 0 where outside
  const s = new Float32Array(w * h);
  for (let i = 0; i < s.length; i++) s[i] = inside[i] ? dIn[i] : -dOut[i];
  return s;
}

export default chamfer;
