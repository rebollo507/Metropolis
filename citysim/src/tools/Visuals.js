import * as THREE from 'three';
import { LEVEL_COLOR, corridorHalf, halfWidth } from './Rules.js';

/**
 * The feedback layer.
 *
 * Five objects, five draw calls, all of them off unless a tool is live:
 *
 *   GroundOverlay  one terrain-conforming lattice under the cursor carrying the
 *                  survey grid, the zone/terrain brush and the validity tint
 *   GhostRoad      the pending carriageway with its kerbs and verges, drawn as
 *                  a lit hologram rather than an outline
 *   Markers        snap indicators (junction, tie-in, angle lock, offset)
 *   Highlight      the bulldoze cuff — an extruded footprint that hugs the
 *                  target instead of boxing it
 *   Earthworks     the graded surface a terrain brush has actually produced
 *
 * Everything is a raw ShaderMaterial following the house convention
 * (`<tonemapping_fragment>` + `<colorspace_fragment>` + the fog chunks) so the
 * previews sit in the same colour pipeline as the city, with the composer on
 * or off. Nothing here is a wireframe, a GridHelper or a flat primary.
 */

const FOG_V = /* glsl */`
#include <common>
#include <fog_pars_vertex>
`;
const FOG_F = /* glsl */`
#include <common>
#include <fog_pars_fragment>
`;
const TAIL = /* glsl */`
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
`;

export const COLOR = LEVEL_COLOR;

/* ===================================================== ground overlay ==== */

const GRID_SPAN = 232;
const GRID_SEG = 76;

const OVERLAY_VERT = /* glsl */`
varying vec3 vW;
varying float vR;
${FOG_V}
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vW = wp.xyz;
  vR = length( position.xz ) / ${(GRID_SPAN / 2).toFixed(1)};
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const OVERLAY_FRAG = /* glsl */`
uniform float uTime;
uniform float uGrid;          // 0..1 survey-grid fade
uniform vec3  uGridColor;
uniform int   uMode;          // 0 off · 1 circle · 2 rect · 3 capsule
uniform vec2  uP0;
uniform vec2  uP1;
uniform float uR;
uniform float uSoft;
uniform vec3  uColor;
uniform float uShapeA;
uniform float uBad;           // 0 legal · 1 illegal (hazard chevrons)
uniform float uCell;
varying vec3 vW;
varying float vR;
${FOG_F}

float aaLine( vec2 p, float cell, float w ) {
  vec2 q = p / cell;
  vec2 g = abs( fract( q - 0.5 ) - 0.5 ) / max( fwidth( q ), 1e-5 );
  float l = min( g.x, g.y );
  return 1.0 - smoothstep( 0.0, w, l );
}

float sdBox( vec2 p, vec2 b ) {
  vec2 d = abs( p ) - b;
  return length( max( d, 0.0 ) ) + min( max( d.x, d.y ), 0.0 );
}

float sdSeg( vec2 p, vec2 a, vec2 b ) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp( dot( pa, ba ) / max( dot( ba, ba ), 1e-5 ), 0.0, 1.0 );
  return length( pa - ba * h );
}

