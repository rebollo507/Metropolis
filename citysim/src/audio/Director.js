/**
 * audio/Director — the live audio engine.
 *
 * Owns the `AudioContext` lifecycle and everything hanging off it. Three rules
 * shape this file:
 *
 *  1. **Nothing is created until a user gesture.** Browsers refuse to start an
 *     `AudioContext` without one, and a suspended context that is built anyway
 *     logs warnings and burns memory. So the graph is built on the first
 *     pointer or key event, or on an explicit `start()`.
 *  2. **Absence is a supported state.** No `AudioContext` constructor, a context
 *     that throws, a blocked autoplay policy, a headless harness with
 *     `--mute-audio`: all of them leave the module in `unavailable` or
 *     `suspended`, every public method still answers, and nothing throws. That
 *     is the harness's condition, so it is tested on every shot.
 *  3. **The hot path does not allocate.** `update()` moves the listener and,
 *     four times a second, re-samples the world and re-applies the mix. Event
 *     scheduling uses fixed accumulators. The only per-event allocation is the
 *     buffer source node the Web Audio spec forces on us, and its chain is
 *     pooled (see `Voices.js`).
 */

import { Rng } from '../core/Rng.js';
import { clamp, lerp, linToDb } from './Dsp.js';
import { bankFor } from './Bank.js';
import { Mix, BUSES } from './Mix.js';
import { Beds, mixFromState, ratesFromState } from './Beds.js';
import { VoicePool } from './Voices.js';
import { Sfx } from './Sfx.js';
import { Music } from './Music.js';
import { Field } from './Field.js';

const CtxClass = (typeof window !== 'undefined')
  ? (window.AudioContext || window.webkitAudioContext || null)
  : null;

export class Director {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.log = ctx.log;
    this.seed = ctx.world.seed >>> 0;
    this.rng = Rng.derive(this.seed, 'audio:director');

    this.available = !!CtxClass;
    this.state = this.available ? 'idle' : 'unavailable';
    this.reason = this.available ? null : 'AudioContext is not implemented in this browser';

    this.actx = null;
    this.bank = null;
    this.mix = null;
    this.beds = null;
    this.pool = null;
    this.sfx = null;
    this.music = null;

    this.field = new Field(ctx);
    this.master = clamp(opts.volume ?? 0.85, 0, 1);
    this.muted = false;
    this.musicGain = 0.55;

    this.elapsed = 0;
    this._nextSample = 0;
    this._nextMusic = 0;
    this._nextMeter = 0;
    this._ev = { pass: 0, horn: 0, bird: 0, construction: 0, thunder: 0, industry: 0 };
    this._evGate = { pass: 1, horn: 1, bird: 1, construction: 1, thunder: 1, industry: 1 };
    this.updateMs = 0;
    this._updEma = 0;
    this.lastMix = null;
    this.startMs = 0;
    this.milestone = 0;

