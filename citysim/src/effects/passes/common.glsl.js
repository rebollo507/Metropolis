/**
 * Shared GLSL fragments for the effects pipeline.
 *
 * Everything downstream of the scene render works from ONE depth texture
 * (`tDepth`, attached to the module's own HDR scene target) plus the camera
 * projection matrices. There is no G-buffer: normals are reconstructed from
 * depth with a 4-tap "closest neighbour" differencing scheme, which is
 * accurate enough for contact AO and for gating wet-surface reflections, and
 * costs one geometry pass less than an override-material normal prepass —
 * which matters a lot on this software-GL box.
 */

/**
 * ── The half-texel rule (R-fx-1) ─────────────────────────────────────────────
 * `tDepth` is the FULL-resolution depth attachment and it is `NearestFilter`
 * (WebGL2 cannot linearly filter a depth texture). A pass that runs at HALF
 * resolution has pixel centres at `(x+0.5)/halfW` = `(2x+1)/fullW` — which is
 * exactly a full-res texel *boundary*. Nearest sampling on a boundary is decided
 * by the last bit of the varying interpolator, so the fetch flips between texel
 * 2x and 2x+1 in a pattern that is fixed in screen space and independent of the
 * scene. That is what produced the one-pixel dark scanlines every 8 rows in
 * every composed frame (R-demo-4): the normal-reconstruction stencil collapsed
 * on those rows, the normal tilted, and the tangent-plane AO samples dived into
 * the surface.
 *
 * So: every half-res pass adds `uUvBias` (= half a FULL-res texel) to `vUv`
 * before any depth fetch. That puts the centre tap and both ± neighbours on
 * unambiguous full-res texel centres with a half-texel margin on either side.
 * Full-res passes are already on centres and need no bias.
 */

/** Depth → view space. Requires uniforms tDepth,uNear,uFar,uProj,uProjInv. */
export const DEPTH_UTILS = /* glsl */`
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
uniform mat4 uProj;
uniform mat4 uProjInv;

float fx_rawDepth(vec2 uv) { return texture2D(tDepth, uv).x; }

/** window depth [0,1] -> view-space z (negative, in metres) */
float fx_viewZ(float d) { return (uNear * uFar) / ((uFar - uNear) * d - uFar); }

/** full unprojection — exact, no ray-scaling approximation */
vec3 fx_viewPos(vec2 uv, float d) {
  vec4 c = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return c.xyz / c.w;
}
vec3 fx_viewPosAt(vec2 uv) { return fx_viewPos(uv, fx_rawDepth(uv)); }

/**
 * Cheap exact unprojection for a SYMMETRIC perspective camera.
 * fx_viewPos costs a mat4 multiply; a horizon trace does 24 of them per pixel.
 * For a symmetric perspective P, ndc.x = P00 * x / -z, so
 * x = ndc.x * (1/P00) * (-z) — two multiplies. uProjInv[0][0] is 1/P00 and
 * uProjInv[1][1] is 1/P11, so this is exact, not an approximation.
 */
vec3 fx_viewPosFast(vec2 uv, float d) {
  float z = fx_viewZ(d);
  return vec3((uv * 2.0 - 1.0) * vec2(uProjInv[0][0], uProjInv[1][1]) * (-z), z);
}

/** project a view-space point back to [0,1] screen uv */
vec3 fx_project(vec3 vp) {
  vec4 c = uProj * vec4(vp, 1.0);
  c.xyz /= max(1e-6, c.w);
  return vec3(c.xy * 0.5 + 0.5, c.z * 0.5 + 0.5);
}
`;

/**
 * Normal from depth. Picks, per axis, whichever neighbour is closest in z so
 * the differencing never straddles a silhouette — that is what stops the AO
 * from drawing a dark outline around every roofline against the sky.
 */
export const NORMAL_FROM_DEPTH = /* glsl */`
vec3 fx_normalFromDepth(vec2 uv, vec3 P, vec2 texel) {
  vec3 l = fx_viewPosAt(uv - vec2(texel.x, 0.0));
  vec3 r = fx_viewPosAt(uv + vec2(texel.x, 0.0));
  vec3 d = fx_viewPosAt(uv - vec2(0.0, texel.y));
  vec3 u = fx_viewPosAt(uv + vec2(0.0, texel.y));
  vec3 dx = (abs(l.z - P.z) < abs(r.z - P.z)) ? (P - l) : (r - P);
  vec3 dy = (abs(d.z - P.z) < abs(u.z - P.z)) ? (P - d) : (u - P);
  vec3 n = cross(dx, dy);
  float len = length(n);
  return len > 1e-9 ? n / len : vec3(0.0, 0.0, 1.0);
}
`;

/** Cheap, stable hashes. No Math.random equivalent on the GPU either. */
export const HASH = /* glsl */`
float fx_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 fx_hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float fx_luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/** The vertex shader every full-screen pass in this module uses. */
export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
