import * as THREE from 'three';

/**
 * The terrain splat material.
 *
 * A `MeshStandardMaterial` patched through `onBeforeCompile` and then handed to
 * `ctx.materials.adopt()`, so `environment`'s CSM cascades and `props`' clustered
 * light pass compose on top of it instead of fighting it.
 *
 * Round 2 rewrite. The round-1 version chose its four layers from slope,
 * altitude and three octaves of noise. That is fine at 30 m and useless at
 * 500 m, because noise has no landform: it looks identical on a ridge nose and
 * in a valley floor, so the mid field washed out to one smooth tone. This
 * version drives the same four layers from a **baked control map**
 * (`ControlMap.js`) carrying flow accumulation, curvature, field parcels and
 * rock exposure, all derived from the heightfield — so every macro feature the
 * shader draws is anchored to the shape of the land:
 *
 *   · drainage lines stay green and damp while the ridge noses between them
 *     go dry and pale — this is what makes gullies read from the air
 *   · rock breaks out on steep convex faces and follows the ridge network
 *   · forest masses on the moist mid-slopes, dark and blue-green
 *   · field parcels quilt the workable flat ground at ~110 m
 *   · hollows darken, noses lighten (curvature as free large-scale AO)
 *
 * All coordinates are TERRAIN space (object space), not world space, so the
 * showcase variants can slide the whole site under a fixed camera without the
 * material sliding off the landform.
 */

const COMMON = /* glsl */`
varying vec3 vTPos;
varying vec3 vTNrm;
`;

const FRAG_PARS = /* glsl */`
uniform sampler2D tGrassA; uniform sampler2D tGrassS;
uniform sampler2D tSoilA;  uniform sampler2D tSoilS;
uniform sampler2D tRockA;  uniform sampler2D tRockS;
uniform sampler2D tSandA;  uniform sampler2D tSandS;
uniform sampler2D tControl;
uniform vec4  uScale;        // 1/metres per layer: grass, soil, rock, sand
uniform float uWaterY;
uniform float uHalfSize;
uniform float uSize;
uniform float uWetness;
uniform float uNrmStr;
uniform float uMacroAmt;

float tHash(vec2 p){
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y * 95.4307);
}
float tVal(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x),
             mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float tFbm(vec2 p){
  const mat2 R = mat2(0.7373, -0.6755, 0.6755, 0.7373);
  float s = 0.0, a = 0.53;
  for (int i = 0; i < 4; i++) { s += a * tVal(p); p = R * p * 2.07 + vec2(1.3, -2.1); a *= 0.5; }
  return s;
}

// The second UV set is both scaled AND rotated: a pure scale change still lines
// its lattice up with the first one, a 37 degree rotation does not.
const mat2 UV_ROT = mat2(0.7986, -0.6018, 0.6018, 0.7986);

void accFlat(sampler2D ta, sampler2D ts, float sc, float k, float w,
             inout vec3 alb, inout float rgh, inout float ao, inout vec3 pert){
  vec2 u1 = vTPos.xz * sc;
  vec2 u2 = (UV_ROT * vTPos.xz) * (sc * 0.2437) + vec2(19.7, 4.3);
  vec3 a = mix(texture2D(ta, u1).rgb, texture2D(ta, u2).rgb, k);
  vec4 s = mix(texture2D(ts, u1), texture2D(ts, u2), k);
  alb  += a * w;
  rgh  += s.b * w;
  ao   += s.a * w;
  pert += vec3(s.r - 0.5, 0.0, s.g - 0.5) * (w * 2.0);
}

void accTri(sampler2D ta, sampler2D ts, float sc, float w, vec3 bw,
            inout vec3 alb, inout float rgh, inout float ao, inout vec3 pert){
  vec2 uy = vTPos.xz * sc;
  vec2 ux = vTPos.zy * sc;
  vec2 uz = vTPos.xy * sc;
  vec4 sy = texture2D(ts, uy), sx = texture2D(ts, ux), sz = texture2D(ts, uz);
  vec3 a = texture2D(ta, uy).rgb * bw.y + texture2D(ta, ux).rgb * bw.x + texture2D(ta, uz).rgb * bw.z;
  vec4 s = sy * bw.y + sx * bw.x + sz * bw.z;
  alb += a * w; rgh += s.b * w; ao += s.a * w;
  vec3 p = vec3(sy.r - 0.5, 0.0, sy.g - 0.5) * bw.y
         + vec3(0.0, sx.g - 0.5, sx.r - 0.5) * bw.x
         + vec3(sz.r - 0.5, sz.g - 0.5, 0.0) * bw.z;
  pert += p * (w * 2.0);
}
`;

