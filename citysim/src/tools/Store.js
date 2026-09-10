import { nextId, resetIds, ZONE } from '../core/World.js';
import { corridorHalf } from './Rules.js';

/**
 * Adapters onto the world.
 *
 * Every write the tools perform goes through this file, so exactly one place
 * knows which sibling API is public, which is missing, and what the fallback
 * costs. Two things are worth stating plainly because they are the only places
 * `tools` touches data it does not own:
 *
 *  1. **Undo must restore identifiers, not just shapes.** `World.hash()` folds
 *     segment and building ids in, so "delete a road, undo" is only correct if
 *     the segment comes back as *the same id*. `roads` has no restore API and
 *     `RoadNet.addSegment` always allocates a fresh id, so a destructive undo
 *     re-inserts the original segment *object* (held by reference, so its
 *     non-enumerable `_lut` / `_ys` caches survive intact) into
 *     `world.roads.segments` and re-links the node edge lists. Filed as
 *     R-tools-2.
 *
 *  2. **A hand edit must not trigger one full city rebuild per graph
 *     mutation.** `RoadNet.begin()/end()` exist but are not on `roads.provides`
 *     or `roads.api` (R-demo-1), so a commit uses the same shipped workaround
 *     `demo` uses — set the "somebody else is staging a network" guard for the
 *     duration, then drive the consumers once through the sanctioned
 *     `host.rebuild('roads')`. Filed as R-tools-1.
 */

export function envOf(ctx) {
  const get = (n) => { try { return ctx.get(n); } catch { return null; } };
  return {
    ctx,
    world: ctx.world,
    terrain: get('terrain'),
    roads: get('roads'),
    zoning: get('zoning'),
    buildings: get('buildings'),
    props: get('props'),
    ui: get('ui'),
  };
}

/**
 * Re-insert `key` into a Map at its original position.
 *
 * `World.hash()` iterates `roads.segments` and `buildings` in **insertion
 * order**, and `zoning` enumerates block faces in the same order, so putting a
 * restored segment back on the end of the Map changes the world hash and the
 * land-use plan even though the content is identical. Undo therefore has to
 * restore ordering, not just membership. A few hundred entries, only on undo.
 */
export function insertAt(map, key, value, index) {
  if (index === undefined || index < 0 || index >= map.size) { map.set(key, value); return; }
  const entries = [...map];
  entries.splice(index, 0, [key, value]);
  map.clear();
  for (const [k, v] of entries) map.set(k, v);
}

export function indexOfKey(map, key) {
  let i = 0;
  for (const k of map.keys()) { if (k === key) return i; i++; }
  return -1;
}

/** Read the id counter without consuming a value. */
export function peekId() {
  const n = nextId();
  resetIds(n);
  return n;
}

/** Hand ids back, but only when nothing else has allocated since. */
export function rewindIds(after, before) {
  if (peekId() === after && before < after) { resetIds(before); return true; }
  return false;
}

/* ========================================================== road adapter == */

export class RoadStore {
  constructor(ctx) {
    this.ctx = ctx;
    this.depth = 0;
    this.pendingAdded = [];
    this.pendingRemoved = [];
    this._prevShowcase = null;
  }

  get api() { try { return this.ctx.get('roads'); } catch { return null; } }
  get graph() { return this.ctx.world.roads; }

  /** Coalesce a whole commit into one downstream rebuild. See the header. */
  batch(fn) {
    const ctx = this.ctx;
    if (this.depth++ === 0) {
      this._prevShowcase = ctx.opts ? ctx.opts.showcase : undefined;
      if (ctx.opts) ctx.opts.showcase = this._prevShowcase || 'tools';
      this.pendingAdded.length = 0;
      this.pendingRemoved.length = 0;
    }
    let out = null;
    try {
      out = fn();
    } finally {
      if (--this.depth === 0) {
        if (ctx.opts) ctx.opts.showcase = this._prevShowcase;
        this.flush();
      }
    }
    return out;
  }

