import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { DEPTH_UTILS, FS_VERT } from './common.glsl.js';

/**
 * Brings the HDR scene colour into the composer chain and folds in the two
 * half-resolution buffers (AO, SSR) with a depth-guided bilateral upsample.
 * Doing all three in one pass means the scene→composer blit is free.
 *
 * AO is applied as a multiply on the ambient-ish part of the image only: full
 * multiplication crushes sunlit asphalt into mud, so the term is lifted toward
 * 1 as pixel luminance rises. That is a hack standing in for a proper split of
 * direct and indirect lighting, and it is the reason the AO reads as contact
 * shading rather than dirt.
 */
const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
${DEPTH_UTILS}
uniform sampler2D tScene;
uniform sampler2D tAo;
uniform sampler2D tSsr;
uniform vec2  uTexelHalf;
uniform float uAoStrength;
uniform float uSsrStrength;
uniform int   uUseAo;
uniform int   uUseSsr;
uniform int   uDebug;    // 0 off, 1 AO, 2 SSR rgb, 3 SSR weight, 4 normal, 5 depth
uniform vec2  uTexelFull;

vec3 fx_normalDebug(vec2 uv, float dist) {
  vec3 P = fx_viewPos(uv, fx_rawDepth(uv));
  vec3 l = fx_viewPosAt(uv - vec2(uTexelFull.x, 0.0));
  vec3 r = fx_viewPosAt(uv + vec2(uTexelFull.x, 0.0));
  vec3 d0 = fx_viewPosAt(uv - vec2(0.0, uTexelFull.y));
  vec3 u0 = fx_viewPosAt(uv + vec2(0.0, uTexelFull.y));
  vec3 dx = (abs(l.z - P.z) < abs(r.z - P.z)) ? (P - l) : (r - P);
  vec3 dy = (abs(d0.z - P.z) < abs(u0.z - P.z)) ? (P - d0) : (u0 - P);
  vec3 n = normalize(cross(dx, dy));
  return n * 0.5 + 0.5;
}

/**
 * Depth-guided bilinear upsample of the half-res AO. The depth weight is
 * relative to the centre distance, for the same reason as the blur: an absolute
 * metre tolerance is far too tight up close and a no-op at city distances.
 */
float upsampleAo(vec2 uv, float centreDist) {
  vec2 hp = uv / uTexelHalf - 0.5;
  vec2 base = floor(hp);
  vec2 f = hp - base;
  float tol = 0.02 * centreDist + 0.10;
  float sum = 0.0, wsum = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 o = base + vec2(float(i), float(j)) + 0.5;
      vec2 suv = o * uTexelHalf;
      vec2 s = texture2D(tAo, suv).rg;
      float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
      float dw = exp(-abs(s.g - centreDist) / tol);
      float w = bw * dw + 1e-4;
      sum += s.r * w; wsum += w;
    }
  }
  return sum / wsum;
}

void main() {
  vec3 col = texture2D(tScene, vUv).rgb;
  float d = fx_rawDepth(vUv);
  float dist = -fx_viewZ(d);

  if (uUseAo == 1) {
    float ao = upsampleAo(vUv, dist);
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    /* AO physically modulates the indirect term only, and there is no
       direct/indirect split here, so a directly-lit pixel is allowed to keep
       some of its energy. Round 2 gave back 30 % of it above a luminance of
       0.8, which on a noon street — where nearly everything is above 0.8 — was
       most of the term. It is 12 % now, and the threshold sits higher, so
       sunlit asphalt does not go muddy but the contact under a car survives. */
    float keep = smoothstep(1.6, 7.0, lum);
    float k = uAoStrength * (1.0 - 0.12 * keep);
    col *= mix(1.0, ao, clamp(k, 0.0, 1.0));
  }

  if (uUseSsr == 1) {
    vec4 r = texture2D(tSsr, vUv);
    float w = r.a * uSsrStrength;
    // energy-conserving-ish: the reflection displaces part of the diffuse
    col = col * (1.0 - w * 0.65) + r.rgb * w;
  }

  if (uDebug == 1) { float ao = upsampleAo(vUv, dist); col = vec3(ao); }
  else if (uDebug == 2) { col = texture2D(tSsr, vUv).rgb; }
  else if (uDebug == 3) { col = vec3(texture2D(tSsr, vUv).a); }
  else if (uDebug == 4) { col = fx_normalDebug(vUv, dist); }
  else if (uDebug == 5) { col = vec3(fract(dist / 50.0)); }

  gl_FragColor = vec4(col, 1.0);
}
`;

export class ResolvePass extends Pass {
  constructor(width, height) {
    super();
    this.needsSwap = true;
    this.mat = new THREE.ShaderMaterial({
      name: 'fx.resolve',
      uniforms: {
        tScene: { value: null }, tAo: { value: null }, tSsr: { value: null },
        tDepth: { value: null },
        uNear: { value: 0.5 }, uFar: { value: 12000 },
        uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() },
        uTexelHalf: { value: new THREE.Vector2(2 / width, 2 / height) },
        uAoStrength: { value: 0.9 },
        uSsrStrength: { value: 1.0 },
        uUseAo: { value: 0 },
        uUseSsr: { value: 0 },
        uDebug: { value: 0 },
        uTexelFull: { value: new THREE.Vector2(1 / width, 1 / height) },
      },
      vertexShader: FS_VERT,
      fragmentShader: FRAG,
      depthTest: false, depthWrite: false,
    });
    this._quad = new FullScreenQuad(this.mat);
  }

  setSize(w, h) {
    const hw = Math.max(2, Math.floor(w / 2)), hh = Math.max(2, Math.floor(h / 2));
    this.mat.uniforms.uTexelHalf.value.set(1 / hw, 1 / hh);
    this.mat.uniforms.uTexelFull.value.set(1 / w, 1 / h);
  }

  sync(camera) {
    const u = this.mat.uniforms;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uProj.value.copy(camera.projectionMatrix);
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
  }

  render(renderer, writeBuffer) {
    if (this.renderToScreen) renderer.setRenderTarget(null);
    else { renderer.setRenderTarget(writeBuffer); renderer.clear(); }
    this._quad.render(renderer);
  }

  dispose() { this.mat.dispose(); this._quad.dispose(); }
}

export default ResolvePass;
