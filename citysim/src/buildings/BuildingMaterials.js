import * as THREE from 'three';
import { INTERIOR_CELLS } from './Textures.js';

/**
 * Materials for the buildings module.
 *
 * Opaque surfaces are `MeshStandardMaterial` (safe with environment's global fog
 * chunk override, R-3) carrying a procedural albedo + tangent normal + packed
 * ORM map, with **vertex colours** supplying per-building tint variation so one
 * material serves a whole street without it reading as forty clones. They also
 * carry a small night term — a city makes its own light, and a facade that goes
 * to pure black at 22:00 is photographically wrong even when it is physically
 * defensible.
 *
 * Glass is the material that decides whether a city reads as a render or as a
 * photograph, so it gets three things a flat quad does not have:
 *   · an **interior** behind it (`Textures.interior()`, one atlas cell per pane)
 *   · a per-pane **reflectance** (`aGls.x`) scaling the specular IBL radiance —
 *     a coated curtain-wall pane returns 30-40 % of the sky, a domestic sash 8 %
 *   · a per-pane **roughness** (`aGls.y`) and a fraction of a degree of normal
 *     bow, so a tower's glass face sparkles instead of reading as one sheet
 * plus the `aWin` night attribute — (phase, occupancy class, warmth, special) —
 * that turns windows on from two uniforms with zero per-frame CPU.
 */

/* UV tiling: metres covered by one texture repeat, per slot. */
export const TILE_M = {
  brickRed: 2.0, brickBuff: 2.0, brickDark: 2.0,
  stucco: 3.0, stuccoWarm: 3.0,
  concrete: 3.6, concreteDk: 3.6,
  stone: 2.6,
  metal: 1.8, metalWarm: 1.8,
  shingle: 1.5, tileRoof: 1.6, membrane: 4.0,
  paint: 1.2,
};

export const WALL_SLOTS = [
  'brickRed', 'brickBuff', 'brickDark', 'stucco', 'stuccoWarm',
  'concrete', 'concreteDk', 'stone', 'metal', 'metalWarm',
];
export const ROOF_SLOTS = ['shingle', 'tileRoof', 'membrane'];
export const ALL_SLOTS = [...WALL_SLOTS, ...ROOF_SLOTS, 'paint'];

/* Occupancy classes indexed by aWin.y */
export const OCC = { RES: 0, OFFICE: 1, RETAIL: 2, IND: 3 };

/* Per-pane reflectance presets — the multiplier on specular IBL radiance. */
/*
 * Roughness floor is 0.10, deliberately. Below that the *direct* sun lobe on a
 * pane goes as 1/alpha^2 and a west-facing glass tower at golden hour returns a
 * highlight in the tens of thousands, which overflows the composer's half-float
 * bloom pyramid and takes the whole frame to black. Real architectural glass is
 * never a perfect mirror anyway. The reflection people actually read comes from
 * the multiplier below acting on the *prefiltered* IBL, which is bounded.
 */
export const GLS = {
  curtain: [9.5, 0.100],    // coated curtain wall: a tinted mirror of the sky
  office: [8.0, 0.115],     // punched office glazing, sealed unit
  window: [5.2, 0.140],     // domestic sash / masonry punched window
  shop: [4.0, 0.130],       // shopfront: big pane, kept clean
  rail: [4.0, 0.105],       // glass balustrade
  ind: [3.0, 0.220],        // wired / dirty industrial clerestory
};

/** The reserved "sheet of glass, no room behind it" atlas cell. */
export const CELL_CLEAR = INTERIOR_CELLS * INTERIOR_CELLS - 1;

/** UV rect of one atlas cell for a pane. `k` is any integer-ish selector. */
export function interiorCell(k) {
  const N = INTERIOR_CELLS;
  const i = Math.abs(Math.floor(k)) % (N * N);
  const s = 1 / N;
  // inset a little so bilinear filtering cannot sample the neighbour cell
  const pad = s * 0.035;
  const u = (i % N) * s + pad, v = Math.floor(i / N) * s + pad;
  return [u, v, u + s - pad * 2, v + s - pad * 2];
}

/** Same, but never the reserved clear cell — use this for actual windows. */
export function roomCell(k) {
  const N = INTERIOR_CELLS;
  return interiorCell(Math.abs(Math.floor(k)) % (N * N - 1));
}

