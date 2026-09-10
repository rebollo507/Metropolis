import * as THREE from 'three';

/**
 * The river / sea surface.
 *
 * Round 2 rewrite, against three specific critic findings:
 *
 *  1. *"a hard geometry crease across the surface"* — round 1 displaced the
 *     water plane by a ±0.27 m analytic swell on a 53 m tessellation. That is
 *     pure faceting: the crease WAS the vertex swell. The plane is now dead
 *     flat and every wave lives in the normal map, where it belongs.
 *  2. *"blotchy low-frequency noise that reads as moss"* — the ripple field was
 *     dominated by a 91 m octave. It is now three tighter, wind-aligned scales
 *     with the long one demoted to a slow swell modulation.
 *  3. *"water reflects sky but no buildings"* — the single most-cited water
 *     complaint, and `effects` reports SSR can only reach 1.4% of the waterfront
 *     frame because the sky it needs to reflect is off-screen. So this now runs
 *     a real **planar reflection**: the scene re-rendered from the mirrored
 *     camera with an oblique near plane clipped to the waterline.
 *
 * The reflection pass is budget-guarded — it renders with shadows OFF (the three
 * CSM cascades are ~40% of the scene's draw calls) at a third of the viewport,
 * and is skipped entirely on any frame where no water is under the camera's
 * frustum. See `updateReflection`.
 */

const PARS = /* glsl */`
varying vec3 vWPosW;
varying vec2 vTerrXZ;
varying vec4 vReflUV;
uniform sampler2D uWaterN;
uniform sampler2D uDepthTex;
uniform sampler2D uReflect;
uniform float uReflStrength;
uniform float uReflDistort;
uniform float uTime;
uniform float uSize;
uniform float uHalf;
uniform float uDepthScale;
uniform float uWaveAmp;
uniform vec3  uShallow;
uniform vec3  uDeep;
uniform vec3  uFoamCol;
uniform vec3  uSunDir;
uniform vec3  uSunTint;
uniform float uGlintPow;
uniform float uGlintInt;
uniform float uNight;
uniform vec2  uWind;

float wHash(vec2 p){ p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 34.23); return fract(p.x * p.y * 95.4307); }
float wVal(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0,0.0)), u.x), mix(wHash(i + vec2(0.0,1.0)), wHash(i + vec2(1.0,1.0)), u.x), u.y);
}
`;

