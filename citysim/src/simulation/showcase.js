import { FieldOverlay, stretch } from './Overlay.js';
import { Glyphs } from './Glyphs.js';
import { SERVICE_INDEX, clamp01 } from './constants.js';

/**
 * Showcase staging.
 *
 * This module is data, so a shot of it has to be a shot of the *city* with the
 * simulation drawn onto it. Every variant therefore lays a real road network
 * through `roads`, zones it through `zoning`, builds it through `buildings`,
 * runs the simulation forward several simulated days so the numbers are settled
 * rather than freshly seeded, and only then drapes a field over the result.
 *
 * The overlays default OFF. They are only ever switched on here, and by an
 * explicit `setOverlay()` call from outside.
 */

const GRID = {
  // odd cols/rows on purpose — see R-traffic-3: `Generator.rank()` only lays
  // arterials when the middle index is an integer, so an even grid silently
  // comes out as a uniform mesh of lane2 with no hierarchy at all.
  cols: 7, rows: 7, blockW: 112, blockH: 92,
  highway: true, ramp: true, organic: true, alleys: true,
};

const VARIANTS = {
  default: { field: 'landValue', mode: 0, iso: 0.95, opacity: 0.90, days: 6, preset: 'aerial' },
  demand: { field: 'pressure', mode: 2, iso: 0.30, opacity: 0.86, days: 8, preset: 'aerial' },
  coverage: { field: 'coverage', mode: 1, iso: 0.75, opacity: 0.86, days: 6, preset: 'aerial' },
  rhythm: { field: null, mode: 0, iso: 0, opacity: 0, days: 5, preset: 'city' },
};

