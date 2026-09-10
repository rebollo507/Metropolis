import { ZONE, ROAD_CLASS } from '../core/World.js';
import { Picker } from './Pick.js';
import { History } from './History.js';
import { Actions, zoneLabel } from './Actions.js';
import {
  RoadStore, ZoneStore, BuildStore, TerrainStore, envOf,
} from './Store.js';
import {
  LEVEL, LEVEL_COLOR, corridorHalf, halfWidth, classOf, money,
} from './Rules.js';
import { GroundOverlay, GhostRoad, Markers, Highlight, Earthworks } from './Visuals.js';
import { stageShowcase } from './showcase.js';

/**
 * tools — the in-game build tools.
 *
 * The player's whole loop lives here: know what you are about to do, what it
 * costs, and whether it is legal, before you commit. Selection comes from `ui`
 * (`tool:selected`); everything else — picking, snapping, previewing, pricing,
 * validating, committing, undoing — is this module.
 *
 * Three things are worth reading before changing anything:
 *
 *  · Every edit is a **command** with an exact inverse (`History.js`), and the
 *    applied prefix of the stack is a **replayable action log**. The same log
 *    on the same seed must reproduce the same `world.hash()`; that is both the
 *    undo guarantee and the determinism test.
 *  · Nothing writes to another module's slice except through `Store.js`, which
 *    documents each place a public API is missing and what it falls back to.
 *  · The previews are five shader-driven objects in this module's own group
 *    (`Visuals.js`), never a wireframe and never a helper.
 */

const S = {
  ctx: null,
  ready: false,
  env: null,
  picker: null,
  history: null,
  actions: null,
  stores: null,
  vis: null,
  tool: null,          // 'road:street' | 'zone:res_low' | 'bulldoze' | 'terrain:raise' | null
  category: null,
  sel: {},             // { zone?, roadClass?, service? }
  roadMode: 'straight',
  zoneMode: 'brush',
  brush: { radius: 22, strength: 0.55, minR: 6, maxR: 70 },
  drag: null,
  preview: null,
  lastPreviewKey: '',
  hoverTarget: null,
  gridFade: 0,
  offEvents: [],
  bound: [],
  stroke: null,
  journal: [],         // player zone strokes, replayed when zoning re-derives
  reapplying: false,
  showcasing: false,
  counters: { commits: 0, refused: 0, previews: 0, previewMs: 0 },
  lastEarth: 0,
};

/* ------------------------------------------------------------- helpers -- */

function colorFor(level) { return LEVEL_COLOR[level] || LEVEL_COLOR.ok; }

function emitPreview(ctx, p) {
  const payload = p ? {
    tool: S.tool, level: p.level, reason: p.reason, cost: Math.round(p.cost || 0),
    affordable: (ctx.world.stats.budget ?? 0) >= (p.cost || 0),
    budget: Math.round(ctx.world.stats.budget ?? 0),
  } : { tool: S.tool, level: null, reason: '', cost: 0, affordable: true, budget: Math.round(ctx.world.stats.budget ?? 0) };
  try { ctx.events.emit('tools:preview', payload); } catch { /* never break a frame */ }
}

function notify(title, message, level = 'warning') {
  const ui = S.env && S.env.ui;
  if (ui && ui.notify) { try { ui.notify(title, message, level); } catch { /* ignore */ } }
}

/* ------------------------------------------------------- tool selection -- */

function applySelection(payload) {
  const p = payload || {};
  S.tool = p.tool || null;
  S.category = p.category || (p.tool ? String(p.tool).split(':')[0] : null);
  S.sel = { zone: p.zone, roadClass: p.roadClass, service: p.service, id: p.id, label: p.label };
  cancelDrag();
  S.preview = null;
  S.hoverTarget = null;
  if (S.vis) {
    S.vis.ghost.hide();
    S.vis.highlight.hide();
    S.vis.ground.clearShape();
  }
  emitPreview(S.ctx, null);
  return S.tool;
}

function toolActive() { return !!S.category && S.category !== 'service'; }

/* ------------------------------------------------------------- previews -- */

function previewKey() {
  const s = S.picker.snapped;
  const d = S.drag;
  return `${S.tool}|${S.roadMode}|${S.zoneMode}|${S.brush.radius}|` +
    `${s.x.toFixed(1)},${s.z.toFixed(1)},${s.kind}|` +
    (d ? `${d.kind}:${d.points.length}:${d.stage || 0}` : '-') +
    `|${S.ctx.world.roads.version}|${S.ctx.world.zoning.version}`;
}

