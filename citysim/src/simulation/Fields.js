/**
 * The spatial half of the simulation: every scalar field the city is judged on.
 *
 * All of it lives on one coarse `FieldGrid` and is refreshed by `phase(k)`,
 * which does exactly one bounded slab of work. `Sim` calls one phase per tick,
 * so a complete refresh of every field costs FIELD_PHASES ticks (1.2 s at 20 Hz)
 * and no single tick ever pays for the whole thing.
 *
 * Fields, and what they mean:
 *   pop / jobs        residents and jobs per cell, blurred to a walkable radius
 *   access            road accessibility (weighted by class), static per network
 *   congestion        traffic congestion splatted from `world.stats.traffic.bySegment`
 *   pollution         advected/diffused plume from industry, traffic and utilities
 *   amenity           parks, water, retail proximity, minus industry
 *   coverage[k]       supply/demand ratio for each of the seven services
 *   service           the composite service quality that land value uses
 *   landValue         the derived field everything else reads
 *   pressureR/C/I     where demand wants to build next
 */

import { chamferDistance } from './Grid.js';
import {
  SERVICES, SERVICE_SPEC, CLASS, LV, UPKEEP_SCALE, clamp01, smoothstep,
} from './constants.js';

export class Fields {
  constructor(grid, rng) {
    this.grid = grid;
    this.rng = rng;
    const f = () => grid.field();

    this.pop = f(); this.jobs = f(); this.indJobs = f();
    this.access = f(); this.roadDens = f();
    this.congestion = f();
    this.pollution = f(); this.pollSrc = f();
    this.amenity = f(); this.parks = f();
    this.service = f();
    this.landValue = f();
    this.pressureR = f(); this.pressureC = f(); this.pressureI = f();
    this.built = f();               // 0..1 mask of "this cell is part of the city"
    this.demandField = f();         // per-cell demand for service capacity (people)

    this.coverage = SERVICES.map(() => f());
    this.supply = SERVICES.map(() => f());

    this.installations = [];        // {kind, x, z, radius, capacity, upkeep, on}
    this.wind = [0.2, -0.1];
    this.stats = { landValueMean: 0, landValueMax: 0, pollutionMean: 0, coverageMean: 0 };
    this._cover = new Float32Array(SERVICES.length);
    this._bbox = { x0: 0, z0: 0, x1: 0, z1: 0, valid: false };
  }

  /* ==================================================================== */
  /* static rebuilds — network + building sources                         */
  /* ==================================================================== */

