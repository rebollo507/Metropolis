import { ROAD_CLASS, ZONE } from '../core/World.js';
import { pointSeg, angDiff } from './curve.js';

/**
 * Price list and legality rules.
 *
 * Every action the player can take is priced here and validated here, and the
 * result is a *three-state* verdict — `ok` / `warn` / `bad` — with a sentence
 * the HUD can print verbatim. That is the whole contract the rest of the module
 * relies on: a tool never decides for itself whether something is legal.
 *
 * Money is in whole currency units; `world.stats.budget` starts at 100 000.
 */

export const LEVEL = { OK: 'ok', WARN: 'warn', BAD: 'bad' };

/** Preview colours. Deliberately not primaries — these are read under AgX. */
export const LEVEL_COLOR = {
  ok: 0x6fe8c4,       // cool mint, reads as "go" without being a traffic light
  warn: 0xffb445,     // amber
  bad: 0xff4d5e,      // rose red
};

export const PRICE = {
  /** currency per metre of carriageway */
  road: { alley: 14, lane2: 30, lane4: 78, boulevard: 145, highway: 230 },
  /** currency per 8 m zoning cell (64 m²) */
  zone: {
    [ZONE.RES_LOW]: 30, [ZONE.RES_HIGH]: 58, [ZONE.COM_LOW]: 44, [ZONE.COM_HIGH]: 82,
    [ZONE.OFFICE]: 70, [ZONE.IND]: 38, [ZONE.PARK]: 96, [ZONE.CIVIC]: 150,
    [ZONE.NONE]: 4,
  },
  /** demolition */
  demolishRoadPerM: 6,
  demolishBuildingBase: 220,
  // per m² of *floor* area. Priced against a $9.7k 124 m avenue and a $100k
  // starting balance: a house is ~$430, a 20-storey tower ~$9k, a landmark ~$25k
  demolishBuildingPerM2: 0.9,
  /** earthworks, per cubic metre moved */
  earthPerM3: 1.35,
};

/* road-class limits ------------------------------------------------------- */

const GRADE = {
  alley: { warn: 0.09, bad: 0.16 },
  lane2: { warn: 0.08, bad: 0.14 },
  lane4: { warn: 0.06, bad: 0.11 },
  boulevard: { warn: 0.055, bad: 0.10 },
  highway: { warn: 0.04, bad: 0.075 },
};

const MIN_RADIUS = { alley: 8, lane2: 14, lane4: 26, boulevard: 34, highway: 90 };

export const MIN_ROAD_LENGTH = 10;

export const money = (v) => '$' + Math.round(v).toLocaleString('en-US');

export function classOf(cls) { return ROAD_CLASS[cls] ? cls : 'lane2'; }
export function halfWidth(cls) {
  const c = ROAD_CLASS[classOf(cls)];
  return c.width / 2;
}
export function corridorHalf(cls) {
  const c = ROAD_CLASS[classOf(cls)];
  return c.width / 2 + (c.sidewalk || 0);
}

export function roadCost(cls, lengthM) {
  return (PRICE.road[classOf(cls)] || PRICE.road.lane2) * Math.max(0, lengthM);
}

export function zoneCost(zone, cells) {
  return (PRICE.zone[zone] ?? 30) * Math.max(0, cells);
}

export function buildingDemolitionCost(b) {
  const fp = b.footprint || [12, 10];
  const area = Math.abs(fp[0] * fp[1]) * Math.max(1, b.levels || 1);
  return PRICE.demolishBuildingBase + PRICE.demolishBuildingPerM2 * Math.min(area, 30000);
}

export function segmentDemolitionCost(seg) {
  return PRICE.demolishRoadPerM * Math.max(0, seg.length || 0);
}

export function earthCost(volumeM3) { return PRICE.earthPerM3 * Math.abs(volumeM3); }

/* ------------------------------------------------------------- verdicts -- */

export function verdict(level, reason, extra = null) {
  const v = { level, reason, ok: level !== LEVEL.BAD };
  if (extra) Object.assign(v, extra);
  return v;
}