/* Per-hour lit probability. Index = hour, wraps. */
const CURVES = {
  // residential: dark at 4am, morning bump, empty-ish midday, big evening peak
  0: [0.10, 0.06, 0.04, 0.03, 0.03, 0.06, 0.22, 0.42, 0.34, 0.20, 0.15, 0.14,
      0.14, 0.14, 0.15, 0.17, 0.24, 0.42, 0.62, 0.76, 0.80, 0.74, 0.52, 0.26],
  // office: lit through the working day, a scatter of late floors, cleaners
  1: [0.05, 0.04, 0.03, 0.03, 0.04, 0.08, 0.18, 0.42, 0.72, 0.88, 0.92, 0.92,
      0.86, 0.90, 0.92, 0.90, 0.86, 0.74, 0.52, 0.36, 0.26, 0.18, 0.12, 0.08],
  // retail: shopfronts blaze while open, security lighting after
  2: [0.10, 0.08, 0.08, 0.08, 0.10, 0.16, 0.36, 0.62, 0.86, 0.95, 0.97, 0.97,
      0.97, 0.97, 0.97, 0.97, 0.97, 0.96, 0.92, 0.82, 0.60, 0.36, 0.20, 0.13],
  // industrial: shift work, never fully dark
  3: [0.22, 0.20, 0.18, 0.18, 0.22, 0.34, 0.52, 0.66, 0.72, 0.74, 0.74, 0.72,
      0.70, 0.72, 0.72, 0.70, 0.64, 0.56, 0.46, 0.40, 0.36, 0.32, 0.24, 0.24],
};

function curveAt(cls, hours) {
  const c = CURVES[cls] || CURVES[0];
  const h = ((hours % 24) + 24) % 24;
  const i = Math.floor(h), f = h - i;
  return c[i] * (1 - f) + c[(i + 1) % 24] * f;
}

const GLASS_PATCH_V = `
attribute vec4 aWin;
attribute vec3 aGls;
varying vec4 vWin;
varying vec3 vGls;
`;
const GLASS_PATCH_F = `
uniform float uNight;
uniform vec4  uOcc;
varying vec4 vWin;
varying vec3 vGls;
`;

const OPAQUE_PATCH_F = `
uniform vec3 uNightUp;
uniform vec3 uNightDn;
`;

export class BuildingMaterials {
  constructor(ctx, textures) {
    this.ctx = ctx;
    this.tex = textures;
    this.slots = new Map();
    this.all = new Set();
    this.opaque = new Set();
    this.uniforms = {
      uNight: { value: 0 },
      uOcc: { value: new THREE.Vector4(0, 0, 0, 0) },
      uNightUp: { value: new THREE.Color(0, 0, 0) },
      uNightDn: { value: new THREE.Color(0, 0, 0) },
    };
    this._envIntensity = 1.0;
    this._night = 0;
    this._wet = 0;
    this._occOverride = null;
  }

