import * as THREE from 'three';
import { ZONE } from '../core/World.js';
import { PALETTE, ZONE_NAME, isLandUse } from './Palette.js';
import { chamfer, signedChamfer } from './field.js';

/**
 * The zoning overlay — one draw call.
 *
 * The land use lives in three 256×256 DataTextures rather than in geometry:
 *
 *   colTex  (sRGB, linear-filtered)  rgb = the cell's graded zone colour,
 *                                    a   = a **signed distance** to the edge of
 *                                          the zoned area, in metres. Filtering
 *                                          a distance field reconstructs the
 *                                          boundary sub-cell, which is what
 *                                          gives a crisp soft edge instead of
 *                                          8 m stair-steps.
 *   edgeTex (linear)                 r = unsigned distance to the nearest
 *                                    land-use *change* (so zone-to-zone borders
 *                                    glow too), g = per-block hash, b = mottle.
 *   patTex  (nearest)                the per-zone hatch parameters, baked so the
 *                                    shader needs no lookup table and the
 *                                    pattern switches hard across a border.
 *
 * The carrier is a single terrain-conforming grid mesh. Nothing about it is
 * per-cell geometry, so repainting is a texture sub-upload, not a rebuild.
 */

const SDF_RANGE = 24;      // metres encoded into ±1

/* ------------------------------------------------------------- shaders --- */

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
uniform sampler2D uCol;
uniform sampler2D uEdge;
uniform sampler2D uPat;
uniform float uTime;
uniform float uOpacity;
uniform float uHatchGain;
uniform float uRimGain;
uniform vec2 uTexel;
uniform vec3 uTint;
varying vec2 vUv;
varying vec3 vWPos;
#include <common>
#include <fog_pars_fragment>

