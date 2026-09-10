/**
 * audio/Mix — the bus architecture.
 *
 *   sources ─► bus.in ─► bus.tone ─► bus.gain ─┬─────────────────────► sum
 *                                              └─► bus.send ─► verb ──┘
 *
 *   sum ─► rumble filter ─► limiter (compressor) ─► ceiling (tanh shaper)
 *        ─► master gain ─► destination
 *
 * Two things here are deliberate rather than decorative:
 *
 *  · **the ceiling is a waveshaper, not a hope.** The compressor catches
 *    programme peaks musically; the tanh curve after it makes "no sample leaves
 *    this graph above 1.0" a property of the topology. The offline harness
 *    asserts it.
 *  · **the reverb is two impulse responses cross-faded by altitude.** A street
 *    is a canyon with hard early reflections; 300 m up there is no room at all.
 *    One convolver with a switched buffer would click, so both live and the
 *    crossfade is a pair of gains.
 *
 * Everything is created against a `BaseAudioContext`, so the identical graph is
 * built by the live `AudioContext` and by the `OfflineAudioContext` the
 * verification harness renders through. That is what makes the numbers in the
 * report describe the thing you actually hear.
 */

import { softClipCurve, dbToLin, clamp } from './Dsp.js';

export const BUSES = [
  { key: 'ambience', label: 'Ambience', gain: 0.90, send: 0.26, color: '#3987e5' },
  { key: 'traffic', label: 'Traffic', gain: 0.85, send: 0.20, color: '#d95926' },
  { key: 'weather', label: 'Weather', gain: 0.95, send: 0.16, color: '#199e70' },
  { key: 'ui', label: 'Interface', gain: 0.80, send: 0.05, color: '#c98500' },
  { key: 'music', label: 'Music', gain: 0.55, send: 0.12, color: '#8f7ae0' },
];

export class Mix {
  /**
   * @param {BaseAudioContext} actx
   * @param {Bank} bank
   * @param {{analysers?:boolean, reverb?:boolean, master?:number}} opts
   */
  constructor(actx, bank, opts = {}) {
    this.actx = actx;
    this.bank = bank;
    this.useAnalysers = opts.analysers !== false;
    this.useReverb = opts.reverb !== false;

    const out = opts.destination || actx.destination;

    /* ---- master chain, built output-first so nothing is ever unconnected -- */
    this.masterGain = actx.createGain();
    this.masterGain.gain.value = clamp(opts.master ?? 0.85, 0, 1);
    this.masterGain.connect(out);

    this.ceiling = actx.createWaveShaper();
    this.ceiling.curve = softClipCurve(4096, 1.55);
    this.ceiling.oversample = '2x';
    this.ceiling.connect(this.masterGain);

    this.limiter = actx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.18;
    this.limiter.connect(this.ceiling);

    // nothing below 24 Hz is audible on any speaker a player owns, and it eats
    // limiter headroom — so it never gets into the limiter
    this.rumble = actx.createBiquadFilter();
    this.rumble.type = 'highpass';
    this.rumble.frequency.value = 26;
    this.rumble.Q.value = 0.6;
    this.rumble.connect(this.limiter);

    this.sum = actx.createGain();
    this.sum.gain.value = 1;
    this.sum.connect(this.rumble);

    this.masterAnalyser = null;
    if (this.useAnalysers && actx.createAnalyser) {
      this.masterAnalyser = actx.createAnalyser();
      this.masterAnalyser.fftSize = 2048;
      this.masterAnalyser.smoothingTimeConstant = 0.72;
      this.masterGain.connect(this.masterAnalyser);
    }

    /* --------------------------------------------------------- reverb ---- */
    this.verb = null;
    if (this.useReverb && actx.createConvolver) {
      const inGain = actx.createGain();
      inGain.gain.value = 1;
      const ret = actx.createGain();
      ret.gain.value = 0.9;
      ret.connect(this.sum);

      const mk = (name, g) => {
        const cv = actx.createConvolver();
        cv.normalize = true;
        const buf = bank && bank.buffer(actx, name);
        if (buf) cv.buffer = buf;
        const gain = actx.createGain();
        gain.gain.value = g;
        inGain.connect(cv);
        cv.connect(gain);
        gain.connect(ret);
        return { cv, gain };
      };
      // a gentle pre-delay keeps the tail behind the dry signal
      const pre = actx.createDelay(0.2);
      pre.delayTime.value = 0.018;
      this.verb = {
        input: inGain, pre, ret,
        canyon: mk('ir.canyon', 1),
        open: mk('ir.open', 0),
      };
    }

    /* ----------------------------------------------------------- buses --- */
    this.buses = new Map();
    for (const def of BUSES) {
      const input = actx.createGain();
      input.gain.value = 1;

      const tone = actx.createBiquadFilter();
      tone.type = 'highshelf';
      tone.frequency.value = 3200;
      tone.gain.value = 0;

      const gain = actx.createGain();
      gain.gain.value = def.gain;

      input.connect(tone);
      tone.connect(gain);
      gain.connect(this.sum);

      let send = null;
      if (this.verb) {
        send = actx.createGain();
        send.gain.value = def.send;
        gain.connect(send);
        send.connect(this.verb.input);
      }

      let analyser = null;
      if (this.useAnalysers && actx.createAnalyser) {
        analyser = actx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.6;
        gain.connect(analyser);
      }

      this.buses.set(def.key, {
        key: def.key, label: def.label, color: def.color,
        designGain: def.gain, designSend: def.send,
        input, tone, gain, send, analyser,
        muted: false, userGain: 1, level: 0, peak: 0,
      });
    }

    this._scratch = new Float32Array(1024);
    this._spec = this.masterAnalyser ? new Float32Array(this.masterAnalyser.frequencyBinCount) : new Float32Array(0);
  }

