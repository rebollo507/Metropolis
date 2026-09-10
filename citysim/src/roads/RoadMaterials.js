import * as THREE from 'three';

/**
 * Road materials.
 *
 * All of them are plain `MeshStandardMaterial` + `onBeforeCompile` (never a raw
 * ShaderMaterial) so they keep working with the environment module's replaced
 * fog chunks and with `scene.environment` IBL.
 *
 * The asphalt carries a per-vertex `aRoad` attribute:
 *   x = wheel polish   (lane tracks are burnished: smoother, slightly darker)
 *   y = kerbside grime (dust and detritus: lighter, rougher)
 *   z = puddle mask    (gutters and low patches hold water first)
 *
 * `wetness` is a shared uniform driven by `weather:changed`, so a rain front
 * changes the roughness of the whole network without touching geometry.
 */

const ROAD_PATCH_HEAD_V = /* glsl */`
attribute vec3 aRoad;
varying vec3 vRoad;
`;

const ROAD_PATCH_HEAD_F = /* glsl */`
varying vec3 vRoad;
uniform float uWetness;
`;

const ROAD_PATCH_BODY_F = /* glsl */`
  float polish = clamp(vRoad.x, 0.0, 1.0);
  float grime  = clamp(vRoad.y, 0.0, 1.0);
  float pud    = clamp(vRoad.z, 0.0, 1.0);
  float wet    = clamp(uWetness * (0.24 + 0.88 * pud), 0.0, 1.0);

  // burnished wheel tracks: darker and much less rough than fresh chip
  roughnessFactor *= mix(1.0, 0.58, polish);
  diffuseColor.rgb *= mix(1.0, 0.80, polish * 0.75);

  // kerbside grime: pale dust, rougher
  roughnessFactor = mix(roughnessFactor, min(roughnessFactor + 0.16, 1.0), grime);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.11, 1.08, 1.02), grime * 0.55);

  // Water darkens the surface and drops the roughness, but a wet road is not a
  // mirror: a film of water also FILLS the aggregate, so the micro-normal has
  // to flatten too or the specular breaks up into sparkle.
  roughnessFactor = mix(roughnessFactor, 0.13, wet);
  metalnessFactor = mix(metalnessFactor, 0.14, wet);
  diffuseColor.rgb *= mix(1.0, 0.50, wet);
`;

function patchStandard(mat, { head_v = '', body_v = '', head_f = '', body_f = '', norm_f = '', map_f = '' }, uniforms, key) {
  mat.onBeforeCompile = (shader) => {
    for (const k of Object.keys(uniforms)) shader.uniforms[k] = uniforms[k];
    if (head_v) shader.vertexShader = head_v + '\n' + shader.vertexShader;
    if (body_v) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>', '#include <begin_vertex>\n' + body_v);
    }
    if (head_f) shader.fragmentShader = head_f + '\n' + shader.fragmentShader;
    if (body_f) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + body_f);
    }
    if (norm_f) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + norm_f);
    }
    if (map_f) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', map_f);
    }
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

