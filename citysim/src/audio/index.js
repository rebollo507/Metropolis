/**
 * audio — the city's sound.
 *
 * Every sample in this module is synthesised in the browser: noise buffers,
 * biquads, formant banks, oscillator stacks, waveshapers and a convolution
 * reverb whose impulse responses are grown from a comb/all-pass network. There
 * is no sample library, and there could not be one — the build environment's
 * egress proxy blocks every source of audio, and the project's asset policy is
 * procedural-only anyway.
 *
 * What it does, in one paragraph: a lazily-created `AudioContext` carries a
 * mastered bus architecture (ambience · traffic · weather · interface · music →
 * limiter → tanh ceiling); fourteen sustained beds are re-balanced four times a
 * second from the real world state — land use around the camera, vehicle
 * density and congestion, hour, weather and, crucially, altitude, which is what
 * separates a street mix from an aerial one; discrete events (vehicle passes,
 * horns, construction, birds, thunder, interface) play through a hard-capped
 * pool of recycled voices; and a seeded generative music bed drifts underneath
 * without ever repeating.
 *
 * What it does when it cannot make a sound at all — no `AudioContext`, autoplay
 * blocked, a headless harness with `--mute-audio` — is *exactly the same thing*,
 * minus the sound: every method answers, `stats()` tells the truth about why,
 * and nothing throws. That path is not a fallback bolted on afterwards; it is
 * the path the verification harness takes on every single shot.
 *
 * Showcases visualise what is playing (`default` spectrum + meters, `mix` the
 * bus architecture, `sources` the positional field in the world) because a
 * screenshot cannot hear. They are OFF unless explicitly staged.
 */

import { Director } from './Director.js';
import { stageShowcase, teardownShowcase, setOverlayVisible } from './showcase.js';
import { blankState } from './Field.js';
import * as Analysis from './Analysis.js';
import { mixFromState, ratesFromState } from './Beds.js';

const S = {
  ctx: null,
  dir: null,
  offEvents: [],
  showcaseMode: null,
  lastPop: 0,
  nextMilestoneCheck: 0,
};

function api(name) { try { return S.ctx ? S.ctx.get(name) : null; } catch { return null; } }

/* --------------------------------------------------------------- module -- */

