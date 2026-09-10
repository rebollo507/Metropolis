/**
 * audio/Voices — the one-shot voice pool.
 *
 * Every discrete sound in the city (a car pass, a horn, a hammer, a click) is
 * played through a *recycled* voice: a persistent panner → filter → gain chain
 * that is reused for the life of the session. Only the buffer source itself is
 * created per trigger, because the Web Audio spec makes source nodes one-shot;
 * everything else that would otherwise be allocated, connected and garbage
 * collected forty times a minute is not.
 *
 * The pool is hard-capped. When every voice is busy the quietest one is stolen
 * with a 15 ms fade rather than a hard stop, which is inaudible and cannot
 * click. A city that runs out of voices gets quieter, never crackly.
 */

import { clamp } from './Dsp.js';

export class Voice {
  constructor(actx, id) {
    this.id = id;
    this.actx = actx;
    this.busy = false;
    this.startedAt = -1;
    this.endsAt = -1;
    this.gainValue = 0;
    this.label = '';
    this.busKey = 'ambience';
    this.src = null;

    this.gain = actx.createGain();
    this.gain.gain.value = 0.0001;

    this.filter = actx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 20000;
    this.filter.Q.value = 0.7;
    this.filter.connect(this.gain);

    this.panner = null;
    if (actx.createPanner) {
      const p = actx.createPanner();
      p.panningModel = 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = 12;
      p.maxDistance = 800;
      p.rolloffFactor = 1.15;
      this.panner = p;
      this.gain.connect(p);
      this.out = p;
    } else {
      this.out = this.gain;
    }
    this.connectedTo = null;
  }

  _route(dest) {
    if (this.connectedTo === dest) return;
    try { this.out.disconnect(); } catch { /* not connected yet */ }
    try { this.out.connect(dest); this.connectedTo = dest; } catch { /* ignore */ }
  }

  setPos(x, y, z) {
    const p = this.panner;
    if (!p) return;
    if (p.positionX) {
      const t = this.actx.currentTime;
      try { p.positionX.setValueAtTime(x, t); p.positionY.setValueAtTime(y, t); p.positionZ.setValueAtTime(z, t); return; }
      catch { /* legacy path below */ }
    }
    try { p.setPosition(x, y, z); } catch { /* ignore */ }
  }

  /** Move the voice along a straight line during playback — a real pass-by. */
  glide(x0, y0, z0, x1, y1, z1, dur) {
    const p = this.panner;
    if (!p || !p.positionX) { this.setPos(x0, y0, z0); return; }
    const t = this.actx.currentTime;
    try {
      p.positionX.setValueAtTime(x0, t); p.positionX.linearRampToValueAtTime(x1, t + dur);
      p.positionY.setValueAtTime(y0, t); p.positionY.linearRampToValueAtTime(y1, t + dur);
      p.positionZ.setValueAtTime(z0, t); p.positionZ.linearRampToValueAtTime(z1, t + dur);
    } catch { this.setPos(x0, y0, z0); }
  }

  release(fade = 0.015) {
    if (!this.busy) return;
    const t = this.actx.currentTime;
    try {
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setValueAtTime(Math.max(this.gain.gain.value, 0.00001), t);
      this.gain.gain.linearRampToValueAtTime(0.00001, t + fade);
      this.src?.stop(t + fade + 0.005);
    } catch { /* already stopped */ }
    this.busy = false;
  }
}

export class VoicePool {
  constructor(actx, bank, mix, opts = {}) {
    this.actx = actx;
    this.bank = bank;
    this.mix = mix;
    this.max = opts.max || 24;
    this.voices = [];
    for (let i = 0; i < this.max; i++) this.voices.push(new Voice(actx, i));
    this.played = 0;
    this.stolen = 0;
    this.refused = 0;
    this.active = 0;
    this.lastAt = new Map();     // per-kind rate limiting
  }

  /**
   * Free voice, or the quietest busy one.
   *
   * A voice whose sound has already finished counts as free even if its
   * `onended` has not been delivered — the callback is a courtesy, not a
   * guarantee, and a pool that waits for it silently shrinks over a long
   * session (and cannot be tested against a simulated clock at all).
   */
  _take() {
    const now = this.actx.currentTime;
    let free = null;
    for (const v of this.voices) {
      if (!v.busy || v.endsAt <= now) { free = v; break; }
    }
    if (free) { free.busy = false; return free; }
    let worst = null;
    for (const v of this.voices) if (!worst || v.gainValue < worst.gainValue) worst = v;
    if (worst) { worst.release(0.015); this.stolen++; }
    return worst;
  }