const SPLAT = /* glsl */`
  vec3 wp = vTPos;
  vec3 gn = normalize(vTNrm);
  float slope = clamp(1.0 - gn.y, 0.0, 1.0);
  // (1 - cos) badly under-reads a real hillside: a 45 degree face scores only
  // 0.29 on it. The gradient (rise/run) is what rock and woodland actually key
  // off, so thresholds that mean something in degrees use this one.
  float ny = max(gn.y, 1e-3);
  float slopeT = sqrt(max(0.0, 1.0 - ny * ny)) / ny;
  float alt = wp.y - uWaterY;

  /* ---- the landform control map: flow, curvature, parcels, rock ---- */
  vec2 ctlUV = clamp((wp.xz + uHalfSize) / uSize, 0.0015, 0.9985);
  vec4 ctl = texture2D(tControl, ctlUV);
  float chan  = ctl.r;                 // drainage / catchment
  float curv  = ctl.g;                 // 0 concave .. 1 convex
  float parc  = ctl.b;                 // field parcel tone
  float rockX = ctl.a;                 // rock exposure

  float macroL = tFbm(wp.xz * 0.0013);
  float macroM = tFbm(wp.xz * 0.0072 + vec2(31.7, 11.2));
  float macroS = tFbm(wp.xz * 0.031 + vec2(77.0, 13.0));
  float uvMix  = smoothstep(0.30, 0.66, tFbm(wp.xz * 0.028 + vec2(5.0, 9.0)));

  // The baked curvature channel is near-binary on a 4 m field — ridge/hollow
  // reads as a mask, not a gradient. Used raw it drove dryness to 0.87 on every
  // convex hillside and turned the whole range to bare soil, so it is softened
  // hard before it feeds the material and only lightly for the relief shading.
  float curvS = 0.5 + (curv - 0.5) * 0.45;

  // Dryness is a landform quantity, not a noise field: ridge noses (convex, no
  // catchment) bake dry and pale, drainage lines stay damp and green.
  float dry = clamp(0.38
                    + (macroL - 0.50) * 1.30
                    + (curvS - 0.50) * 0.85
                    - chan * 0.80
                    + (parc  - 0.50) * 0.45, 0.0, 1.0);

  /* ---- layer weights ---------------------------------------------- */
  float wRock = clamp(max(smoothstep(0.58, 1.20, slopeT + (macroM - 0.47) * 0.42),
                          rockX * 1.00) - chan * 0.28, 0.0, 1.0);
  float wSand = clamp((1.0 - smoothstep(0.6, 3.4, abs(alt - 0.5)))
                    * (1.0 - smoothstep(0.09, 0.28, slope))
                    * (0.7 + 0.6 * macroM), 0.0, 1.0);
  // higher threshold than round 1: bare soil on flat grass was reading as
  // pink blotches once effects raised saturation
  float wSoil = clamp(smoothstep(0.54, 1.02, dry * 0.95 + slope * 1.20), 0.0, 1.0);

  float rem = 1.0;
  float aR = rem * wRock; rem -= aR;
  float aS = rem * wSand; rem -= aS;
  float aD = rem * wSoil; rem -= aD;
  float aG = rem;

  vec3 splatAlb = vec3(0.0);
  float splatRgh = 0.0;
  float splatAo = 0.0;
  vec3 splatPert = vec3(0.0);

  if (aG > 0.005) accFlat(tGrassA, tGrassS, uScale.x, uvMix, aG, splatAlb, splatRgh, splatAo, splatPert);
  if (aD > 0.005) accFlat(tSoilA,  tSoilS,  uScale.y, uvMix, aD, splatAlb, splatRgh, splatAo, splatPert);
  if (aS > 0.005) accFlat(tSandA,  tSandS,  uScale.w, uvMix, aS, splatAlb, splatRgh, splatAo, splatPert);
  if (aR > 0.005) {
    vec3 bw = abs(gn); bw = bw * bw; bw = bw * bw;
    bw /= (bw.x + bw.y + bw.z + 1e-5);
    accTri(tRockA, tRockS, uScale.z, aR, bw, splatAlb, splatRgh, splatAo, splatPert);
  }

  // Soil blended over grass at LOW weight used to inject its full chroma and
  // read as pink confetti. Pull it toward the neutral of the mix as its weight
  // falls, so the transition passes through olive instead of through salmon.
  float soilChroma = smoothstep(0.10, 0.55, aD);
  float lum = dot(splatAlb, vec3(0.30, 0.59, 0.11));
  splatAlb = mix(splatAlb, mix(vec3(lum), splatAlb, 0.62 + 0.38 * soilChroma),
                 aD * (1.0 - soilChroma) * 0.85);

  /* ---- macro colour, all of it anchored to the landform ------------ */

  // dryness drift
  splatAlb *= mix(vec3(0.84, 1.02, 0.90), vec3(1.18, 1.03, 0.80), dry * uMacroAmt);

  // curvature as free large-scale relief: hollows sink, noses catch the light
  splatAlb *= 0.74 + 0.50 * (0.5 + (curv - 0.5) * 0.70);

  // damp ground along the drainage network
  float damp = smoothstep(0.30, 0.82, chan);
  splatAlb *= mix(vec3(1.0), vec3(0.66, 0.83, 0.64), damp);

  // Forest mass. Woodland sits on the moderate slopes and follows the damp
  // draws; it stops at the tree line and never covers the workable flats — that
  // pattern is most of what makes hill country read as hill country from 600 m.
  float woodPatch = smoothstep(0.40, 0.64, tFbm(wp.xz * 0.0042 + vec2(63.0, 17.0)));
  float forest = woodPatch
               * smoothstep(0.12, 0.46, slopeT + chan * 0.55)
               * (1.0 - smoothstep(0.95, 1.65, slopeT))
               * (1.0 - smoothstep(92.0, 152.0, alt))
               * smoothstep(2.0, 10.0, alt);
  vec3 canopy = vec3(0.041, 0.068, 0.031) * (0.58 + 0.92 * tFbm(wp.xz * 0.075 + vec2(9.0, 3.0)));
  splatAlb = mix(splatAlb, canopy, forest * 0.88);
  splatRgh = mix(splatRgh, 0.95, forest * 0.7);

  // field quilt on workable ground
  float parcAmt = (1.0 - smoothstep(0.10, 0.24, slope)) * (1.0 - forest) * (1.0 - damp);
  vec3 parcTint = mix(vec3(0.78, 0.93, 0.60), vec3(1.18, 1.06, 0.80), parc);
  splatAlb *= mix(vec3(1.0), parcTint, parcAmt * 0.70);

  // Remaining aperiodic mottling, deliberately weak. Measured against the
  // critic's frame, total band-pass detail was already the same as round 1's —
  // what was missing was ORGANISATION, so unorganised noise here is not helping
  // and is actively competing with the landform terms above.
  splatAlb *= 0.90 + 0.20 * tFbm(wp.xz * 0.0031 + vec2(41.0, 3.0));
  splatAlb *= 0.93 + 0.14 * macroS;
  splatAlb *= mix(1.0, clamp(splatAo, 0.0, 1.0), 0.55);

  // silt darkening below the waterline
  float sub = smoothstep(0.3, -2.4, alt);
  splatAlb = mix(splatAlb, splatAlb * vec3(0.46, 0.55, 0.47), sub);
  splatRgh = mix(splatRgh, 0.55, sub * 0.6);

  // Damp soil is darker and a bit glossier; standing water only collects in the
  // genuinely flat hollows.
  float puddle = uWetness * uWetness
               * smoothstep(0.045, 0.006, slope)
               * smoothstep(0.64, 0.50, tFbm(wp.xz * 0.085 + vec2(3.0, 7.0)));
  splatAlb *= mix(1.0, 0.64, uWetness * (1.0 - 0.5 * slope));
  splatRgh *= mix(1.0, 0.74, uWetness);
  splatRgh = mix(splatRgh, 0.10, puddle);

  diffuseColor.rgb *= splatAlb;
`;

