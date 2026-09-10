import { ZONE } from '../core/World.js';
import { pointInPoly, bbox } from './geom.js';

/**
 * The zoning cell grid — `world.zoning.cells`, 8 m cells over the whole map.
 *
 * Everything here is allocation-light: painting writes into the existing
 * Uint8Array, undo keeps a bounded stack of rectangular patches (not full-grid
 * copies), and the dirty rectangle is tracked so the overlay only re-uploads the
 * part of the DataTexture that actually changed.
 *
 * ROAD and WATER are masks, not land use: painting never overwrites them and
 * erase() never clears them. `onlyZoned` additionally restricts a stroke to land
 * that already carries a use — that is what lets a district be laid out once and
 * then re-coloured with loose brush strokes that cannot spill onto raw hillside.
 *
 * **Authored vs derived (R-tools-6).** A parallel `authored` bitmap records which
 * cells a person painted. `clearDerived()` wipes only the rest, so laying a road
 * no longer destroys a hand-planned district — which it did, silently, for three
 * rounds. Physical facts still win: a cell that becomes ROAD or WATER loses its
 * authored bit, because the land it described is gone.
 */

const MASK = new Set([ZONE.ROAD, ZONE.WATER]);
const UNDO_CAP = 40;

export class ZoneGrid {
  constructor(world, log = null) {
    this.world = world;
    this.log = log;
    const z = world.zoning;
    this.cellSize = z.cellSize || 8;
    this.size = world.terrain?.size || 2048;
    this.gridW = Math.max(1, Math.round(this.size / this.cellSize));
    this.gridH = this.gridW;
    this.originX = -this.size / 2;
    this.originZ = -this.size / 2;

    if (!z.cells || z.cells.length !== this.gridW * this.gridH) {
      z.cells = new Uint8Array(this.gridW * this.gridH);
    }
    if (!z.authored || z.authored.length !== this.gridW * this.gridH) {
      z.authored = new Uint8Array(this.gridW * this.gridH);
    }
    z.gridW = this.gridW;
    z.gridH = this.gridH;
    z.cellSize = this.cellSize;
    this.cells = z.cells;
    this.authored = z.authored;
    /** while true, every stroke marks its cells as hand-authored */
    this.authoring = true;

    this.undoStack = [];
    this.dirty = null;
    this._pending = null;
  }

  /* ------------------------------------------------------------ mapping -- */

  ci(x) { return Math.floor((x - this.originX) / this.cellSize); }
  cj(z) { return Math.floor((z - this.originZ) / this.cellSize); }
  wx(i) { return this.originX + (i + 0.5) * this.cellSize; }
  wz(j) { return this.originZ + (j + 0.5) * this.cellSize; }
  inside(i, j) { return i >= 0 && j >= 0 && i < this.gridW && j < this.gridH; }

  zoneAt(x, z) {
    const i = this.ci(x), j = this.cj(z);
    return this.inside(i, j) ? this.cells[j * this.gridW + i] : ZONE.NONE;
  }

  /* -------------------------------------------------------------- dirty -- */

  _touch(i0, j0, i1, j1) {
    if (!this.dirty) this.dirty = { i0, j0, i1, j1 };
    else {
      const d = this.dirty;
      if (i0 < d.i0) d.i0 = i0;
      if (j0 < d.j0) d.j0 = j0;
      if (i1 > d.i1) d.i1 = i1;
      if (j1 > d.j1) d.j1 = j1;
    }
  }

  clearDirty() { const d = this.dirty; this.dirty = null; return d; }

  /* --------------------------------------------------------------- undo -- */

