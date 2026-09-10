import * as THREE from 'three';

/**
 * Time-of-day look table.
 *
 * These are keyed *looks*, interpolated on the clock — cool and contrasty at
 * night, warm and open at golden hour, neutral and clean at noon — expressed as
 * ASC-CDL (slope / offset / power) plus saturation, contrast, vignette and
 * chromatic-aberration amount, and the bloom curve that goes with each.
 *
 * ── round 2: what changed and why (R-env-4) ─────────────────────────────────
 * The critic's finding was that the composed golden-hour frame pushed brick
 * red, grey concrete and teal glass to one beige while the un-composed frame
 * separated them cleanly. Two things were doing it, and both are here:
 *
 *  1. **Bloom was veiling.** The threshold sat *below* the sky's own radiance,
 *     so the entire sky filled the pyramid and was added back as a broad warm
 *     term over the city — which lifts blacks, compresses contrast and drags
 *     every hue toward the veil's colour. Thresholds are now above the diffuse
 *     sky at every hour, `bloomClamp` bounds what a single pixel may inject
 *     (see BloomPass), and `bloomRadius` — which is what trades tight halation
 *     against a full-frame veil — is pulled well down in daylight.
 *  2. **The grade was tinting.** A slope of [1.06, 1.00, 0.93] is a ~13 % warm
 *     channel tilt applied to every pixel, on top of a sun that is already
 *     warm. Golden hour should get its warmth from the light, not from a
 *     filter, so the tilt is now ~4 % and saturation carries the look instead.
 *
 * ── night ───────────────────────────────────────────────────────────────────
 * Deep night keys used to *reduce* gain (slope ≈ 0.9) on top of a scene that is
 * already 3-4 stops down, which is why the aerial night frame read as windows
 * floating in void — median pixel 1.4/255. A real photographer opens up at
 * night; the night keys now carry a gain of ~1.9x (about a stop) and a much
 * gentler S-curve, so lamplit tarmac and props' light pools survive to the
 * display instead of being crushed. This is deliberately a *clock-keyed* curve
 * and not an auto-exposure feedback loop: it stays deterministic, which the
 * shot harness and `World.hash()` both depend on.
 */

const K = (h, o) => ({ h, ...o });

const KEYS = [
  K(0.0, {   // deep night — the camera opens up
    slope: [1.78, 1.80, 1.90], offset: [0.000, 0.000, 0.002], power: [1.02, 1.00, 0.98],
    sat: 1.02, contrast: 0.22, vignette: 0.26, ca: 0.45,
    bloomStrength: 1.25, bloomThreshold: 0.16, bloomRadius: 0.56, bloomKnee: 0.12, bloomClamp: 10,
  }),
  K(5.0, {   // pre-dawn blue hour
    slope: [1.58, 1.62, 1.74], offset: [0.000, 0.000, 0.002], power: [1.01, 1.00, 0.99],
    sat: 1.03, contrast: 0.21, vignette: 0.25, ca: 0.45,
    bloomStrength: 0.95, bloomThreshold: 0.20, bloomRadius: 0.55, bloomKnee: 0.15, bloomClamp: 11,
  }),
  K(7.0, {   // low warm sun
    slope: [1.018, 1.000, 0.985], offset: [0.001, 0.000, 0.000], power: [1.00, 1.00, 1.00],
    sat: 1.18, contrast: 0.25, vignette: 0.20, ca: 0.55,
    bloomStrength: 0.085, bloomThreshold: 1.50, bloomRadius: 0.22, bloomKnee: 0.40, bloomClamp: 10,
  }),
  K(11.0, {  // neutral day — a touch of warmth so clear-sky shadows, which the
             // sky IBL renders very blue, do not read as cyan
    slope: [1.012, 1.000, 0.988], offset: [0.000, 0.000, 0.000], power: [1.00, 1.00, 1.00],
    sat: 1.16, contrast: 0.24, vignette: 0.15, ca: 0.32,
    bloomStrength: 0.035, bloomThreshold: 1.25, bloomRadius: 0.14, bloomKnee: 0.35, bloomClamp: 8,
  }),
  K(14.0, {
    slope: [1.012, 1.000, 0.988], offset: [0.000, 0.000, 0.000], power: [1.00, 1.00, 1.00],
    sat: 1.16, contrast: 0.24, vignette: 0.15, ca: 0.32,
    bloomStrength: 0.035, bloomThreshold: 1.25, bloomRadius: 0.14, bloomKnee: 0.35, bloomClamp: 8,
  }),
  K(17.5, {  // late afternoon
    slope: [1.014, 1.000, 0.988], offset: [0.001, 0.000, 0.000], power: [1.00, 1.00, 1.00],
    sat: 1.18, contrast: 0.22, vignette: 0.16, ca: 0.45,
    bloomStrength: 0.075, bloomThreshold: 1.70, bloomRadius: 0.20, bloomKnee: 0.40, bloomClamp: 10,
  }),
  K(18.9, {  // golden hour — warmth comes from the sun, not from a filter
    slope: [1.018, 1.000, 0.984], offset: [0.001, 0.000, 0.000], power: [0.995, 1.00, 1.01],
    sat: 1.20, contrast: 0.215, vignette: 0.16, ca: 0.62,
    bloomStrength: 0.100, bloomThreshold: 2.05, bloomRadius: 0.28, bloomKnee: 0.35, bloomClamp: 9,
  }),
  K(20.3, {  // dusk / blue hour with lights coming on
    slope: [1.30, 1.32, 1.42], offset: [0.000, 0.000, 0.001], power: [1.01, 1.00, 0.99],
    sat: 1.08, contrast: 0.20, vignette: 0.23, ca: 0.45,
    bloomStrength: 0.80, bloomThreshold: 0.35, bloomRadius: 0.52, bloomKnee: 0.20, bloomClamp: 12,
  }),
  K(24.0, {  // wraps to the 0.0 key
    slope: [1.78, 1.80, 1.90], offset: [0.000, 0.000, 0.002], power: [1.02, 1.00, 0.98],
    sat: 1.02, contrast: 0.22, vignette: 0.26, ca: 0.45,
    bloomStrength: 1.25, bloomThreshold: 0.16, bloomRadius: 0.56, bloomKnee: 0.12, bloomClamp: 10,
  }),
];

