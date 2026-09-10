import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FS_VERT, HASH } from './common.glsl.js';

/**
 * Physically-motivated bloom — a mip pyramid with a **clamped** source.
 *
 * ── why this replaces `UnrealBloomPass` (R-env-4 / R-fx-2) ───────────────────
 * `UnrealBloomPass` high-passes at a threshold and blurs whatever is left, with
 * no ceiling on how much energy a single pixel may contribute. `environment`'s
 * sky reached ~5.3e3 relative radiance at golden hour and ~2.8e4 at noon (it now
 * clamps its display output to 1200, which bounds it but does not fix this
 * side). The whole sky also sits *above* any threshold low enough to make
 * windows halate, so the largest mip — which covers the entire frame — was
 * being filled with warm sky radiance and added back over the city. Adding a
 * near-constant warm term to a linear image before a tone map is exactly what
 * lifts the blacks, compresses the contrast and drags every hue toward the
 * veil's own colour: brick, concrete and glass all arrive at the same beige.
 *
 * The fix has three parts, all in the prefilter:
 *   1. **clamp** the source radiance (`uClamp`). A 1200-radiance sun and a
 *      12-radiance sun then paint the same halo. Real veiling glare is a small
 *      fraction of the source; it is not proportional to it without limit.
 *   2. a **soft knee** around the threshold, so the bloom fades in over a stop
 *      rather than switching on at a hard edge (a hard knee is what makes bloom
 *      pop as the sun crosses a roofline).
 *   3. a **Karis average** on the first downsample — weight each tap by
 *      1/(1+luma) — which stops one very bright texel becoming a stable
 *      full-screen flare.
 *
 * ── filter ──────────────────────────────────────────────────────────────────
 * Down: the 13-tap partial-Karis box from Jimenez's SIGGRAPH 2014 course.
 * Up:   a 9-tap tent, accumulated additively into the next larger mip.
 * Both sample at the destination pixel centre with the *source's* texel size,
 * which is what keeps the pyramid aligned; there is no half-texel slop, and no
 * mip is ever assumed to be exactly half of its parent (odd sizes are handled by
 * reading each level's real dimensions).
 */

const PREFILTER = /* glsl */`
precision highp float;
varying vec2 vUv;
${HASH}
uniform sampler2D tSrc;
uniform vec2  uTexel;        // source texel size
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;

vec3 tap(vec2 uv) { return max(texture2D(tSrc, uv).rgb, 0.0); }

void main() {
  vec2 t = uTexel;
  // 13-tap box, partial Karis average: the four inner taps and the corner
  // groups are averaged with a 1/(1+luma) weight so a single firefly cannot
  // dominate the whole pyramid.
  vec3 a = tap(vUv + vec2(-2.0, 2.0) * t), b = tap(vUv + vec2(0.0, 2.0) * t), c = tap(vUv + vec2(2.0, 2.0) * t);
  vec3 d = tap(vUv + vec2(-2.0, 0.0) * t), e = tap(vUv), f = tap(vUv + vec2(2.0, 0.0) * t);
  vec3 g = tap(vUv + vec2(-2.0, -2.0) * t), h = tap(vUv + vec2(0.0, -2.0) * t), i = tap(vUv + vec2(2.0, -2.0) * t);
  vec3 j = tap(vUv + vec2(-1.0, 1.0) * t), k = tap(vUv + vec2(1.0, 1.0) * t);
  vec3 l = tap(vUv + vec2(-1.0, -1.0) * t), m = tap(vUv + vec2(1.0, -1.0) * t);

  vec3 g0 = (j + k + l + m) * 0.25;
  vec3 g1 = (a + b + d + e) * 0.25;
  vec3 g2 = (b + c + e + f) * 0.25;
  vec3 g3 = (d + e + g + h) * 0.25;
  vec3 g4 = (e + f + h + i) * 0.25;
  float w0 = 1.0 / (1.0 + fx_luma(g0)), w1 = 1.0 / (1.0 + fx_luma(g1));
  float w2 = 1.0 / (1.0 + fx_luma(g2)), w3 = 1.0 / (1.0 + fx_luma(g3));
  float w4 = 1.0 / (1.0 + fx_luma(g4));
  vec3 col = (g0 * w0 * 0.5 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.125)
           / (w0 * 0.5 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.125);

  // 1. ceiling on how much energy one pixel may inject into the pyramid
  col = min(col, vec3(uClamp));

  // 2. soft-knee threshold
  float br = max(col.r, max(col.g, col.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = rq * rq / (4.0 * uKnee + 1e-4);
  float wgt = max(rq, br - uThreshold) / max(br, 1e-4);
  gl_FragColor = vec4(col * clamp(wgt, 0.0, 1.0), 1.0);
}
`;

