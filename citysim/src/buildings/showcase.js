import * as THREE from 'three';
import { fallbackFrontages } from './Lots.js';

/**
 * Showcase staging.
 *
 * The host hides every other module's group before calling `showcase()`, and
 * `main.js` then reveals only environment + terrain + effects. A street scene
 * with no street reads as a floating diorama, so this stages a real road
 * network through the roads module's own API and un-hides its group; if roads
 * is unavailable it lays down its own asphalt ribbons instead. Everything added
 * here is scaffolding and is torn down again by `clearStage`.
 */

const VARIANTS = {
  default: {
    grid: { cols: 6, rows: 6, blockW: 94, blockH: 76, highway: false, ramp: false, organic: true, alleys: true },
    gen: { centre: [0, 0], radius: 340, urbanBias: -0.04, limit: 560 },
    hero: ['midrise', 'rowhouse', 'retail'],
  },
  tower: {
    grid: { cols: 5, rows: 5, blockW: 108, blockH: 92, highway: false, ramp: false, organic: false, alleys: true },
    gen: { centre: [0, 0], radius: 300, urbanBias: 0.22, limit: 260 },
    hero: ['tower'],
  },
  residential: {
    grid: { cols: 6, rows: 6, blockW: 84, blockH: 68, highway: false, ramp: false, organic: true, alleys: false },
    gen: { centre: [0, 0], radius: 260, urbanBias: -0.62, limit: 520 },
    hero: ['house', 'rowhouse'],
  },
  skyline: {
    grid: { cols: 9, rows: 8, blockW: 104, blockH: 84, highway: true, ramp: true, organic: true, alleys: true },
    gen: { centre: [0, 0], radius: 400, urbanBias: 0.10, limit: 680 },
    hero: ['tower'],
  },
};

/* ------------------------------------------------------------ scaffolding -- */

