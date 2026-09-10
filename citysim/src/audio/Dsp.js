/**
 * audio/Dsp — the sample-level kernel.
 *
 * Everything this module makes a sound with is synthesised here or by Web Audio
 * nodes; nothing is downloaded (the egress proxy blocks every sample library, and
 * the asset policy would forbid them anyway). This file is the part of the module
 * that touches individual samples: noise, biquads, envelopes, waveshaping, the
 * comb/all-pass network the impulse responses are grown from, and a radix-2 FFT
 * used by the analyser overlay and by the offline verification harness.
 *
 * Determinism: every stochastic routine takes an `Rng` from `core/Rng.js`.
 * `Math.random` is banned project-wide and is not used here.
 */

export const TAU = Math.PI * 2;

export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (v) => 20 * Math.log10(Math.max(v, 1e-9));
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Smooth, monotone 0→1. */
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};

/* ============================================================== noise ==== */

/** White noise in [-1,1]. */
export function fillWhite(out, rng, gain = 1) {
  for (let i = 0; i < out.length; i++) out[i] = (rng.next() * 2 - 1) * gain;
  return out;
}

/**
 * Pink noise — Paul Kellet's economical −3 dB/oct filter, the standard
 * approximation. Normalised so its RMS lands near white's.
 */
export function fillPink(out, rng, gain = 1) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    const p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    out[i] = p * 0.11 * gain;
  }
  return out;
}

/** Brown (−6 dB/oct) noise via a leaky integrator, then DC-blocked. */
export function fillBrown(out, rng, gain = 1) {
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    y = (y + (rng.next() * 2 - 1) * 0.02) * 0.998;
    out[i] = y * 12 * gain;
  }
  return dcBlock(out);
}

/** One-pole DC blocker, in place. */
export function dcBlock(buf, r = 0.9985) {
  let x1 = 0, y1 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = x - x1 + r * y1;
    x1 = x; y1 = y;
    buf[i] = y;
  }
  return buf;
}

/* ============================================================= biquad ==== */

/**
 * RBJ cookbook biquad, direct form 1. Written as a small class rather than a
 * closure so a bake loop can hold dozens of them without allocating per sample.
 */
export class Biquad {
  constructor(sr = 48000) {
    this.sr = sr;
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }

  reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0; return this; }

  _norm(b0, b1, b2, a0, a1, a2) {
    const ia = 1 / a0;
    this.b0 = b0 * ia; this.b1 = b1 * ia; this.b2 = b2 * ia;
    this.a1 = a1 * ia; this.a2 = a2 * ia;
    return this;
  }

  lowpass(f, q = 0.7071) {
    const w = TAU * clamp(f, 10, this.sr * 0.49) / this.sr;
    const c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    return this._norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }

  highpass(f, q = 0.7071) {
    const w = TAU * clamp(f, 10, this.sr * 0.49) / this.sr;
    const c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    return this._norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }

  bandpass(f, q = 1) {
    const w = TAU * clamp(f, 10, this.sr * 0.49) / this.sr;
    const c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    return this._norm(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }

  peaking(f, q, gainDb) {
    const A = Math.pow(10, gainDb / 40);
    const w = TAU * clamp(f, 10, this.sr * 0.49) / this.sr;
    const c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    return this._norm(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }

  notch(f, q = 4) {
    const w = TAU * clamp(f, 10, this.sr * 0.49) / this.sr;
    const c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    return this._norm(1, -2 * c, 1, 1 + al, -2 * c, 1 - al);
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
            - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }

  /** Filter a whole buffer in place. */
  run(buf) {
    for (let i = 0; i < buf.length; i++) buf[i] = this.process(buf[i]);
    return buf;
  }
}

/** One-pole lowpass — cheap smoothing for control signals and dark tails. */
export class OnePole {
  constructor(a = 0.01) { this.a = a; this.y = 0; }
  set(hz, sr) { this.a = 1 - Math.exp(-TAU * hz / sr); return this; }
  process(x) { this.y += this.a * (x - this.y); return this.y; }
}

/* ========================================================== envelopes ==== */

/**
 * Percussive envelope: fast attack, exponential-ish decay with an adjustable
 * curve. `t` and the times are in seconds.
 */
export function hit(t, attack, decay, curve = 2.4) {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  const u = (t - attack) / Math.max(decay, 1e-5);
  return u >= 1 ? 0 : Math.pow(1 - u, curve);
}

/** Raised-cosine window, for grains that must not click. */
export function hann(u) { return 0.5 - 0.5 * Math.cos(TAU * clamp(u, 0, 1)); }

/* ========================================================= waveshaping === */

/**
 * tanh soft clip normalised so |y| ≤ 1 strictly. The master limiter uses this
 * as its ceiling, which is what makes "no sample exceeds 1.0" a property of the
 * graph rather than a hope.
 */
export function softClip(x, k = 1.6) {
  return Math.tanh(k * x) / Math.tanh(k);
}

/** Curve table for a WaveShaperNode implementing softClip(). */
export function softClipCurve(n = 4096, k = 1.6) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = softClip((i / (n - 1)) * 2 - 1, k);
  return c;
}