function currentSpec() {
  const s = S.picker.snapped;
  if (!s) return null;
  if (S.category === 'road') {
    const cls = classOf(S.sel.roadClass || 'lane2');
    const d = S.drag;
    if (!d || d.kind !== 'road') {
      // hovering an existing road with a different class offers an upgrade
      const t = S.actions.targetAt(s.x, s.z);
      if (t && t.kind === 'road' && t.segment.class !== cls)
        return { action: 'road.upgrade', segmentId: t.id, class: cls };
      return null;
    }
    const nodes = d.points.map((p) => [p.x, p.z]);
    if (S.roadMode === 'curve' && d.stage === 1) {
      // start · control(cursor) · end
      return { action: 'road.build', class: cls, mode: 'curve', nodes: [nodes[0], [s.x, s.z], nodes[1]] };
    }
    if (S.roadMode === 'curve' && d.stage === 0) {
      return { action: 'road.build', class: cls, mode: 'straight', nodes: [nodes[0], [s.x, s.z]] };
    }
    if (S.roadMode === 'free') {
      return { action: 'road.build', class: cls, mode: 'free', nodes: nodes.concat([[s.x, s.z]]) };
    }
    return { action: 'road.build', class: cls, mode: 'straight', nodes: [nodes[0], [s.x, s.z]] };
  }
  if (S.category === 'zone') {
    const zone = S.sel.zone ?? ZONE.RES_LOW;
    if (S.zoneMode === 'fill') return { action: 'zone.fill', zone, x: s.x, z: s.z };
    if (S.zoneMode === 'rect' && S.drag && S.drag.kind === 'zone') {
      const a = S.drag.points[0];
      return { action: 'zone.paint', zone, shape: { x0: a.x, z0: a.z, x1: s.x, z1: s.z } };
    }
    return { action: 'zone.paint', zone, shape: { x: s.x, z: s.z, r: S.brush.radius } };
  }
  if (S.category === 'terrain') {
    const op = ({ raise: 'raise', lower: 'lower', level: 'level', water: 'smooth' })[S.sel.id] || 'raise';
    return {
      action: 'terrain.brush', op, x: s.x, z: s.z,
      r: S.brush.radius, strength: S.brush.strength,
      target: op === 'level' ? (S.drag && S.drag.targetY !== undefined ? S.drag.targetY : s.y) : undefined,
    };
  }
  if (S.category === 'bulldoze') return { action: 'bulldoze', x: s.x, z: s.z };
  return null;
}

function evaluate(spec) {
  if (!spec) return null;
  const t0 = performance.now();
  let v = null;
  switch (spec.action) {
    case 'road.build': v = S.actions.previewRoad(spec); break;
    case 'road.upgrade': v = S.actions.previewUpgrade(spec); break;
    case 'road.delete': v = S.actions.previewRoadDelete(spec); break;
    case 'zone.paint': v = S.actions.previewZone(spec); break;
    case 'zone.fill': v = S.actions.previewFill(spec); break;
    case 'terrain.brush': v = S.actions.previewTerrain(spec); break;
    case 'bulldoze': v = S.actions.previewBulldoze(spec); break;
    default: return null;
  }
  if (v) v.spec = spec;
  S.counters.previews++;
  S.counters.previewMs += performance.now() - t0;
  return v;
}

function refreshPreview(force = false) {
  if (!S.ready || !toolActive()) {
    if (S.preview) { S.preview = null; emitPreview(S.ctx, null); }
    return;
  }
  const key = previewKey();
  if (!force && key === S.lastPreviewKey) return;
  S.lastPreviewKey = key;
  const spec = currentSpec();
  const v = evaluate(spec);
  S.preview = v;
  emitPreview(S.ctx, v);
  paintPreview(v, spec);
}

/* -------------------------------------------------------------- visuals -- */

function paintPreview(v, spec) {
  const vis = S.vis;
  const s = S.picker.snapped;
  if (!vis) return;
  const col = v ? colorFor(v.level) : LEVEL_COLOR.ok;
  const bad = v && v.level === LEVEL.BAD;

  vis.ground.place(s.x, s.z);
  vis.ground.setBad(bad ? 1 : 0);
  vis.markers.begin();

  if (!spec) {
    vis.ground.clearShape();
    vis.ghost.hide();
    vis.highlight.hide();
    vis.markers.add(s.x, s.y, s.z, 2.2, 0x9fd8ff, 0);
    vis.markers.end();
    return;
  }

  if (spec.action === 'road.build') {
    const cls = spec.class;
    if (v && v.stations && v.stations.length >= 4) {
      vis.ghost.build(v.stations, v.profile ? v.profile.ys : null, cls, col, bad);
      const st = v.stations;
      vis.ground.capsule(st[0], st[1], st[st.length - 2], st[st.length - 1], corridorHalf(cls) + 2, col, 0.30);
      for (const c of (v.cross || [])) vis.markers.add(c.x, S.picker.heightAt(c.x, c.z), c.z, 3.4, 0xffe9a8, c.u * 6);
    } else {
      vis.ghost.hide();
      vis.ground.circle(s.x, s.z, halfWidth(cls), col, 0.7);
    }
    vis.highlight.hide();
  } else if (spec.action === 'road.upgrade') {
    vis.ghost.hide();
    vis.ground.clearShape();
    highlightSegment(spec.segmentId, col);
  } else if (spec.action === 'zone.paint') {
    vis.ghost.hide();
    vis.highlight.hide();
    const zc = zoneHex(spec.zone);
    if (spec.shape.r !== undefined) vis.ground.circle(spec.shape.x, spec.shape.z, spec.shape.r, bad ? col : zc, 0.95, 2.2);
    else vis.ground.rect(spec.shape.x0, spec.shape.z0, spec.shape.x1, spec.shape.z1, bad ? col : zc, 0.95);
  } else if (spec.action === 'zone.fill') {
    vis.ghost.hide();
    vis.highlight.hide();
    vis.ground.circle(s.x, s.z, 6, bad ? col : zoneHex(spec.zone), 0.9, 1.4);
  } else if (spec.action === 'terrain.brush') {
    vis.ghost.hide();
    vis.highlight.hide();
    vis.ground.circle(spec.x, spec.z, spec.r, bad ? col : 0xf2d9a6, 0.95, spec.r * 0.28);
    vis.markers.add(spec.x, s.y, spec.z, spec.r * 0.34, bad ? col : 0xf6e3bb, 1.4);
  } else if (spec.action === 'bulldoze') {
    vis.ghost.hide();
    const t = v && v.target;
    S.hoverTarget = t || null;
    if (t && t.kind === 'building') {
      vis.highlight.building(t.building, S.picker.heightAt(t.building.pos[0], t.building.pos[2]), LEVEL_COLOR.bad);
      vis.ground.circle(t.building.pos[0], t.building.pos[2],
        Math.max(t.building.footprint[0], t.building.footprint[1]) * 0.62, LEVEL_COLOR.bad, 0.8, 2.0);
    } else if (t && t.kind === 'road') {
      highlightSegment(t.id, LEVEL_COLOR.bad);
      vis.ground.clearShape();
    } else {
      vis.highlight.hide();
      vis.ground.circle(s.x, s.z, 5, LEVEL_COLOR.warn, 0.55, 1.6);
    }
  }

  // snap indicators
  if (s.kind === 'node') vis.markers.add(s.x, s.y, s.z, 4.2, 0x7ef2ff, 0);
  else if (s.kind === 'road') vis.markers.add(s.x, s.y, s.z, 3.4, 0x9fe8ff, 1.1);
  else if (s.kind === 'parallel') vis.markers.add(s.x, s.y, s.z, 3.0, 0xc6b8ff, 2.2);
  else if (s.kind === 'angle') vis.markers.add(s.x, s.y, s.z, 2.8, 0xffe9a8, 3.3);
  else if (S.category === 'road') vis.markers.add(s.x, s.y, s.z, 1.9, 0x9fd8ff, 0);
  if (S.drag && S.drag.points.length) {
    const a = S.drag.points[0];
    vis.markers.add(a.x, a.y, a.z, 3.0, 0x7ef2ff, 4.4);
  }
  vis.markers.end();
}

