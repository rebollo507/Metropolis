/**
 * environment/skyModel.js
 *
 * CPU mirror of the GPU sky. Everything analytic that both the shader and the
 * JavaScript side need lives here so the two can never drift apart:
 *
 *   · solar / lunar position from hour-of-day (real spherical astronomy,
 *     simplified to a circular orbit — accurate enough that the arc, the
 *     azimuth sweep and the day length all behave like a real place)
 *   · the same single-scattering Rayleigh/Mie radiance model the shader runs,
 *     used for fog colour, hemisphere-light colour and `skyColorAt(dir)`
 *   · blackbody colour temperature → linear sRGB
 *
 * Units: metres, radians. Colours are LINEAR sRGB (the renderer converts).
 */

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

/* --------------------------------------------------------------------------
   Site — a mid-latitude northern city. The clock offset stands in for
   longitude-within-timezone plus daylight saving, which is why solar noon is
   at 12:51 rather than 12:00 and the day runs 06:03 → 19:39.
   -------------------------------------------------------------------------- */
export const SITE = {
  latitude: 42.0,        // degrees north
  dayOfYear: 115,        // late April
  clockOffset: 0.85,     // hours; clock time − solar time
};

/**
 * Solar altitude/azimuth for a clock hour.
 * @returns {{alt:number, az:number, decl:number}} radians; az measured from
 *          north, increasing clockwise through east.
 */
export function solarPosition(hours, day = 0, site = SITE) {
  const doy = site.dayOfYear + (day | 0);
  const decl = 23.44 * DEG * Math.sin((2 * Math.PI * (doy - 81)) / 365.2422);
  const H = (hours - site.clockOffset - 12) * 15 * DEG;
  const la = site.latitude * DEG;
  const sinAlt = clamp(Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(H), -1, 1);
  const alt = Math.asin(sinAlt);
  const cosAlt = Math.max(1e-4, Math.cos(alt));
  const cosAz = clamp((Math.sin(decl) - Math.sin(la) * sinAlt) / (Math.cos(la) * cosAlt), -1, 1);
  let az = Math.acos(cosAz);
  if (H > 0) az = 2 * Math.PI - az;
  return { alt, az, decl };
}

/**
 * The moon, treated as a body on a similar arc lagging the sun by ~12.4 h with
 * its own declination. Good enough that it rises in the east, crosses the
 * southern sky and is never in the same place as the sun.
 */
export function lunarPosition(hours, day = 0, site = SITE) {
  // ~4.9 h behind the sun: a waxing gibbous that is high in the west-south-west
  // by 22:00, i.e. actually inside the frame the skyline camera shoots.
  const lag = 5.27 + (day % 29.53) * 0.81;
  const decl = -9.5 * DEG;
  const H = (hours - site.clockOffset - 12 - lag) * 15 * DEG;
  const la = site.latitude * DEG;
  const sinAlt = clamp(Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(H), -1, 1);
  const alt = Math.asin(sinAlt);
  const cosAlt = Math.max(1e-4, Math.cos(alt));
  const cosAz = clamp((Math.sin(decl) - Math.sin(la) * sinAlt) / (Math.cos(la) * cosAlt), -1, 1);
  let az = Math.acos(cosAz);
  if (Math.sin(H) > 0) az = 2 * Math.PI - az;
  return { alt, az };
}

/**
 * alt/az → world direction. Project convention: +Y up, −Z north, +Z south,
 * +X east. Writes into `out` (any {x,y,z}); allocation-free.
 */
export function dirFromAltAz(alt, az, out) {
  const ca = Math.cos(alt);
  out.x = Math.sin(az) * ca;
  out.y = Math.sin(alt);
  out.z = -Math.cos(az) * ca;
  return out;
}

/* --------------------------------------------------------------------------
   Blackbody — Tanner Helland's approximation, then sRGB → linear.
   -------------------------------------------------------------------------- */

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Kelvin → linear sRGB, normalised so the brightest channel is 1. */
export function kelvinToLinearRGB(kelvin, out) {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  r = clamp(r, 0, 255) / 255; g = clamp(g, 0, 255) / 255; b = clamp(b, 0, 255) / 255;
  r = srgbToLinear(r); g = srgbToLinear(g); b = srgbToLinear(b);
  const m = Math.max(r, g, b) || 1;
  out.r = r / m; out.g = g / m; out.b = b / m;
  return out;
}