    this._gesture = null;
    this._armed = false;
  }

  /* ------------------------------------------------------------- start --- */

  /** Arm the one-shot gesture listeners. Never throws, even without a DOM. */
  arm() {
    if (this._armed || !this.available || typeof window === 'undefined') return this;
    const go = () => { this.disarm(); this.start('gesture'); };
    this._gesture = go;
    try {
      for (const t of ['pointerdown', 'keydown', 'touchstart']) {
        window.addEventListener(t, go, { once: true, passive: true });
      }
      this._armed = true;
    } catch { /* a DOM-less host: the module simply stays idle */ }
    return this;
  }

  disarm() {
    if (!this._armed || !this._gesture) return;
    try {
      for (const t of ['pointerdown', 'keydown', 'touchstart']) {
        window.removeEventListener(t, this._gesture);
      }
    } catch { /* ignore */ }
    this._armed = false;
  }

  /**
   * Build the graph. Safe to call repeatedly; safe to call with autoplay
   * blocked (the context simply stays suspended and everything else is ready).
   */
  start(why = 'explicit') {
    if (!this.available) return false;
    if (this.actx) { this._resume(); return true; }
    const t0 = performance.now();
    try {
      this.actx = new CtxClass({ latencyHint: 'interactive' });
    } catch (err) {
      this.state = 'unavailable';
      this.reason = 'AudioContext constructor threw: ' + (err && err.message);
      this.log?.warn?.('audio unavailable —', this.reason);
      return false;
    }

    // Resume inside the gesture's sticky activation window, before the bake.
    this._resume();
    this.bank = bankFor(this.actx.sampleRate, this.seed);
    if (!this.bank.built && typeof requestAnimationFrame === 'function' && why !== 'sync') {
      this.state = 'preparing';
      this._bakeStaged(() => this._buildGraph(why, t0));
      return true;
    }
    this.bank.build();
    return this._buildGraph(why, t0);
  }

  /**
   * Walk the bake one step per animation frame. The whole library is ~2.2 s of
   * DSP on this box; doing it in one block on the first click would drop two
   * seconds of frames, so it is spread over ~15 of them and the graph is built
   * when the last one lands.
   */
  _bakeStaged(done) {
    const steps = this.bank.stepList();
    let i = 0;
    // Idle callbacks rather than animation frames: on a software renderer the
    // composed city runs at ~1 fps, and one step per *frame* would mean fifteen
    // seconds of silence. `requestIdleCallback` with a timeout makes progress
    // between frames however slow they are, and still yields to rendering.
    const schedule = (typeof requestIdleCallback === 'function')
      ? (fn) => requestIdleCallback(fn, { timeout: 200 })
      : (fn) => setTimeout(fn, 0);
    const tick = () => {
      const t0 = performance.now();
      do { this.bank.runStep(i++); } while (i < steps.length && performance.now() - t0 < 6);
      if (i < steps.length) schedule(tick);
      else done();
    };
    schedule(tick);
  }

  _buildGraph(why, t0) {
    try {
      this.mix = new Mix(this.actx, this.bank, { master: this.muted ? 0 : this.master });
      this.beds = new Beds(this.actx, this.bank, this.mix).start(0);
      this.pool = new VoicePool(this.actx, this.bank, this.mix, { max: this.opts.voices || 24 });
      this.sfx = new Sfx(this.pool, Rng.derive(this.seed, 'audio:sfx'), this.log);
      this.music = new Music(this.actx, this.mix, this.seed, { gain: this.musicGain });
      this._applyListener(true);
      this.applyMix(true);
      // …then walk every bed back to silence and ramp it up, so the city fades
      // in over ~2 s instead of arriving as a block of noise on the first click.
      try {
        for (const l of this.beds.layers.values()) {
          const g = l.gainValue;
          l.gain.gain.value = 0.00001;
          l.set(g, 1.2);
        }
      } catch { /* a context that refuses ramps still plays */ }
      this.state = this.actx.state === 'running' ? 'running' : this.actx.state;
      this.startMs = performance.now() - t0;
      this.log?.info?.(
        `started (${why}) — ${this.actx.sampleRate} Hz, ${this.bank.stats().entries} baked sources, `
        + `${this.bank.stats().megabytes} MB, bake ${this.bank.stats().bakeMs} ms, build ${this.startMs.toFixed(0)} ms`
      );
    } catch (err) {
      this.state = 'failed';
      this.reason = 'graph build failed: ' + (err && err.message);
      this.log?.warn?.('audio graph failed, continuing silently —', err && err.message);
      this._teardown();
      return false;
    }
    this._resume();
    return true;
  }

  _resume() {
    if (!this.actx) return;
    if (this.actx.state === 'suspended' && this.actx.resume) {
      this.actx.resume().then(
        () => { this.state = this.actx.state; },
        () => { this.state = 'suspended'; }
      );
    }
    this.state = this.actx.state;
  }

  _teardown() {
    try { this.music?.dispose(); } catch { /* ignore */ }
    try { this.pool?.dispose(); } catch { /* ignore */ }
    try { this.beds?.stop(); } catch { /* ignore */ }
    try { this.mix?.dispose(); } catch { /* ignore */ }
    this.music = this.pool = this.beds = this.mix = null;
  }

  get running() { return !!this.actx && this.actx.state === 'running'; }

  /* -------------------------------------------------------------- mix ---- */

  /** Push the current world state through the mix. Cheap; called at 4 Hz. */
  applyMix(instant = false) {
    const s = this.field.state;
    const m = mixFromState(s);
    this.lastMix = m;
    if (!this.mix) return m;
    this.beds.apply(m, instant);
    for (const b of BUSES) {
      this.mix.setBusGain(b.key, (m.buses[b.key] ?? 1) * (b.key === 'music' ? this.musicGain / 0.55 : 1), instant ? 0.01 : 0.5);
      this.mix.setBusTilt(b.key, m.tilt[b.key] ?? 0, instant ? 0.01 : 0.8);
    }
    this.mix.setSpace(m.space, instant ? 0.01 : 1.5);
    this.mix.setReverb(m.reverb, instant ? 0.01 : 0.8);
    this.music?.setState(s.hours, s.city.size);
    return m;
  }

  _applyListener(instant = false) {
    if (!this.actx) return;
    const l = this.actx.listener;
    const s = this.field.state.listener;
    const t = this.actx.currentTime;
    const tc = instant ? 0.001 : 0.09;
    if (l.positionX) {
      try {
        l.positionX.setTargetAtTime(s.x, t, tc);
        l.positionY.setTargetAtTime(s.y, t, tc);
        l.positionZ.setTargetAtTime(s.z, t, tc);
        l.forwardX.setTargetAtTime(s.fx, t, tc);
        l.forwardY.setTargetAtTime(s.fy, t, tc);
        l.forwardZ.setTargetAtTime(s.fz, t, tc);
        l.upX.setTargetAtTime(0, t, tc);
        l.upY.setTargetAtTime(1, t, tc);
        l.upZ.setTargetAtTime(0, t, tc);
        return;
      } catch { /* fall through */ }
    }
    try {
      l.setPosition(s.x, s.y, s.z);
      l.setOrientation(s.fx, s.fy, s.fz, 0, 1, 0);
    } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------ update --- */

  update(dt, elapsed) {
    this.elapsed = elapsed;
    const t0 = performance.now();

    // the world sample is cheap and gated inside Field; the listener is per frame
    this.field.sample(elapsed, false);
    if (this.actx) {
      this._applyListener(false);
      if (elapsed >= this._nextSample) {
        this._nextSample = elapsed + 0.25;
        this.applyMix(false);
      }
      if (this.running) {
        this._events(Math.min(dt, 0.25));
        if (elapsed >= this._nextMusic) {
          this._nextMusic = elapsed + 1.0;
          this.music?.schedule(this.actx.currentTime + 6);
        }
      }
      if (elapsed >= this._nextMeter) {
        this._nextMeter = elapsed + 0.05;
        this.mix?.readLevels();
      }
    }

    const ms = performance.now() - t0;
    this._updEma = this._updEma * 0.92 + ms * 0.08;
    this.updateMs = this._updEma;
  }

  /** Poisson-ish event scheduling from the published rates. */
  _events(dt) {
    if (!this.sfx) return;
    const s = this.field.state;
    const r = ratesFromState(s);
    const acc = this._ev, gate = this._evGate;
    const step = (key, rate, fire) => {
      if (rate <= 0) { acc[key] = 0; return; }
      acc[key] += rate * dt;
      if (acc[key] >= gate[key]) {
        acc[key] = 0;
        gate[key] = this.rng.range(0.55, 1.7);
        fire();
      }
    };

    const L = s.listener;
    step('pass', r.pass, () => this._vehiclePass(L));
    step('horn', r.horn, () => this._horn(L));
    step('bird', r.bird, () => {
      const g = s.sources[2];
      const w = g.weight > 0.02 ? g : null;
      const x = w ? w.x : L.x + this.rng.range(-30, 30);
      const z = w ? w.z : L.z + this.rng.range(-30, 30);
      const y = (w ? w.y : L.y) + this.rng.range(2, 10);
      this.sfx.bird(x, y, z, Math.hypot(x - L.x, z - L.z));
    });
    step('construction', r.construction, () => {
      // only if something is actually being built nearby
      const b = this.ctx.get('buildings');
      if (!b || !b.buildingsNear) return;
      const list = b.buildingsNear([L.x, 0, L.z], 180);
      if (!list.length) return;
      const pick = list[this.rng.int(list.length)];
      const d = Math.hypot(pick.pos[0] - L.x, pick.pos[2] - L.z);
      this.sfx.construction(pick.pos[0], pick.pos[1] + 2, pick.pos[2], d);
    });
    step('industry', r.industry, () => {
      const p = s.sources[0];
      this.sfx.industry(p.x, p.y, p.z, Math.hypot(p.x - L.x, p.z - L.z));
    });
    step('thunder', r.thunder, () => this.sfx.thunder(this.rng.bool(0.35), [L.x, L.y, L.z]));
  }

  _vehiclePass(L) {
    const traffic = this.ctx.get('traffic');
    if (!traffic || !traffic.vehiclesNear) return;
    let list;
    try { list = traffic.vehiclesNear([L.x, 0, L.z], 70); } catch { return; }
    if (!list || !list.length) return;
    // prefer something close and moving — a parked car does not make a pass
    let best = null, bestScore = -1;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const d = Math.hypot(v.x - L.x, v.z - L.z);
      const score = (0.4 + Math.min(v.speed || 0, 18) / 18) / (1 + d / 40) * this.rng.range(0.6, 1.4);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    if (!best) return;
    this.sfx.vehiclePass(best, Math.hypot(best.x - L.x, best.z - L.z), best.speed || 6);
  }

  _horn(L) {
    const traffic = this.ctx.get('traffic');
    let v = null;
    if (traffic && traffic.vehiclesNear) {
      try {
        const list = traffic.vehiclesNear([L.x, 0, L.z], 110);
        for (const c of list) if (!c.speed || c.speed < 1.5) { v = c; break; }
        if (!v && list.length) v = list[this.rng.int(list.length)];
      } catch { /* ignore */ }
    }
    const x = v ? v.x : L.x + this.rng.range(-40, 40);
    const z = v ? v.z : L.z + this.rng.range(-40, 40);
    const y = v ? v.y : L.y;
    this.sfx.horn(x, y, z, Math.hypot(x - L.x, z - L.z), this.rng.bool(0.18));
  }

  /* -------------------------------------------------------- game events -- */

  onBuildingsSpawned(ids) {
    if (!this.sfx || !this.running) return;
    const b = this.ctx.get('buildings');
    const L = this.field.state.listener;
    let x = L.x, y = L.y, z = L.z, d = 40;
    if (b && b.buildingsNear && ids && ids.length) {
      const list = b.buildingsNear([L.x, 0, L.z], 260);
      const set = new Set(ids);
      const hit = list.find((r) => set.has(r.id)) || null;
      if (!hit) return;                       // built out of earshot: say nothing
      x = hit.pos[0]; y = hit.pos[1] + 2; z = hit.pos[2];
      d = Math.hypot(x - L.x, z - L.z);
    }
    this.sfx.construction(x, y, z, d);
  }

  onTool(kind) { if (this.sfx && this.running) this.sfx.ui(kind); }

  onAlert(level) { if (this.sfx && this.running) this.sfx.alert(level); }

  /** Population milestones are the one "good news" cue the city gets. */
  checkMilestone(population) {
    const steps = [500, 1000, 2500, 5000, 10000, 25000, 50000];
    let reached = 0;
    for (const s of steps) if (population >= s) reached = s;
    if (reached > this.milestone) {
      this.milestone = reached;
      if (this.sfx && this.running) this.sfx.ui('chime');
      return reached;
    }
    this.milestone = Math.max(this.milestone, reached);
    return 0;
  }

  /* ------------------------------------------------------------- public -- */

  setVolume(v) {
    this.master = clamp(v, 0, 1);
    if (this.mix && !this.muted) this.mix.setMaster(this.master);
    return this.master;
  }

  mute(on) {
    this.muted = on === undefined ? !this.muted : !!on;
    if (this.mix) this.mix.setMaster(this.muted ? 0 : this.master);
    return this.muted;
  }

  setMusic(v) {
    if (v === false || v === true) this.musicGain = v ? 0.55 : 0;
    else this.musicGain = clamp(v, 0, 1);
    this.music?.setGain(this.musicGain);
    if (this.mix) this.mix.setBusGain('music', this.musicGain / 0.55);
    return this.musicGain;
  }

  play(kind, opts = {}) {
    if (!this.sfx) return false;
    if (!this.running) this.start('play');
    if (!this.sfx) return false;
    const L = this.field.state.listener;
    switch (kind) {
      case 'click': case 'select': case 'confirm': case 'refuse': case 'alert': case 'chime':
        return !!this.sfx.ui(kind);
      case 'horn':
        return !!this.sfx.horn(opts.x ?? L.x, opts.y ?? L.y, opts.z ?? L.z, opts.dist ?? 30, !!opts.heavy);
      case 'construction':
        return !!this.sfx.construction(opts.x ?? L.x, opts.y ?? L.y, opts.z ?? L.z, opts.dist ?? 40);
      case 'thunder':
        return !!this.sfx.thunder(!!opts.near, [L.x, L.y, L.z]);
      case 'bird':
        return !!this.sfx.bird(opts.x ?? L.x, opts.y ?? L.y + 6, opts.z ?? L.z, opts.dist ?? 20);
      default:
        return this.sfx.pool.play(kind, { bus: opts.bus || 'ambience', gain: opts.gain ?? 0.4 }) !== null;
    }
  }

  stats() {
    const m = this.lastMix;
    const busLevels = {};
    if (this.mix) for (const [k, b] of this.mix.buses) busLevels[k] = +linToDb(b.level || 0).toFixed(1);
    return {
      available: this.available,
      // 'preparing' outranks the context state: the context can be running
      // while the library is still being baked, and reporting 'running' then
      // would be a lie about whether anything can be heard.
      state: this.state === 'preparing' ? 'preparing' : (this.actx ? this.actx.state : this.state),
      reason: this.reason,
      sampleRate: this.actx ? this.actx.sampleRate : null,
      baseLatencyMs: this.actx && this.actx.baseLatency ? +(this.actx.baseLatency * 1000).toFixed(1) : null,
      master: +this.master.toFixed(2),
      muted: this.muted,
      music: +this.musicGain.toFixed(2),
      voices: this.pool ? this.pool.stats() : { max: this.opts.voices || 24, active: 0, played: 0, stolen: 0, refused: 0 },
      bank: this.bank ? this.bank.stats() : null,
      updateMs: +this.updateMs.toFixed(3),
      fieldMs: +this.field.sampleMs.toFixed(3),
      buildMs: +this.startMs.toFixed(1),
      mix: m ? m.derived : null,
      busLevels,
      masterDb: this.mix ? +linToDb(this.mix.masterLevel || 0).toFixed(1) : -120,
      limiterDb: this.mix ? +this.mix.reduction().toFixed(2) : 0,
      musicState: this.music ? this.music.stats() : null,
      sfx: this.sfx ? this.sfx.counts : null,
      nodes: this.mix ? this._nodeCount() : 0,
    };
  }

  _nodeCount() {
    // a fixed, knowable graph: buses (5 × 4 nodes) + master (5) + reverb (6)
    // + beds (14 layers × ~4) + voices (24 × 3). Reported, not estimated.
    const beds = this.beds ? this.beds.layers.size : 0;
    let bedNodes = 0;
    if (this.beds) for (const l of this.beds.layers.values()) bedNodes += 1 + (l.filter ? 1 : 0) + (l.panner ? 1 : 0) + l.sources.length * 2;
    const voices = this.pool ? this.pool.voices.length * 3 : 0;
    return 5 * 4 + 5 + (this.mix.verb ? 6 : 0) + bedNodes + voices + beds * 0;
  }

  dispose() {
    this.disarm();
    this._teardown();
    if (this.actx && this.actx.close) { try { this.actx.close(); } catch { /* ignore */ } }
    this.actx = null;
    this.state = this.available ? 'idle' : 'unavailable';
  }
}

export default Director;
export { lerp };
