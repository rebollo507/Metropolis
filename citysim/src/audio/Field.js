/**
 * audio/Field — what the city sounds like *here*.
 *
 * Turns the world model into the small state object the mix is a pure function
 * of: how urban this place is, how much traffic is on it and how jammed, which
 * land uses surround it and *where* their centroids are, plus the hour, the
 * weather and where the ear is standing.
 *
 * Everything is guarded: any module may be missing or FAILED, in which case its
 * contribution is simply absent and the mix degrades to a plausible bed rather
 * than to silence or to a thrown exception.
 *
 * Cost control: the world sample runs at 4 Hz, not per frame, and re-uses one
 * state object and one source array — nothing in here allocates once warm.
 */

import { ZONE } from '../core/World.js';
import { clamp, smoothstep } from './Dsp.js';

const SAMPLES = 9;          // 9×9 lattice over the sample radius
const RADIUS = 260;         // metres

/** Land-use families the mix cares about. */
const FAMILY = {
  [ZONE.RES_LOW]: 'res', [ZONE.RES_HIGH]: 'res',
  [ZONE.COM_LOW]: 'com', [ZONE.COM_HIGH]: 'com', [ZONE.OFFICE]: 'com',
  [ZONE.IND]: 'ind',
  [ZONE.PARK]: 'park', [ZONE.CIVIC]: 'civ',
};