function highlightSegment(segId, col) {
  const api = S.env.roads;
  const seg = S.ctx.world.roads.segments.get(segId);
  if (!api || !seg) { S.vis.highlight.hide(); return; }
  const N = Math.max(6, Math.min(40, Math.round((seg.length || 20) / 5)));
  const pts = new Float32Array((N + 1) * 2);
  const ys = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const p = api.pointAt(segId, i / N);
    pts[i * 2] = p.x; pts[i * 2 + 1] = p.z; ys[i] = p.y;
  }
  S.vis.highlight.road(pts, ys, seg.class, col);
}

function zoneHex(z) {
  const zoning = S.env.zoning;
  if (zoning && zoning.palette) {
    try {
      const p = zoning.palette();
      for (const [k, v] of Object.entries(p)) {
        if (ZONE[k] === z) return v.hex || 0x9fd8ff;
      }
    } catch { /* fall through */ }
  }
  const FALLBACK = {
    [ZONE.RES_LOW]: 0xb6e34a, [ZONE.RES_HIGH]: 0x2f8f1f, [ZONE.COM_LOW]: 0x3fb4e8,
    [ZONE.COM_HIGH]: 0x1b46b4, [ZONE.OFFICE]: 0x00b7c9, [ZONE.IND]: 0xf5991a,
    [ZONE.PARK]: 0xd8efa4, [ZONE.CIVIC]: 0xcf5ce0, [ZONE.NONE]: 0xb9c2cc,
  };
  return FALLBACK[z] ?? 0x9fd8ff;
}

/* ---------------------------------------------------------------- edits -- */

function commitSpec(spec) {
  if (!spec) return { ok: false, reason: 'nothing to build' };
  let r;
  switch (spec.action) {
    case 'road.build': r = S.actions.buildRoad(spec); break;
    case 'road.upgrade': r = S.actions.buildUpgrade(spec); break;
    case 'road.delete': r = S.actions.buildRoadDelete(spec); break;
    case 'zone.paint': r = S.actions.buildZone(spec); break;
    case 'zone.fill': r = S.actions.buildFill(spec); break;
    case 'zone.stroke': r = buildZoneStroke(spec); break;
    case 'terrain.brush': r = S.actions.buildTerrain(spec); break;
    case 'terrain.stroke': r = buildTerrainStroke(spec); break;
    case 'bulldoze': r = S.actions.buildBulldoze(spec); break;
    default: return { ok: false, reason: `unknown action "${spec.action}"` };
  }
  if (!r || r.error) {
    const reason = r && r.error ? r.error.reason : 'refused';
    S.counters.refused++;
    notify('Cannot build', reason, 'warning');
    try { S.ctx.events.emit('tools:refused', { tool: S.tool, action: spec.action, reason }); } catch { /* ignore */ }
    return { ok: false, reason, cost: r && r.error ? r.error.cost : 0 };
  }
  const cmd = S.history.run(r.cmd);
  if (!cmd) return { ok: false, reason: 'the edit produced no change' };
  S.counters.commits++;
  if (spec.action === 'zone.paint' || spec.action === 'zone.fill' || spec.action === 'zone.stroke') {
    S.journal.push({ spec: { ...spec }, serial: cmd.serial });
    if (S.journal.length > 200) S.journal.shift();
  }
  S.lastPreviewKey = '';
  return {
    ok: true, type: cmd.type, label: cmd.label, cost: cmd.cost,
    budget: S.ctx.world.stats.budget, result: cmd.result,
  };
}

/* --------------------------------------------------- continuous strokes -- */

/**
 * A brush drag is one command, not one per frame: the dabs are applied live so
 * the player sees the paint land, and the *first* value of every cell touched
 * is remembered so a single undo removes the whole stroke.
 */
function beginZoneStroke(zone) {
  const g = S.stores.zones.grid;
  S.stroke = { kind: 'zone', zone, dabs: [], before: new Map(), grid: g };
}

