/**
 * audio/lab — the measurement bench.
 *
 * A screenshot cannot hear, and the verification harness runs Chromium with
 * `--mute-audio`, so this module's evidence is numeric. `lab.html` loads this
 * file and exposes `window.LAB`; a Playwright script drives it and writes the
 * numbers and the spectrogram PNGs into `docs/shots/audio/`.
 *
 * Everything measured here goes through the *shipping* code: the same `Bank`,
 * the same `Mix`, the same `Beds`, the same `mixFromState()` the live module
 * runs. Nothing is re-implemented for the test, which is the only way the
 * numbers describe the thing the player hears.
 */

import * as Analysis from './Analysis.js';
import { blankState } from './Field.js';
import { mixFromState } from './Beds.js';
import { bankFor } from './Bank.js';
import { VoicePool } from './Voices.js';
import { Mix } from './Mix.js';
import { scheduleOnly } from './Music.js';
import { Rng } from '../core/Rng.js';
import { linToDb, spectralCentroid, averageSpectrum } from './Dsp.js';

const SR = 48000;
const SEED = 1337;

/* --------------------------------------------------------------- states -- */

export const STATES = {
  street_noon: blankState({
    hours: 13.0,
    camera: { x: 0, y: 12, z: 0, agl: 8, dist: 60, tx: 0, tz: 0 },
    listener: { x: 0, y: 6, z: 40, fx: 0, fy: -0.1, fz: -1 },
    zones: { res: 0.25, com: 0.55, ind: 0.12, park: 0.15, civ: 0.05, none: 0.1 },
    density: { urban: 0.75, vehicles: 0.62, congestion: 0.25, building: 0.5, roadNear: 0.8, roadFar: 0.5, population: 0.4 },
  }),
  street_night: blankState({
    hours: 2.5, isNight: true,
    camera: { x: 0, y: 12, z: 0, agl: 8, dist: 60, tx: 0, tz: 0 },
    listener: { x: 0, y: 6, z: 40, fx: 0, fy: -0.1, fz: -1 },
    zones: { res: 0.25, com: 0.55, ind: 0.12, park: 0.15, civ: 0.05, none: 0.1 },
    density: { urban: 0.75, vehicles: 0.10, congestion: 0.02, building: 0.5, roadNear: 0.8, roadFar: 0.5, population: 0.4 },
  }),
  street_dawn: blankState({
    hours: 6.1,
    camera: { x: 0, y: 12, z: 0, agl: 8, dist: 60, tx: 0, tz: 0 },
    listener: { x: 0, y: 6, z: 40, fx: 0, fy: -0.1, fz: -1 },
    zones: { res: 0.55, com: 0.2, ind: 0.05, park: 0.45, civ: 0.05, none: 0.1 },
    density: { urban: 0.4, vehicles: 0.25, congestion: 0.05, building: 0.3, roadNear: 0.5, roadFar: 0.3, population: 0.3 },
  }),
  aerial_noon: blankState({
    hours: 13.0,
    camera: { x: 0, y: 420, z: 0, agl: 415, dist: 620, tx: 0, tz: 0 },
    listener: { x: 0, y: 90, z: 60, fx: 0, fy: -0.8, fz: -0.6 },
    zones: { res: 0.25, com: 0.55, ind: 0.12, park: 0.15, civ: 0.05, none: 0.1 },
    density: { urban: 0.75, vehicles: 0.62, congestion: 0.25, building: 0.5, roadNear: 0.8, roadFar: 0.5, population: 0.4 },
  }),
  industry_noon: blankState({
    hours: 11.0,
    camera: { x: 0, y: 14, z: 0, agl: 10, dist: 60, tx: 0, tz: 0 },
    listener: { x: 0, y: 6, z: 40, fx: 0, fy: -0.1, fz: -1 },
    zones: { res: 0.05, com: 0.05, ind: 0.85, park: 0.02, civ: 0, none: 0.05 },
    density: { urban: 0.5, vehicles: 0.3, congestion: 0.1, building: 0.3, roadNear: 0.5, roadFar: 0.4, population: 0.2 },
  }),
  park_day: blankState({
    hours: 10.0,
    camera: { x: 0, y: 10, z: 0, agl: 6, dist: 40, tx: 0, tz: 0 },
    listener: { x: 0, y: 5, z: 30, fx: 0, fy: -0.1, fz: -1 },
    zones: { res: 0.3, com: 0.05, ind: 0.0, park: 0.8, civ: 0, none: 0.1 },
    density: { urban: 0.15, vehicles: 0.08, congestion: 0.0, building: 0.1, roadNear: 0.2, roadFar: 0.2, population: 0.2 },
  }),
  rain_street: blankState({
    hours: 15.0,
    weather: { preset: 'rain', wetness: 0.88, windSpeed: 9.5 },
    camera: { x: 0, y: 12, z: 0, agl: 8, dist: 60, tx: 0, tz: 0 },
    listener: { x: 0, y: 6, z: 40, fx: 0, fy: -0.1, fz: -1 },
    density: { urban: 0.7, vehicles: 0.45, congestion: 0.3, building: 0.5, roadNear: 0.7, roadFar: 0.5, population: 0.4 },
  }),
  rain_aerial: blankState({
    hours: 15.0,
    weather: { preset: 'rain', wetness: 0.88, windSpeed: 9.5 },
    camera: { x: 0, y: 420, z: 0, agl: 415, dist: 620, tx: 0, tz: 0 },
    listener: { x: 0, y: 90, z: 60, fx: 0, fy: -0.8, fz: -0.6 },
    density: { urban: 0.7, vehicles: 0.45, congestion: 0.3, building: 0.5, roadNear: 0.7, roadFar: 0.5, population: 0.4 },
  }),
  jam_evening: blankState({
    hours: 17.8,
    camera: { x: 0, y: 12, z: 0, agl: 8, dist: 60, tx: 0, tz: 0 },
    listener: { x: 0, y: 6, z: 40, fx: 0, fy: -0.1, fz: -1 },
    density: { urban: 0.85, vehicles: 0.95, congestion: 0.85, building: 0.6, roadNear: 1, roadFar: 0.8, population: 0.6 },
  }),
};

