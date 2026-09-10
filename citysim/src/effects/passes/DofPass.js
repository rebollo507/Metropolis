import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { DEPTH_UTILS, HASH, FS_VERT } from './common.glsl.js';

/**
 * Depth of field — one gather pass, thin-lens circle of confusion from depth.
 *
 * The focus plane is the camera rig's orbit target distance, which is exactly
 * what a player is looking at, and it is the reason this does not need an
 * autofocus heuristic. Strength is driven by the camera preset: none from the
 * air, mild at street level, real at `closeup`/`eyelevel`.
 *
 * Taps are accepted using the scatter-as-gather rule — a neighbour contributes
 * only if *its own* CoC is wide enough to reach this pixel. That is what stops
 * a blurred background bleeding over a sharp foreground silhouette, which is
 * the artefact that makes cheap DOF look like a smear filter.
 */
const TAPS = [
  [0.0, 0.0], [0.53, 0.0], [0.26, 0.46], [-0.26, 0.46], [-0.53, 0.0],
  [-0.26, -0.46], [0.26, -0.46], [1.0, 0.0], [0.5, 0.87], [-0.5, 0.87],
  [-1.0, 0.0], [-0.5, -0.87], [0.5, -0.87], [0.77, 0.44], [-0.77, 0.44],
  [0.0, 1.0], [-0.77, -0.44], [0.77, -0.44], [0.0, -1.0],
];

const FRAG = (N) => /* glsl */`
precision highp float;
varying vec2 vUv;
${DEPTH_UTILS}
${HASH}
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform vec2  uTaps[${N}];
uniform float uFocus;      // metres
uniform float uRange;      // metres of acceptable sharpness
uniform float uMaxCoc;     // pixels
uniform float uFrame;
uniform float uSkyCoc;     // CoC ceiling applied to background

float cocPixels(float dist) {
  float c = (dist - uFocus) / max(0.001, dist);      // signed, thin lens
  c = c * uMaxCoc / max(0.05, uRange / max(1.0, uFocus));
  return clamp(c, -uMaxCoc, uSkyCoc);
}

void main() {
  float dc = fx_rawDepth(vUv);
  float distC = -fx_viewZ(dc);
  float cocC = cocPixels(distC);
  float rC = abs(cocC);

  if (rC < 0.75) { gl_FragColor = texture2D(tDiffuse, vUv); return; }

  float ang = fx_hash12(gl_FragCoord.xy + uFrame * 11.0) * 6.2831853;
  float ca = cos(ang), sa = sin(ang);

  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < ${N}; i++) {
    vec2 t = uTaps[i];
    vec2 rt = vec2(t.x * ca - t.y * sa, t.x * sa + t.y * ca);
    float lenPx = length(rt) * rC;
    vec2 suv = vUv + rt * rC * uTexel;
    vec3 s = texture2D(tDiffuse, suv).rgb;
    float sd = -fx_viewZ(fx_rawDepth(suv));
    float sc = abs(cocPixels(sd));
    // the tap only contributes if its own blur disc reaches this pixel
    float w = clamp((sc - lenPx) * 0.5 + 1.0, 0.0, 1.0);
    // ... and never let a *sharper, nearer* pixel dim a blurred background
    if (sd > distC + 0.5) w = max(w, 0.25);
    sum += s * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / max(1e-4, wsum), 1.0);
}
`;

export class DofPass extends Pass {
  constructor(width, height) {
    super();
    this.needsSwap = true;
    this.mat = new THREE.ShaderMaterial({
      name: 'fx.dof',
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null },
        uNear: { value: 0.5 }, uFar: { value: 12000 },
        uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() },
        uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
        uTaps: { value: TAPS.map((t) => new THREE.Vector2(t[0], t[1])) },
        uFocus: { value: 40 },
        uRange: { value: 30 },
        uMaxCoc: { value: 0 },
        uSkyCoc: { value: 6 },
        uFrame: { value: 0 },
      },
      vertexShader: FS_VERT,
      fragmentShader: FRAG(TAPS.length),
      depthTest: false, depthWrite: false,
    });
    this._quad = new FullScreenQuad(this.mat);
  }

  setSize(w, h) { this.mat.uniforms.uTexel.value.set(1 / w, 1 / h); }

  sync(depthTexture, camera, focus, strength, frame) {
    const u = this.mat.uniforms;
    u.tDepth.value = depthTexture;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uProj.value.copy(camera.projectionMatrix);
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uFocus.value = Math.max(1, focus);
    u.uRange.value = Math.max(2, focus * 0.55);
    u.uMaxCoc.value = 6.5 * strength;
    u.uSkyCoc.value = 4.5 * strength;
    u.uFrame.value = 0;   // frozen tap rotation — no TAA to resolve it
  }

  render(renderer, writeBuffer, readBuffer) {
    this.mat.uniforms.tDiffuse.value = readBuffer.texture;
    if (this.renderToScreen) renderer.setRenderTarget(null);
    else { renderer.setRenderTarget(writeBuffer); renderer.clear(); }
    this._quad.render(renderer);
  }

  dispose() { this.mat.dispose(); this._quad.dispose(); }
}

export default DofPass;