void main() {
  vec2 p = vW.xz;

  // ---- survey grid ------------------------------------------------------
  float minor = aaLine( p, uCell, 1.15 );
  float major = aaLine( p, uCell * 5.0, 1.5 );
  float gridA = uGrid * ( minor * 0.11 + major * 0.26 );

  // ---- brush / corridor shape ------------------------------------------
  float d = 1e6;
  if ( uMode == 1 ) d = length( p - uP0 ) - uR;
  else if ( uMode == 2 ) d = sdBox( p - ( uP0 + uP1 ) * 0.5, abs( uP1 - uP0 ) * 0.5 );
  else if ( uMode == 3 ) d = sdSeg( p, uP0, uP1 ) - uR;

  float fill = 1.0 - smoothstep( -uSoft, uSoft * 0.35, d );
  float rim  = exp( -abs( d ) * ( 1.6 / max( uSoft, 0.4 ) ) );
  float rimTight = exp( -abs( d ) * 2.4 );

  // a slow inward ripple so a live brush reads as an instrument, not a sticker
  float ripple = 0.5 + 0.5 * sin( d * 0.9 + uTime * 2.4 );

  // hazard chevrons for an illegal action — 45°, travelling, never a flat red
  float haz = step( 0.5, fract( ( p.x + p.y * 0.0 + vW.z ) * 0.22 - uTime * 0.6 ) );
  vec3 shapeCol = mix( uColor, mix( uColor, vec3( 1.0 ), 0.55 ), rimTight );
  shapeCol = mix( shapeCol, shapeCol * ( 0.55 + 0.45 * haz ), uBad * 0.85 );

  float shapeA = uShapeA * ( fill * ( 0.30 + 0.10 * ripple ) + rim * 0.34 + rimTight * 0.42 );

  // ---- composite --------------------------------------------------------
  float fade = 1.0 - smoothstep( 0.55, 1.0, vR );
  vec3 col = mix( uGridColor, shapeCol, clamp( shapeA / max( shapeA + gridA, 1e-4 ), 0.0, 1.0 ) );
  float a = clamp( ( gridA + shapeA ) * fade, 0.0, 0.92 );
  if ( a < 0.004 ) discard;

  gl_FragColor = vec4( col, a );
${TAIL}
}
`;

export class GroundOverlay {
  constructor(ctx) {
    this.ctx = ctx;
    const geo = new THREE.PlaneGeometry(GRID_SPAN, GRID_SPAN, GRID_SEG, GRID_SEG);
    geo.rotateX(-Math.PI / 2);
    this.geo = geo;
    this.pos = geo.attributes.position;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 }, uGrid: { value: 0 }, uGridColor: { value: new THREE.Color(0x9fd8ff) },
          uMode: { value: 0 }, uP0: { value: new THREE.Vector2() }, uP1: { value: new THREE.Vector2() },
          uR: { value: 12 }, uSoft: { value: 1.6 }, uColor: { value: new THREE.Color(COLOR.ok) },
          uShapeA: { value: 0 }, uBad: { value: 0 }, uCell: { value: 8 },
        },
      ]),
      vertexShader: OVERLAY_VERT,
      fragmentShader: OVERLAY_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'tools:ground';
    this.mesh.renderOrder = 8;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
    this._anchor = { x: NaN, z: NaN };
    ctx.group.add(this.mesh);
  }

  /** Re-drape the lattice on the heightfield. Only when the anchor really moved. */
  place(x, z, force = false) {
    const ax = Math.round(x / 3) * 3, az = Math.round(z / 3) * 3;
    if (!force && ax === this._anchor.x && az === this._anchor.z) return;
    this._anchor.x = ax; this._anchor.z = az;
    const t = safe(this.ctx, 'terrain');
    const h = t && t.heightAt ? (px, pz) => t.heightAt(px, pz) : (px, pz) => this.ctx.world.heightAt(px, pz);
    const arr = this.pos.array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i + 1] = h(arr[i] + ax, arr[i + 2] + az) + 0.14;
    }
    this.pos.needsUpdate = true;
    this.mesh.position.set(ax, 0, az);
    this.mesh.updateMatrix();
  }

  setGrid(amount, cell = 8) {
    this.material.uniforms.uGrid.value = amount;
    this.material.uniforms.uCell.value = cell;
  }

  circle(x, z, r, color, alpha = 1, soft = 1.8) {
    const u = this.material.uniforms;
    u.uMode.value = 1;
    u.uP0.value.set(x, z);
    u.uR.value = r;
    u.uSoft.value = soft;
    u.uColor.value.setHex(color);
    u.uShapeA.value = alpha;
  }

  rect(x0, z0, x1, z1, color, alpha = 1) {
    const u = this.material.uniforms;
    u.uMode.value = 2;
    u.uP0.value.set(x0, z0);
    u.uP1.value.set(x1, z1);
    u.uSoft.value = 1.4;
    u.uColor.value.setHex(color);
    u.uShapeA.value = alpha;
  }

  capsule(x0, z0, x1, z1, r, color, alpha = 1) {
    const u = this.material.uniforms;
    u.uMode.value = 3;
    u.uP0.value.set(x0, z0);
    u.uP1.value.set(x1, z1);
    u.uR.value = r;
    u.uSoft.value = 1.6;
    u.uColor.value.setHex(color);
    u.uShapeA.value = alpha;
  }

  clearShape() { this.material.uniforms.uShapeA.value = 0; this.material.uniforms.uMode.value = 0; }
  setBad(v) { this.material.uniforms.uBad.value = v; }
  update(elapsed) { this.material.uniforms.uTime.value = elapsed; }
  dispose() { this.geo.dispose(); this.material.dispose(); this.mesh.removeFromParent(); }
}

/* ========================================================== ghost road === */

const GHOST_VERT = /* glsl */`
attribute float aAcross;
attribute float aU;
attribute float aKind;
varying float vAcross;
varying float vU;
varying float vKind;
varying vec3 vW;
${FOG_V}
void main() {
  vAcross = aAcross; vU = aU; vKind = aKind;
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vW = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const GHOST_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uTime;
uniform float uAlpha;
uniform float uBad;
uniform float uLength;
varying float vAcross;
varying float vU;
varying float vKind;
varying vec3 vW;
${FOG_F}
void main() {
  float ax = abs( vAcross );

  // centre line: dashed, in metres, so it reads at any road width
  float s = vU * uLength;
  float dash = step( 0.5, fract( s / 6.0 ) );
  float centre = ( 1.0 - smoothstep( 0.03, 0.075, ax ) ) * dash;

  // travelling survey band — this is what makes it read as "pending"
  float head = exp( -abs( fract( vU - uTime * 0.16 ) - 0.5 ) * 7.0 );

  float deck = step( vKind, 0.5 );
  float kerb = step( 0.5, vKind ) * step( vKind, 1.5 );
  float verge = step( 1.5, vKind );

  // The deck is a real carriageway being placed, not a coloured film: dark
  // asphalt tinted by the verdict, with the kerbs and the centre line carrying
  // the colour. Anything lighter vanished against grass from the air.
  vec3 asphalt = vec3( 0.016, 0.018, 0.022 );
  vec3 deckCol = mix( asphalt, uColor, 0.13 );

  float a = uAlpha * (
      deck  * ( 0.80 + 0.12 * head )
    + kerb  * ( 0.94 + 0.06 * head )
    + verge * 0.30
  );
  a += uAlpha * smoothstep( 0.88, 1.0, ax ) * 0.25;

  vec3 col = mix( deckCol, uColor, kerb + verge * 0.7 );
  col = mix( col, vec3( 1.0 ), kerb * 0.34 + centre * 0.92 + head * 0.10 );
  float haz = step( 0.5, fract( ( vW.x + vW.z ) * 0.20 - uTime * 0.55 ) );
  col = mix( col, col * ( 0.5 + 0.5 * haz ), uBad * 0.8 );

  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( col, clamp( a, 0.0, 0.94 ) );
${TAIL}
}
`;

const ACROSS = 8;
const MAX_ST = 260;

export class GhostRoad {
  constructor(ctx) {
    this.ctx = ctx;
    const verts = ACROSS * MAX_ST;
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.aAcross = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.aU = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.aKind = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aAcross.setUsage(THREE.DynamicDrawUsage);
    this.aU.setUsage(THREE.DynamicDrawUsage);
    this.aKind.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aAcross', this.aAcross);
    geo.setAttribute('aU', this.aU);
    geo.setAttribute('aKind', this.aKind);
    const idx = new Uint32Array((ACROSS - 1) * (MAX_ST - 1) * 6);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4000);
    this.geo = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uColor: { value: new THREE.Color(COLOR.ok) }, uTime: { value: 0 },
          uAlpha: { value: 1 }, uBad: { value: 0 }, uLength: { value: 100 },
        },
      ]),
      vertexShader: GHOST_VERT,
      fragmentShader: GHOST_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'tools:ghostroad';
    this.mesh.renderOrder = 9;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    ctx.group.add(this.mesh);
  }

  /**
   * Rebuild from a station list and its elevation profile.
   * `stations` is XZ pairs; `ys` is the smoothed centreline height.
   */
  build(stations, ys, cls, color, bad) {
    const n = Math.min(MAX_ST, stations.length / 2);
    if (n < 2) { this.mesh.visible = false; return 0; }
    const half = halfWidth(cls);
    const walk = Math.max(0.9, corridorHalf(cls) - half);
    const kerbH = 0.16;
    const pos = this.aPos.array, ac = this.aAcross.array, uu = this.aU.array, kk = this.aKind.array;

    const off = [
      -(half + walk), -(half + 0.22), -half, -half,
      half, half, half + 0.22, half + walk,
    ];
    const dy = [0.02, kerbH, kerbH, 0.0, 0.0, kerbH, kerbH, 0.02];
    const kind = [2, 1, 1, 0, 0, 1, 1, 2];

    let total = 0;
    for (let i = 1; i < n; i++) {
      total += Math.hypot(stations[i * 2] - stations[i * 2 - 2], stations[i * 2 + 1] - stations[i * 2 - 1]);
    }
    let run = 0;
    for (let i = 0; i < n; i++) {
      const x = stations[i * 2], z = stations[i * 2 + 1];
      if (i > 0) run += Math.hypot(x - stations[i * 2 - 2], z - stations[i * 2 - 1]);
      const j = i === n - 1 ? i - 1 : i;
      let dx = stations[(j + 1) * 2] - stations[j * 2];
      let dz = stations[(j + 1) * 2 + 1] - stations[j * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const nx = -dz, nz = dx;
      const y = (ys && ys[i] !== undefined ? ys[i] : this._h(x, z)) + 0.18;
      const u = total > 0 ? run / total : 0;
      for (let k = 0; k < ACROSS; k++) {
        const vi = i * ACROSS + k;
        pos[vi * 3] = x + nx * off[k];
        pos[vi * 3 + 1] = y + dy[k];
        pos[vi * 3 + 2] = z + nz * off[k];
        ac[vi] = off[k] / (half + walk);
        uu[vi] = u;
        kk[vi] = kind[k];
      }
    }

    const idx = this.geo.index.array;
    let p = 0;
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < ACROSS - 1; k++) {
        const a = i * ACROSS + k, b = a + 1, c = a + ACROSS, d = c + 1;
        idx[p++] = a; idx[p++] = c; idx[p++] = b;
        idx[p++] = b; idx[p++] = c; idx[p++] = d;
      }
    }
    this.geo.setDrawRange(0, p);
    this.geo.index.needsUpdate = true;
    this.aPos.needsUpdate = true; this.aAcross.needsUpdate = true;
    this.aU.needsUpdate = true; this.aKind.needsUpdate = true;
    this.material.uniforms.uColor.value.setHex(color);
    this.material.uniforms.uBad.value = bad ? 1 : 0;
    this.material.uniforms.uLength.value = Math.max(1, total);
    this.mesh.visible = true;
    return p / 3;
  }

  _h(x, z) {
    const t = safe(this.ctx, 'terrain');
    return t && t.heightAt ? t.heightAt(x, z) : this.ctx.world.heightAt(x, z);
  }

  hide() { this.mesh.visible = false; }
  update(elapsed) { this.material.uniforms.uTime.value = elapsed; }
  dispose() { this.geo.dispose(); this.material.dispose(); this.mesh.removeFromParent(); }
}

/* ============================================================= markers === */

const MARK_VERT = /* glsl */`
attribute vec3 aColor;
attribute float aPhase;
varying vec2 vLocal;
varying vec3 vCol;
varying float vPhase;
${FOG_V}
void main() {
  vLocal = position.xz;
  vCol = aColor;
  vPhase = aPhase;
  vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const MARK_FRAG = /* glsl */`
uniform float uTime;
varying vec2 vLocal;
varying vec3 vCol;
varying float vPhase;
${FOG_F}
void main() {
  float r = length( vLocal );
  // the geometry is an annulus 0.62..1.0; shape a soft double ring inside it
  float band = smoothstep( 0.62, 0.74, r ) * ( 1.0 - smoothstep( 0.90, 1.0, r ) );
  float pulse = 0.62 + 0.38 * sin( uTime * 3.0 + vPhase );
  float a = band * pulse;
  if ( a < 0.01 ) discard;
  gl_FragColor = vec4( mix( vCol, vec3( 1.0 ), 0.35 * pulse ), a * 0.95 );
${TAIL}
}
`;

const MARK_CAP = 32;

export class Markers {
  constructor(ctx) {
    this.ctx = ctx;
    const geo = new THREE.RingGeometry(0.62, 1.0, 40, 1);
    geo.rotateX(-Math.PI / 2);
    this.geo = geo;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
      vertexShader: MARK_VERT,
      fragmentShader: MARK_FRAG,
      transparent: true, depthWrite: false, depthTest: false,
      fog: true, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, MARK_CAP);
    this.mesh.name = 'tools:markers';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.count = 0;
    this.colors = new THREE.InstancedBufferAttribute(new Float32Array(MARK_CAP * 3), 3);
    this.phases = new THREE.InstancedBufferAttribute(new Float32Array(MARK_CAP), 1);
    geo.setAttribute('aColor', this.colors);
    geo.setAttribute('aPhase', this.phases);
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this.n = 0;
    ctx.group.add(this.mesh);
  }

  begin() { this.n = 0; }

  add(x, y, z, radius, color, phase = 0) {
    if (this.n >= MARK_CAP) return;
    this._p.set(x, y + 0.35, z);
    this._s.set(radius, 1, radius);
    this._m.compose(this._p, this._q, this._s);
    this.mesh.setMatrixAt(this.n, this._m);
    this._c.setHex(color);
    this.colors.setXYZ(this.n, this._c.r, this._c.g, this._c.b);
    this.phases.setX(this.n, phase);
    this.n++;
  }

  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.phases.needsUpdate = true;
    this.mesh.visible = this.n > 0;
  }

  update(elapsed) { this.material.uniforms.uTime.value = elapsed; }
  dispose() { this.geo.dispose(); this.material.dispose(); this.mesh.dispose(); this.mesh.removeFromParent(); }
}