const DOWN = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
vec3 tap(vec2 uv) { return texture2D(tSrc, uv).rgb; }
void main() {
  vec2 t = uTexel;
  vec3 a = tap(vUv + vec2(-2.0, 2.0) * t), b = tap(vUv + vec2(0.0, 2.0) * t), c = tap(vUv + vec2(2.0, 2.0) * t);
  vec3 d = tap(vUv + vec2(-2.0, 0.0) * t), e = tap(vUv), f = tap(vUv + vec2(2.0, 0.0) * t);
  vec3 g = tap(vUv + vec2(-2.0, -2.0) * t), h = tap(vUv + vec2(0.0, -2.0) * t), i = tap(vUv + vec2(2.0, -2.0) * t);
  vec3 j = tap(vUv + vec2(-1.0, 1.0) * t), k = tap(vUv + vec2(1.0, 1.0) * t);
  vec3 l = tap(vUv + vec2(-1.0, -1.0) * t), m = tap(vUv + vec2(1.0, -1.0) * t);
  vec3 col = e * 0.125
    + (a + c + g + i) * 0.03125
    + (b + d + f + h) * 0.0625
    + (j + k + l + m) * 0.125;
  gl_FragColor = vec4(col, 1.0);
}
`;

const UP = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2  uTexel;        // source (smaller) texel size
uniform float uScale;        // tent radius in source texels
uniform float uWeight;
vec3 tap(vec2 uv) { return texture2D(tSrc, uv).rgb; }
void main() {
  vec2 t = uTexel * uScale;
  vec3 col =
      tap(vUv + vec2(-1.0,  1.0) * t) * 1.0 + tap(vUv + vec2(0.0,  1.0) * t) * 2.0 + tap(vUv + vec2(1.0,  1.0) * t) * 1.0
    + tap(vUv + vec2(-1.0,  0.0) * t) * 2.0 + tap(vUv)                        * 4.0 + tap(vUv + vec2(1.0,  0.0) * t) * 2.0
    + tap(vUv + vec2(-1.0, -1.0) * t) * 1.0 + tap(vUv + vec2(0.0, -1.0) * t) * 2.0 + tap(vUv + vec2(1.0, -1.0) * t) * 1.0;
  gl_FragColor = vec4(col * (1.0 / 16.0) * uWeight, 1.0);
}
`;

