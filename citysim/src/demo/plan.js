/**
 * The urban plan — the shape of the city, in metres, before a single road
 * exists. Everything here is derived from `Site` + the seeded RNG, so the plan
 * is reproducible and follows the ground rather than being drawn on top of it.
 *
 * The structure it lays out, in the order a real city grows:
 *
 *   waterfront ── downtown grid ── midtown ── residential fringe
 *        │             │                          │
 *      quays       boulevard spine            organic lanes on the slopes
 *                      │
 *                  ring / highway ── industrial estate (downwind, by the ramp)
 */

import { offsetPoly, resample, simplify, smoothPoly } from './site.js';

/**
 * @param {Site} site
 * @param {Rng} rng
 * @returns {object} the plan
 */
export function makePlan(site, rng, opts = {}) {
  const basin = site.basin;
  const axis = site.axis;

  /* ---------------------------------------------------------------- core -- */
  // Downtown wants open water in front of it and buildable land behind it —
  // that is what makes a skyline photographable and what actually decided the
  // site of every waterfront city there is.
  const coreInset = opts.coreInset ?? 165;
  const vista = site.bestVista(coreInset);
  const shoreP = vista.point;
  const inward = vista.inward;

  let core = [shoreP[0] + inward[0] * coreInset, shoreP[1] + inward[1] * coreInset];
  if (!site.buildable(core[0], core[1], 0.20)) {
    const n2 = site.nudge(core, inward, 220, 0.20);
    core = n2 || [basin.x, basin.z];
  }

  // u runs along the shore, v runs inland
  const v = [inward[0], inward[1]];
  const u = [-v[1], v[0]];
  void axis;
  // the lattice origin sits `originInset` inland of the shore, on the core line
  const originInset = opts.originInset ?? 96;
  const origin = [shoreP[0] + v[0] * originInset, shoreP[1] + v[1] * originInset];

  const toWorld = (uu, vv) => [
    origin[0] + u[0] * uu + v[0] * vv,
    origin[1] + u[1] * uu + v[1] * vv,
  ];
  const toLocal = (x, z) => {
    const dx = x - origin[0], dz = z - origin[1];
    return [dx * u[0] + dz * u[1], dx * v[0] + dz * v[1]];
  };

  /* ------------------------------------------------------- street spacing -- */
  // Block size grows with distance from the core — that single fact is most of
  // what makes a city read as downtown → midtown → suburb rather than a lattice.
  const depth = opts.depth ?? 560;
  const width = opts.width ?? 480;
  const vs = [];
  {
    let vv = 0;
    while (vv < depth) {
      vs.push(vv);
      // 80 m between streets downtown, opening out to ~135 m at the fringe.
      // Downtown wants short blocks (frontage is what a city is made of); the
      // suburbs want long ones.
      vv += 80 + (vv / depth) * 56 + rng.range(-5, 5);
    }
  }
  const us = [0];
  {
    for (const s of [1, -1]) {
      let uu = 0;
      for (let k = 0; k < 9; k++) {
        uu += s * (98 + (Math.abs(uu) / 380) * 48 + rng.range(-6, 6));
        if (Math.abs(uu) > width) break;
        us.push(uu);
      }
    }
    us.sort((a, b) => a - b);
  }

  const uMid = us.indexOf(0);
  // one cross-town arterial two blocks back from the water, one on the far side
  const vArt1 = Math.min(2, vs.length - 1);
  const vArt2 = Math.max(vArt1 + 2, Math.round((vs.length - 1) * 0.72));
  const vClass = (j) => ((j === vArt1 || j === vArt2) ? 'lane4' : 'lane2');
  const uClass = (i) => {
    if (i === uMid) return 'boulevard';
    const d = Math.abs(i - uMid);
    return d === 3 ? 'lane4' : 'lane2';
  };

  /* --------------------------------------------------------- waterfront --- */
  // The quay follows the traced shoreline, pushed inland far enough that the
  // carriageway is never in the water and never on the beach.
  const quayInset = opts.quayInset ?? 30;
  let quay = [];
  if (site.shore.length > 3) {
    const raw = offsetPoly(site.shore, -quayInset * Math.sign(1));
    // offsetPoly's sign depends on the traced direction — pick whichever side
    // lands on dry land more often
    const a = offsetPoly(site.shore, quayInset);
    const dry = (p) => (site.buildable(p[0], p[1], 0.34) ? 1 : 0);
    const scoreA = a.reduce((s, p) => s + dry(p), 0);
    const scoreB = raw.reduce((s, p) => s + dry(p), 0);
    let line = scoreA >= scoreB ? a : raw;
    // keep only the run that fronts the city
    line = line.filter((p) => {
      const l = toLocal(p[0], p[1]);
      return Math.abs(l[0]) < (opts.width ?? 520) + 170 && l[1] > -90 && l[1] < 260;
    });
    line = smoothPoly(line, 2);
    // drop anything that cannot carry a road at all
    const runs = [];
    let cur = [];
    for (const p of line) {
      if (site.buildable(p[0], p[1], 0.30)) cur.push(p);
      else { if (cur.length > 2) runs.push(cur); cur = []; }
    }
    if (cur.length > 2) runs.push(cur);
    runs.sort((x, y) => y.length - x.length);
    quay = runs.length ? resample(simplify(runs[0], 14), 76) : [];
  }

  /* ------------------------------------------------------------- highway -- */
  // A motorway skirting the foot of the hills on the land side of the city.
  // Rather than a circle of fixed radius, each spoke marches outward from the
  // core until the ground stops being road-able and stands the carriageway just
  // inside that line — which is literally "along the foot of the hills", and
  // cannot walk into the river because water is not road-able either.
  const shoreAng = Math.atan2(-v[1], -v[0]);      // direction from core to water
  const minR = opts.minRingR ?? 380;
  const maxR = opts.maxRingR ?? 900;
  const hw = [];
  const N = 26;
  for (let k = 0; k <= N; k++) {
    const a = shoreAng + Math.PI * 0.30 + (k / N) * Math.PI * 1.40;
    const cs = Math.cos(a), sn = Math.sin(a);
    let lastGood = -1, run = 0;
    for (let r = minR; r <= maxR; r += 14) {
      const x = core[0] + cs * r, z = core[1] + sn * r;
      // require a corridor, not a single lucky sample
      const wide = site.buildable(x, z, 0.235)
        && site.buildable(x - sn * 16, z + cs * 16, 0.28)
        && site.buildable(x + sn * 16, z - cs * 16, 0.28);
      if (wide) { run++; if (run >= 2) lastGood = r; }
      else run = 0;
    }
    if (lastGood < 0) { hw.push(null); continue; }
    const r = Math.max(minR, lastGood - 34);
    hw.push([core[0] + cs * r, core[1] + sn * r]);
  }
  // longest contiguous buildable run, then smoothed: a motorway has geometry
  const highway = smoothPoly(longestRun(hw), 2);
  const ringR = highway.length
    ? highway.reduce((s, p) => s + Math.hypot(p[0] - core[0], p[1] - core[1]), 0) / highway.length
    : minR;

  /* ------------------------------------------------------------ industry -- */
  // Downwind of downtown (the weather module's wind vector) and next to the
  // highway: the two things that decide where industry actually goes.
  const wind = opts.windDir ?? 0.7;
  const downwind = [Math.cos(wind), Math.sin(wind)];
  let industry = null;
  if (highway.length > 3) {
    let best = null;
    for (const p of highway) {
      const dx = p[0] - core[0], dz = p[1] - core[1];
      const L = Math.hypot(dx, dz) || 1;
      const align = (dx / L) * downwind[0] + (dz / L) * downwind[1];
      const s = align * 1.0 - (site.nearestShore(p[0], p[1])?.d ?? 999) / 1400;
      if (!best || s > best.s) best = { s, p };
    }
    if (best) {
      const dx = best.p[0] - core[0], dz = best.p[1] - core[1];
      const L = Math.hypot(dx, dz) || 1;
      industry = {
        x: best.p[0] - (dx / L) * 120,
        z: best.p[1] - (dz / L) * 120,
        r: 190,
      };
    }
  }

  return {
    core, origin, u, v, toWorld, toLocal,
    us, vs, uMid, uClass, vClass,
    quay, highway, industry,
    vista,
    shore: site.shore,
    width: opts.width ?? 520,
    depth: opts.depth ?? 620,
    ringR,
  };
}

/** Longest run of non-null points in a sparse array. */
function longestRun(pts) {
  let best = [], cur = [];
  for (const p of pts) {
    if (p) { cur.push(p); if (cur.length > best.length) best = cur; }
    else cur = [];
  }
  return best;
}

export default makePlan;
