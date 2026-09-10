/**
 * audio/Analysis — offline rendering and measurement.
 *
 * A screenshot cannot hear anything and the verification harness runs Chromium
 * with `--mute-audio`, so this module's proof of work is numeric. Everything
 * here renders the *same graph the player hears* through an
 * `OfflineAudioContext` and measures it: peak, RMS, dBFS, spectral centroid,
 * band energies, whether any sample ever leaves the limiter above 1.0, and how
 * the mix differs between two world states.
 *
 * It is also what feeds the showcase overlay when the live context is suspended
 * (which is exactly the harness's condition): the spectrum drawn over the city
 * is then a real render of the real mix, not a decoration.
 */

import { bankFor } from './Bank.js';
import { Mix, BUSES } from './Mix.js';
import { Beds, mixFromState } from './Beds.js';
import { VoicePool } from './Voices.js';
import { Sfx } from './Sfx.js';
import { Music } from './Music.js';
import { Rng } from '../core/Rng.js';
import { averageSpectrum, spectralCentroid, peakOf, rms, linToDb, magSpectrum, clamp } from './Dsp.js';

const OfflineCtx = (typeof window !== 'undefined')
  ? (window.OfflineAudioContext || window.webkitOfflineAudioContext || null)
  : (typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : null);

export const canRenderOffline = () => !!OfflineCtx;

/**
 * Render a world state to a stereo buffer.
 *
 * @param {object} state    a `Field` state (or `blankState()`)
 * @param {object} o        {seconds, sampleRate, seed, music, solo, events, reverb}
 * @returns {Promise<{left:Float32Array,right:Float32Array,sampleRate:number,mix:object,renderMs:number}>}
 */
export async function renderState(state, o = {}) {
  if (!OfflineCtx) throw new Error('OfflineAudioContext unavailable');
  const seconds = o.seconds ?? 3.0;
  const sr = o.sampleRate ?? 48000;
  const seed = (o.seed ?? 1337) >>> 0;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);

  const actx = new OfflineCtx(2, Math.round(seconds * sr), sr);
  const bank = bankFor(sr, seed).build();
  const mix = new Mix(actx, bank, { analysers: false, reverb: o.reverb !== false, master: o.master ?? 0.85 });
  const beds = new Beds(actx, bank, mix);
  const m = mixFromState(state);

  // solo: keep one bus (or one layer) and silence the rest, for per-part metrics
  if (o.solo) {
    for (const b of BUSES) if (b.key !== o.solo) mix.setBusGain(b.key, 0, 0.001);
  }
  if (o.soloLayer) {
    for (const k of Object.keys(m.layers)) if (k !== o.soloLayer) m.layers[k] = 0;
  }
  if (o.noLayers) for (const k of Object.keys(m.layers)) m.layers[k] = 0;

  beds.apply(m, true);
  beds.start(0);
  for (const b of BUSES) {
    if (o.solo && b.key !== o.solo) continue;
    mix.setBusGain(b.key, m.buses[b.key] ?? 1, 0.001);
    mix.setBusTilt(b.key, m.tilt[b.key] ?? 0, 0.001);
  }
  mix.setSpace(m.space, 0.001);
  mix.setReverb(m.reverb, 0.001);

  // listener, so positional sources land where the state says they are
  const L = state.listener;
  try {
    const l = actx.listener;
    if (l.positionX) {
      l.positionX.value = L.x; l.positionY.value = L.y; l.positionZ.value = L.z;
      l.forwardX.value = L.fx; l.forwardY.value = L.fy; l.forwardZ.value = L.fz;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else { l.setPosition(L.x, L.y, L.z); l.setOrientation(L.fx, L.fy, L.fz, 0, 1, 0); }
  } catch { /* a listener that refuses positioning still renders */ }

  // music
  let music = null;
  if (o.music !== false) {
    music = new Music(actx, mix, seed, { gain: o.musicGain ?? 0.55 });
    music.setState(state.hours, state.city ? state.city.size : 0.4);
    music.schedule(seconds + 1);
  }

  // discrete events
  let pool = null, sfx = null;
  if (o.events && o.events.length) {
    pool = new VoicePool(actx, bank, mix, { max: o.voices || 24 });
    sfx = new Sfx(pool, Rng.derive(seed, 'audio:sfx'), null);
    for (const e of o.events) {
      const at = e.at ?? 0;
      if (e.kind === 'pass') {
        sfx.pool.allow('pass', 0);
        sfx.pool.play(e.buffer || 'sfx.pass.car0', {
          bus: 'traffic', gain: e.gain ?? 0.5, rate: e.rate ?? 1, when: at,
          pos: e.pos || [L.x + 6, L.y, L.z], ref: 14, max: 260, label: 'pass',
        });
      } else if (e.kind === 'raw') {
        pool.play(e.buffer, { bus: e.bus || 'ambience', gain: e.gain ?? 0.5, rate: e.rate ?? 1, when: at, pos: e.pos, ref: e.ref, max: e.max, label: e.buffer });
      } else if (e.kind === 'ui') {
        pool.play('sfx.ui.' + (e.name || 'click'), { bus: 'ui', gain: e.gain ?? 0.35, when: at, ref: 1, max: 1e4, rolloff: 0, label: 'ui' });
      } else if (e.kind === 'horn') {
        pool.play(e.buffer || 'sfx.horn.car0', { bus: 'traffic', gain: e.gain ?? 0.4, when: at, pos: e.pos || [L.x + 10, L.y, L.z], ref: 18, max: 420, label: 'horn' });
      } else if (e.kind === 'thunder') {
        pool.play(e.buffer || 'sfx.thunder.near', { bus: 'weather', gain: e.gain ?? 0.7, when: at, pos: e.pos || [L.x, 260, L.z + 300], ref: 320, max: 4000, rolloff: 0.7, label: 'thunder' });
      }
    }
  }

  const rendered = await actx.startRendering();
  const out = {
    left: rendered.getChannelData(0),
    right: rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : rendered.getChannelData(0),
    sampleRate: sr,
    seconds,
    mix: m,
    voices: pool ? pool.stats() : null,
    music: music ? music.stats() : null,
    renderMs: +((typeof performance !== 'undefined' ? performance.now() : 0) - t0).toFixed(1),
  };
  out.realtimeFactor = +(out.renderMs / (seconds * 1000)).toFixed(4);
  return out;
}