export function createTerrainMaterial(layers, controlTex, opts = {}) {
  const {
    waterLevel = 0,
    size = 2048,
    scales = new THREE.Vector4(1 / 4.0, 1 / 3.2, 1 / 6.5, 1 / 2.6),
    normalStrength = 0.95,
  } = opts;

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    // slightly under 1: ground lit only by the sky IBL otherwise reads too blue
    // in shadow, which is the one note the environment builder raised
    envMapIntensity: 0.85,
    dithering: true,
  });
  mat.name = 'terrain:ground';

  const uniforms = {
    tGrassA: { value: layers.grass.albedo }, tGrassS: { value: layers.grass.surf },
    tSoilA: { value: layers.soil.albedo }, tSoilS: { value: layers.soil.surf },
    tRockA: { value: layers.rock.albedo }, tRockS: { value: layers.rock.surf },
    tSandA: { value: layers.sand.albedo }, tSandS: { value: layers.sand.surf },
    tControl: { value: controlTex },
    uScale: { value: scales.clone() },
    uWaterY: { value: waterLevel },
    uHalfSize: { value: size / 2 },
    uSize: { value: size },
    uWetness: { value: 0 },
    uNrmStr: { value: normalStrength },
    uMacroAmt: { value: 1.0 },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = COMMON + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       // TERRAIN space, not world: showcase variants slide the group under a
       // fixed camera and the material must stay welded to the landform
       vTPos = transformed;
       vTNrm = normalize(mat3(modelMatrix) * objectNormal);`
    );

    shader.fragmentShader = COMMON + FRAG_PARS + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', SPLAT);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      'float roughnessFactor = clamp(splatRgh * roughness, 0.045, 1.0);'
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `vec3 nW = normalize(gn + splatPert * uNrmStr);
       normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);`
    );
  };

  // force a distinct program from any other MeshStandardMaterial
  mat.customProgramCacheKey = () => 'terrain-splat-v2';
  return mat;
}

export default createTerrainMaterial;