  /** Rate limit by kind, in seconds. Returns false when the call should drop. */
  allow(kind, minGap) {
    const t = this.actx.currentTime;
    const last = this.lastAt.get(kind);
    if (last !== undefined && t - last < minGap) return false;
    this.lastAt.set(kind, t);
    return true;
  }

  /**
   * @param {string} buffer  a Bank entry name
   * @param {object} o {bus, gain, rate, pos:[x,y,z], to:[x,y,z], filter:{type,f,q},
   *                    attack, when, label}
   */
  play(buffer, o = {}) {
    const rec = this.bank.get(buffer);
    if (!rec) return null;
    const v = this._take();
    if (!v) { this.refused++; return null; }

    const actx = this.actx;
    const t = actx.currentTime + (o.when || 0);
    const src = actx.createBufferSource();
    src.buffer = this.bank.buffer(actx, buffer);
    src.playbackRate.value = clamp(o.rate || 1, 0.25, 4);

    if (o.filter) {
      v.filter.type = o.filter.type || 'lowpass';
      v.filter.frequency.setValueAtTime(clamp(o.filter.f || 20000, 30, 20000), t);
      v.filter.Q.setValueAtTime(o.filter.q || 0.7, t);
    } else {
      v.filter.type = 'lowpass';
      v.filter.frequency.setValueAtTime(20000, t);
      v.filter.Q.setValueAtTime(0.7, t);
    }

    if (v.panner) {
      v.panner.refDistance = o.ref || 12;
      v.panner.maxDistance = o.max || 800;
      v.panner.rolloffFactor = o.rolloff || 1.15;
    }
    const dur = (rec.dur / src.playbackRate.value);
    if (o.pos && o.to) v.glide(o.pos[0], o.pos[1], o.pos[2], o.to[0], o.to[1], o.to[2], dur);
    else if (o.pos) v.setPos(o.pos[0], o.pos[1], o.pos[2]);
    else v.setPos(0, 0, 0);

    const g = clamp(o.gain === undefined ? 0.5 : o.gain, 0, 4);
    const atk = o.attack || 0.004;
    try {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(0.00001, t);
      v.gain.gain.linearRampToValueAtTime(Math.max(g, 0.00002), t + atk);
    } catch { v.gain.gain.value = g; }

    v._route(this.mix.busIn(o.bus || 'ambience'));
    src.connect(v.filter);

    v.busy = true;
    v.src = src;
    v.gainValue = g;
    v.label = o.label || buffer;
    v.busKey = o.bus || 'ambience';
    v.startedAt = t;
    v.endsAt = t + dur;
    this.active++;
    this.played++;

    src.onended = () => {
      if (v.src === src) { v.busy = false; v.gainValue = 0; v.src = null; }
      this.active = Math.max(0, this.active - 1);
      try { src.disconnect(); } catch { /* ignore */ }
    };
    try { src.start(t); } catch { v.busy = false; this.active = Math.max(0, this.active - 1); return null; }
    return v;
  }

  /** How many voices are sounding right now (recomputed, not trusted). */
  count() {
    const t = this.actx.currentTime;
    let n = 0;
    for (const v of this.voices) if (v.busy && v.endsAt > t) n++;
    return n;
  }

  live() {
    const t = this.actx.currentTime;
    const out = [];
    for (const v of this.voices) {
      if (!v.busy || v.endsAt <= t) continue;
      out.push({ id: v.id, label: v.label, bus: v.busKey, gain: v.gainValue, remain: +(v.endsAt - t).toFixed(2) });
    }
    return out;
  }

  stats() {
    return { max: this.max, active: this.count(), played: this.played, stolen: this.stolen, refused: this.refused };
  }

  stopAll() { for (const v of this.voices) v.release(0.01); }

  dispose() {
    this.stopAll();
    for (const v of this.voices) {
      try { v.gain.disconnect(); v.filter.disconnect(); v.panner?.disconnect(); } catch { /* ignore */ }
    }
    this.voices.length = 0;
  }
}

export default VoicePool;