/* ------------------------------------------------------------ utilities -- */

const mid = (r) => {
  const n = r.left.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (r.left[i] + r.right[i]) * 0.5;
  return out;
};

async function measure(name, state, o = {}) {
  const r = await Analysis.renderState(state, { seconds: o.seconds ?? 4, sampleRate: SR, seed: SEED, ...o });
  const m = mid(r);
  const met = Analysis.metrics(m, SR, o.skip ?? 0.6);
  return {
    name,
    ...met,
    bands: Analysis.bandEnergies(m, SR),
    correlation: Analysis.correlation(r.left, r.right, 0.6, SR),
    renderMs: r.renderMs,
    realtimeFactor: r.realtimeFactor,
    layers: Object.fromEntries(Object.entries(r.mix.layers)
      .filter(([, v]) => v > 0.004).map(([k, v]) => [k, +v.toFixed(3)])),
    derived: r.mix.derived,
    _buf: m,
  };
}

/* ------------------------------------------------------------ the tests -- */

/** Beds and the whole mix, per state. */
export async function measureStates(names) {
  const out = {};
  for (const n of (names || Object.keys(STATES))) {
    const r = await measure(n, STATES[n], { seconds: 4 });
    delete r._buf;
    out[n] = r;
  }
  return out;
}

/** Every baked one-shot, rendered alone. */
export async function measureOneShots() {
  const bank = bankFor(SR, SEED).build();
  const names = bank.names().filter((n) => n.startsWith('sfx.'));
  const out = [];
  const st = blankState({ hours: 13 });
  for (const n of names) {
    const rec = bank.get(n);
    const r = await Analysis.renderState(st, {
      seconds: Math.min(7, rec.dur + 1.4), sampleRate: SR, seed: SEED,
      music: false, noLayers: true, reverb: false,
      // at the listener's own position, so the table reports the sound and not
      // the distance law applied to it
      events: [{ kind: 'raw', buffer: n, at: 0.05, gain: 0.7, bus: 'ambience',
        pos: [st.listener.x, st.listener.y, st.listener.z], ref: 1, max: 1e4 }],
    });
    const m = mid(r);
    const met = Analysis.metrics(m, SR, 0);
    out.push({
      name: n, durationS: +rec.dur.toFixed(3),
      peak: met.peak, peakDb: met.peakDb, rmsDb: met.rmsDb,
      crestDb: met.crestDb, centroid: met.centroid,
    });
  }
  return out;
}