  /** Where a sound of a given kind plugs in. Unknown kinds land on ambience. */
  busIn(key) {
    const b = this.buses.get(key) || this.buses.get('ambience');
    return b.input;
  }

  bus(key) { return this.buses.get(key) || null; }

  /** User-facing per-bus trim, multiplied into the design gain. */
  setBusGain(key, v, ramp = 0.08) {
    const b = this.buses.get(key);
    if (!b) return 0;
    b.userGain = clamp(v, 0, 2);
    this._applyBus(b, ramp);
    return b.userGain;
  }

  _applyBus(b, ramp = 0.05) {
    const target = b.muted ? 0.0001 : b.designGain * b.userGain;
    const p = b.gain.gain, t = this.actx.currentTime;
    try {
      p.cancelScheduledValues(t);
      p.setTargetAtTime(Math.max(target, 0.0001), t, Math.max(ramp, 0.005));
    } catch { p.value = target; }
  }

  muteBus(key, on) {
    const b = this.buses.get(key);
    if (!b) return false;
    b.muted = !!on;
    this._applyBus(b, 0.05);
    return b.muted;
  }

  setMaster(v, ramp = 0.05) {
    const g = clamp(v, 0, 1);
    const p = this.masterGain.gain, t = this.actx.currentTime;
    try {
      p.cancelScheduledValues(t);
      p.setTargetAtTime(Math.max(g, 0.0001), t, ramp);
    } catch { p.value = g; }
    return g;
  }

  /** 0 = street canyon, 1 = open air. Cross-fades the two impulse responses. */
  setSpace(t, ramp = 1.2) {
    if (!this.verb) return 0;
    const u = clamp(t, 0, 1);
    const now = this.actx.currentTime;
    const set = (p, v) => {
      try { p.cancelScheduledValues(now); p.setTargetAtTime(Math.max(v, 0.0001), now, ramp); }
      catch { p.value = v; }
    };
    set(this.verb.canyon.gain.gain, 1 - u);
    set(this.verb.open.gain.gain, u * 0.85);
    return u;
  }

  /** Overall wet amount — rain and open air want more, a dry noon street less. */
  setReverb(amount, ramp = 0.6) {
    if (!this.verb) return 0;
    const v = clamp(amount, 0, 1.5);
    const p = this.verb.ret.gain, t = this.actx.currentTime;
    try { p.cancelScheduledValues(t); p.setTargetAtTime(Math.max(v, 0.0001), t, ramp); }
    catch { p.value = v; }
    return v;
  }

