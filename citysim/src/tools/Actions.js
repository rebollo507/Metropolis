import { ZONE, ROAD_CLASS } from '../core/World.js';
import {
  LEVEL, judgeRoad, judgeZone, judgeBulldoze, judgeTerrain, profileRoad,
  roadDistance, halfWidth, corridorHalf, classOf, verdict,
  segmentDemolitionCost, buildingDemolitionCost, earthCost, crossAngleDeg,
} from './Rules.js';
import {
  straightCurve, quadCurve, cubicCurve, subCurve, arcTable, flatten,
  segCross, pointSeg, clamp,
} from './curve.js';
import { peekId, rewindIds, isWaterAt } from './Store.js';

/**
 * Everything a tool can *do*, expressed as validated, invertible commands.
 *
 * `preview(spec)` answers "what would this cost and is it legal" with no side
 * effects; `build(spec)` returns the command that performs it. Both read the
 * same rule functions, so the ghost the player sees and the edit they get can
 * never disagree.
 */

const STATION_M = 2.5;      // preview flattening resolution

/* ------------------------------------------------------------- geometry -- */

/** Cubic curves for a road spec. `nodes` are [x, z] pairs. */
export function curvesOf(spec) {
  const p = (a) => [a[0], 0, a[1]];
  const n = spec.nodes || [];
  if (n.length < 2) return [];
  if (spec.mode === 'free') {
    const out = [];
    for (let i = 0; i < n.length - 1; i++) out.push(straightCurve(p(n[i]), p(n[i + 1])));
    return out;
  }
  if (spec.mode === 'curve' && n.length >= 3) return [quadCurve(p(n[0]), p(n[1]), p(n[2]))];
  if (spec.mode === 'cubic' && n.length >= 4) return [cubicCurve(p(n[0]), p(n[1]), p(n[2]), p(n[3]))];
  return [straightCurve(p(n[0]), p(n[n.length - 1]))];
}

/** One flat station list for a whole chain of curves. */
export function stationsOf(curves, step = STATION_M) {
  const parts = [];
  let total = 0;
  for (const c of curves) {
    const L = arcTable(c).length;
    const n = Math.max(2, Math.min(400, Math.ceil(L / step)));
    parts.push(flatten(c, n));
    total += n + 1;
  }
  if (parts.length === 1) return parts[0];
  const out = new Float32Array(total * 2);
  let k = 0;
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i];
    const from = i === 0 ? 0 : 2;      // skip the duplicated joint
    for (let j = from; j < a.length; j++) out[k++] = a[j];
  }
  return out.subarray(0, k);
}

/* --------------------------------------------------------------- module -- */

export class Actions {
  constructor(ctx, stores) {
    this.ctx = ctx;
    this.roads = stores.roads;
    this.zones = stores.zones;
    this.builds = stores.builds;
    this.terra = stores.terra;
    this.env = stores.env;
    this._st = null;
  }

  get world() { return this.ctx.world; }

  refreshEnv(env) { this.env = env; }

  /* ================================================================ road == */