function zoneDab(x, z, r) {
  const st = S.stroke;
  const g = st.grid;
  if (!g) return 0;
  const MASK = new Set([ZONE.ROAD, ZONE.WATER]);
  let n = 0;
  const i0 = Math.max(0, g.ci(x - r)), i1 = Math.min(g.gridW - 1, g.ci(x + r));
  const j0 = Math.max(0, g.cj(z - r)), j1 = Math.min(g.gridH - 1, g.cj(z + r));
  const r2 = r * r;
  for (let j = j0; j <= j1; j++) {
    const dz = g.wz(j) - z;
    for (let i = i0; i <= i1; i++) {
      const dx = g.wx(i) - x;
      if (dx * dx + dz * dz > r2) continue;
      const k = j * g.gridW + i;
      const cur = g.cells[k];
      if (MASK.has(cur)) continue;
      if (!st.before.has(k)) st.before.set(k, cur);
      if (cur !== st.zone) { g.cells[k] = st.zone; n++; }
    }
  }
  if (n) {
    g._touch(i0, j0, i1, j1);
    st.dabs.push([+x.toFixed(2), +z.toFixed(2), +r.toFixed(2)]);
  }
  return n;
}

function endZoneStroke() {
  const st = S.stroke;
  S.stroke = null;
  if (!st || !st.dabs.length) return { ok: false, reason: 'nothing painted' };
  // roll back the live paint, then commit it properly so history owns it
  const g = st.grid;
  for (const [k, v] of st.before) g.cells[k] = v;
  return commitSpec({ action: 'zone.stroke', zone: st.zone, dabs: st.dabs });
}

function buildZoneStroke(spec) {
  const store = S.stores.zones;
  const g = store.grid;
  if (!g) return { error: { reason: 'no zoning grid', cost: 0 } };
  // price it from the cells that would actually change
  const MASK = new Set([ZONE.ROAD, ZONE.WATER]);
  const touched = new Map();
  let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
  for (const [x, z, r] of spec.dabs) {
    const a0 = Math.max(0, g.ci(x - r)), a1 = Math.min(g.gridW - 1, g.ci(x + r));
    const b0 = Math.max(0, g.cj(z - r)), b1 = Math.min(g.gridH - 1, g.cj(z + r));
    const r2 = r * r;
    for (let j = b0; j <= b1; j++) {
      const dz = g.wz(j) - z;
      for (let i = a0; i <= a1; i++) {
        const dx = g.wx(i) - x;
        if (dx * dx + dz * dz > r2) continue;
        const k = j * g.gridW + i;
        if (MASK.has(g.cells[k])) continue;
        if (!touched.has(k)) {
          touched.set(k, g.cells[k]);
          if (i < i0) i0 = i; if (i > i1) i1 = i;
          if (j < j0) j0 = j; if (j > j1) j1 = j;
        }
      }
    }
  }
  let changed = 0;
  for (const [k, v] of touched) if (v !== spec.zone) changed++;
  const v = S.actions.previewZone({ zone: spec.zone, shape: { x: spec.dabs[0][0], z: spec.dabs[0][1], r: spec.dabs[0][2] } });
  const cost = (changed / Math.max(1, v.cells || 1)) * (v.cost || 0) || changed * 30;
  if (!changed) return { error: { reason: 'nothing to zone here', cost: 0 } };
  if ((S.ctx.world.stats.budget ?? 0) < cost)
    return { error: { reason: `insufficient funds — needs ${money(cost)}`, cost } };

  let snap = null;
  const cmd = {
    type: 'zone.stroke',
    label: `${zoneLabel(spec.zone)} · ${changed} cells`,
    cost,
    spec: { ...spec },
    apply() {
      snap = store.snapshot(g.wx(i0), g.wz(j0), g.wx(i1), g.wz(j1));
      for (const k of touched.keys()) g.cells[k] = spec.zone;
      g._touch(i0, j0, i1, j1);
      store._poke(g, snap);
      return true;
    },
    revert() { if (snap) store.restore(snap); },
  };
  return { cmd, preview: { level: LEVEL.OK, reason: cmd.label, cost, cells: changed } };
}

function beginTerrainStroke(op, target) {
  S.stroke = { kind: 'terrain', op, target, dabs: [], before: new Map() };
}

function terrainDab(x, z, r, strength) {
  const st = S.stroke;
  const f = S.stores.terra.field;
  if (!f) return 0;
  const i0 = Math.max(0, Math.floor((x - r + f.half) / f.step));
  const i1 = Math.min(f.n - 1, Math.ceil((x + r + f.half) / f.step));
  const j0 = Math.max(0, Math.floor((z - r + f.half) / f.step));
  const j1 = Math.min(f.n - 1, Math.ceil((z + r + f.half) / f.step));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * f.n + i;
      if (!st.before.has(k)) st.before.set(k, f.h[k]);
    }
  }
  S.actions._stamp({ op: st.op, x, z, r, strength, target: st.target });
  st.dabs.push([+x.toFixed(2), +z.toFixed(2), +r.toFixed(2), +strength.toFixed(3)]);
  return 1;
}

function endTerrainStroke() {
  const st = S.stroke;
  S.stroke = null;
  if (!st || !st.dabs.length) return { ok: false, reason: 'nothing moved' };
  const f = S.stores.terra.field;
  for (const [k, v] of st.before) f.h[k] = v;
  return commitSpec({ action: 'terrain.stroke', op: st.op, target: st.target, dabs: st.dabs });
}

