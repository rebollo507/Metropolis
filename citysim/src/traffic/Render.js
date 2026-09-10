import * as THREE from 'three';
import { buildVehicle, paint } from './VehicleGeo.js';
import { VEH_SPEC, VEH_NAMES } from './Sim.js';

/**
 * Vehicle rendering.
 *
 * One `InstancedMesh` per (body type, LOD tier, part). Every frame `update()`
 * walks the live vehicles once, picks a tier from camera distance, interpolates
 * the transform between the two most recent 20 Hz ticks, and writes a matrix.
 * Nothing is allocated in that loop.
 *
 * Night adds two more batches that do most of the work of selling a lit street:
 * an additive light shaft in front of each vehicle and a soft pool of light on
 * the road under it. Tail lamps carry a per-instance colour so a decelerating
 * vehicle brightens to brake red, and indicators are a square-wave blink driven
 * off the sim clock (never the wall clock).
 */

/* Round 1 shipped 70 / 210 / 620 m and the critic found "not one vehicle
 * visible" in any wide frame. Same near-field-LOD finding as every other module.
 * A tier-2 body is a 5-ring loft, so reaching 1100 m costs triangles, not draw
 * calls — the batch count is fixed by the number of body types. */
const TIER_DIST = [110, 300];
const CULL_DIST = 1100;

export class VehicleRenderer {
  constructor(ctx, mats, sim) {
    this.ctx = ctx;
    this.mats = mats;
    this.sim = sim;
    this.group = new THREE.Group();
    this.group.name = 'traffic:vehicles';
    ctx.group.add(this.group);

    this.cap = sim.capacity;
    this.meshes = [];
    this.tiers = [];
    this.colors = new Float32Array(this.cap * 3);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
    this.night = 0;
    this.drawn = 0;
    this.tierCounts = [0, 0, 0];

    this._buildBatches();
    this._buildLights();
    this._assignPaint();
  }

  _mk(geo, mat, cap, name, cast) {
    const im = new THREE.InstancedMesh(geo, mat, cap);
    im.name = name;
    im.count = 0;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = !!cast;
    im.receiveShadow = true;
    im.frustumCulled = false;   // one bounding sphere over the whole city is useless
    this.group.add(im);
    this.meshes.push(im);
    return im;
  }