  /** Crossings of a proposed centreline with the existing network. */
  _crossings(stations, cls) {
    const api = this.env.roads;
    const out = [];
    if (!api || !api.segmentsNear) return out;
    const n = stations.length / 2;
    const seen = new Set();
    const hit = { t: 0, u: 0 };
    // candidate segments once, from the whole span
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = stations[i * 2], z = stations[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const r = Math.hypot(maxX - minX, maxZ - minZ) / 2 + 40;
    const ids = api.segmentsNear([cx, 0, cz], r);
    const poly = [];
    for (const id of ids) {
      const seg = this.world.roads.segments.get(id);
      if (!seg) continue;
      const N = Math.max(4, Math.min(48, Math.round((seg.length || 20) / 5)));
      const pts = new Float32Array((N + 1) * 2);
      for (let k = 0; k <= N; k++) {
        const q = api.pointAt(id, k / N);
        pts[k * 2] = q.x; pts[k * 2 + 1] = q.z;
      }
      poly.push({ id, pts, N, cls: seg.class });
    }
    for (let i = 0; i < n - 1; i++) {
      const ax = stations[i * 2], az = stations[i * 2 + 1];
      const bx = stations[i * 2 + 2], bz = stations[i * 2 + 3];
      for (const s of poly) {
        for (let k = 0; k < s.N; k++) {
          const c0 = s.pts[k * 2], c1 = s.pts[k * 2 + 1];
          const d0 = s.pts[k * 2 + 2], d1 = s.pts[k * 2 + 3];
          if (!segCross(ax, az, bx, bz, c0, c1, d0, d1, hit)) continue;
          const u = (i + hit.t) / (n - 1);
          const px = ax + (bx - ax) * hit.t, pz = az + (bz - az) * hit.t;
          const key = `${s.id}:${Math.round(px / 4)}:${Math.round(pz / 4)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const myH = Math.atan2(bz - az, bx - ax);
          const otH = Math.atan2(d1 - c1, d0 - c0);
          out.push({ u, x: px, z: pz, segId: s.id, angle: crossAngleDeg(myH, otH), cls: s.cls });
        }
      }
    }
    out.sort((a, b) => a.u - b.u);
    // never make two junctions within a road width of each other
    const keep = [];
    const minGap = Math.max(10, halfWidth(cls) * 2.2);
    for (const c of out) {
      const last = keep[keep.length - 1];
      if (last && Math.hypot(c.x - last.x, c.z - last.z) < minGap) continue;
      keep.push(c);
    }
    return keep;
  }

  /** Does the proposal run along an existing road rather than across it? */
  _overlaps(stations, cls) {
    const api = this.env.roads;
    if (!api || !api.nearestPoint) return false;
    const n = stations.length / 2;
    if (n < 3) return false;
    const half = halfWidth(cls);
    let inside = 0, tested = 0;
    for (let i = 1; i < n - 1; i += Math.max(1, Math.floor(n / 24))) {
      const x = stations[i * 2], z = stations[i * 2 + 1];
      const hit = api.nearestPoint({ x, z }, 60);
      tested++;
      if (!hit) continue;
      const oh = halfWidth(hit.class || 'lane2');
      if (hit.dist < (half + oh) * 0.55) inside++;
    }
    return tested > 0 && inside / tested > 0.55;
  }

  previewRoad(spec) {
    const cls = classOf(spec.class);
    const curves = curvesOf(spec);
    if (!curves.length) return verdict(LEVEL.BAD, 'drag to lay a road', { cost: 0, stations: null });
    const stations = stationsOf(curves);
    const prof = profileRoad(stations, cls, this.env);
    const crossings = this._crossings(stations, cls);
    const overlaps = this._overlaps(stations, cls);
    const hitBuildings = this.builds ? this.builds.alongCorridor(stations, corridorHalf(cls) * 0.86) : [];
    let sharp = 0;
    for (const c of crossings) if (c.angle < 24 && (!sharp || c.angle < sharp)) sharp = c.angle;
    const v = judgeRoad(prof, cls, this.env, {
      crossings: crossings.length, overlaps, hitBuildings, sharpJunction: sharp,
    });
    v.stations = stations;
    v.curves = curves;
    v.profile = prof;
    v.cross = crossings;
    v.class = cls;
    return v;
  }

  buildRoad(spec) {
    const v = this.previewRoad(spec);
    if (v.level === LEVEL.BAD) return { error: v };
    const store = this.roads;
    const cls = v.class;
    const self = this;
    const rec = { segs: [], nodes: [], splits: [], demolished: [], idBefore: 0, idAfter: 0 };

    const cmd = {
      type: 'road.build',
      label: `${ROAD_CLASS[cls].lanes}-lane ${cls}, ${Math.round(v.length)} m`,
      cost: v.cost,
      spec: { ...spec, class: cls },
      apply() {
        rec.segs.length = 0; rec.nodes.length = 0; rec.splits.length = 0; rec.demolished.length = 0;
        rec.idBefore = peekId();
        store.batch(() => {
          if (v.demolish.length) rec.demolished = self.builds.despawn(v.demolish.map((b) => b.id));
          for (const c of v.curves) self._layCurve(c, cls, rec);
        });
        rec.idAfter = peekId();
        return rec.segs.length > 0;
      },
      revert() {
        store.batch(() => {
          for (let i = rec.segs.length - 1; i >= 0; i--) store.removeSegment(rec.segs[i]);
          for (let i = rec.nodes.length - 1; i >= 0; i--) store.removeNode(rec.nodes[i]);
          for (let i = rec.splits.length - 1; i >= 0; i--) store.unsplit(rec.splits[i]);
          if (rec.demolished.length) self.builds.restore(rec.demolished);
        });
        rewindIds(peekId(), rec.idBefore);
      },
      record: rec,
      preview: v,
    };
    return { cmd, preview: v };
  }

  /** Lay one cubic curve, splitting whatever it crosses. */
  _layCurve(curve, cls, rec) {
    const store = this.roads;
    const table = arcTable(curve);
    const n = Math.max(2, Math.min(400, Math.ceil(table.length / STATION_M)));
    const stations = flatten(curve, n);
    const crossings = this._crossings(stations, cls);

    const endpoint = (x, z) => {
      const j = store.junctionAt(x, z, halfWidth(cls) + 2.0, 8);
      if (j) {
        if (j.split) rec.splits.push(j.split);
        return j.id;
      }
      const made = store.nodeAt([x, 0, z], 6);
      if (made.created) rec.nodes.push(made.id);
      return made.id;
    };

    const ax = stations[0], az = stations[1];
    const bx = stations[stations.length - 2], bz = stations[stations.length - 1];
    const startNode = endpoint(ax, az);
    const endNode = endpoint(bx, bz);
    if (startNode == null || endNode == null || startNode === endNode) return;

    // parameters are in flattened-station space; convert to Bezier parameter
    const stops = [];
    for (const c of crossings) {
      if (c.u < 0.04 || c.u > 0.96) continue;
      if (Math.hypot(c.x - ax, c.z - az) < 12 || Math.hypot(c.x - bx, c.z - bz) < 12) continue;
      stops.push(c);
    }

    let prevNode = startNode;
    let prevU = 0;
    for (const c of stops) {
      const j = store.junctionAt(c.x, c.z, halfWidth(cls) + 2.5, 7);
      if (!j) continue;
      if (j.split) rec.splits.push(j.split);
      const sub = subCurve(curve, prevU, c.u);
      if (sub) {
        const id = store.addSegment(prevNode, j.id, cls, sub);
        if (id != null) rec.segs.push(id);
      }
      prevNode = j.id;
      prevU = c.u;
    }
    const tail = subCurve(curve, prevU, 1);
    if (tail) {
      const id = store.addSegment(prevNode, endNode, cls, tail);
      if (id != null) rec.segs.push(id);
    }
  }

  /* ------------------------------------------------------- road: upgrade -- */

  previewUpgrade(spec) {
    const seg = this.world.roads.segments.get(spec.segmentId);
    if (!seg) return verdict(LEVEL.BAD, 'no road here', { cost: 0 });
    const to = classOf(spec.class);
    if (seg.class === to) return verdict(LEVEL.BAD, `already a ${to}`, { cost: 0 });
    const wasW = ROAD_CLASS[seg.class].width, toW = ROAD_CLASS[to].width;
    const up = toW > wasW;
    const cost = up
      ? (ROAD_CLASS[to] ? (seg.length || 0) * (30 + (toW - wasW) * 6) : 0)
      : (seg.length || 0) * 8;
    const v = judgeRoad(
      { length: seg.length || 0, maxGrade: 0, minRadius: Infinity, water: 0, n: 2 },
      to, this.env, {}
    );
    v.cost = cost;
    v.reason = `${up ? 'upgrade' : 'downgrade'} ${seg.class} → ${to} · ${Math.round(seg.length || 0)} m`;
    if ((this.world.stats.budget ?? 0) < cost) {
      v.level = LEVEL.BAD; v.ok = false;
      v.reason = `insufficient funds — needs $${Math.round(cost).toLocaleString('en-US')}`;
    }
    v.segment = seg;
    return v;
  }

  buildUpgrade(spec) {
    const v = this.previewUpgrade(spec);
    if (v.level === LEVEL.BAD) return { error: v };
    const store = this.roads;
    const to = classOf(spec.class);
    let was = null;
    const cmd = {
      type: 'road.upgrade',
      label: `${v.segment.class} → ${to}`,
      cost: v.cost,
      spec: { ...spec, class: to },
      apply() {
        return store.batch(() => { was = store.setClass(spec.segmentId, to); return was !== null; });
      },
      revert() { store.batch(() => { if (was) store.setClass(spec.segmentId, was); }); },
    };
    return { cmd, preview: v };
  }

  /* -------------------------------------------------------- road: delete -- */

  previewRoadDelete(spec) {
    const seg = this.world.roads.segments.get(spec.segmentId);
    if (!seg) return verdict(LEVEL.BAD, 'no road here', { cost: 0 });
    const cost = segmentDemolitionCost(seg);
    const na = this.world.roads.nodes.get(seg.a), nb = this.world.roads.nodes.get(seg.b);
    const junction = (na && na.edges.length > 2) || (nb && nb.edges.length > 2);
    return judgeBulldoze({
      kind: 'road', id: seg.id, cost, junction,
      label: `${seg.class}, ${Math.round(seg.length || 0)} m`,
    }, this.env);
  }

  buildRoadDelete(spec) {
    const v = this.previewRoadDelete(spec);
    if (v.level === LEVEL.BAD) return { error: v };
    const store = this.roads;
    let rec = null;
    const cmd = {
      type: 'road.delete',
      label: `demolish road ${spec.segmentId}`,
      cost: v.cost,
      spec: { ...spec },
      apply() { return store.batch(() => { rec = store.removeSegment(spec.segmentId); return !!rec; }); },
      revert() { store.batch(() => { if (rec) store.restoreSegment(rec); }); },
    };
    return { cmd, preview: v };
  }

  /* ================================================================ zone == */

  previewZone(spec) {
    const zone = spec.zone ?? ZONE.NONE;
    const shape = spec.shape;
    if (!shape) return verdict(LEVEL.BAD, 'no brush', { cost: 0 });
    const c = this.zones.countPaintable(shape, zone);
    const cx = shape.r !== undefined ? shape.x : (shape.x0 + shape.x1) / 2;
    const cz = shape.r !== undefined ? shape.z : (shape.z0 + shape.z1) / 2;
    return judgeZone(zone, c.cells, this.env, {
      blockedByWater: c.blockedByWater,
      roadDist: roadDistance(this.env, cx, cz, 120),
      label: spec.label || zoneLabel(zone),
    });
  }

  buildZone(spec) {
    const v = this.previewZone(spec);
    if (v.level === LEVEL.BAD) return { error: v };
    const store = this.zones;
    const zone = spec.zone ?? ZONE.NONE;
    const shape = spec.shape;
    const b = store.bounds(shape);
    let snap = null;
    const cmd = {
      type: 'zone.paint',
      label: `${zoneLabel(zone)} · ${v.cells} cells`,
      cost: v.cost,
      spec: { ...spec },
      apply() {
        snap = store.snapshot(b[0], b[1], b[2], b[3]);
        const n = store.paint(shape, zone);
        store.popTheirUndo();
        return n > 0;
      },
      revert() { if (snap) store.restore(snap); },
    };
    return { cmd, preview: v };
  }

  /** Flood-fill the block under (x,z): everything reachable without crossing a road. */
  fillCells(x, z, limit = 6000) {
    const g = this.zones.grid;
    if (!g) return null;
    const i0 = g.ci(x), j0 = g.cj(z);
    if (!g.inside(i0, j0)) return null;
    const start = g.cells[j0 * g.gridW + i0];
    if (start === ZONE.ROAD || start === ZONE.WATER) return null;
    const seen = new Set();
    const out = [];
    const stack = [j0 * g.gridW + i0];
    seen.add(stack[0]);
    let bi0 = i0, bi1 = i0, bj0 = j0, bj1 = j0;
    while (stack.length && out.length < limit) {
      const k = stack.pop();
      const j = (k / g.gridW) | 0, i = k - j * g.gridW;
      const v = g.cells[k];
      if (v === ZONE.ROAD || v === ZONE.WATER) continue;
      out.push(k);
      if (i < bi0) bi0 = i; if (i > bi1) bi1 = i;
      if (j < bj0) bj0 = j; if (j > bj1) bj1 = j;
      const push = (ii, jj) => {
        if (!g.inside(ii, jj)) return;
        const kk = jj * g.gridW + ii;
        if (seen.has(kk)) return;
        seen.add(kk);
        stack.push(kk);
      };
      push(i + 1, j); push(i - 1, j); push(i, j + 1); push(i, j - 1);
    }
    return { cells: out, i0: bi0, j0: bj0, i1: bi1, j1: bj1 };
  }

  previewFill(spec) {
    const zone = spec.zone ?? ZONE.NONE;
    const f = this.fillCells(spec.x, spec.z);
    if (!f) return verdict(LEVEL.BAD, 'cannot fill a road or water cell', { cost: 0 });
    const g = this.zones.grid;
    let n = 0;
    for (const k of f.cells) if (g.cells[k] !== zone) n++;
    const v = judgeZone(zone, n, this.env, {
      roadDist: roadDistance(this.env, spec.x, spec.z, 120),
      label: `fill ${zoneLabel(zone)}`,
    });
    v.fill = f;
    return v;
  }

  buildFill(spec) {
    const v = this.previewFill(spec);
    if (v.level === LEVEL.BAD) return { error: v };
    const store = this.zones;
    const zone = spec.zone ?? ZONE.NONE;
    const self = this;
    let snap = null;
    const cmd = {
      type: 'zone.fill',
      label: `fill ${zoneLabel(zone)} · ${v.cells} cells`,
      cost: v.cost,
      spec: { ...spec },
      apply() {
        const f = self.fillCells(spec.x, spec.z);
        if (!f) return false;
        const g = store.grid;
        snap = store.snapshot(g.wx(f.i0), g.wz(f.j0), g.wx(f.i1), g.wz(f.j1));
        for (const k of f.cells) g.cells[k] = zone;
        g._touch(f.i0, f.j0, f.i1, f.j1);
        store._poke(g, snap);
        return true;
      },
      revert() { if (snap) store.restore(snap); },
    };
    return { cmd, preview: v };
  }

  /* ============================================================ bulldoze == */

  /** What is under (x,z)? Buildings win over roads — that is what the eye picks. */
  targetAt(x, z) {
    const b = this.builds ? this.builds.at(x, z, 1.0) : null;
    if (b) {
      return {
        kind: 'building', id: b.id, building: b,
        cost: buildingDemolitionCost(b),
        label: `${b.kind || 'building'}${b.levels ? `, ${b.levels} floors` : ''}`,
      };
    }
    const api = this.env.roads;
    if (api && api.nearestPoint) {
      const hit = api.nearestPoint({ x, z }, 60);
      if (hit) {
        const seg = this.world.roads.segments.get(hit.segmentId);
        if (seg && hit.dist < corridorHalf(seg.class) + 1.0) {
          const na = this.world.roads.nodes.get(seg.a), nb = this.world.roads.nodes.get(seg.b);
          return {
            kind: 'road', id: seg.id, segment: seg, t: hit.t,
            cost: segmentDemolitionCost(seg),
            junction: (na && na.edges.length > 2) || (nb && nb.edges.length > 2),
            label: `${seg.class}, ${Math.round(seg.length || 0)} m`,
          };
        }
      }
    }
    return null;
  }

  previewBulldoze(spec) {
    const t = spec.target || this.targetAt(spec.x, spec.z);
    const v = judgeBulldoze(t, this.env);
    v.target = t;
    return v;
  }

  buildBulldoze(spec) {
    const v = this.previewBulldoze(spec);
    if (v.level === LEVEL.BAD) return { error: v };
    const t = v.target;
    if (t.kind === 'road') return this.buildRoadDelete({ action: 'road.delete', segmentId: t.id });
    const store = this.builds;
    let recs = null;
    const cmd = {
      type: 'bulldoze',
      label: `demolish ${t.label}`,
      cost: v.cost,
      spec: { action: 'bulldoze', x: spec.x, z: spec.z },
      apply() { recs = store.despawn([t.id]); return recs.length > 0; },
      revert() { if (recs) store.restore(recs); },
    };
    return { cmd, preview: v };
  }

  /* ============================================================= terrain == */

  /** Sample what a brush would do, without writing. */
  terrainInfo(spec) {
    const f = this.terra.field;
    if (!f) return { cells: 0, volume: 0, delta: 0, underwater: false, onRoad: false, maxSlope: 0 };
    const { x, z, r } = spec;
    const strength = spec.strength ?? 1;
    const water = this.world.terrain.water ?? 0;
    const i0 = Math.max(0, Math.floor((x - r + f.half) / f.step));
    const i1 = Math.min(f.n - 1, Math.ceil((x + r + f.half) / f.step));
    const j0 = Math.max(0, Math.floor((z - r + f.half) / f.step));
    const j1 = Math.min(f.n - 1, Math.ceil((z + r + f.half) / f.step));
    let cells = 0, volume = 0, peak = 0;
    const cellArea = f.step * f.step;
    const target = spec.target ?? this.world.heightAt(x, z);
    for (let j = j0; j <= j1; j++) {
      const wz = j * f.step - f.half;
      for (let i = i0; i <= i1; i++) {
        const wx = i * f.step - f.half;
        const d = Math.hypot(wx - x, wz - z);
        if (d > r) continue;
        cells++;
        const w = falloff(d / r);
        const h = f.h[j * f.n + i];
        const nh = applyOp(spec.op, h, w, strength, target, f, i, j);
        const dh = nh - h;
        volume += Math.abs(dh) * cellArea;
        if (Math.abs(dh) > Math.abs(peak)) peak = dh;
      }
    }
    const underwater = this.world.heightAt(x, z) < water + 0.05 && spec.op !== 'level';
    const onRoad = roadDistance(this.env, x, z, r + 30) < r + 4;
    return { cells, volume, delta: peak, underwater, onRoad, maxSlope: 0 };
  }

  previewTerrain(spec) {
    const info = this.terrainInfo(spec);
    const v = judgeTerrain(spec.op, info, this.env);
    v.info = info;
    return v;
  }

  buildTerrain(spec) {
    const v = this.previewTerrain(spec);
    if (v.level === LEVEL.BAD) return { error: v };
    const store = this.terra;
    const self = this;
    let snap = null;
    const cmd = {
      type: 'terrain.brush',
      label: `${spec.op} ${Math.round(spec.r)} m`,
      cost: v.cost,
      spec: { ...spec },
      apply() {
        snap = store.snapshot(spec.x, spec.z, spec.r);
        if (!snap) return false;
        self._stamp(spec);
        store.markDirty(snap);
        store.publish();
        return true;
      },
      revert() {
        if (!snap) return;
        store.restore(snap);
        store.publish();
      },
    };
    return { cmd, preview: v };
  }

  _stamp(spec) {
    const f = this.terra.field;
    if (!f) return 0;
    const { x, z, r } = spec;
    const strength = spec.strength ?? 1;
    const target = spec.target ?? this.world.heightAt(x, z);
    const i0 = Math.max(0, Math.floor((x - r + f.half) / f.step));
    const i1 = Math.min(f.n - 1, Math.ceil((x + r + f.half) / f.step));
    const j0 = Math.max(0, Math.floor((z - r + f.half) / f.step));
    const j1 = Math.min(f.n - 1, Math.ceil((z + r + f.half) / f.step));
    // read from a copy so a smoothing pass does not eat its own output
    const src = new Float32Array((i1 - i0 + 1) * (j1 - j0 + 1));
    const w0 = i1 - i0 + 1;
    for (let j = j0; j <= j1; j++) src.set(f.h.subarray(j * f.n + i0, j * f.n + i1 + 1), (j - j0) * w0);
    const read = (i, j) => {
      if (i < i0 || i > i1 || j < j0 || j > j1) return f.h[clamp(j, 0, f.n - 1) * f.n + clamp(i, 0, f.n - 1)];
      return src[(j - j0) * w0 + (i - i0)];
    };
    let n = 0;
    for (let j = j0; j <= j1; j++) {
      const wz = j * f.step - f.half;
      for (let i = i0; i <= i1; i++) {
        const wx = i * f.step - f.half;
        const d = Math.hypot(wx - x, wz - z);
        if (d > r) continue;
        const w = falloff(d / r);
        const h = read(i, j);
        f.h[j * f.n + i] = applyOp(spec.op, h, w, strength, target, { read }, i, j);
        n++;
      }
    }
    return n;
  }
}

/* -------------------------------------------------------------- helpers -- */

/** Smooth, volume-preserving-ish brush falloff. */
function falloff(t) {
  const u = 1 - clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
}

function applyOp(op, h, w, strength, target, f, i, j) {
  if (op === 'raise') return h + strength * w;
  if (op === 'lower') return h - strength * w;
  if (op === 'level') return h + (target - h) * clamp(w * strength, 0, 1);
  if (op === 'smooth') {
    const read = f.read || ((ii, jj) => f.h[jj * f.n + ii]);
    let sum = 0, c = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) { sum += read(i + di, j + dj); c++; }
    }
    const avg = sum / c;
    return h + (avg - h) * clamp(w * strength, 0, 1);
  }
  return h;
}

const ZONE_LABEL = {
  [ZONE.RES_LOW]: 'residential', [ZONE.RES_HIGH]: 'apartments',
  [ZONE.COM_LOW]: 'commercial', [ZONE.COM_HIGH]: 'commercial core',
  [ZONE.OFFICE]: 'office', [ZONE.IND]: 'industry',
  [ZONE.PARK]: 'park', [ZONE.CIVIC]: 'civic', [ZONE.NONE]: 'dezone',
};

export function zoneLabel(z) { return ZONE_LABEL[z] || 'zone'; }
export { isWaterAt, pointSeg };