/* =========================================================== highlight === */

const HL_VERT = /* glsl */`
attribute float aUp;
varying float vUp;
varying vec3 vW;
varying vec3 vN;
${FOG_V}
void main() {
  vUp = aUp;
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vW = wp.xyz;
  vN = normalize( mat3( modelMatrix ) * normal );
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const HL_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uTime;
uniform float uAlpha;
varying float vUp;
varying vec3 vW;
varying vec3 vN;
${FOG_F}
void main() {
  vec3 V = normalize( cameraPosition - vW );
  float fres = pow( 1.0 - abs( dot( normalize( vN ), V ) ), 2.0 );
  float base = pow( 1.0 - vUp, 2.4 );                 // densest at the ground
  float cut  = smoothstep( 0.92, 1.0, vUp );          // a bright line where it ends
  float sweep = exp( -abs( fract( vW.y * 0.12 - uTime * 0.30 ) - 0.5 ) * 9.0 );
  float a = uAlpha * ( base * 0.46 + fres * 0.34 + sweep * 0.16 + cut * 0.55 );
  vec3 col = mix( uColor, vec3( 1.0 ), fres * 0.4 + sweep * 0.22 + cut * 0.7 );
  if ( a < 0.005 ) discard;
  gl_FragColor = vec4( col, clamp( a, 0.0, 0.85 ) );
${TAIL}
}
`;