  _buildBatches() {
    const cap = this.cap;
    // rough per-type share of the fleet, with slack
    const share = [0.62, 0.14, 0.22, 0.14, 0.14, 0.10];
    this.tiers = [];
    let tris = 0;
    for (let t = 0; t < VEH_SPEC.length; t++) {
      const perType = Math.max(24, Math.ceil(cap * share[t]));
      const byTier = [];
      for (let lod = 0; lod < 3; lod++) {
        const g = buildVehicle(t, lod);
        tris += g.tris;
        const c = lod === 0 ? perType : Math.ceil(perType * (lod === 1 ? 0.8 : 0.7));
        const rec = { lod, count: 0, cap: c, spec: VEH_SPEC[t] };
        rec.body = this._mk(g.body, this.mats.paint, c, `traffic:${VEH_NAMES[t]}:body:${lod}`, lod < 2);
        rec.body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(c * 3), 3);
        rec.body.instanceColor.setUsage(THREE.DynamicDrawUsage);
        if (g.wheels) {
          rec.wheels = this._mk(g.wheels, this.mats.rubber, c, `traffic:${VEH_NAMES[t]}:wheels:${lod}`, false);
          // per-instance (roll, steer) for the wheel shader patch
          const spin = new THREE.InstancedBufferAttribute(new Float32Array(c * 2), 2);
          spin.setUsage(THREE.DynamicDrawUsage);
          g.wheels.setAttribute('aSpin', spin);
          rec.spin = spin;
          rec.wheelR = g.wheelR || 0.35;
        }
        if (g.glass) rec.glass = this._mk(g.glass, this.mats.glass, c, `traffic:${VEH_NAMES[t]}:glass:${lod}`, false);
        if (g.lampF) {
          rec.lampF = this._mk(g.lampF, this.mats.head, c, `traffic:${VEH_NAMES[t]}:lampF`, false);
          rec.lampR = this._mk(g.lampR, this.mats.tail, c, `traffic:${VEH_NAMES[t]}:lampR`, false);
          rec.lampR.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(c * 3), 3);
          rec.lampR.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
        byTier.push(rec);
      }
      this.tiers.push(byTier);
    }
    this.uniqueTris = tris;
  }

  _buildLights() {
    const cap = this.cap;
    // ground pool: a flat quad laid on the road just ahead of the vehicle
    const pg = new THREE.PlaneGeometry(1, 1);
    pg.rotateX(-Math.PI / 2);
    this.pool = this._mk(pg, this.mats.pool, cap, 'traffic:lightPool', false);
    this.pool.renderOrder = 3;
    this.pool.receiveShadow = false;

    // light shaft: two crossed quads fanning forward from the lamps
    const L = 10.5, W0 = 0.9, W1 = 3.4, H = 0.62;
    const posA = [-W0 / 2, H, 0, W0 / 2, H, 0, W1 / 2, H * 0.65, L, -W1 / 2, H * 0.65, L];
    const posB = [0, H - W0 / 2, 0, 0, H + W0 / 2, 0, 0, H * 0.65 + W1 / 2, L, 0, H * 0.65 - W1 / 2, L];
    const uv = [0, 0, 1, 0, 1, 1, 0, 1];
    const arr = [];
    const idx = [];
    for (const p of [posA, posB]) {
      const b = arr.length / 8;
      for (let i = 0; i < 4; i++) arr.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], 0, 1, 0, uv[i * 2], uv[i * 2 + 1]);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const sg = new THREE.BufferGeometry();
    const inter = new Float32Array(arr);
    const ib = new THREE.InterleavedBuffer(inter, 8);
    sg.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
    sg.setAttribute('normal', new THREE.InterleavedBufferAttribute(ib, 3, 3));
    sg.setAttribute('uv', new THREE.InterleavedBufferAttribute(ib, 2, 6));
    sg.setIndex(idx);
    this.shaft = this._mk(sg, this.mats.shaft, cap, 'traffic:lightShaft', false);
    this.shaft.renderOrder = 4;
  }

  _assignPaint() {
    // A colour per (slot, body type), drawn once from a dedicated stream. A
    // vehicle recycled into the same slot keeps its paint, and nothing in the
    // spawn path has to touch an rng, so respawning cannot shift the sequence.
    const T = VEH_SPEC.length;
    this.colors = new Float32Array(this.cap * T * 3);
    const rng = this.ctx.rng;
    for (let i = 0; i < this.cap; i++) {
      for (let t = 0; t < T; t++) {
        paint(rng, this._c, t);
        const o = (i * T + t) * 3;
        this.colors[o] = this._c.r;
        this.colors[o + 1] = this._c.g;
        this.colors[o + 2] = this._c.b;
      }
    }
  }

  setNight(n) { this.night = n; }

  /**
   * @param alpha 0..1 interpolation between the last two sim ticks
   */
  update(alpha, camera, simTime) {
    const sim = this.sim;
    const tiers = this.tiers;
    for (const byTier of tiers) for (const rec of byTier) rec.count = 0;
    let poolN = 0, shaftN = 0;
    this.tierCounts[0] = this.tierCounts[1] = this.tierCounts[2] = 0;

    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const night = this.night;
    const blinkOn = (simTime % 0.86) < 0.45;
    const poolMesh = this.pool, shaftMesh = this.shaft;

    for (let i = 0; i < sim.capacity; i++) {
      if (!sim.alive[i]) continue;
      const o = i * 4;
      const px = sim.prev[o] + (sim.cur[o] - sim.prev[o]) * alpha;
      const py = sim.prev[o + 1] + (sim.cur[o + 1] - sim.prev[o + 1]) * alpha;
      const pz = sim.prev[o + 2] + (sim.cur[o + 2] - sim.prev[o + 2]) * alpha;
      const yaw = sim.prev[o + 3] + (sim.cur[o + 3] - sim.prev[o + 3]) * alpha;

      const dx = px - cx, dy = py - cy, dz = pz - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > CULL_DIST * CULL_DIST) continue;
      const lod = d2 < TIER_DIST[0] * TIER_DIST[0] ? 0 : (d2 < TIER_DIST[1] * TIER_DIST[1] ? 1 : 2);

      const t = sim.type[i];
      const rec = tiers[t][lod];
      if (rec.count >= rec.cap) continue;
      const k = rec.count++;
      this.tierCounts[lod]++;

      this._p.set(px, py, pz);
      this._q.setFromAxisAngle(this._up, yaw);
      this._m.compose(this._p, this._q, this._s);

      rec.body.setMatrixAt(k, this._m);
      const co = (i * VEH_SPEC.length + t) * 3;
      rec.body.instanceColor.setXYZ(k, this.colors[co], this.colors[co + 1], this.colors[co + 2]);
      if (rec.wheels) {
        rec.wheels.setMatrixAt(k, this._m);
        rec.spin.setXY(k, sim.odo[i] / rec.wheelR, sim.steer[i]);
      }
      if (rec.glass) rec.glass.setMatrixAt(k, this._m);

      if (rec.lampF) {
        rec.lampF.setMatrixAt(k, this._m);
        rec.lampR.setMatrixAt(k, this._m);
        // brake lights respond to real deceleration; indicators square-wave
        const dec = Math.max(0, -sim.acc[i]);
        let brake = Math.min(1, dec / 2.2);
        if (sim.v[i] < 0.4 && sim.gate[i]) brake = Math.max(brake, 0.85);
        const bl = sim.blink[i];
        const flash = bl !== 0 && blinkOn ? 1 : 0;
        const rr = 0.30 + brake * 2.6 + flash * 1.1;
        const gg = flash * 0.42;
        rec.lampR.instanceColor.setXYZ(k, rr, gg, gg * 0.16);
      }

      if (night > 0.02 && lod < 2) {
        const spec = VEH_SPEC[t];
        const fx = Math.sin(yaw), fz = Math.cos(yaw);
        if (poolN < this.cap) {
          const pd = spec.len * 0.5 + 3.2;
          this._p.set(px + fx * pd, py + 0.03, pz + fz * pd);
          this._s.set(5.6, 1, 7.4);
          this._m.compose(this._p, this._q, this._s);
          poolMesh.setMatrixAt(poolN++, this._m);
          this._s.set(1, 1, 1);
        }
        if (shaftN < this.cap && lod === 0) {
          const sd = spec.len * 0.5 - 0.05;
          this._p.set(px + fx * sd, py, pz + fz * sd);
          this._m.compose(this._p, this._q, this._s);
          shaftMesh.setMatrixAt(shaftN++, this._m);
        }
      }
    }

    let calls = 0;
    for (const byTier of tiers) {
      for (const rec of byTier) {
        const n = rec.count;
        for (const part of _PARTS) {
          const m = rec[part];
          if (!m) continue;
          m.count = n;
          m.visible = n > 0;
          if (n > 0) {
            m.instanceMatrix.needsUpdate = true;
            if (m.instanceColor) m.instanceColor.needsUpdate = true;
            calls++;
          }
          if (part === 'wheels' && n > 0 && rec.spin) rec.spin.needsUpdate = true;
        }
      }
    }
    poolMesh.count = poolN; poolMesh.visible = poolN > 0 && night > 0.02;
    shaftMesh.count = shaftN; shaftMesh.visible = shaftN > 0 && night > 0.02;
    if (poolN) poolMesh.instanceMatrix.needsUpdate = true;
    if (shaftN) shaftMesh.instanceMatrix.needsUpdate = true;
    if (poolMesh.visible) calls++;
    if (shaftMesh.visible) calls++;
    this.drawn = calls;
  }

  dispose() {
    for (const m of this.meshes) {
      m.geometry.dispose();
      m.dispose?.();
      m.removeFromParent();
    }
    this.meshes.length = 0;
    this.group.removeFromParent();
  }
}

const _PARTS = ['body', 'wheels', 'glass', 'lampF', 'lampR'];

export default VehicleRenderer;