const BODY = /* glsl */`
  // Indexed in TERRAIN space, not world space: showcase variants slide the
  // whole group around, and a world-space lookup puts the shoreline foam and the
  // depth ramp tens of metres away from the actual bank.
  vec2 duv = clamp((vTerrXZ + uHalf) / uSize, 0.0015, 0.9985);
  float depth = texture2D(uDepthTex, duv).r * uDepthScale;

  // Everything high-frequency here is procedural, so it has no mip chain of its
  // own: fade it out by distance or it aliases into a moving checkerboard.
  float camDist = length(cameraPosition - vWPosW);
  float detail = 1.0 - smoothstep(70.0, 380.0, camDist);
  float detailMid = 1.0 - smoothstep(220.0, 1100.0, camDist);

  // Wind-aligned wave trains. Round 1 leaned on a 91 m octave and the result
  // read as moss; the long scale now only modulates, it does not draw.
  vec2 wdir = normalize(uWind + vec2(1e-4));
  vec2 wperp = vec2(-wdir.y, wdir.x);
  vec2 flow = uWind * uTime;
  vec2 uvA = vec2(dot(vTerrXZ, wdir) * 0.052, dot(vTerrXZ, wperp) * 0.030) + flow * 0.022;
  vec2 uvB = vec2(dot(vTerrXZ, wdir) * 0.021, dot(vTerrXZ, wperp) * 0.028) - flow * 0.011 + vec2(0.37, 0.11);
  vec2 uvC = vec2(dot(vTerrXZ, wdir) * 0.145, dot(vTerrXZ, wperp) * 0.118) + flow * 0.048 + vec2(0.62, 0.83);
  vec3 t1 = texture2D(uWaterN, uvA).rgb;
  vec3 t2 = texture2D(uWaterN, uvB).rgb;
  vec3 t3 = texture2D(uWaterN, uvC).rgb;
  float swellMod = 0.75 + 0.5 * texture2D(uWaterN, vTerrXZ * 0.0032 + flow * 0.004).b;
  vec2 wRip = ((t1.rg - 0.5) * (0.62 + 0.38 * detailMid)
             + (t2.rg - 0.5) * 0.52
             + (t3.rg - 0.5) * (0.42 * detail)) * swellMod;

  float chop = mix(0.30, 1.0, smoothstep(0.15, 7.0, depth));
  vec3 wN = normalize(vec3(wRip.x * uWaveAmp * chop, 1.0, wRip.y * uWaveAmp * chop));

  float dRamp = smoothstep(0.0, 8.5, depth);
  vec3 col = mix(uShallow, uDeep, dRamp);
  col = mix(col * 1.35 + vec3(0.014, 0.024, 0.018), col, smoothstep(0.0, 2.4, depth));

  // shoreline foam: a soft, broken band rather than a drawn outline
  float band = 1.0 - smoothstep(0.10, 2.9, depth);
  float n1 = wVal(vTerrXZ * 0.085 + vec2(uTime * 0.04, -uTime * 0.02));
  float n2 = wVal(vTerrXZ * 0.34 - vec2(0.0, uTime * 0.09));
  float surge = 0.5 + 0.5 * sin(depth * 3.1 - uTime * 1.05 + n1 * 9.0);
  float foamMod = (0.20 + 0.80 * surge) * (0.40 + 0.80 * n2);
  foamMod = mix(0.62, foamMod, detailMid);
  float foam = clamp(band * foamMod, 0.0, 1.0) * smoothstep(0.0, 0.4, depth) * 0.72;
  col = mix(col, uFoamCol, foam);

  diffuseColor.rgb = col;
  diffuseColor.a = max(mix(0.22, 0.955, smoothstep(0.0, 3.4, depth)), foam * 0.9);
`;