  _snapshot(i0, j0, i1, j1) {
    i0 = Math.max(0, i0); j0 = Math.max(0, j0);
    i1 = Math.min(this.gridW - 1, i1); j1 = Math.min(this.gridH - 1, j1);
    if (i1 < i0 || j1 < j0) return null;
    const w = i1 - i0 + 1, h = j1 - j0 + 1;
    const data = new Uint8Array(w * h);
    const auth = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      const src = (j0 + j) * this.gridW + i0;
      data.set(this.cells.subarray(src, src + w), j * w);
      auth.set(this.authored.subarray(src, src + w), j * w);
    }
    return { i0, j0, w, h, data, auth };
  }

  _pushUndo(patch) {
    if (!patch) return;
    this.undoStack.push(patch);
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift();
  }

  undo() {
    const p = this.undoStack.pop();
    if (!p) return false;
    for (let j = 0; j < p.h; j++) {
      const dst = (p.j0 + j) * this.gridW + p.i0;
      this.cells.set(p.data.subarray(j * p.w, j * p.w + p.w), dst);
      if (p.auth) this.authored.set(p.auth.subarray(j * p.w, j * p.w + p.w), dst);
    }
    this._touch(p.i0, p.j0, p.i0 + p.w - 1, p.j0 + p.h - 1);
    return true;
  }

  /* ------------------------------------------------------------- filling -- */

  /** Reset every land-use cell AND every authored bit. Full wipe. */
  clearAll() {
    this.cells.fill(ZONE.NONE);
    this.authored.fill(0);
    this.undoStack.length = 0;
    this._touch(0, 0, this.gridW - 1, this.gridH - 1);
  }

  /**
   * Reset only the cells `autoZone` owns, leaving hand-painted land intact.
   * This is what a road edit runs; `clearAll()` is now reserved for a genuine
   * new city.
   * @returns {number} authored cells preserved
   */
  clearDerived() {
    let kept = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.authored[i]) { kept++; continue; }
      this.cells[i] = ZONE.NONE;
    }
    this.undoStack.length = 0;
    this._touch(0, 0, this.gridW - 1, this.gridH - 1);
    return kept;
  }

  /** Release cells back to the auto-zoner (whole grid, or inside a shape). */
  clearAuthored(shape = null) {
    if (!shape) { this.authored.fill(0); this._touch(0, 0, this.gridW - 1, this.gridH - 1); return this.cells.length; }
    let n = 0;
    this._forShape(shape, (idx) => { if (this.authored[idx]) { this.authored[idx] = 0; n++; } });
    return n;
  }

  /** Run `fn(cellIndex)` over a polygon / circle / rect brush. */
  _forShape(shape, fn) {
    if (Array.isArray(shape)) {
      const b = bbox(shape);
      const i0 = Math.max(0, this.ci(b.x0)), i1 = Math.min(this.gridW - 1, this.ci(b.x1));
      const j0 = Math.max(0, this.cj(b.z0)), j1 = Math.min(this.gridH - 1, this.cj(b.z1));
      for (let j = j0; j <= j1; j++) {
        const cz = this.wz(j);
        for (let i = i0; i <= i1; i++) if (pointInPoly(shape, this.wx(i), cz)) fn(j * this.gridW + i);
      }
      return;
    }
    if (!shape || typeof shape !== 'object') return;
    if (shape.r !== undefined || shape.radius !== undefined) {
      const r = shape.r ?? shape.radius, r2 = r * r;
      const i0 = Math.max(0, this.ci(shape.x - r)), i1 = Math.min(this.gridW - 1, this.ci(shape.x + r));
      const j0 = Math.max(0, this.cj(shape.z - r)), j1 = Math.min(this.gridH - 1, this.cj(shape.z + r));
      for (let j = j0; j <= j1; j++) {
        const dz = this.wz(j) - shape.z;
        for (let i = i0; i <= i1; i++) {
          const dx = this.wx(i) - shape.x;
          if (dx * dx + dz * dz <= r2) fn(j * this.gridW + i);
        }
      }
      return;
    }
    if (shape.x0 !== undefined) {
      const i0 = Math.max(0, this.ci(Math.min(shape.x0, shape.x1)));
      const i1 = Math.min(this.gridW - 1, this.ci(Math.max(shape.x0, shape.x1)));
      const j0 = Math.max(0, this.cj(Math.min(shape.z0, shape.z1)));
      const j1 = Math.min(this.gridH - 1, this.cj(Math.max(shape.z0, shape.z1)));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * this.gridW + i);
    }
  }

  authoredCount() {
    let n = 0;
    for (let i = 0; i < this.authored.length; i++) if (this.authored[i]) n++;
    return n;
  }

  /** Mark every submerged cell WATER. */
  stampWater(terrain, waterLevel = 0) {
    if (!terrain) return 0;
    let n = 0;
    const isW = terrain.isWater
      ? (x, z) => terrain.isWater(x, z)
      : (x, z) => terrain.heightAt(x, z) < waterLevel + 0.001;
    for (let j = 0; j < this.gridH; j++) {
      for (let i = 0; i < this.gridW; i++) {
        if (isW(this.wx(i), this.wz(j))) {
          const k = j * this.gridW + i;
          this.cells[k] = ZONE.WATER; this.authored[k] = 0; n++;
        }
      }
    }
    this._touch(0, 0, this.gridW - 1, this.gridH - 1);
    return n;
  }

  /**
   * Mark the road corridor. `polys` is the flattened-polyline map from the
   * planar build so the mask follows curves exactly; `radiusOf(cls)` gives the
   * corridor half-width (carriageway + sidewalk).
   */
  stampRoads(polys, radiusOf) {
    let n = 0;
    const cs = this.cellSize;
    for (const p of polys.values()) {
      const r = radiusOf(p.cls) + 0.6;
      const r2 = r * r;
      for (let k = 0; k < p.pts.length - 1; k++) {
        const ax = p.pts[k][0], az = p.pts[k][1];
        const bx = p.pts[k + 1][0], bz = p.pts[k + 1][1];
        const i0 = this.ci(Math.min(ax, bx) - r), i1 = this.ci(Math.max(ax, bx) + r);
        const j0 = this.cj(Math.min(az, bz) - r), j1 = this.cj(Math.max(az, bz) + r);
        const ex = bx - ax, ez = bz - az;
        const L2 = ex * ex + ez * ez || 1e-9;
        for (let j = Math.max(0, j0); j <= Math.min(this.gridH - 1, j1); j++) {
          const cz = this.originZ + (j + 0.5) * cs;
          for (let i = Math.max(0, i0); i <= Math.min(this.gridW - 1, i1); i++) {
            const cx = this.originX + (i + 0.5) * cs;
            let u = ((cx - ax) * ex + (cz - az) * ez) / L2;
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            const dx = cx - (ax + ex * u), dz = cz - (az + ez * u);
            if (dx * dx + dz * dz > r2) continue;
            const idx = j * this.gridW + i;
            if (this.cells[idx] === ZONE.WATER) continue;
            // the land a painted zone described is gone — release the bit
            this.authored[idx] = 0;
            if (this.cells[idx] !== ZONE.ROAD) { this.cells[idx] = ZONE.ROAD; n++; }
          }
        }
      }
    }
    this._touch(0, 0, this.gridW - 1, this.gridH - 1);
    return n;
  }

  /* ------------------------------------------------------------ painting -- */

  /**
   * Paint a polygon (array of [x,z]).
   * @param {boolean} respectMask keep ROAD/WATER cells intact (default true)
   * @param {boolean} record push an undo patch (default true)
   */
  paintPolygon(pts, zone, { respectMask = true, record = true, onlyZoned = false, respectAuthored = false, authored = null } = {}) {
    if (!pts || pts.length < 3) return 0;
    const b = bbox(pts);
    const i0 = Math.max(0, this.ci(b.x0)), i1 = Math.min(this.gridW - 1, this.ci(b.x1));
    const j0 = Math.max(0, this.cj(b.z0)), j1 = Math.min(this.gridH - 1, this.cj(b.z1));
    if (i1 < i0 || j1 < j0) return 0;
    if (record) this._pushUndo(this._snapshot(i0, j0, i1, j1));
    let n = 0;
    for (let j = j0; j <= j1; j++) {
      const cz = this.wz(j);
      for (let i = i0; i <= i1; i++) {
        const idx = j * this.gridW + i;
        if (respectMask && MASK.has(this.cells[idx])) continue;
        if (respectAuthored && this.authored[idx]) continue;
        if (onlyZoned && this.cells[idx] === ZONE.NONE) continue;
        if (!pointInPoly(pts, this.wx(i), cz)) continue;
        this.cells[idx] = zone;
        this.authored[idx] = (authored === null ? (this.authoring ? 1 : 0) : (authored ? 1 : 0));
        n++;
      }
    }
    this._touch(i0, j0, i1, j1);
    return n;
  }

  paintCircle(x, z, r, zone, { respectMask = true, record = true, onlyZoned = false, respectAuthored = false, authored = null } = {}) {
    const i0 = Math.max(0, this.ci(x - r)), i1 = Math.min(this.gridW - 1, this.ci(x + r));
    const j0 = Math.max(0, this.cj(z - r)), j1 = Math.min(this.gridH - 1, this.cj(z + r));
    if (i1 < i0 || j1 < j0) return 0;
    if (record) this._pushUndo(this._snapshot(i0, j0, i1, j1));
    const r2 = r * r;
    let n = 0;
    for (let j = j0; j <= j1; j++) {
      const cz = this.wz(j), dz = cz - z;
      for (let i = i0; i <= i1; i++) {
        const dx = this.wx(i) - x;
        if (dx * dx + dz * dz > r2) continue;
        const idx = j * this.gridW + i;
        if (respectMask && MASK.has(this.cells[idx])) continue;
        if (respectAuthored && this.authored[idx]) continue;
        if (onlyZoned && this.cells[idx] === ZONE.NONE) continue;
        this.cells[idx] = zone;
        this.authored[idx] = (authored === null ? (this.authoring ? 1 : 0) : (authored ? 1 : 0));
        n++;
      }
    }
    this._touch(i0, j0, i1, j1);
    return n;
  }

  paintRect(x0, z0, x1, z1, zone, opts = {}) {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const az = Math.min(z0, z1), bz = Math.max(z0, z1);
    return this.paintPolygon([[ax, az], [bx, az], [bx, bz], [ax, bz]], zone, opts);
  }

  /** Dispatch on a brush description: polygon array | {circle} | {rect}. */
  paintShape(shape, zone, opts = {}) {
    if (Array.isArray(shape)) return this.paintPolygon(shape, zone, opts);
    if (!shape || typeof shape !== 'object') return 0;
    if (shape.r !== undefined || shape.radius !== undefined) {
      return this.paintCircle(shape.x, shape.z, shape.r ?? shape.radius, zone, opts);
    }
    if (shape.x0 !== undefined) return this.paintRect(shape.x0, shape.z0, shape.x1, shape.z1, zone, opts);
    if (Array.isArray(shape.points)) return this.paintPolygon(shape.points, zone, opts);
    return 0;
  }

  /* ------------------------------------------------------------ queries -- */

  cellsOfZone(zone) {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] === zone) n++;
    const out = new Int32Array(n);
    let k = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] === zone) out[k++] = i;
    return out;
  }

  counts() {
    const c = new Int32Array(16);
    for (let i = 0; i < this.cells.length; i++) c[this.cells[i]]++;
    return c;
  }
}

export default ZoneGrid;