export function makeRoadMaterials(ctx, tex) {
  const wet = { value: 0 };
  const renderer = ctx.renderer;
  const aniso = Math.min(16, renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
  for (const t of [tex.asphaltMap, tex.asphaltNormal, tex.asphaltRough,
    tex.concreteMap, tex.concreteNormal, tex.concreteRough,
    tex.vergeMap, tex.vergeNormal, tex.vergeRough]) {
    if (t) t.anisotropy = aniso;
  }

  /* -------------------------------------------------------------- asphalt -- */
  const road = new THREE.MeshStandardMaterial({
    name: 'roads:asphalt',
    color: 0xffffff,
    map: tex.asphaltMap,
    normalMap: tex.asphaltNormal,
    roughnessMap: tex.asphaltRough,
    roughness: 1.0,
    metalness: 0.0,
    vertexColors: true,
    envMapIntensity: 1.0,
    dithering: true,
  });
  road.normalScale = new THREE.Vector2(0.72, 0.72);
  patchStandard(road, {
    head_v: ROAD_PATCH_HEAD_V,
    body_v: '  vRoad = aRoad;',
    head_f: ROAD_PATCH_HEAD_F,
    body_f: ROAD_PATCH_BODY_F,
    norm_f: '  normal = normalize(mix(normal, nonPerturbedNormal, clamp(wet, 0.0, 1.0) * 0.88));',
  }, { uWetness: wet }, 'roads:asphalt:v1');

  /* ------------------------------------------------------------- concrete -- */
  const walk = new THREE.MeshStandardMaterial({
    name: 'roads:concrete',
    color: 0xffffff,
    map: tex.concreteMap,
    normalMap: tex.concreteNormal,
    roughnessMap: tex.concreteRough,
    roughness: 1.0,
    metalness: 0.0,
    vertexColors: true,
    envMapIntensity: 1.0,
    dithering: true,
  });
  walk.normalScale = new THREE.Vector2(0.62, 0.62);
  patchStandard(walk, {
    head_f: 'uniform float uWetness;',
    body_f: `
  roughnessFactor = mix(roughnessFactor, 0.11, uWetness * 0.85);
  metalnessFactor = mix(metalnessFactor, 0.10, uWetness);
  diffuseColor.rgb *= mix(1.0, 0.62, uWetness * 0.9);
`,
  }, { uWetness: wet }, 'roads:concrete:v1');

  /* ---------------------------------------------------------------- verge -- */
  const verge = new THREE.MeshStandardMaterial({
    name: 'roads:verge',
    color: 0xffffff,
    map: tex.vergeMap,
    normalMap: tex.vergeNormal,
    roughnessMap: tex.vergeRough,
    roughness: 1.0,
    metalness: 0.0,
    vertexColors: true,
    envMapIntensity: 1.0,
    dithering: true,
  });
  verge.normalScale = new THREE.Vector2(0.9, 0.9);
  /* De-tiling. The verge is the nearest surface to camera in the residential
   * frame, so a single UV set reads as a repeating stamp however good the noise
   * is. Blend a second sample at an incommensurate scale and rotation: the
   * combined pattern has no visible period, for one extra fetch on a surface
   * that covers a few percent of the frame. Albedo only — the normal and
   * roughness maps carry no large-scale structure to give the repeat away. */
  const DETILE = `
  vec2 _uvA = vMapUv;
  vec2 _uvB = mat2(0.7373, 0.6755, -0.6755, 0.7373) * vMapUv * 0.4137 + vec2(5.31, 2.17);
  vec4 sampledDiffuseColor = mix(texture2D(map, _uvA), texture2D(map, _uvB), 0.45);
  diffuseColor *= sampledDiffuseColor;
`;
  patchStandard(verge, {
    map_f: DETILE,
    head_f: 'uniform float uWetness;',
    body_f: `
  roughnessFactor = mix(roughnessFactor, 0.42, uWetness * 0.8);
  diffuseColor.rgb *= mix(1.0, 0.60, uWetness * 0.9);
`,
  }, { uWetness: wet }, 'roads:verge:v1');

  /* ------------------------------------------------------------- markings -- */
  const marks = new THREE.MeshStandardMaterial({
    name: 'roads:markings',
    map: tex.markings,
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0.0,
    transparent: true,
    depthWrite: false,
    envMapIntensity: 1.0,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
    side: THREE.FrontSide,
  });
  patchStandard(marks, {
    head_f: 'uniform float uWetness;',
    body_f: `
  roughnessFactor = mix(roughnessFactor, 0.10, uWetness * 0.9);
  diffuseColor.rgb *= mix(1.0, 0.66, uWetness * 0.8);
`,
  }, { uWetness: wet }, 'roads:markings:v1');

  /* --------------------------------------------------------------- decals -- */
  const decal = new THREE.MeshStandardMaterial({
    name: 'roads:decals',
    map: tex.decals,
    color: 0xffffff,
    roughness: 0.62,
    metalness: 0.45,
    alphaTest: 0.5,
    envMapIntensity: 1.0,
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -12,
  });
  patchStandard(decal, {
    head_f: 'uniform float uWetness;',
    body_f: `
  roughnessFactor = mix(roughnessFactor, 0.08, uWetness);
  diffuseColor.rgb *= mix(1.0, 0.6, uWetness * 0.8);
`,
  }, { uWetness: wet }, 'roads:decals:v1');

  return {
    road, walk, verge, marks, decal,
    wetUniform: wet,
    setWetness(v) { wet.value = Math.max(0, Math.min(1, v || 0)); },
    dispose() { for (const m of [road, walk, verge, marks, decal]) m.dispose(); },
  };
}

export default makeRoadMaterials;
