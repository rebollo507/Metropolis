import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { HASH, FS_VERT } from './common.glsl.js';

/**
 * Lens + grade, all in linear HDR *before* the single tone-map in OutputPass.
 *
 * Order inside the shader matters and is deliberate:
 *   lens water (refractive offset)  →  chromatic aberration  →  ASC-CDL
 *   (slope/offset/power)  →  saturation  →  log-space contrast  →  vignette.
 *
 * Everything that is physically a *lens* phenomenon happens on the sampling
 * coordinates; everything that is a *film* phenomenon happens on the values.
 * The grade is a real time-of-day LUT in the sense that matters — the CDL
 * coefficients are interpolated between four keyed looks (night / dawn /
 * noon / golden) on `world.time.hours` — but it is evaluated analytically
 * rather than sampled from a 3D texture, because a 32³ LUT is a texture fetch
 * this box does not need to pay for to get the same three knobs.
 *
 * ── R-fx-3: the contrast curve had its pivot in the wrong place ─────────────
 * The old curve encoded to log as (log2(c + 0.0625) + 5)/9 and applied a
 * smoothstep S-curve there. A smoothstep inflects at 0.5, and lc = 0.5 decodes
 * to **0.645 in linear** — roughly 3.6x middle grey. So the "S-curve" was in
 * practice all toe: nearly every pixel in the frame sat below the inflection
 * and was pushed down, and the +0.0625 pedestal made the compression worse the
 * darker the pixel got (scene 0.01 came out at 0.0013, a 7.7x crush). Measured
 * on the composed golden-hour skyline, that took the frame's 1st percentile
 * from 18.8/255 with the composer off to 1.1/255 with it on, and it flattened
 * exactly the shadow end where brick, concrete and glass differ from each
 * other. It is now a pivoted power law about middle grey — monotonic, no
 * pedestal — and the toe and shoulder are left to AgX, which owns them.
 */

const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
${HASH}
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform float uAspect;
uniform float uTime;

uniform vec3  uSlope;
uniform vec3  uOffset;
uniform vec3  uPower;
uniform float uSat;
uniform float uContrast;
uniform float uVignette;
uniform float uCa;
uniform float uPivot;      // middle grey as the camera meters it
uniform float uWet;        // 0..1 lens water
uniform float uSnow;       // 0..1 lens snow

vec2 dropLayer(vec2 uv, float scale, float slide, out float mask) {
  vec2 st = uv * scale;
  st.y += slide;
  vec2 id = floor(st);
  vec2 f = fract(st) - 0.5;
  vec2 h = fx_hash22(id);
  if (h.x < 0.72) { mask = 0.0; return vec2(0.0); }   // sparse: a few beads, not a shower screen
  vec2 c = (h - 0.5) * 0.62;
  float r = 0.09 + 0.13 * h.y;
  vec2 q = (f - c) * vec2(1.0, 1.28);
  float d = length(q);
  float m = smoothstep(r, r * 0.42, d);
  mask = m;
  return normalize(q + 1e-5) * m;
}

