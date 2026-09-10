import * as THREE from 'three';

/** Shared geometry pool + instanced-mesh batching helper. */
export class Registry {
  constructor() {
    this.geometries = new Map();
    this.batches = new Map();
  }

  /** geo('box:1x1x1', () => new THREE.BoxGeometry(1,1,1)) */
  geo(key, build) {
    if (this.geometries.has(key)) return this.geometries.get(key);
    const g = build();
    this.geometries.set(key, g);
    return g;
  }

  unitBox() { return this.geo('unit:box', () => new THREE.BoxGeometry(1, 1, 1)); }
  unitPlane() { return this.geo('unit:plane', () => new THREE.PlaneGeometry(1, 1)); }
  unitCyl(seg = 12) { return this.geo('unit:cyl' + seg, () => new THREE.CylinderGeometry(0.5, 0.5, 1, seg)); }
  unitSphere(seg = 16) { return this.geo('unit:sph' + seg, () => new THREE.SphereGeometry(0.5, seg, seg / 2)); }

  /**
   * Create (or fetch) an InstancedMesh batch. Grows by re-allocating when full.
   * `add(matrix, color?)` returns the instance index.
   */
  batch(key, geometry, material, capacity = 1024, parent = null) {
    if (this.batches.has(key)) return this.batches.get(key);
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    const api = {
      mesh,
      capacity,
      add(matrix, color) {
        if (mesh.count >= api.capacity) return -1;
        const i = mesh.count++;
        mesh.setMatrixAt(i, matrix);
        if (color !== undefined) {
          if (!mesh.instanceColor) {
            mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(api.capacity * 3), 3);
            mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
          }
          mesh.setColorAt(i, color);
        }
        return i;
      },
      commit() {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
      },
      clear() { mesh.count = 0; },
    };
    if (parent) parent.add(mesh);
    this.batches.set(key, api);
    return api;
  }

  dispose() {
    for (const g of this.geometries.values()) g.dispose();
    for (const b of this.batches.values()) { b.mesh.dispose(); b.mesh.removeFromParent(); }
    this.geometries.clear();
    this.batches.clear();
  }
}

export default Registry;