  /** Rebuild the carriageway meshes and let the consumers catch up once. */
  flush() {
    const api = this.api;
    try { api?.rebuildMeshes?.(); } catch (err) { this.ctx.log.warn('road mesh rebuild failed:', err.message); }
    const added = this.pendingAdded.slice();
    const removed = this.pendingRemoved.slice();
    this.pendingAdded.length = 0;
    this.pendingRemoved.length = 0;
    if (added.length || removed.length) {
      // Direct-surgery paths (restore / class change) never reach RoadNet's own
      // emitter, so the event is published here. Everything else has already
      // emitted per mutation and this is the coalescing signal.
      this.ctx.events.emit('roads:changed', { version: this.graph.version, added, removed });
    }
    try { this.ctx.engine?.host?.rebuild?.('roads'); }
    catch (err) { this.ctx.log.warn('sibling rebuild failed:', err.message); }
  }

  node(id) { return this.graph.nodes.get(id) || null; }
  segment(id) { return this.graph.segments.get(id) || null; }

  addNode(pos) {
    const api = this.api;
    if (!api?.addNode) return null;
    const id = api.addNode([pos[0], 0, pos[2]], 'junction');
    if (id != null) this.pendingAdded.push(id);
    return id;
  }

  /** Reuse a node within `r`, else make one. */
  nodeAt(pos, r = 7) {
    const api = this.api;
    const found = api?.snapToExisting ? api.snapToExisting([pos[0], 0, pos[2]], r) : null;
    if (found !== null && found !== undefined) return { id: found, created: false };
    const id = this.addNode(pos);
    return { id, created: true };
  }

  addSegment(a, b, cls, curve) {
    const api = this.api;
    if (!api?.addSegment) return null;
    const id = api.addSegment(a, b, cls, curve);
    if (id != null) this.pendingAdded.push(id);
    return id;
  }

  /** Remove a segment, returning everything undo needs (object references). */
  removeSegment(id) {
    const seg = this.segment(id);
    if (!seg) return null;
    const rec = { seg, a: seg.a, b: seg.b, nodes: [], at: indexOfKey(this.graph.segments, id) };
    const api = this.api;
    if (api?.removeSegment) api.removeSegment(id);
    else this.graph.segments.delete(id);
    this.pendingRemoved.push(id);
    // orphaned endpoints go too, and come back on undo
    for (const nid of [rec.a, rec.b]) {
      const n = this.node(nid);
      if (n && n.edges.length === 0) {
        rec.nodes.push(n);
        this.graph.nodes.delete(nid);
        this.graph.version++;
      }
    }
    return rec;
  }

  /** Re-insert exactly what `removeSegment` took out, ids and caches intact. */
  restoreSegment(rec) {
    if (!rec || !rec.seg) return false;
    for (const n of rec.nodes) if (!this.graph.nodes.has(n.id)) this.graph.nodes.set(n.id, n);
    insertAt(this.graph.segments, rec.seg.id, rec.seg, rec.at);
    for (const nid of [rec.seg.a, rec.seg.b]) {
      const n = this.node(nid);
      if (!n) continue;
      if (!n.edges.includes(rec.seg.id)) n.edges.push(rec.seg.id);
      n.degree = n.edges.length;
    }
    this.graph.version++;
    this.pendingAdded.push(rec.seg.id);
    return true;
  }

  removeNode(id) {
    const n = this.node(id);
    if (!n) return null;
    if (n.edges.length) return null;
    this.graph.nodes.delete(id);
    this.graph.version++;
    return n;
  }

  restoreNode(n) {
    if (!n || this.graph.nodes.has(n.id)) return false;
    this.graph.nodes.set(n.id, n);
    this.graph.version++;
    return true;
  }

  /** Upgrade / downgrade in place, so the segment keeps its identity. */
  setClass(id, cls) {
    const seg = this.segment(id);
    if (!seg) return null;
    const was = seg.class;
    if (was === cls) return null;
    seg.class = cls;
    this.graph.version++;
    this.pendingAdded.push(id);
    return was;
  }

