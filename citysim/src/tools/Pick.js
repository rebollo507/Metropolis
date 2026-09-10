import * as THREE from 'three';
import { corridorHalf, halfWidth } from './Rules.js';
import { angDiff } from './curve.js';

/**
 * Where the cursor is on the ground, and where it should *snap* to.
 *
 * The city has no per-object colliders — buildings are merged per block and
 * props are instanced — so picking is done against the heightfield through
 * `terrain.raycastGround`, exactly as `ui` does it. That is cheaper than a mesh
 * raycast and it stays correct while a terrain brush is deforming the ground,
 * because the sampler closes over the live height array.
 *
 * The whole class is allocation-free after construction: the ray, the vectors
 * and the result objects are all reused, and the ground point is only
 * recomputed when the pointer or the camera actually moved.
 */

const SNAP = {
  node: 11,          // metres — reuse an existing junction
  road: 6.5,         // metres — attach to a segment (creates a T)
  grid: 4,           // metres — default lattice
  angleStep: Math.PI / 12,   // 15°
  offsetStep: 20,    // parallel offsets snap to multiples of this
  offsetTol: 3.5,
  parallelTol: 0.22, // radians
};

export class Picker {
  constructor(ctx) {
    this.ctx = ctx;
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this.pointer = { x: 0, y: 0, inside: false, moved: false };
    this.hover = { x: 0, y: 0, z: 0, valid: false };
    this.snapped = { x: 0, y: 0, z: 0, kind: 'free', nodeId: null, segId: null, t: 0, angle: 0, note: '' };
    this.modifiers = { shift: false, alt: false, ctrl: false };
    this.grid = SNAP.grid;
    this._camKey = 0;
    this._dirty = true;
    this._sn = { d: 0, t: 0, x: 0, z: 0 };
  }

  get env() {
    return {
      terrain: safe(this.ctx, 'terrain'),
      roads: safe(this.ctx, 'roads'),
    };
  }

  setPointer(px, py, rect) {
    const w = rect.width || 1, h = rect.height || 1;
    const nx = ((px - rect.left) / w) * 2 - 1;
    const ny = -((py - rect.top) / h) * 2 + 1;
    if (nx !== this.ndc.x || ny !== this.ndc.y) this._dirty = true;
    this.ndc.set(nx, ny);
    this.pointer.x = px; this.pointer.y = py; this.pointer.inside = true;
  }

  leave() { this.pointer.inside = false; }

  /** Cheap camera-change detector — no allocation, no matrix compare. */
  _cameraMoved() {
    const c = this.ctx.camera;
    const k = c.position.x * 7.13 + c.position.y * 3.71 + c.position.z * 1.97
      + c.quaternion.x * 911 + c.quaternion.y * 523 + c.quaternion.z * 271 + c.quaternion.w * 137;
    if (Math.abs(k - this._camKey) > 1e-6) { this._camKey = k; return true; }
    return false;
  }

  /** Recompute the ground point if anything moved. Returns `hover`. */
  update(force = false) {
    const moved = this._cameraMoved();
    if (!force && !this._dirty && !moved) return this.hover;
    this._dirty = false;
    if (!this.pointer.inside) { this.hover.valid = false; return this.hover; }

    this.ray.setFromCamera(this.ndc, this.ctx.camera);
    this._o.copy(this.ray.ray.origin);
    this._d.copy(this.ray.ray.direction);

    const terrain = safe(this.ctx, 'terrain');
    if (terrain && terrain.raycastGround) {
      const hit = terrain.raycastGround(this._o, this._d, 9000);
      if (hit) {
        this.hover.x = hit.x; this.hover.y = hit.y; this.hover.z = hit.z;
        this.hover.valid = true;
        return this.hover;
      }
    }
    // no terrain module (or the ray escaped): fall back to the water plane
    const y0 = this.ctx.world.terrain.water ?? 0;
    if (Math.abs(this._d.y) < 1e-5) { this.hover.valid = false; return this.hover; }
    const t = (y0 - this._o.y) / this._d.y;
    if (t <= 0) { this.hover.valid = false; return this.hover; }
    this.hover.x = this._o.x + this._d.x * t;
    this.hover.y = y0;
    this.hover.z = this._o.z + this._d.z * t;
    this.hover.valid = true;
    return this.hover;
  }

  heightAt(x, z) {
    const t = safe(this.ctx, 'terrain');
    if (t && t.heightAt) return t.heightAt(x, z);
    return this.ctx.world.heightAt(x, z);
  }

