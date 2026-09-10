import * as THREE from 'three';

/**
 * Clustered forward lighting for the city's street lamps and shopfronts.
 *
 * Round 2 lit the ground with an additive gobo, which the critic correctly
 * called glowing paint: it painted the *result* of a lamp without there being a
 * lamp, so a car parked in a near-white pool stayed black. This is the fix
 * R-props-6 asked for, built on the core shader-patch chain the integrator
 * shipped in pass 5.
 *
 * Why clustered rather than `THREE.PointLight`: three's forward renderer bakes
 * the light count into every program and uploads a uniform array per light, so
 * 300+ point lights is neither compilable nor affordable. Instead the lights
 * live in two data textures and the fragment shader looks up only the handful
 * that can reach the pixel:
 *
 *   uPropsLightTex   W x 2 RGBA float.  row 0 = (x, y, z, radius)
 *                                       row 1 = (r, g, b, intensity)
 *   uPropsLightGrid  GW x GH RGBA float. four light indices per XZ cell, -1 empty
 *
 * A fragment reads one grid texel and at most four light records — nine texture
 * fetches, unrolled, with an early-out on `uPropsLightMeta2.z` (the night term)
 * so a daylight frame pays a single uniform compare.
 *
 * The uniforms go into `ctx.materials.globalUniforms`, which core shares BY
 * REFERENCE with every material in the patch chain, so one write per frame
 * updates the whole scene and no other module's folder is touched.
 */

const MAX_LIGHTS = 1024;
const CELL = 26;             // metres per cluster cell
const PER_CELL = 4;          // light indices stored per cell

/* Fragment: the cluster lookup, injected after <lights_fragment_end>. */
const FRAG_PARS = /* glsl */`
uniform sampler2D uPropsLightTex;
uniform sampler2D uPropsLightGrid;
uniform vec4 uPropsLightMeta;    // originX, originZ, 1/cell, texWidth
uniform vec4 uPropsLightMeta2;   // gridW, gridH, nightScale, lightCount
varying vec3 vPropsWorld;

vec3 propsLampContrib( float idx, vec3 wp, vec3 nrm ) {
  if ( idx < 0.0 ) return vec3( 0.0 );
  float u = ( idx + 0.5 ) / uPropsLightMeta.w;
  vec4 P = texture2D( uPropsLightTex, vec2( u, 0.25 ) );
  vec3 d = P.xyz - wp;
  float dist = length( d );
  if ( dist >= P.w ) return vec3( 0.0 );
  vec4 C = texture2D( uPropsLightTex, vec2( u, 0.75 ) );
  // three's own point-light falloff (physical inverse-square, windowed to zero
  // at the radius so a light never leaks past the cell it was binned into),
  // which keeps these intensities in the same units as a THREE.PointLight
  float dOverR = dist / P.w;
  float w = clamp( 1.0 - dOverR * dOverR * dOverR * dOverR, 0.0, 1.0 );
  float att = ( w * w ) / max( dist * dist, 0.04 );
  float ndl = max( dot( nrm, d / max( dist, 1e-4 ) ), 0.0 );
  return C.rgb * ( C.w * att * ndl );
}
`;

const FRAG_BODY = /* glsl */`
#include <lights_fragment_end>
#if defined( RE_IndirectDiffuse )
if ( uPropsLightMeta2.z > 0.002 && uPropsLightMeta2.w > 0.5 ) {
  float pgx = floor( ( vPropsWorld.x - uPropsLightMeta.x ) * uPropsLightMeta.z );
  float pgz = floor( ( vPropsWorld.z - uPropsLightMeta.y ) * uPropsLightMeta.z );
  if ( pgx >= 0.0 && pgz >= 0.0 && pgx < uPropsLightMeta2.x && pgz < uPropsLightMeta2.y ) {
    vec2 guv = ( vec2( pgx, pgz ) + 0.5 ) / vec2( uPropsLightMeta2.x, uPropsLightMeta2.y );
    vec4 cell = texture2D( uPropsLightGrid, guv );
    vec3 lampAcc = propsLampContrib( cell.x, vPropsWorld, normal )
                 + propsLampContrib( cell.y, vPropsWorld, normal )
                 + propsLampContrib( cell.z, vPropsWorld, normal )
                 + propsLampContrib( cell.w, vPropsWorld, normal );
    reflectedLight.directDiffuse +=
      lampAcc * uPropsLightMeta2.z * BRDF_Lambert( material.diffuseColor );
  }
}
#endif
`;

