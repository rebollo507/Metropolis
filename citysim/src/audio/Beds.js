/**
 * audio/Beds — the sustained layers, and the state → mix mapping.
 *
 * A bed is two players of the same baked loop at slightly different rates and
 * offsets, into a filter, into a gain. The rate offset matters: two copies of a
 * 6 s loop at 0.97× and 1.031× only line up again after ~19 minutes, so the
 * period the ear could latch onto is gone.
 *
 * `mixFromState()` is deliberately a pure function of the world state. The live
 * module and the offline verification harness call the same function, so the
 * numbers in the report describe the mix the player actually gets.
 */

import { clamp, lerp, smoothstep } from './Dsp.js';
import * as C from './Curves.js';

/* ------------------------------------------------------------------ layer -- */

export class Layer {
  /**
   * @param {BaseAudioContext} actx
   * @param {Bank} bank
   * @param {object} o  {name, buffer, bus, rates:[..], filter:{type,f,q}, gain, positional}
   */
  constructor(actx, bank, mix, o) {
    this.actx = actx;
    this.name = o.name;
    this.busKey = o.bus || 'ambience';
    this.gainValue = 0;
    this.target = 0;
    this.positional = !!o.positional;
    this.label = o.label || o.name;
    this.rec = bank.get(o.buffer);
    this.ok = !!this.rec;
    this.pos = { x: 0, y: 0, z: 0 };
    this.ref = o.ref || 40;
    this.max = o.max || 900;

    this.gain = actx.createGain();
    this.gain.gain.value = 0.0001;

    let tail = this.gain;
    if (this.positional && actx.createPanner) {
      const p = actx.createPanner();
      p.panningModel = 'equalpower';        // cheap and stable; HRTF costs 10× for no gain on a city bed
      p.distanceModel = 'inverse';
      p.refDistance = this.ref;
      p.maxDistance = this.max;
      p.rolloffFactor = o.rolloff || 1.1;
      this.panner = p;
      this.gain.connect(p);
      tail = p;
    }
    tail.connect(mix.busIn(this.busKey));

    this.filter = null;
    if (o.filter) {
      const f = actx.createBiquadFilter();
      f.type = o.filter.type || 'lowpass';
      f.frequency.value = o.filter.f || 12000;
      f.Q.value = o.filter.q || 0.7;
      f.connect(this.gain);
      this.filter = f;
      this.head = f;
    } else {
      this.head = this.gain;
    }

    this.sources = [];
    if (this.ok) {
      const buf = bank.buffer(actx, o.buffer);
      const rates = o.rates || [1];
      for (let i = 0; i < rates.length; i++) {
        const s = actx.createBufferSource();
        s.buffer = buf;
        s.loop = true;
        s.playbackRate.value = rates[i];
        const g = actx.createGain();
        g.gain.value = 1 / Math.sqrt(rates.length);
        s.connect(g);
        g.connect(this.head);
        this.sources.push({ s, g, offset: (o.offsets && o.offsets[i]) || 0 });
      }
    }
    this.started = false;
  }

  start(when = 0) {
    if (this.started || !this.ok) return this;
    for (const { s, offset } of this.sources) {
      try { s.start(when, offset % (this.rec.dur || 1)); }
      catch { /* a source can only start once; a re-entrant start is harmless */ }
    }
    this.started = true;
    return this;
  }

  /** Ramp to a linear gain. `tc` is a time constant, so this never clicks. */
  set(v, tc = 0.6) {
    const g = clamp(v, 0, 4);
    this.target = g;
    const p = this.gain.gain, t = this.actx.currentTime;
    try { p.setTargetAtTime(Math.max(g, 0.00001), t, Math.max(tc, 0.01)); }
    catch { p.value = g; }
    this.gainValue = g;
    return g;
  }

  /** Immediate value — used by the offline render, where ramps waste the window. */
  setNow(v) {
    const g = clamp(v, 0, 4);
    this.target = this.gainValue = g;
    try { this.gain.gain.value = Math.max(g, 0.00001); } catch { /* ignore */ }
    return g;
  }