function buildTerrainStroke(spec) {
  const store = S.stores.terra;
  const f = store.field;
  if (!f) return { error: { reason: 'no heightfield', cost: 0 } };
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z, r] of spec.dabs) {
    x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r);
    z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r);
  }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const rr = Math.max(x1 - x0, z1 - z0) / 2;
  const probe = S.actions.previewTerrain({
    op: spec.op, x: cx, z: cz, r: Math.max(4, rr),
    strength: spec.dabs[0][3], target: spec.target,
  });
  const cost = Math.max(probe.cost || 0, spec.dabs.length * 40);
  if ((S.ctx.world.stats.budget ?? 0) < cost)
    return { error: { reason: `insufficient funds — needs ${money(cost)}`, cost } };
  if (probe.level === LEVEL.BAD && probe.reason.includes('sea bed'))
    return { error: probe };

  let snap = null;
  const cmd = {
    type: 'terrain.stroke',
    label: `${spec.op} · ${spec.dabs.length} passes`,
    cost,
    spec: { ...spec },
    apply() {
      snap = store.snapshot(cx, cz, rr + f.step * 2);
      for (const [x, z, r, st] of spec.dabs) {
        S.actions._stamp({ op: spec.op, x, z, r, strength: st, target: spec.target });
      }
      store.markDirty(snap);
      store.publish();
      showEarthworks({ x0, z0, x1, z1 });
      return true;
    },
    revert() {
      if (!snap) return;
      store.restore(snap);
      store.publish();
      S.vis && S.vis.earth.clear();
    },
  };
  return { cmd, preview: probe };
}

function showEarthworks(b) {
  if (!S.vis) return;
  try { S.vis.earth.grow(b); }
  catch (err) { S.ctx.log.warn('earthworks surface failed:', err.message); }
}

/* ----------------------------------------------------------------- drag -- */

function startDrag(kind) {
  const s = S.picker.snapped;
  S.drag = { kind, points: [{ x: s.x, y: s.y, z: s.z }], stage: 0, t0: performance.now() };
  return S.drag;
}

function cancelDrag() {
  if (S.stroke) {
    // restore the live paint and drop it
    if (S.stroke.kind === 'zone') {
      const g = S.stroke.grid;
      for (const [k, v] of S.stroke.before) g.cells[k] = v;
    } else if (S.stroke.kind === 'terrain') {
      const f = S.stores.terra.field;
      if (f) for (const [k, v] of S.stroke.before) f.h[k] = v;
    }
    S.stroke = null;
  }
  S.drag = null;
  S.lastPreviewKey = '';
}

/* ---------------------------------------------------------------- input -- */

function bindInput(ctx) {
  const canvas = ctx.renderer.domElement;
  const rect = () => canvas.getBoundingClientRect();

  const isCanvas = (e) => e.target === canvas;

  const onMove = (e) => {
    S.picker.modifiers.shift = e.shiftKey;
    S.picker.modifiers.alt = e.altKey;
    S.picker.modifiers.ctrl = e.ctrlKey || e.metaKey;
    S.picker.setPointer(e.clientX, e.clientY, rect());
  };

  const onDown = (e) => {
    if (!isCanvas(e) || !toolActive()) return;
    if (e.button !== 0 || e.shiftKey && S.category !== 'road') return;
    // the camera rig also listens on the canvas; take the event first so a
    // build drag never orbits the city as a side effect
    e.stopPropagation();
    e.preventDefault();
    S.picker.setPointer(e.clientX, e.clientY, rect());
    S.picker.update(true);
    snapNow();
    handleDown();
  };

  const onUp = (e) => {
    if (!S.drag && !S.stroke) return;
    if (e.button !== undefined && e.button !== 0) return;
    S.picker.setPointer(e.clientX, e.clientY, rect());
    S.picker.update(true);
    snapNow();
    handleUp();
  };

  const onLeave = () => S.picker.leave();

  const onKey = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) mod_.redo(); else mod_.undo();
      return;
    }
    if (mod && e.code === 'KeyY') { e.preventDefault(); mod_.redo(); return; }
    if (e.code === 'Escape') { cancelDrag(); return; }
    if (!toolActive()) return;
    if (e.code === 'BracketLeft') { setBrush(S.brush.radius - 4); e.preventDefault(); }
    else if (e.code === 'BracketRight') { setBrush(S.brush.radius + 4); e.preventDefault(); }
    else if (e.code === 'KeyM') {
      if (S.category === 'road') S.roadMode = ({ straight: 'curve', curve: 'free', free: 'straight' })[S.roadMode];
      else if (S.category === 'zone') S.zoneMode = ({ brush: 'rect', rect: 'fill', fill: 'brush' })[S.zoneMode];
      cancelDrag();
      S.lastPreviewKey = '';
      e.preventDefault();
    }
  };

  // capture phase on window so these run before CameraRig's canvas listeners
  const add = (target, type, fn, capture) => {
    target.addEventListener(type, fn, capture);
    S.bound.push(() => target.removeEventListener(type, fn, capture));
  };
  add(window, 'pointermove', onMove, true);
  add(window, 'pointerdown', onDown, true);
  add(window, 'pointerup', onUp, true);
  add(canvas, 'pointerleave', onLeave, false);
  add(window, 'keydown', onKey, false);
}

function snapNow() {
  const h = S.picker.hover;
  if (!h.valid) return null;
  const anchor = S.drag && S.drag.points.length ? [S.drag.points[0].x, S.drag.points[0].z] : null;
  return S.picker.snap(h.x, h.z, { anchor, class: S.sel.roadClass || 'lane2' });
}

function handleDown() {
  const s = S.picker.snapped;
  if (!S.picker.hover.valid) return;

  if (S.category === 'road') {
    if (!S.drag) {
      // clicking an existing road with another class selected is an upgrade;
      // it is committed on release only if the pointer did not travel
      startDrag('road');
      if (S.roadMode === 'free') S.drag.free = true;
      return;
    }
    if (S.roadMode === 'curve' && S.drag.stage === 0) {
      S.drag.points.push({ x: s.x, y: s.y, z: s.z });
      S.drag.stage = 1;
      return;
    }
    return;
  }

  if (S.category === 'zone') {
    if (S.zoneMode === 'fill') { commitSpec(currentSpec()); return; }
    if (S.zoneMode === 'rect') { startDrag('zone'); return; }
    startDrag('zone');
    beginZoneStroke(S.sel.zone ?? ZONE.RES_LOW);
    zoneDab(s.x, s.z, S.brush.radius);
    return;
  }

  if (S.category === 'terrain') {
    startDrag('terrain');
    const op = ({ raise: 'raise', lower: 'lower', level: 'level', water: 'smooth' })[S.sel.id] || 'raise';
    S.drag.targetY = s.y;
    beginTerrainStroke(op, s.y);
    terrainDab(s.x, s.z, S.brush.radius, S.brush.strength);
    return;
  }

  if (S.category === 'bulldoze') {
    commitSpec({ action: 'bulldoze', x: s.x, z: s.z });
  }
}