/** Pick the worse of two levels. */
export function worse(a, b) {
  const rank = { ok: 0, warn: 1, bad: 2 };
  return rank[b] > rank[a] ? b : a;
}

/**
 * Affordability. Kept separate so `canAfford` in the module API and the
 * preview path can never disagree.
 */
export function affordable(world, cost) {
  return (world?.stats?.budget ?? 0) + 1e-6 >= cost;
}

/* --------------------------------------------------------- road analysis -- */

/**
 * Walk a proposed centreline and report everything the validity state needs.
 * `stations` is a Float32Array of XZ pairs; `env` bundles the sibling APIs.
 *
 * Returns { grade, maxGrade, minRadius, water, ys:Float32Array, length }.
 */
export function profileRoad(stations, cls, env) {
  const n = stations.length / 2;
  const half = halfWidth(cls);
  const ys = new Float32Array(n);
  const raw = new Float32Array(n);
  const terrain = env.terrain;
  const hAt = terrain ? (x, z) => terrain.heightAt(x, z) : () => 0;
  const isWater = terrain && terrain.isWater ? (x, z) => terrain.isWater(x, z) : () => false;

  let water = 0;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const x = stations[i * 2], z = stations[i * 2 + 1];
    if (i > 0) length += Math.hypot(x - stations[i * 2 - 2], z - stations[i * 2 - 1]);
    // highest ground across the full width — the same rule `roads` uses, so the
    // preview and the committed road agree
    let g = hAt(x, z);
    let nx = 0, nz = 0;
    if (n > 1) {
      const j = i === n - 1 ? i - 1 : i;
      const dxs = stations[(j + 1) * 2] - stations[j * 2];
      const dzs = stations[(j + 1) * 2 + 1] - stations[j * 2 + 1];
      const l = Math.hypot(dxs, dzs) || 1;
      nx = -dzs / l; nz = dxs / l;
    }
    for (const k of [-1, -0.55, 0.55, 1]) {
      const px = x + nx * half * k, pz = z + nz * half * k;
      const h = hAt(px, pz);
      if (h > g) g = h;
    }
    raw[i] = g;
    ys[i] = g;
    if (isWater(x, z)) water++;
  }

  /* The same elevation solve `RoadGraph._computeElevation` runs, so the ghost
   * and the committed road agree: smooth hard, blend toward a straight ramp,
   * clamp the running gradient, then lift-and-resmooth until the profile is
   * everywhere on or above the ground (terrain is not carved for roads — R-6).
   * Doing anything cheaper here made rolling ground read as a 140% cliff. */
  const ds0 = Math.max(0.5, length / Math.max(1, n - 1));
  if (n > 2) {
    const ya = raw[0], yb = raw[n - 1];
    const tmp = new Float32Array(n);
    const smooth = (passes) => {
      for (let k = 0; k < passes; k++) {
        tmp[0] = ya; tmp[n - 1] = yb;
        for (let i = 1; i < n - 1; i++) tmp[i] = ys[i - 1] * 0.25 + ys[i] * 0.5 + ys[i + 1] * 0.25;
        ys.set(tmp);
      }
    };
    smooth(Math.min(24, Math.max(3, Math.round(n / 6))));
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      ys[i] = ys[i] + (ya + (yb - ya) * t - ys[i]) * 0.30;
    }
    const maxD = 0.075 * ds0;
    for (let i = 1; i < n; i++) ys[i] = Math.min(Math.max(ys[i], ys[i - 1] - maxD), ys[i - 1] + maxD);
    for (let i = n - 2; i >= 0; i--) ys[i] = Math.min(Math.max(ys[i], ys[i + 1] - maxD), ys[i + 1] + maxD);
    const eA = ya - ys[0], eB = yb - ys[n - 1];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      ys[i] += eA * (1 - t) + eB * t;
    }
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < n; i++) if (ys[i] < raw[i]) ys[i] = raw[i];
      smooth(2);
    }
    for (let i = 0; i < n; i++) if (ys[i] < raw[i]) ys[i] = raw[i];
    ys[0] = ya; ys[n - 1] = yb;
  }

  // running gradient over a ~10 m window: a single lifted sample is a bump the
  // verge absorbs, not a hill the driver climbs
  let maxGrade = 0;
  const ds = Math.max(0.5, length / Math.max(1, n - 1));
  const win = Math.max(1, Math.round(10 / ds));
  for (let i = win; i < n; i++) {
    const g = Math.abs(ys[i] - ys[i - win]) / (ds * win);
    if (g > maxGrade) maxGrade = g;
  }
  if (n > 1 && win >= n) maxGrade = Math.abs(ys[n - 1] - ys[0]) / Math.max(1, length);

  // discrete curvature → minimum radius
  let minRadius = Infinity;
  for (let i = 1; i < n - 1; i++) {
    const ax = stations[i * 2 - 2], az = stations[i * 2 - 1];
    const bx = stations[i * 2], bz = stations[i * 2 + 1];
    const cx = stations[i * 2 + 2], cz = stations[i * 2 + 3];
    const a = Math.hypot(bx - ax, bz - az);
    const b = Math.hypot(cx - bx, cz - bz);
    const c = Math.hypot(cx - ax, cz - az);
    const s = (a + b + c) / 2;
    const areaSq = s * (s - a) * (s - b) * (s - c);
    if (areaSq <= 1e-6) continue;
    const r = (a * b * c) / (4 * Math.sqrt(areaSq));
    if (r < minRadius) minRadius = r;
  }

  return { ys, raw, length, maxGrade, minRadius, water, n };
}

