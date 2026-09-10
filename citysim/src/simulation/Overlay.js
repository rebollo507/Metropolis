import * as THREE from 'three';
import { signedChamfer } from './Grid.js';
import { SDF_RANGE } from './constants.js';

/**
 * A simulation field, draped over the real terrain. One draw call.
 *
 * The data is a single RGBA DataTexture the size of the field grid:
 *
 *   R  the primary value being drawn        (land value, coverage, pressure…)
 *   G  a secondary value                    (pressure: which zone wins)
 *   B  the "this is city" mask              (so the field stops at the edge of town)
 *   A  signed distance to the edge of the mask, in metres, encoded to ±SDF_RANGE
 *
 * Filtering a *distance* field rather than the mask itself is what gives a clean
 * sub-cell boundary instead of 32 m stair-steps — the same trick the zoning
 * overlay uses, and the reason a 64×64 texture can carry a 1.2 km field without
 * looking like a chessboard.
 *
 * Two things stop it reading as a HUD sticker rather than as part of the world:
 * the UV is domain-warped by a little value noise, so the bilinear diamonds
 * break up into something organic; and its exposure and colour temperature are
 * tied to the hour, exactly as the ground under it is.
 */

const VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWPos;
#include <common>
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWPos = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */`
uniform sampler2D uField;
uniform float uOpacity;
uniform float uTime;
uniform float uMode;         // 0 value ramp, 1 diverging ramp, 2 zone-hued
uniform float uIso;          // isoline strength
uniform float uWarp;         // domain-warp amount, in texels
uniform vec2  uTexel;
uniform vec3  uTint;
uniform float uFloor;        // values below this are transparent
varying vec2 vUv;
varying vec3 vWPos;
#include <common>
#include <fog_pars_fragment>

float hash21( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}
float vnoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = hash21( i ), b = hash21( i + vec2( 1.0, 0.0 ) );
  float c = hash21( i + vec2( 0.0, 1.0 ) ), d = hash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}

/* A sequential ramp that climbs monotonically in luminance and warmth, from a
   near-black indigo through slate and olive to khaki, amber and cream. There is
   no cyan in it on purpose: over a green-and-ochre landscape a cyan low end
   reads as shallow water, and a land-value map that looks like a bathymetric
   chart is not legible, it is just pretty. No hue doubles back, so "brighter and
   warmer" always means "worth more". */
vec3 rampValue( float t ) {
  t = clamp( t, 0.0, 1.0 );
  vec3 c0 = vec3( 0.067, 0.086, 0.141 );
  vec3 c1 = vec3( 0.157, 0.184, 0.267 );
  vec3 c2 = vec3( 0.372, 0.298, 0.361 );
  vec3 c3 = vec3( 0.659, 0.384, 0.278 );
  vec3 c4 = vec3( 0.886, 0.596, 0.231 );
  vec3 c5 = vec3( 0.988, 0.867, 0.514 );
  vec3 c = mix( c0, c1, smoothstep( 0.00, 0.22, t ) );
  c = mix( c, c2, smoothstep( 0.16, 0.46, t ) );
  c = mix( c, c3, smoothstep( 0.40, 0.68, t ) );
  c = mix( c, c4, smoothstep( 0.62, 0.87, t ) );
  c = mix( c, c5, smoothstep( 0.85, 1.00, t ) );
  return c;
}

/* Service coverage, drawn deficit-first.
   The useful question about a coverage map is "where are the holes", so this
   ramp runs hot at LOW coverage — alarm red through orange to amber — and cools
   to a quiet slate where the city is properly served. The alpha rule in main()
   fades the well-served half out too, so the eye lands on the gaps.
   No blue anywhere: over a landscape with a river in it, a blue "good" end
   reads as water and the map says nothing. Red-vs-grey also survives a
   colour-blind reader, which red-vs-green would not. */
vec3 rampDiverge( float t ) {
  t = clamp( t, 0.0, 1.0 );
  vec3 c0 = vec3( 0.902, 0.180, 0.176 );
  vec3 c1 = vec3( 0.918, 0.435, 0.157 );
  vec3 c2 = vec3( 0.812, 0.671, 0.298 );
  vec3 c3 = vec3( 0.451, 0.463, 0.529 );
  vec3 c4 = vec3( 0.290, 0.325, 0.412 );
  vec3 c = mix( c0, c1, smoothstep( 0.00, 0.28, t ) );
  c = mix( c, c2, smoothstep( 0.24, 0.52, t ) );
  c = mix( c, c3, smoothstep( 0.48, 0.78, t ) );
  c = mix( c, c4, smoothstep( 0.74, 1.00, t ) );
  return c;
}

/* Residential green / commercial blue / industrial amber, muted so the field
   still sits under the city rather than on top of it. */
vec3 rampZone( float z ) {
  vec3 r = vec3( 0.180, 0.620, 0.290 );
  vec3 c = vec3( 0.145, 0.435, 0.850 );
  vec3 i = vec3( 0.910, 0.560, 0.090 );
  vec3 col = mix( r, c, smoothstep( 0.15, 0.5, z ) );
  col = mix( col, i, smoothstep( 0.55, 0.9, z ) );
  return col;
}

void main() {
  // domain warp: two octaves of value noise, in texel units
  vec2 wp = vWPos.xz;
  float n1 = vnoise( wp * 0.021 ) - 0.5;
  float n2 = vnoise( wp * 0.061 + 17.3 ) - 0.5;
  vec2 warp = vec2( n1, n2 ) * uTexel * uWarp;
  vec2 uv = vUv + warp;

  vec4 d = texture2D( uField, uv );
  float value = d.r;
  float second = d.g;
  float mask = d.b;
  float sdf = ( d.a * 2.0 - 1.0 ) * ${SDF_RANGE.toFixed(1)};
  float inside = smoothstep( -14.0, 10.0, sdf );
  if ( inside <= 0.004 ) discard;

  bool isCoverage = ( uMode > 0.5 && uMode < 1.5 );
  vec3 col;
  if ( uMode < 0.5 )      col = rampValue( value );
  else if ( uMode < 1.5 ) col = rampDiverge( value );
  // In zone mode the hue says *which* use wants the ground and the brightness
  // says how badly — hue alone leaves a flat wash that cannot be read.
  else                    col = rampZone( second ) * ( 0.16 + 1.25 * value );

  // ---- isolines ----------------------------------------------------------
  // Contours at every 0.1, a heavier one at every 0.25. Width is set from the
  // screen-space derivative so they stay one pixel wide from any altitude and
  // simply fade away when the camera is too far for them to mean anything.
  float band = value * 10.0;
  float fw = fwidth( band );
  float line = 1.0 - abs( fract( band ) * 2.0 - 1.0 );
  line = 1.0 - smoothstep( 0.0, max( fw * 2.2, 0.06 ), line );
  float band4 = value * 4.0;
  float fw4 = fwidth( band4 );
  float major = 1.0 - abs( fract( band4 ) * 2.0 - 1.0 );
  major = 1.0 - smoothstep( 0.0, max( fw4 * 2.2, 0.05 ), major );
  float lineFade = 1.0 - smoothstep( 0.10, 0.34, fw );
  // Gate the contours on the same window the fill uses. Without this the 0.0
  // contour is "on" across every cell the stretch clamped to zero — i.e. all
  // the open country outside town — and the map grows a set of beautiful,
  // completely meaningless rings out in the hills.
  float valGate = isCoverage
    ? ( 1.0 - smoothstep( 0.96, 1.0, value ) )
    : smoothstep( uFloor, uFloor + 0.10, value ) * ( 1.0 - smoothstep( 0.982, 1.0, value ) );
  float iso = clamp( ( line * 0.5 + major * 0.9 ) * lineFade * uIso * valGate
    * clamp( mask * 1.6, 0.0, 1.0 ) * ( isCoverage ? 1.0 : ( 0.30 + 0.70 * value ) ), 0.0, 1.0 );

  // The edge of the built-up area, as a thin bright line at the zero crossing
  // of the distance field. Without it the field trails off into the landscape
  // and reads as haze; with it the diagram has a stated extent.
  float edge = 1.0 - smoothstep( 0.0, 26.0, abs( sdf + 8.0 ) );
  edge *= 0.9;

  // a whisper of ground texture so the field is not a dead flat wash
  float grain = vnoise( wp * 0.42 ) * 0.5 + vnoise( wp * 1.9 ) * 0.5;
  col *= 0.94 + grain * 0.12;
  col = mix( col, mix( col, vec3( 1.0 ), 0.55 ) * 1.05, iso );
  col = mix( col, mix( col, vec3( 1.0 ), 0.42 ), edge * 0.7 );

  // The mask only *modulates* coverage — the edge of the field is the signed
  // distance, not the mask, or the periphery goes see-through and the diagram
  // stops reading as a single body of land.
  // Opacity tracks the value. A heat field whose cold end is as opaque as its
  // hot end is not a heat field, it is a tarpaulin: the eye has to be able to
  // see the ground it is reading about, and "not much here" should look like
  // not much here.
  float a = uOpacity * inside * ( 0.55 + 0.45 * clamp( mask * 1.4, 0.0, 1.0 ) );
  if ( isCoverage ) {
    // coverage runs the other way: a well-served cell gets out of the way
    a *= mix( 1.0, 0.26, smoothstep( 0.30, 0.96, value ) );
  } else {
    a *= mix( 0.14, 1.0, smoothstep( 0.04, 0.66, value ) );
    a *= smoothstep( uFloor, uFloor + 0.10, value );
  }
  a = clamp( a + iso * 0.26 * uOpacity * inside + edge * 0.30 * uOpacity, 0.0, 0.97 );

  gl_FragColor = vec4( col * uTint, a );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class FieldOverlay {
  constructor(ctx, grid) {
    this.ctx = ctx;
    this.grid = grid;
    this.mesh = null;
    this.material = null;
    this.enabled = false;
    this.baseOpacity = 0.80;
    this.timeAlpha = 1;
    this.data = new Uint8Array(grid.n * 4);
    this.tex = null;
    this._sdf = new Float32Array(grid.n);
    this._mask = new Uint8Array(grid.n);
  }

  _makeTexture() {
    const t = new THREE.DataTexture(this.data, this.grid.w, this.grid.h,
      THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.NoColorSpace;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    this.tex = t;
    return t;
  }

  /**
   * Upload a field.
   * @param value   Float32Array, the primary channel (already 0..1)
   * @param mask    Float32Array 0..1 — where the city is
   * @param second  Float32Array 0..1 or null — the zone selector for mode 2
   */
  setField(value, mask, second = null) {
    const g = this.grid, n = g.n;
    const m = this._mask;
    for (let i = 0; i < n; i++) m[i] = mask[i] > 0.06 ? 1 : 0;
    signedChamfer(m, g.w, g.h, g.cellSize, this._sdf);
    const d = this.data;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      d[o] = clamp255(value[i] * 255);
      d[o + 1] = clamp255((second ? second[i] : 0) * 255);
      d[o + 2] = clamp255(Math.min(1, mask[i]) * 255);
      const s = Math.max(-SDF_RANGE, Math.min(SDF_RANGE, this._sdf[i]));
      d[o + 3] = clamp255((s / SDF_RANGE * 0.5 + 0.5) * 255);
    }
    if (!this.tex) this._makeTexture(); else this.tex.needsUpdate = true;
    return this;
  }

  /** Build the terrain-conforming carrier over `area = {x0,z0,x1,z1}`. */
  build(area, terrain, waterLevel = 0) {
    if (this.mesh) this.disposeMesh();
    if (!this.tex) this._makeTexture();
    const g = this.grid;
    const pad = 90;
    const half = g.size / 2;
    const x0 = Math.max(-half + 2, area.x0 - pad), x1 = Math.min(half - 2, area.x1 + pad);
    const z0 = Math.max(-half + 2, area.z0 - pad), z1 = Math.min(half - 2, area.z1 + pad);
    const W = Math.max(100, x1 - x0), H = Math.max(100, z1 - z0);
    const step = 6.0;
    const nx = Math.max(12, Math.min(220, Math.round(W / step)));
    const nz = Math.max(12, Math.min(220, Math.round(H / step)));

    const geo = new THREE.PlaneGeometry(W, H, nx, nz);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx, z = pos.getZ(i) + cz;
      const y = terrain ? terrain.heightAt(x, z) : 0;
      pos.setX(i, x); pos.setZ(i, z);
      pos.setY(i, Math.max(y, waterLevel) + 0.55);
      uv.setXY(i, (x - g.origin) / g.size, (z - g.origin) / g.size);
    }
    pos.needsUpdate = true; uv.needsUpdate = true;
    geo.computeBoundingSphere(); geo.computeBoundingBox();

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uField: { value: null },
          uOpacity: { value: this.baseOpacity },
          uTime: { value: 0 },
          uMode: { value: 0 },
          uIso: { value: 0.85 },
          uWarp: { value: 0.9 },
          uTexel: { value: new THREE.Vector2(1 / g.w, 1 / g.h) },
          uTint: { value: new THREE.Color(1, 1, 1) },
          uFloor: { value: 0.02 },
        },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: true,
      side: THREE.DoubleSide,
    });
    this.material.uniforms.uField.value = this.tex;

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'simulation:field';
    this.mesh.renderOrder = 6;
    this.mesh.frustumCulled = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.visible = this.enabled;
    return this.mesh;
  }

  setMode(mode) { if (this.material) this.material.uniforms.uMode.value = mode; return this; }
  setIso(v) { if (this.material) this.material.uniforms.uIso.value = v; return this; }
  setFloor(v) { if (this.material) this.material.uniforms.uFloor.value = v; return this; }
  setOpacity(v) { this.baseOpacity = v; this._applyOpacity(); return this; }
  setEnabled(v) {
    this.enabled = !!v;
    if (this.mesh) this.mesh.visible = this.enabled;
    return this.enabled;
  }
  _applyOpacity() {
    if (this.material) this.material.uniforms.uOpacity.value = this.baseOpacity * this.timeAlpha;
  }

  /**
   * A diagram painted on the ground still has to live in the scene's light: if
   * it keeps its noon exposure at 18:45 it stops being part of the city and
   * starts being a HUD.
   */
  setTime(hours, payload = null) {
    if (!this.material) return;
    const elev = Math.cos(((hours - 12.8) / 6.6) * (Math.PI / 2));
    const night = smoothstepf(0.02, -0.12, elev);
    const golden = Math.max(0, Math.min(1, 1 - Math.max(elev, 0) / 0.34)) * (1 - night);
    let r = 1, g = 1 - 0.18 * golden, b = 1 - 0.34 * golden;
    r = r * (1 - night) + 0.70 * night;
    g = g * (1 - night) + 0.82 * night;
    b = b * (1 - night) + 1.08 * night;
    const luma = (1 - 0.16 * golden) * (1 - night) + 0.20 * night;
    if (payload && Array.isArray(payload.sunColor) && payload.sunColor.length === 3 && night < 0.5) {
      const s = payload.sunColor;
      const m = Math.max(1e-3, (s[0] + s[1] + s[2]) / 3);
      r = r * 0.7 + (s[0] / m) * 0.3;
      g = g * 0.7 + (s[1] / m) * 0.3;
      b = b * 0.7 + (s[2] / m) * 0.3;
    }
    this.material.uniforms.uTint.value.setRGB(r * luma, g * luma, b * luma);
    this.timeAlpha = 1 - 0.30 * night;
    this._applyOpacity();
  }

  update(elapsed) { if (this.material) this.material.uniforms.uTime.value = elapsed; }

  disposeMesh() {
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.removeFromParent(); }
    this.material?.dispose();
    this.mesh = null; this.material = null;
  }

  dispose() {
    this.disposeMesh();
    this.tex?.dispose();
    this.tex = null;
  }
}

/* ------------------------------------------------------------- helpers --- */

/**
 * Stretch a field to its own distribution inside the city.
 *
 * Land value across a real city occupies maybe 0.30–0.72 of the model's range.
 * Drawn raw, that is three neighbouring shades of the same green and the map
 * says nothing. This remaps the `lo`…`hi` percentiles *measured over the masked
 * cells only* onto 0…1, so the ramp spends its whole gamut on the variation
 * that actually exists — and reports the real interval it used, so a legend can
 * still say what the colours mean in absolute terms.
 */
export function stretch(field, mask, out, lo = 0.04, hi = 0.97) {
  const n = field.length;
  const BINS = 128;
  const hist = new Int32Array(BINS);
  let count = 0, minV = 1e9, maxV = -1e9;
  for (let i = 0; i < n; i++) {
    if (mask[i] <= 0.06) continue;
    const v = field[i];
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
    count++;
  }
  if (!count || maxV - minV < 1e-5) {
    for (let i = 0; i < n; i++) out[i] = field[i];
    return { lo: minV === 1e9 ? 0 : minV, hi: maxV === -1e9 ? 1 : maxV, count };
  }
  const inv = (BINS - 1) / (maxV - minV);
  for (let i = 0; i < n; i++) {
    if (mask[i] <= 0.06) continue;
    hist[((field[i] - minV) * inv) | 0]++;
  }
  const loN = count * lo, hiN = count * hi;
  let acc = 0, bLo = 0, bHi = BINS - 1;
  for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc >= loN) { bLo = b; break; } }
  acc = 0;
  for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc >= hiN) { bHi = b; break; } }
  const vLo = minV + bLo / inv;
  const vHi = Math.max(vLo + 1e-4, minV + bHi / inv);
  const k = 1 / (vHi - vLo);
  for (let i = 0; i < n; i++) {
    const t = (field[i] - vLo) * k;
    out[i] = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  return { lo: vLo, hi: vHi, count };
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

function smoothstepf(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export { signedChamfer };
export default FieldOverlay;