export function buildDepthTexture(world) {
  const T = world.terrain;
  const n = T.resolution, h = T.heights;
  const scale = 25;
  const data = new Uint8Array(n * n * 4);
  for (let k = 0; k < n * n; k++) {
    const d = T.water - h[k];
    data[k * 4] = Math.max(0, Math.min(1, d / scale)) * 255;
    data[k * 4 + 1] = Math.max(0, Math.min(1, (d + 4) / 8)) * 255;
    data[k * 4 + 2] = 0;
    data[k * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  // MUST be mip-mapped: at grazing angles a 4 m/texel depth field aliases hard,
  // and the foam smoothstep turns that aliasing into a visible checkerboard.
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, data, scale };
}

/** Refresh the depth texture over a lattice index box after a height edit. */
export function refreshDepthRegion(world, depth, i0, j0, i1, j1) {
  const T = world.terrain;
  const n = T.resolution, h = T.heights, data = depth.data, scale = depth.scale;
  for (let j = Math.max(0, j0); j <= Math.min(n - 1, j1); j++) {
    for (let i = Math.max(0, i0); i <= Math.min(n - 1, i1); i++) {
      const k = j * n + i;
      const d = T.water - h[k];
      data[k * 4] = Math.max(0, Math.min(1, d / scale)) * 255;
      data[k * 4 + 1] = Math.max(0, Math.min(1, (d + 4) / 8)) * 255;
    }
  }
  depth.tex.needsUpdate = true;
}

export function createWater(world, waterNormalTex, opts = {}) {
  const T = world.terrain;
  const { extent = 3400, segments = 64, reflectTex = null } = opts;
  const depth = buildDepthTexture(world);

  const geo = new THREE.PlaneGeometry(extent, extent, segments, segments);
  geo.rotateX(-Math.PI / 2);

  const uniforms = {
    uWaterN: { value: waterNormalTex },
    uDepthTex: { value: depth.tex },
    uReflect: { value: reflectTex },
    uReflStrength: { value: 0 },
    uReflDistort: { value: 0.055 },
    uTime: { value: 0 },
    uSize: { value: T.size },
    uHalf: { value: T.size / 2 },
    uDepthScale: { value: depth.scale },
    uWaveAmp: { value: 0.62 },
    uShallow: { value: new THREE.Color(0x2f6f6a) },
    uDeep: { value: new THREE.Color(0x0b2733) },
    uFoamCol: { value: new THREE.Color(0xd7e2e0) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.55).normalize() },
    uSunTint: { value: new THREE.Color(0xfff0d8) },
    uGlintPow: { value: 260 },
    uGlintInt: { value: 5.5 },
    uNight: { value: 0 },
    uWind: { value: new THREE.Vector2(0.9, 0.42) },
    uTextureMatrix: { value: new THREE.Matrix4() },
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.04,
    metalness: 0.0,
    // the planar reflection carries the sky now, so the IBL term is pulled well
    // down to stop the two double-counting into a white sheet
    envMapIntensity: 0.42,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  mat.name = 'terrain:water';
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader =
      'varying vec3 vWPosW;\nvarying vec2 vTerrXZ;\nvarying vec4 vReflUV;\n' +
      'uniform float uTime;\nuniform mat4 uTextureMatrix;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       // dead flat: round 1's analytic swell WAS the "hard geometry crease"
       vWPosW = (modelMatrix * vec4(transformed, 1.0)).xyz;
       vTerrXZ = transformed.xz;
       vReflUV = uTextureMatrix * vec4(transformed, 1.0);`
    );

    shader.fragmentShader = PARS + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', BODY);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      'float roughnessFactor = mix(0.028, 0.46, foam) + (1.0 - detailMid) * 0.11;'
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      'normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);'
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `{
         vec3 Vw = normalize(cameraPosition - vWPosW);
         vec3 Hw = normalize(uSunDir + Vw);
         float sp = pow(max(dot(wN, Hw), 0.0), uGlintPow);
         float fres = pow(1.0 - clamp(dot(wN, Vw), 0.0, 1.0), 5.0);

         if (uReflStrength > 0.001) {
           vec2 ruv = vReflUV.xy / max(vReflUV.w, 1e-4);
           ruv += wRip * uReflDistort * (1.0 - smoothstep(120.0, 900.0, camDist) * 0.75);
           vec3 refl = texture2D(uReflect, clamp(ruv, vec2(0.002), vec2(0.998))).rgb;
           float rw = mix(0.045, 0.92, fres) * uReflStrength * (1.0 - foam * 0.85);
           outgoingLight = mix(outgoingLight, refl, clamp(rw, 0.0, 0.95));
         }

         outgoingLight += uSunTint * sp * uGlintInt * (1.0 - foam * 0.7);
         outgoingLight += uSunTint * fres * (0.008 + 0.022 * (1.0 - uNight));
       }
       #include <opaque_fragment>`
    );
  };
  mat.customProgramCacheKey = () => 'terrain-water-v2';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain:water';
  mesh.position.y = T.water;
  mesh.renderOrder = 2;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.frustumCulled = false;

  return { mesh, material: mat, uniforms, depth, depthTex: depth.tex };
}

/* ------------------------------------------------------------------ */
/* planar reflection                                                    */
/* ------------------------------------------------------------------ */