function handleUp() {
  const s = S.picker.snapped;
  const d = S.drag;

  if (S.stroke && S.stroke.kind === 'zone') { endZoneStroke(); S.drag = null; S.lastPreviewKey = ''; return; }
  if (S.stroke && S.stroke.kind === 'terrain') { endTerrainStroke(); S.drag = null; S.lastPreviewKey = ''; return; }

  if (!d) return;

  if (d.kind === 'zone' && S.zoneMode === 'rect') {
    const a = d.points[0];
    S.drag = null;
    commitSpec({ action: 'zone.paint', zone: S.sel.zone ?? ZONE.RES_LOW, shape: { x0: a.x, z0: a.z, x1: s.x, z1: s.z } });
    S.lastPreviewKey = '';
    return;
  }

  if (d.kind === 'road') {
    const a = d.points[0];
    const travelled = Math.hypot(s.x - a.x, s.z - a.z);
    if (S.roadMode === 'free') {
      const nodes = d.points.map((p) => [p.x, p.z]);
      if (travelled > 6) nodes.push([s.x, s.z]);
      S.drag = null;
      if (nodes.length >= 2) commitSpec({ action: 'road.build', class: classOf(S.sel.roadClass), mode: 'free', nodes });
      S.lastPreviewKey = '';
      return;
    }
    if (S.roadMode === 'curve') {
      if (d.stage === 0) return;                 // waiting for the second click
      const nodes = [[a.x, a.z], [s.x, s.z], [d.points[1].x, d.points[1].z]];
      S.drag = null;
      commitSpec({ action: 'road.build', class: classOf(S.sel.roadClass), mode: 'curve', nodes });
      S.lastPreviewKey = '';
      return;
    }
    if (travelled < 4) {
      // a click, not a drag: either start a click-click road or upgrade
      const t = S.actions.targetAt(a.x, a.z);
      const cls = classOf(S.sel.roadClass);
      if (t && t.kind === 'road' && t.segment.class !== cls && performance.now() - d.t0 < 400) {
        S.drag = null;
        commitSpec({ action: 'road.upgrade', segmentId: t.id, class: cls });
        S.lastPreviewKey = '';
      }
      return;                                     // keep the anchor for click-click
    }
    S.drag = null;
    commitSpec({ action: 'road.build', class: classOf(S.sel.roadClass), mode: 'straight', nodes: [[a.x, a.z], [s.x, s.z]] });
    S.lastPreviewKey = '';
  }
}

function setBrush(r) {
  S.brush.radius = Math.max(S.brush.minR, Math.min(S.brush.maxR, r));
  S.lastPreviewKey = '';
  return S.brush.radius;
}

/* ---------------------------------------------------------- zoning guard -- */

/**
 * `zoning` re-derives the entire land-use plan from the road network whenever
 * roads change (`rebuildAll` calls `grid.clearAll()` then `autoZone`), so a
 * player's hand painting is discarded the moment they lay a street. Until
 * R-tools-6 resolves that, the strokes still in the undo stack are replayed
 * after such a rebuild, so hand zoning survives a road edit.
 */
function onZoningChanged(p) {
  if (S.reapplying || !S.ready) return;
  if (!p || p.reason !== 'rebuild') return;
  const live = new Set(S.history.stack.slice(0, S.history.index).map((c) => c.serial));
  const todo = S.journal.filter((j) => live.has(j.serial));
  if (!todo.length) return;
  S.reapplying = true;
  try {
    const g = S.stores.zones.grid;
    if (!g) return;
    const MASK = new Set([ZONE.ROAD, ZONE.WATER]);
    let n = 0;
    for (const j of todo) {
      const sp = j.spec;
      const dabs = sp.dabs || (sp.shape && sp.shape.r !== undefined ? [[sp.shape.x, sp.shape.z, sp.shape.r]] : null);
      if (dabs) {
        for (const [x, z, r] of dabs) {
          const i0 = Math.max(0, g.ci(x - r)), i1 = Math.min(g.gridW - 1, g.ci(x + r));
          const j0 = Math.max(0, g.cj(z - r)), j1 = Math.min(g.gridH - 1, g.cj(z + r));
          const r2 = r * r;
          for (let jj = j0; jj <= j1; jj++) {
            const dz = g.wz(jj) - z;
            for (let ii = i0; ii <= i1; ii++) {
              const dx = g.wx(ii) - x;
              if (dx * dx + dz * dz > r2) continue;
              const k = jj * g.gridW + ii;
              if (MASK.has(g.cells[k])) continue;
              g.cells[k] = sp.zone; n++;
            }
          }
          g._touch(i0, j0, i1, j1);
        }
      } else if (sp.shape && sp.shape.x0 !== undefined) {
        const i0 = Math.max(0, g.ci(Math.min(sp.shape.x0, sp.shape.x1)));
        const i1 = Math.min(g.gridW - 1, g.ci(Math.max(sp.shape.x0, sp.shape.x1)));
        const j0 = Math.max(0, g.cj(Math.min(sp.shape.z0, sp.shape.z1)));
        const j1 = Math.min(g.gridH - 1, g.cj(Math.max(sp.shape.z0, sp.shape.z1)));
        for (let jj = j0; jj <= j1; jj++) {
          for (let ii = i0; ii <= i1; ii++) {
            const k = jj * g.gridW + ii;
            if (MASK.has(g.cells[k])) continue;
            g.cells[k] = sp.zone; n++;
          }
        }
        g._touch(i0, j0, i1, j1);
      }
    }
    if (n) S.ctx.log.info(`re-applied ${todo.length} hand zoning stroke(s) after a plan rebuild (${n} cells)`);
  } catch (err) {
    S.ctx.log.warn('zoning re-apply failed:', err.message);
  } finally {
    S.reapplying = false;
  }
}