  /**
   * Snap a world point.
   *
   * Priority: an existing junction, then an existing carriageway (which becomes
   * a T), then — when an anchor is given — angle lock and parallel offset, then
   * the lattice. `alt` frees the cursor completely.
   */
  snap(x, z, opts = {}) {
    const s = this.snapped;
    s.x = x; s.z = z; s.kind = 'free'; s.nodeId = null; s.segId = null; s.t = 0; s.note = '';
    s.angle = 0;
    const roads = safe(this.ctx, 'roads');
    const free = this.modifiers.alt || opts.free;
    const anchor = opts.anchor || null;
    const cls = opts.class || 'lane2';

    if (!free && roads) {
      // 1 — existing node
      const r = SNAP.node;
      const nid = roads.snapToExisting ? roads.snapToExisting([x, 0, z], r) : null;
      if (nid !== null && nid !== undefined) {
        const n = this.ctx.world.roads.nodes.get(nid);
        if (n) {
          s.x = n.pos[0]; s.z = n.pos[2]; s.kind = 'node'; s.nodeId = nid;
          s.note = n.edges && n.edges.length > 2 ? 'junction' : 'road end';
          s.y = this.heightAt(s.x, s.z);
          return s;
        }
      }
      // 2 — existing carriageway → a new T junction
      if (roads.nearestPoint) {
        const hit = roads.nearestPoint({ x, z }, 60);
        if (hit && hit.dist < Math.max(SNAP.road, halfWidth(hit.class || 'lane2') * 0.8)) {
          s.x = hit.pos.x; s.z = hit.pos.z; s.kind = 'road'; s.segId = hit.segmentId; s.t = hit.t;
          s.note = 'new junction';
          s.y = this.heightAt(s.x, s.z);
          return s;
        }
      }
    }

    if (!free && anchor) {
      // 3 — angle lock (held modifier, or always for the straight tool's 90°)
      if (this.modifiers.shift) {
        const dx = x - anchor[0], dz = z - anchor[1];
        const len = Math.hypot(dx, dz);
        if (len > 1) {
          const a = Math.round(Math.atan2(dz, dx) / SNAP.angleStep) * SNAP.angleStep;
          s.x = anchor[0] + Math.cos(a) * len;
          s.z = anchor[1] + Math.sin(a) * len;
          s.kind = 'angle';
          s.angle = a;
          s.note = `${Math.round((a * 180 / Math.PI + 360) % 360)}°`;
          s.y = this.heightAt(s.x, s.z);
          return s;
        }
      }
      // 4 — parallel offset from a nearby road
      const par = this._parallel(anchor, x, z, cls);
      if (par) { s.y = this.heightAt(s.x, s.z); return s; }
    }

    if (!free && this.grid > 0) {
      s.x = Math.round(x / this.grid) * this.grid;
      s.z = Math.round(z / this.grid) * this.grid;
      s.kind = 'grid';
      s.note = `${this.grid} m grid`;
    }
    s.y = this.heightAt(s.x, s.z);
    return s;
  }

  /**
   * If the pending road runs roughly parallel to a nearby one, pull its offset
   * onto a multiple of `offsetStep` so blocks come out even. This is the snap
   * that makes a hand-drawn grid look designed rather than sketched.
   */
  _parallel(anchor, x, z, cls) {
    const roads = safe(this.ctx, 'roads');
    if (!roads || !roads.nearestPoint) return null;
    const dx = x - anchor[0], dz = z - anchor[1];
    const len = Math.hypot(dx, dz);
    if (len < 12) return null;
    const myH = Math.atan2(dz, dx);
    const mid = { x: (anchor[0] + x) / 2, z: (anchor[1] + z) / 2 };
    const hit = roads.nearestPoint(mid, 140);
    if (!hit) return null;
    const tan = roads.tangentAt(hit.segmentId, hit.t);
    const otH = Math.atan2(tan.z, tan.x);
    let d = Math.abs(angDiff(myH, otH));
    if (d > Math.PI / 2) d = Math.PI - d;
    if (d > SNAP.parallelTol) return null;

    const minGap = corridorHalf(cls) + corridorHalf(hit.class || 'lane2') + 6;
    const want = Math.max(minGap, Math.round(hit.dist / SNAP.offsetStep) * SNAP.offsetStep);
    if (Math.abs(want - hit.dist) > SNAP.offsetTol) return null;
    // move the endpoint perpendicular to the reference road by the correction
    const nx = -tan.z, nz = tan.x;
    const side = Math.sign((mid.x - hit.pos.x) * nx + (mid.z - hit.pos.z) * nz) || 1;
    const corr = (want - hit.dist) * side;
    const s = this.snapped;
    s.x = x + nx * corr;
    s.z = z + nz * corr;
    s.kind = 'parallel';
    s.segId = hit.segmentId;
    s.note = `${Math.round(want)} m offset`;
    return s;
  }
}

function safe(ctx, name) { try { return ctx.get(name); } catch { return null; } }

export { SNAP };
export default Picker;