  /**
   * A node at (x,z) on the existing network: reuse a nearby node, otherwise
   * split whatever segment passes through. Returns
   * `{ id, split? }` where `split` is the undo record for the split.
   */
  junctionAt(x, z, tol = 2.5, snapR = 9) {
    const api = this.api;
    if (!api) return null;
    const near = api.snapToExisting ? api.snapToExisting([x, 0, z], snapR) : null;
    if (near !== null && near !== undefined) return { id: near, split: null };
    const hit = api.nearestPoint ? api.nearestPoint({ x, z }, 60) : null;
    if (!hit || hit.dist > tol) return null;
    const seg = this.segment(hit.segmentId);
    if (!seg) return null;
    // too close to an end — use that node rather than making a stub
    const L = seg.length || 1;
    if (hit.t * L < snapR) return { id: seg.a, split: null };
    if ((1 - hit.t) * L < snapR) return { id: seg.b, split: null };

    const before = peekId();
    const at = indexOfKey(this.graph.segments, hit.segmentId);
    const r = api.splitSegment ? api.splitSegment(hit.segmentId, hit.t) : null;
    if (!r || r.node == null) return null;
    this.pendingAdded.push(r.node, r.a, r.b);
    this.pendingRemoved.push(hit.segmentId);
    return {
      id: r.node,
      split: { original: seg, at, node: r.node, a: r.a, b: r.b, idBefore: before, idAfter: peekId() },
    };
  }

  /** Undo a `junctionAt` split. */
  unsplit(split) {
    if (!split) return false;
    for (const sid of [split.a, split.b]) if (sid != null) this.removeSegment(sid);
    this.removeNode(split.node);
    this.restoreSegment({ seg: split.original, at: split.at, a: split.original.a, b: split.original.b, nodes: [] });
    rewindIds(split.idAfter, split.idBefore);
    return true;
  }

  stats() {
    return { nodes: this.graph.nodes.size, segments: this.graph.segments.size, version: this.graph.version };
  }
}

/* ========================================================== zone adapter == */

const MASK = new Set([ZONE.ROAD, ZONE.WATER]);

export class ZoneStore {
  constructor(ctx) { this.ctx = ctx; }

  get api() { try { return this.ctx.get('zoning'); } catch { return null; } }
  get grid() { const a = this.api; return a && a.grid ? a.grid() : null; }