  /** Rasterise the road network into an accessibility field. */
  rebuildRoads(world, roadsApi) {
    const g = this.grid;
    this.roadDens.fill(0);
    this.segCells = new Map();
    let laneKm = 0;
    const CLASS_W = { alley: 0.35, lane2: 1.0, lane4: 1.9, boulevard: 2.4, highway: 2.2 };
    for (const s of world.roads.segments.values()) {
      const w = CLASS_W[s.class] ?? 1;
      const len = s.length || 0;
      const lanes = s.lanes || (s.class === 'alley' ? 1 : s.class === 'lane2' ? 2 : 4);
      laneKm += (len * lanes) / 1000;
      const n = Math.max(2, Math.ceil(len / (g.cellSize * 0.5)));
      const cells = [];
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const p = samplePoint(s, t, roadsApi);
        if (!p) continue;
        const idx = g.index(p[0], p[2]);
        this.roadDens[idx] += w * (len / n) * 0.02;
        if (cells[cells.length - 1] !== idx) cells.push(idx);
      }
      this.segCells.set(s.id, cells);
    }
    this.laneKm = laneKm;
    // accessibility is road density spread to a walking radius, then compressed
    this.access.set(this.roadDens);
    this.grid.blur(this.access, 2, 2);
    const max = this.grid.max(this.access) || 1;
    for (let i = 0; i < this.access.length; i++) {
      this.access[i] = clamp01(Math.sqrt(this.access[i] / max) * 1.15);
    }
    return { laneKm, segments: world.roads.segments.size };
  }

  /** Accumulate per-cell building sources. Called on a rebuild, not per tick. */
  rebuildBuildings(pop) {
    const g = this.grid;
    this.pop.fill(0); this.jobs.fill(0); this.indJobs.fill(0);
    this.pollSrc.fill(0); this.parks.fill(0); this.built.fill(0);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < pop.nb; i++) {
      const c = pop.bCell[i];
      this.built[c] = 1;
      const x = pop.bX[i], z = pop.bZ[i];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
      const cls = pop.bClass[i];
      if (cls === CLASS.RES) this.pop[c] += pop.bCap[i];
      else this.jobs[c] += pop.bJobs[i];
      if (cls === CLASS.IND) {
        this.indJobs[c] += pop.bJobs[i];
        this.pollSrc[c] += pop.bArea[i] * 0.0016;
      } else if (cls === CLASS.RETAIL) {
        this.parks[c] += pop.bArea[i] * 0.00012;      // street life counts as amenity
      }
    }
    this._bbox = Number.isFinite(x0)
      ? { x0, z0, x1, z1, valid: true } : { x0: -200, z0: -200, x1: 200, z1: 200, valid: false };
    /*
     * "The city" is a distance, not a blur.
     *
     * A box-blurred building mask either leaves each plot as its own island
     * (reads as confetti) or, opened up enough to join them, leaks a hundred
     * metres of field into open country — and once the road mask is added, all
     * the way down the highway into the hills. So: exact chamfer distance to the
     * nearest building, full weight within 48 m, gone by 132 m. Streets inside
     * that envelope count; the highway crossing empty land does not.
     */
    const bmask = this._bmask || (this._bmask = new Uint8Array(g.n));
    for (let i = 0; i < g.n; i++) bmask[i] = this.built[i] > 0 ? 1 : 0;
    const dist = chamferDistance(bmask, g.w, g.h, g.cellSize, this._bdist
      || (this._bdist = new Float32Array(g.n)));
    for (let i = 0; i < g.n; i++) {
      const near = 1 - smoothstep(40, 108, dist[i]);
      this.built[i] = clamp01(near * (0.55 + 0.65 * clamp01(this.roadDens[i] * 2.4) + 0.45 * (dist[i] < 40 ? 1 : 0)));
    }
    g.blur(this.built, 1, 1);
    // service demand = housing capacity smeared to a catchment
    this.demandField.set(this.pop);
    g.blur(this.demandField, 1, 1);
    return this._bbox;
  }

  bbox() { return this._bbox; }

  /**
   * Place service installations deterministically: each kind is sited where the
   * unserved population is densest, at a road-accessible cell, until either the
   * whole population is covered or the plan hits `maxPer` sites for that kind.
   * The result is data — positions, radii, capacities and monthly upkeep — and
   * it is what the budget's service line is actually made of.
   */
  planServices(pop, { maxPer = 8, budgetCap = Infinity } = {}) {
    const g = this.grid;
    this.installations.length = 0;
    // demand field = residents, smeared to a service catchment
    this.demandField.set(this.pop);
    g.blur(this.demandField, 1, 1);
    const totalPeople = Math.max(1, pop.count || pop.capTotal);

    // how much ground the city actually occupies, so a small dense city gets one
    // school and a sprawling one gets four even at the same population
    let builtCells = 0;
    for (let c = 0; c < g.n; c++) if (this.built[c] > 0.05) builtCells++;
    const builtArea = builtCells * g.cellSize * g.cellSize;

    let spend = 0;
    for (let k = 0; k < SERVICES.length; k++) {
      const kind = SERVICES[k];
      const spec = SERVICE_SPEC[kind];
      const byPeople = Math.ceil(totalPeople / spec.capacity);
      const byArea = Math.ceil(builtArea / (Math.PI * spec.radius * spec.radius) * 1.6);
      const n = Math.max(1, Math.min(maxPer, Math.max(byPeople, byArea)));
      const claimed = new Float32Array(g.n);
      for (let s = 0; s < n; s++) {
        if (spend + spec.build > budgetCap) break;
        let best = -1, bestScore = -1;
        for (let c = 0; c < g.n; c++) {
          const unserved = this.demandField[c] * (1 - clamp01(claimed[c]));
          if (unserved <= 0) continue;
          // utilities want to sit off the high street; social services on it
          const acc = this.access[c];
          const wantAccess = (kind === 'power' || kind === 'waste' || kind === 'water')
            ? 0.35 + 0.3 * acc : 0.25 + 0.9 * acc;
          const score = unserved * wantAccess;
          if (score > bestScore) { bestScore = score; best = c; }
        }
        if (best < 0 || bestScore <= 0) break;
        const i = best % g.w, j = (best / g.w) | 0;
        const x = g.cx(i), z = g.cz(j);
        this.installations.push({
          kind, k, x, z, radius: spec.radius, capacity: spec.capacity,
          upkeep: Math.round(spec.upkeep * UPKEEP_SCALE), build: spec.build,
          pollution: spec.pollution, on: true,
        });
        spend += spec.build;
        g.splatDisc(claimed, x, z, spec.radius, 1, 2);
      }
    }
    for (let k = 0; k < SERVICES.length; k++) this.stepCoverage(k, 1);
    for (let k = 0; k < SERVICES.length; k++) this.stepCoverage(k, 1);
    return { installations: this.installations.length, capital: spend };
  }

  /* ==================================================================== */
  /* per-tick phases                                                      */
  /* ==================================================================== */

  /**
   * Splat live congestion from the traffic module's per-segment index.
   * `bySegment` is `{segmentId: 0..1}` — cheap, exact, and it costs nothing
   * like the per-cell `congestionAt()` raycast would.
   */
  updateCongestion(trafficStat, congestionAt) {
    const f = this.congestion;
    f.fill(0);
    const by = trafficStat && trafficStat.bySegment;
    if (by && this.segCells) {
      let any = false;
      for (const key in by) {
        const cells = this.segCells.get(+key);
        if (!cells) continue;
        const v = by[key];
        for (let i = 0; i < cells.length; i++) if (v > f[cells[i]]) f[cells[i]] = v;
        any = true;
      }
      if (any) { this.grid.blur(f, 1, 1); return true; }
    }
    if (typeof congestionAt === 'function') {
      // sparse fallback: 1 in 4 cells, still ~1000 calls — only used when the
      // traffic module publishes no per-segment breakdown
      const g = this.grid;
      for (let j = 0; j < g.h; j += 2) {
        for (let i = 0; i < g.w; i += 2) {
          const c = j * g.w + i;
          if (this.roadDens[c] <= 0) continue;
          const v = congestionAt(g.cx(i), g.cz(j)) || 0;
          f[c] = v; f[c + 1] = v;
          if (j + 1 < g.h) { f[c + g.w] = v; f[c + g.w + 1] = v; }
        }
      }
      this.grid.blur(f, 1, 1);
      return true;
    }
    return false;
  }

  stepPollution(trafficIndex) {
    const g = this.grid;
    const p = this.pollution;
    for (let i = 0; i < p.length; i++) {
      p[i] += this.pollSrc[i] * 0.10
        + this.congestion[i] * this.roadDens[i] * 0.0035 * (0.4 + trafficIndex)
        - p[i] * 0.055;
      if (p[i] < 0) p[i] = 0;
    }
    for (const inst of this.installations) {
      if (!inst.on || inst.pollution <= 0) continue;
      g.splatDisc(p, inst.x, inst.z, inst.radius * 0.28, inst.pollution * 0.06, 2);
    }
    g.diffuseWind(p, 0.20, this.wind[0], this.wind[1], 0.992);
  }

  stepAmenity(waterMask) {
    const g = this.grid;
    const a = this.amenity;
    a.set(this.parks);
    g.blur(a, 2, 1);
    const maxP = g.max(a) || 1;
    for (let i = 0; i < a.length; i++) {
      let v = clamp01(a[i] / maxP) * 0.55;
      if (waterMask) v += waterMask[i] * 0.30;
      v += (1 - clamp01(this.pop[i] / 240)) * 0.10;   // breathing room
      a[i] = clamp01(v + 0.18);
    }
    g.blur(a, 1, 1);
  }

  /**
   * Coverage for service kind `k`.
   *
   * Two disc walks per installation: the first measures the population actually
   * inside its catchment, the second paints `min(1, capacity/load)` — so a plant
   * that is big enough for its catchment gives full coverage at its centre and
   * tapers to nothing at its edge, and two overlapping plants add up. This is
   * why "coverage" here is a real supply/demand ratio and not a painted disc.
   *
   * `occupancy` scales the housing-capacity population field down to the people
   * who are actually living there.
   */
  stepCoverage(k, occupancy = 1) {
    const g = this.grid, w = g.w, h = g.h, cs = g.cellSize;
    const sup = this.supply[k];
    sup.fill(0);
    for (let n = 0; n < this.installations.length; n++) {
      const inst = this.installations[n];
      if (inst.k !== k || !inst.on) continue;
      const r = inst.radius, r2 = r * r, inv = 1 / r2;
      const rc = Math.max(1, Math.ceil(r / cs));
      const ci = g.ix(inst.x), cj = g.iz(inst.z);
      const j0 = Math.max(0, cj - rc), j1 = Math.min(h - 1, cj + rc);
      const i0 = Math.max(0, ci - rc), i1 = Math.min(w - 1, ci + rc);
      let load = 0;
      for (let j = j0; j <= j1; j++) {
        const dz = g.cz(j) - inst.z, row = j * w;
        for (let i = i0; i <= i1; i++) {
          const dx = g.cx(i) - inst.x;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r2) continue;
          let a = 1 - d2 * inv; a *= a;
          load += this.demandField[row + i] * a;
        }
      }
      load *= occupancy;
      inst.load = load;
      const quality = load <= 1 ? 1 : clamp01(inst.capacity / load);
      inst.quality = quality;
      for (let j = j0; j <= j1; j++) {
        const dz = g.cz(j) - inst.z, row = j * w;
        for (let i = i0; i <= i1; i++) {
          const dx = g.cx(i) - inst.x;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r2) continue;
          let a = 1 - d2 * inv; a *= a;
          sup[row + i] += quality * a;
        }
      }
    }
    const cov = this.coverage[k];
    let sum = 0, n = 0;
    for (let i = 0; i < cov.length; i++) {
      cov[i] = cov[i] * 0.55 + clamp01(sup[i]) * 0.45;   // smoothed, never flickers
      if (this.built[i] > 0.05) { sum += cov[i]; n++; }
    }
    this._cover[k] = n ? sum / n : 0;
  }

  stepService() {
    const s = this.service;
    const w = [0.16, 0.16, 0.12, 0.16, 0.14, 0.13, 0.13];   // sums to 1
    for (let i = 0; i < s.length; i++) {
      let v = 0;
      for (let k = 0; k < this.coverage.length; k++) v += this.coverage[k][i] * w[k];
      s[i] = v;
    }
  }

  stepLandValue(centre, radius) {
    const g = this.grid;
    const lv = this.landValue;
    const cx = centre ? centre[0] : 0, cz = centre ? centre[1] : 0;
    const r = Math.max(80, radius || 400);
    for (let j = 0; j < g.h; j++) {
      const z = g.cz(j);
      for (let i = 0; i < g.w; i++) {
        const c = j * g.w + i;
        const x = g.cx(i);
        const d = Math.hypot(x - cx, z - cz);
        const centrality = 1 - smoothstep(r * 0.15, r * 1.35, d);
        const ind = clamp01(this.indJobs[c] / 160);
        let v = LV.base
          + LV.access * this.access[c]
          + LV.amenity * this.amenity[c]
          + LV.service * this.service[c]
          + LV.centrality * centrality
          + LV.pollution * clamp01(this.pollution[c] * 1.6)
          + LV.congestion * this.congestion[c]
          + LV.industry * ind;
        lv[c] = lv[c] * 0.75 + clamp01(v) * 0.25;
      }
    }
    g.blur(lv, 1, 1);
    let sum = 0, n = 0, max = 0;
    for (let i = 0; i < lv.length; i++) {
      if (this.built[i] <= 0.05) continue;
      sum += lv[i]; n++;
      if (lv[i] > max) max = lv[i];
    }
    this.stats.landValueMean = n ? sum / n : 0;
    this.stats.landValueMax = max;
    let ps = 0, pn = 0;
    for (let i = 0; i < this.pollution.length; i++) {
      if (this.built[i] <= 0.05) continue;
      ps += clamp01(this.pollution[i] * 1.6); pn++;
    }
    this.stats.pollutionMean = pn ? ps / pn : 0;
    let cs = 0;
    for (let k = 0; k < this._cover.length; k++) cs += this._cover[k];
    this.stats.coverageMean = cs / this._cover.length;
  }

  /**
   * Where does each zone class want to grow?
   * Pressure is the product of the city-wide demand for that class and the
   * local suitability of the ground — so a high global demand still cannot
   * push growth into a polluted, unserviced, inaccessible corner.
   */
  stepPressure(demand, pop) {
    const g = this.grid;
    const pr = this.pressureR, pc = this.pressureC, pi = this.pressureI;
    const vacancyR = pop.capTotal ? clamp01(1 - pop.count / pop.capTotal) : 0;
    for (let c = 0; c < g.n; c++) {
      const acc = this.access[c];
      if (acc < 0.06) { pr[c] = pc[c] = pi[c] = 0; continue; }
      const lv = this.landValue[c];
      const svc = this.service[c];
      const poll = clamp01(this.pollution[c] * 1.6);
      const near = clamp01(this.built[c] * 0.7 + acc * 0.6);
      const jobsNear = clamp01(this.jobs[c] / 120);
      const popNear = clamp01(this.pop[c] / 180);

      const sR = clamp01(0.25 + 0.45 * acc + 0.42 * this.amenity[c] + 0.35 * svc
        - 0.85 * poll - 0.35 * this.congestion[c] - 0.35 * vacancyR + 0.20 * jobsNear);
      const sC = clamp01(0.18 + 0.72 * acc + 0.50 * popNear + 0.30 * lv
        - 0.35 * poll - 0.20 * this.congestion[c]);
      const sI = clamp01(0.16 + 0.55 * acc + 0.42 * poll + 0.30 * (1 - lv)
        - 0.55 * this.amenity[c] - 0.30 * popNear);

      pr[c] = clamp01(demand.r * sR * near);
      pc[c] = clamp01(demand.c * sC * near);
      pi[c] = clamp01(demand.i * sI * near);
    }
  }

  /**
   * The n hottest growth sites per zone, for consumers that want a short list
   * rather than the whole field. Allocation-free top-k with an explicit minimum
   * — a comparator sort per candidate cell was measurably the most expensive
   * thing in the whole hourly step, so it is not used here.
   */
  topPressure(n = 12) {
    const g = this.grid;
    const K = Math.max(1, Math.min(64, n));
    const vals = this._topV || (this._topV = new Float32Array(64));
    const idx = this._topI || (this._topI = new Int32Array(64));
    const out = [];
    const zones = ['r', 'c', 'i'];
    const fields = [this.pressureR, this.pressureC, this.pressureI];
    for (let zi = 0; zi < 3; zi++) {
      const f = fields[zi];
      let count = 0, minSlot = 0, minVal = 0;
      for (let c = 0; c < g.n; c++) {
        const v = f[c];
        if (v < 0.08) continue;
        if (count < K) {
          vals[count] = v; idx[count] = c; count++;
          if (count === K) {
            minVal = vals[0]; minSlot = 0;
            for (let s = 1; s < K; s++) if (vals[s] < minVal) { minVal = vals[s]; minSlot = s; }
          }
        } else if (v > minVal) {
          vals[minSlot] = v; idx[minSlot] = c;
          minVal = vals[0]; minSlot = 0;
          for (let s = 1; s < K; s++) if (vals[s] < minVal) { minVal = vals[s]; minSlot = s; }
        }
      }
      for (let s = 0; s < count; s++) {
        const c = idx[s];
        out.push({
          zone: zones[zi],
          x: +g.cx(c % g.w).toFixed(1), z: +g.cz((c / g.w) | 0).toFixed(1),
          p: +vals[s].toFixed(3),
        });
      }
    }
    out.sort((a, b) => b.p - a.p);
    return out;
  }

  coverageMeans() {
    const o = {};
    for (let k = 0; k < SERVICES.length; k++) o[SERVICES[k]] = +this._cover[k].toFixed(3);
    return o;
  }
}

/** Sample a road segment at parameter t, preferring the roads module's own curve. */
function samplePoint(s, t, roadsApi) {
  if (roadsApi && typeof roadsApi.pointAt === 'function') {
    try {
      const p = roadsApi.pointAt(s.id, t);
      if (p) return Array.isArray(p) ? p : [p.x, p.y ?? 0, p.z];
    } catch { /* fall through */ }
  }
  const c = s.curve;
  if (c && c.length === 4) {
    const u = 1 - t;
    const x = u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0];
    const z = u * u * u * c[0][2] + 3 * u * u * t * c[1][2] + 3 * u * t * t * c[2][2] + t * t * t * c[3][2];
    return [x, 0, z];
  }
  return null;
}

export default Fields;