/** Loop textures, measured directly from the bank (no graph). */
export function measureBank() {
  const bank = bankFor(SR, SEED).build();
  const out = [];
  for (const n of bank.names()) {
    const rec = bank.get(n);
    const ch = rec.ch[0];
    const spec = averageSpectrum(ch.subarray(0, Math.min(ch.length, 1 << 17)), 2048);
    let pk = 0, acc = 0;
    for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > pk) pk = a; acc += ch[i] * ch[i]; }
    out.push({
      name: n, channels: rec.ch.length, seconds: +rec.dur.toFixed(2),
      peakDb: +linToDb(pk).toFixed(2), rmsDb: +linToDb(Math.sqrt(acc / ch.length)).toFixed(2),
      centroid: +spectralCentroid(spec, SR).toFixed(1),
    });
  }
  return { stats: bank.stats(), entries: out };
}

/**
 * The limiter's ceiling. A deliberately over-driven state plus a burst of loud
 * events; the assertion is that not one sample leaves the graph above 1.0.
 */
export async function measureCeiling() {
  const hot = blankState({
    hours: 17.8,
    weather: { preset: 'rain', wetness: 1, windSpeed: 12 },
    camera: { x: 0, y: 10, z: 0, agl: 6, dist: 40, tx: 0, tz: 0 },
    listener: { x: 0, y: 4, z: 12, fx: 0, fy: 0, fz: -1 },
    zones: { res: 1, com: 1, ind: 1, park: 1, civ: 1, none: 0 },
    density: { urban: 1, vehicles: 1, congestion: 1, building: 1, roadNear: 1, roadFar: 1, population: 1 },
  });
  const events = [];
  const rng = new Rng(99);
  for (let i = 0; i < 60; i++) {
    events.push({
      kind: 'raw',
      buffer: rng.pick(['sfx.horn.truck', 'sfx.horn.car0', 'sfx.pass.truck', 'sfx.constr.beam', 'sfx.thunder.near']),
      at: rng.range(0, 3.4), gain: 1.0, bus: rng.pick(['traffic', 'ambience', 'weather']),
      pos: [rng.range(-4, 4), 2, rng.range(-4, 4)], ref: 2, max: 100,
    });
  }
  const r = await Analysis.renderState(hot, { seconds: 4.5, sampleRate: SR, seed: SEED, events, master: 1.0 });
  const L = Analysis.metrics(r.left, SR, 0.2);
  const R = Analysis.metrics(r.right, SR, 0.2);
  return {
    left: L, right: R,
    voices: r.voices,
    verdict: (L.samplesOverUnity === 0 && R.samplesOverUnity === 0) ? 'PASS — no sample above 1.0' : 'FAIL',
    events: events.length,
  };
}

/**
 * Voice cap under synthetic load, against a simulated clock. No audio: this
 * measures the pool's bookkeeping, which is what the cap actually is.
 */
