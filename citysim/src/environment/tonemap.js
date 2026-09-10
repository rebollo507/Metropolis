/**
 * environment/tonemap.js — a JS port of three's `AgXToneMapping`.
 *
 * three applies fog *after* tone mapping and colour-space conversion, so the
 * `fogColor` uniform is a display-referred value. If we handed it raw HDR sky
 * radiance the horizon line would be a hard seam between the tone-mapped sky
 * mesh and the fogged geometry in front of it. Running the same curve on the
 * CPU makes the two agree exactly.
 *
 * Kept byte-for-byte equivalent to ShaderChunk/tonemapping_pars_fragment.
 */

function contrastApprox(x) {
  const x2 = x * x, x4 = x2 * x2;
  return (
    15.5 * x4 * x2 -
    40.14 * x4 * x +
    31.96 * x4 -
    6.868 * x2 * x +
    0.4298 * x2 +
    0.1191 * x -
    0.00232
  );
}

const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;
const INV_EV = 1 / (AGX_MAX_EV - AGX_MIN_EV);
const LOG2 = Math.LN2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Linear sRGB (HDR) → linear sRGB (display referred, 0..1).
 * @param {{r:number,g:number,b:number}} out
 */
export function agxToneMap(r, g, b, exposure, out) {
  r *= exposure; g *= exposure; b *= exposure;

  // linear sRGB → linear Rec.2020
  let x = 0.6274 * r + 0.3293 * g + 0.0433 * b;
  let y = 0.0691 * r + 0.9195 * g + 0.0113 * b;
  let z = 0.0164 * r + 0.0880 * g + 0.8956 * b;

  // AgX inset
  let ix = 0.856627153315983 * x + 0.0951212405381588 * y + 0.0482516061458583 * z;
  let iy = 0.137318972929847 * x + 0.761241990602591 * y + 0.101439036467562 * z;
  let iz = 0.11189821299995 * x + 0.0767994186031903 * y + 0.811302368396859 * z;

  // log2 encode + normalise to the AgX EV window
  ix = clamp01((Math.log(Math.max(ix, 1e-10)) / LOG2 - AGX_MIN_EV) * INV_EV);
  iy = clamp01((Math.log(Math.max(iy, 1e-10)) / LOG2 - AGX_MIN_EV) * INV_EV);
  iz = clamp01((Math.log(Math.max(iz, 1e-10)) / LOG2 - AGX_MIN_EV) * INV_EV);

  ix = contrastApprox(ix);
  iy = contrastApprox(iy);
  iz = contrastApprox(iz);

  // AgX outset
  x = 1.1271005818144368 * ix - 0.11060664309660323 * iy - 0.016493938717834573 * iz;
  y = -0.1413297634984383 * ix + 1.157823702216272 * iy - 0.016493938717834257 * iz;
  z = -0.14132976349843826 * ix - 0.11060664309660294 * iy + 1.2519364065950405 * iz;

  x = Math.pow(Math.max(0, x), 2.2);
  y = Math.pow(Math.max(0, y), 2.2);
  z = Math.pow(Math.max(0, z), 2.2);

  // linear Rec.2020 → linear sRGB
  out.r = clamp01(1.6605 * x - 0.5876 * y - 0.0728 * z);
  out.g = clamp01(-0.1246 * x + 1.1329 * y - 0.0083 * z);
  out.b = clamp01(-0.0182 * x - 0.1006 * y + 1.1187 * z);
  return out;
}

export default agxToneMap;