const lerp = THREE.MathUtils.lerp;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Smooth look-up on the 24 h clock. */
export function lookForHour(hours) {
  const h = ((hours % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const raw = (h - a.h) / Math.max(1e-6, b.h - a.h);
  const t = THREE.MathUtils.clamp(raw, 0, 1);
  const s = t * t * (3 - 2 * t);
  return {
    slope: lerp3(a.slope, b.slope, s),
    offset: lerp3(a.offset, b.offset, s),
    power: lerp3(a.power, b.power, s),
    sat: lerp(a.sat, b.sat, s),
    contrast: lerp(a.contrast, b.contrast, s),
    vignette: lerp(a.vignette, b.vignette, s),
    ca: lerp(a.ca, b.ca, s),
    bloomStrength: lerp(a.bloomStrength, b.bloomStrength, s),
    // thresholds span a decade across the day, so interpolate them in log space
    // — a linear blend between 0.7 and 6.0 spends most of the evening at values
    // that are wrong for both ends.
    bloomThreshold: Math.exp(lerp(Math.log(a.bloomThreshold), Math.log(b.bloomThreshold), s)),
    bloomRadius: lerp(a.bloomRadius, b.bloomRadius, s),
    bloomKnee: lerp(a.bloomKnee, b.bloomKnee, s),
    bloomClamp: lerp(a.bloomClamp, b.bloomClamp, s),
  };
}

/**
 * Weather bends the look: overcast and rain pull saturation and contrast down
 * and cool the midtones; fog flattens contrast hardest and lifts bloom because
 * every light source is scattering into the air around it.
 */
export function applyWeather(look, preset, wetness = 0) {
  const o = { ...look, slope: [...look.slope], offset: [...look.offset], power: [...look.power] };
  const grey = { overcast: 0.5, rain: 0.75, fog: 0.6 }[preset] || 0;
  if (grey > 0) {
    o.sat = lerp(o.sat, 0.90, grey);
    o.contrast = lerp(o.contrast, 0.13, grey * 0.7);
    o.slope[2] *= 1 + 0.04 * grey;
    o.slope[0] *= 1 - 0.02 * grey;
    o.vignette = lerp(o.vignette, o.vignette + 0.06, grey);
  }
  if (preset === 'fog') {
    o.bloomStrength *= 1.35;
    o.bloomThreshold *= 0.75;
    o.bloomRadius = Math.min(0.85, o.bloomRadius + 0.18);
  }
  if (preset === 'rain') {
    o.bloomStrength *= 1.18;   // wet streets throw light back up into the air
    o.bloomThreshold *= 0.85;
  }
  o.wetness = wetness;
  return o;
}

export default { lookForHour, applyWeather };