  /** Per-bus tone tilt in dB at 3.2 kHz — how altitude eats the high end. */
  setBusTilt(key, db, ramp = 0.4) {
    const b = this.buses.get(key);
    if (!b) return 0;
    const p = b.tone.gain, t = this.actx.currentTime;
    try { p.cancelScheduledValues(t); p.setTargetAtTime(db, t, ramp); }
    catch { p.value = db; }
    return db;
  }

  /* ------------------------------------------------------------ meters -- */

  /** RMS + peak per bus, read from the analysers. Allocation-free. */
  readLevels() {
    const s = this._scratch;
    for (const b of this.buses.values()) {
      if (!b.analyser) { b.level = 0; continue; }
      const n = Math.min(s.length, b.analyser.fftSize);
      b.analyser.getFloatTimeDomainData(s);
      let acc = 0, pk = 0;
      for (let i = 0; i < n; i++) { const v = s[i]; acc += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
      b.level = Math.sqrt(acc / n);
      b.peak = Math.max(pk, b.peak * 0.92);
    }
    if (this.masterAnalyser) {
      const n = Math.min(s.length, this.masterAnalyser.fftSize);
      this.masterAnalyser.getFloatTimeDomainData(s);
      let acc = 0, pk = 0;
      for (let i = 0; i < n; i++) { const v = s[i]; acc += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
      this.masterLevel = Math.sqrt(acc / n);
      this.masterPeak = Math.max(pk, (this.masterPeak || 0) * 0.92);
    }
    return this;
  }

  /** Linear magnitude spectrum of the master bus, or null when not running. */
  readSpectrum() {
    if (!this.masterAnalyser) return null;
    const n = this.masterAnalyser.frequencyBinCount;
    if (this._spec.length !== n) this._spec = new Float32Array(n);
    this.masterAnalyser.getFloatFrequencyData(this._spec);   // dBFS
    return this._spec;
  }

  /** Gain reduction the limiter is applying, in dB (≤ 0). */
  reduction() { return this.limiter ? this.limiter.reduction : 0; }

  describe() {
    return {
      master: +this.masterGain.gain.value.toFixed(3),
      limiter: {
        threshold: this.limiter.threshold.value, ratio: this.limiter.ratio.value,
        knee: this.limiter.knee.value, attack: this.limiter.attack.value,
        release: this.limiter.release.value, reductionDb: +this.reduction().toFixed(2),
      },
      ceiling: 'tanh soft clip, 2× oversampled',
      reverb: this.verb ? {
        canyon: +this.verb.canyon.gain.gain.value.toFixed(3),
        open: +this.verb.open.gain.gain.value.toFixed(3),
        wet: +this.verb.ret.gain.value.toFixed(3),
      } : null,
      buses: [...this.buses.values()].map((b) => ({
        key: b.key, label: b.label, color: b.color,
        gain: +b.gain.gain.value.toFixed(3),
        tiltDb: +b.tone.gain.value.toFixed(2),
        send: b.send ? +b.send.gain.value.toFixed(3) : 0,
        muted: b.muted,
        level: +(b.level || 0).toFixed(5),
        peak: +(b.peak || 0).toFixed(5),
      })),
    };
  }

  dispose() {
    try {
      for (const b of this.buses.values()) {
        b.input.disconnect(); b.tone.disconnect(); b.gain.disconnect();
        b.send?.disconnect(); b.analyser?.disconnect();
      }
      this.sum.disconnect(); this.rumble.disconnect(); this.limiter.disconnect();
      this.ceiling.disconnect(); this.masterGain.disconnect();
      if (this.verb) {
        this.verb.input.disconnect(); this.verb.ret.disconnect();
        this.verb.canyon.cv.disconnect(); this.verb.canyon.gain.disconnect();
        this.verb.open.cv.disconnect(); this.verb.open.gain.disconnect();
      }
    } catch { /* a closed context throws on disconnect; nothing to do */ }
    this.buses.clear();
  }
}

export const dB = dbToLin;
export default Mix;