/**
 * The full legality verdict for a proposed road.
 * `crossings` and `hitBuildings` are supplied by the caller (they need the road
 * graph and the building index, which Rules deliberately does not reach for).
 */
export function judgeRoad(prof, cls, env, extras = {}) {
  const lim = GRADE[classOf(cls)] || GRADE.lane2;
  const world = env.world;
  const demolition = (extras.hitBuildings || []).reduce((a, b) => a + buildingDemolitionCost(b), 0);
  const cost = roadCost(cls, prof.length) + demolition;

  let level = LEVEL.OK;
  let reason = `${ROAD_CLASS[classOf(cls)].lanes}-lane ${classOf(cls)} · ${Math.round(prof.length)} m`;

  const bad = (r) => { level = LEVEL.BAD; reason = r; };
  const warn = (r) => { if (level !== LEVEL.BAD) { level = LEVEL.WARN; reason = r; } };

  if (prof.length < MIN_ROAD_LENGTH) bad(`too short — ${MIN_ROAD_LENGTH} m minimum`);
  else if (prof.water > 0) bad('cannot build across water');
  else if (prof.maxGrade > lim.bad) bad(`gradient too steep — ${(prof.maxGrade * 100).toFixed(0)}% (max ${(lim.bad * 100) | 0}%)`);
  else if (extras.overlaps) bad('overlaps an existing road');
  else if (!affordable(world, cost)) bad(`insufficient funds — needs ${money(cost)}`);
  else if (prof.maxGrade > lim.warn) warn(`steep gradient — ${(prof.maxGrade * 100).toFixed(0)}%`);
  else if (prof.minRadius < (MIN_RADIUS[classOf(cls)] || 14)) warn(`tight curve — ${Math.round(prof.minRadius)} m radius`);
  else if (extras.sharpJunction) warn(`sharp junction — ${Math.round(extras.sharpJunction)}°`);
  else if (extras.hitBuildings && extras.hitBuildings.length)
    warn(`demolishes ${extras.hitBuildings.length} building${extras.hitBuildings.length > 1 ? 's' : ''}`);
  else if (extras.crossings) reason += ` · ${extras.crossings} new junction${extras.crossings > 1 ? 's' : ''}`;

  return verdict(level, reason, {
    cost, demolition,
    length: prof.length,
    grade: prof.maxGrade,
    radius: Number.isFinite(prof.minRadius) ? prof.minRadius : null,
    crossings: extras.crossings || 0,
    demolish: extras.hitBuildings || [],
  });
}