/* ------------------------------------------------------------- lifecycle -- */

const mod_ = {
  name: 'tools',
  version: '1.0.0',
  dependsOn: ['terrain', 'roads'],
  provides: ['setTool', 'activeTool', 'undo', 'redo', 'canAfford', 'preview', 'commit', 'history'],

  api: {},

  async init(ctx) {
    S.ctx = ctx;
    S.env = envOf(ctx);
    S.stores = {
      env: S.env,
      roads: new RoadStore(ctx),
      zones: new ZoneStore(ctx),
      builds: new BuildStore(ctx),
      terra: new TerrainStore(ctx),
    };
    S.picker = new Picker(ctx);
    S.history = new History(ctx, { cap: 128 });
    S.actions = new Actions(ctx, S.stores);

    try {
      S.vis = {
        ground: new GroundOverlay(ctx),
        ghost: new GhostRoad(ctx),
        markers: new Markers(ctx),
        highlight: new Highlight(ctx),
        earth: new Earthworks(ctx),
      };
    } catch (err) {
      ctx.log.warn('preview layer unavailable, tools still function headlessly:', err.message);
      S.vis = null;
    }

    S.offEvents.push(ctx.events.on('tool:selected', (p) => applySelection(p), 'tools'));
    S.offEvents.push(ctx.events.on('zoning:changed', (p) => onZoningChanged(p), 'tools'));
    S.offEvents.push(ctx.events.on('roads:changed', () => { S.lastPreviewKey = ''; }, 'tools'));

    if (typeof window !== 'undefined' && ctx.renderer && ctx.renderer.domElement) bindInput(ctx);

    S.ready = true;
    ctx.log.info('ready — 5 preview objects, 0 draw calls until a tool is selected');
  },

  rebuild(ctx) {
    S.env = envOf(ctx);
    S.actions.refreshEnv(S.env);
    S.lastPreviewKey = '';
  },

  update(ctx, dt, elapsed) {
    if (!S.ready) return;
    const vis = S.vis;
    if (vis) {
      vis.ground.update(elapsed);
      vis.ghost.update(elapsed);
      vis.markers.update(elapsed);
      vis.highlight.update(elapsed);
    }
    if (S.showcasing) return;

    const active = toolActive();
    const goal = active ? 1 : 0;
    S.gridFade += (goal - S.gridFade) * Math.min(1, dt * 6);
    if (vis) {
      vis.ground.setGrid(S.gridFade * 0.9, S.category === 'zone' ? 8 : 4);
      vis.ground.mesh.visible = S.gridFade > 0.02;
      if (!active) { vis.ghost.hide(); vis.highlight.hide(); vis.markers.begin(); vis.markers.end(); }
    }
    if (!active) return;

    S.picker.update();
    if (!S.picker.hover.valid) return;
    snapNow();

    // live strokes follow the cursor
    if (S.stroke && S.drag) {
      const s = S.picker.snapped;
      const last = S.drag.points[S.drag.points.length - 1];
      const step = Math.max(2.5, S.brush.radius * 0.35);
      if (Math.hypot(s.x - last.x, s.z - last.z) > step) {
        S.drag.points.push({ x: s.x, y: s.y, z: s.z });
        if (S.stroke.kind === 'zone') zoneDab(s.x, s.z, S.brush.radius);
        else {
          terrainDab(s.x, s.z, S.brush.radius, S.brush.strength * dt * 12);
          const now = performance.now();
          if (now - S.lastEarth > 120) {
            S.lastEarth = now;
            showEarthworks({
              x0: s.x - S.brush.radius, z0: s.z - S.brush.radius,
              x1: s.x + S.brush.radius, z1: s.z + S.brush.radius,
            });
          }
        }
        S.lastPreviewKey = '';
      }
    }
    // freehand roads sample the cursor as it travels
    if (S.drag && S.drag.kind === 'road' && S.roadMode === 'free') {
      const s = S.picker.snapped;
      const last = S.drag.points[S.drag.points.length - 1];
      if (Math.hypot(s.x - last.x, s.z - last.z) > 14) {
        S.drag.points.push({ x: s.x, y: s.y, z: s.z });
        S.lastPreviewKey = '';
      }
    }

    refreshPreview();
  },

  showcase(ctx, variant = 'default') {
    S.ctx = ctx;
    S.showcasing = true;
    try {
      return stageShowcase(ctx, S, variant, {
        applySelection, refreshPreview, paintPreview, evaluate, commitSpec,
        setBrush, showEarthworks, snapNow,
      });
    } catch (err) {
      ctx.log.warn('showcase staging failed:', err.message);
      return null;
    }
  },

  dispose(ctx) {
    for (const off of S.offEvents) { try { off(); } catch { /* ignore */ } }
    S.offEvents.length = 0;
    for (const off of S.bound) { try { off(); } catch { /* ignore */ } }
    S.bound.length = 0;
    ctx.events.offOwner('tools');
    if (S.vis) {
      for (const k of Object.keys(S.vis)) { try { S.vis[k].dispose(); } catch { /* ignore */ } }
      S.vis = null;
    }
    S.ready = false;
    S.history = null;
    S.drag = null;
    S.stroke = null;
  },

  /* ------------------------------------------------------------- API --- */

  /** `setTool('road:street')`, `setTool({tool:'zone:park', zone:7})`, `setTool(null)`. */
  setTool(idOrPayload, opts = {}) {
    if (idOrPayload && typeof idOrPayload === 'object') return applySelection(idOrPayload);
    if (!idOrPayload) return applySelection(null);
    const id = String(idOrPayload);
    const [cat, sub] = id.split(':');
    const payload = { tool: id, category: cat, id: sub || cat, label: sub || cat, ...opts };
    if (cat === 'road' && !payload.roadClass) payload.roadClass = ROAD_CLASS[sub] ? sub : ROAD_MAP[sub] || 'lane2';
    if (cat === 'zone' && payload.zone === undefined) payload.zone = ZONE_MAP[sub] ?? ZONE.RES_LOW;
    return applySelection(payload);
  },

  activeTool() {
    return {
      tool: S.tool, category: S.category, ...S.sel,
      roadMode: S.roadMode, zoneMode: S.zoneMode,
      brush: { ...S.brush },
      dragging: !!S.drag, stroking: !!S.stroke,
    };
  },

  undo() { return S.history ? S.history.undo() : false; },
  redo() { return S.history ? S.history.redo() : false; },

  /** With a number: can the city pay it. Without: the budget. */
  canAfford(cost) {
    const b = S.ctx ? (S.ctx.world.stats.budget ?? 0) : 0;
    if (cost === undefined) return b;
    return b + 1e-6 >= cost;
  },

  /** `preview()` → the live hover verdict; `preview(spec)` → a hypothetical. */
  preview(spec) {
    if (!S.ready) return null;
    if (spec) return evaluate(spec);
    return S.preview;
  },

  /** `commit()` commits what is under the cursor; `commit(spec)` an explicit action. */
  commit(spec) {
    if (!S.ready) return { ok: false, reason: 'tools not ready' };
    return commitSpec(spec || currentSpec());
  },

  history() {
    if (!S.history) return { depth: 0, undoable: 0, redoable: 0, log: [] };
    return { ...S.history.state(), log: S.history.log() };
  },
};

