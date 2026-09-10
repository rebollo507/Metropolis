import * as THREE from 'three';

/**
 * Instance collector → one `InstancedMesh` per (geometry, material) pair.
 *
 * Two-pass on purpose: the scatter passes push raw matrices into flat arrays
 * (no Matrix4 garbage, no capacity guessing), then `build()` allocates each
 * InstancedMesh at exactly the right size. A full city ends up as ~90 meshes,
 * which is the honest cost of the module — one draw call each, plus one more
 * for each that casts a shadow.
 *
 * Only structural props cast shadows. A bin's shadow is invisible at any
 * distance you would notice it and doubles its draw-call cost, so it is off.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

export class BatchSet {
  constructor(ctx) {
    this.ctx = ctx;
    this.kinds = new Map();     // key -> {geo, mat, cast, receive, order, mat4:[], col:[]}
    this.meshes = [];
    this.tris = 0;
  }

  /** Register a kind. Safe to call repeatedly; the first call wins. */
  define(key, geo, mat, { cast = false, receive = true, order = 0 } = {}) {
    if (!geo || !mat) return null;
    let k = this.kinds.get(key);
    if (!k) {
      k = { key, geo, mat, cast, receive, order, m: [], c: [], n: 0 };
      this.kinds.set(key, k);
    }
    return k;
  }

  has(key) { return this.kinds.has(key); }

  /** Push one instance from position / Y-rotation / scale, with an optional tint. */
  put(key, x, y, z, rotY = 0, sx = 1, sy = sx, sz = sx, color = null, tiltX = 0, tiltZ = 0) {
    const k = this.kinds.get(key);
    if (!k) return false;
    _p.set(x, y, z);
    if (tiltX || tiltZ) {
      _e.set(tiltX, rotY, tiltZ, 'YXZ');
      _q.setFromEuler(_e);
    } else {
      _q.setFromAxisAngle(_up, rotY);
    }
    _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s);
    const a = _m.elements;
    for (let i = 0; i < 16; i++) k.m.push(a[i]);
    if (color) k.c.push(color.r, color.g, color.b);
    else k.c.push(1, 1, 1);
    k.n++;
    return true;
  }

  /** Push a raw matrix (used where a prop needs a full orientation). */
  putMatrix(key, m4, color = null) {
    const k = this.kinds.get(key);
    if (!k) return false;
    const a = m4.elements;
    for (let i = 0; i < 16; i++) k.m.push(a[i]);
    if (color) k.c.push(color.r, color.g, color.b);
    else k.c.push(1, 1, 1);
    k.n++;
    return true;
  }

  count(key) { const k = this.kinds.get(key); return k ? k.n : 0; }

  /**
   * `mats` = PropMaterials, used to build a matching depth material for every
   * shadow caster so the shadow pass gets the same wind sway and the same
   * distance collapse as the beauty pass (R-props-7). Without it a tree that has
   * been collapsed to a point still casts a full-resolution shadow at 1.4 km.
   */
  build(group, mats = null) {
    let calls = 0, tris = 0, instances = 0;
    const ordered = [...this.kinds.values()].sort((a, b) => a.order - b.order);
    for (const k of ordered) {
      if (!k.n) continue;
      const im = new THREE.InstancedMesh(k.geo, k.mat, k.n);
      im.name = `props:${k.key}`;
      im.instanceMatrix.array.set(k.m);
      im.instanceMatrix.needsUpdate = true;
      const col = new THREE.InstancedBufferAttribute(new Float32Array(k.c), 3);
      im.instanceColor = col;
      im.instanceColor.needsUpdate = true;
      im.castShadow = k.cast;
      im.receiveShadow = k.receive;
      if (k.cast && mats && typeof mats.depthFor === 'function') {
        im.customDepthMaterial = mats.depthFor(k.mat, {
          alphaTest: k.mat.alphaTest || 0, map: k.mat.map || null,
        });
        if (this.ctx.materials && typeof this.ctx.materials.adoptMesh === 'function') {
          try { this.ctx.materials.adoptMesh(im); } catch { /* never fatal */ }
        }
      }
      im.renderOrder = k.order;
      im.frustumCulled = true;
      im.matrixAutoUpdate = false;
      im.updateMatrix();
      im.computeBoundingSphere();
      group.add(im);
      this.meshes.push(im);
      calls += 1 + (k.cast ? 1 : 0);
      instances += k.n;
      tris += ((k.geo.index ? k.geo.index.count : k.geo.attributes.position.count) / 3) * k.n;
      // free the staging arrays
      k.m.length = 0; k.c.length = 0;
    }
    this.tris = tris;
    return { meshes: this.meshes.length, drawCalls: calls, instances, triangles: Math.round(tris) };
  }

  /** Per-kind instance counts, for the honest report. */
  report() {
    const o = {};
    for (const k of this.kinds.values()) if (k.n) o[k.key] = k.n;
    return o;
  }

  clear(group) {
    for (const m of this.meshes) { group.remove(m); m.dispose(); }
    this.meshes.length = 0;
    for (const k of this.kinds.values()) { k.m.length = 0; k.c.length = 0; k.n = 0; }
  }

  dispose(group) {
    this.clear(group);
    this.kinds.clear();
  }
}

export default BatchSet;