export class PlanarReflection {
  constructor(renderer, waterMesh, uniforms, waterY) {
    this.renderer = renderer;
    this.mesh = waterMesh;
    this.uniforms = uniforms;
    this.waterY = waterY;
    this.enabled = true;
    this.lastCalls = 0;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(160, Math.round(size.x / 3));
    const h = Math.max(90, Math.round(size.y / 3));
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      type: THREE.UnsignedByteType,
    });
    this.rt.texture.name = 'terrain:reflection';
    uniforms.uReflect.value = this.rt.texture;

    this.camera = new THREE.PerspectiveCamera();
    this.textureMatrix = new THREE.Matrix4();
    this._normal = new THREE.Vector3(0, 1, 0);
    this._planePos = new THREE.Vector3(0, waterY, 0);
    this._camPos = new THREE.Vector3();
    this._view = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._rot = new THREE.Matrix4();
    this._plane = new THREE.Plane();
    this._clip = new THREE.Vector4();
    this._q = new THREE.Vector4();
  }

  setSize(w, h) {
    this.rt.setSize(Math.max(160, Math.round(w / 3)), Math.max(90, Math.round(h / 3)));
  }

  /**
   * @returns {boolean} true if the pass ran
   */
  update(scene, camera) {
    if (!this.enabled) { this.uniforms.uReflStrength.value = 0; return false; }

    const normal = this._normal;
    this._planePos.set(this.mesh.position.x, this.mesh.getWorldPosition(this._target).y, 0);
    const planeY = this.mesh.getWorldPosition(this._target).y;
    this._planePos.set(0, planeY, 0);

    this._camPos.setFromMatrixPosition(camera.matrixWorld);
    if (this._camPos.y <= planeY + 0.05) { this.uniforms.uReflStrength.value = 0; return false; }

    const vcam = this.camera;
    const view = this._view.copy(this._planePos).sub(this._camPos);
    view.reflect(normal).negate().add(this._planePos);

    this._rot.extractRotation(camera.matrixWorld);
    this._lookAt.set(0, 0, -1).applyMatrix4(this._rot).add(this._camPos);
    const target = this._target.copy(this._planePos).sub(this._lookAt);
    target.reflect(normal).negate().add(this._planePos);

    vcam.position.copy(view);
    vcam.up.set(0, 1, 0).applyMatrix4(this._rot).reflect(normal);
    vcam.lookAt(target);
    vcam.near = camera.near;
    vcam.far = camera.far;
    vcam.updateMatrixWorld();
    vcam.projectionMatrix.copy(camera.projectionMatrix);

    // texture matrix: clip space → [0,1] uv, applied to the reflector's own
    // object space so a showcase group offset comes along for free
    this.textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0
    );
    this.textureMatrix.multiply(vcam.projectionMatrix);
    this.textureMatrix.multiply(vcam.matrixWorldInverse);
    this.textureMatrix.multiply(this.mesh.matrixWorld);
    this.uniforms.uTextureMatrix.value.copy(this.textureMatrix);

    // oblique near plane clipped to the waterline, so nothing under the surface
    // leaks into its own reflection
    this._plane.setFromNormalAndCoplanarPoint(normal, this._planePos);
    this._plane.applyMatrix4(vcam.matrixWorldInverse);
    const clip = this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const p = vcam.projectionMatrix;
    const q = this._q;
    q.x = (Math.sign(clip.x) + p.elements[8]) / p.elements[0];
    q.y = (Math.sign(clip.y) + p.elements[9]) / p.elements[5];
    q.z = -1.0;
    q.w = (1.0 + p.elements[10]) / p.elements[14];
    clip.multiplyScalar(2.0 / clip.dot(q));
    p.elements[2] = clip.x;
    p.elements[6] = clip.y;
    p.elements[10] = clip.z + 1.0 - 0.004;
    p.elements[14] = clip.w;

    const renderer = this.renderer;
    const prevRT = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.enabled;
    const prevXR = renderer.xr.enabled;
    const callsBefore = renderer.info.render.calls;

    this.mesh.visible = false;
    // The three CSM cascades are ~40% of this project's draw calls and a
    // reflection does not need them: shadow-side facades still read.
    renderer.shadowMap.enabled = false;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    try {
      renderer.render(scene, vcam);
    } finally {
      renderer.setRenderTarget(prevRT);
      renderer.shadowMap.enabled = prevShadow;
      renderer.xr.enabled = prevXR;
      this.mesh.visible = true;
    }

    this.lastCalls = renderer.info.render.calls - callsBefore;
    this.uniforms.uReflStrength.value = 1;
    return true;
  }

  dispose() {
    this.rt.dispose();
  }
}

export default createWater;