export function measureVoiceLoad(seconds = 60, rate = 40, cap = 24) {
  const fake = makeFakeContext();
  const bank = bankFor(SR, SEED).build();
  const mix = new Mix(fake, bank, { analysers: false, reverb: false });
  const pool = new VoicePool(fake, bank, mix, { max: cap });
  const rng = new Rng(4242);
  const names = ['sfx.pass.car0', 'sfx.pass.truck', 'sfx.horn.car1', 'sfx.constr.nail', 'sfx.bird0', 'sfx.ui.click'];
  const dt = 1 / 120;
  let maxActive = 0, attempts = 0;
  const hist = [];
  for (let t = 0; t < seconds; t += dt) {
    fake.currentTime = t;
    // Poisson-ish arrivals
    if (rng.next() < rate * dt) {
      attempts++;
      pool.play(rng.pick(names), { bus: 'traffic', gain: 0.4, rate: rng.range(0.8, 1.2), pos: [0, 0, 0] });
    }
    const a = pool.count();
    if (a > maxActive) maxActive = a;
    if ((Math.round(t * 120) % 120) === 0) hist.push(a);
  }
  return {
    seconds, requestedPerSecond: rate, cap,
    attempts, played: pool.stats().played, stolen: pool.stats().stolen,
    maxConcurrent: maxActive,
    meanConcurrent: +(hist.reduce((a, b) => a + b, 0) / Math.max(1, hist.length)).toFixed(2),
    verdict: maxActive <= cap ? `PASS — never exceeded ${cap} voices` : `FAIL — ${maxActive} > ${cap}`,
  };
}

/** A minimal BaseAudioContext stand-in: enough graph API for the pool + mix. */
function makeFakeContext() {
  const param = (v) => ({
    value: v, setValueAtTime() { return this; }, setTargetAtTime() { return this; },
    linearRampToValueAtTime() { return this; }, cancelScheduledValues() { return this; },
    exponentialRampToValueAtTime() { return this; },
  });
  const node = (extra = {}) => ({
    connect() { return this; }, disconnect() { return this; }, ...extra,
  });
  return {
    currentTime: 0,
    sampleRate: SR,
    destination: node(),
    createGain: () => node({ gain: param(1) }),
    createBiquadFilter: () => node({ type: 'lowpass', frequency: param(1000), Q: param(1), gain: param(0) }),
    createPanner: () => node({
      panningModel: '', distanceModel: '', refDistance: 1, maxDistance: 1, rolloffFactor: 1,
      positionX: param(0), positionY: param(0), positionZ: param(0), setPosition() {},
    }),
    createDynamicsCompressor: () => node({
      threshold: param(-8), knee: param(2), ratio: param(20), attack: param(0.002), release: param(0.18), reduction: 0,
    }),
    createWaveShaper: () => node({ curve: null, oversample: 'none' }),
    createDelay: () => node({ delayTime: param(0) }),
    createConvolver: () => node({ buffer: null, normalize: true }),
    createBufferSource: () => node({
      buffer: null, loop: false, playbackRate: param(1), onended: null,
      start() {}, stop() {},
    }),
    createBuffer: (ch, len, sr) => ({ numberOfChannels: ch, length: len, sampleRate: sr, copyToChannel() {} }),
  };
}

/** Does the generative music repeat? Fifteen minutes of schedule, checked. */
export function measureMusic(minutes = 15) {
  const seconds = minutes * 60;
  const sched = scheduleOnly(SEED, 13, 0.5, seconds);
  const key = sched.map((c) => `${c.degree}:${Math.round(c.dur)}`);
  const RUN = 8;
  let repeats = 0, firstAt = null;
  const seen = new Map();
  for (let i = 0; i + RUN <= key.length; i++) {
    const k = key.slice(i, i + RUN).join('|');
    if (seen.has(k)) { repeats++; if (firstAt === null) firstAt = [seen.get(k), i]; }
    else seen.set(k, i);
  }
  const byHour = {};
  for (const h of [3, 6, 13, 18, 22]) {
    const s = scheduleOnly(SEED, h, 0.5, 300);
    byHour[h] = { mode: s[0].mode, root: s[0].root, chords: s.length };
  }
  const degrees = new Array(7).fill(0);
  for (const c of sched) degrees[c.degree]++;
  return {
    minutes, chords: sched.length,
    meanChordS: +(sched.reduce((a, c) => a + c.dur, 0) / sched.length).toFixed(2),
    repeatedRunsOf8: repeats,
    firstRepeatAt: firstAt,
    degreeHistogram: degrees,
    keyByHour: byHour,
    verdict: repeats === 0 ? `PASS — no run of ${RUN} chords recurs in ${minutes} min` : 'FAIL',
  };
}

