/**
 * audio/Curves — the time-of-day and weather response, as plain functions.
 *
 * These are the *only* place the module decides how loud a city is at 04:00 or
 * how much of a rain shower reaches a camera 300 m up. Keeping them pure means
 * the offline verification harness can render the exact mix the live app would
 * play at any hour, which is what makes "night floor is N dB below noon" a
 * measurement rather than an anecdote.
 */

import { clamp, lerp, smoothstep } from './Dsp.js';

/** Wrapped distance between two hours, 0..12. */
export const hourDist = (a, b) => {
  const d = Math.abs(((a - b) % 24 + 24) % 24);
  return Math.min(d, 24 - d);
};

const bump = (h, at, width) => Math.exp(-Math.pow(hourDist(h, at) / width, 2));

/**
 * Overall human activity, 0..1. Two commuter peaks, a lunchtime shoulder, a
 * deep trough at 04:00. This drives traffic, chatter and construction alike.
 */
export function activity(h) {
  const base = 0.06
    + 0.62 * bump(h, 8.3, 2.1)
    + 0.70 * bump(h, 17.6, 2.4)
    + 0.42 * bump(h, 12.8, 2.8)
    + 0.20 * bump(h, 21.0, 2.2)
    + 0.06 * bump(h, 2.0, 3.0);
  return clamp(base, 0.05, 1);
}

/** Night-ness: 1 deep at night, 0 in full day. Used for beds, not for light. */
export function nightness(h, isNight) {
  const geo = clamp(1 - smoothstep(5.2, 7.4, h) + smoothstep(18.4, 20.8, h), 0, 1);
  if (isNight === true) return Math.max(geo, 0.55);
  if (isNight === false) return Math.min(geo, 0.45);
  return geo;
}

/** Dawn chorus window — birds, and only birds, own 04:40 to 08:30. */
export function chorus(h) {
  return clamp(bump(h, 6.0, 1.15) * 1.15 + 0.22 * bump(h, 17.9, 1.6), 0, 1);
}

/** Construction hours: nothing hammers at midnight. */
export function worksite(h) {
  return clamp(smoothstep(6.8, 8.0, h) * (1 - smoothstep(17.0, 18.6, h)), 0, 1);
}

/**
 * Altitude blend: 0 at street level, 1 well above the rooftops. Everything that
 * differs between the street mix and the aerial mix keys off this one number.
 */
export function altitude(heightAboveGround) {
  return smoothstep(28, 280, heightAboveGround);
}

/** Rain intensity 0..1 from the weather slice, tolerant of missing fields. */
export function rainAmount(weather) {
  if (!weather) return 0;
  const preset = weather.preset || 'clear';
  const w = Number.isFinite(weather.wetness) ? weather.wetness : 0;
  const byPreset = preset === 'rain' ? 1 : preset === 'overcast' ? 0.10 : preset === 'fog' ? 0.06 : 0;
  return clamp(Math.max(byPreset, w * 0.95), 0, 1);
}

/** Wind 0..1 from m/s, with a floor so a still day is not silent. */
export function windAmount(weather) {
  const s = weather && Number.isFinite(weather.windSpeed) ? weather.windSpeed : 2.4;
  return clamp(0.10 + s / 14, 0, 1);
}

/**
 * Air absorption over distance, as a shelf in dB at 3.2 kHz. A city heard from
 * 300 m has measurably less high frequency in it than the same city from the
 * pavement; this is the number that makes the spectral centroid fall.
 */
export function airTiltDb(alt) {
  return lerp(0, -9.0, alt);
}

export default {
  hourDist, activity, nightness, chorus, worksite,
  altitude, rainAmount, windAmount, airTiltDb,
};