/** Peak / RMS / centroid / clipping for one channel (or a mid-sum). */
export function metrics(buf, sr, skip = 0.5) {
  const from = Math.min(buf.length - 1, Math.round(skip * sr));
  const view = buf.subarray(from);
  const pk = peakOf(view);
  const r = rms(view);
  let over = 0;
  for (let i = 0; i < view.length; i++) if (Math.abs(view[i]) > 1.0) over++;
  const spec = averageSpectrum(view.length > 65536 ? view.subarray(0, 65536) : view, 2048);
  return {
    peak: +pk.toFixed(5),
    peakDb: +linToDb(pk).toFixed(2),
    rms: +r.toFixed(6),
    rmsDb: +linToDb(r).toFixed(2),
    crestDb: +(linToDb(pk) - linToDb(r)).toFixed(2),
    centroid: +spectralCentroid(spec, sr).toFixed(1),
    samplesOverUnity: over,
    seconds: +(view.length / sr).toFixed(2),
  };
}

/** Energy in octave-ish bands, in dB — a compact spectral fingerprint. */
export const BANDS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export function bandEnergies(buf, sr) {
  const n = Math.min(buf.length, 1 << 17);
  const spec = averageSpectrum(buf.subarray(0, n), 2048);
  const df = sr / ((spec.length - 1) * 2);
  const out = [];
  for (const f of BANDS) {
    const lo = f / Math.SQRT2, hi = f * Math.SQRT2;
    let acc = 0, k = 0;
    for (let i = 1; i < spec.length; i++) {
      const fr = i * df;
      if (fr >= lo && fr < hi) { acc += spec[i] * spec[i]; k++; }
    }
    out.push({ f, db: +linToDb(Math.sqrt(acc / Math.max(1, k))).toFixed(2) });
  }
  return out;
}

/**
 * Log-spaced spectrum for the overlay: `n` points from 20 Hz to 20 kHz, in dB.
 * Averaged over the whole signal so a still frame shows the bed, not one grain.
 */
export function displaySpectrum(buf, sr, n = 128) {
  const len = Math.min(buf.length, 1 << 17);
  const spec = averageSpectrum(buf.subarray(0, len), 4096);
  const df = sr / ((spec.length - 1) * 2);
  const out = new Float32Array(n);
  const f0 = 20, f1 = Math.min(20000, sr / 2);
  for (let i = 0; i < n; i++) {
    const lo = f0 * Math.pow(f1 / f0, i / n);
    const hi = f0 * Math.pow(f1 / f0, (i + 1) / n);
    let acc = 0, k = 0;
    for (let b = Math.max(1, Math.floor(lo / df)); b <= Math.min(spec.length - 1, Math.ceil(hi / df)); b++) {
      acc += spec[b] * spec[b]; k++;
    }
    out[i] = linToDb(Math.sqrt(acc / Math.max(1, k)));
  }
  return out;
}

/** STFT magnitudes in dB — `[frames][bins]`, for drawing a spectrogram. */
export function spectrogram(buf, sr, fftSize = 1024, hop = 512, maxFrames = 512) {
  const frames = [];
  const frame = new Float32Array(fftSize);
  const bins = fftSize / 2 + 1;
  const mag = new Float32Array(bins);
  for (let p = 0; p + fftSize <= buf.length && frames.length < maxFrames; p += hop) {
    frame.set(buf.subarray(p, p + fftSize));
    magSpectrum(frame, mag);
    const row = new Float32Array(bins);
    for (let i = 0; i < bins; i++) row[i] = linToDb(mag[i]);
    frames.push(row);
  }
  return { frames, sampleRate: sr, fftSize, hop, bins };
}

/** Per-bus RMS, by rendering each bus solo. Slow but exact. */
export async function busLevels(state, o = {}) {
  const out = {};
  for (const b of BUSES) {
    const r = await renderState(state, { ...o, seconds: o.seconds ?? 1.6, solo: b.key });
    const m = metrics(r.left, r.sampleRate, 0.4);
    out[b.key] = { rms: m.rms, rmsDb: m.rmsDb, peakDb: m.peakDb, centroid: m.centroid };
  }
  return out;
}

/** Stereo width: correlation of L and R. 1 = mono, 0 = uncorrelated. */
export function correlation(l, r, skip = 0.5, sr = 48000) {
  const from = Math.round(skip * sr);
  let num = 0, dl = 0, dr = 0;
  for (let i = from; i < l.length; i++) { num += l[i] * r[i]; dl += l[i] * l[i]; dr += r[i] * r[i]; }
  return +(num / (Math.sqrt(dl * dr) || 1e-12)).toFixed(4);
}

export default { renderState, metrics, bandEnergies, displaySpectrum, spectrogram, busLevels, correlation, canRenderOffline, clamp };