export class Highlight {
  constructor(ctx) {
    this.ctx = ctx;
    const geo = new THREE.BufferGeometry();
    const CAP = 4096;
    this.aPos = new THREE.BufferAttribute(new Float32Array(CAP * 3), 3);
    this.aNrm = new THREE.BufferAttribute(new Float32Array(CAP * 3), 3);
    this.aUp = new THREE.BufferAttribute(new Float32Array(CAP), 1);
    for (const a of [this.aPos, this.aNrm, this.aUp]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('normal', this.aNrm);
    geo.setAttribute('aUp', this.aUp);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4000);
    this.geo = geo;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uColor: { value: new THREE.Color(COLOR.bad) }, uTime: { value: 0 }, uAlpha: { value: 1 } },
      ]),
      vertexShader: HL_VERT,
      fragmentShader: HL_FRAG,
      transparent: true, depthWrite: false, depthTest: true, fog: true, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'tools:highlight';
    this.mesh.renderOrder = 11;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.count = 0;
    ctx.group.add(this.mesh);
  }

  _reset() { this.count = 0; }

  _quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, u0, u1) {
    const p = this.aPos.array, nA = this.aNrm.array, up = this.aUp.array;
    // outward normal from the AB edge
    let ex = bx - ax, ez = bz - az;
    const l = Math.hypot(ex, ez) || 1;
    const nx = ez / l, nz = -ex / l;
    const push = (x, y, z, u) => {
      const i = this.count++;
      p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
      nA[i * 3] = nx; nA[i * 3 + 1] = 0.15; nA[i * 3 + 2] = nz;
      up[i] = u;
    };
    push(ax, ay, az, u0); push(bx, by, bz, u0); push(cx, cy, cz, u1);
    push(ax, ay, az, u0); push(cx, cy, cz, u1); push(dx, dy, dz, u1);
  }

  /** A cuff around a rotated footprint, rising to `height`. */
  building(b, groundY, color = COLOR.bad) {
    this._reset();
    const fp = b.footprint || [12, 10];
    const hw = fp[0] / 2 + 0.5, hd = fp[1] / 2 + 0.5;
    const r = b.rotation || 0;
    const c = Math.cos(r), s = Math.sin(r);
    const cx = b.pos[0], cz = b.pos[2];
    const y0 = groundY - 0.4;
    const h = Math.max(4, Math.min(240, b.height || 12)) * 1.02;
    const corner = (sx, sz) => [cx + (sx * hw) * c - (sz * hd) * s, cz + (sx * hw) * s + (sz * hd) * c];
    const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    for (let i = 0; i < 4; i++) {
      const a = pts[i], bb = pts[(i + 1) % 4];
      this._quad(a[0], y0, a[1], bb[0], y0, bb[1], bb[0], y0 + h, bb[1], a[0], y0 + h, a[1], 0, 1);
    }
    this._commit(color);
  }

  /** A corridor cuff along a road segment. */
  road(points, groundYs, cls, color = COLOR.bad) {
    this._reset();
    const half = corridorHalf(cls) + 0.4;
    const h = 2.4;
    const n = points.length / 2;
    for (let i = 0; i < n - 1; i++) {
      const ax = points[i * 2], az = points[i * 2 + 1];
      const bx = points[i * 2 + 2], bz = points[i * 2 + 3];
      let dx = bx - ax, dz = bz - az;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const nx = -dz, nz = dx;
      const ya = groundYs[i], yb = groundYs[i + 1];
      for (const side of [-1, 1]) {
        const a0x = ax + nx * half * side, a0z = az + nz * half * side;
        const b0x = bx + nx * half * side, b0z = bz + nz * half * side;
        this._quad(a0x, ya, a0z, b0x, yb, b0z, b0x, yb + h, b0z, a0x, ya + h, a0z, 0, 1);
      }
    }
    this._commit(color);
  }

  _commit(color) {
    if (this.count < 3) { this.mesh.visible = false; return; }
    this.geo.setDrawRange(0, this.count);
    this.aPos.needsUpdate = true; this.aNrm.needsUpdate = true; this.aUp.needsUpdate = true;
    this.material.uniforms.uColor.value.setHex(color);
    this.mesh.visible = true;
  }

  hide() { this.mesh.visible = false; }
  update(elapsed) { this.material.uniforms.uTime.value = elapsed; }
  dispose() { this.geo.dispose(); this.material.dispose(); this.mesh.removeFromParent(); }
}