/* ============================================== reverb building blocks === */

/** Schroeder all-pass, used to diffuse an impulse response into a smooth tail. */
export class Allpass {
  constructor(n, g = 0.7) { this.buf = new Float32Array(Math.max(1, n | 0)); this.i = 0; this.g = g; }
  process(x) {
    const b = this.buf;
    const v = b[this.i];
    const y = -x * this.g + v;
    b[this.i] = x + v * this.g;
    if (++this.i >= b.length) this.i = 0;
    return y;
  }
}

/** Feedback comb with a one-pole damper in the loop (HF decays faster). */
export class Comb {
  constructor(n, fb = 0.8, damp = 0.2) {
    this.buf = new Float32Array(Math.max(1, n | 0));
    this.i = 0; this.fb = fb; this.damp = damp; this.store = 0;
  }
  process(x) {
    const b = this.buf;
    const y = b[this.i];
    this.store = y * (1 - this.damp) + this.store * this.damp;
    b[this.i] = x + this.store * this.fb;
    if (++this.i >= b.length) this.i = 0;
    return y;
  }
}

/* ============================================================ buffers ==== */

/**
 * Make a noise loop seamless: cross-fade the tail back over the head with a
 * constant-power curve. Without this every looped bed ticks once per period,
 * which is the single most common tell of a cheap ambience system.
 */
export function seamless(buf, fade) {
  const n = buf.length, f = Math.min(fade | 0, (n / 2) | 0);
  if (f < 2) return buf;
  const out = buf.subarray(0, n - f);
  for (let i = 0; i < f; i++) {
    const u = i / f;
    const a = Math.cos(u * Math.PI * 0.5), b = Math.sin(u * Math.PI * 0.5);
    out[i] = out[i] * b + buf[n - f + i] * a;
  }
  return out;
}

/** Peak-normalise in place to `peak`; returns the gain applied. */
export function normalize(buf, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; }
  if (m < 1e-9) return 0;
  const g = peak / m;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return g;
}

export function rms(buf, from = 0, to = buf.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

export function peakOf(buf) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; }
  return m;
}

/* =============================================================== FFT ===== */

/**
 * In-place iterative radix-2 FFT. `re`/`im` must be power-of-two length.
 * Used by the spectrum overlay (offline path) and the verification harness —
 * `AnalyserNode` only exists on a running context, and the harness's context is
 * suspended, so the module carries its own transform.
 */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TAU / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  return re;
}

/** Magnitude spectrum of one Hann-windowed frame. Returns n/2+1 bins. */
export function magSpectrum(frame, out) {
  const n = frame.length;
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * (0.5 - 0.5 * Math.cos(TAU * i / (n - 1)));
  fft(re, im);
  const bins = n / 2 + 1;
  const o = out && out.length >= bins ? out : new Float32Array(bins);
  for (let i = 0; i < bins; i++) o[i] = Math.hypot(re[i], im[i]) / (n * 0.5);
  return o;
}

/** Power-weighted mean frequency of a magnitude spectrum, in Hz. */
export function spectralCentroid(mag, sr) {
  let num = 0, den = 0;
  const df = sr / ((mag.length - 1) * 2);
  for (let i = 1; i < mag.length; i++) {
    const p = mag[i] * mag[i];
    num += p * (i * df);
    den += p;
  }
  return den > 1e-20 ? num / den : 0;
}

/** Average magnitude spectrum over the whole signal (50 % overlap Hann). */
export function averageSpectrum(sig, fftSize = 2048) {
  const bins = fftSize / 2 + 1;
  const acc = new Float64Array(bins);
  const frame = new Float32Array(fftSize);
  const mag = new Float32Array(bins);
  let frames = 0;
  for (let p = 0; p + fftSize <= sig.length; p += fftSize / 2) {
    frame.set(sig.subarray(p, p + fftSize));
    magSpectrum(frame, mag);
    for (let i = 0; i < bins; i++) acc[i] += mag[i];
    frames++;
  }
  const out = new Float32Array(bins);
  if (frames) for (let i = 0; i < bins; i++) out[i] = acc[i] / frames;
  return out;
}

export default {
  dbToLin, linToDb, clamp, lerp, smoothstep,
  fillWhite, fillPink, fillBrown, dcBlock,
  Biquad, OnePole, Allpass, Comb,
  hit, hann, softClip, softClipCurve,
  seamless, normalize, rms, peakOf,
  fft, magSpectrum, spectralCentroid, averageSpectrum,
};