  /** A merged-geometry opaque surface material for one slot name. */
  slot(name) {
    if (this.slots.has(name)) return this.slots.get(name);
    const t = this.tex.set(name);
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: t.map,
      normalMap: t.normalMap,
      roughnessMap: t.ormMap,
      metalnessMap: t.ormMap,
      aoMap: t.ormMap,
      aoMapIntensity: 0.85,
      roughness: 1.0,
      metalness: 1.0,
      vertexColors: true,
      envMapIntensity: 1.0,
      dithering: true,
    });
    m.normalScale = new THREE.Vector2(1.0, 1.0);
    m.name = 'buildings:' + name;
    const U = this.uniforms;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uNightUp = U.uNightUp;
      shader.uniforms.uNightDn = U.uNightDn;
      shader.fragmentShader = OPAQUE_PATCH_F + shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // A city makes its own light: cool sky-glow from above, warm sodium
          // and shopfront bounce from below. Zero at noon, and it keeps the
          // albedo legible instead of letting every facade crush to black.
          // NOT normalize(): a degenerate triangle anywhere in the merged chunk
          // gives a zero normal, normalize() turns that into NaN, and a single
          // NaN pixel takes the whole composed frame to black downstream.
          vec3 wN = ( vec4( normal, 0.0 ) * viewMatrix ).xyz;
          float up = 0.5 + 0.5 * wN.y * inversesqrt( max( dot( wN, wN ), 1e-6 ) );
          totalEmissiveRadiance += (0.34 + 0.90 * diffuseColor.rgb)
            * mix( uNightDn, uNightUp, clamp( up, 0.0, 1.0 ) );
        }`
      );
    };
    m.customProgramCacheKey = () => 'buildings-opaque-v3';
    this.slots.set(name, m);
    this.all.add(m);
    this.opaque.add(m);
    return m;
  }

  /** Window / curtain-wall glass with the interior atlas + night-lights patch. */
  glass() {
    if (this._glass) return this._glass;
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.tex.interior(),
      roughness: 0.12,
      metalness: 0.0,          // dielectric: aGls.x carries the coating instead
      vertexColors: true,
      envMapIntensity: 1.0,
      dithering: true,
    });
    m.name = 'buildings:glass';
    const U = this.uniforms;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = U.uNight;
      shader.uniforms.uOcc = U.uOcc;
      shader.vertexShader = GLASS_PATCH_V + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vWin = aWin;\n  vGls = aGls;'
      );
      shader.fragmentShader = GLASS_PATCH_F + shader.fragmentShader
        // keep the raw interior texel: it drives both how much lamplight gets
        // past the blinds and how much of the room is visible by day
        .replace(
          '#include <map_fragment>',
          '#include <map_fragment>\n  vec3 gInt = diffuseColor.rgb;'
        )
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n  roughnessFactor = clamp( vGls.y, 0.10, 1.0 );'
        )
        .replace(
          '#include <lights_fragment_maps>',
          `#include <lights_fragment_maps>
        #if defined( RE_IndirectSpecular )
          {
            // architectural glazing is coated: it returns far more of the sky
            // than a bare dielectric's 4 %, and it returns it tinted
            vec3 gTint = vColor.rgb / max( 1e-4, max( vColor.r, max( vColor.g, vColor.b ) ) );
            // The ceiling is not cosmetic. The environment module keeps its sun
            // disc near the top of the half-float range on purpose; multiplying
            // that by 9.5 overflows to Inf, and one Inf pixel poisons the whole
            // bloom pyramid in effects — the frame comes back black. Tone
            // mapping compresses anything past ~8 anyway, so nothing is lost.
            radiance = min( radiance * vGls.x * mix( vec3( 1.0 ), gTint, 0.5 ), vec3( 40.0 ) );
          }
        #endif
        #if defined( RE_IndirectDiffuse )
          // the room behind the pane is not lit by the sky it is facing
          iblIrradiance *= 0.22;
        #endif`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
        {
          float occ = vWin.y < 0.5 ? uOcc.x : (vWin.y < 1.5 ? uOcc.y : (vWin.y < 2.5 ? uOcc.z : uOcc.w));
          float on  = step(vWin.x, occ);
          // lamp colour is an occupancy signature: homes are tungsten, offices
          // cool fluorescent, shops neutral-bright, industry a cold vapour lamp
          vec3 resC  = mix(vec3(1.00, 0.50, 0.19), vec3(1.00, 0.82, 0.60), vWin.z);
          vec3 offC  = mix(vec3(0.74, 0.86, 1.00), vec3(1.00, 0.98, 0.92), vWin.z);
          vec3 shopC = mix(vec3(1.00, 0.92, 0.78), vec3(0.90, 0.96, 1.00), vWin.z);
          vec3 indC  = mix(vec3(0.72, 0.83, 1.00), vec3(1.00, 0.84, 0.50), vWin.z);
          vec3 lamp  = vWin.y < 0.5 ? resC : (vWin.y < 1.5 ? offC : (vWin.y < 2.5 ? shopC : indC));
          lamp = mix(lamp, vec3(0.32, 0.50, 1.00), step(0.94, vWin.w));   // a television
          float bright = 0.42 + 0.98 * fract(vWin.x * 7.31 + vWin.z * 3.17);
          // shopfronts burn brighter than a flat window — and they are lit
          // through the working day, not only after dark
          float shop = step(0.5, vWin.w) * (1.0 - step(0.94, vWin.w));
          bright *= mix(1.0, 1.30, shop);
          // blinds, curtains and a dark room all cut what reaches the glass
          float thru = 0.34 + 1.30 * clamp(dot(gInt, vec3(0.30, 0.59, 0.11)) * 3.4, 0.0, 1.0);
          // A shop is lit through the working day, not only after dark — that
          // daytime floor is what stops a glazed frontage reading as a black
          // band under its own fascia in a sunlit street.
          float lvl = mix(uNight, max(uNight, 0.225), shop);
          totalEmissiveRadiance += lamp * (on * lvl * bright * thru * 0.74);
        }`
        );
    };
    // distinguish the program from the plain standard material cache
    m.customProgramCacheKey = () => 'buildings-glass-v5';
    this._glass = m;
    this.all.add(m);
    return m;
  }

  /** Shop signage / neon: coloured by day, emissive after dark. */
  sign() {
    if (this._sign) return this._sign;
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.5,
      metalness: 0.0,
      vertexColors: true,
      dithering: true,
    });
    m.name = 'buildings:sign';
    const U = this.uniforms;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = U.uNight;
      shader.fragmentShader = `uniform float uNight;\n` + shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         totalEmissiveRadiance += vColor.rgb * uNight * 1.35;`
      );
    };
    m.customProgramCacheKey = () => 'buildings-sign-v2';
    this._sign = m;
    this.all.add(m);
    return m;
  }

  /**
   * R-sim-4: when `simulation` publishes real occupancy, follow it and keep the
   * built-in curves only as the fallback. `null` clears the override.
   */
  setOccupancy(o) {
    this._occOverride = o && typeof o === 'object' ? o : null;
  }

  /** Called on time:changed. `nightAmount` 0 (day) .. 1 (fully dark). */
  setNight(nightAmount, hours) {
    const n = Math.max(0, Math.min(1, nightAmount));
    this._night = n;
    this.uniforms.uNight.value = n;
    const o = this._occOverride;
    const blend = (cls, key) => {
      const base = curveAt(cls, hours);
      const v = o && Number.isFinite(o[key]) ? o[key] : null;
      // the published figure is a city-wide occupancy, not a lit probability:
      // use it to bend our curve rather than to replace it outright
      return v === null ? base : Math.max(0, Math.min(1, base * 0.45 + v * 0.75));
    };
    this.uniforms.uOcc.value.set(
      blend(OCC.RES, 'res'),
      blend(OCC.OFFICE, 'office'),
      blend(OCC.RETAIL, 'retail'),
      blend(OCC.IND, 'ind')
    );
    // urban skyglow: cool from above, warm street bounce from below
    const k = n * n * (3 - 2 * n);
    // Critic issue 3: at 22:00 the road drops 93x from noon but facades only 4x,
    // so the city reads inverted — bright walls over black streets. `demo`'s
    // NightFill is the larger half of that; this is my half, and it is now about
    // a third of what it was. A facade should sit near the road's level at night,
    // legible but not lit.
    this.uniforms.uNightUp.value.setRGB(0.012 * k, 0.015 * k, 0.026 * k);
    this.uniforms.uNightDn.value.setRGB(0.022 * k, 0.016 * k, 0.010 * k);
    this._applyEnv();
  }

  setEnvMapIntensity(v) {
    this._envIntensity = v;
    this._applyEnv();
  }

  /** Wet surfaces get darker and glossier. */
  setWetness(w) {
    this._wet = Math.max(0, Math.min(1, w));
    for (const m of this.opaque) m.roughness = 1.0 - this._wet * 0.45;
    this._applyEnv();
  }

  _applyEnv() {
    const wet = 1 + this._wet * 0.6;
    // at night the only ambient a facade has is the sky and the city's own
    // glow; lifting IBL keeps it a dark blue mass with readable material
    const night = 1 + this._night * 0.30;
    for (const m of this.opaque) m.envMapIntensity = this._envIntensity * wet * night;
    if (this._glass) this._glass.envMapIntensity = this._envIntensity * wet;
    if (this._sign) this._sign.envMapIntensity = this._envIntensity;
  }

  dispose() {
    for (const m of this.all) m.dispose();
    this.all.clear();
    this.opaque.clear();
    this.slots.clear();
    this._glass = null;
    this._sign = null;
  }
}

export { curveAt };
export default BuildingMaterials;
