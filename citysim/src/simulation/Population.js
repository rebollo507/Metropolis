/**
 * Population, households and the job market.
 *
 * Everything is a typed array. There is no object per citizen anywhere, and the
 * hot path never allocates: growth happens by writing into a preallocated slot
 * taken from a free-list, and capacity doubles only when the free-list runs dry
 * (which is a rare, off-peak event, not a per-tick one).
 *
 * The per-tick cost is bounded by `stepSlice(n)`: it visits n citizens, ages
 * them lazily (age is derived from `birthDay`, so nothing has to be swept), runs
 * their state transitions and lets the unemployed look for work. A full pass
 * over the city therefore costs O(pop) *per pass*, never per tick.
 */

import {
  CLASS, STATE, EDU, WORK_AGE_MIN, WORK_AGE_MAX, SCHOOL_AGE_MIN,
  EFFICIENCY, AREA_PER_RESIDENT, AREA_PER_JOB,
  BIRTH_RATE_DAY, DEATH_BASE_DAY, DEATH_AGE_K,
  COMMUTE_SPEED_MPS, COMMUTE_CONGESTION_K, COMMUTE_FIXED_MIN, COMMUTE_DETOUR, clamp,
} from './constants.js';

const DAYS_PER_YEAR = 365;

/** Map a building record from `world.buildings` onto a simulation class. */
export function classifyBuilding(b) {
  const kind = b.kind || '';
  if (kind === 'civic') return CLASS.CIVIC;
  const z = typeof b.zone === 'number' ? b.zone : -1;
  if (z === 0) return CLASS.RES;
  if (z === 1) return CLASS.OFFICE;
  if (z === 2) return CLASS.RETAIL;
  if (z === 3) return CLASS.IND;
  // fall back on the kind when a building predates the occ tag
  if (kind === 'house' || kind === 'rowhouse' || kind === 'midrise') return CLASS.RES;
  if (kind === 'warehouse') return CLASS.IND;
  if (kind === 'retail') return CLASS.RETAIL;
  if (kind === 'tower' || kind === 'podium') return CLASS.OFFICE;
  return CLASS.RES;
}

export class Population {
  constructor(rng, grid) {
    this.rng = rng;
    this.grid = grid;

    /* ---- buildings (slot arrays, rebuilt whenever the city changes) ---- */
    this.nb = 0;
    this.bId = new Int32Array(0);
    this.bX = new Float32Array(0);
    this.bZ = new Float32Array(0);
    this.bClass = new Uint8Array(0);
    this.bCap = new Uint16Array(0);      // resident capacity
    this.bJobs = new Uint16Array(0);     // job capacity
    this.bOcc = new Uint16Array(0);      // residents living here
    this.bFill = new Uint16Array(0);     // jobs filled
    this.bArea = new Float32Array(0);    // usable floor area, m²
    this.bCell = new Int32Array(0);
    this.bSkill = new Uint8Array(0);     // education level the job wants
    this.slotOfId = new Map();

    /* homes and workplaces bucketed by cell, CSR style */
    this.homeCellStart = new Int32Array(0);
    this.homeCellList = new Int32Array(0);
    this.jobCellStart = new Int32Array(0);
    this.jobCellList = new Int32Array(0);

    /* ---- citizens ---- */
    this.cap = 0;
    this.count = 0;
    this.birthDay = new Int32Array(0);
    this.lastDay = new Int32Array(0);
    this.edu = new Uint8Array(0);
    this.state = new Uint8Array(0);
    this.coh = new Uint8Array(0);        // cached age cohort, refreshed on visit
    this.home = new Int32Array(0);
    this.work = new Int32Array(0);
    this.hh = new Int32Array(0);
    this.commute = new Float32Array(0);   // minutes, one way
    this.alive = new Uint8Array(0);
    this.hhNext = new Int32Array(0);
    this.free = new Int32Array(0);
    this.nFree = 0;

    /* ---- households ---- */
    this.hcap = 0;
    this.hcount = 0;
    this.hhHome = new Int32Array(0);
    this.hhSize = new Uint8Array(0);
    this.hhFirst = new Int32Array(0);
    this.hhAlive = new Uint8Array(0);
    this.hhIncome = new Float32Array(0);
    this.hFree = new Int32Array(0);
    this.nHFree = 0;

    /* ---- aggregates, maintained incrementally ---- */
    this.byState = new Int32Array(5);
    this.byCohort = new Int32Array(6);
    this.byEdu = new Int32Array(4);
    this.employed = 0;
    this.workforce = 0;
    this.jobsTotal = 0;
    this.jobsFilled = 0;
    this.capTotal = 0;
    this.commuteSum = 0;
    this.commuteN = 0;
    this.freeJobs = 0;
    this.deaths = 0; this.births = 0; this.movedIn = 0; this.movedOut = 0;

    this._cursor = 0;
    this._ringOrder = null;
  }