  cutoff(hz, tc = 0.4) {
    if (!this.filter) return 0;
    const p = this.filter.frequency, t = this.actx.currentTime;
    const v = clamp(hz, 40, 20000);
    try { p.setTargetAtTime(v, t, tc); } catch { p.value = v; }
    return v;
  }

  moveTo(x, y, z, tc = 0.35) {
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    const p = this.panner;
    if (!p) return;
    const t = this.actx.currentTime;
    if (p.positionX) {
      try {
        p.positionX.setTargetAtTime(x, t, tc);
        p.positionY.setTargetAtTime(y, t, tc);
        p.positionZ.setTargetAtTime(z, t, tc);
        return;
      } catch { /* fall through to the legacy setter */ }
    }
    try { p.setPosition(x, y, z); } catch { /* ignore */ }
  }

  stop() {
    for (const { s } of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    try { this.gain.disconnect(); this.panner?.disconnect(); this.filter?.disconnect(); } catch { /* ignore */ }
    this.started = false;
  }
}

/* ------------------------------------------------------------------- beds -- */

/**
 * The layer list. Order is the order they appear in the showcase's source list,
 * which is why it reads bottom-up: the roar first, the detail last.
 */
export const LAYERS = [
  { name: 'hum.low', label: 'City roar', buffer: 'bed.hum.low', bus: 'ambience', rates: [1, 0.947], offsets: [0, 2.7], filter: { type: 'lowpass', f: 900 } },
  { name: 'hum.mid', label: 'City body', buffer: 'bed.hum.mid', bus: 'ambience', rates: [1, 1.031], offsets: [0.9, 3.3], filter: { type: 'lowpass', f: 4000 } },
  { name: 'hum.air', label: 'Air / tyre hiss', buffer: 'bed.hum.air', bus: 'ambience', rates: [1, 0.973], offsets: [1.7, 4.1], filter: { type: 'highpass', f: 900, q: 0.6 } },
  { name: 'traffic.wash', label: 'Tyre wash', buffer: 'bed.traffic.wash', bus: 'traffic', rates: [1, 1.037], offsets: [0, 2.1], filter: { type: 'lowpass', f: 6000 } },
  { name: 'traffic.engines', label: 'Engines', buffer: 'bed.traffic.engines', bus: 'traffic', rates: [1, 0.961], offsets: [1.1, 3.9], filter: { type: 'lowpass', f: 1800 } },
  { name: 'wind', label: 'Wind', buffer: 'bed.wind', bus: 'weather', rates: [1, 0.939], offsets: [0, 3.7], filter: { type: 'lowpass', f: 9000 } },
  { name: 'rain.street', label: 'Rain (street)', buffer: 'bed.rain.street', bus: 'weather', rates: [1, 1.021], offsets: [0, 2.9], filter: { type: 'highpass', f: 120, q: 0.6 } },
  { name: 'rain.aerial', label: 'Rain (aerial)', buffer: 'bed.rain.aerial', bus: 'weather', rates: [1, 0.983], offsets: [1.3, 4.4], filter: { type: 'lowpass', f: 3000 } },
  { name: 'night', label: 'Night insects', buffer: 'bed.night', bus: 'ambience', rates: [1, 1.017], offsets: [0.4, 2.2], filter: { type: 'highpass', f: 900, q: 0.6 } },
  // positional, placed on the real city
  { name: 'zone.industry', label: 'Industrial plant', buffer: 'bed.industry', bus: 'ambience', rates: [1, 0.967], offsets: [0, 2.3], positional: true, ref: 55, max: 900, filter: { type: 'lowpass', f: 4000 } },
  { name: 'zone.retail', label: 'Retail frontage', buffer: 'bed.chatter', bus: 'ambience', rates: [1, 1.029], offsets: [0.7, 3.1], positional: true, ref: 30, max: 420, filter: { type: 'lowpass', f: 6000 } },
  { name: 'zone.green', label: 'Trees / park', buffer: 'bed.foliage', bus: 'ambience', rates: [1, 0.953], offsets: [0.3, 2.6], positional: true, ref: 34, max: 460, filter: { type: 'highpass', f: 500, q: 0.6 } },
  { name: 'road.a', label: 'Arterial (near)', buffer: 'bed.traffic.wash', bus: 'traffic', rates: [1.013], offsets: [1.9], positional: true, ref: 26, max: 520, filter: { type: 'lowpass', f: 7000 } },
  { name: 'road.b', label: 'Arterial (far)', buffer: 'bed.traffic.engines', bus: 'traffic', rates: [0.991], offsets: [2.8], positional: true, ref: 40, max: 700, filter: { type: 'lowpass', f: 2400 } },
];

export class Beds {
  constructor(actx, bank, mix) {
    this.actx = actx;
    this.mix = mix;
    this.layers = new Map();
    for (const def of LAYERS) {
      const l = new Layer(actx, bank, mix, def);
      this.layers.set(def.name, l);
    }
  }