  /** Copy the cell rectangle a stroke is about to touch. */
  snapshot(x0, z0, x1, z1) {
    const g = this.grid;
    if (!g) return null;
    let i0 = Math.max(0, g.ci(Math.min(x0, x1))), i1 = Math.min(g.gridW - 1, g.ci(Math.max(x0, x1)));
    let j0 = Math.max(0, g.cj(Math.min(z0, z1))), j1 = Math.min(g.gridH - 1, g.cj(Math.max(z0, z1)));
    if (i1 < i0 || j1 < j0) return null;
    const w = i1 - i0 + 1, h = j1 - j0 + 1;
    const data = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      const src = (j0 + j) * g.gridW + i0;
      data.set(g.cells.subarray(src, src + w), j * w);
    }
    return { i0, j0, w, h, data };
  }

  /** How many cells a stroke would actually change (masks are never painted). */
  countPaintable(shape, zone) {
    const g = this.grid;
    if (!g) return { cells: 0, blockedByWater: false };
    let n = 0, blocked = false;
    this.eachCell(shape, (i, j) => {
      const v = g.cells[j * g.gridW + i];
      if (MASK.has(v)) { blocked = true; return; }
      if (v !== zone) n++;
    });
    return { cells: n, blockedByWater: blocked };
  }

  eachCell(shape, fn) {
    const g = this.grid;
    if (!g) return;
    if (shape.r !== undefined) {
      const { x, z, r } = shape;
      const i0 = Math.max(0, g.ci(x - r)), i1 = Math.min(g.gridW - 1, g.ci(x + r));
      const j0 = Math.max(0, g.cj(z - r)), j1 = Math.min(g.gridH - 1, g.cj(z + r));
      const r2 = r * r;
      for (let j = j0; j <= j1; j++) {
        const dz = g.wz(j) - z;
        for (let i = i0; i <= i1; i++) {
          const dx = g.wx(i) - x;
          if (dx * dx + dz * dz <= r2) fn(i, j);
        }
      }
    } else {
      const x0 = Math.min(shape.x0, shape.x1), x1 = Math.max(shape.x0, shape.x1);
      const z0 = Math.min(shape.z0, shape.z1), z1 = Math.max(shape.z0, shape.z1);
      const i0 = Math.max(0, g.ci(x0)), i1 = Math.min(g.gridW - 1, g.ci(x1));
      const j0 = Math.max(0, g.cj(z0)), j1 = Math.min(g.gridH - 1, g.cj(z1));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(i, j);
    }
  }

  bounds(shape) {
    if (shape.r !== undefined) return [shape.x - shape.r, shape.z - shape.r, shape.x + shape.r, shape.z + shape.r];
    return [shape.x0, shape.z0, shape.x1, shape.z1];
  }

  paint(shape, zone) {
    const a = this.api;
    if (!a) return 0;
    if (shape.r !== undefined) return a.paintCircle(shape.x, shape.z, shape.r, zone) || 0;
    if (a.paintRect) return a.paintRect(shape.x0, shape.z0, shape.x1, shape.z1, zone) || 0;
    return a.paint({ x0: shape.x0, z0: shape.z0, x1: shape.x1, z1: shape.z1 }, zone) || 0;
  }

  paintPolygon(points, zone) {
    const a = this.api;
    if (!a || !a.paint) return 0;
    return a.paint(points, zone) || 0;
  }

  /**
   * Write a snapshot back verbatim and make `zoning` notice.
   *
   * `zoning` has no "these cells changed, refresh yourself" entry point — only
   * `paint*`, which also *writes*. So the restore goes straight into the grid
   * (which `zoning.api.grid()` publishes) and is then followed by a one-cell
   * repaint of a cell with the value it already has: zero net change, but it
   * takes the module's own retag + overlay + `zoning:changed` path. The undo
   * entry that repaint pushes onto zoning's own stack is popped again so the
   * two histories stay in step. Filed as R-tools-3.
   */
  restore(snap) {
    const g = this.grid;
    if (!g || !snap) return false;
    for (let j = 0; j < snap.h; j++) {
      const dst = (snap.j0 + j) * g.gridW + snap.i0;
      g.cells.set(snap.data.subarray(j * snap.w, j * snap.w + snap.w), dst);
    }
    g._touch(snap.i0, snap.j0, snap.i0 + snap.w - 1, snap.j0 + snap.h - 1);
    this._poke(g, snap);
    return true;
  }

  _poke(g, snap) {
    const a = this.api;
    if (!a || !a.paintCircle) return;
    for (let j = 0; j < snap.h; j++) {
      for (let i = 0; i < snap.w; i++) {
        const gi = snap.i0 + i, gj = snap.j0 + j;
        const v = g.cells[gj * g.gridW + gi];
        if (MASK.has(v)) continue;
        const before = g.undoStack.length;
        a.paintCircle(g.wx(gi), g.wz(gj), g.cellSize * 0.4, v);
        if (g.undoStack.length > before) g.undoStack.length = before;
        return;
      }
    }
  }

  /** Drop the entry `zoning` recorded for our own paint, so its stack matches. */
  popTheirUndo() {
    const g = this.grid;
    if (g && g.undoStack.length) g.undoStack.pop();
  }
}

/* ====================================================== building adapter == */

export class BuildStore {
  constructor(ctx) { this.ctx = ctx; }

  get api() { try { return this.ctx.get('buildings'); } catch { return null; } }
  get chunks() { const a = this.api; return a && a.chunks ? a.chunks() : null; }

