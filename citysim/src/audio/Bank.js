/**
 * audio/Bank — the sound library, synthesised.
 *
 * Nothing here is a recording. Every loop, one-shot and impulse response is
 * grown sample by sample from noise, oscillators, biquads and envelopes, seeded
 * from `world.seed` so two runs of the same city sound identical.
 *
 * The design follows how a game audio team would actually build a city bed:
 *
 *   · **beds are loops**, deliberately long and cross-faded so they never tick;
 *     each is a *layer* (low roar / mid body / air) rather than a finished mix,
 *     so the runtime can re-balance them for altitude, zone and weather;
 *   · **events are one-shots**, baked in small variant sets and then varied at
 *     playback by rate, filter, level and pan — the standard trick that gets
 *     hundreds of distinguishable car passes out of three buffers;
 *   · **reverb is an impulse response**, grown from a comb/all-pass network with
 *     band-dependent decay, so the street canyon and the open air above the city
 *     are genuinely different rooms rather than two settings of a delay.
 *
 * Cost is measured, not assumed: `Bank.stats()` reports bake time and megabytes.
 */

import { Rng } from '../core/Rng.js';
import {
  TAU, clamp, lerp, smoothstep, fillWhite, fillPink, fillBrown, dcBlock,
  Biquad, OnePole, Allpass, Comb, hit, hann, softClip, seamless, normalize, peakOf,
} from './Dsp.js';

/* Bed loop lengths, seconds. Long enough that the ear cannot hold the period,
 * short enough that the whole bank stays inside a few tens of megabytes. */
const LOOP = { hum: 6.0, wash: 6.0, chatter: 6.0, rain: 6.0, wind: 8.0, misc: 4.0 };

/* --------------------------------------------------------------- helpers -- */

const mono = (sr, dur) => [new Float32Array(Math.round(sr * dur))];
const stereo = (sr, dur) => [new Float32Array(Math.round(sr * dur)), new Float32Array(Math.round(sr * dur))];

/** A slowly-wandering control signal in [0,1] — gusts, crowd density, load. */
function walk(n, rng, hz, sr, start = 0.5) {
  const out = new Float32Array(n);
  const a = 1 - Math.exp(-TAU * hz / sr);
  let y = start, t = start;
  for (let i = 0; i < n; i++) {
    if ((i & 511) === 0) t = clamp(t + rng.gauss(0, 0.30), 0, 1);
    y += a * (t - y);
    out[i] = y;
  }
  return out;
}

/** Additive band-limited saw: `h` harmonics at 1/n, phase-continuous. */
function saw(phase, h) {
  let s = 0;
  for (let k = 1; k <= h; k++) s += Math.sin(phase * k) / k;
  return s * 0.55;
}

/* ============================================================== the bank == */

export class Bank {
  constructor(sampleRate = 48000, seed = 1337) {
    this.sr = sampleRate;
    this.seed = seed >>> 0;
    this.data = new Map();     // name -> {ch:[Float32Array], sr, dur, loop}
    this.buffers = new WeakMap(); // AudioContext -> Map(name -> AudioBuffer)
    this.bakeMs = 0;
    this.bytes = 0;
    this.built = false;
  }

  rng(name) { return Rng.derive(this.seed, 'audio:' + name); }

  put(name, ch, loop = false) {
    const rec = { ch, sr: this.sr, dur: ch[0].length / this.sr, loop };
    this.data.set(name, rec);
    for (const c of ch) this.bytes += c.byteLength;
    return rec;
  }

  has(name) { return this.data.has(name); }
  get(name) { return this.data.get(name) || null; }
  names() { return [...this.data.keys()]; }

  /** AudioBuffer for a given context, created once and cached per context. */
  buffer(actx, name) {
    if (!actx) return null;
    const rec = this.data.get(name);
    if (!rec) return null;
    let m = this.buffers.get(actx);
    if (!m) { m = new Map(); this.buffers.set(actx, m); }
    let b = m.get(name);
    if (!b) {
      b = actx.createBuffer(rec.ch.length, rec.ch[0].length, rec.sr);
      for (let c = 0; c < rec.ch.length; c++) b.copyToChannel(rec.ch[c], c);
      m.set(name, b);
    }
    return b;
  }

  stats() {
    return {
      built: this.built,
      entries: this.data.size,
      bakeMs: +this.bakeMs.toFixed(1),
      megabytes: +(this.bytes / 1048576).toFixed(2),
      sampleRate: this.sr,
    };
  }

  /* ------------------------------------------------------------- build --- */

  /**
   * The bake, as a list of steps.
   *
   * Baking the whole library is ~2.2 s on this two-core sandbox (a few hundred
   * milliseconds on real hardware), and a single 2 s synchronous block on the
   * first click is not acceptable in a game that is rendering. So the live path
   * walks these steps one per animation frame (`Director._bakeStaged`), while
   * the offline harness — which has no frames to drop — calls `build()`.
   */
  stepList() {
    if (!this._steps) {
      this._steps = [
        ['city hum', () => this.bakeCityHum()],
        ['traffic', () => this.bakeTraffic()],
        ['crowd babble', () => this.bakeChatter()],
        ['foliage', () => this.bakeFoliage()],
        ['industry', () => this.bakeIndustry()],
        ['rain', () => this.bakeRain()],
        ['wind', () => this.bakeWind()],
        ['night', () => this.bakeNight()],
        ['vehicle passes', () => this.bakePasses()],
        ['horns', () => this.bakeHorns()],
        ['construction', () => this.bakeConstruction()],
        ['birds', () => this.bakeBirds()],
        ['thunder', () => this.bakeThunder()],
        ['interface', () => this.bakeUi()],
        ['impulse responses', () => this.bakeIRs()],
      ].map(([name, run]) => ({ name, run }));
    }
    return this._steps;
  }