/* --------------------------------------------------------------------------
   The scattering model — identical maths to sky.glsl.js.
   -------------------------------------------------------------------------- */

const RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const RAY_ZENITH = 8.4e3;
const MIE_ZENITH = 1.25e3;
const CUTOFF = 1.70;   // must match sky.glsl.js
const STEEP = 1.5;
const EE = 1000.0;

const _bR = [0, 0, 0], _bM = [0, 0, 0], _Fex = [0, 0, 0], _Lin = [0, 0, 0];

/**
 * Analytic sky radiance. Mirrors the fragment shader closely enough that fog
 * and ambient always agree with what is on screen.
 */
export class SkyModel {
  constructor() {
    this.sun = { x: 0, y: 1, z: 0 };
    this.turbidity = 2.6;
    this.rayleigh = 2.2;
    this.mieCoefficient = 0.005;
    this.mieG = 0.8;
    this.sunE = 1.0;
    this.skyScale = 1.0;
    this.night = 0;
    this.cityGlow = 0;
    this.overcast = 0;
    this.twilight = 0;
    this.groundAlbedo = [0.15, 0.145, 0.135];
    this.groundBounce = [0.02, 0.018, 0.016];  // set per frame from the real key light
  }

  /**
   * @param {number} dx,dy,dz  normalised view direction
   * @param {{r,g,b}} out      linear radiance (may exceed 1 — it is HDR)
   */
  radiance(dx, dy, dz, out) {
    const sun = this.sun;
    const sunfade = 1 - clamp(1 - Math.exp(sun.y / 0.9), 0, 1);
    const rc = this.rayleigh - 1.0 * (1 - sunfade);
    for (let i = 0; i < 3; i++) _bR[i] = RAYLEIGH[i] * rc;
    const c = 0.2 * this.turbidity * 1e-17;
    for (let i = 0; i < 3; i++) _bM[i] = 0.434 * c * MIE_CONST[i] * this.mieCoefficient;

    const sunE = sunIntensity(sun.y) * this.sunE;

    const vy = Math.max(dy, -0.06);
    const zen = Math.acos(clamp(vy, 0, 1));
    const denom = Math.cos(zen) + 0.15 * Math.pow(Math.max(1e-3, 93.885 - (zen * 180) / Math.PI), -1.253);
    const sR = RAY_ZENITH / denom;
    const sM = MIE_ZENITH / denom;
    for (let i = 0; i < 3; i++) _Fex[i] = Math.exp(-(_bR[i] * sR + _bM[i] * sM));

    const cosT = dx * sun.x + dy * sun.y + dz * sun.z;
    const rPhase = (3 / (16 * Math.PI)) * (1 + Math.pow(cosT * 0.5 + 0.5, 2));
    const g2 = this.mieG * this.mieG;
    const mPhase =
      (1 / (4 * Math.PI)) * ((1 - g2) / Math.pow(Math.max(1e-4, 1 + g2 - 2 * this.mieG * cosT), 1.5));

    // gate identical to sky.glsl.js — see the comment there
    const sunward = Math.pow(clamp(cosT * 0.5 + 0.5, 0, 1), 6);
    const lowView = 1 - smoothstep(0.02, 0.28, dy);
    const mixK = clamp(Math.pow(Math.max(0, 1 - sun.y), 5), 0, 1) * sunward * lowView;
    for (let i = 0; i < 3; i++) {
      const beta = (_bR[i] * rPhase + _bM[i] * mPhase) / (_bR[i] + _bM[i]);
      const a = Math.pow(Math.max(0, sunE * beta * (1 - _Fex[i])), 1.5);
      const b = Math.pow(Math.max(0, sunE * beta * _Fex[i]), 0.5);
      _Lin[i] = a * (1 - mixK + mixK * b);
    }

    const floorK = 1 - this.night;
    let r = (_Lin[0] + 0.1 * _Fex[0] * floorK) * 0.04 * this.skyScale;
    let g = (_Lin[1] + 0.1 * _Fex[1] * floorK) * 0.04 * this.skyScale;
    let b = (_Lin[2] + 0.1 * _Fex[2] * floorK) * 0.04 * this.skyScale;

    // twilight afterglow — mirrors the shader term exactly
    if (this.twilight > 0.0001) {
      const twAmt =
        smoothstep(0.11, -0.02, sun.y) * smoothstep(-0.32, -0.06, sun.y);
      if (twAmt > 0.001) {
        const dl = Math.max(Math.hypot(dx, dz), 1e-4);
        const sl = Math.max(Math.hypot(sun.x, sun.z), 1e-4);
        const sunAz = (dx * sun.x + dz * sun.z) / (dl * sl);
        const band = Math.pow(clamp(1 - Math.abs(dy) * 3.0, 0, 1), 2.5);
        const lobe = Math.pow(clamp(sunAz * 0.5 + 0.5, 0, 1), 3);
        const t = smoothstep(-0.02, -0.22, sun.y);
        const k = twAmt * band * lobe * this.twilight;
        r += (0.95 + (0.52 - 0.95) * t) * k;
        g += (0.34 + (0.30 - 0.34) * t) * k;
        b += (0.11 + (0.52 - 0.11) * t) * k;
        const c = twAmt * band * (1 - lobe) * this.twilight * 0.42;
        r += 0.20 * c; g += 0.20 * c; b += 0.34 * c;
      }
    }

    if (this.night > 0) {
      const t = clamp(dy * 1.9 + 0.08, 0, 1);
      const nr = 0.0125 + (0.0042 - 0.0125) * t;
      const ng = 0.0182 + (0.0068 - 0.0182) * t;
      const nb = 0.0340 + (0.0158 - 0.0340) * t;
      const band = Math.pow(clamp(1 - Math.abs(dy) * 4.2, 0, 1), 2.2);
      const gl = this.cityGlow * band;
      r += (nr + gl * 1.00) * this.night;
      g += (ng + gl * 0.56) * this.night;
      b += (nb + gl * 0.24) * this.night;
    }

    if (this.overcast > 0) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const k = this.overcast * 0.75;
      r += (lum * 1.02 - r) * k;
      g += (lum * 1.01 - g) * k;
      b += (lum * 1.0 - b) * k;
    }