/**
 * The two claims that are easiest to assert and hardest to prove: that the
 * weather bed really is a different texture at street level and from the air,
 * and that the city's own bed loses its high end with altitude. Both are
 * measured on the bus in question, alone, so nothing else can flatter them.
 */
export async function measureContrast() {
  const one = async (state, solo, seconds = 4, soloLayer = null) => {
    const r = await Analysis.renderState(state, { seconds, sampleRate: SR, seed: SEED, solo, soloLayer, music: false });
    const m = mid(r);
    return { ...Analysis.metrics(m, SR, 0.6), bands: Analysis.bandEnergies(m, SR), correlation: Analysis.correlation(r.left, r.right, 0.6, SR) };
  };
  const rainStreet = await one(STATES.rain_street, 'weather', 4, 'rain.street');
  const rainAerial = await one(STATES.rain_aerial, 'weather', 4, 'rain.aerial');
  const wxStreet = await one(STATES.rain_street, 'weather');
  const wxAerial = await one(STATES.rain_aerial, 'weather');
  const cityStreet = await one(STATES.street_noon, 'ambience');
  const cityAerial = await one(STATES.aerial_noon, 'ambience');
  const trafStreet = await one(STATES.street_noon, 'traffic');
  const trafAerial = await one(STATES.aerial_noon, 'traffic');
  const hf = (m) => {
    const b = Object.fromEntries(m.bands.map((x) => [x.f, x.db]));
    return +(((b[4000] + b[8000]) / 2) - ((b[125] + b[250]) / 2)).toFixed(2);
  };
  return {
    rain: {
      street: rainStreet, aerial: rainAerial,
      wholeBus: {
        street: { centroid: wxStreet.centroid, rmsDb: wxStreet.rmsDb, correlation: wxStreet.correlation },
        aerial: { centroid: wxAerial.centroid, rmsDb: wxAerial.rmsDb, correlation: wxAerial.correlation },
        note: 'the weather bus also carries wind, which is louder and brighter at altitude',
      },
      centroidDelta: +(rainStreet.centroid - rainAerial.centroid).toFixed(1),
      hfTiltDelta: +(hf(rainStreet) - hf(rainAerial)).toFixed(2),
      verdict: rainStreet.centroid > rainAerial.centroid * 1.4
        ? 'PASS — street rain is measurably brighter than aerial rain' : 'FAIL',
    },
    city: {
      street: cityStreet, aerial: cityAerial,
      centroidDelta: +(cityStreet.centroid - cityAerial.centroid).toFixed(1),
      hfTiltDelta: +(hf(cityStreet) - hf(cityAerial)).toFixed(2),
      verdict: cityStreet.centroid > cityAerial.centroid * 1.4
        ? 'PASS — the aerial city bed is measurably darker' : 'FAIL',
    },
    traffic: {
      street: trafStreet, aerial: trafAerial,
      centroidDelta: +(trafStreet.centroid - trafAerial.centroid).toFixed(1),
      levelDeltaDb: +(trafStreet.rmsDb - trafAerial.rmsDb).toFixed(2),
    },
  };
}

/** Per-bus levels, by rendering each bus solo through the real graph. */
export async function measureBuses(stateName = 'street_noon') {
  return Analysis.busLevels(STATES[stateName], { seconds: 2.5, sampleRate: SR, seed: SEED });
}