const VERT_TAIL = /* glsl */`
#include <worldpos_vertex>
#ifdef USE_INSTANCING
  vPropsWorld = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
#else
  vPropsWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#endif
`;

export class ClusterLights {
  static GAIN = 4.5;

  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = false;
    this.n = 0;
    this.night = 0;
    this.data = new Float32Array(MAX_LIGHTS * 2 * 4);
    this.tex = new THREE.DataTexture(this.data, MAX_LIGHTS, 2, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = this.tex.minFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;

    this.gw = 1; this.gh = 1;
    this.gridData = new Float32Array(4);
    this.grid = new THREE.DataTexture(this.gridData, 1, 1, THREE.RGBAFormat, THREE.FloatType);
    this.grid.magFilter = this.grid.minFilter = THREE.NearestFilter;
    this.grid.generateMipmaps = false;
    this.grid.needsUpdate = true;

    this.uMeta = { value: new THREE.Vector4(0, 0, 1 / CELL, MAX_LIGHTS) };
    this.uMeta2 = { value: new THREE.Vector4(1, 1, 0, 0) };
    this.uTex = { value: this.tex };
    this.uGrid = { value: this.grid };
    this._unregister = null;
    this._adopted = new Set();
  }

  /** Publish uniforms + register the patch. Safe to call when core is older. */
  install() {
    const M = this.ctx.materials;
    if (!M || typeof M.registerShaderPatch !== 'function' || !M.globalUniforms) {
      this.ctx.log.warn('materials.registerShaderPatch/globalUniforms unavailable — '
        + 'street lamps stay a painted gobo (R-props-6)');
      return false;
    }
    M.globalUniforms.uPropsLightTex = this.uTex;
    M.globalUniforms.uPropsLightGrid = this.uGrid;
    M.globalUniforms.uPropsLightMeta = this.uMeta;
    M.globalUniforms.uPropsLightMeta2 = this.uMeta2;

    // Below environment's CSM (order 50): the shadow term must still be able to
    // rewrite lights_fragment_begin after we have appended to _end.
    this.patched = 0;
    this._unregister = M.registerShaderPatch('props:cluster', (shader, material) => {
      if (shader.__propsCluster) return;
      if (shader.fragmentShader.indexOf('#include <lights_fragment_end>') < 0) return;
      if (shader.vertexShader.indexOf('#include <worldpos_vertex>') < 0) return;
      shader.vertexShader = 'varying vec3 vPropsWorld;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', VERT_TAIL);
      shader.fragmentShader = FRAG_PARS + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lights_fragment_end>', FRAG_BODY);
      shader.__propsCluster = true;
      this.patched++;
      if (material && material.userData) material.userData.propsLit = 1;
    }, { order: 10 });