export class Field {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = {
      hours: 13, day: 0, isNight: null,
      weather: { preset: 'clear', wetness: 0, windSpeed: 2.4 },
      camera: { x: 0, y: 60, z: 0, agl: 60, dist: 300, tx: 0, tz: 0 },
      listener: { x: 0, y: 20, z: 0, fx: 0, fy: 0, fz: -1 },
      zones: { res: 0, com: 0, ind: 0, park: 0, civ: 0, none: 1 },
      density: { urban: 0, vehicles: 0, congestion: 0, building: 0, roadNear: 0, roadFar: 0, population: 0 },
      sources: [],
      city: { buildings: 0, population: 0, size: 0 },
    };
    // fixed, reused — the mix reads these by name
    this.state.sources = [
      { name: 'zone.industry', label: 'Industrial plant', bus: 'ambience', x: 0, y: 6, z: 0, ref: 55, max: 900, weight: 0 },
      { name: 'zone.retail', label: 'Retail frontage', bus: 'ambience', x: 0, y: 2, z: 0, ref: 30, max: 420, weight: 0 },
      { name: 'zone.green', label: 'Trees / park', bus: 'ambience', x: 0, y: 4, z: 0, ref: 34, max: 460, weight: 0 },
      { name: 'road.a', label: 'Arterial (near)', bus: 'traffic', x: 0, y: 1, z: 0, ref: 26, max: 520, weight: 0 },
      { name: 'road.b', label: 'Arterial (far)', bus: 'traffic', x: 0, y: 1, z: 0, ref: 40, max: 700, weight: 0 },
    ];
    this._lastSample = -1e9;
    this._lastFocus = { x: 1e9, z: 1e9 };
    this._acc = { res: 0, com: 0, ind: 0, park: 0, civ: 0, total: 0 };
    this._cent = {
      ind: { x: 0, z: 0, w: 0 }, com: { x: 0, z: 0, w: 0 }, green: { x: 0, z: 0, w: 0 },
    };
    this.sampleMs = 0;
  }

  api(name) { try { return this.ctx.get(name); } catch { return null; } }

  groundAt(x, z) {
    const t = this.api('terrain');
    if (t && t.heightAt) { const h = t.heightAt(x, z); if (Number.isFinite(h)) return h; }
    try { return this.ctx.world.heightAt(x, z) || 0; } catch { return 0; }
  }

  /**
   * The ear.
   *
   * A city builder's camera is often 600 m from what it is looking at, and a
   * listener parked on the lens hears nothing at all — which is *accurate* and
   * useless. So the listener rides the camera→target ray but never further than
   * 90 m out: pans and near/far relationships stay geometrically honest, while
   * the city below an aerial shot is still audible. The altitude character of
   * the mix comes from the camera's real height, not from this clamp.
   */
  listenerFrom(cam, target) {
    const dx = cam.x - target.x, dy = cam.y - target.y, dz = cam.z - target.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const k = Math.min(d, 90) / d;
    return {
      x: target.x + dx * k, y: target.y + dy * k, z: target.z + dz * k,
      fx: -dx / d, fy: -dy / d, fz: -dz / d,
    };
  }

  /** Sample the world. `force` bypasses the 4 Hz / 30 m gate. */
  sample(elapsed, force = false) {
    const s = this.state;
    const ctx = this.ctx;
    const world = ctx.world;
    const rig = ctx.cameraRig;
    const cam = ctx.camera ? ctx.camera.position : { x: 0, y: 60, z: 0 };
    const tgt = rig && rig.target ? rig.target : { x: 0, y: 0, z: 0 };

    /* ---- always cheap: time, weather, camera ---------------------------- */
    s.hours = world.time.hours;
    s.day = world.time.day;
    s.weather.preset = world.weather.preset;
    s.weather.wetness = world.weather.wetness;
    s.weather.windSpeed = world.weather.windSpeed;

    s.camera.x = cam.x; s.camera.y = cam.y; s.camera.z = cam.z;
    s.camera.tx = tgt.x; s.camera.tz = tgt.z;
    s.camera.dist = rig ? rig.dist : 300;
    const g = this.groundAt(cam.x, cam.z);
    s.camera.agl = Math.max(0, cam.y - g);

    const L = this.listenerFrom(cam, tgt);
    s.listener.x = L.x; s.listener.y = L.y; s.listener.z = L.z;
    s.listener.fx = L.fx; s.listener.fy = L.fy; s.listener.fz = L.fz;

    const moved = Math.hypot(tgt.x - this._lastFocus.x, tgt.z - this._lastFocus.z);
    if (!force && elapsed - this._lastSample < 0.25 && moved < 30) return s;
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    this._lastSample = elapsed;
    this._lastFocus.x = tgt.x; this._lastFocus.z = tgt.z;

    /* ---- land use ------------------------------------------------------- */
    const zoning = this.api('zoning');
    const acc = this._acc, cen = this._cent;
    acc.res = acc.com = acc.ind = acc.park = acc.civ = acc.total = 0;
    cen.ind.x = cen.ind.z = cen.ind.w = 0;
    cen.com.x = cen.com.z = cen.com.w = 0;
    cen.green.x = cen.green.z = cen.green.w = 0;

    if (zoning && zoning.zoneAt) {
      const step = (RADIUS * 2) / (SAMPLES - 1);
      for (let j = 0; j < SAMPLES; j++) {
        const z = tgt.z - RADIUS + j * step;
        for (let i = 0; i < SAMPLES; i++) {
          const x = tgt.x - RADIUS + i * step;
          const d = Math.hypot(x - tgt.x, z - tgt.z);
          const w = 1 / (1 + (d / 110) * (d / 110));
          acc.total += w;
          const fam = FAMILY[zoning.zoneAt(x, z)];
          if (!fam) continue;
          acc[fam] += w;
          if (fam === 'ind') { cen.ind.x += x * w; cen.ind.z += z * w; cen.ind.w += w; }
          else if (fam === 'com') { cen.com.x += x * w; cen.com.z += z * w; cen.com.w += w; }
          else if (fam === 'park' || fam === 'res') {
            const gw = fam === 'park' ? w : w * 0.45;
            cen.green.x += x * gw; cen.green.z += z * gw; cen.green.w += gw;
          }
        }
      }
    }
    const tot = acc.total || 1;
    // land-use fractions are boosted a little: a 20 % industrial neighbourhood
    // sounds industrial, it does not sound 20 % industrial
    const boost = (v) => clamp(Math.pow(v / tot, 0.72) * 1.35, 0, 1);
    s.zones.res = boost(acc.res);
    s.zones.com = boost(acc.com);
    s.zones.ind = boost(acc.ind);
    s.zones.park = boost(acc.park);
    s.zones.civ = boost(acc.civ);
    s.zones.none = clamp(1 - (acc.res + acc.com + acc.ind + acc.park + acc.civ) / tot, 0, 1);

    /* ---- buildings ------------------------------------------------------ */
    const buildings = this.api('buildings');
    let bCount = 0, bHeight = 0;
    if (buildings && buildings.buildingsNear) {
      const list = buildings.buildingsNear([tgt.x, 0, tgt.z], 220);
      bCount = list.length;
      for (let i = 0; i < list.length; i++) bHeight += list[i].height || 0;
    } else if (world.buildings && world.buildings.size) {
      bCount = Math.min(world.buildings.size, 60);
    }
    s.density.urban = clamp(bCount / 45 * 0.6 + bHeight / 2600 * 0.4, 0, 1);
    s.density.building = clamp(bCount / 60, 0, 1);

    /* ---- traffic -------------------------------------------------------- */
    const traffic = this.api('traffic');
    let veh = 0, jam = 0;
    if (traffic) {
      if (traffic.vehiclesNear) {
        try { veh = traffic.vehiclesNear([tgt.x, 0, tgt.z], 240).length; } catch { veh = 0; }
      }
      if (traffic.congestionAt) {
        try { jam = traffic.congestionAt(tgt.x, tgt.z) || 0; } catch { jam = 0; }
      }
      if (!veh && traffic.stats) {
        try { veh = Math.min(60, (traffic.stats().vehicles || 0) * 0.12); } catch { /* ignore */ }
      }
    }
    s.density.vehicles = clamp(veh / 55, 0, 1);
    s.density.congestion = clamp(jam, 0, 1);

    /* ---- roads: the two positional traffic sources ---------------------- */
    const roads = this.api('roads');
    let near = null, far = null, nNear = 0, nFar = 0;
    if (roads && roads.segmentsNear) {
      try {
        const idsNear = roads.segmentsNear([tgt.x, 0, tgt.z], 90);
        const idsFar = roads.segmentsNear([tgt.x, 0, tgt.z], 300);
        nNear = idsNear.length; nFar = Math.max(0, idsFar.length - idsNear.length);
      } catch { /* ignore */ }
    }
    if (roads && roads.nearestPoint) {
      try { near = roads.nearestPoint([tgt.x, 0, tgt.z]); } catch { near = null; }
    }
    if (near && roads && roads.pointAt) {
      // a second, further road so the traffic bed has width rather than a point
      try {
        const net = roads.network ? roads.network() : null;
        if (net) {
          let best = null, bestScore = -1;
          let scanned = 0;
          for (const seg of net.segments.values()) {
            if (++scanned > 260) break;
            const p = seg.curve && seg.curve[0];
            if (!p) continue;
            const d = Math.hypot(p.x - tgt.x, p.z - tgt.z);
            if (d < 120 || d > 420) continue;
            const wide = seg.class === 'boulevard' || seg.class === 'lane4' || seg.class === 'highway' ? 1.6 : 1;
            const score = wide / (1 + d / 200);
            if (score > bestScore) { bestScore = score; best = p; }
          }
          if (best) far = { pos: { x: best.x, y: best.y || 0, z: best.z } };
        }
      } catch { /* ignore */ }
    }
    s.density.roadNear = clamp(nNear / 5, 0, 1);
    s.density.roadFar = clamp(nFar / 14, 0, 1);

    /* ---- publish the positional sources --------------------------------- */
    const src = s.sources;
    const place = (rec, cx, cz, w, y) => {
      rec.weight = w;
      if (w > 0.001) {
        rec.x = cx; rec.z = cz;
        rec.y = this.groundAt(cx, cz) + y;
      }
    };
    place(src[0], cen.ind.w ? cen.ind.x / cen.ind.w : tgt.x, cen.ind.w ? cen.ind.z / cen.ind.w : tgt.z, s.zones.ind, 7);
    place(src[1], cen.com.w ? cen.com.x / cen.com.w : tgt.x, cen.com.w ? cen.com.z / cen.com.w : tgt.z, s.zones.com, 2);
    place(src[2], cen.green.w ? cen.green.x / cen.green.w : tgt.x, cen.green.w ? cen.green.z / cen.green.w : tgt.z,
      clamp(s.zones.park + s.zones.res * 0.45, 0, 1), 5);
    if (near && near.pos) place(src[3], near.pos.x, near.pos.z, s.density.roadNear, 0.8);
    else place(src[3], tgt.x, tgt.z, s.density.roadNear, 0.8);
    if (far && far.pos) place(src[4], far.pos.x, far.pos.z, s.density.roadFar, 1.2);
    else place(src[4], tgt.x + 180, tgt.z - 140, s.density.roadFar * 0.5, 1.2);

    /* ---- city scale (drives the music register) ------------------------- */
    const pop = (world.stats && world.stats.population) || 0;
    s.city.buildings = world.buildings ? world.buildings.size : 0;
    s.city.population = pop;
    s.city.size = clamp(smoothstep(0, 12000, pop) * 0.6 + smoothstep(0, 400, s.city.buildings) * 0.4, 0, 1);
    s.density.population = clamp(pop / 12000, 0, 1);

    this.sampleMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0;
    return s;
  }

  /** A plain, serialisable copy — used by the showcase and the harness. */
  snapshot() {
    const s = this.state;
    return JSON.parse(JSON.stringify({
      hours: +s.hours.toFixed(2), day: s.day, isNight: s.isNight,
      weather: s.weather, camera: s.camera, listener: s.listener,
      zones: s.zones, density: s.density, city: s.city,
      sources: s.sources,
    }));
  }
}