  /** The building whose footprint contains (x,z), or null. */
  at(x, z, pad = 1.0) {
    const list = this.near(x, z, 70);
    let best = null, bestD = Infinity;
    for (const b of list) {
      const fp = b.footprint || [10, 10];
      const c = Math.cos(-(b.rotation || 0)), s = Math.sin(-(b.rotation || 0));
      const dx = x - b.pos[0], dz = z - b.pos[2];
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      const ex = Math.abs(lx) - fp[0] / 2 - pad;
      const ez = Math.abs(lz) - fp[1] / 2 - pad;
      const d = Math.max(ex, ez);
      if (d <= 0 && d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  near(x, z, r = 60) {
    const a = this.api;
    if (a && a.buildingsNear) {
      try { return a.buildingsNear({ x, z }, r) || []; } catch { /* fall through */ }
    }
    const out = [];
    for (const b of this.ctx.world.buildings.values()) {
      if (!b.pos) continue;
      const dx = b.pos[0] - x, dz = b.pos[2] - z;
      if (dx * dx + dz * dz <= r * r) out.push(b);
    }
    return out;
  }

  /** Remove, capturing the chunk record and world entry so undo is exact. */
  despawn(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    const chunks = this.chunks;
    const recs = [];
    for (const id of list) {
      const entry = this.ctx.world.buildings.get(id);
      let rec = null;
      if (chunks) {
        for (const r of chunks.records) if (r.id === id) { rec = r; break; }
      }
      if (entry || rec) {
        recs.push({
          id, entry: entry ? { ...entry } : null,
          lot: rec ? rec.lot : null, seed: rec ? rec.seed : 0,
          at: indexOfKey(this.ctx.world.buildings, id),
        });
      }
    }
    const a = this.api;
    if (a && a.despawn) a.despawn(list);
    else for (const id of list) this.ctx.world.buildings.delete(id);
    return recs;
  }

  /**
   * Put a demolished building back with its original id.
   *
   * `buildings.spawnOnLot()` always takes a fresh id from the chunk counter, and
   * `World.hash()` folds building ids in, so undo would not restore the hash.
   * `ChunkManager.rebuildCell` only assigns an id when the record has none —
   * so the record is created through the published `buildings.api.chunks()`
   * handle and its id is set before the cell is rebuilt. Filed as R-tools-4.
   */
  restore(recs) {
    const chunks = this.chunks;
    const ids = [];
    // ascending, so each insertion index is still valid as the map refills
    for (const r of [...recs].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
      if (!r.entry) continue;
      if (chunks && r.lot) {
        const rec = chunks.add(r.lot, r.seed >>> 0);
        rec.id = r.id;
        chunks.rebuildCell(chunks.cellFor(r.lot.x, r.lot.z));
      }
      insertAt(this.ctx.world.buildings, r.id, r.entry, r.at);
      ids.push(r.id);
    }
    if (ids.length) this.ctx.events.emit('buildings:spawned', { ids });
    return ids.length;
  }

  /** Buildings whose footprint intersects a corridor polyline. */
  alongCorridor(stations, half) {
    const hit = new Map();
    const n = stations.length / 2;
    for (let i = 0; i < n; i++) {
      const x = stations[i * 2], z = stations[i * 2 + 1];
      for (const b of this.near(x, z, half + 26)) {
        if (hit.has(b.id)) continue;
        const fp = b.footprint || [10, 10];
        const rr = half + Math.hypot(fp[0], fp[1]) * 0.5;
        const dx = b.pos[0] - x, dz = b.pos[2] - z;
        if (dx * dx + dz * dz > rr * rr) continue;
        const c = Math.cos(-(b.rotation || 0)), s = Math.sin(-(b.rotation || 0));
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) < fp[0] / 2 + half && Math.abs(lz) < fp[1] / 2 + half) hit.set(b.id, b);
      }
    }
    return [...hit.values()];
  }
}

/* ======================================================= terrain adapter == */

export class TerrainStore {
  constructor(ctx) {
    this.ctx = ctx;
    this.dirty = null;
  }