/** The pure mix function, sampled across the day and across altitude. */
export function sweep() {
  const out = { byHour: [], byAltitude: [] };
  for (let h = 0; h < 24; h++) {
    const s = blankState({ hours: h });
    const m = mixFromState(s);
    out.byHour.push({
      h, activity: m.derived.activity, night: m.derived.nightness,
      hum: +m.layers['hum.mid'].toFixed(3), wash: +m.layers['traffic.wash'].toFixed(3),
      chatter: +m.layers['zone.retail'].toFixed(3), insects: +m.layers.night.toFixed(3),
    });
  }
  for (const agl of [2, 15, 40, 90, 180, 320, 600]) {
    const s = blankState({ camera: { agl }, weather: { preset: 'rain', wetness: 0.9, windSpeed: 9 } });
    const m = mixFromState(s);
    out.byAltitude.push({
      agl, alt: m.derived.altitude,
      rainStreet: +m.layers['rain.street'].toFixed(3),
      rainAerial: +m.layers['rain.aerial'].toFixed(3),
      air: +m.layers['hum.air'].toFixed(3),
      tiltDb: +m.tilt.ambience.toFixed(2),
      space: +m.space.toFixed(3),
    });
  }
  return out;
}

/* ---------------------------------------------------------- spectrogram -- */

/** Render a state and return a spectrogram PNG as a data URL. */
export async function spectrogramPng(stateName, o = {}) {
  const state = STATES[stateName] || blankState({});
  const r = await Analysis.renderState(state, {
    seconds: o.seconds ?? 6, sampleRate: SR, seed: SEED, ...o,
  });
  const buf = mid(r);
  return drawSpectrogram(buf, SR, `${stateName}${o.tag ? ' · ' + o.tag : ''}`, o);
}

export function drawSpectrogram(buf, sr, title, o = {}) {
  const sg = Analysis.spectrogram(buf, sr, 1024, 384, 900);
  const W = o.width || 900, H = o.height || 320;
  const padL = 52, padB = 34, padT = 30, padR = 12;
  const cv = document.createElement('canvas');
  const dpr = 2;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = W + 'px';
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = '#0b0f14';
  g.fillRect(0, 0, W, H);

  const plotW = W - padL - padR, plotH = H - padT - padB;
  const bins = sg.bins;
  const fMax = sr / 2, fMin = 30;
  const img = g.createImageData(Math.round(plotW), Math.round(plotH));
  const lo = o.floorDb ?? -88, hi = o.ceilDb ?? -28;
  for (let px = 0; px < img.width; px++) {
    const fi = Math.min(sg.frames.length - 1, Math.floor(px / img.width * sg.frames.length));
    const row = sg.frames[fi];
    for (let py = 0; py < img.height; py++) {
      // log frequency axis
      const u = 1 - py / img.height;
      const f = fMin * Math.pow(fMax / fMin, u);
      const b = Math.min(bins - 1, Math.max(1, Math.round(f / (fMax / (bins - 1)))));
      const db = row[b];
      const t = Math.max(0, Math.min(1, (db - lo) / (hi - lo)));
      // a perceptual ramp: deep blue → cyan → warm → white
      const c = ramp(t);
      const k = (py * img.width + px) * 4;
      img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = 255;
    }
  }
  // putImageData ignores the canvas transform, so the plot goes through an
  // offscreen buffer and is drawn scaled — otherwise it lands at raw device
  // pixels in the corner of a device-pixel-ratio canvas.
  const off = document.createElement('canvas');
  off.width = img.width; off.height = img.height;
  off.getContext('2d').putImageData(img, 0, 0);
  g.drawImage(off, padL, padT, plotW, plotH);

  g.strokeStyle = 'rgba(255,255,255,.16)';
  g.strokeRect(padL + 0.5, padT + 0.5, plotW - 1, plotH - 1);
  g.fillStyle = '#cfe0f0';
  g.font = '600 13px "Liberation Sans", Arial, sans-serif';
  g.fillText(title, padL, 20);
  g.font = '10px "Liberation Sans", Arial, sans-serif';
  g.fillStyle = '#8fa6bd';
  for (const f of [50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000]) {
    if (f > fMax) continue;
    const u = Math.log(f / fMin) / Math.log(fMax / fMin);
    const y = padT + plotH - u * plotH;
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, 8, y + 3);
    g.strokeStyle = 'rgba(255,255,255,.10)';
    g.beginPath(); g.moveTo(padL - 4, y + 0.5); g.lineTo(padL, y + 0.5); g.stroke();
  }
  const secs = buf.length / sr;
  for (let s = 0; s <= secs; s++) {
    const x = padL + (s / secs) * plotW;
    g.fillText(`${s}s`, x - 6, H - 12);
  }
  // colour key, top right, clear of the time axis
  g.fillStyle = '#5c6879';
  g.font = '10px "Liberation Sans", Arial, sans-serif';
  g.fillText(`${lo}`, W - 232, 20);
  g.fillText(`${hi} dBFS/bin`, W - 92, 20);
  for (let i = 0; i < 120; i++) {
    const c = ramp(i / 119);
    g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    g.fillRect(W - 216 + i, 12, 1, 9);
  }
  return cv.toDataURL('image/png');
}

