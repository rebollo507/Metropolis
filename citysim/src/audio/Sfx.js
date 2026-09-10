/**
 * audio/Sfx — the recipes. What each game event actually sounds like.
 *
 * Every trigger takes a baked variant, then varies it: playback rate (which is
 * both pitch and length, so a truck pass is never the same length twice), level,
 * a distance lowpass standing in for air absorption, and — for anything with a
 * position — the geometry of a moving pass through the panner. Three car-pass
 * buffers become several hundred distinguishable passes.
 *
 * Rate limits live here rather than at the call site so the pool cannot be
 * flooded by a single frame in which forty buildings finished at once.
 */

import { clamp, lerp } from './Dsp.js';

/** Air absorption: distant sources lose their high end before their level. */
function airLp(dist) {
  return clamp(18000 * Math.exp(-dist / 190), 420, 18000);
}

export class Sfx {
  constructor(pool, rng, log) {
    this.pool = pool;
    this.rng = rng;
    this.log = log;
    this.counts = { pass: 0, horn: 0, construction: 0, ui: 0, alert: 0, bird: 0, thunder: 0, industry: 0 };
  }

  /* ------------------------------------------------------------ traffic -- */

  /**
   * A vehicle passing. `v` is a `traffic.vehiclesNear()` record; the voice is
   * flown along the vehicle's own velocity for the length of the sound, so the
   * pan and the baked band-sweep agree instead of fighting.
   */
  vehiclePass(v, dist, speed) {
    if (!this.pool.allow('pass', 0.16)) return null;
    const r = this.rng;
    const heavy = v.type === 'truck' || v.type === 'bus' || v.type === 'van';
    const name = heavy
      ? (v.type === 'bus' ? 'sfx.pass.bus' : 'sfx.pass.truck')
      : ['sfx.pass.car0', 'sfx.pass.car1', 'sfx.pass.car2'][r.int(3)];
    // fast traffic plays back shorter and brighter; a crawl is long and dull
    const rate = clamp(lerp(0.72, 1.28, clamp(speed / 16, 0, 1)) * r.range(0.94, 1.07), 0.5, 1.7);
    const gain = clamp((heavy ? 0.55 : 0.42) * lerp(1.0, 0.35, clamp(dist / 90, 0, 1)) * r.range(0.85, 1.15), 0, 1);
    const dur = 1.2 / rate;
    const vx = v.speed ? Math.sin(v.yaw || 0) * v.speed : 0;
    const vz = v.speed ? Math.cos(v.yaw || 0) * v.speed : 0;
    this.counts.pass++;
    return this.pool.play(name, {
      bus: 'traffic', gain, rate,
      pos: [v.x, (v.y || 0) + 0.6, v.z],
      to: [v.x + vx * dur, (v.y || 0) + 0.6, v.z + vz * dur],
      ref: 14, max: 260, rolloff: 1.25,
      filter: { type: 'lowpass', f: airLp(dist) },
      label: `${v.type || 'car'} pass`,
    });
  }

  horn(x, y, z, dist, heavy = false) {
    if (!this.pool.allow('horn', 1.6)) return null;
    const r = this.rng;
    const name = heavy ? 'sfx.horn.truck' : ['sfx.horn.car0', 'sfx.horn.car1', 'sfx.horn.car2'][r.int(3)];
    this.counts.horn++;
    return this.pool.play(name, {
      bus: 'traffic',
      gain: clamp((heavy ? 0.42 : 0.34) * lerp(1, 0.3, clamp(dist / 120, 0, 1)), 0, 1),
      rate: r.range(0.94, 1.08),
      pos: [x, y + 1.0, z],
      ref: 18, max: 420, rolloff: 1.0,
      filter: { type: 'lowpass', f: airLp(dist * 0.8) },
      label: heavy ? 'air horn' : 'car horn',
    });
  }

  /* ------------------------------------------------------- construction -- */

  /** A building went up. Four hits over a couple of seconds, not one clang. */
  construction(x, y, z, dist) {
    if (!this.pool.allow('constr', 0.5)) return null;
    const r = this.rng;
    const n = 2 + r.int(3);
    const base = clamp(0.40 * lerp(1, 0.28, clamp(dist / 160, 0, 1)), 0, 1);
    for (let i = 0; i < n; i++) {
      const kind = r.weighted([
        ['sfx.constr.steel0', 3], ['sfx.constr.steel1', 3],
        ['sfx.constr.nail', 4], ['sfx.constr.beam', 1], ['sfx.constr.drill', 1.4],
      ]);
      this.pool.play(kind, {
        bus: 'ambience',
        gain: base * r.range(0.6, 1.15),
        rate: r.range(0.86, 1.18),
        when: i * r.range(0.18, 0.62),
        pos: [x + r.range(-6, 6), y + r.range(0, 8), z + r.range(-6, 6)],
        ref: 22, max: 500,
        filter: { type: 'lowpass', f: airLp(dist) },
        label: 'construction',
      });
    }
    this.counts.construction += n;
    return n;
  }