const COMPOSITE = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float uStrength;
uniform vec3  uTint;
void main() {
  vec3 base = texture2D(tDiffuse, vUv).rgb;
  vec3 bl = max(texture2D(tBloom, vUv).rgb, 0.0);
  gl_FragColor = vec4(base + bl * uStrength * uTint, 1.0);
}
`;

const RT_OPTS = {
  type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace,
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  depthBuffer: false, stencilBuffer: false,
};

export class BloomPass extends Pass {
  /** @param div base mip is width/div; levels is how deep the pyramid goes. */
  constructor(width, height, div = 2, levels = 5) {
    super();
    this.needsSwap = true;
    this.div = div;
    this.levels = levels;
    this.strength = 0.12;
    this.threshold = 1.4;
    this.knee = 0.5;
    this.clampMax = 24;
    this.radius = 0.6;

    this.mips = [];
    this._alloc(width, height);

    const mk = (frag, uniforms) => new THREE.ShaderMaterial({
      name: 'fx.bloom', uniforms, vertexShader: FS_VERT, fragmentShader: frag,
      depthTest: false, depthWrite: false,
    });
    this.preMat = mk(PREFILTER, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 1.4 }, uKnee: { value: 0.5 }, uClamp: { value: 24 },
    });
    this.downMat = mk(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upMat = mk(UP, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
      uScale: { value: 1 }, uWeight: { value: 1 },
    });
    this.upMat.blending = THREE.AdditiveBlending;
    this.upMat.transparent = true;
    this.compMat = mk(COMPOSITE, {
      tDiffuse: { value: null }, tBloom: { value: null },
      uStrength: { value: 0.12 }, uTint: { value: new THREE.Vector3(1, 1, 1) },
    });
    this._quad = new FullScreenQuad(this.preMat);
  }

  _alloc(width, height) {
    for (const m of this.mips) m.dispose();
    this.mips = [];
    let w = Math.max(2, Math.floor(width / this.div));
    let h = Math.max(2, Math.floor(height / this.div));
    for (let i = 0; i < this.levels; i++) {
      const rt = new THREE.WebGLRenderTarget(w, h, RT_OPTS);
      rt.texture.name = `fx.bloom${i}`;
      this.mips.push(rt);
      if (w <= 4 || h <= 4) break;
      w = Math.max(2, Math.floor(w / 2));
      h = Math.max(2, Math.floor(h / 2));
    }
  }

  setSize(w, h) { this._alloc(w, h); }

  render(renderer, writeBuffer, readBuffer) {
    const mips = this.mips;
    const n = mips.length;

    /* ---- prefilter: full-res scene -> mip0 ---- */
    this.preMat.uniforms.tSrc.value = readBuffer.texture;
    this.preMat.uniforms.uTexel.value.set(1 / readBuffer.width, 1 / readBuffer.height);
    this.preMat.uniforms.uThreshold.value = this.threshold;
    this.preMat.uniforms.uKnee.value = Math.max(1e-3, this.knee);
    this.preMat.uniforms.uClamp.value = this.clampMax;
    this._quad.material = this.preMat;
    renderer.setRenderTarget(mips[0]);
    renderer.clear();
    this._quad.render(renderer);

    /* ---- downsample ---- */
    this._quad.material = this.downMat;
    for (let i = 1; i < n; i++) {
      this.downMat.uniforms.tSrc.value = mips[i - 1].texture;
      this.downMat.uniforms.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      renderer.setRenderTarget(mips[i]);
      renderer.clear();
      this._quad.render(renderer);
    }

    /* ---- upsample, additive, small mips first ---- */
    // The accumulation is the blend, so the target must NOT be cleared between
    // draws. EffectComposer already sets autoClear = false for the duration of
    // a pass, but this pass is the one place where relying on that silently
    // would cost the whole pyramid, so it is made explicit.
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    this._quad.material = this.upMat;
    // `radius` trades a tight halation (low) against a broad veil (high). It is
    // deliberately capped well below 1 for daylight looks: the broad term is
    // what washes a frame out.
    this.upMat.uniforms.uScale.value = 0.55 + this.radius * 1.15;
    this.upMat.uniforms.uWeight.value = 0.55 + this.radius * 0.75;
    for (let i = n - 1; i > 0; i--) {
      this.upMat.uniforms.tSrc.value = mips[i].texture;
      this.upMat.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      renderer.setRenderTarget(mips[i - 1]);
      this._quad.render(renderer);          // additive — do NOT clear
    }
    renderer.autoClear = autoClear;

    /* ---- composite ---- */
    this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.compMat.uniforms.tBloom.value = mips[0].texture;
    this.compMat.uniforms.uStrength.value = this.strength;
    this._quad.material = this.compMat;
    if (this.renderToScreen) renderer.setRenderTarget(null);
    else { renderer.setRenderTarget(writeBuffer); renderer.clear(); }
    this._quad.render(renderer);
  }

  dispose() {
    for (const m of this.mips) m.dispose();
    this.preMat.dispose(); this.downMat.dispose(); this.upMat.dispose(); this.compMat.dispose();
    this._quad.dispose();
  }
}

export default BloomPass;