/* =========================================================== earthworks == */

/**
 * The surface a terrain brush has actually produced.
 *
 * `terrain` publishes no write path and no rebuild hook, so its LOD rings keep
 * the geometry they were built with and an edit would otherwise be invisible
 * (R-tools-5). This is a real, lit, shadow-receiving PBR surface sampled from
 * the live heightfield over exactly the edited footprint, faded into the
 * surrounding ground at its rim — a graded construction pad, which is what a
 * fresh earthwork looks like anyway. It cannot hide the stale mesh where the
 * ground was *cut*; that needs the terrain API.
 */
export class Earthworks {
  constructor(ctx) {
    this.ctx = ctx;
    this.mesh = null;
    this.material = null;
    this.bounds = null;
  }

  _material() {
    if (this.material) return this.material;
    const ctx = this.ctx;
    const tex = ctx.assets.canvasTexture('tools:soil', 512, (g, s) => {
      const img = g.createImageData(s, s);
      const d = img.data;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const i = (y * s + x) * 4;
          // banded, tracked earth: coarse clods plus grader ruts
          const clod = Math.sin(x * 0.13) * Math.cos(y * 0.11) * 0.5
            + Math.sin((x + y) * 0.047) * 0.5;
          const rut = Math.sin(y * 0.9 + Math.sin(x * 0.02) * 3) * 0.5 + 0.5;
          const grit = ((x * 7919 + y * 104729) % 211) / 211;
          const l = 0.26 + clod * 0.055 + grit * 0.09 - rut * 0.045;
          d[i] = Math.max(0, Math.min(255, l * 255 * 1.00));
          d[i + 1] = Math.max(0, Math.min(255, l * 255 * 0.88));
          d[i + 2] = Math.max(0, Math.min(255, l * 255 * 0.74));
          d[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
    }, { srgb: true, repeat: 44 });
    this.material = ctx.materials.pbr({
      color: 0x6f6250, roughness: 0.98, metalness: 0.0,
      map: tex, envMapIntensity: 0.85, vertexColors: true,
      transparent: true, dithering: true,
    });
    return this.material;
  }

  /** Rebuild over `b = {x0,z0,x1,z1}` (world metres), with a soft margin. */
  show(b, margin = 6) {
    if (!b) return;
    const x0 = b.x0 - margin, x1 = b.x1 + margin, z0 = b.z0 - margin, z1 = b.z1 + margin;
    const w = x1 - x0, d = z1 - z0;
    const nx = Math.max(6, Math.min(160, Math.round(w / 2.5)));
    const nz = Math.max(6, Math.min(160, Math.round(d / 2.5)));
    this._dispose();
    const geo = new THREE.PlaneGeometry(w, d, nx, nz);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position.array;
    const col = new Float32Array((nx + 1) * (nz + 1) * 4);
    const t = safe(this.ctx, 'terrain');
    const h = t && t.heightAt ? (px, pz) => t.heightAt(px, pz) : (px, pz) => this.ctx.world.heightAt(px, pz);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const rx = w / 2, rz = d / 2;
    for (let i = 0; i < pos.length; i += 3) {
      const wx = pos[i] + cx, wz = pos[i + 2] + cz;
      pos[i + 1] = h(wx, wz) + 0.045;
      const e = Math.max(Math.abs(pos[i]) / rx, Math.abs(pos[i + 2]) / rz);
      const a = 1 - smoothstep(0.46, 1.0, e);
      const k = i / 3;
      col[k * 4] = 1; col[k * 4 + 1] = 1; col[k * 4 + 2] = 1; col[k * 4 + 3] = a;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    geo.computeVertexNormals();
    this.mesh = new THREE.Mesh(geo, this._material());
    this.mesh.name = 'tools:earthworks';
    this.mesh.position.set(cx, 0, cz);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.renderOrder = 3;
    this.ctx.group.add(this.mesh);
    this.bounds = { x0, z0, x1, z1 };
  }

  /** Widen to include another edit and rebuild once. */
  grow(b) {
    const cur = this.bounds;
    const next = cur ? {
      x0: Math.min(cur.x0, b.x0), z0: Math.min(cur.z0, b.z0),
      x1: Math.max(cur.x1, b.x1), z1: Math.max(cur.z1, b.z1),
    } : b;
    this.show(next, cur ? 0 : 10);
  }

  clear() { this._dispose(); this.bounds = null; }

  _dispose() {
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.removeFromParent(); this.mesh = null; }
  }

  dispose() { this._dispose(); }
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function safe(ctx, name) { try { return ctx.get(name); } catch { return null; } }