const ROAD_MAP = { street: 'lane2', avenue: 'lane4', boulevard: 'boulevard', highway: 'highway', alley: 'alley' };
const ZONE_MAP = {
  res_low: ZONE.RES_LOW, res_high: ZONE.RES_HIGH, com_low: ZONE.COM_LOW, com_high: ZONE.COM_HIGH,
  office: ZONE.OFFICE, industrial: ZONE.IND, park: ZONE.PARK, civic: ZONE.CIVIC, dezone: ZONE.NONE,
};

mod_.api = {
  /** Replay a serialised action log. Same seed + same log ⇒ same world hash. */
  replay(log) {
    const out = { applied: 0, refused: 0 };
    for (const spec of log || []) {
      const r = commitSpec(spec);
      if (r && r.ok) out.applied++; else out.refused++;
    }
    return out;
  },
  undoAll() { return S.history ? S.history.undoAll() : 0; },
  clearHistory() { if (S.history) S.history.clear(); S.journal.length = 0; },
  setBrush,
  brush: () => ({ ...S.brush }),
  setRoadMode: (m) => { S.roadMode = m; S.lastPreviewKey = ''; return S.roadMode; },
  setZoneMode: (m) => { S.zoneMode = m; S.lastPreviewKey = ''; return S.zoneMode; },
  setGridSnap: (m) => { S.picker.grid = m; return m; },
  hover: () => ({ ...S.picker.hover }),
  snapped: () => ({ ...S.picker.snapped }),
  targetAt: (x, z) => S.actions.targetAt(x, z),
  /** Point the picker at a world position (used by the showcases and by tests). */
  pointAtWorld(x, z, opts = {}) {
    const y = S.picker.heightAt(x, z);
    S.picker.hover.x = x; S.picker.hover.y = y; S.picker.hover.z = z; S.picker.hover.valid = true;
    S.picker.pointer.inside = true;
    const anchor = opts.anchor || (S.drag && S.drag.points.length ? [S.drag.points[0].x, S.drag.points[0].z] : null);
    S.picker.snap(x, z, { anchor, class: S.sel.roadClass || 'lane2', free: opts.free });
    S.lastPreviewKey = '';
    return { ...S.picker.snapped };
  },
  refresh: () => refreshPreview(true),
  stats: () => ({
    ...S.counters,
    meanPreviewMs: S.counters.previews ? +(S.counters.previewMs / S.counters.previews).toFixed(3) : 0,
    ...(S.stores ? S.stores.roads.stats() : {}),
    buildings: S.ctx ? S.ctx.world.buildings.size : 0,
    budget: S.ctx ? S.ctx.world.stats.budget : 0,
    drawCalls: mod_.api.drawCalls(),
  }),
  drawCalls() {
    if (!S.vis) return 0;
    let n = 0;
    for (const k of ['ground', 'ghost', 'markers', 'highlight']) {
      const m = S.vis[k] && S.vis[k].mesh;
      if (m && m.visible && (!m.isInstancedMesh || m.count > 0)) n++;
    }
    if (S.vis.earth && S.vis.earth.mesh && S.vis.earth.mesh.visible) n++;
    return n;
  },
  /** For the showcases: force the preview layer without a real pointer. */
  stage: (spec) => {
    const v = evaluate(spec);
    S.preview = v;
    paintPreview(v, spec);
    return v;
  },
};

export default mod_;
export { S as _state };
