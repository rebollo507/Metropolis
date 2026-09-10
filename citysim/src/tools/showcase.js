import { ZONE } from '../core/World.js';
import { corridorHalf } from './Rules.js';

/**
 * Staged mid-interaction states.
 *
 * A still cannot show an interaction, so each variant *performs* one and stops
 * halfway: the road showcase really is a drag in progress with a live verdict,
 * the zone showcase really has half a district painted with the brush over the
 * next dab, the bulldoze showcase really is hovering a building, and the
 * terrain showcase really has moved earth. Nothing here is drawn for the
 * camera — it is the same code path a player's pointer drives.
 */

const REVEAL = ['environment', 'terrain', 'roads', 'zoning', 'buildings',
  'props', 'traffic', 'simulation', 'effects', 'demo'];

function get(ctx, n) { try { return ctx.get(n); } catch { return null; } }

/** Compose a city to build on. Falls back to a bare grid if `demo` is absent. */
function ensureCity(ctx, log) {
  const demo = get(ctx, 'demo');
  if (demo && demo.build) {
    try {
      demo.build({ coreRadius: 300, limit: 460, urbanBias: 0.06 });
      const plan = demo.plan ? demo.plan() : null;
      if (plan && plan.core) return { core: [plan.core[0], plan.core[1]], full: true };
    } catch (err) { log.warn('demo city unavailable:', err.message); }
  }
  const roads = get(ctx, 'roads');
  if (roads && roads.generateGrid && ctx.world.roads.segments.size === 0) {
    roads.generateGrid({ cols: 7, rows: 7, blockW: 92, blockH: 74, organic: true, alleys: true });
    const z = get(ctx, 'zoning');
    try { z && z.autoZone && z.autoZone(); } catch { /* optional */ }
    const b = get(ctx, 'buildings');
    try { b && b.generateForNetwork && b.generateForNetwork({ centre: [0, 0], radius: 240, limit: 260, urbanBias: 0.08 }); }
    catch { /* optional */ }
  }
  return { core: [0, 0], full: false };
}

/** Centre of gravity of the network, used when `demo` gave us no plan. */
function networkCentre(ctx) {
  const nodes = ctx.world.roads.nodes;
  let sx = 0, sz = 0, n = 0;
  for (const nd of nodes.values()) { sx += nd.pos[0]; sz += nd.pos[2]; n++; }
  return n ? [sx / n, sz / n] : [0, 0];
}