const mod = {
  name: 'audio',
  version: '1.0.0',
  // Everything is late-bound through ctx.get(), so a missing or FAILED sibling
  // costs a feature, never a boot.
  dependsOn: [],
  provides: ['setVolume', 'mute', 'isReady', 'play', 'stats', 'setMusic'],

  api: {},

  async init(ctx) {
    S.ctx = ctx;
    S.showcaseMode = null;
    S.lastPop = 0;

    S.dir = new Director(ctx, {
      volume: 0.85,
      voices: ctx.opts?.quality === 'low' ? 16 : 24,
    });

    // The graph is built on the first user gesture — browsers block it before
    // one, and building a suspended context just to hold it is waste. The
    // headless harness never gestures, which is precisely why the silent path
    // is the one exercised on every shot.
    S.dir.arm();

    const on = (type, fn) => S.offEvents.push(ctx.events.on(type, fn, 'audio'));

    on('time:changed', (p) => {
      if (p && p.isNight !== undefined) S.dir.field.state.isNight = p.isNight;
      S.dir.field.sample(S.dir.elapsed, true);
      S.dir.applyMix(false);
    });

    on('weather:changed', () => {
      S.dir.field.sample(S.dir.elapsed, true);
      S.dir.applyMix(false);
    });

    on('buildings:spawned', (p) => { S.dir.onBuildingsSpawned(p && p.ids); });

    on('tool:selected', () => S.dir.onTool('select'));
    on('tools:refused', () => S.dir.onTool('refuse'));
    on('tools:history', (p) => {
      if (!p) return;
      if (p.kind === 'push') S.dir.onTool('confirm');
      else if (p.kind === 'undo' || p.kind === 'redo') S.dir.onTool('click');
    });

    on('sim:budget', (p) => { if (p && p.bankrupt) S.dir.onAlert('critical'); });
    on('module:failed', () => S.dir.onAlert('warning'));

    on('sim:tick', () => {
      const pop = ctx.world.stats.population || 0;
      if (pop !== S.lastPop) { S.lastPop = pop; S.dir.checkMilestone(pop); }
    });

    // Prime the field so `stats()` and the showcase have real numbers before
    // anything has been rendered or clicked.
    S.dir.field.sample(0, true);
    S.dir.applyMix(true);

    ctx.log.info(
      `ready — silent until first gesture (${S.dir.available ? 'AudioContext available' : 'no AudioContext: ' + S.dir.reason}), `
      + `5 buses, 14 beds, ${S.dir.opts.voices} voice cap`
    );
  },

  update(ctx, dt, elapsed) {
    if (!S.dir) return;
    S.dir.update(dt, elapsed);
    if (S.showcaseMode) {
      // the overlay refreshes on its own cadence; this only feeds it state
      try { setOverlayVisible(true, S.dir, S.showcaseMode); } catch { /* never break a frame */ }
    }
  },

  showcase(ctx, variant = 'default') {
    S.ctx = ctx;
    S.showcaseMode = variant;
    return stageShowcase(ctx, S.dir, variant);
  },

  dispose(ctx) {
    for (const off of S.offEvents) { try { off(); } catch { /* ignore */ } }
    S.offEvents.length = 0;
    try { teardownShowcase(ctx); } catch { /* ignore */ }
    try { S.dir?.dispose(); } catch { /* ignore */ }
    S.dir = null;
    S.showcaseMode = null;
  },

  /* ============================== provides ============================== */

  /** Master volume, 0..1. Takes effect immediately, ramped so it cannot click. */
  setVolume(v) { return S.dir ? S.dir.setVolume(v) : 0; },

  /** mute() toggles, mute(true|false) sets. Returns the resulting state. */
  mute(on) { return S.dir ? S.dir.mute(on) : true; },

  /** True only when sound is actually being produced. `stats()` says why not. */
  isReady() { return !!(S.dir && S.dir.running); },

  /**
   * Fire a sound by name: 'click' | 'select' | 'confirm' | 'refuse' | 'alert' |
   * 'chime' | 'horn' | 'construction' | 'thunder' | 'bird', or any Bank entry.
   * Starts the audio graph if a gesture has already happened.
   */
  play(kind, opts) { return S.dir ? S.dir.play(kind, opts) : false; },

  /** Music bed level 0..1, or false to silence it. */
  setMusic(v) { return S.dir ? S.dir.setMusic(v) : 0; },

  stats() {
    if (!S.dir) return { available: false, state: 'disposed' };
    const s = S.dir.stats();
    s.showcase = S.showcaseMode;
    s.field = S.dir.field.snapshot();
    return s;
  },
};

/* Extra surface beyond the required list — used by the showcase, the overlay
 * and the offline verification harness. */
mod.api = {
  director: () => S.dir,
  field: () => (S.dir ? S.dir.field.snapshot() : null),
  mixState: () => (S.dir && S.dir.lastMix ? S.dir.lastMix : null),
  rates: () => (S.dir ? ratesFromState(S.dir.field.state) : null),
  /** The pure state → mix function, exposed so a test can call it directly. */
  mixFromState,
  blankState,
  analysis: Analysis,
  /** Turn the visualiser on or off outside a showcase. Default is OFF. */
  setOverlay: (on, variant = 'default') => {
    S.showcaseMode = on ? variant : null;
    setOverlayVisible(!!on, S.dir, variant);
    return !!on;
  },
  /** Start the graph without waiting for a gesture (a click handler may call it). */
  start: (why) => (S.dir ? S.dir.start(why || 'api') : false),
  bank: () => (S.dir && S.dir.bank ? S.dir.bank.stats() : null),
};

export default mod;