export function stage(ctx, S, variant, hooks) {
  const cfg = VARIANTS[variant] || VARIANTS.default;
  const log = ctx.log;

  /* ---- 1. a real city under the field ------------------------------- */
  const roads = ctx.get('roads');
  if (roads && typeof roads.generateGrid === 'function' && ctx.world.roads.segments.size === 0) {
    try { roads.generateGrid(GRID); }
    catch (err) { log.warn('road staging failed:', err.message); }
  }
  const zoning = ctx.get('zoning');
  if (zoning && typeof zoning.autoZone === 'function') {
    try { zoning.autoZone(); }
    catch (err) { log.warn('zoning staging failed:', err.message); }
  }
  const buildings = ctx.get('buildings');
  if (buildings && typeof buildings.generateForNetwork === 'function'
    && ctx.world.buildings.size === 0) {
    try {
      buildings.generateForNetwork({
        centre: [0, 0], radius: 380, urbanBias: 0.04, limit: 620,
      });
    } catch (err) { log.warn('building staging failed:', err.message); }
  }

  /*
   * The `rhythm` variant is the only one that needs the *living* city — cars and
   * street furniture — rather than a diagram over it.
   *
   * `traffic` and `props` both ignore `roads:changed` while some other module is
   * being showcased (`if (ctx.opts?.showcase) return`), which is the right
   * default: it stops a sibling's staging from rebuilding them behind their
   * back. The consequence is that a network staged here is invisible to them, so
   * a `simulation` rhythm shot came out with empty streets. `ModuleHost.rebuild`
   * is the sanctioned "a dependency's data changed" path, so drive it once, then
   * dress the plots through props' own public `populate()`. Filed as R-sim-2.
   */
  if (variant === 'rhythm') {
    try { ctx.engine?.host?.rebuild?.('roads'); }
    catch (err) { log.warn('sibling rebuild failed:', err.message); }
    const props = ctx.get('props');
    if (props && typeof props.populate === 'function') {
      try { props.populate({}); }
      catch (err) { log.warn('props dressing failed:', err.message); }
    }
  }

  /* ---- 2. run the simulation until it means something ---------------- */
  hooks.rebuild('showcase');
  const sim = S.sim;
  // the harness pins the hour, so drive the clock ourselves for the preroll and
  // then put the requested hour back — the shot must be at the time asked for
  const wantHours = ctx.world.time.hours;
  const wantDay = ctx.world.time.day;
  const t0 = nowMs();
  sim.advanceDays(cfg.days);
  const prerollMs = nowMs() - t0;
  ctx.world.time.hours = wantHours;
  ctx.world.time.day = wantDay;
  sim._lastSeenHours = wantHours;
  sim.day = wantDay;
  sim.hourBucket = Math.floor(wantHours);
  sim._hourly(true);

  /* ---- 3. drive the visible city from the simulation ------------------ */
  const traffic = ctx.get('traffic');
  if (traffic && typeof traffic.setDensity === 'function') {
    try { traffic.setDensity(sim.rhythm.trafficDensity); }
    catch (err) { log.warn('traffic density push failed:', err.message); }
  }

  /* ---- 4. the field ---------------------------------------------------- */
  const terrain = ctx.get('terrain');
  const hAt = terrain && terrain.heightAt
    ? (x, z) => terrain.heightAt(x, z)
    : (x, z) => ctx.world.heightAt(x, z);
  const water = ctx.world.terrain?.water ?? 0;
  const bb = sim.fields.bbox();
  const area = { x0: bb.x0, z0: bb.z0, x1: bb.x1, z1: bb.z1 };

  if (!S.overlay) S.overlay = new FieldOverlay(ctx, sim.grid);
  if (!S.glyphs) S.glyphs = new Glyphs(ctx);
  S.glyphs.clearArrows(); S.glyphs.clearMarkers();

  let legend = null, range = null;
  const scratch = new Float32Array(sim.grid.n);
  if (cfg.field === 'landValue') {
    range = stretch(sim.fields.landValue, sim.fields.built, scratch);
    S.overlay.setField(scratch, sim.fields.built);
    legend = 'land value';
  } else if (cfg.field === 'coverage') {
    // the composite the land-value model actually consumes. NOT stretched:
    // 0 and 1 mean "nothing" and "fully served" in absolute terms here, and
    // rescaling them would turn "the whole city is under-served" into "half of
    // it is fine", which is a lie.
    S.overlay.setField(sim.fields.service, sim.fields.built);
    legend = 'service coverage';
    range = { lo: 0, hi: 1 };
  } else if (cfg.field === 'pressure') {
    const { value, zone } = packPressure(sim);
    S.overlay.setField(value, sim.fields.built, zone);
    legend = 'growth pressure';
    range = { lo: 0, hi: 1 };
  }

  if (cfg.field) {
    const mesh = S.overlay.build(area, terrain, water);
    ctx.group.add(mesh);
    S.overlay.setMode(cfg.mode);
    S.overlay.setIso(cfg.iso);
    S.overlay.setOpacity(cfg.opacity);
    S.overlay.setFloor(cfg.field === 'pressure' ? 0.20 : 0.02);
    S.overlay.setTime(ctx.world.time.hours);
    S.overlay.setEnabled(true);
  } else {
    S.overlay.setEnabled(false);
  }

  let glyphs = 0;
  if (variant === 'demand') {
    glyphs = S.glyphs.buildArrows(sim.fields.topPressure(14), hAt, { maxHeight: 52, minP: 0.10 });
  } else if (variant === 'coverage') {
    glyphs = S.glyphs.buildMarkers(sim.fields.installations.map((i) => ({
      x: i.x, z: i.z, kind: i.kind, quality: clamp01(i.quality ?? 1),
    })), hAt);
  }

  /* ---- 5. framing ------------------------------------------------------ */
  const mid = [(area.x0 + area.x1) * 0.5, (area.z0 + area.z1) * 0.5];
  const span = Math.max(area.x1 - area.x0, area.z1 - area.z0);
  // the aerial preset looks down the +x/+z diagonal, so bias the target that way
  const bias = span * 0.05;
  const tx = mid[0] + bias, tz = mid[1] + bias;
  const ty = hAt(tx, tz);

  S.lastStage = {
    variant, days: cfg.days, prerollMs: Math.round(prerollMs), legend, glyphs,
    range: range ? { lo: +range.lo.toFixed(3), hi: +range.hi.toFixed(3) } : null,
    population: sim.pop.count, jobs: sim.pop.jobsTotal,
    landValue: +sim.fields.stats.landValueMean.toFixed(3),
    coverage: +sim.fields.stats.coverageMean.toFixed(3),
    demand: sim.demand.value(),
    trafficDensity: +sim.rhythm.trafficDensity.toFixed(2),
    budget: Math.round(sim.econ.budget),
  };
  log.info(`showcase "${variant}"`, S.lastStage);

  if (variant === 'rhythm') {
    /*
     * The evening commute peak.
     *
     * A shot from above downtown proves nothing: the towers hide every street
     * and the vehicles the simulation asked for are invisible. So this frames
     * the arterial that the *simulation's own congestion data* says is the
     * busiest — `world.stats.traffic.bySegment`, which the traffic module
     * publishes — and looks down it, so a queue of cars, the lit windows and the
     * low sun are all in one frame.
     */
    const shot = busiestArterial(ctx, sim);
    const reveal = ['roads', 'buildings', 'props', 'traffic', 'terrain', 'environment', 'effects'];
    if (shot) {
      S.lastStage.framedSegment = shot.id;
      S.lastStage.framedCongestion = +shot.v.toFixed(3);
      return {
        target: [shot.x, hAt(shot.x, shot.z) + 9, shot.z],
        dist: 215, az: Math.atan2(-shot.tx, -shot.tz), pol: 1.22, fov: 46, reveal,
      };
    }
    const cx = sim.centre[0], cz = sim.centre[1];
    return {
      target: [cx, hAt(cx, cz) + 26, cz],
      dist: 540, az: 0.98, pol: 0.88, fov: 40, reveal,
    };
  }

  return {
    target: [tx, ty, tz],
    dist: Math.max(360, span * 1.02), az: 0.72, pol: 0.60, fov: 42,
    reveal: ['roads', 'buildings', 'terrain', 'environment', 'effects'],
  };
}

