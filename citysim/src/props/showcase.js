import * as THREE from 'three';
import { ZONE } from '../core/World.js';
import { Rng, hashString } from '../core/Rng.js';
import { plantLineup, carLineup } from './Lineup.js';

/**
 * Showcase staging. `props` is a dressing module — on its own it is a handful of
 * objects floating in space — so every variant except `trees` stages a real
 * street through the public APIs of `roads`, `zoning` and `buildings` and then
 * asks the host to reveal those groups (CORE_REQUESTS pass-2: `reveal:` on the
 * showcase return value; no module pokes at another module's Object3D).
 */

const GRID = {
  cols: 6, rows: 6, blockW: 90, blockH: 74,
  highway: false, ramp: false, organic: true, alleys: true,
};

function stageCity(ctx, S, { urbanBias = -0.30, limit = 420, radius = 300 } = {}) {
  const roads = ctx.get('roads');
  const zoning = ctx.get('zoning');
  const buildings = ctx.get('buildings');
  if (roads && typeof roads.generateGrid === 'function') {
    try { roads.generateGrid(GRID); } catch (e) { ctx.log.warn('roads staging failed:', e.message); }
  }
  if (zoning && typeof zoning.autoZone === 'function') {
    try { zoning.autoZone(); } catch (e) { ctx.log.warn('zoning staging failed:', e.message); }
  }
  if (buildings && typeof buildings.generateForNetwork === 'function') {
    try {
      buildings.generateForNetwork({ centre: [0, 0], radius, urbanBias, limit, useZoning: true });
    } catch (e) { ctx.log.warn('buildings staging failed:', e.message); }
  }
  void S;
}

/** Pick the street segment nearest the origin that has buildings facing it. */
function heroStreet(ctx) {
  const roads = ctx.get('roads');
  if (!roads || !ctx.world.roads.segments.size) return null;
  let best = null, bestScore = -Infinity;
  for (const s of ctx.world.roads.segments.values()) {
    if (s.class === 'highway' || s.class === 'alley') continue;
    if (s.length < 45) continue;
    const p = roads.pointAt(s.id, 0.5);
    let near = 0;
    for (const b of ctx.world.buildings.values()) {
      const bp = b.pos || [0, 0, 0];
      const d = Math.hypot(bp[0] - p.x, bp[2] - p.z);
      if (d < 42) near++;
      if (near > 14) break;
    }
    const score = near * 6 - Math.hypot(p.x, p.z) * 0.35;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  if (!best) return null;
  const p = roads.pointAt(best.id, 0.45);
  const u = roads.tangentAt(best.id, 0.45);
  return { seg: best, p, u };
}

function eyeLevelFraming(hero, back = 26) {
  if (!hero) return null;
  const { p, u } = hero;
  const tx = p.x + u.x * 12, tz = p.z + u.z * 12;
  return {
    target: [tx, p.y + 1.25, tz],
    dist: back,
    az: Math.atan2(-u.x, -u.z),
    pol: 1.5405,
    fov: 52,
  };
}

/** Warm point lights so the night shot shows real falloff, not just emissives. */
function nightLights(ctx, S, near) {
  const hours = ctx.world.time.hours;
  if (hours > 6.2 && hours < 18.9) return;
  for (const l of near) {
    const light = new THREE.PointLight(0xffb877, 42, 34, 2.0);
    light.position.set(l[0], l[1], l[2]);
    light.castShadow = false;
    ctx.group.add(light);
    S.extras.push(light);
  }
}

export function showcase(ctx, variant, S, api) {
  const seed = ctx.world.seed >>> 0;
  const rng = new Rng(hashString(`props:showcase:${variant}`, seed) >>> 0);

  if (variant === 'cars') {
    const info = carLineup(ctx, S);
    return { target: [info.cx, info.cy + 1.1, info.cz], dist: 15, az: 0.85, pol: 1.30, fov: 42, reveal: [] };
  }

  if (variant === 'trees') {
    const info = plantLineup(ctx, S, api);
    return {
      target: [info.cx - 4, info.cy + 4.6, info.cz + 8],
      dist: 25, az: 0.10, pol: 1.375, fov: 46,
      reveal: [],
    };
  }

  if (variant === 'park') {
    stageCity(ctx, S, { urbanBias: -0.42, limit: 360, radius: 260 });
    // clear a block and zone it as parkland, then dress it
    const zoning = ctx.get('zoning');
    const buildings = ctx.get('buildings');
    const px = 0, pz = 0, pr = 58;
    if (zoning && typeof zoning.paintCircle === 'function') {
      try { zoning.paintCircle(px, pz, pr, ZONE.PARK); } catch { /* optional */ }
    }
    if (buildings && typeof buildings.buildingsNear === 'function') {
      try {
        const ids = buildings.buildingsNear([px, 0, pz], pr - 4).map((b) => b.id);
        if (ids.length) buildings.despawn(ids);
      } catch { /* optional */ }
    }
    api.populate({ density: 1.15 });
    const h = ctx.get('terrain');
    const y = h && h.heightAt ? h.heightAt(px, pz) : 0;
    nightLights(ctx, S, []);
    return {
      target: [px, y + 2.0, pz],
      dist: 104, az: 2.36, pol: 1.20, fov: 44,
      reveal: ['roads', 'buildings'],
    };
  }

  // default / night — a dressed street at eye level
  stageCity(ctx, S, { urbanBias: variant === 'night' ? -0.05 : -0.30, limit: 460 });
  api.populate({ density: variant === 'night' ? 1.15 : 1.0 });
  const hero = heroStreet(ctx);
  const framing = eyeLevelFraming(hero, variant === 'night' ? 30 : 26);

  if (variant === 'night' && hero) {
    const roads = ctx.get('roads');
    const spots = [];
    for (const t of [0.18, 0.34, 0.5, 0.66, 0.82]) {
      const p = roads.pointAt(hero.seg.id, t);
      const tan = roads.tangentAt(hero.seg.id, t);
      for (const side of [1, -1]) {
        spots.push([p.x - tan.z * side * 3.2, p.y + 7.6, p.z + tan.x * side * 3.2]);
      }
    }
    nightLights(ctx, S, spots.slice(0, 10));
  }

  return { ...(framing || {}), reveal: ['roads', 'buildings'] };
}

export default { showcase };