  start(when = 0) { for (const l of this.layers.values()) l.start(when); return this; }
  get(name) { return this.layers.get(name) || null; }
  stop() { for (const l of this.layers.values()) l.stop(); this.layers.clear(); }

  /**
   * Apply a mix (from `mixFromState`) to the layers.
   * `instant` is used by the offline renderer, where a 0.6 s ramp would eat the
   * window being measured.
   */
  apply(m, instant = false) {
    for (const [name, l] of this.layers) {
      const g = m.layers[name] || 0;
      if (instant) l.setNow(g); else l.set(g, m.tc || 0.6);
      const cf = m.cutoffs && m.cutoffs[name];
      if (cf && l.filter) { if (instant) { try { l.filter.frequency.value = cf; } catch { /* ignore */ } } else l.cutoff(cf); }
    }
    for (const s of (m.sources || [])) {
      const l = this.layers.get(s.name);
      if (l && l.panner) l.moveTo(s.x, s.y, s.z, instant ? 0.001 : 0.4);
    }
    return this;
  }
}

/* --------------------------------------------------- the mix decision ---- */

/**
 * Turn a world state into every bed gain, filter cutoff and bus setting.
 * Pure: no context, no nodes, no clock. This is the sound design, written down.
 *
 * @param {object} s  see `Field.sample()` for the shape
 */
export function mixFromState(s) {
  const alt = C.altitude(s.camera.agl);
  const act = C.activity(s.hours);
  const night = C.nightness(s.hours, s.isNight);
  const rain = C.rainAmount(s.weather);
  const wind = C.windAmount(s.weather);
  const urban = clamp(s.density.urban, 0, 1);
  const veh = clamp(s.density.vehicles, 0, 1);
  const jam = clamp(s.density.congestion, 0, 1);
  const z = s.zones;

  const L = {};
  const cut = {};

  /* ---- the city's own floor -------------------------------------------- */
  // The roar survives distance; it is most of the aerial mix.
  L['hum.low'] = (0.10 + 0.52 * urban) * lerp(0.85, 1.12, alt) * lerp(0.42, 1.0, act * 0.7 + 0.3);
  // Body and air are street phenomena: they lose to distance and to the night.
  L['hum.mid'] = (0.05 + 0.40 * urban) * lerp(1.0, 0.55, alt) * lerp(0.30, 1.0, act);
  L['hum.air'] = (0.02 + 0.30 * urban) * lerp(1.0, 0.22, alt) * lerp(0.18, 1.0, act) * (1 - 0.55 * rain);
  cut['hum.mid'] = lerp(4200, 2600, alt);
  cut['hum.air'] = lerp(900, 2400, alt);

  /* ---- traffic ---------------------------------------------------------- */
  // Free-flowing traffic is tyre wash; a jam is idling engines and no wash.
  const flow = veh * (1 - 0.55 * jam);
  L['traffic.wash'] = (0.06 + 0.85 * flow) * lerp(1.0, 0.42, alt) * lerp(0.25, 1.0, act) * (1 - 0.30 * rain);
  L['traffic.engines'] = (0.05 + 0.60 * veh * (0.45 + 0.85 * jam)) * lerp(1.0, 0.55, alt) * lerp(0.30, 1.0, act);
  cut['traffic.wash'] = lerp(7000, 2600, alt);
  cut['traffic.engines'] = lerp(1800, 900, alt);

  /* ---- zone flavours ---------------------------------------------------- */
  L['zone.industry'] = clamp(z.ind, 0, 1) * (0.55 + 0.45 * act) * 0.95;
  L['zone.retail'] = clamp(z.com, 0, 1) * act * (1 - 0.75 * night) * 1.05 * (1 - 0.5 * rain);
  L['zone.green'] = clamp(z.park + z.res * 0.45, 0, 1) * (0.25 + 0.9 * wind) * 0.75;
  L['road.a'] = flow * clamp(s.density.roadNear, 0, 1) * 0.85 * lerp(1.0, 0.30, alt);
  L['road.b'] = veh * clamp(s.density.roadFar, 0, 1) * 0.55 * lerp(1.0, 0.55, alt);

  /* ---- night ------------------------------------------------------------ */
  L['night'] = night * clamp(z.park + z.res * 0.7, 0, 1) * (1 - 0.9 * rain) * lerp(1.0, 0.15, alt) * 0.55;

  /* ---- weather ---------------------------------------------------------- */
  // Street rain is droplets on hard surfaces; the aerial texture is the same
  // storm with its top taken off by distance. They cross over at ~120 m.
  L['rain.street'] = rain * lerp(1.05, 0.15, alt);
  L['rain.aerial'] = rain * lerp(0.18, 1.0, alt) * 0.9;
  L['wind'] = wind * lerp(0.30, 0.95, alt) * (0.7 + 0.5 * rain);
  cut['rain.street'] = lerp(140, 400, alt);
  cut['wind'] = lerp(4000, 7000, alt);

  /* ---- buses ------------------------------------------------------------ */
  const buses = {
    ambience: 1,
    traffic: lerp(1.0, 0.72, alt),
    weather: 1,
    ui: 1,
    music: 1,
  };
  const tilt = {
    ambience: C.airTiltDb(alt),
    traffic: C.airTiltDb(alt) * 0.8,
    weather: lerp(0, -5, alt),
    ui: 0,
    music: 0,
  };

  return {
    layers: L,
    cutoffs: cut,
    buses,
    tilt,
    space: alt,
    reverb: lerp(0.75, 1.05, alt) * (1 + 0.25 * rain),
    tc: 0.6,
    sources: s.sources,
    derived: {
      altitude: +alt.toFixed(3), activity: +act.toFixed(3), nightness: +night.toFixed(3),
      rain: +rain.toFixed(3), wind: +wind.toFixed(3), urban: +urban.toFixed(3),
      vehicles: +veh.toFixed(3), congestion: +jam.toFixed(3),
    },
  };
}

/** Event rates, per second, for the one-shot layer. Also pure. */
export function ratesFromState(s) {
  const act = C.activity(s.hours);
  const night = C.nightness(s.hours, s.isNight);
  const rain = C.rainAmount(s.weather);
  const alt = C.altitude(s.camera.agl);
  const near = 1 - smoothstep(60, 320, s.camera.agl);
  return {
    pass: clamp(s.density.vehicles * (0.35 + 1.8 * act) * near, 0, 2.2),
    horn: clamp(s.density.congestion * s.density.vehicles * 0.30 * act * near, 0, 0.5),
    bird: clamp(C.chorus(s.hours) * (0.35 + 1.4 * (s.zones.park + s.zones.res * 0.5)) * (1 - rain) * (1 - 0.6 * alt), 0, 2.5),
    construction: clamp(C.worksite(s.hours) * s.density.building * 1.2 * near, 0, 1.4),
    thunder: s.weather && s.weather.preset === 'rain' ? 0.035 : 0,
    industry: clamp(s.zones.ind * (0.35 + 0.5 * act) * near, 0, 0.5),
    nightAmbient: night,
  };
}

export default Beds;