    this.enabled = true;
    return true;
  }

  /**
   * Bring a material into the chain so it receives lamp light. Used for props'
   * own materials, and for any other module that publishes its materials on a
   * public API (`buildings.materials()`), which is the only sanctioned way to
   * reach across a module boundary.
   */
  has(material) { return this._adopted.has(material); }

  adopt(material, opts) {
    const M = this.ctx.materials;
    if (!material || !M || typeof M.adopt !== 'function') return;
    if (this._adopted.has(material)) return;
    this._adopted.add(material);
    try { M.adopt(material, opts); } catch { /* never fatal */ }
  }

  /* ------------------------------------------------------------ building -- */

  begin(bounds) {
    this.n = 0;
    const [x0, z0, x1, z1] = bounds;
    this.x0 = x0; this.z0 = z0;
    this.gw = Math.max(1, Math.min(256, Math.ceil((x1 - x0) / CELL)));
    this.gh = Math.max(1, Math.min(256, Math.ceil((z1 - z0) / CELL)));
    this._cells = new Float32Array(this.gw * this.gh * 4).fill(-1);
    this._fill = new Uint8Array(this.gw * this.gh);
    this.dropped = 0;
  }

  add(x, y, z, r, g, b, radius, intensity) {
    if (this.n >= MAX_LIGHTS) { this.dropped++; return false; }
    const i = this.n;
    const w = MAX_LIGHTS;
    this.data[i * 4 + 0] = x;
    this.data[i * 4 + 1] = y;
    this.data[i * 4 + 2] = z;
    this.data[i * 4 + 3] = radius;
    const o = (w + i) * 4;
    this.data[o + 0] = r; this.data[o + 1] = g; this.data[o + 2] = b;
    this.data[o + 3] = intensity;
    this.n++;

    // bin into every cell the sphere touches, so a lamp lights across a cell edge
    const i0 = Math.max(0, Math.floor((x - radius - this.x0) / CELL));
    const i1 = Math.min(this.gw - 1, Math.floor((x + radius - this.x0) / CELL));
    const j0 = Math.max(0, Math.floor((z - radius - this.z0) / CELL));
    const j1 = Math.min(this.gh - 1, Math.floor((z + radius - this.z0) / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let k = i0; k <= i1; k++) {
        const c = j * this.gw + k;
        const f = this._fill[c];
        if (f >= PER_CELL) { this.dropped++; continue; }
        this._cells[c * 4 + f] = i;
        this._fill[c] = f + 1;
      }
    }
    return true;
  }

  commit() {
    this.tex.needsUpdate = true;
    if (this.grid) this.grid.dispose();
    this.grid = new THREE.DataTexture(this._cells, this.gw, this.gh, THREE.RGBAFormat, THREE.FloatType);
    this.grid.magFilter = this.grid.minFilter = THREE.NearestFilter;
    this.grid.generateMipmaps = false;
    this.grid.needsUpdate = true;
    this.uGrid.value = this.grid;
    this.uMeta.value.set(this.x0, this.z0, 1 / CELL, MAX_LIGHTS);
    this.uMeta2.value.set(this.gw, this.gh, this.night, this.n);
    return { lights: this.n, cells: this.gw * this.gh, dropped: this.dropped };
  }

  /**
   * Per-light intensities are authored in THREE.PointLight units (a street
   * lantern at 58 cd / 30 m, which is what `roads`' own fallback lamp used).
   * Measured in the composed scene those land well below where they read: the
   * night frame goes through AgX plus `effects`' grade, and the exposure the
   * demo keys for is set by lit windows, not by the road. Rather than inflate
   * every light and lose the physical units, the whole rig carries one gain,
   * folded into the same uniform that fades the lights up at dusk.
   */
  setNight(n) {
    this.night = Math.max(0, Math.min(1, n));
    this.uMeta2.value.z = this.night * ClusterLights.GAIN;
  }

  stats() {
    return { lights: this.n, grid: `${this.gw}x${this.gh}`, cell: CELL, enabled: this.enabled };
  }

  dispose() {
    try { this._unregister?.(); } catch { /* ignore */ }
    this._unregister = null;
    const M = this.ctx.materials;
    if (M && M.globalUniforms) {
      delete M.globalUniforms.uPropsLightTex;
      delete M.globalUniforms.uPropsLightGrid;
      delete M.globalUniforms.uPropsLightMeta;
      delete M.globalUniforms.uPropsLightMeta2;
    }
    this.tex.dispose();
    this.grid?.dispose();
    this._adopted.clear();
    this.enabled = false;
  }
}

export default ClusterLights;