    if (dy < 0) {
      let k = clamp(-dy / 0.30, 0, 1);
      k = k * k * (3 - 2 * k) * 0.92;
      const grade = 0.95 + (0.45 - 0.95) * clamp(-dy * 3, 0, 1);
      r += (this.groundBounce[0] * grade - r) * k;
      g += (this.groundBounce[1] * grade - g) * k;
      b += (this.groundBounce[2] * grade - b) * k;
    }

    out.r = Math.max(0, r); out.g = Math.max(0, g); out.b = Math.max(0, b);
    return out;
  }

  /** Atmospheric transmittance along the sun's own path — the sun's colour. */
  sunTransmittance(out) {
    const sun = this.sun;
    const sunfade = 1 - clamp(1 - Math.exp(sun.y / 0.9), 0, 1);
    const rc = this.rayleigh - 1.0 * (1 - sunfade);
    const c = 0.2 * this.turbidity * 1e-17;
    const vy = Math.max(sun.y, -0.02);
    const zen = Math.acos(clamp(vy, 0, 1));
    const denom = Math.cos(zen) + 0.15 * Math.pow(Math.max(1e-3, 93.885 - (zen * 180) / Math.PI), -1.253);
    const sR = RAY_ZENITH / denom, sM = MIE_ZENITH / denom;
    const v = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const bR = RAYLEIGH[i] * rc;
      const bM = 0.434 * c * MIE_CONST[i] * this.mieCoefficient;
      v[i] = Math.exp(-(bR * sR + bM * sM));
    }
    const m = Math.max(v[0], v[1], v[2]) || 1;
    out.r = v[0] / m; out.g = v[1] / m; out.b = v[2] / m;
    return out;
  }
}

export function sunIntensity(zenithCos) {
  const z = clamp(zenithCos, -1, 1);
  return EE * Math.max(0, 1 - Math.exp(-((CUTOFF - Math.acos(z)) / STEEP)));
}

export default SkyModel;