/** A state object with no world attached — the harness's baseline. */
export function blankState(over = {}) {
  const s = {
    hours: 13, day: 0, isNight: null,
    weather: { preset: 'clear', wetness: 0, windSpeed: 2.4 },
    camera: { x: 0, y: 40, z: 0, agl: 40, dist: 120, tx: 0, tz: 0 },
    listener: { x: 0, y: 20, z: 60, fx: 0, fy: -0.2, fz: -1 },
    zones: { res: 0.3, com: 0.35, ind: 0.1, park: 0.15, civ: 0.05, none: 0.2 },
    density: { urban: 0.6, vehicles: 0.5, congestion: 0.2, building: 0.4, roadNear: 0.6, roadFar: 0.4, population: 0.3 },
    city: { buildings: 240, population: 4800, size: 0.45 },
    sources: [
      { name: 'zone.industry', label: 'Industrial plant', bus: 'ambience', x: 180, y: 8, z: -120, ref: 55, max: 900, weight: 0.1 },
      { name: 'zone.retail', label: 'Retail frontage', bus: 'ambience', x: -40, y: 2, z: 30, ref: 30, max: 420, weight: 0.35 },
      { name: 'zone.green', label: 'Trees / park', bus: 'ambience', x: 60, y: 5, z: 90, ref: 34, max: 460, weight: 0.3 },
      { name: 'road.a', label: 'Arterial (near)', bus: 'traffic', x: 8, y: 1, z: 12, ref: 26, max: 520, weight: 0.6 },
      { name: 'road.b', label: 'Arterial (far)', bus: 'traffic', x: 150, y: 1, z: -90, ref: 40, max: 700, weight: 0.4 },
    ],
  };
  const out = JSON.parse(JSON.stringify(s));
  for (const k of Object.keys(over)) {
    if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) Object.assign(out[k], over[k]);
    else out[k] = over[k];
  }
  return out;
}

export default Field;