void main() {
  vec2 uv = vUv;
  float wetMask = 0.0;

  if (uWet > 0.001) {
    // Water on the front element belongs at the edges of the frame, where a
    // real lens hood stops shedding it — a full-frame bead field reads as a
    // shower door, not as rain.
    vec2 rv = (vUv - 0.5) * vec2(uAspect, 1.0);
    float edge = 0.25 + 0.75 * smoothstep(0.02, 0.30, dot(rv, rv));
    float m1, m2, m3n;
    vec2 n1 = dropLayer(vec2(uv.x * uAspect, uv.y), 11.0, uTime * 0.016, m1);
    vec2 n2 = dropLayer(vec2(uv.x * uAspect, uv.y) + 3.7, 21.0, uTime * 0.045, m2);
    // one fast near-lens streak layer, tall and thin, sliding hard
    vec2 sv = vec2(uv.x * uAspect * 4.0, uv.y * 0.8 - uTime * 0.5);
    vec2 n3 = dropLayer(sv, 1.0, 0.0, m3n);
    float k = uWet * edge;
    vec2 n = (n1 * 0.8 + n2 * 0.5 + n3 * 0.6) * k;
    wetMask = clamp((m1 * 0.8 + m2 * 0.5 + m3n * 0.5) * k, 0.0, 1.0);
    uv -= n * 0.011;
  }

  if (uSnow > 0.001) {
    // out-of-focus flakes drifting across the front element
    vec2 sv = vec2(uv.x * uAspect, uv.y) * 9.0 + vec2(uTime * 0.06, -uTime * 0.11);
    float m;
    dropLayer(sv, 1.0, 0.0, m);
    wetMask = max(wetMask, m * 0.35 * uSnow);
  }

  // chromatic aberration — r^4 so the centre of frame is untouched
  vec2 dir = uv - 0.5;
  float r2 = dot(dir * vec2(uAspect, 1.0), dir * vec2(uAspect, 1.0));
  float amt = uCa * r2 * r2;
  vec3 c;
  c.r = texture2D(tDiffuse, uv - dir * amt).r;
  c.g = texture2D(tDiffuse, uv).g;
  c.b = texture2D(tDiffuse, uv + dir * amt).b;

  // droplets pick up a little light of their own
  c += wetMask * wetMask * 0.045 * (0.5 + 0.5 * fx_luma(c));

  // ---- grade: ASC-CDL -> saturation -> log-space contrast ----
  c = max(c * uSlope + uOffset, 0.0);
  c = pow(c, uPower);
  float l = fx_luma(c);
  c = max(mix(vec3(l), c, uSat), 0.0);

  // Contrast is a gain in log2 about MIDDLE GREY: uPivot is 0.18 divided by the
  // exposure the environment has metered, so the pivot tracks the camera rather
  // than sitting at a fixed scene value. See the header note (R-fx-3).
  c = uPivot * pow(max(c, 0.0) / uPivot, vec3(1.0 + uContrast));

  // ---- vignette (a lens falloff, so a multiply in linear) ----
  vec2 vd = (vUv - 0.5) * vec2(uAspect, 1.0);
  float v = 1.0 - uVignette * smoothstep(0.28, 0.86, dot(vd, vd) * 1.15);
  c *= v;

  gl_FragColor = vec4(c, 1.0);
}
`;

export class GradePass extends Pass {
  constructor(width, height) {
    super();
    this.needsSwap = true;
    this.mat = new THREE.ShaderMaterial({
      name: 'fx.grade',
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
        uAspect: { value: width / height },
        uTime: { value: 0 },
        uSlope: { value: new THREE.Vector3(1, 1, 1) },
        uOffset: { value: new THREE.Vector3(0, 0, 0) },
        uPower: { value: new THREE.Vector3(1, 1, 1) },
        uSat: { value: 1.0 },
        uContrast: { value: 0.18 },
        uVignette: { value: 0.28 },
        uCa: { value: 0.55 },
        uPivot: { value: 0.18 },
        uWet: { value: 0 },
        uSnow: { value: 0 },
      },
      vertexShader: FS_VERT,
      fragmentShader: FRAG,
      depthTest: false, depthWrite: false,
    });
    this._quad = new FullScreenQuad(this.mat);
  }

  setSize(w, h) {
    this.mat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.mat.uniforms.uAspect.value = w / h;
  }

  render(renderer, writeBuffer, readBuffer) {
    this.mat.uniforms.tDiffuse.value = readBuffer.texture;
    if (this.renderToScreen) renderer.setRenderTarget(null);
    else { renderer.setRenderTarget(writeBuffer); renderer.clear(); }
    this._quad.render(renderer);
  }

  dispose() { this.mat.dispose(); this._quad.dispose(); }
}

export default GradePass;