function nearestNode(ctx, x, z) {
  let best = null, bd = Infinity;
  for (const n of ctx.world.roads.nodes.values()) {
    const d = (n.pos[0] - x) ** 2 + (n.pos[2] - z) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

/** A heading perpendicular to the streets meeting `node`, pointing away from `core`. */
function crossHeading(ctx, node, core) {
  const roads = get(ctx, 'roads');
  let h = 0;
  if (roads && node.edges && node.edges.length) {
    const seg = ctx.world.roads.segments.get(node.edges[0]);
    if (seg) {
      const t = roads.tangentAt(seg.id, seg.a === node.id ? 0.05 : 0.95);
      h = Math.atan2(t.z, t.x) + Math.PI / 2;
    }
  }
  const away = Math.atan2(node.pos[2] - core[1], node.pos[0] - core[0]);
  if (Math.cos(h - away) < 0) h += Math.PI;
  return h;
}

function setCursor(S, x, z, anchor, cls) {
  const y = S.picker.heightAt(x, z);
  S.picker.hover.x = x; S.picker.hover.y = y; S.picker.hover.z = z; S.picker.hover.valid = true;
  S.picker.pointer.inside = true;
  return S.picker.snap(x, z, { anchor, class: cls || 'lane2' });
}

function showGround(S) {
  S.gridFade = 1;
  if (!S.vis) return;
  S.vis.ground.setGrid(0.95, S.category === 'zone' ? 8 : 4);
  S.vis.ground.mesh.visible = true;
}

/* ------------------------------------------------------------ variants -- */

export function stageShowcase(ctx, S, variant, H) {
  const log = ctx.log;
  const site = ensureCity(ctx, log);
  const core = site.full ? site.core : networkCentre(ctx);

  if (variant === 'zone') return stageZone(ctx, S, H, core);
  if (variant === 'closeup') return stageRoad(ctx, S, H, core, true);
  if (variant === 'bulldoze') return stageBulldoze(ctx, S, H, core);
  if (variant === 'terrain') return stageTerrain(ctx, S, H, core);
  return stageRoad(ctx, S, H, core);
}

/* -------- default: a road mid-drag, with snaps, junctions and a verdict -- */

function stageRoad(ctx, S, H, core, close = false) {
  lightDock(ctx, 'road', 'avenue');
  H.applySelection({ tool: 'road:avenue', category: 'road', id: 'avenue', label: 'Avenue', roadClass: 'lane4' });
  S.roadMode = 'straight';
  S.showcasing = true;

  const best = findRoute(ctx, S, H, core, 'lane4');
  if (!best) { ctx.log.warn('no buildable route found to demonstrate'); return { reveal: REVEAL }; }

  // start the drag exactly where a player's pointer-down would put it
  setCursor(S, best.a[0], best.a[1], null, 'lane4');
  const p0 = { x: S.picker.snapped.x, y: S.picker.snapped.y, z: S.picker.snapped.z };
  S.drag = { kind: 'road', points: [p0], stage: 0, t0: 0 };
  setCursor(S, best.b[0], best.b[1], [p0.x, p0.z], 'lane4');

  const s = S.picker.snapped;
  const spec = { action: 'road.build', class: 'lane4', mode: 'straight', nodes: [[p0.x, p0.z], [s.x, s.z]] };
  const v = H.evaluate(spec);
  S.preview = v;
  showGround(S);
  H.paintPreview(v, spec);
  ctx.log.info(`showcase:default — ${v.level} · ${v.reason} · $${Math.round(v.cost)} · `
    + `${v.crossings} junction(s), ${Math.round(v.length)} m, grade ${(v.grade * 100).toFixed(1)}%`);

  const h = Math.atan2(s.z - p0.z, s.x - p0.x);
  // `closeup` sits on the kerb a third of the way along, where the ghost's
  // section — deck, kerb line, verge, centre dashes — is actually judgeable
  const k = close ? 0.34 : 0.5;
  const mx = p0.x + (s.x - p0.x) * k, mz = p0.z + (s.z - p0.z) * k;
  const my = S.picker.heightAt(mx, mz);
  return {
    target: [mx, my + (close ? 1.6 : 10), mz],
    dist: close ? 44 : Math.max(190, v.length * 1.22),
    az: Math.atan2(Math.cos(h), Math.sin(h)) + (close ? 0.62 : 1.02),
    pol: close ? 1.30 : 0.92,
    fov: close ? 40 : 44,
    reveal: REVEAL,
  };
}

/**
 * Look for a route a player would actually be pleased with: legal, long
 * enough to read, and crossing at least one existing street so the automatic
 * junction markers are in shot. Every candidate is scored by the *real*
 * verdict, so nothing here is staged for the camera.
 */
function findRoute(ctx, S, H, core, cls) {
  const terrain = get(ctx, 'terrain');
  const nodes = [...ctx.world.roads.nodes.values()]
    .filter((n) => n.edges && n.edges.length && n.edges.length <= 3)
    .map((n) => ({ n, d: Math.hypot(n.pos[0] - core[0], n.pos[2] - core[1]) }))
    // the fringe, not the core: a demo road buried in a canyon of towers shows
    // nothing, and the edge of town is where a player actually extends a network
    .filter((e) => e.d > 150 && e.d < 520)
    .sort((a, b) => b.d - a.d);
  const pick = [];
  const stride = Math.max(1, Math.floor(nodes.length / 22));
  for (let i = 0; i < nodes.length && pick.length < 22; i += stride) pick.push(nodes[i]);

  const blds = [...ctx.world.buildings.values()].filter((b) => b.pos);

  /* Cheap pre-filter first: the full verdict walks every station against every
   * building, which is far too slow to run on hundreds of candidates. */
  const rough = [];
  for (const { n } of pick) {
    const base = crossHeading(ctx, n, core);
    for (const dh of [0, Math.PI, 0.45, -0.45, 0.95, -0.95]) {
      for (const len of [205, 160, 125]) {
        const h = base + dh;
        const a = [n.pos[0], n.pos[2]];
        const b = [a[0] + Math.cos(h) * len, a[1] + Math.sin(h) * len];
        let bad = false, free = 0, tall = 0, tested = 0, minH = 1e9, maxH = -1e9;
        for (let k = 0; k <= 14 && !bad; k++) {
          const t = k / 14;
          const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
          if (terrain && terrain.isWater && terrain.isWater(x, z)) { bad = true; break; }
          const y = S.picker.heightAt(x, z);
          if (y < minH) minH = y;
          if (y > maxH) maxH = y;
          let clear = true;
          for (const bl of blds) {
            const d = Math.hypot(bl.pos[0] - x, bl.pos[2] - z);
            if (d < 26) { clear = false; if ((bl.height || 0) > tall) tall = bl.height || 0; }
          }
          if (clear) free++;
          tested++;
        }
        if (bad) continue;
        if ((maxH - minH) / len > 0.11) continue;
        rough.push({ a, b, len, free: free / tested, tall });
      }
    }
  }
  rough.sort((p, q) => (q.free - p.free) * 100 + (q.len - p.len) * 0.01 + (p.tall - q.tall) * 0.02);

  let best = null;
  for (const c of rough.slice(0, 14)) {
    const v = H.evaluate({ action: 'road.build', class: cls, mode: 'straight', nodes: [c.a, c.b] });
    if (!v) continue;
    // a legal route always beats a merely-tolerable one: the default shot should
    // show the state the player is aiming for
    const rank = v.level === 'ok' ? 10000 : v.level === 'warn' ? 1 : 0;
    if (rank === 0) continue;
    const score = rank + Math.min(3, v.crossings || 0) * 16 + c.free * 240 - c.tall * 1.6 + v.length * 0.05;
    if (!best || score > best.score) best = { a: c.a, b: c.b, score, v };
  }
  return best;
}

/** Fraction of the route with no building within 34 m, and the tallest nearby. */
function openness(ctx, stations) {
  if (!stations) return { free: 0, tallest: 0 };
  const n = stations.length / 2;
  let free = 0, tallest = 0, tested = 0;
  const step = Math.max(1, Math.floor(n / 16));
  for (let i = 0; i < n; i += step) {
    const x = stations[i * 2], z = stations[i * 2 + 1];
    let clear = true;
    for (const b of ctx.world.buildings.values()) {
      if (!b.pos) continue;
      const d = Math.hypot(b.pos[0] - x, b.pos[2] - z);
      if (d < 34) { clear = false; if ((b.height || 0) > tallest) tallest = b.height || 0; }
    }
    if (clear) free++;
    tested++;
  }
  return { free: tested ? free / tested : 0, tallest };
}

/** Light the matching button in the HUD so the shot shows the whole loop. */
function lightDock(ctx, cat, sub) {
  const ui = get(ctx, 'ui');
  try { ui && ui.pick && ui.pick(cat, sub); } catch { /* optional */ }
}

/* ------------------------------- zone: a district half painted, brush live */

function stageZone(ctx, S, H, core) {
  lightDock(ctx, 'zone', 'res_high');
  H.applySelection({ tool: 'zone:res_high', category: 'zone', id: 'res_high', label: 'Apartments', zone: ZONE.RES_HIGH });
  S.zoneMode = 'brush';
  S.showcasing = true;
  H.setBrush(24);

  const zoning = get(ctx, 'zoning');
  try { zoning && zoning.setOverlay && zoning.setOverlay(true); } catch { /* optional */ }

  const f = findFrontage(ctx, S, core);
  if (!f) { ctx.log.warn('no open frontage to zone'); return { reveal: REVEAL }; }

  // a real stroke, committed as a real command, so the district in shot is
  // genuinely painted rather than drawn for the camera
  const dabs = [];
  for (let i = 0; i < 7; i++) {
    const t = -0.34 + i * 0.11;
    dabs.push([
      +(f.x + f.dx * t * f.len).toFixed(2),
      +(f.z + f.dz * t * f.len).toFixed(2),
      24,
    ]);
  }
  const r = H.commitSpec({ action: 'zone.stroke', zone: ZONE.RES_HIGH, dabs });
  ctx.log.info(`showcase:zone — ${r && r.ok ? `${r.label} · $${Math.round(r.cost)}` : (r && r.reason)}`);

  // the cursor sits on the next dab, brush live
  const t2 = -0.34 + 7 * 0.11;
  const nx = f.x + f.dx * t2 * f.len, nz = f.z + f.dz * t2 * f.len;
  setCursor(S, nx, nz, null, 'lane2');
  const sn = S.picker.snapped;
  const spec = { action: 'zone.paint', zone: ZONE.RES_HIGH, shape: { x: sn.x, z: sn.z, r: S.brush.radius } };
  const v = H.evaluate(spec);
  S.preview = v;
  showGround(S);
  H.paintPreview(v, spec);

  const my = S.picker.heightAt(f.x, f.z);
  return {
    target: [(f.x + nx) / 2, my + 2, (f.z + nz) / 2],
    dist: 210, az: Math.atan2(f.dx, f.dz) + 1.05, pol: 0.66, fov: 42,
    reveal: REVEAL,
  };
}

/**
 * Open land against a street at the edge of town — where a player actually
 * zones. Returns the strip's centre, its along-street direction and its length.
 */
function findFrontage(ctx, S, core) {
  const roads = get(ctx, 'roads');
  const terrain = get(ctx, 'terrain');
  if (!roads) return null;
  const blds = [...ctx.world.buildings.values()].filter((b) => b.pos);
  let best = null;
  for (const seg of ctx.world.roads.segments.values()) {
    if ((seg.length || 0) < 60) continue;
    const mid = roads.pointAt(seg.id, 0.5);
    const d = Math.hypot(mid.x - core[0], mid.z - core[1]);
    if (d < 130 || d > 520) continue;
    const tan = roads.tangentAt(seg.id, 0.5);
    const nx = -tan.z, nz = tan.x;
    for (const side of [1, -1]) {
      const cx = mid.x + nx * side * 26, cz = mid.z + nz * side * 26;
      let clear = 0, tested = 0, water = false;
      for (let k = -3; k <= 3; k++) {
        const x = cx + tan.x * k * 26, z = cz + tan.z * k * 26;
        if (terrain && terrain.isWater && terrain.isWater(x, z)) { water = true; break; }
        let free = true;
        for (const b of blds) if (Math.hypot(b.pos[0] - x, b.pos[2] - z) < 26) { free = false; break; }
        if (free) clear++;
        tested++;
      }
      if (water || !tested) continue;
      const score = (clear / tested) * 100 + Math.min(seg.length, 200) * 0.08;
      if (!best || score > best.score) {
        best = { x: cx, z: cz, dx: tan.x, dz: tan.z, len: Math.min(seg.length, 190), score };
      }
    }
  }
  return best;
}

/* ------------------------------------- bulldoze: hover cuff on a building */

function stageBulldoze(ctx, S, H, core) {
  lightDock(ctx, 'bulldoze');
  H.applySelection({ tool: 'bulldoze', category: 'bulldoze', id: 'bulldoze', label: 'Bulldoze' });
  S.showcasing = true;

  // the most photogenic candidate: the tallest thing reasonably near the core
  let best = null, bestScore = -Infinity;
  for (const b of ctx.world.buildings.values()) {
    if (!b.pos) continue;
    const d = Math.hypot(b.pos[0] - core[0], b.pos[2] - core[1]);
    if (d > 320) continue;
    const score = (b.height || 10) - d * 0.05;
    if (score > bestScore) { bestScore = score; best = b; }
  }
  if (!best) { ctx.log.warn('no buildings to demolish'); return { reveal: REVEAL }; }

  setCursor(S, best.pos[0], best.pos[2], null, 'lane2');
  const spec = { action: 'bulldoze', x: best.pos[0], z: best.pos[2] };
  const v = H.evaluate(spec);
  S.preview = v;
  showGround(S);
  H.paintPreview(v, spec);
  ctx.log.info(`showcase:bulldoze — ${v.reason} · $${Math.round(v.cost)}`);

  const hgt = Math.max(10, best.height || 14);
  return {
    target: [best.pos[0], best.pos[1] + hgt * 0.42, best.pos[2]],
    dist: Math.max(58, hgt * 1.9), az: 2.3, pol: 1.16, fov: 42,
    reveal: REVEAL,
  };
}

/* ----------------------------------------- terrain: a brush mid-earthwork */

function stageTerrain(ctx, S, H, core) {
  lightDock(ctx, 'terrain', 'raise');
  H.applySelection({ tool: 'terrain:raise', category: 'terrain', id: 'raise', label: 'Raise' });
  S.showcasing = true;
  H.setBrush(38);
  S.brush.strength = 1.0;

  const site = findOpenGround(ctx, S, core);
  const px = site.x, pz = site.z;

  // a real earthwork: a ridge raised by nine passes of the same brush a player
  // would drag, committed as one undoable command
  const dabs = [];
  for (let i = 0; i < 5; i++) {
    const t = (i - 2) * 20;
    dabs.push([+(px + t).toFixed(2), +(pz + t * 0.35).toFixed(2), 38, 2.1]);
  }
  for (let i = 0; i < 4; i++) {
    const t = (i - 1.5) * 16;
    dabs.push([+(px + t).toFixed(2), +(pz + t * 0.35).toFixed(2), 28, 2.4]);
  }
  const r = H.commitSpec({ action: 'terrain.stroke', op: 'raise', target: S.picker.heightAt(px, pz), dabs });
  ctx.log.info(`showcase:terrain — ${r && r.ok ? `${r.label} · $${Math.round(r.cost)}` : (r && r.reason)}`);

  // cursor on the next pass, at the end of the ridge
  const nx = px + 58, nz = pz + 20;
  setCursor(S, nx, nz, null, 'lane2');
  const sn = S.picker.snapped;
  const spec = {
    action: 'terrain.brush', op: 'raise', x: sn.x, z: sn.z,
    r: S.brush.radius, strength: S.brush.strength,
  };
  const v = H.evaluate(spec);
  S.preview = v;
  showGround(S);
  H.paintPreview(v, spec);

  const my = S.picker.heightAt(px, pz);
  return {
    target: [(px + nx) / 2, my + 4, (pz + nz) / 2],
    dist: 168, az: 1.35, pol: 0.96, fov: 44,
    reveal: REVEAL,
  };
}

/** Somewhere with room to work: no water, no road, no buildings, fairly flat. */
function findOpenGround(ctx, S, core) {
  const terrain = get(ctx, 'terrain');
  const roads = get(ctx, 'roads');
  const blds = [...ctx.world.buildings.values()].filter((b) => b.pos);
  let best = null;
  for (let ring = 0; ring < 4; ring++) {
    const rad = 260 + ring * 70;
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2;
      const x = core[0] + Math.cos(ang) * rad, z = core[1] + Math.sin(ang) * rad;
      if (terrain && terrain.isWater && (terrain.isWater(x, z) || terrain.isWater(x + 60, z + 60))) continue;
      const hit = roads && roads.nearestPoint ? roads.nearestPoint({ x, z }, 160) : null;
      if (hit && hit.dist < 70) continue;
      let nearB = false;
      for (const b of blds) if (Math.hypot(b.pos[0] - x, b.pos[2] - z) < 70) { nearB = true; break; }
      if (nearB) continue;
      // mean slope over the whole working area, not just the centre point: an
      // earthwork on a 20% hillside is invisible against the terrain's own scree
      let slope = 0;
      if (terrain && terrain.slopeAt) {
        for (const [ox, oz] of [[0, 0], [40, 0], [-40, 0], [0, 40], [0, -40]]) slope += terrain.slopeAt(x + ox, z + oz);
        slope /= 5;
      }
      if (slope > 0.13) continue;
      const score = 100 - slope * 400 - rad * 0.02;
      if (!best || score > best.score) best = { x, z, score };
    }
    if (best) break;
  }
  return best || { x: core[0] + 300, z: core[1] + 240 };
}

export { REVEAL, corridorHalf };
