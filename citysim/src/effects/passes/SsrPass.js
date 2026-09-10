import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { DEPTH_UTILS, NORMAL_FROM_DEPTH, HASH, FS_VERT } from './common.glsl.js';

/**
 * Wet-surface screen-space reflections — a deliberately restrained SSR.
 *
 * What it is, precisely, so nobody over-reads it:
 *  · half resolution, linear march in *view* space with a growing stride,
 *    N steps + 4 binary-refinement steps;
 *  · applied ONLY where the depth-reconstructed normal points up
 *    (`dot(N, up) > 0.55`), which is roads, pavement, roofs and flat terrain —
 *    i.e. the surfaces that actually hold water. Building facades get nothing;
 *    without a roughness/metalness G-buffer there is no honest way to know how
 *    reflective a wall is, and guessing looks worse than not doing it.
 *  · weighted by `world.weather.wetness` × Schlick Fresnel, so it is completely
 *    absent in dry weather and strongest at grazing angles, which is the one
 *    thing that reads as "wet" rather than "mirror".
 *  · roughness is faked by widening the colour tap disc with hit distance — a
 *    real roughness-driven cone trace needs a mip chain this box cannot afford.
 *
 * Rays that leave the screen, hit nothing, or point back at the camera fade to
 * zero rather than smearing, so the failure mode is "no reflection", never a
 * streak.
 */

const SSR_FRAG = (STEPS) => /* glsl */`
precision highp float;
varying vec2 vUv;
${DEPTH_UTILS}
${NORMAL_FROM_DEPTH}
${HASH}
uniform sampler2D tColor;
uniform vec2  uTexelFull;
uniform vec2  uUvBias;      // half a FULL-res texel — see common.glsl.js
uniform vec3  uUpView;      // world +Y in view space
uniform float uStride;      // metres per first step
uniform float uGrowth;
uniform float uThickness;   // metres
uniform float uIntensity;
uniform float uMaxDist;
uniform float uFrame;
uniform float uSkyZ;
uniform mat4  uViewInv;     // camera.matrixWorld — view space back to world
uniform float uWaterY;      // world sea level, metres
uniform float uWaterAmt;    // how strongly standing water reflects (0 = off)

void main() {
  // half-res pixel centre -> full-res texel centre (R-fx-1)
  vec2 uv = vUv + uUvBias;

  float d = fx_rawDepth(uv);
  vec3 P = fx_viewPos(uv, d);
  float dist = -P.z;
  if (dist > uSkyZ || dist < 0.05) { gl_FragColor = vec4(0.0); return; }

  vec3 N = fx_normalFromDepth(uv, P, uTexelFull);
  float upness = dot(N, uUpView);
  if (upness < 0.55) { gl_FragColor = vec4(0.0); return; }
  float upW = smoothstep(0.55, 0.85, upness);

  /* Standing water reflects in every weather, not only when it is raining
     (critic issue 8 / R-env-6). There is no roughness G-buffer to tell water
     from asphalt, but water has a property nothing else in the city has: it is
     a horizontal plane at a known world height. So bring the pixel back to
     world space and test its height against sea level. The band is tight
     (0.35 m, feathered to 0.9 m) so a road running near the shore does not
     start behaving like a mirror. */
  float worldY = (uViewInv * vec4(P, 1.0)).y;
  float waterMask = 1.0 - smoothstep(0.35, 0.9, abs(worldY - uWaterY));
  float amount = max(uIntensity, waterMask * uWaterAmt);
  if (amount < 0.01) { gl_FragColor = vec4(0.0); return; }

  vec3 V = normalize(P);                 // eye(0,0,0) -> surface
  vec3 R = reflect(V, N);
  if (R.z > 0.0) { gl_FragColor = vec4(0.0); return; }  // heading behind the eye

  // Schlick, water-on-asphalt F0. Grazing angles carry the effect.
  float ndv = clamp(dot(-V, N), 0.0, 1.0);
  float F = 0.028 + 0.972 * pow(1.0 - ndv, 5.0);

  float jitter = fx_hash12(gl_FragCoord.xy + uFrame * 3.7);
  float t = uStride * (0.5 + jitter);
  float stp = uStride;

  vec2 hitUv = vec2(-1.0);
  float hitT = 0.0;
  vec3 prev = P;

  for (int i = 0; i < ${STEPS}; i++) {
    vec3 rp = P + R * t;
    if (-rp.z > uMaxDist) break;
    vec3 sc = fx_project(rp);
    if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0) break;
    float sd = fx_rawDepth(sc.xy);
    float sz = fx_viewZ(sd);
    if (-sz > uSkyZ) { prev = rp; t += stp; stp *= uGrowth; continue; }
    float delta = sz - rp.z;               // >0 : scene surface is in front of ray
    if (delta > 0.0 && delta < uThickness + stp) {
      // binary refine between prev and rp
      float lo = 0.0, hi = 1.0;
      for (int k = 0; k < 4; k++) {
        float mid = (lo + hi) * 0.5;
        vec3 mp = mix(prev, rp, mid);
        vec3 mc = fx_project(mp);
        float mz = fx_viewZ(fx_rawDepth(mc.xy));
        if (mz - mp.z > 0.0) hi = mid; else lo = mid;
      }
      vec3 fp = mix(prev, rp, hi);
      hitUv = fx_project(fp).xy;
      hitT = length(fp - P);
      break;
    }
    prev = rp;
    t += stp;
    stp *= uGrowth;
  }

  if (hitUv.x < 0.0) { gl_FragColor = vec4(0.0); return; }

  // edge fade — the classic SSR tell is a hard cut at the screen border
  vec2 e = smoothstep(vec2(0.0), vec2(0.12), hitUv) * (1.0 - smoothstep(vec2(0.88), vec2(1.0), hitUv));
  float edge = e.x * e.y;

  // fake roughness: the tap disc widens with travel distance
  float spread = clamp(hitT * 0.0025, 0.0, 0.010);
  vec3 c = texture2D(tColor, hitUv).rgb;
  c += texture2D(tColor, hitUv + vec2(spread, spread * 0.6)).rgb;
  c += texture2D(tColor, hitUv + vec2(-spread * 0.7, spread)).rgb;
  c += texture2D(tColor, hitUv + vec2(spread * 0.3, -spread)).rgb;
  c *= 0.25;

  float distFade = 1.0 - smoothstep(uMaxDist * 0.5, uMaxDist, hitT);
  float w = F * upW * edge * distFade * amount;
  gl_FragColor = vec4(c, clamp(w, 0.0, 1.0));
}
`;