  /** Run one step. Returns true when the bank is complete. */
  runStep(i) {
    const steps = this.stepList();
    if (this.built || i >= steps.length) return true;
    // a staged bake that was interrupted resumes rather than re-baking
    if (i < (this._next || 0)) return false;
    this._next = i + 1;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    steps[i].run();
    this.bakeMs += (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    if (i === steps.length - 1) this.built = true;
    return this.built;
  }

  build() {
    if (this.built) return this;
    const steps = this.stepList();
    for (let i = 0; i < steps.length; i++) this.runStep(i);
    return this;
  }

  /* ============================================================ beds ===== */

  /**
   * The city's own noise floor, in three layers.
   *
   *  low  — the distant roar: brown noise under 200 Hz plus a faint plant drone.
   *         This is nearly all of what a city sounds like from 300 m up.
   *  mid  — the body: pink noise around 400 Hz, lightly chorused so it moves.
   *  air  — tyre hiss and HVAC breath above 1.2 kHz, stereo-decorrelated. Air
   *         absorption kills this over distance, so altitude fades it out — the
   *         measurable consequence is a spectral centroid that falls with height.
   */
  bakeCityHum() {
    const sr = this.sr, n = Math.round(sr * LOOP.hum);

    // low roar
    {
      const rng = this.rng('hum.low');
      const buf = new Float32Array(n + sr);
      fillBrown(buf, rng, 1);
      new Biquad(sr).lowpass(190, 0.8).run(buf);
      new Biquad(sr).peaking(72, 1.1, 5).run(buf);
      const drift = walk(buf.length, this.rng('hum.low.d'), 0.05, sr, 0.6);
      // a faint mains-ish drone: the plant rooms of a city never stop
      let p1 = 0, p2 = 0;
      const w1 = TAU * 99.6 / sr, w2 = TAU * 100.35 / sr;
      for (let i = 0; i < buf.length; i++) {
        p1 += w1; p2 += w2;
        buf[i] = buf[i] * (0.55 + 0.45 * drift[i]) + (Math.sin(p1) + Math.sin(p2)) * 0.012;
      }
      normalize(buf, 0.8);
      this.put('bed.hum.low', [seamless(buf, sr * 0.9)], true);
    }

    // mid body
    {
      const rng = this.rng('hum.mid');
      const buf = new Float32Array(n + sr);
      fillPink(buf, rng, 1);
      new Biquad(sr).bandpass(380, 0.55).run(buf);
      new Biquad(sr).peaking(240, 1.4, 3).run(buf);
      // slow chorus: a modulated 4–11 ms tap keeps the layer from sitting still
      const out = new Float32Array(buf.length);
      const maxD = Math.round(sr * 0.012);
      let ph = 0;
      for (let i = 0; i < buf.length; i++) {
        ph += TAU * 0.07 / sr;
        const d = Math.round(maxD * (0.5 + 0.45 * Math.sin(ph)));
        const j = i - d;
        out[i] = buf[i] * 0.7 + (j >= 0 ? buf[j] : 0) * 0.5;
      }
      normalize(out, 0.8);
      this.put('bed.hum.mid', [seamless(out, sr * 0.9)], true);
    }

    // air / hiss, stereo
    {
      const ch = [];
      for (let c = 0; c < 2; c++) {
        const rng = this.rng('hum.air.' + c);
        const buf = new Float32Array(n + sr);
        fillPink(buf, rng, 1);
        new Biquad(sr).highpass(1250, 0.6).run(buf);
        new Biquad(sr).lowpass(7200, 0.7).run(buf);
        const g = walk(buf.length, this.rng('hum.air.g' + c), 0.09, sr, 0.5);
        for (let i = 0; i < buf.length; i++) buf[i] *= 0.55 + 0.55 * g[i];
        normalize(buf, 0.8);
        ch.push(seamless(buf, sr * 0.9));
      }
      this.put('bed.hum.air', ch, true);
    }
  }

  /**
   * Traffic, as two separable layers so the runtime can weight them by density
   * *and* by congestion — jammed traffic is all idling engines and no tyre wash,
   * free-flowing traffic is the opposite, and that difference is most of what
   * makes a city sound busy rather than loud.
   */
  bakeTraffic() {
    const sr = this.sr, n = Math.round(sr * LOOP.wash);

    // tyre wash — passing swells, each sweeping its band centre
    {
      const rng = this.rng('traffic.wash');
      const src = new Float32Array(n + sr);
      fillPink(src, rng, 1);
      const out = new Float32Array(src.length);
      const bp = new Biquad(sr);
      const events = [];
      for (let k = 0; k < 26; k++) {
        events.push({
          t: rng.range(-1, LOOP.wash + 1) * sr,
          w: rng.range(0.45, 1.5) * sr,
          a: rng.range(0.35, 1.0),
          f0: rng.range(620, 900), f1: rng.range(1100, 1900),
        });
      }
      let env = 0, cf = 900;
      for (let i = 0; i < src.length; i++) {
        if ((i & 63) === 0) {
          env = 0.22; cf = 0;
          let wsum = 0;
          for (const e of events) {
            const u = (i - e.t) / e.w;
            if (u < -3 || u > 3) continue;
            const g = Math.exp(-u * u * 1.6) * e.a;
            env += g;
            const f = lerp(e.f0, e.f1, clamp(u * 0.5 + 0.5, 0, 1));
            cf += f * g; wsum += g;
          }
          cf = wsum > 1e-4 ? cf / wsum : 950;
          bp.bandpass(clamp(cf, 400, 2400), 0.62);
        }
        out[i] = bp.process(src[i]) * Math.min(env, 1.6);
      }
      new Biquad(sr).highpass(160, 0.7).run(out);
      normalize(out, 0.85);
      this.put('bed.traffic.wash', [seamless(out, sr * 0.9)], true);
    }

    // engine bed — a handful of distant idling/pulling engines
    {
      const rng = this.rng('traffic.engines');
      const len = n + sr;
      const out = new Float32Array(len);
      for (let v = 0; v < 7; v++) {
        const f0 = rng.range(26, 58);
        const load = walk(len, this.rng('eng.load' + v), 0.13, sr, rng.next());
        const amp = rng.range(0.25, 0.8);
        const detune = rng.range(-0.4, 0.4);
        let ph = 0;
        for (let i = 0; i < len; i++) {
          const f = f0 * (1 + 0.22 * load[i]) + detune;
          ph += TAU * f / sr;
          if (ph > TAU * 64) ph -= TAU * 64;
          out[i] += saw(ph, 7) * amp * (0.35 + 0.65 * load[i]);
        }
      }
      new Biquad(sr).lowpass(230, 0.9).run(out);
      new Biquad(sr).highpass(30, 0.7).run(out);
      // a light diesel clatter so it is not a pure drone
      const rat = this.rng('eng.rattle');
      const cl = new Float32Array(len);
      const bpc = new Biquad(sr).bandpass(1500, 3.2);
      for (let k = 0; k < 340; k++) {
        const t0 = Math.round(rat.range(0, len - 800));
        const a = rat.range(0.02, 0.10);
        for (let i = 0; i < 700; i++) cl[t0 + i] += (rat.next() * 2 - 1) * a * hit(i / sr, 0.0004, 0.010, 3);
      }
      bpc.run(cl);
      for (let i = 0; i < len; i++) out[i] += cl[i] * 1.15;
      dcBlock(out);
      normalize(out, 0.85);
      this.put('bed.traffic.engines', [seamless(out, sr * 0.9)], true);
    }
  }

  /**
   * Crowd babble. Overlapping "utterances": noise driven through three gliding
   * formants with a 4–6 Hz syllabic envelope. No word is ever intelligible,
   * which is the point — the ear reads it as people without listening to them.
   */
  bakeChatter() {
    const sr = this.sr, len = Math.round(sr * LOOP.chatter) + sr;
    const ch = [new Float32Array(len), new Float32Array(len)];
    const rng = this.rng('chatter');
    const src = new Float32Array(len);
    fillPink(src, this.rng('chatter.src'), 1);

    const f1 = new Biquad(sr), f2 = new Biquad(sr), f3 = new Biquad(sr);
    for (let u = 0; u < 150; u++) {
      const start = Math.round(rng.range(-0.5, LOOP.chatter) * sr);
      const dur = Math.round(rng.range(0.22, 0.85) * sr);
      const pan = rng.range(-1, 1);
      const gain = rng.range(0.12, 0.5) * (0.4 + 0.6 * rng.next());
      const male = rng.bool(0.5);
      const base = male ? 0.86 : 1.16;
      const F1a = 480 * base, F1b = F1a * rng.range(0.75, 1.35);
      const F2a = 1450 * base, F2b = F2a * rng.range(0.7, 1.4);
      const F3a = 2650 * base;
      const syl = rng.range(3.6, 6.2);
      const sylPh = rng.range(0, TAU);
      const gl = 1 / Math.max(1, dur);
      const lg = Math.sqrt(clamp(0.5 - pan * 0.5, 0, 1)), rg = Math.sqrt(clamp(0.5 + pan * 0.5, 0, 1));
      for (let i = 0; i < dur; i++) {
        const j = start + i;
        if (j < 0 || j >= len) continue;
        const t = i * gl;
        if ((i & 127) === 0) {
          f1.bandpass(lerp(F1a, F1b, t), 5.5);
          f2.bandpass(lerp(F2a, F2b, t), 6.5);
          f3.bandpass(F3a, 7.5);
        }
        const x = src[j];
        const v = f1.process(x) * 1.0 + f2.process(x) * 0.55 + f3.process(x) * 0.28;
        const s = Math.max(0, Math.sin(sylPh + t * dur / sr * TAU * syl));
        const env = Math.sin(Math.PI * t) * (0.35 + 0.65 * s * s);
        const y = v * env * gain;
        ch[0][j] += y * lg; ch[1][j] += y * rg;
      }
    }
    // a little room tone under the voices
    const room = new Float32Array(len);
    fillPink(room, this.rng('chatter.room'), 1);
    new Biquad(sr).bandpass(700, 0.5).run(room);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < len; i++) ch[c][i] += room[i] * 0.10;
      new Biquad(sr).highpass(180, 0.7).run(ch[c]);
      normalize(ch[c], 0.8);
      ch[c] = seamless(ch[c], sr * 0.8);
    }
    this.put('bed.chatter', ch, true);
  }

  /** Foliage: broadband rustle gated by gusts — the sound of a quiet street. */
  bakeFoliage() {
    const sr = this.sr, len = Math.round(sr * LOOP.misc) + sr;
    const ch = [];
    for (let c = 0; c < 2; c++) {
      const buf = new Float32Array(len);
      fillPink(buf, this.rng('leaves' + c), 1);
      new Biquad(sr).bandpass(2600, 0.55).run(buf);
      const g = walk(len, this.rng('leaves.g' + c), 0.22, sr, 0.4);
      for (let i = 0; i < len; i++) buf[i] *= 0.12 + 1.5 * g[i] * g[i];
      normalize(buf, 0.8);
      ch.push(seamless(buf, sr * 0.7));
    }
    this.put('bed.foliage', ch, true);
  }

  /**
   * Industry: a harmonic plant hum with real beating (partials detuned by a
   * fraction of a hertz), a fan with a blade-passing tone, and a low rumble.
   */
  bakeIndustry() {
    const sr = this.sr, len = Math.round(sr * LOOP.misc) + sr;
    const out = new Float32Array(len);
    const rng = this.rng('industry');
    const parts = [
      [49.7, 1.0, 0.31], [99.6, 0.55, 0.22], [149.1, 0.30, 0.47],
      [198.9, 0.17, 0.63], [298.6, 0.09, 0.29],
    ];
    for (const [f, a, beat] of parts) {
      let p1 = 0, p2 = 0;
      const w1 = TAU * f / sr, w2 = TAU * (f + beat) / sr;
      for (let i = 0; i < len; i++) {
        p1 += w1; p2 += w2;
        out[i] += (Math.sin(p1) + Math.sin(p2) * 0.8) * a * 0.24;
      }
    }
    // extraction fan
    const fan = new Float32Array(len);
    fillPink(fan, this.rng('industry.fan'), 1);
    new Biquad(sr).bandpass(950, 1.3).run(fan);
    const blade = new Float32Array(len);
    fillPink(blade, this.rng('industry.blade'), 1);
    new Biquad(sr).bandpass(2150, 6.0).run(blade);
    let bp = 0;
    for (let i = 0; i < len; i++) {
      bp += TAU * 23.7 / sr;
      out[i] += fan[i] * 0.46 + blade[i] * 0.26 * (0.6 + 0.4 * Math.sin(bp));
    }
    // distant rumble
    const rum = new Float32Array(len);
    fillBrown(rum, rng, 1);
    new Biquad(sr).lowpass(120, 0.8).run(rum);
    for (let i = 0; i < len; i++) out[i] += rum[i] * 0.14;
    dcBlock(out);
    normalize(out, 0.82);
    this.put('bed.industry', [seamless(out, sr * 0.8)], true);
  }

  /**
   * Rain, in two genuinely different textures.
   *
   * `rain.street` is what rain sounds like when you are standing in it: a hiss
   * plus several hundred discrete droplet impacts a second, each a short
   * resonant burst — that is where its high spectral centroid comes from.
   * `rain.aerial` is the same storm heard from 300 m: the individual impacts
   * have merged and air absorption has taken the top off, so it is a smooth,
   * dark, slowly-undulating wash. The verification harness measures the
   * centroid difference; it is not a claim, it is a number.
   */
  bakeRain() {
    const sr = this.sr, len = Math.round(sr * LOOP.rain) + sr;

    // street
    {
      const ch = [];
      for (let c = 0; c < 2; c++) {
        const rng = this.rng('rain.street' + c);
        const buf = new Float32Array(len);
        fillWhite(buf, rng, 0.5);
        new Biquad(sr).highpass(900, 0.6).run(buf);
        new Biquad(sr).lowpass(9000, 0.7).run(buf);
        for (let i = 0; i < len; i++) buf[i] *= 0.55;

        // droplets
        const drops = Math.round(LOOP.rain * 520);
        const bq = new Biquad(sr);
        const grain = new Float32Array(700);
        for (let d = 0; d < drops; d++) {
          const t0 = Math.round(rng.range(0, len - 720));
          const f = rng.range(1600, 7200);
          const dec = rng.range(0.0025, 0.012);
          const a = rng.range(0.05, 0.30);
          bq.bandpass(f, rng.range(3, 9)).reset();
          const nn = Math.min(700, Math.round(dec * 5 * sr) + 16);
          for (let i = 0; i < nn; i++) grain[i] = bq.process((rng.next() * 2 - 1)) * hit(i / sr, 0.0002, dec, 2.2) * a;
          for (let i = 0; i < nn; i++) buf[t0 + i] += grain[i];
        }
        // roof / gutter roar underneath
        const roar = new Float32Array(len);
        fillBrown(roar, this.rng('rain.roar' + c), 1);
        new Biquad(sr).lowpass(420, 0.8).run(roar);
        for (let i = 0; i < len; i++) buf[i] += roar[i] * 0.085;
        dcBlock(buf);
        normalize(buf, 0.85);
        ch.push(seamless(buf, sr * 0.8));
      }
      this.put('bed.rain.street', ch, true);
    }

    // aerial
    {
      const ch = [];
      for (let c = 0; c < 2; c++) {
        const rng = this.rng('rain.aerial' + c);
        const buf = new Float32Array(len);
        fillWhite(buf, rng, 0.6);
        new Biquad(sr).bandpass(520, 0.5).run(buf);
        new Biquad(sr).lowpass(1500, 0.8).run(buf);
        new Biquad(sr).lowpass(2600, 0.7).run(buf);
        const cell = walk(len, this.rng('rain.cell' + c), 0.06, sr, 0.5);
        for (let i = 0; i < len; i++) buf[i] *= 0.5 + 0.9 * cell[i];
        normalize(buf, 0.85);
        ch.push(seamless(buf, sr * 0.8));
      }
      this.put('bed.rain.aerial', ch, true);
    }
  }

  /** Wind: a gust-driven band whose centre and Q wander, plus an edge whistle. */
  bakeWind() {
    const sr = this.sr, len = Math.round(sr * LOOP.wind) + sr;
    const ch = [];
    for (let c = 0; c < 2; c++) {
      const rng = this.rng('wind' + c);
      const src = new Float32Array(len);
      fillPink(src, rng, 1);
      const out = new Float32Array(len);
      const bp = new Biquad(sr);
      const gust = walk(len, this.rng('wind.g' + c), 0.09, sr, 0.4);
      const col = walk(len, this.rng('wind.c' + c), 0.16, sr, 0.5);
      for (let i = 0; i < len; i++) {
        if ((i & 255) === 0) bp.bandpass(lerp(180, 1100, col[i] * 0.7 + gust[i] * 0.3), lerp(0.6, 2.2, gust[i]));
        out[i] = bp.process(src[i]) * (0.18 + 1.5 * gust[i] * gust[i]);
      }
      // edge whistle around a parapet, only in the strong gusts
      const wh = new Float32Array(len);
      fillPink(wh, this.rng('wind.w' + c), 1);
      const wb = new Biquad(sr);
      for (let i = 0; i < len; i++) {
        if ((i & 255) === 0) wb.bandpass(lerp(900, 1700, col[i]), 11);
        wh[i] = wb.process(wh[i]) * Math.max(0, gust[i] - 0.55) * 2.4;
      }
      for (let i = 0; i < len; i++) out[i] += wh[i] * 0.5;
      dcBlock(out);
      normalize(out, 0.85);
      ch.push(seamless(out, sr * 1.0));
    }
    this.put('bed.wind', ch, true);
  }

  /** Night insects — sparse, dry, and the reason 02:00 is not just quiet. */
  bakeNight() {
    const sr = this.sr, len = Math.round(sr * LOOP.misc) + sr;
    const ch = [new Float32Array(len), new Float32Array(len)];
    const rng = this.rng('night');
    for (let ins = 0; ins < 9; ins++) {
      const f = rng.range(3900, 5400);
      const rate = rng.range(0.35, 0.85);
      const pan = rng.range(-1, 1);
      const gain = rng.range(0.05, 0.16);
      const lg = Math.sqrt(clamp(0.5 - pan * 0.5, 0, 1)), rg = Math.sqrt(clamp(0.5 + pan * 0.5, 0, 1));
      let t = rng.range(0, 1 / rate);
      while (t < len / sr) {
        const start = Math.round(t * sr);
        for (let k = 0; k < 4; k++) {
          const s0 = start + Math.round(k * 0.020 * sr);
          const nn = Math.round(0.009 * sr);
          for (let i = 0; i < nn; i++) {
            const j = s0 + i;
            if (j >= len) break;
            const e = hann(i / nn) * gain;
            const y = Math.sin(TAU * f * (i / sr)) * e;
            ch[0][j] += y * lg; ch[1][j] += y * rg;
          }
        }
        t += (1 / rate) * rng.range(0.75, 1.3);
      }
    }
    for (let c = 0; c < 2; c++) {
      new Biquad(sr).highpass(1200, 0.7).run(ch[c]);
      normalize(ch[c], 0.7);
      ch[c] = seamless(ch[c], sr * 0.5);
    }
    this.put('bed.night', ch, true);
  }

  /* ========================================================== one-shots == */

  /**
   * A vehicle passing the listener. Baked *without* panning or distance: the
   * runtime puts it through a PannerNode at the vehicle's real position, so the
   * Doppler-ish band sweep baked in here and the geometric pan agree.
   */
  bakePasses() {
    const sr = this.sr;
    const spec = [
      ['sfx.pass.car0', 1.15, 78, 0.45, 1250],
      ['sfx.pass.car1', 0.95, 96, 0.38, 1450],
      ['sfx.pass.car2', 1.35, 64, 0.52, 1100],
      ['sfx.pass.truck', 2.10, 38, 0.85, 820],
      ['sfx.pass.bus', 1.90, 44, 0.72, 900],
    ];
    for (const [name, dur, f0, weight, tyreF] of spec) {
      const rng = this.rng(name);
      const len = Math.round(dur * sr);
      const out = new Float32Array(len);

      // tyre / air rush: a band that opens as the vehicle arrives and closes
      const src = new Float32Array(len);
      fillWhite(src, rng, 1);
      const bp = new Biquad(sr);
      for (let i = 0; i < len; i++) {
        const u = i / len;                       // 0 → 1 across the pass
        const near = Math.exp(-Math.pow((u - 0.5) * 3.1, 2));
        if ((i & 63) === 0) bp.bandpass(tyreF * lerp(0.62, 1.45, smoothstep(0.15, 0.85, u)), lerp(1.4, 0.62, near));
        out[i] = bp.process(src[i]) * near * 0.9;
      }
      // engine: harmonics with a modest Doppler shift through the pass
      let ph = 0;
      for (let i = 0; i < len; i++) {
        const u = i / len;
        const near = Math.exp(-Math.pow((u - 0.5) * 2.6, 2));
        const dop = lerp(1.06, 0.94, smoothstep(0.30, 0.70, u));
        ph += TAU * f0 * dop / sr;
        out[i] += saw(ph, 9) * near * weight * 0.55;
      }
      if (weight > 0.6) {   // diesel clatter for the heavy vehicles
        const cl = new Float32Array(len);
        const b = new Biquad(sr).bandpass(1750, 3.0);
        for (let k = 0; k < Math.round(dur * 90); k++) {
          const t0 = Math.round(rng.range(0, len - 400));
          for (let i = 0; i < 380; i++) cl[t0 + i] += (rng.next() * 2 - 1) * hit(i / sr, 0.0003, 0.006, 3);
        }
        b.run(cl);
        for (let i = 0; i < len; i++) {
          const near = Math.exp(-Math.pow((i / len - 0.5) * 2.8, 2));
          out[i] += cl[i] * near * 0.35;
        }
      }
      new Biquad(sr).highpass(45, 0.7).run(out);
      dcBlock(out);
      normalize(out, 0.85);
      this.put(name, [out]);
    }
  }

  /** Horns: a body resonance over two detuned reed tones, lightly overdriven. */
  bakeHorns() {
    const sr = this.sr;
    const spec = [
      ['sfx.horn.car0', 0.42, 415, 508, 1500, 0.85],
      ['sfx.horn.car1', 0.28, 466, 588, 1650, 0.80],
      ['sfx.horn.car2', 0.70, 370, 440, 1350, 0.90],
      ['sfx.horn.truck', 1.15, 208, 262, 780, 1.00],
    ];
    for (const [name, dur, fa, fb, body, amp] of spec) {
      const len = Math.round(dur * sr);
      const out = new Float32Array(len);
      let pa = 0, pb = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        pa += TAU * fa / sr; pb += TAU * fb / sr;
        const env = Math.min(1, t / 0.018) * (t > dur - 0.06 ? Math.max(0, (dur - t) / 0.06) : 1)
                  * (1 - 0.12 * Math.sin(TAU * 5.5 * t));
        out[i] = softClip((saw(pa, 12) + saw(pb, 12) * 0.85) * 0.5, 2.2) * env * amp;
      }
      new Biquad(sr).peaking(body, 1.6, 8).run(out);
      new Biquad(sr).peaking(body * 2.2, 2.0, 4).run(out);
      new Biquad(sr).highpass(140, 0.7).run(out);
      normalize(out, 0.9);
      this.put(name, [out]);
    }
  }

  /** Construction: struck steel, a nail gun, and an impact wrench. */
  bakeConstruction() {
    const sr = this.sr;

    const strike = (name, modes, dur, click) => {
      const len = Math.round(dur * sr);
      const out = new Float32Array(len);
      const rng = this.rng(name);
      for (const [f, a, dec] of modes) {
        const ph0 = rng.range(0, TAU);
        for (let i = 0; i < len; i++) {
          const t = i / sr;
          out[i] += Math.sin(ph0 + TAU * f * t) * a * Math.exp(-t / dec);
        }
      }
      const cl = new Float32Array(Math.round(0.02 * sr));
      fillWhite(cl, rng, 1);
      new Biquad(sr).highpass(1800, 0.8).run(cl);
      for (let i = 0; i < cl.length; i++) out[i] += cl[i] * click * hit(i / sr, 0.0002, 0.012, 2);
      dcBlock(out);
      normalize(out, 0.9);
      this.put(name, [out]);
    };

    strike('sfx.constr.steel0', [[318, 1.0, 0.42], [792, 0.6, 0.26], [1237, 0.35, 0.18],
      [2110, 0.22, 0.12], [3580, 0.12, 0.07]], 0.75, 0.7);
    strike('sfx.constr.steel1', [[248, 1.0, 0.60], [611, 0.5, 0.34], [1490, 0.30, 0.16],
      [2740, 0.16, 0.09]], 0.95, 0.6);
    strike('sfx.constr.beam', [[96, 1.0, 1.10], [187, 0.55, 0.70], [402, 0.30, 0.35],
      [910, 0.14, 0.15]], 1.40, 0.45);

    // nail gun — pneumatic snap plus a small thud
    {
      const len = Math.round(0.22 * sr);
      const out = new Float32Array(len);
      const rng = this.rng('nail');
      const air = new Float32Array(len);
      fillWhite(air, rng, 1);
      new Biquad(sr).bandpass(3200, 1.1).run(air);
      let p = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        p += TAU * 92 / sr;
        out[i] = air[i] * hit(t, 0.0006, 0.045, 3.2) * 0.9 + Math.sin(p) * hit(t, 0.001, 0.09, 3) * 0.35;
      }
      normalize(out, 0.9);
      this.put('sfx.constr.nail', [out]);
    }

    // impact wrench / drill — a rattling motor, 1.1 s
    {
      const dur = 1.1, len = Math.round(dur * sr);
      const out = new Float32Array(len);
      const rng = this.rng('drill');
      const nz = new Float32Array(len);
      fillWhite(nz, rng, 1);
      const b = new Biquad(sr).bandpass(1750, 2.4);
      let p = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const env = Math.min(1, t / 0.03) * Math.min(1, (dur - t) / 0.08);
        const ratchet = 0.45 + 0.55 * Math.max(0, Math.sin(TAU * 26 * t));
        p += TAU * 104 / sr;
        out[i] = (saw(p, 10) * 0.5 + b.process(nz[i]) * 0.8) * env * ratchet;
      }
      new Biquad(sr).highpass(120, 0.7).run(out);
      normalize(out, 0.85);
      this.put('sfx.constr.drill', [out]);
    }
  }

  /** Birds: a swept-sine chirp with a second partial, and a trill of six. */
  bakeBirds() {
    const sr = this.sr;
    const chirp = (name, f0, f1, dur, wob, wobHz) => {
      const len = Math.round(dur * sr);
      const out = new Float32Array(len);
      let ph = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr, u = i / len;
        const f = lerp(f0, f1, Math.sin(u * Math.PI * 0.5)) * (1 + wob * Math.sin(TAU * wobHz * t));
        ph += TAU * f / sr;
        const e = Math.pow(Math.sin(Math.PI * u), 1.4);
        out[i] = (Math.sin(ph) + Math.sin(ph * 2) * 0.22) * e;
      }
      new Biquad(sr).highpass(1500, 0.7).run(out);
      normalize(out, 0.9);
      this.put(name, [out]);
      return out;
    };
    chirp('sfx.bird0', 2600, 4600, 0.075, 0.05, 55);
    chirp('sfx.bird1', 4200, 3100, 0.060, 0.09, 38);
    chirp('sfx.bird2', 3100, 3900, 0.110, 0.03, 22);
    chirp('sfx.bird3', 2200, 5200, 0.045, 0.12, 70);

    {
      const dur = 0.72, len = Math.round(dur * sr);
      const out = new Float32Array(len);
      const rng = this.rng('trill');
      let t = 0;
      while (t < dur - 0.09) {
        const start = Math.round(t * sr);
        const d = rng.range(0.035, 0.070), n = Math.round(d * sr);
        const f0 = rng.range(2600, 4200), f1 = f0 * rng.range(0.8, 1.35);
        let ph = 0;
        for (let i = 0; i < n; i++) {
          const u = i / n;
          ph += TAU * lerp(f0, f1, u) / sr;
          out[start + i] += Math.sin(ph) * Math.pow(Math.sin(Math.PI * u), 1.3) * 0.9;
        }
        t += d + rng.range(0.02, 0.06);
      }
      new Biquad(sr).highpass(1500, 0.7).run(out);
      normalize(out, 0.9);
      this.put('sfx.bird.trill', [out]);
    }
  }

  /**
   * Thunder. The near strike keeps its crack; the far one has lost everything
   * above a few hundred hertz to distance, which is the only cue that matters.
   */
  bakeThunder() {
    const sr = this.sr;
    const make = (name, dur, crack, lp0, lp1, lobes) => {
      const len = Math.round(dur * sr);
      const out = new Float32Array(len);
      const rng = this.rng(name);
      const body = new Float32Array(len);
      fillBrown(body, rng, 1);
      const lp = new Biquad(sr);
      // irregular amplitude lobes — the sound of a discharge folding over itself
      const L = [];
      for (let i = 0; i < lobes; i++) L.push({ t: rng.range(0.02, 0.85) * dur, w: rng.range(0.10, 0.45) * dur, a: rng.range(0.4, 1) });
      for (let i = 0; i < len; i++) {
        const t = i / sr, u = t / dur;
        if ((i & 127) === 0) lp.lowpass(lerp(lp0, lp1, u), 0.9);
        let e = 0.12 * (1 - u);
        for (const l of L) { const d = (t - l.t) / l.w; e += l.a * Math.exp(-d * d * 2.2); }
        out[i] = lp.process(body[i]) * Math.min(e, 1.5);
      }
      if (crack > 0) {
        const n = Math.round(0.28 * sr);
        const c = new Float32Array(n);
        fillWhite(c, rng, 1);
        new Biquad(sr).highpass(700, 0.8).run(c);
        for (let i = 0; i < n; i++) out[i] += c[i] * hit(i / sr, 0.0015, 0.16, 2.6) * crack;
      }
      dcBlock(out);
      normalize(out, 0.92);
      this.put(name, [out]);
    };
    make('sfx.thunder.near', 5.2, 0.95, 900, 110, 5);
    make('sfx.thunder.far', 6.4, 0.0, 260, 70, 4);
  }

  /**
   * Interface sounds. These are the only sounds in the module a player hears
   * hundreds of times, so they are short, band-limited and pitched — a click
   * with any broadband energy in it becomes fatiguing within a minute.
   */
  bakeUi() {
    const sr = this.sr;

    const blip = (name, freqs, dur, decay, noise = 0, shape = 1) => {
      const len = Math.round(dur * sr);
      const out = new Float32Array(len);
      const rng = this.rng(name);
      for (const [f, a, delay = 0] of freqs) {
        const off = Math.round(delay * sr);
        for (let i = 0; i + off < len; i++) {
          const t = i / sr;
          out[i + off] += Math.sin(TAU * f * t) * a * hit(t, 0.0015, decay, shape);
        }
      }
      if (noise > 0) {
        const n = Math.round(0.006 * sr);
        const c = new Float32Array(n);
        fillWhite(c, rng, 1);
        new Biquad(sr).bandpass(3400, 1.2).run(c);
        for (let i = 0; i < n; i++) out[i] += c[i] * noise * hit(i / sr, 0.0002, 0.004, 2);
      }
      new Biquad(sr).highpass(180, 0.7).run(out);
      normalize(out, 0.9);
      this.put(name, [out]);
    };

    blip('sfx.ui.click', [[2100, 1.0], [3150, 0.35]], 0.055, 0.030, 0.35, 2.4);
    blip('sfx.ui.select', [[1480, 1.0], [2220, 0.5, 0.045]], 0.16, 0.075, 0.25, 2.0);
    blip('sfx.ui.confirm', [[784, 0.9], [1175, 0.8, 0.070], [1568, 0.7, 0.140]], 0.55, 0.20, 0.15, 1.7);
    blip('sfx.ui.refuse', [[330, 0.9], [247, 0.9, 0.090]], 0.42, 0.16, 0.10, 1.8);
    blip('sfx.ui.alert', [[880, 0.8], [660, 0.8, 0.18]], 0.95, 0.34, 0.0, 1.5);

    // milestone bell — inharmonic partials, long decay, no click
    {
      const dur = 1.9, len = Math.round(dur * sr);
      const out = new Float32Array(len);
      const modes = [[523.3, 1.0, 1.5], [1046, 0.45, 0.9], [1567, 0.28, 0.55],
        [2093, 0.16, 0.35], [2673, 0.09, 0.22]];
      for (const [f, a, dec] of modes) {
        for (let i = 0; i < len; i++) {
          const t = i / sr;
          out[i] += Math.sin(TAU * f * t) * a * Math.exp(-t / dec) * Math.min(1, t / 0.004);
        }
      }
      normalize(out, 0.85);
      this.put('sfx.ui.chime', [out]);
    }
  }

  /* ================================================= impulse responses === */

  /**
   * Impulse responses grown from a comb/all-pass network.
   *
   *  `ir.canyon` — a street between two facades: discrete early reflections at
   *  the delays the geometry actually implies (2×12 m across the street, the
   *  ground, a facade 60 m ahead), then a diffuse tail with HF damping.
   *  `ir.open`   — 300 m up: no early reflections worth the name, a long, dark,
   *  very quiet tail. Swapping between them by camera height is what makes the
   *  aerial mix sound like air rather than a smaller street.
   */
  bakeIRs() {
    const sr = this.sr;

    const grow = (name, dur, taps, combs, damp, tilt, level, fb = 0.82) => {
      const len = Math.round(dur * sr);
      const ch = [];
      for (let c = 0; c < 2; c++) {
        const rng = this.rng(name + c);
        const buf = new Float32Array(len);
        // diffuse tail
        const nz = new Float32Array(len);
        fillWhite(nz, rng, 1);
        const cbs = combs.map((d, i) => new Comb(Math.round(sr * d * (c ? 1.021 : 1)), fb - i * 0.02, damp));
        const aps = [0.0053, 0.0071, 0.0111, 0.0139].map((d) => new Allpass(Math.round(sr * d * (c ? 0.987 : 1)), 0.72));
        // A real tail loses its high end as it ages: every reflection is another
        // pass through air and another absorbent surface. A comb network alone
        // produces a tail that is nearly white — which is precisely what makes a
        // synthetic reverb sound like a spring — so the damping is *swept*: the
        // one-pole cutoff falls from 8 kHz to 700 Hz across the tail.
        const damper = new OnePole(0.3);
        for (let i = 0; i < len; i++) {
          const u = i / len;
          if ((i & 63) === 0) damper.set(lerp(8000, 700, Math.pow(u, 0.55)), sr);
          // excite with a short burst, not a continuous stream: the tail must be
          // the network's own response, and it must be loudest at t = 0
          const burst = i < 0.02 * sr ? 1 : Math.exp(-((i - 0.02 * sr) / sr) * 45 * tilt);
          const x = nz[i] * burst;
          let s = 0;
          for (const cb of cbs) s += cb.process(x);
          s *= 0.25;
          for (const ap of aps) s = ap.process(s);
          buf[i] = damper.process(s) * Math.exp(-i / sr * (6.9 / dur));
        }
        new Biquad(sr).highpass(60, 0.7).run(buf);
        new Biquad(sr).peaking(2400, 1.2, -4).run(buf);
        // early reflections
        const erf = new Biquad(sr).lowpass(4200, 0.7);
        for (const [t, a, pan] of taps) {
          const j = Math.round(t * sr);
          if (j >= len) continue;
          const g = a * (c === 0 ? 1 - Math.max(0, pan) * 0.8 : 1 - Math.max(0, -pan) * 0.8);
          const n = Math.min(len - j, Math.round(0.006 * sr));
          erf.reset();
          for (let i = 0; i < n; i++) buf[j + i] += erf.process(rng.next() * 2 - 1) * g * hit(i / sr, 0.0002, 0.0022, 2);
        }
        buf[0] += 0.35;
        normalize(buf, level);
        ch.push(buf);
      }
      this.put(name, ch);
    };

    grow('ir.canyon', 1.25,
      [[0.070, 0.62, -1], [0.074, 0.58, 1], [0.021, 0.44, 0], [0.140, 0.34, -1],
        [0.150, 0.31, 1], [0.350, 0.22, 0], [0.420, 0.16, -1]],
      [0.0297, 0.0371, 0.0411, 0.0437], 0.24, 1.6, 0.62, 0.855);

    grow('ir.open', 2.10, [[0.62, 0.10, 0], [0.83, 0.07, -1]],
      [0.0531, 0.0673, 0.0741, 0.0827], 0.40, 0.9, 0.30, 0.905);
  }
}

/** Bank singletons are keyed by (sampleRate, seed) so offline renders share them. */
const _cache = new Map();
export function bankFor(sampleRate, seed) {
  const k = `${Math.round(sampleRate)}|${seed >>> 0}`;
  let b = _cache.get(k);
  if (!b) { b = new Bank(sampleRate, seed); _cache.set(k, b); }
  return b;
}
export function disposeBanks() { _cache.clear(); }

export default Bank;