/** Flat asphalt + kerb ribbons, only used when the roads module is missing. */
function ownStreets(ctx, fronts, S) {
  const pos = [], nrm = [], uv = [];
  const push = (a, b, c, d, u1, v1) => {
    const quad = [a, b, c, a, c, d];
    for (const p of quad) { pos.push(p[0], p[1], p[2]); nrm.push(0, 1, 0); }
    uv.push(0, 0, u1, 0, u1, v1, 0, 0, u1, v1, 0, v1);
  };
  const hAt = (x, z) => {
    const t = ctx.get('terrain');
    return t && t.heightAt ? t.heightAt(x, z) : 0;
  };
  for (const f of fronts) {
    for (let i = 1; i < f.pts.length; i++) {
      const a = f.pts[i - 1], b = f.pts[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l, nz = dx / l;
      const w = f.half + f.walk;
      push(
        [a.x + nx * w, hAt(a.x, a.z) + 0.03, a.z + nz * w],
        [b.x + nx * w, hAt(b.x, b.z) + 0.03, b.z + nz * w],
        [b.x - nx * w, hAt(b.x, b.z) + 0.03, b.z - nz * w],
        [a.x - nx * w, hAt(a.x, a.z) + 0.03, a.z - nz * w],
        l / 8, (w * 2) / 8
      );
    }
  }
  if (!pos.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const mat = ctx.materials.pbr({ color: 0x33363a, roughness: 0.86, metalness: 0 });
  const m = new THREE.Mesh(g, mat);
  m.name = 'buildings:showcase:streets';
  m.receiveShadow = true;
  ctx.group.add(m);
  S.stage.push(m);
}

/** A handful of warm street-level lights so the night shot is judgeable. */
function nightLamps(ctx, S, records) {
  const hours = ctx.world.time.hours;
  if (hours > 6.4 && hours < 18.6) return;
  const cam = ctx.camera.position;
  const near = records
    .map((r) => ({ r, d: (r.x - cam.x) ** 2 + (r.z - cam.z) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 12);
  for (const { r } of near) {
    const n = [-Math.sin(r.rot), -Math.cos(r.rot)];
    const l = new THREE.PointLight(0xffc08a, 40, 40, 2.0);
    l.position.set(r.x + n[0] * (r.spec.D / 2 + 5.5), r.baseY + 6.4, r.z + n[1] * (r.spec.D / 2 + 5.5));
    l.castShadow = false;
    ctx.group.add(l);
    S.stage.push(l);
  }
}

export function clearStage(ctx, S) {
  for (const o of S.stage) {
    if (o.isMesh) o.geometry?.dispose();
    o.removeFromParent?.();
  }
  S.stage.length = 0;
}

/* ---------------------------------------------------------------- staging -- */

export function stageShowcase(ctx, variant, S, generate) {
  const v = VARIANTS[variant] || VARIANTS.default;
  const roads = ctx.get('roads');
  let fronts = null;

  if (roads && typeof roads.generateGrid === 'function') {
    try {
      roads.generateGrid(v.grid);
      // a street scene needs its street: asked for via the showcase return
      // value's `reveal` (integrator pass 2), not by poking another module's group
    } catch (err) {
      ctx.log.warn('roads staging failed:', err.message);
    }
  }
  if (!ctx.world.roads.segments.size) {
    fronts = fallbackFrontages(0, 0, v.grid.cols, v.grid.rows, v.grid.blockW, v.grid.blockH);
    ownStreets(ctx, fronts, S);
  }

  const plan = generate(ctx, {
    ...v.gen,
    frontages: fronts || undefined,
    useZoning: false,
  });

  if (S.chunks) nightLamps(ctx, S, S.chunks.records);
  return plan;
}

/* --------------------------------------------------------------- framing -- */

function pickHero(S, kinds, prefer = 'central') {
  const recs = S.chunks ? S.chunks.records : [];
  if (!recs.length) return null;
  let best = null, bestScore = -Infinity;
  for (const r of recs) {
    const k = kinds.indexOf(r.spec.kind);
    if (k < 0) continue;
    const d = Math.hypot(r.x, r.z);
    const score = prefer === 'tall'
      ? r.spec.height * 3 - d * 0.35
      : -d - k * 40 + r.spec.W * 0.6;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (!best) {
    for (const r of recs) {
      const d = Math.hypot(r.x, r.z);
      if (-d > bestScore) { bestScore = -d; best = r; }
    }
  }
  return best;
}

const REVEAL = ['roads'];

export function framingFor(ctx, variant, S) {
  const v = VARIANTS[variant] || VARIANTS.default;
  const recs = S.chunks ? S.chunks.records : [];
  if (!recs.length) return { reveal: REVEAL };

  if (variant === 'tower') {
    const h = pickHero(S, ['tower'], 'tall') || pickHero(S, ['midrise'], 'tall');
    if (!h) return { reveal: REVEAL };
    const H = h.spec.height;
    // stand outside the cluster looking in, or the neighbours eat the shot
    let cx = 0, cz = 0, n = 0;
    for (const r of recs) if (r.spec.height > 30) { cx += r.x; cz += r.z; n++; }
    if (n) { cx /= n; cz /= n; }
    let dx = h.x - cx, dz = h.z - cz;
    const l = Math.hypot(dx, dz);
    if (l < 12) { dx = -Math.sin(h.rot); dz = -Math.cos(h.rot); }
    else { dx /= l; dz /= l; }
    return {
      target: [h.x, h.baseY + H * 0.30, h.z],
      dist: Math.max(46, Math.min(95, H * 0.60)),
      az: Math.atan2(dx, dz) + 0.30,
      pol: 1.425,
      fov: 38,
      reveal: REVEAL,
    };
  }

  if (variant === 'skyline') {
    // centroid of the tall stuff, seen from outside the cluster
    let sx = 0, sz = 0, sw = 0, top = 0;
    for (const r of recs) {
      const w = Math.pow(Math.max(0, r.spec.height - 18), 1.6);
      sx += r.x * w; sz += r.z * w; sw += w;
      top = Math.max(top, r.baseY + r.spec.height);
    }
    const cx = sw > 0 ? sx / sw : 0, cz = sw > 0 ? sz / sw : 0;
    return {
      target: [cx, Math.max(30, top * 0.42), cz],
      dist: 520,
      az: 2.05,
      pol: 1.315,
      fov: 33,
      reveal: REVEAL,
    };
  }

  // Pick a frontage that actually has something to look at: buildings of the
  // wanted kind facing each other across the street, and no blank flank parked
  // where the camera has to stand.
  const dist0 = variant === 'residential' ? 46 : 56;
  const pol0 = variant === 'residential' ? 1.532 : 1.528;
  const horiz = dist0 * Math.sin(pol0);
  let hero = null, bestScore = -Infinity;
  for (const r of recs) {
    if (!v.hero.includes(r.spec.kind)) continue;
    const nn = [-Math.sin(r.rot), -Math.cos(r.rot)];
    const tt = [-nn[1], nn[0]];
    const so = r.spec.D / 2 + (variant === 'residential' ? 9.0 : 8.0);
    const tx0 = r.x + nn[0] * so + tt[0] * 24;
    const tz0 = r.z + nn[1] * so + tt[1] * 24;
    const camX = tx0 - tt[0] * horiz, camZ = tz0 - tt[1] * horiz;
    let score = -Math.hypot(r.x, r.z) * 0.5 + (r.spec.retail ? 45 : 0);
    let blocked = false;
    let neighbours = 0;
    for (const o of recs) {
      if (o === r) continue;
      const dc = Math.hypot(o.x - camX, o.z - camZ);
      if (dc < Math.max(o.spec.W, o.spec.D) * 0.62 + 5) { blocked = true; break; }
      const dh = Math.hypot(o.x - r.x, o.z - r.z);
      if (dh < 90) {
        neighbours++;
        if (o.spec.kind === 'warehouse' && dh < 55) score -= 60;
      }
    }
    if (blocked) continue;
    score += Math.min(neighbours, 14) * 6;
    if (score > bestScore) { bestScore = score; hero = r; }
  }
  hero = hero || pickHero(S, v.hero) || recs[0];
  const n = [-Math.sin(hero.rot), -Math.cos(hero.rot)];      // outward, toward the street
  const t = [-n[1], n[0]];                                   // along the street
  // Stand in the middle of the carriageway and look along it. The camera
  // position is derived from (target, dist, az) by the rig, so az must stay
  // parallel to the street or the camera walks into the building opposite.
  const standoff = hero.spec.D / 2 + (variant === 'residential' ? 9.0 : 8.0);
  const tx = hero.x + n[0] * standoff + t[0] * 24;
  const tz = hero.z + n[1] * standoff + t[1] * 24;
  const az = Math.atan2(-t[0], -t[1]);
  return {
    target: [tx, hero.baseY + (variant === 'residential' ? 3.0 : 4.0), tz],
    dist: variant === 'residential' ? 46 : 56,
    az,
    pol: variant === 'residential' ? 1.532 : 1.528,
    fov: variant === 'residential' ? 50 : 47,
    reveal: REVEAL,
  };
}

export default { stageShowcase, framingFor, clearStage };