  /* ==================================================================== */
  /* buildings                                                            */
  /* ==================================================================== */

  /**
   * Rebuild the building slot arrays from `world.buildings`.
   * Existing citizens keep their home/work if the building still exists,
   * otherwise they are re-housed (or leave) on their next slice visit.
   */
  setBuildings(buildings) {
    const list = [];
    for (const b of buildings.values()) list.push(b);
    // deterministic order: by id
    list.sort((a, c) => a.id - c.id);

    const n = list.length;
    this.nb = n;
    this.bId = new Int32Array(n);
    this.bX = new Float32Array(n);
    this.bZ = new Float32Array(n);
    this.bClass = new Uint8Array(n);
    this.bCap = new Uint16Array(n);
    this.bJobs = new Uint16Array(n);
    this.bOcc = new Uint16Array(n);
    this.bFill = new Uint16Array(n);
    this.bArea = new Float32Array(n);
    this.bCell = new Int32Array(n);
    this.bSkill = new Uint8Array(n);
    const oldSlotOf = this.slotOfId;
    this.slotOfId = new Map();

    this.capTotal = 0; this.jobsTotal = 0;
    for (let i = 0; i < n; i++) {
      const b = list[i];
      const fp = b.footprint || [10, 10];
      const levels = Math.max(1, b.levels | 0 || 1);
      const area = Math.max(12, fp[0] * fp[1]) * levels * EFFICIENCY;
      const cls = classifyBuilding(b);
      const pos = b.pos || [0, 0, 0];
      this.bId[i] = b.id;
      this.bX[i] = pos[0]; this.bZ[i] = pos[2];
      this.bClass[i] = cls;
      this.bArea[i] = area;
      this.bCell[i] = this.grid.index(pos[0], pos[2]);
      this.slotOfId.set(b.id, i);

      if (cls === CLASS.RES) {
        const band = levels >= 6 ? 'high' : levels >= 3 ? 'mid' : 'low';
        this.bCap[i] = Math.min(65535, Math.max(1, Math.round(area / AREA_PER_RESIDENT[band])));
        this.capTotal += this.bCap[i];
      } else {
        const key = cls === CLASS.OFFICE ? 'office' : cls === CLASS.RETAIL ? 'retail'
          : cls === CLASS.IND ? 'ind' : 'civic';
        this.bJobs[i] = Math.min(65535, Math.max(1, Math.round(area / AREA_PER_JOB[key])));
        this.jobsTotal += this.bJobs[i];
        this.bSkill[i] = cls === CLASS.OFFICE ? EDU.COLLEGE : cls === CLASS.CIVIC ? EDU.HIGH
          : cls === CLASS.IND ? EDU.SCHOOL : EDU.HIGH;
      }
    }

    this._buildCellBuckets();
    this._remapCitizens(oldSlotOf);
    this.freeJobs = this.jobsTotal - this.jobsFilled;
    return { buildings: n, capacity: this.capTotal, jobs: this.jobsTotal };
  }