function ramp(t) {
  const stops = [
    [0.00, [8, 12, 24]],
    [0.25, [22, 52, 110]],
    [0.50, [30, 140, 170]],
    [0.72, [220, 170, 70]],
    [0.88, [245, 120, 60]],
    [1.00, [255, 250, 240]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const u = (t - a[0]) / (b[0] - a[0] || 1);
      return [0, 1, 2].map((k) => Math.round(a[1][k] + (b[1][k] - a[1][k]) * u));
    }
  }
  return stops[stops.length - 1][1];
}

/* ---------------------------------------------------------------- boot --- */

export async function boot() {
  window.LAB = {
    STATES, measureStates, measureOneShots, measureBank, measureCeiling, measureContrast,
    measureVoiceLoad, measureMusic, measureBuses, sweep, spectrogramPng,
    drawSpectrogram, Analysis, blankState, mixFromState,
    async passSpectrogram() {
      const st = blankState({ hours: 13, listener: { x: 0, y: 2, z: 0, fx: 0, fy: 0, fz: -1 } });
      const r = await Analysis.renderState(st, {
        seconds: 6, sampleRate: SR, seed: SEED, music: false, noLayers: true,
        events: [
          { kind: 'pass', buffer: 'sfx.pass.car0', at: 0.3, gain: 0.9, pos: [-30, 1, 4] },
          { kind: 'pass', buffer: 'sfx.pass.truck', at: 1.8, gain: 0.9, pos: [-30, 1, 6] },
          { kind: 'horn', at: 3.2, gain: 0.7, pos: [6, 1, 4] },
          { kind: 'raw', buffer: 'sfx.constr.steel0', at: 4.1, gain: 0.8, bus: 'ambience', pos: [4, 2, 4], ref: 4, max: 200 },
          { kind: 'raw', buffer: 'sfx.bird.trill', at: 4.9, gain: 0.8, bus: 'ambience', pos: [2, 6, 2], ref: 4, max: 200 },
        ],
      });
      const m = mid(r);
      return drawSpectrogram(m, SR, 'one-shots · car pass · truck · horn · steel · bird trill');
    },
    async musicSpectrogram() {
      const st = blankState({ hours: 22 });
      const r = await Analysis.renderState(st, {
        seconds: 30, sampleRate: SR, seed: SEED, noLayers: true, musicGain: 0.8,
      });
      return drawSpectrogram(mid(r), SR, 'music bed alone · 30 s from 22:00', { seconds: 30 });
    },
  };
  return window.LAB;
}

export default boot;
