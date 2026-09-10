import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { HASH, FS_VERT } from './common.glsl.js';

/**
 * Film grain, applied last (after tone map and after SMAA, so the anti-aliaser
 * never tries to smooth the grain away).
 *
 * "Animated but stable" means two specific things here:
 *  · the grain cell grid is *fixed* in screen space and the seed jumps a long
 *    way every frame, so successive frames are uncorrelated — that is film.
 *    A pattern that slowly translates is what produces the crawling-dither
 *    look, and that is exactly what is avoided.
 *  · grain is value-noise (bilinearly smoothed), roughly 1.4 px per cell, not
 *    per-pixel white noise, so it survives video compression and does not
 *    alias when the window is resized.
 *
 * Amplitude follows a film response curve: strongest in the low-mids, almost
 * nothing in the deep blacks and none in the highlights.
 */
const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
${HASH}
uniform sampler2D tDiffuse;
uniform vec2  uRes;
uniform float uAmount;
uniform vec2  uSeed;
uniform float uSize;

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fx_hash12(i);
  float b = fx_hash12(i + vec2(1.0, 0.0));
  float c = fx_hash12(i + vec2(0.0, 1.0));
  float d = fx_hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  if (uAmount <= 0.0001) { gl_FragColor = vec4(c, 1.0); return; }

  vec2 p = gl_FragCoord.xy / uSize + uSeed;
  float g = vnoise(p) - 0.5;
  g += (vnoise(p * 2.17 + 11.3) - 0.5) * 0.4;      // a second, finer octave

  float l = fx_luma(c);
  float response = smoothstep(0.0, 0.16, l) * (1.0 - smoothstep(0.55, 0.98, l));
  // The floor used to be 0.35, which put ~2/255 of noise into pixels that are
  // themselves 1-2/255 — i.e. the aerial night frame was more grain than city.
  // Film has almost no grain in the toe; so does this now.
  c += g * uAmount * (0.08 + 0.92 * response);

  gl_FragColor = vec4(max(c, 0.0), 1.0);
}
`;

export class GrainPass extends Pass {
  constructor(width, height) {
    super();
    this.needsSwap = true;
    this.mat = new THREE.ShaderMaterial({
      name: 'fx.grain',
      uniforms: {
        tDiffuse: { value: null },
        uRes: { value: new THREE.Vector2(width, height) },
        uAmount: { value: 0.028 },
        uSeed: { value: new THREE.Vector2(0, 0) },
        uSize: { value: 1.4 },
      },
      vertexShader: FS_VERT,
      fragmentShader: FRAG,
      depthTest: false, depthWrite: false,
    });
    this._quad = new FullScreenQuad(this.mat);
    this._n = 0;
  }

  setSize(w, h) { this.mat.uniforms.uRes.value.set(w, h); }

  /** Golden-ratio jump: uncorrelated frame to frame, deterministic given n. */
  advance() {
    this._n = (this._n + 1) % 4096;
    const a = (this._n * 0.7548776662466927) % 1;
    const b = (this._n * 0.5698402909980532) % 1;
    this.mat.uniforms.uSeed.value.set(a * 941.7, b * 673.3);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.mat.uniforms.tDiffuse.value = readBuffer.texture;
    if (this.renderToScreen) renderer.setRenderTarget(null);
    else { renderer.setRenderTarget(writeBuffer); renderer.clear(); }
    this._quad.render(renderer);
  }

  dispose() { this.mat.dispose(); this._quad.dispose(); }
}

export default GrainPass;