/** Is this point within `pad` of any road corridor? */
export function nearRoad(env, x, z, pad = 3) {
  const roads = env.roads;
  if (!roads || !roads.segmentsNear) return false;
  const ids = roads.segmentsNear([x, 0, z], pad + 30);
  const p = { d: 0, t: 0, x: 0, z: 0 };
  for (const id of ids) {
    const seg = env.world.roads.segments.get(id);
    if (!seg) continue;
    const half = corridorHalf(seg.class);
    const N = 10;
    let px = 0, pz = 0;
    for (let i = 0; i <= N; i++) {
      const q = roads.pointAt(id, i / N);
      if (i > 0) {
        pointSeg(x, z, px, pz, q.x, q.z, p);
        if (p.d < half + pad) return true;
      }
      px = q.x; pz = q.z;
    }
  }
  return false;
}

/** Distance to the nearest road centreline, or Infinity. */
export function roadDistance(env, x, z, maxR = 90) {
  const roads = env.roads;
  if (!roads || !roads.nearestPoint) return Infinity;
  const hit = roads.nearestPoint({ x, z }, maxR);
  return hit ? hit.dist : Infinity;
}

/* --------------------------------------------------------- zone verdicts -- */

export function judgeZone(zone, cells, env, extras = {}) {
  const cost = zoneCost(zone, cells);
  const label = extras.label || 'zone';
  let level = LEVEL.OK;
  let reason = `${label} · ${cells} cell${cells === 1 ? '' : 's'} · ${(cells * 64 / 10000).toFixed(2)} ha`;

  if (cells <= 0) {
    level = LEVEL.BAD;
    reason = extras.blockedByWater ? 'water and road cannot be zoned' : 'nothing to zone here';
  } else if (!affordable(env.world, cost)) {
    level = LEVEL.BAD;
    reason = `insufficient funds — needs ${money(cost)}`;
  } else if (extras.roadDist !== undefined && extras.roadDist > 46 && zone !== ZONE.NONE) {
    level = LEVEL.WARN;
    reason = `no road access — nearest street ${Math.round(extras.roadDist)} m`;
  }
  return verdict(level, reason, { cost, cells });
}

/* ------------------------------------------------------ bulldoze verdicts -- */

export function judgeBulldoze(target, env) {
  if (!target) return verdict(LEVEL.BAD, 'nothing to demolish here', { cost: 0 });
  const cost = target.cost || 0;
  if (!affordable(env.world, cost))
    return verdict(LEVEL.BAD, `insufficient funds — needs ${money(cost)}`, { cost });
  if (target.kind === 'road' && target.junction)
    return verdict(LEVEL.WARN, `remove ${target.label} · isolates a junction`, { cost });
  return verdict(LEVEL.OK, `demolish ${target.label}`, { cost });
}

/* ------------------------------------------------------- terrain verdicts -- */

export function judgeTerrain(op, info, env) {
  const cost = earthCost(info.volume);
  let level = LEVEL.OK;
  let reason = `${op} · ${Math.abs(info.volume).toFixed(0)} m³ · Δ${info.delta >= 0 ? '+' : ''}${info.delta.toFixed(2)} m`;
  if (info.underwater) { level = LEVEL.BAD; reason = 'cannot reshape the sea bed'; }
  else if (info.cells === 0) { level = LEVEL.BAD; reason = 'outside the buildable area'; }
  else if (!affordable(env.world, cost)) { level = LEVEL.BAD; reason = `insufficient funds — needs ${money(cost)}`; }
  else if (info.onRoad) { level = LEVEL.WARN; reason = `${op} · disturbs a road corridor`; }
  else if (info.maxSlope > 1.0) { level = LEVEL.WARN; reason = `${op} · slope ${(info.maxSlope * 100) | 0}% is unbuildable`; }
  return verdict(level, reason, { cost, volume: info.volume });
}

/** Angle in degrees between two headings. */
export function crossAngleDeg(h1, h2) {
  const d = Math.abs(angDiff(h1, h2)) * 180 / Math.PI;
  return d > 90 ? 180 - d : d;
}