  /** A clank from a plant — the punctuation on the industrial bed. */
  industry(x, y, z, dist) {
    if (!this.pool.allow('industry', 2.2)) return null;
    const r = this.rng;
    this.counts.industry++;
    return this.pool.play(r.bool(0.6) ? 'sfx.constr.beam' : 'sfx.constr.steel1', {
      bus: 'ambience',
      gain: clamp(0.28 * lerp(1, 0.3, clamp(dist / 220, 0, 1)), 0, 1),
      rate: r.range(0.55, 0.85),
      pos: [x, y + 4, z],
      ref: 30, max: 700,
      filter: { type: 'lowpass', f: airLp(dist * 1.4) },
      label: 'plant clank',
    });
  }

  /* ---------------------------------------------------------- wildlife --- */

  bird(x, y, z, dist) {
    if (!this.pool.allow('bird', 0.22)) return null;
    const r = this.rng;
    const trill = r.bool(0.18);
    const name = trill ? 'sfx.bird.trill' : ['sfx.bird0', 'sfx.bird1', 'sfx.bird2', 'sfx.bird3'][r.int(4)];
    const n = trill ? 1 : 1 + r.int(3);
    for (let i = 0; i < n; i++) {
      this.pool.play(name, {
        bus: 'ambience',
        gain: clamp(0.30 * lerp(1, 0.35, clamp(dist / 90, 0, 1)) * r.range(0.7, 1.2), 0, 1),
        rate: r.range(0.82, 1.24),
        when: i * r.range(0.10, 0.28),
        pos: [x + r.range(-8, 8), y + r.range(3, 12), z + r.range(-8, 8)],
        ref: 16, max: 220,
        label: 'bird',
      });
    }
    this.counts.bird += n;
    return n;
  }

  /* ----------------------------------------------------------- weather --- */

  thunder(near, listener) {
    if (!this.pool.allow('thunder', 6)) return null;
    const r = this.rng;
    const far = !near;
    const ang = r.range(0, Math.PI * 2);
    const d = far ? r.range(600, 1800) : r.range(120, 420);
    this.counts.thunder++;
    return this.pool.play(far ? 'sfx.thunder.far' : 'sfx.thunder.near', {
      bus: 'weather',
      gain: far ? r.range(0.30, 0.5) : r.range(0.55, 0.85),
      rate: r.range(0.88, 1.10),
      pos: [listener[0] + Math.sin(ang) * d, 260, listener[2] + Math.cos(ang) * d],
      ref: 320, max: 4000, rolloff: 0.7,
      filter: { type: 'lowpass', f: far ? 260 : 2600 },
      label: far ? 'distant thunder' : 'thunder',
    });
  }

  /* --------------------------------------------------------- interface --- */

  ui(kind) {
    const map = {
      click: ['sfx.ui.click', 0.35, 0.02],
      select: ['sfx.ui.select', 0.32, 0.05],
      confirm: ['sfx.ui.confirm', 0.30, 0.10],
      refuse: ['sfx.ui.refuse', 0.34, 0.10],
      alert: ['sfx.ui.alert', 0.34, 0.40],
      chime: ['sfx.ui.chime', 0.30, 0.40],
    };
    const m = map[kind] || map.click;
    if (!this.pool.allow('ui:' + kind, m[2])) return null;
    this.counts.ui++;
    // Interface sounds are not in the world: no panner distance, dead centre.
    return this.pool.play(m[0], {
      bus: 'ui', gain: m[1], rate: this.rng.range(0.99, 1.01),
      ref: 1, max: 10000, rolloff: 0,
      label: 'ui ' + kind,
    });
  }

  alert(level = 'warning') {
    if (!this.pool.allow('alert', 4)) return null;
    this.counts.alert++;
    return this.pool.play(level === 'critical' ? 'sfx.ui.alert' : 'sfx.ui.refuse', {
      bus: 'ui', gain: level === 'critical' ? 0.42 : 0.30,
      rate: level === 'critical' ? 0.96 : 1.04,
      ref: 1, max: 10000, rolloff: 0,
      label: 'alert ' + level,
    });
  }
}

export default Sfx;