export class SsrPass extends Pass {
  constructor(camera, width, height, steps = 22) {
    super();
    this.camera = camera;
    this.needsSwap = false;
    const hw = Math.max(2, Math.floor(width / 2));
    const hh = Math.max(2, Math.floor(height / 2));
    this.rt = new THREE.WebGLRenderTarget(hw, hh, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    });
    this.rt.texture.name = 'fx.ssr';

    this.mat = new THREE.ShaderMaterial({
      name: 'fx.ssr',
      uniforms: {
        tDepth: { value: null }, tColor: { value: null },
        uNear: { value: 0.5 }, uFar: { value: 12000 },
        uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() },
        uTexelFull: { value: new THREE.Vector2(1 / width, 1 / height) },
        uUvBias: { value: new THREE.Vector2(0.5 / width, 0.5 / height) },
        uUpView: { value: new THREE.Vector3(0, 1, 0) },
        uStride: { value: 0.9 },
        uGrowth: { value: 1.22 },
        uThickness: { value: 1.1 },
        uIntensity: { value: 0.0 },
        uMaxDist: { value: 260 },
        uFrame: { value: 0 },
        uSkyZ: { value: 3000 },
        uViewInv: { value: new THREE.Matrix4() },
        uWaterY: { value: 0 },
        uWaterAmt: { value: 0 },
      },
      vertexShader: FS_VERT,
      fragmentShader: SSR_FRAG(steps),
      depthTest: false, depthWrite: false,
    });
    this._quad = new FullScreenQuad(this.mat);
    this.output = this.rt.texture;
  }

  setSize(w, h) {
    this.rt.setSize(Math.max(2, Math.floor(w / 2)), Math.max(2, Math.floor(h / 2)));
    this.mat.uniforms.uTexelFull.value.set(1 / w, 1 / h);
    this.mat.uniforms.uUvBias.value.set(0.5 / w, 0.5 / h);
  }

  sync(depthTexture, colorTexture, camera, rigDist, wetness, frame, waterY = 0, waterAmt = 0) {
    const u = this.mat.uniforms;
    u.tDepth.value = depthTexture;
    u.tColor.value = colorTexture;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uProj.value.copy(camera.projectionMatrix);
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uUpView.value.set(0, 1, 0).transformDirection(camera.matrixWorldInverse).normalize();
    u.uIntensity.value = wetness;
    u.uViewInv.value.copy(camera.matrixWorld);
    u.uWaterY.value = waterY;
    u.uWaterAmt.value = waterAmt;
    u.uFrame.value = 0;   // frozen jitter — nothing downstream averages it
    const s = THREE.MathUtils.clamp(rigDist * 0.006, 0.35, 3.0);
    u.uStride.value = s;
    u.uThickness.value = s * 1.4 + 0.5;
    u.uMaxDist.value = THREE.MathUtils.clamp(rigDist * 2.2, 90, 900);
    u.uSkyZ.value = Math.max(2500, rigDist * 6);
  }

  render(renderer) {
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    this._quad.render(renderer);
    this.output = this.rt.texture;
  }

  dispose() { this.rt.dispose(); this.mat.dispose(); this._quad.dispose(); }
}

export default SsrPass;
