/**
 * What is under the cursor.
 *
 * The city's geometry is merged per block and instanced, so there is no
 * per-building Object3D to raycast. Picking is therefore done in world space:
 * cast against the terrain heightfield (`terrain.raycastGround`), then ask the
 * data model what stands at that point. That is both cheaper and more accurate
 * than a mesh hit for everything except a façade seen edge-on, and it means the
 * inspector reads the same world model the simulation does.
 */
import * as THREE from 'three';
import { ROAD_CLASS } from '../core/World.js';

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();

function api(ctx, name) { try { return ctx.get(name); } catch { return null; } }

/** Screen (px) → a point on the ground, or null. */
export function groundAt(ctx, px, py, rect) {
  const w = rect.width || 1, hgt = rect.height || 1;
  _ndc.set(((px - rect.left) / w) * 2 - 1, -((py - rect.top) / hgt) * 2 + 1);
  _ray.setFromCamera(_ndc, ctx.camera);
  _origin.copy(_ray.ray.origin);
  _dir.copy(_ray.ray.direction);

  const terrain = api(ctx, 'terrain');
  if (terrain && terrain.raycastGround) {
    const hit = terrain.raycastGround(_origin, _dir, 8000);
    if (hit) return { x: hit.x, y: hit.y, z: hit.z };
  }
  // no terrain module: intersect the y=0 plane
  if (Math.abs(_dir.y) < 1e-5) return null;
  const t = -_origin.y / _dir.y;
  if (t <= 0) return null;
  return { x: _origin.x + _dir.x * t, y: 0, z: _origin.z + _dir.z * t };
}

/** Is (x,z) inside a building's rotated footprint (with a small tolerance)? */
function inFootprint(b, x, z, pad = 1.5) {
  const p = b.pos;
  if (!p) return false;
  const fp = b.footprint || [10, 10];
  const c = Math.cos(-(b.rotation || 0)), s = Math.sin(-(b.rotation || 0));
  const dx = x - p[0], dz = z - p[2];
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) <= fp[0] / 2 + pad && Math.abs(lz) <= fp[1] / 2 + pad;
}

/**
 * Resolve a ground point to a subject.
 * Returns `{ kind:'building'|'road'|'lot'|'ground', … }` — never null.
 */
export function subjectAt(ctx, p) {
  const world = ctx.world;

  /* --- road: inside the carriageway wins, it is what the cursor is over --- */
  const roads = api(ctx, 'roads');
  let near = null;
  if (roads && roads.nearestPoint) {
    try { near = roads.nearestPoint([p.x, 0, p.z]); } catch { near = null; }
  }
  if (near && Number.isFinite(near.dist)) {
    const cls = ROAD_CLASS[near.class] || ROAD_CLASS.lane2;
    if (near.dist <= cls.width / 2 + (cls.sidewalk || 0)) {
      return { kind: 'road', point: p, segmentId: near.segmentId, t: near.t, class: near.class, dist: near.dist };
    }
  }

  /* --- building: footprint test on the data model ------------------------ */
  const bld = api(ctx, 'buildings');
  let best = null, bestD = Infinity;
  if (bld && bld.buildingsNear) {
    let list = [];
    try { list = bld.buildingsNear([p.x, 0, p.z], 42) || []; } catch { list = []; }
    for (const rec of list) {
      const b = world.buildings.get(rec.id) || rec;
      const bp = b.pos || rec.pos;
      if (!bp) continue;
      const rec2 = { ...rec, pos: bp, footprint: b.footprint || rec.footprint, rotation: b.rotation ?? rec.rotation };
      const d = (bp[0] - p.x) ** 2 + (bp[2] - p.z) ** 2;
      if (inFootprint(rec2, p.x, p.z) && d < bestD) { bestD = d; best = b.id !== undefined ? b : rec; }
    }
  }
  if (best) return { kind: 'building', point: p, id: best.id, record: best, near };

  /* --- lot -------------------------------------------------------------- */
  const zon = api(ctx, 'zoning');
  if (zon) {
    let lot = null;
    try { lot = zon.lotAt ? zon.lotAt(p.x, p.z) : null; } catch { lot = null; }
    const zone = (() => { try { return zon.zoneAt ? zon.zoneAt(p.x, p.z) : 0; } catch { return 0; } })();
    if (lot || zone) return { kind: 'lot', point: p, lot, zone, near };
  }

  return { kind: 'ground', point: p, near };
}

/** The tallest building in the city — the showcase's stand-in for a click. */
export function pickLandmark(ctx, centre) {
  const world = ctx.world;
  if (!world.buildings || world.buildings.size === 0) return null;

  // the tallest dozen near the centre …
  const tall = [];
  for (const b of world.buildings.values()) {
    if (!b.pos || !Number.isFinite(b.height)) continue;
    let score = b.height;
    if (centre) score -= Math.hypot(b.pos[0] - centre[0], b.pos[2] - centre[2]) * 0.06;
    tall.push({ b, score });
  }
  if (!tall.length) return null;
  tall.sort((x, y) => y.score - x.score);
  const shortlist = tall.slice(0, 12);

  // … and among those, one the simulation has actually filled, so the inspector
  // shows a live occupancy rather than a true but empty 0-of-N.
  let pop = null;
  try { const sim = api(ctx, 'simulation'); pop = sim && sim.sim ? sim.sim().pop : null; } catch { pop = null; }
  let best = shortlist[0].b;
  if (pop && pop.slotOfId) {
    let bestUse = -1;
    for (const { b } of shortlist) {
      const slot = pop.slotOfId.get(b.id);
      if (slot === undefined) continue;
      const use = (pop.bOcc[slot] || 0) + (pop.bFill[slot] || 0);
      if (use > bestUse) { bestUse = use; if (use > 0) best = b; }
    }
  }
  return { kind: 'building', point: { x: best.pos[0], y: best.pos[1], z: best.pos[2] }, id: best.id, record: best };
}

export default subjectAt;
