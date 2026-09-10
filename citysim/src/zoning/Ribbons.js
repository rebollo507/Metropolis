import * as THREE from 'three';
import { PALETTE, ZONE_NAME } from './Palette.js';

/**
 * Terrain-conforming outline ribbons — the diagnostic view of the subdivision.
 *
 * Every lot edge, every block setback line and a frontage tick per lot are
 * emitted into ONE merged, vertex-coloured buffer (a single draw call). Ribbons
 * are re-sampled every ~5 m along their length and re-grounded, so on rolling
 * terrain they lie on the surface instead of cutting through it; each quad is
 * extended by half its width at both ends so corners mitre closed.
 */

const VERT = /* glsl */`
attribute vec3 color;
varying vec3 vCol;
varying float vFade;
#include <common>
#include <fog_pars_vertex>
void main() {
  vCol = color;
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vec4 mvPosition = viewMatrix * wp;
  vFade = clamp( 1.0 - ( -mvPosition.z - 900.0 ) / 900.0, 0.0, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */`
uniform float uOpacity;
varying vec3 vCol;
varying float vFade;
#include <common>
#include <fog_pars_fragment>
void main() {
  gl_FragColor = vec4( vCol, uOpacity * vFade );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class Ribbons {
  constructor(ctx) {
    this.ctx = ctx;
    this.mesh = null;
    this.material = null;
  }

  /**
   * @param {Array} lots
   * @param {Array} blocks
   * @param {object} terrain
   */
  build(lots, blocks, terrain, opts = {}) {
    const {
      lotWidth = 0.85,
      setbackWidth = 0.60,
      lift = 0.34,
      showSetback = true,
      showTicks = true,
    } = opts;

    this.dispose();
    const pos = [];
    const col = [];
    const idx = [];
    const h = (x, z) => (terrain ? terrain.heightAt(x, z) : 0);

    const push = (ax, az, bx, bz, w, r, g, b) => {
      const dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz);
      if (L < 0.02) return;
      const ux = dx / L, uz = dz / L;
      const nx = -uz * w * 0.5, nz = ux * w * 0.5;
      // extend by half-width so consecutive quads close their corners
      const ex = ux * w * 0.5, ez = uz * w * 0.5;
      const steps = Math.max(1, Math.min(24, Math.ceil(L / 5)));
      let prevBase = -1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax - ex + (dx + 2 * ex) * t;
        const pz = az - ez + (dz + 2 * ez) * t;
        const y = h(px, pz) + lift;
        const base = pos.length / 3;
        pos.push(px + nx, y, pz + nz, px - nx, y, pz - nz);
        col.push(r, g, b, r, g, b);
        if (prevBase >= 0) idx.push(prevBase, prevBase + 1, base, prevBase + 1, base + 1, base);
        prevBase = base;
      }
    };

    const lin = (hex, mul = 1) => {
      const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
      return [c.r * mul, c.g * mul, c.b * mul];
    };

    if (showSetback) {
      const sb = lin(0xa9c2dd, 0.9);
      for (const bl of blocks) {
        const P = bl.inset;
        if (!P || P.length < 3) continue;
        for (let i = 0; i < P.length; i++) {
          const a = P[i], b = P[(i + 1) % P.length];
          push(a[0], a[1], b[0], b[1], setbackWidth, sb[0], sb[1], sb[2]);
        }
      }
    }

    for (const lot of lots) {
      const p = PALETTE[ZONE_NAME[lot.zone]] || PALETTE.NONE;
      const side = lin(p.hex, 1.15);
      const front = lin(p.hex, 3.0);
      const P = lot.poly;
      const fa = lot.frontage.a, fb = lot.frontage.b;
      for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length];
        const onFront = nearFrontage(a, b, fa, fb);
        const c = onFront ? front : side;
        push(a[0], a[1], b[0], b[1], onFront ? lotWidth * 2.0 : lotWidth, c[0], c[1], c[2]);
      }
      if (showTicks) {
        const m = lot.frontage.mid, n = lot.frontage.normal;
        push(m[0], m[1], m[0] + n[0] * 3.0, m[1] + n[1] * 3.0, lotWidth * 1.3, front[0], front[1], front[2]);
      }
    }

    if (!pos.length) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uOpacity: { value: 0.95 } }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: true,
      side: THREE.DoubleSide,
    });

    try { this.ctx?.materials?.adopt?.(this.material); } catch { /* older core */ }

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'zoning:lotOutlines';
    this.mesh.renderOrder = 7;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.tris = idx.length / 3;
    return this.mesh;
  }

  dispose() {
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.removeFromParent(); }
    this.material?.dispose();
    this.mesh = null; this.material = null;
  }
}

/** Is edge a→b (roughly) the lot's street frontage? */
function nearFrontage(a, b, fa, fb) {
  const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const tol = 0.7;
  return (d(a, fa) < tol && d(b, fb) < tol) || (d(a, fb) < tol && d(b, fa) < tol);
}

export default Ribbons;