  _buildCellBuckets() {
    const nc = this.grid.n;
    const hCount = new Int32Array(nc + 1);
    const jCount = new Int32Array(nc + 1);
    for (let i = 0; i < this.nb; i++) {
      const c = this.bCell[i];
      if (this.bCap[i] > 0) hCount[c + 1]++;
      if (this.bJobs[i] > 0) jCount[c + 1]++;
    }
    for (let c = 0; c < nc; c++) { hCount[c + 1] += hCount[c]; jCount[c + 1] += jCount[c]; }
    this.homeCellStart = hCount;
    this.jobCellStart = jCount;
    this.homeCellList = new Int32Array(hCount[nc]);
    this.jobCellList = new Int32Array(jCount[nc]);
    const hCur = Int32Array.from(hCount.subarray(0, nc));
    const jCur = Int32Array.from(jCount.subarray(0, nc));
    for (let i = 0; i < this.nb; i++) {
      const c = this.bCell[i];
      if (this.bCap[i] > 0) this.homeCellList[hCur[c]++] = i;
      if (this.bJobs[i] > 0) this.jobCellList[jCur[c]++] = i;
    }
  }

  /** After a rebuild, translate citizen home/work slots and recount occupancy. */
  _remapCitizens(oldSlotOf) {
    if (!this.count) return;
    const idOfOldSlot = new Map();
    for (const [id, slot] of oldSlotOf) idOfOldSlot.set(slot, id);
    this.jobsFilled = 0;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const oh = this.home[i], ow = this.work[i];
      this.home[i] = oh >= 0 ? (this.slotOfId.get(idOfOldSlot.get(oh)) ?? -1) : -1;
      this.work[i] = ow >= 0 ? (this.slotOfId.get(idOfOldSlot.get(ow)) ?? -1) : -1;
      if (this.home[i] >= 0) this.bOcc[this.home[i]]++;
      if (this.work[i] >= 0) {
        if (this.bFill[this.work[i]] < this.bJobs[this.work[i]]) {
          this.bFill[this.work[i]]++; this.jobsFilled++;
        } else { this.work[i] = -1; }
      }
      if (this.work[i] < 0 && this.state[i] === STATE.EMPLOYED) {
        this.state[i] = STATE.UNEMPLOYED;
        this.byState[STATE.EMPLOYED]--; this.byState[STATE.UNEMPLOYED]++;
        this.employed--;
      }
    }
    for (let h = 0; h < this.hcap; h++) {
      if (!this.hhAlive[h]) continue;
      const oh = this.hhHome[h];
      this.hhHome[h] = oh >= 0 ? (this.slotOfId.get(idOfOldSlot.get(oh)) ?? -1) : -1;
    }
  }

  /* ==================================================================== */
  /* storage                                                              */
  /* ==================================================================== */

  _growCitizens(need) {
    let cap = Math.max(1024, this.cap);
    while (cap < need) cap *= 2;
    if (cap === this.cap) return;
    const g = (Ctor, old) => { const a = new Ctor(cap); a.set(old); return a; };
    this.birthDay = g(Int32Array, this.birthDay);
    this.lastDay = g(Int32Array, this.lastDay);
    this.edu = g(Uint8Array, this.edu);
    this.state = g(Uint8Array, this.state);
    this.coh = g(Uint8Array, this.coh);
    this.home = g(Int32Array, this.home);
    this.work = g(Int32Array, this.work);
    this.hh = g(Int32Array, this.hh);
    this.commute = g(Float32Array, this.commute);
    this.alive = g(Uint8Array, this.alive);
    this.hhNext = g(Int32Array, this.hhNext);
    const nf = new Int32Array(cap); nf.set(this.free.subarray(0, this.nFree));
    this.free = nf;
    for (let i = cap - 1; i >= this.cap; i--) this.free[this.nFree++] = i;
    this.cap = cap;
  }

  _growHouseholds(need) {
    let cap = Math.max(512, this.hcap);
    while (cap < need) cap *= 2;
    if (cap === this.hcap) return;
    const g = (Ctor, old) => { const a = new Ctor(cap); a.set(old); return a; };
    this.hhHome = g(Int32Array, this.hhHome);
    this.hhSize = g(Uint8Array, this.hhSize);
    this.hhFirst = g(Int32Array, this.hhFirst);
    this.hhAlive = g(Uint8Array, this.hhAlive);
    this.hhIncome = g(Float32Array, this.hhIncome);
    const nf = new Int32Array(cap); nf.set(this.hFree.subarray(0, this.nHFree));
    this.hFree = nf;
    for (let i = cap - 1; i >= this.hcap; i--) this.hFree[this.nHFree++] = i;
    this.hcap = cap;
  }

  _allocCitizen() {
    if (this.nFree === 0) this._growCitizens(this.cap + 1);
    return this.free[--this.nFree];
  }
  _allocHousehold() {
    if (this.nHFree === 0) this._growHouseholds(this.hcap + 1);
    return this.hFree[--this.nHFree];
  }

  /* ==================================================================== */
  /* demography helpers                                                   */
  /* ==================================================================== */

  ageOf(i, day) { return (day - this.birthDay[i]) / DAYS_PER_YEAR; }

  cohortOf(age) {
    return age < 15 ? 0 : age < 20 ? 1 : age < 35 ? 2 : age < 55 ? 3 : age < 65 ? 4 : 5;
  }

  _setState(i, s) {
    const old = this.state[i];
    if (old === s) return;
    this.byState[old]--; this.byState[s]++;
    if (old === STATE.EMPLOYED) this.employed--;
    if (s === STATE.EMPLOYED) this.employed++;
    const wasWF = old === STATE.EMPLOYED || old === STATE.UNEMPLOYED;
    const isWF = s === STATE.EMPLOYED || s === STATE.UNEMPLOYED;
    if (wasWF && !isWF) this.workforce--;
    if (!wasWF && isWF) this.workforce++;
    this.state[i] = s;
  }

  /* ==================================================================== */
  /* creation                                                             */
  /* ==================================================================== */

  /** Pick a home with spare capacity, preferring higher land value. */
  _pickHome(valueField) {
    const n = this.nb;
    if (!n) return -1;
    // Reservoir-ish weighted scan over a bounded random sample: O(TRIES), not O(n).
    const TRIES = 24;
    let best = -1, bestScore = -1;
    for (let t = 0; t < TRIES; t++) {
      const s = (this.rng.next() * n) | 0;
      if (this.bCap[s] === 0 || this.bOcc[s] >= this.bCap[s]) continue;
      const v = valueField ? valueField[this.bCell[s]] : 0.5;
      const score = (0.35 + v) * (0.6 + this.rng.next() * 0.8);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (best >= 0) return best;
    // linear fallback so a nearly-full city still houses people deterministically
    const start = (this.rng.next() * n) | 0;
    for (let k = 0; k < n; k++) {
      const s = (start + k) % n;
      if (this.bCap[s] > 0 && this.bOcc[s] < this.bCap[s]) return s;
    }
    return -1;
  }

  /** Create one household of `size` citizens in `homeSlot`. */
  addHousehold(homeSlot, day, valueField) {
    if (homeSlot < 0) homeSlot = this._pickHome(valueField);
    if (homeSlot < 0) return -1;
    const roomLeft = this.bCap[homeSlot] - this.bOcc[homeSlot];
    if (roomLeft <= 0) return -1;
    const rng = this.rng;
    let size = 1 + (rng.next() < 0.62 ? 1 : 0) + (rng.next() < 0.34 ? 1 : 0) + (rng.next() < 0.16 ? 1 : 0);
    size = Math.min(size, roomLeft);

    const h = this._allocHousehold();
    this.hhAlive[h] = 1; this.hhHome[h] = homeSlot; this.hhSize[h] = 0;
    this.hhFirst[h] = -1; this.hhIncome[h] = 0;
    this.hcount++;

    // two adults of similar age, then children
    const adultAge = 22 + rng.next() * 42;
    for (let k = 0; k < size; k++) {
      let age;
      if (k === 0) age = adultAge;
      else if (k === 1) age = clamp(adultAge + rng.gauss(0, 4), 20, 78);
      else age = rng.next() * Math.min(18, Math.max(1, adultAge - 20));
      this._makeCitizen(age, homeSlot, h, day);
    }
    return h;
  }

  _makeCitizen(age, homeSlot, hhIdx, day) {
    const i = this._allocCitizen();
    const rng = this.rng;
    this.alive[i] = 1;
    this.birthDay[i] = day - Math.round(age * DAYS_PER_YEAR);
    this.lastDay[i] = day;
    this.home[i] = homeSlot;
    this.work[i] = -1;
    this.hh[i] = hhIdx;
    this.commute[i] = 0;
    // education: sampled once, refined when the citizen finishes school
    const r = rng.next();
    this.edu[i] = age < SCHOOL_AGE_MIN ? EDU.NONE
      : age < 18 ? EDU.SCHOOL
        : r < 0.22 ? EDU.SCHOOL : r < 0.66 ? EDU.HIGH : EDU.COLLEGE;
    this.byEdu[this.edu[i]]++;
    const st = age < SCHOOL_AGE_MIN ? STATE.CHILD
      : age < 18 ? STATE.STUDENT
        : age >= WORK_AGE_MAX ? STATE.RETIRED : STATE.UNEMPLOYED;
    this.state[i] = st; this.byState[st]++;
    if (st === STATE.EMPLOYED || st === STATE.UNEMPLOYED) this.workforce++;
    this.coh[i] = this.cohortOf(age);
    this.byCohort[this.coh[i]]++;
    this.count++;
    if (homeSlot >= 0) this.bOcc[homeSlot]++;
    if (hhIdx >= 0) {
      this.hhNext[i] = this.hhFirst[hhIdx];
      this.hhFirst[hhIdx] = i;
      this.hhSize[hhIdx]++;
    } else this.hhNext[i] = -1;
    return i;
  }

  _removeCitizen(i, day) {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    const st = this.state[i];
    this.byState[st]--;
    if (st === STATE.EMPLOYED) this.employed--;
    if (st === STATE.EMPLOYED || st === STATE.UNEMPLOYED) this.workforce--;
    this.byCohort[this.coh[i]]--;
    this.byEdu[this.edu[i]]--;
    void day;
    if (this.home[i] >= 0) this.bOcc[this.home[i]]--;
    if (this.work[i] >= 0) { this.bFill[this.work[i]]--; this.jobsFilled--; }
    const h = this.hh[i];
    if (h >= 0 && this.hhAlive[h]) {
      // unlink from the household list
      let p = this.hhFirst[h];
      if (p === i) this.hhFirst[h] = this.hhNext[i];
      else {
        while (p >= 0 && this.hhNext[p] !== i) p = this.hhNext[p];
        if (p >= 0) this.hhNext[p] = this.hhNext[i];
      }
      if (--this.hhSize[h] === 0) {
        this.hhAlive[h] = 0; this.hcount--;
        this.hFree[this.nHFree++] = h;
      }
    }
    this.home[i] = -1; this.work[i] = -1; this.hh[i] = -1;
    this.count--;
    this.free[this.nFree++] = i;
  }

  /* ==================================================================== */
  /* the job market                                                       */
  /* ==================================================================== */

  /**
   * Find a workplace near `home` with a free job the citizen is plausibly
   * qualified for. Rings outward from the home cell; bounded by `maxRing`.
   */
  findJob(citizen, maxRing = 7) {
    if (this.freeJobs <= 0) return -1;
    const homeSlot = this.home[citizen];
    if (homeSlot < 0) return -1;
    const g = this.grid, w = g.w, h = g.h;
    const c = this.bCell[homeSlot];
    const ci = c % w, cj = (c / w) | 0;
    const skill = this.edu[citizen];
    let best = -1, bestScore = -1e9;
    for (let ring = 0; ring <= maxRing; ring++) {
      const i0 = ci - ring, i1 = ci + ring, j0 = cj - ring, j1 = cj + ring;
      for (let j = j0; j <= j1; j++) {
        if (j < 0 || j >= h) continue;
        const edgeRow = (j === j0 || j === j1);
        for (let i = i0; i <= i1; i++) {
          if (i < 0 || i >= w) continue;
          if (!edgeRow && i !== i0 && i !== i1) continue;   // ring shell only
          const cell = j * w + i;
          const s0 = this.jobCellStart[cell], s1 = this.jobCellStart[cell + 1];
          for (let k = s0; k < s1; k++) {
            const b = this.jobCellList[k];
            if (this.bFill[b] >= this.bJobs[b]) continue;
            const want = this.bSkill[b];
            // over-qualified is fine, under-qualified is a penalty not a bar
            const fit = skill >= want ? 1 : 0.45 + 0.2 * (skill - want + 2);
            const dx = this.bX[b] - this.bX[homeSlot], dz = this.bZ[b] - this.bZ[homeSlot];
            const dist = Math.sqrt(dx * dx + dz * dz);
            const score = fit * 1000 - dist * 0.9 + this.rng.next() * 60;
            if (score > bestScore) { bestScore = score; best = b; }
          }
        }
      }
      if (best >= 0) break;    // nearest ring that offers anything wins
    }
    return best;
  }

  takeJob(citizen, slot, congestionField) {
    if (slot < 0) return false;
    if (this.bFill[slot] >= this.bJobs[slot]) return false;
    if (this.work[citizen] >= 0) this.leaveJob(citizen);
    this.work[citizen] = slot;
    this.bFill[slot]++; this.jobsFilled++; this.freeJobs--;
    this._setState(citizen, STATE.EMPLOYED);
    this.commute[citizen] = this.commuteMinutes(citizen, congestionField);
    return true;
  }

  leaveJob(citizen) {
    const s = this.work[citizen];
    if (s < 0) return;
    this.bFill[s]--; this.jobsFilled--; this.freeJobs++;
    this.work[citizen] = -1;
    this.commute[citizen] = 0;
  }

  /** One-way commute in minutes, including a congestion penalty on the route. */
  commuteMinutes(i, congestionField) {
    const a = this.home[i], b = this.work[i];
    if (a < 0 || b < 0) return 0;
    const dx = this.bX[b] - this.bX[a], dz = this.bZ[b] - this.bZ[a];
    const d = Math.sqrt(dx * dx + dz * dz) * COMMUTE_DETOUR;
    let cong = 0;
    if (congestionField) {
      const mx = (this.bX[a] + this.bX[b]) * 0.5, mz = (this.bZ[a] + this.bZ[b]) * 0.5;
      cong = this.grid.sample(congestionField, mx, mz);
    }
    const t = (d / COMMUTE_SPEED_MPS) * (1 + COMMUTE_CONGESTION_K * cong) / 60;
    return Math.max(1.5, t + COMMUTE_FIXED_MIN);
  }

  /* ==================================================================== */
  /* the amortised per-tick pass                                          */
  /* ==================================================================== */

  /**
   * Visit `n` citizens. This is the whole per-tick citizen cost.
   * `env` carries the fields and rates the visit needs.
   */
  stepSlice(n, day, env) {
    if (this.cap === 0) return 0;
    const cong = env.congestion || null;
    const hire = env.hiring !== false;
    let visited = 0, guard = 0;
    const cap = this.cap;
    while (visited < n && guard < n * 4) {
      guard++;
      const i = this._cursor;
      this._cursor = this._cursor + 1 >= cap ? 0 : this._cursor + 1;
      if (!this.alive[i]) continue;
      visited++;

      const elapsed = day - this.lastDay[i];
      if (elapsed < 0) { this.lastDay[i] = day; continue; }
      this.lastDay[i] = day;
      const age = this.ageOf(i, day);

      /* --- mortality (hazard integrated over the elapsed days) --- */
      const over = Math.max(0, age - 45);
      const hz = (DEATH_BASE_DAY + DEATH_AGE_K * over * over) * Math.max(1, elapsed) * env.mortality;
      if (this.rng.next() < hz) { this._removeCitizen(i, day); this.deaths++; continue; }

      /* --- keep the cohort histogram honest without ever sweeping --- */
      const nc = this.cohortOf(age);
      if (nc !== this.coh[i]) { this.byCohort[this.coh[i]]--; this.byCohort[nc]++; this.coh[i] = nc; }

      /* --- a citizen whose home was demolished re-houses, or leaves --- */
      if (this.home[i] < 0) {
        const slot = this._pickHome(env.value);
        if (slot >= 0) {
          this.home[i] = slot; this.bOcc[slot]++;
          const hh = this.hh[i];
          if (hh >= 0 && this.hhAlive[hh] && this.hhHome[hh] < 0) this.hhHome[hh] = slot;
        } else { this._removeCitizen(i, day); this.movedOut++; continue; }
      }

      /* --- life-stage transitions --- */
      const st = this.state[i];
      if (st === STATE.CHILD && age >= SCHOOL_AGE_MIN) this._setState(i, STATE.STUDENT);
      else if (st === STATE.STUDENT && age >= 18) {
        // education outcome depends on the school coverage where they live
        const hs = this.home[i];
        const q = (env.eduQuality && hs >= 0) ? this.grid.sample(env.eduQuality, this.bX[hs], this.bZ[hs]) : 0.6;
        const r = this.rng.next();
        this.byEdu[this.edu[i]]--;
        this.edu[i] = r < 0.20 * (1 - q * 0.5) ? EDU.SCHOOL : r < 0.62 + q * 0.10 ? EDU.HIGH : EDU.COLLEGE;
        this.byEdu[this.edu[i]]++;
        this._setState(i, STATE.UNEMPLOYED);
      } else if (age >= WORK_AGE_MAX && st !== STATE.RETIRED) {
        if (this.work[i] >= 0) this.leaveJob(i);
        this._setState(i, STATE.RETIRED);
      }

      /* --- job search / churn --- */
      const s2 = this.state[i];
      if (s2 === STATE.UNEMPLOYED && hire && age >= WORK_AGE_MIN && age < WORK_AGE_MAX) {
        // hiring is frictional: a vacancy has to exist *and* be reached
        if (this.rng.next() < env.hireChance) {
          const slot = this.findJob(i);
          if (slot >= 0) this.takeJob(i, slot, cong);
        }
      } else if (s2 === STATE.EMPLOYED) {
        // refresh the commute estimate; quit if it has become intolerable
        const cm = this.commuteMinutes(i, cong);
        this.commute[i] = cm;
        if (cm > env.commuteQuit && this.rng.next() < 0.06) {
          this.leaveJob(i);
          this._setState(i, STATE.UNEMPLOYED);
        } else if (this.rng.next() < env.churn) {
          this.leaveJob(i);
          this._setState(i, STATE.UNEMPLOYED);
        }
      }

      /* --- births --- */
      if (age >= 20 && age < 42 && env.birthScale > 0) {
        const h = this.hh[i];
        if (h >= 0 && this.hhAlive[h] && this.hhSize[h] < 6) {
          const homeSlot = this.hhHome[h];
          if (homeSlot >= 0 && this.bOcc[homeSlot] < this.bCap[homeSlot]
            && this.rng.next() < BIRTH_RATE_DAY * Math.max(1, elapsed) * env.birthScale) {
            this._makeCitizen(0, homeSlot, h, day);
            this.births++;
          }
        }
      }
    }
    return visited;
  }

  /* ==================================================================== */
  /* migration                                                            */
  /* ==================================================================== */

  /** Move `n` new households in. Returns citizens actually added. */
  immigrate(n, day, valueField) {
    let added = 0, tries = 0;
    while (added < n && tries < n * 3 + 16) {
      tries++;
      const before = this.count;
      const h = this.addHousehold(-1, day, valueField);
      if (h < 0) break;
      added += this.count - before;
    }
    this.movedIn += added;
    return added;
  }

  /** Move `n` citizens out, preferring the jobless. Returns citizens removed. */
  emigrate(n, day) {
    let removed = 0, guard = 0;
    const cap = this.cap;
    if (!cap) return 0;
    let cur = (this.rng.next() * cap) | 0;
    while (removed < n && guard < cap * 2) {
      guard++;
      const i = cur; cur = cur + 1 >= cap ? 0 : cur + 1;
      if (!this.alive[i]) continue;
      const st = this.state[i];
      const p = st === STATE.UNEMPLOYED ? 0.55 : st === STATE.EMPLOYED ? 0.06 : 0.14;
      if (this.rng.next() > p) continue;
      // a whole household leaves together
      const h = this.hh[i];
      if (h >= 0 && this.hhAlive[h]) {
        let m = this.hhFirst[h];
        while (m >= 0 && removed < n + 4) {
          const nx = this.hhNext[m];
          this._removeCitizen(m, day); removed++;
          m = nx;
        }
      } else { this._removeCitizen(i, day); removed++; }
    }
    this.movedOut += removed;
    return removed;
  }

  /* ==================================================================== */
  /* bulk build                                                           */
  /* ==================================================================== */

  /** Fill the housing stock to `fill` occupancy, then run one hiring pass. */
  seed(fill, day, valueField) {
    const target = Math.round(this.capTotal * fill);
    let guard = 0;
    while (this.count < target && guard++ < target * 2 + 64) {
      if (this.addHousehold(-1, day, valueField) < 0) break;
    }
    this.hireAll(null);
    return this.count;
  }

  /** A full hiring pass — used at build time only, never inside a tick. */
  hireAll(congestionField) {
    let hired = 0;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      if (this.state[i] !== STATE.UNEMPLOYED) continue;
      const age = this.ageOf(i, this.lastDay[i]);
      if (age < WORK_AGE_MIN || age >= WORK_AGE_MAX) continue;
      const slot = this.findJob(i);
      if (slot >= 0 && this.takeJob(i, slot, congestionField)) hired++;
      if (this.freeJobs <= 0) break;
    }
    this._recomputeCommuteAgg();
    return hired;
  }

  _recomputeCommuteAgg() {
    let s = 0, k = 0;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i] || this.work[i] < 0) continue;
      s += this.commute[i]; k++;
    }
    this.commuteSum = s; this.commuteN = k;
  }

  /** Mean one-way commute, minutes. Recomputed lazily from a bounded sample. */
  meanCommute(sampleN = 512) {
    if (this.employed === 0) return 0;
    let s = 0, k = 0, guard = 0;
    let cur = this._commuteCursor || 0;
    const cap = this.cap;
    while (k < sampleN && guard < cap) {
      guard++;
      const i = cur; cur = cur + 1 >= cap ? 0 : cur + 1;
      if (!this.alive[i] || this.work[i] < 0) continue;
      s += this.commute[i]; k++;
    }
    this._commuteCursor = cur;
    return k ? s / k : 0;
  }

  /* ==================================================================== */
  /* readouts                                                             */
  /* ==================================================================== */

  vacancy() { return this.capTotal > 0 ? 1 - this.count / this.capTotal : 0; }
  unemployment() { return this.workforce > 0 ? this.byState[STATE.UNEMPLOYED] / this.workforce : 0; }
  jobVacancy() { return this.jobsTotal > 0 ? this.freeJobs / this.jobsTotal : 0; }

  /** Residents of a building, by world building id. */
  residentsOf(id) {
    const s = this.slotOfId.get(id);
    return s === undefined ? 0 : this.bOcc[s];
  }
  jobsOf(id) {
    const s = this.slotOfId.get(id);
    return s === undefined ? 0 : this.bJobs[s];
  }
  filledOf(id) {
    const s = this.slotOfId.get(id);
    return s === undefined ? 0 : this.bFill[s];
  }

  /**
   * Per-class totals. O(buildings), called once an in-game hour — not per tick.
   * Caches onto `jobsByClass` / `filledByClass` / `capByClass` / `occByClass`.
   */
  classTotals() {
    const jobs = this._jc || (this._jc = new Int32Array(5));
    const fill = this._fc || (this._fc = new Int32Array(5));
    const cap = this._cc || (this._cc = new Int32Array(5));
    const occ = this._oc || (this._oc = new Int32Array(5));
    jobs.fill(0); fill.fill(0); cap.fill(0); occ.fill(0);
    for (let i = 0; i < this.nb; i++) {
      const c = this.bClass[i];
      jobs[c] += this.bJobs[i]; fill[c] += this.bFill[i];
      cap[c] += this.bCap[i]; occ[c] += this.bOcc[i];
    }
    this.jobsByClass = jobs; this.filledByClass = fill;
    this.capByClass = cap; this.occByClass = occ;
    return { jobs, fill, cap, occ };
  }

  cohorts() {
    const o = {};
    const names = ['child', 'teen', 'young', 'adult', 'mature', 'senior'];
    for (let i = 0; i < names.length; i++) o[names[i]] = this.byCohort[i];
    return o;
  }
}

export default Population;