/**
 * The busiest multi-lane street in the city, with its midpoint and tangent.
 * Reads `world.stats.traffic.bySegment` — tolerating the older shape where
 * `world.stats.traffic` was just a number — and falls back to the longest
 * arterial when no congestion data exists yet.
 */
function busiestArterial(ctx, sim) {
  const roads = ctx.get('roads');
  const t = ctx.world.stats.traffic;
  const by = (t && typeof t === 'object' && t.bySegment) ? t.bySegment : null;
  const WIDE = { lane4: 1, boulevard: 1, highway: 0 };
  let best = null;
  for (const seg of ctx.world.roads.segments.values()) {
    const wide = WIDE[seg.class];
    if (!wide) continue;
    const v = by ? (by[seg.id] || 0) : (seg.length || 0) / 1000;
    if (!best || v > best.v) best = { id: seg.id, v };
  }
  if (!best) return null;
  let p = null, tan = null;
  if (roads && typeof roads.pointAt === 'function') {
    try { p = roads.pointAt(best.id, 0.5); } catch { p = null; }
  }
  if (roads && typeof roads.tangentAt === 'function') {
    try { tan = roads.tangentAt(best.id, 0.5); } catch { tan = null; }
  }
  const seg = ctx.world.roads.segments.get(best.id);
  if (!p && seg && seg.curve) {
    const c = seg.curve;
    p = [(c[0][0] + c[3][0]) * 0.5, 0, (c[0][2] + c[3][2]) * 0.5];
    tan = [c[3][0] - c[0][0], 0, c[3][2] - c[0][2]];
  }
  if (!p) return null;
  const px = p.x !== undefined ? p.x : p[0];
  const pz = p.z !== undefined ? p.z : p[2];
  let tx = tan ? (tan.x !== undefined ? tan.x : tan[0]) : 1;
  let tz = tan ? (tan.z !== undefined ? tan.z : tan[2]) : 0;
  const l = Math.hypot(tx, tz) || 1;
  tx /= l; tz /= l;
  void sim;
  return { id: best.id, v: best.v, x: px, z: pz, tx, tz };
}

/**
 * Pack the three pressure fields into one value + one zone selector:
 * value = the winning pressure, zone = 0 residential / 0.5 commercial /
 * 1 industrial, so the shader can hue it without three textures.
 */
function packPressure(sim) {
  const f = sim.fields, n = sim.grid.n;
  const value = f._packV || (f._packV = new Float32Array(n));
  const zone = f._packZ || (f._packZ = new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const r = f.pressureR[i], c = f.pressureC[i], ind = f.pressureI[i];
    let v = r, z = 0;
    if (c > v) { v = c; z = 0.5; }
    if (ind > v) { v = ind; z = 1; }
    value[i] = v; zone[i] = z;
  }
  // stretch so the strongest site reads as the strongest site
  let max = 0;
  for (let i = 0; i < n; i++) if (value[i] > max) max = value[i];
  if (max > 1e-4) { const inv = 1 / max; for (let i = 0; i < n; i++) value[i] *= inv; }
  return { value, zone };
}

const nowMs = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now() : () => 0;

export { SERVICE_INDEX };
export default stage;
