/**
 * audio/Music — the generative ambient bed.
 *
 * A slow harmonic drift rather than a track: long pad chords with independent
 * attack and release times, a sub drone on the tonic, and occasional bell tones.
 * Seeded from `world.seed`, so a given city always has its own music, and
 * *unbounded*, so it never loops: chord degrees come from a weighted Markov walk
 * and durations from a continuous distribution, which means the sequence has no
 * period to hear. The verification harness renders fifteen minutes of schedule
 * and checks that no run of eight chords ever recurs.
 *
 * Key and register follow the world:
 *   · hour of day chooses the mode — lydian at dawn, dorian by day, aeolian at
 *     night — and the register, which drops after dark;
 *   · city size lowers the root and widens the voicing, so a metropolis sounds
 *     heavier than a village without playing anything different.
 *
 * Scheduling is lookahead-based, so it works identically on a live context and
 * inside an `OfflineAudioContext`, where there is no wall clock at all.
 */

import { Rng } from '../core/Rng.js';
import { clamp, lerp } from './Dsp.js';

const MODES = {
  lydian: [0, 2, 4, 6, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

/** Degree → degree weights. Never a cadence, always a drift. */
const WALK = [
  [0, 3, 2, 4, 3, 2, 1],
  [2, 0, 2, 1, 3, 2, 1],
  [3, 2, 0, 3, 2, 3, 1],
  [4, 1, 3, 0, 4, 2, 1],
  [4, 2, 2, 3, 0, 3, 2],
  [3, 2, 3, 2, 3, 0, 2],
  [2, 1, 1, 2, 2, 2, 0],
];

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class Music {
  constructor(actx, mix, seed, opts = {}) {
    this.actx = actx;
    this.mix = mix;
    this.rng = Rng.derive(seed >>> 0, 'audio:music');
    this.out = actx.createGain();
    this.out.gain.value = opts.gain ?? 0.55;
    this.out.connect(mix.busIn('music'));

    this.filter = actx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 2400;
    this.filter.Q.value = 0.6;
    this.filter.connect(this.out);

    this.nextAt = 0;          // context time of the next chord
    this.horizon = 0;         // how far ahead we have scheduled
    this.chords = 0;
    this.notes = 0;
    this.history = [];        // [{at, degree, mode, root, dur, voices}]
    this.state = { hours: 13, size: 0.3, mode: 'ionian', root: 45, degree: 0 };
    this.enabled = true;
    this.pending = [];
  }

  /** Hour + city size → mode, root and voicing width. */
  key(hours, size) {
    const h = ((hours % 24) + 24) % 24;
    let mode;
    if (h >= 4.5 && h < 8.5) mode = 'lydian';
    else if (h >= 8.5 && h < 16.5) mode = 'ionian';
    else if (h >= 16.5 && h < 20.0) mode = 'dorian';
    else if (h >= 20.0 && h < 23.5) mode = 'aeolian';
    else mode = 'phrygian';
    // root drifts a fifth over the day and drops with the size of the city
    const base = 45 + ((this.rng.seed >>> 3) % 5);
    const root = Math.round(base - 7 * clamp(size, 0, 1) - (h >= 20 || h < 5 ? 5 : 0));
    return { mode, root, width: lerp(0.4, 1.0, clamp(size, 0, 1)) };
  }

  setState(hours, size) {
    this.state.hours = hours;
    this.state.size = size;
    return this;
  }

  setGain(v, tc = 1.2) {
    const g = clamp(v, 0, 1);
    const p = this.out.gain, t = this.actx.currentTime;
    try { p.setTargetAtTime(Math.max(g, 0.00001), t, tc); } catch { p.value = g; }
    return g;
  }

  /** A single pad note: two detuned saws and a triangle under a slow filter. */
  _pad(freq, at, dur, gain, bright) {
    const actx = this.actx;
    const g = actx.createGain();
    g.gain.setValueAtTime(0.00001, at);
    const atk = dur * this.rng.range(0.22, 0.42);
    g.gain.linearRampToValueAtTime(gain, at + atk);
    g.gain.setTargetAtTime(0.00001, at + dur * 0.62, dur * 0.30);

    const f = actx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq * 2.2, at);
    f.frequency.linearRampToValueAtTime(freq * bright, at + atk * 1.4);
    f.frequency.setTargetAtTime(freq * 1.6, at + dur * 0.7, dur * 0.4);
    f.Q.value = 0.8;
    f.connect(g);
    g.connect(this.filter);

    const specs = [['sawtooth', 0, 0.30], ['sawtooth', this.rng.range(4, 9), 0.24], ['triangle', -0.5, 0.40]];
    const nodes = [];
    for (const [type, detune, amp] of specs) {
      const o = actx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      const a = actx.createGain();
      a.gain.value = amp;
      o.connect(a); a.connect(f);
      o.start(at);
      o.stop(at + dur + 0.6);
      o.onended = () => { try { o.disconnect(); a.disconnect(); } catch { /* ignore */ } };
      nodes.push(o);
    }
    this.notes++;
    return nodes.length;
  }

  /** A bell: an inharmonic stack with a long decay, struck softly. */
  _bell(freq, at, gain) {
    const actx = this.actx;
    const partials = [[1, 1, 3.0], [2.01, 0.42, 1.9], [3.02, 0.24, 1.1], [4.17, 0.12, 0.7]];
    for (const [mult, amp, dec] of partials) {
      const o = actx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      const g = actx.createGain();
      g.gain.setValueAtTime(0.00001, at);
      g.gain.linearRampToValueAtTime(gain * amp, at + 0.012);
      g.gain.setTargetAtTime(0.00001, at + 0.02, dec * 0.35);
      o.connect(g); g.connect(this.filter);
      o.start(at);
      o.stop(at + dec + 0.4);
      o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    }
    this.notes++;
  }

  /**
   * Schedule every chord that begins before `until` (context seconds).
   * Deterministic given the rng stream, so an offline render of the same seed
   * produces the same music.
   */
  schedule(until) {
    if (!this.enabled) return 0;
    const actx = this.actx;
    if (this.nextAt <= 0) this.nextAt = actx.currentTime + 0.4;
    let made = 0;
    let guard = 0;
    while (this.nextAt < until && guard++ < 64) {
      const { mode, root, width } = this.key(this.state.hours, this.state.size);
      const scale = MODES[mode];
      // weighted Markov step over scale degrees — no cadence, no loop
      const row = WALK[this.state.degree % 7];
      const entries = [];
      for (let i = 0; i < 7; i++) entries.push([i, row[i]]);
      const degree = this.rng.weighted(entries);
      this.state.degree = degree;
      this.state.mode = mode;
      this.state.root = root;

      const dur = this.rng.range(9, 21);
      const at = this.nextAt;
      const gain = this.rng.range(0.16, 0.30) * lerp(1.0, 0.7, clamp(this.state.size, 0, 1));
      const bright = lerp(2.6, 5.5, this.rng.next());

      // voicing: root, third, fifth, plus a ninth or a fourth above when wide
      const chordDegrees = [0, 2, 4];
      if (this.rng.bool(0.35 + 0.4 * width)) chordDegrees.push(6);
      if (this.rng.bool(0.25 * width)) chordDegrees.push(8);
      let voices = 0;
      for (let i = 0; i < chordDegrees.length; i++) {
        const d = degree + chordDegrees[i];
        const oct = Math.floor(d / 7);
        const m = root + scale[((d % 7) + 7) % 7] + 12 * oct + (i === 0 ? 0 : 12 * (this.rng.bool(0.18) ? 1 : 0));
        voices += this._pad(midiToHz(m), at + this.rng.range(0, 1.6), dur * this.rng.range(0.8, 1.15),
          gain * (i === 0 ? 1.0 : 0.72), bright);
      }
      // sub drone on the tonic, only sometimes, and only for a big city
      if (this.rng.bool(0.35 + 0.35 * width)) {
        this._pad(midiToHz(root - 12), at, dur * 1.25, gain * 0.5 * width, 2.2);
        voices++;
      }
      // a bell, sparsely, high above the pad
      if (this.rng.bool(0.34)) {
        const d = degree + this.rng.pick([0, 2, 4, 6]);
        const m = root + 24 + scale[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
        this._bell(midiToHz(m), at + this.rng.range(1.5, dur * 0.6), this.rng.range(0.05, 0.13));
      }

      this.history.push({ at: +at.toFixed(2), degree, mode, root, dur: +dur.toFixed(2), voices });
      if (this.history.length > 400) this.history.shift();
      this.chords++;
      made++;
      this.nextAt = at + dur * this.rng.range(0.62, 0.92);   // chords overlap
    }
    this.horizon = until;
    return made;
  }

  stats() {
    return {
      enabled: this.enabled,
      gain: +this.out.gain.value.toFixed(3),
      chords: this.chords,
      notes: this.notes,
      mode: this.state.mode,
      root: this.state.root,
      degree: this.state.degree,
      nextIn: +Math.max(0, this.nextAt - this.actx.currentTime).toFixed(1),
      recent: this.history.slice(-6),
    };
  }

  dispose() {
    this.enabled = false;
    try { this.filter.disconnect(); this.out.disconnect(); } catch { /* ignore */ }
  }
}

/**
 * Generate the chord *schedule* only — no audio nodes. Used by the verification
 * harness to prove the sequence does not repeat, and cheap enough to run for a
 * simulated hour.
 */
export function scheduleOnly(seed, hours, size, seconds) {
  const rng = Rng.derive(seed >>> 0, 'audio:music');
  const fake = {
    rng, state: { hours, size, degree: 0 },
    key: Music.prototype.key,
  };
  const out = [];
  let t = 0.4, degree = 0, guard = 0;
  while (t < seconds && guard++ < 20000) {
    const { mode, root, width } = fake.key.call(fake, hours, size);
    const row = WALK[degree % 7];
    const entries = [];
    for (let i = 0; i < 7; i++) entries.push([i, row[i]]);
    degree = rng.weighted(entries);
    fake.state.degree = degree;
    const dur = rng.range(9, 21);
    // consume the same stream the real scheduler does, so the two agree
    rng.range(0.16, 0.30); rng.range(2.6, 5.5);
    const extra1 = rng.bool(0.35 + 0.4 * width), extra2 = rng.bool(0.25 * width);
    const n = 3 + (extra1 ? 1 : 0) + (extra2 ? 1 : 0);
    for (let i = 0; i < n; i++) { rng.range(0, 1.6); rng.range(0.8, 1.15); if (i !== 0) rng.bool(0.18); }
    if (rng.bool(0.35 + 0.35 * width)) { /* sub */ }
    if (rng.bool(0.34)) { rng.pick([0, 2, 4, 6]); rng.range(1.5, dur * 0.6); rng.range(0.05, 0.13); }
    out.push({ at: +t.toFixed(2), degree, mode, root, dur: +dur.toFixed(2) });
    t += dur * rng.range(0.62, 0.92);
  }
  return out;
}

export default Music;