  get api() { try { return this.ctx.get('terrain'); } catch { return null; } }
  get field() {
    const t = this.ctx.world.terrain;
    if (!t.heights) return null;
    const n = t.resolution, size = t.size;
    return { h: t.heights, n, size, half: size / 2, step: size / (n - 1) };
  }

  index(x, z) {
    const f = this.field;
    if (!f) return null;
    const i = Math.round((x + f.half) / f.step);
    const j = Math.round((z + f.half) / f.step);
    if (i < 0 || j < 0 || i >= f.n || j >= f.n) return null;
    return j * f.n + i;
  }

  /** Copy the square of samples a brush is about to touch. */
  snapshot(x, z, r) {
    const f = this.field;
    if (!f) return null;
    const i0 = Math.max(0, Math.floor((x - r + f.half) / f.step));
    const i1 = Math.min(f.n - 1, Math.ceil((x + r + f.half) / f.step));
    const j0 = Math.max(0, Math.floor((z - r + f.half) / f.step));
    const j1 = Math.min(f.n - 1, Math.ceil((z + r + f.half) / f.step));
    if (i1 < i0 || j1 < j0) return null;
    const w = i1 - i0 + 1, hgt = j1 - j0 + 1;
    const data = new Float32Array(w * hgt);
    for (let j = 0; j < hgt; j++) {
      const src = (j0 + j) * f.n + i0;
      data.set(f.h.subarray(src, src + w), j * w);
    }
    return { i0, j0, w, h: hgt, data, step: f.step, half: f.half };
  }

  restore(snap) {
    const f = this.field;
    if (!f || !snap) return false;
    for (let j = 0; j < snap.h; j++) {
      const dst = (snap.j0 + j) * f.n + snap.i0;
      f.h.set(snap.data.subarray(j * snap.w, j * snap.w + snap.w), dst);
    }
    this.markDirty(snap);
    return true;
  }

  markDirty(snap) {
    const f = this.field;
    if (!f || !snap) return;
    const x0 = snap.i0 * f.step - f.half, x1 = (snap.i0 + snap.w - 1) * f.step - f.half;
    const z0 = snap.j0 * f.step - f.half, z1 = (snap.j0 + snap.h - 1) * f.step - f.half;
    const d = this.dirty;
    this.dirty = d
      ? { x0: Math.min(d.x0, x0), z0: Math.min(d.z0, z0), x1: Math.max(d.x1, x1), z1: Math.max(d.z1, z1) }
      : { x0, z0, x1, z1 };
  }

  /**
   * Publish the change.
   *
   * `terrain` exposes no write path and no rebuild hook, so its LOD rings keep
   * the geometry they were built with (R-tools-5). What *does* respond is
   * everything that samples `heightAt` — the sampler closes over the live
   * array, so roads re-drape, picking follows the new ground, and the tools'
   * own earthworks surface renders the edited region correctly.
   */
  publish() {
    const t = this.api;
    for (const name of ['applyHeightPatch', 'rebuildRegion', 'flattenAlong', 'setHeights']) {
      if (t && typeof t[name] === 'function' && this.dirty) {
        try { t[name](this.dirty); break; } catch { /* optional */ }
      }
    }
    this.ctx.world.terrain.version = (this.ctx.world.terrain.version || 0) + 1;
    this.ctx.events.emit('terrain:changed', { bounds: this.dirty || null, source: 'tools' });
    const d = this.dirty;
    this.dirty = null;
    return d;
  }
}

export function isWaterAt(env, x, z) {
  if (env.terrain && env.terrain.isWater) return env.terrain.isWater(x, z);
  const w = env.world.terrain;
  return env.world.heightAt(x, z) < (w.water ?? 0) + 0.001;
}

export function corridorHalfOf(cls) { return corridorHalf(cls); }