void main() {
  // Sampling the texel CENTRE through a linear sampler is a nearest fetch, so
  // one texture serves both roles: a crisp cell-quantised colour for the
  // interior (a 16 m commercial strip inside a residential block must read as a
  // strip, not as a smudge) and a smoothly filtered distance field for the
  // outer edge, which is where softness actually belongs.
  vec2 uvSnap = ( floor( vUv / uTexel ) + 0.5 ) * uTexel;
  vec4 c = texture2D( uCol, vUv );
  vec3 crisp = texture2D( uCol, uvSnap ).rgb;
  float sdf = ( c.a * 2.0 - 1.0 ) * ${SDF_RANGE.toFixed(1)};
  float inside = smoothstep( -1.2, 2.4, sdf );
  if ( inside <= 0.003 ) discard;

  vec4 e = texture2D( uEdge, vUv );
  vec4 pat = texture2D( uPat, vUv );

  // ---- per-zone hatching -------------------------------------------------
  // Two octaves, 2.6x apart, cross-faded on the screen-space derivative: the
  // fine hatch carries the close framing and hands over to the coarse one
  // before it can alias from the air, so the pattern never turns into moire.
  float ang = pat.r * 6.2831853 - 3.1415927;
  float period = max( 2.5, pat.g * 16.0 );
  float duty = pat.b;
  float crossing = pat.a;
  vec2 hv = vec2( cos( ang ), sin( ang ) );
  vec2 hp = vec2( -hv.y, hv.x );
  float s1 = dot( vWPos.xz, hv );
  float s2 = dot( vWPos.xz, hp );
  float lines = 0.0;
  float total = 0.0;
  for ( int o = 0; o < 2; o ++ ) {
    float p = period * ( o == 0 ? 1.0 : 2.6 );
    float k = 6.2831853 / p;
    float u = s1 * k;
    float fw = fwidth( u );
    float vis = 1.0 - smoothstep( 0.55, 1.5, fw );
    if ( o == 0 ) vis *= 1.0;
    else vis *= smoothstep( 0.25, 0.75, fwidth( s1 * 6.2831853 / period ) );
    float l = smoothstep( 0.5 - duty * 0.5, 0.5 + duty * 0.5 + 0.001, 0.5 + 0.5 * sin( u ) );
    if ( crossing > 0.5 ) {
      l = max( l, smoothstep( 0.5 - duty * 0.5, 0.5 + duty * 0.5 + 0.001, 0.5 + 0.5 * sin( s2 * k ) ) );
    }
    lines += l * vis;
    total += vis;
  }
  lines = total > 0.001 ? lines / max( total, 1.0 ) : 0.0;

  // ---- colour grading ------------------------------------------------------
  vec3 base = mix( c.rgb, crisp, 0.86 );
  float mottle = e.b * 2.0 - 1.0;
  base *= 1.0 + mottle * 0.09 + ( e.g - 0.5 ) * 0.16;

  // ---- boundary: soft rim with a slow travelling pulse ---------------------
  float bdist = e.r * ${SDF_RANGE.toFixed(1)};
  float rim = 1.0 - smoothstep( 0.0, 3.6, bdist );
  float rimEdge = 1.0 - smoothstep( 0.0, 1.35, bdist );
  float pulse = 0.55 + 0.45 * sin( bdist * 0.85 - uTime * 1.25 );
  vec3 rimCol = mix( base, vec3( 1.0 ), 0.62 );

  float zoneAlpha = max( e.a, 0.35 );
  // a whisper of extra density near the edge so a district reads as a body of
  // land rather than a flat sticker
  float body = 0.90 + 0.14 * ( 1.0 - smoothstep( 0.0, 16.0, sdf ) );
  float a = uOpacity * zoneAlpha * body * ( 0.80 + uHatchGain * lines );
  a += uOpacity * zoneAlpha * uRimGain * ( rim * pulse * 0.20 + rimEdge * 0.24 );
  vec3 col = mix( base, rimCol, clamp( uRimGain * ( rim * ( 0.30 + 0.28 * pulse ) + rimEdge * 0.26 ), 0.0, 1.0 ) );

  gl_FragColor = vec4( col * uTint, clamp( a, 0.0, 0.95 ) * inside );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/* ---------------------------------------------------------------- class --- */

export class Overlay {
  constructor(ctx, grid) {
    this.ctx = ctx;
    this.grid = grid;
    this.mesh = null;
    this.material = null;
    this.enabled = false;
    this._built = false;
    this.baseOpacity = 0.72;
    this.timeAlpha = 1;
    this._w = grid.gridW;
    this._h = grid.gridH;

    const n = this._w * this._h;
    this.colData = new Uint8Array(n * 4);
    this.edgeData = new Uint8Array(n * 4);
    this.patData = new Uint8Array(n * 4);
  }

  /* ---------------------------------------------------------- textures --- */

  _makeTextures() {
    const w = this._w, h = this._h;
    const mk = (data, { srgb = false, nearest = false }) => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.minFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
      t.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    this.colTex = mk(this.colData, { srgb: true });
    this.edgeTex = mk(this.edgeData, {});
    this.patTex = mk(this.patData, { nearest: true });
  }

  /**
   * Rebuild all three textures from the cell grid.
   * `blockOf` maps a cell index to a block id (for the per-block colour hash).
   */
  refresh(blockOf = null) {
    const g = this.grid;
    const w = this._w, h = this._h, n = w * h;
    const cells = g.cells;

    // 1 — masks
    const zoned = new Uint8Array(n);
    const changed = new Uint8Array(n);
    for (let i = 0; i < n; i++) zoned[i] = isLandUse(cells[i]) ? 1 : 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (!zoned[k]) continue;
        const z = cells[k];
        if ((i > 0 && cells[k - 1] !== z) || (i < w - 1 && cells[k + 1] !== z)
          || (j > 0 && cells[k - w] !== z) || (j < h - 1 && cells[k + w] !== z)) changed[k] = 1;
      }
    }

    // 2 — fields
    const sdf = signedChamfer(zoned, w, h, g.cellSize);
    const edge = chamfer(changed, w, h, g.cellSize);

    // 3 — bake
    const rgbCache = new Array(16);
    const patCache = new Array(16);
    for (let z = 0; z < 16; z++) {
      const p = PALETTE[ZONE_NAME[z]] || PALETTE.NONE;
      rgbCache[z] = [(p.hex >> 16) & 255, (p.hex >> 8) & 255, p.hex & 255, p.alpha];
      const ha = p.hatch;
      patCache[z] = [
        Math.round(((ha[0] + Math.PI) / (2 * Math.PI)) * 255),
        Math.round(Math.min(255, (ha[1] / 16) * 255)),
        Math.round(ha[2] * 255),
        ha[3] > 0.5 ? 255 : 0,
      ];
    }

    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const z = cells[k];
        const o = k * 4;
        const rgb = rgbCache[z] || rgbCache[0];
        // gentle per-cell value noise so a district is not a dead flat wash
        const hsh = hash2(i, j);
        const lift = 1 + (hsh - 0.5) * 0.10;
        this.colData[o] = clamp255(rgb[0] * lift);
        this.colData[o + 1] = clamp255(rgb[1] * lift);
        this.colData[o + 2] = clamp255(rgb[2] * lift);
        const s = sdf[k];
        this.colData[o + 3] = clamp255((Math.max(-SDF_RANGE, Math.min(SDF_RANGE, s)) / SDF_RANGE * 0.5 + 0.5) * 255);

        this.edgeData[o] = clamp255((Math.min(SDF_RANGE, edge[k]) / SDF_RANGE) * 255);
        this.edgeData[o + 1] = blockOf ? clamp255(hashInt(blockOf[k] + 1) * 255) : 128;
        this.edgeData[o + 2] = clamp255(smoothNoise(i, j) * 255);
        // per-zone opacity trim (parks sit back), linearly filtered across borders
        this.edgeData[o + 3] = clamp255(rgb[3] * 255);

        const pc = patCache[z] || patCache[0];
        this.patData[o] = pc[0]; this.patData[o + 1] = pc[1];
        this.patData[o + 2] = pc[2]; this.patData[o + 3] = pc[3];
      }
    }

    if (this.colTex) { this.colTex.needsUpdate = true; this.edgeTex.needsUpdate = true; this.patTex.needsUpdate = true; }
  }

  /* ------------------------------------------------------------- mesh --- */

  /** Build the conforming carrier over `area = {x0,z0,x1,z1}`. */
  build(area, terrain, waterLevel = 0) {
    if (this.mesh) this.dispose();
    if (!this.colTex) this._makeTextures();

    const g = this.grid;
    const pad = 96;
    const half = g.size / 2;
    const x0 = Math.max(-half + 2, area.x0 - pad), x1 = Math.min(half - 2, area.x1 + pad);
    const z0 = Math.max(-half + 2, area.z0 - pad), z1 = Math.min(half - 2, area.z1 + pad);
    const W = Math.max(80, x1 - x0), H = Math.max(80, z1 - z0);

    const step = 5.2;
    const nx = Math.max(8, Math.min(256, Math.round(W / step)));
    const nz = Math.max(8, Math.min(256, Math.round(H / step)));

    const geo = new THREE.PlaneGeometry(W, H, nx, nz);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
    const gsz = g.size;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx;
      const z = pos.getZ(i) + cz;
      const y = terrain ? terrain.heightAt(x, z) : 0;
      pos.setX(i, x); pos.setZ(i, z);
      pos.setY(i, Math.max(y, waterLevel) + 0.62);
      uv.setXY(i, (x - g.originX) / gsz, (z - g.originZ) / gsz);
    }
    pos.needsUpdate = true; uv.needsUpdate = true;
    geo.computeBoundingSphere();
    geo.computeBoundingBox();

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uCol: { value: null }, uEdge: { value: null }, uPat: { value: null },
          uTime: { value: 0 }, uOpacity: { value: 0.72 },
          uHatchGain: { value: 0.34 }, uRimGain: { value: 1.0 },
          uTexel: { value: new THREE.Vector2(1 / 256, 1 / 256) },
          uTint: { value: new THREE.Color(1, 1, 1) },
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
    this.material.uniforms.uTexel.value.set(1 / this._w, 1 / this._h);
    this.material.uniforms.uCol.value = this.colTex;
    this.material.uniforms.uEdge.value = this.edgeTex;
    this.material.uniforms.uPat.value = this.patTex;

    // Join the core patch chain (pass 5). CSM and props' clustered pass are both
    // guarded on lighting chunks this unlit diagram does not have, so they no-op;
    // what it buys is `environment`'s per-pixel aerial perspective replacing the
    // stock fog, so the overlay hazes with the city instead of against it.
    try { this.ctx?.materials?.adopt?.(this.material); } catch { /* older core */ }

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'zoning:overlay';
    this.mesh.frustumCulled = true;
    this.mesh.renderOrder = 6;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.visible = this.enabled;
    this._built = true;
    return this.mesh;
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (this.mesh) this.mesh.visible = this.enabled;
    return this.enabled;
  }

  setOpacity(v) { this.baseOpacity = v; this._applyOpacity(); }

  _applyOpacity() {
    if (!this.material) return;
    this.material.uniforms.uOpacity.value = (this.baseOpacity ?? 0.72) * (this.timeAlpha ?? 1);
  }

  /**
   * A land-use overlay is a diagram, but a diagram painted on the ground: if it
   * keeps its noon brightness while the site goes amber at 18:45 and blue at
   * 22:00 it stops reading as part of the scene and starts reading as a HUD.
   * This ties its exposure and colour temperature to the hour (using
   * `environment`'s published sun colour when it is there, a smooth analytic
   * curve when it is not).
   */
  setTime(hours, payload = null) {
    this.hours = hours;
    if (!this.material) return;
    // Solar-elevation proxy pinned to the same civil day the rest of the
    // project uses (sunrise ~6:12, solar noon ~12:48, sunset ~19:24) — a naive
    // cos((h-12)/12·pi) calls 18:45 "night" and turns the golden-hour shot blue.
    const elev = Math.cos(((hours - 12.8) / 6.6) * (Math.PI / 2));
    const night = smoothstepf(0.02, -0.12, elev);
    const golden = Math.max(0, Math.min(1, 1 - Math.max(elev, 0) / 0.34)) * (1 - night);
    let r = 1, g = 1, b = 1;
    r = 1 - 0.00 * golden; g = 1 - 0.20 * golden; b = 1 - 0.38 * golden;
    r = r * (1 - night) + 0.66 * night;
    g = g * (1 - night) + 0.78 * night;
    b = b * (1 - night) + 1.06 * night;
    const luma = (1 - 0.20 * golden) * (1 - night) + 0.13 * night;
    if (payload && Array.isArray(payload.sunColor) && payload.sunColor.length === 3 && !night) {
      const s = payload.sunColor;
      const m = Math.max(1e-3, (s[0] + s[1] + s[2]) / 3);
      r = r * 0.65 + (s[0] / m) * 0.35;
      g = g * 0.65 + (s[1] / m) * 0.35;
      b = b * 0.65 + (s[2] / m) * 0.35;
    }
    this.material.uniforms.uTint.value.setRGB(r * luma, g * luma, b * luma);
    // the scene itself is nearly black at 22:00, so the diagram has to give up
    // some coverage as well as some exposure or it reads as a backlit light box
    this.timeAlpha = 1 - 0.40 * night;
    this._applyOpacity();
  }

  update(elapsed) {
    if (this.material) this.material.uniforms.uTime.value = elapsed;
  }

  dispose() {
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.removeFromParent(); }
    this.material?.dispose();
    this.mesh = null; this.material = null; this._built = false;
  }

  disposeTextures() {
    this.colTex?.dispose(); this.edgeTex?.dispose(); this.patTex?.dispose();
    this.colTex = this.edgeTex = this.patTex = null;
  }
}

/* ------------------------------------------------------------- helpers --- */

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

function smoothstepf(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hashInt(n) {
  let x = (n | 0) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
function hash2(i, j) { return hashInt(i * 73856093 ^ j * 19349663); }

/** Cheap bilinear value noise over the cell lattice — used only for mottle. */
function smoothNoise(i, j) {
  const s = 0.18;
  const x = i * s, y = j * s;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0), b = hash2(x0 + 1, y0), c = hash2(x0, y0 + 1), d = hash2(x0 + 1, y0 + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

export { ZONE };
export default Overlay;
