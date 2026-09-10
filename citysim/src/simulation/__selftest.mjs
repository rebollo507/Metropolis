#!/usr/bin/env node
/**
 * Numeric self-test for the simulation core. A screenshot cannot prove a
 * simulation, so this runs the real model — the same `CitySim.tick()` the
 * browser runs — over many simulated days and reports actual numbers.
 *
 *   node src/simulation/__selftest.mjs            # standard city
 *   node src/simulation/__selftest.mjs --big      # 200k-population stress run
 *
 * It uses no three.js and no DOM: the whole model is plain data on purpose.
 */

import { Rng } from '../core/Rng.js';
import { CitySim } from './Sim.js';
import { STATE } from './constants.js';

const args = new Set(process.argv.slice(2));
const BIG = args.has('--big');

/* --------------------------------------------------------------------- */
/* a synthetic world with the same shape as core/World.js                 */
/* --------------------------------------------------------------------- */

function makeWorld(seed, { cols, rows, block, levelsScale = 1 }) {
  const world = {
    seed,
    time: { day: 0, hours: 6.0, speed: 1, paused: false },
    weather: { preset: 'clear', wetness: 0 },
    terrain: { size: 2048, resolution: 513, heights: null, water: -999, biome: 'temperate', version: 0 },
    roads: { nodes: new Map(), segments: new Map(), version: 0 },
    zoning: { cells: null, cellSize: 8, gridW: 0, gridH: 0, version: 0 },
    buildings: new Map(),
    stats: { population: 0, jobs: 0, happiness: 0.5, budget: 100000, demand: { r: 0.5, c: 0.4, i: 0.3 }, traffic: 0 },
  };

  const rng = new Rng(seed ^ 0x5eed);
  let id = 1;
  const W = cols * block, H = rows * block;
  const x0 = -W / 2, z0 = -H / 2;

  // road grid
  for (let i = 0; i <= cols; i++) {
    const x = x0 + i * block;
    const a = [x, 0, z0], b = [x, 0, z0 + H];
    world.roads.segments.set(id, {
      id, a: -1, b: -1, class: i === (cols >> 1) ? 'boulevard' : 'lane2',
      lanes: i === (cols >> 1) ? 4 : 2, length: H,
      curve: [a, [a[0], 0, a[2] + H / 3], [a[0], 0, a[2] + 2 * H / 3], b],
    });
    id++;
  }
  for (let j = 0; j <= rows; j++) {
    const z = z0 + j * block;
    const a = [x0, 0, z], b = [x0 + W, 0, z];
    world.roads.segments.set(id, {
      id, a: -1, b: -1, class: j === (rows >> 1) ? 'boulevard' : 'lane2',
      lanes: j === (rows >> 1) ? 4 : 2, length: W,
      curve: [a, [a[0] + W / 3, 0, z], [a[0] + 2 * W / 3, 0, z], b],
    });
    id++;
  }

  // buildings: a downtown core of offices/retail, a residential body, industry at the edge
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = x0 + (i + 0.5) * block, cz = z0 + (j + 0.5) * block;
      const d = Math.hypot(cx, cz) / (Math.max(W, H) * 0.5);
      const per = 6;
      for (let k = 0; k < per; k++) {
        const ox = (rng.next() - 0.5) * block * 0.7;
        const oz = (rng.next() - 0.5) * block * 0.7;
        const x = cx + ox, z = cz + oz;
        let zone, levels, fw, fd;
        const r = rng.next();
        if (d < 0.30) {
          zone = r < 0.55 ? 1 : r < 0.85 ? 2 : 0;
          levels = Math.max(2, Math.round((6 + rng.next() * 22) * levelsScale));
          fw = 16 + rng.next() * 18; fd = 14 + rng.next() * 16;
        } else if (d > 0.78) {
          zone = r < 0.62 ? 3 : 0;
          levels = Math.max(1, Math.round((1 + rng.next() * 2) * levelsScale));
          fw = 26 + rng.next() * 30; fd = 20 + rng.next() * 24;
        } else {
          zone = r < 0.78 ? 0 : r < 0.92 ? 2 : 1;
          levels = Math.max(1, Math.round((1 + rng.next() * 5) * levelsScale));
          fw = 9 + rng.next() * 13; fd = 8 + rng.next() * 12;
        }
        const kind = zone === 0 ? (levels > 3 ? 'midrise' : 'house')
          : zone === 1 ? 'tower' : zone === 2 ? 'retail' : 'warehouse';
        world.buildings.set(id, {
          id, lot: [], footprint: [fw, fd], height: levels * 3.2, levels,
          kind, zone, rotation: 0, address: { segmentId: 1, t: 0.5 },
          seed: id, state: 'built', pos: [x, 0, z],
        });
        id++;
      }
    }
  }
  return world;
}

function makeSim(seed, cfg, opts = {}) {
  const world = makeWorld(seed, cfg);
  const sim = new CitySim(world, Rng.derive(seed, 'simulation'), {
    log: opts.quiet ? { info() {}, warn() {}, error() {} } : {
      info: (...a) => console.log('   [sim]', ...a),
      warn: (...a) => console.log('   [sim:warn]', ...a),
      error: (...a) => console.log('   [sim:err]', ...a),
    },
    emit: () => {},
  });
  sim.attach({});
  sim.rebuild('selftest');
  return { world, sim };
}

/* --------------------------------------------------------------------- */

const fail = [];
function check(name, ok, detail = '') {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) fail.push(name);
}
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const money = (v) => (v >= 0 ? '' : '-') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');

/* ============================== main ================================== */

const cfg = BIG
  ? { cols: 17, rows: 17, block: 112, levelsScale: 7.6 }
  : { cols: 7, rows: 7, block: 120, levelsScale: 1 };

console.log(`\n=== simulation self-test (${BIG ? 'BIG / stress' : 'standard'}) ===\n`);
console.log('1. build');
const t0 = performance.now();
const { world, sim } = makeSim(1337, cfg);
const buildMs = performance.now() - t0;
console.log(`   buildings ${world.buildings.size}  housing ${sim.pop.capTotal}  jobs ${sim.pop.jobsTotal}`
  + `  installations ${sim.fields.installations.length}  build ${Math.round(buildMs)} ms`);
console.log(`   seeded population ${sim.pop.count}  households ${sim.pop.hcount}`
  + `  employed ${sim.pop.employed}  unemployment ${f2(sim.pop.unemployment() * 100)}%`);

/* --- 2. run 40 days and record the curves --------------------------- */
const DAYS = BIG ? 8 : 40;
console.log(`\n2. ${DAYS} simulated days (settlement is monthly, on day 30)`);
const curve = [];
let worstTick = 0, totalTicks = 0, totalMs = 0;
for (let d = 0; d < DAYS; d++) {
  const tA = performance.now();
  const n = sim.advanceDays(1);
  const ms = performance.now() - tA;
  totalTicks += n; totalMs += ms;
  if (sim.tickMsMax > worstTick) worstTick = sim.tickMsMax;
  curve.push({
    day: sim.day,
    pop: sim.pop.count,
    hh: sim.pop.hcount,
    emp: sim.pop.employed,
    un: sim.pop.unemployment(),
    budget: sim.econ.budget,
    lv: sim.fields.stats.landValueMean,
    cov: sim.fields.stats.coverageMean,
    d: { r: sim.demand.r, c: sim.demand.c, i: sim.demand.i },
    commute: sim.commuteMin,
    happy: sim.happiness,
    inc: sim.econ.last.income.total, exp: sim.econ.last.expense.total,
  });
}
console.log('   day   pop     hh    empl   unemp   landval  cover  commute happy   budget       income     expense');
for (const c of curve) {
  if (c.day % 4 !== 0 && c.day !== DAYS && c.day !== 1) continue;
  console.log(`   ${String(c.day).padStart(3)}  ${String(c.pop).padStart(6)} ${String(c.hh).padStart(6)}`
    + ` ${String(c.emp).padStart(6)}  ${f2(c.un * 100).padStart(5)}%`
    + `   ${f2(c.lv).padStart(5)}  ${f2(c.cov).padStart(5)}`
    + `   ${f2(c.commute).padStart(5)}m ${f2(c.happy).padStart(5)}`
    + `  ${money(c.budget).padStart(11)} ${money(c.inc).padStart(10)} ${money(c.exp).padStart(10)}`);
}
const led = sim.econ.last;
console.log('   last settlement:', JSON.stringify({ month: led.month, income: led.income, expense: led.expense, net: led.net }));
console.log(`   demand at end  R ${f2(sim.demand.r)}  C ${f2(sim.demand.c)}  I ${f2(sim.demand.i)}`);
console.log(`   service coverage: ` + JSON.stringify(sim.fields.coverageMeans()));

/* --- 3. sanity assertions ------------------------------------------- */
console.log('\n3. invariants');
const s = sim.stats();
const allNumbers = [];
(function walk(o) {
  for (const k in o) {
    const v = o[k];
    if (typeof v === 'number') allNumbers.push([k, v]);
    else if (v && typeof v === 'object') walk(v);
  }
})(s);
check('no NaN / Infinity anywhere in stats', allNumbers.every(([, v]) => Number.isFinite(v)),
  allNumbers.filter(([, v]) => !Number.isFinite(v)).map(([k]) => k).join(',') || `${allNumbers.length} numbers`);
check('population non-negative', sim.pop.count >= 0, `${sim.pop.count}`);
check('population bounded by housing', sim.pop.count <= sim.pop.capTotal,
  `${sim.pop.count} / ${sim.pop.capTotal}`);
check('employed ≤ workforce', sim.pop.employed <= sim.pop.workforce,
  `${sim.pop.employed} ≤ ${sim.pop.workforce}`);
check('jobs filled ≤ jobs', sim.pop.jobsFilled <= sim.pop.jobsTotal,
  `${sim.pop.jobsFilled} ≤ ${sim.pop.jobsTotal}`);
let occSum = 0, fillSum = 0, occOver = 0;
for (let i = 0; i < sim.pop.nb; i++) {
  occSum += sim.pop.bOcc[i]; fillSum += sim.pop.bFill[i];
  if (sim.pop.bOcc[i] > sim.pop.bCap[i]) occOver++;
  if (sim.pop.bFill[i] > sim.pop.bJobs[i]) occOver++;
}
check('per-building occupancy within capacity', occOver === 0, `${occOver} over-full`);
check('Σ building occupancy == population', occSum === sim.pop.count, `${occSum} vs ${sim.pop.count}`);
check('Σ jobs filled == employed', fillSum === sim.pop.employed, `${fillSum} vs ${sim.pop.employed}`);
const stateSum = sim.pop.byState.reduce((a, b) => a + b, 0);
check('state histogram sums to population', stateSum === sim.pop.count, `${stateSum} vs ${sim.pop.count}`);
const cohSum = sim.pop.byCohort.reduce((a, b) => a + b, 0);
check('cohort histogram sums to population', cohSum === sim.pop.count, `${cohSum} vs ${sim.pop.count}`);
const growth = curve[curve.length - 1].pop / Math.max(1, curve[0].pop);
check('no unbounded growth (≤ 3× over 14 days)', growth <= 3, `${f2(growth)}×`);
let lvBad = 0, covBad = 0;
for (let i = 0; i < sim.fields.landValue.length; i++) {
  const v = sim.fields.landValue[i];
  if (!Number.isFinite(v) || v < 0 || v > 1.0001) lvBad++;
  for (let k = 0; k < sim.fields.coverage.length; k++) {
    const c = sim.fields.coverage[k][i];
    if (!Number.isFinite(c) || c < 0 || c > 1.0001) covBad++;
  }
}
check('land value field in [0,1]', lvBad === 0, `${lvBad} bad cells`);
check('coverage fields in [0,1]', covBad === 0, `${covBad} bad cells`);

/* --- 4. demand responds to a tax change ------------------------------ */
console.log('\n4. demand response to a tax rise (11% → 26% residential)');
const before = { r: sim.demand.r, c: sim.demand.c, i: sim.demand.i, pop: sim.pop.count };
sim.econ.setTax('r', 0.26);
sim.advanceDays(6);
const after = { r: sim.demand.r, c: sim.demand.c, i: sim.demand.i, pop: sim.pop.count };
console.log(`   R demand ${f2(before.r)} → ${f2(after.r)}   C ${f2(before.c)} → ${f2(after.c)}`
  + `   I ${f2(before.i)} → ${f2(after.i)}`);
console.log(`   population ${before.pop} → ${after.pop}   budget ${money(sim.econ.budget)}`);
check('residential demand falls when residential tax rises', after.r < before.r - 0.02,
  `${f2(before.r)} → ${f2(after.r)}`);
sim.econ.setTax('r', 0.04);
sim.advanceDays(6);
console.log(`   after cutting R tax to 4%: R demand ${f2(sim.demand.r)}  pop ${sim.pop.count}`
  + `  budget ${money(sim.econ.budget)}`);
check('residential demand recovers when tax is cut', sim.demand.r > after.r + 0.01,
  `${f2(after.r)} → ${f2(sim.demand.r)}`);

/* --- 4b. a labour-market shock --------------------------------------- */
console.log('\n4b. labour shock — 92% of the workplaces are demolished (jobs fall below the workforce)');
sim.econ.setTax('r', 0.11);
const shock = makeSim(4242, cfg, { quiet: true });
shock.sim.advanceDays(4);
const preU = shock.sim.pop.unemployment(), prePop = shock.sim.pop.count;
const preD = { r: shock.sim.demand.r, i: shock.sim.demand.i };
let killed = 0;
const doomed = [];
for (const b of shock.world.buildings.values()) if (b.zone !== 0 && (b.id % 25) < 23) doomed.push(b.id);
for (const id of doomed) { shock.world.buildings.delete(id); killed++; }
shock.sim.rebuild('shock');
shock.sim.advanceDays(10);
console.log(`   demolished ${killed} workplaces  jobs ${shock.sim.pop.jobsTotal}`
  + `  workforce ${shock.sim.pop.workforce}`);
console.log(`   unemployment ${f2(preU * 100)}% → ${f2(shock.sim.pop.unemployment() * 100)}%`
  + `   population ${prePop} → ${shock.sim.pop.count}`
  + `   R demand ${f2(preD.r)} → ${f2(shock.sim.demand.r)}`
  + `   I demand ${f2(preD.i)} → ${f2(shock.sim.demand.i)}`);
check('unemployment rises when workplaces disappear',
  shock.sim.pop.unemployment() > preU + 0.02,
  `${f2(preU * 100)}% → ${f2(shock.sim.pop.unemployment() * 100)}%`);
check('residential demand falls when the jobs go',
  shock.sim.demand.r < preD.r - 0.02, `${f2(preD.r)} → ${f2(shock.sim.demand.r)}`);
check('citizens leave a city with no work', shock.sim.pop.count < prePop,
  `${prePop} → ${shock.sim.pop.count}`);
check('no citizen is stranded in a demolished building',
  (() => { let n = 0; for (let i = 0; i < shock.sim.pop.cap; i++) if (shock.sim.pop.alive[i] && shock.sim.pop.home[i] < 0) n++; return n === 0; })(),
  'homeless count');

/* --- 5. commute peak / rhythm ---------------------------------------- */
console.log('\n5. daily rhythm → traffic density (weekday)');
const rows = [];
for (let h = 0; h < 24; h++) {
  sim.rhythm.update(h, 3, 1, 1);
  rows.push([h, sim.rhythm.trafficDensity, sim.rhythm.occupancy.res, sim.rhythm.occupancy.office,
    sim.rhythm.occupancy.retail]);
}
console.log('   hour  density  occ.res  occ.office  occ.retail');
for (const [h, d, r, o, rt] of rows) {
  if (h % 2) continue;
  const bar = '#'.repeat(Math.round(d * 18));
  console.log(`   ${String(h).padStart(4)}  ${f2(d).padStart(6)}   ${f2(r)}    ${f2(o)}       ${f2(rt)}  ${bar}`);
}
const peakAM = rows[8][1], peakPM = rows[18][1], night = rows[3][1], noon = rows[12][1];
check('morning peak (08:00) above midday', peakAM > noon, `${f2(peakAM)} vs ${f2(noon)}`);
check('evening peak (18:00) above midday', peakPM > noon, `${f2(peakPM)} vs ${f2(noon)}`);
check('night trough (03:00) well below peaks', night < peakPM * 0.45, `${f2(night)} vs ${f2(peakPM)}`);
sim.rhythm.update(8, 5, 1, 1);
const weekendAM = sim.rhythm.trafficDensity;
check('weekend morning is quieter than weekday morning', weekendAM < peakAM * 0.75,
  `${f2(weekendAM)} vs ${f2(peakAM)}`);

/* --- 6. determinism --------------------------------------------------- */
console.log('\n6. determinism — two independent runs, same seed');
const a = makeSim(20260903, cfg, { quiet: true });
const b = makeSim(20260903, cfg, { quiet: true });
a.sim.advanceDays(5); b.sim.advanceDays(5);
// tickMs is a wall-clock measurement, not simulation state — strip it
const strip = (s) => { const o = { ...s }; delete o.tickMs; return JSON.stringify(o); };
const sa = strip(a.sim.stats()), sb = strip(b.sim.stats());
check('identical stats after 5 days', sa === sb,
  sa === sb ? `pop ${a.sim.pop.count}, budget ${money(a.sim.econ.budget)}` : 'diverged');
let fieldDiff = 0;
for (let i = 0; i < a.sim.fields.landValue.length; i++) {
  if (a.sim.fields.landValue[i] !== b.sim.fields.landValue[i]) fieldDiff++;
}
check('identical land-value field', fieldDiff === 0, `${fieldDiff} differing cells`);
const c = makeSim(20260904, cfg, { quiet: true });
c.sim.advanceDays(5);
check('a different seed gives a different city',
  strip(c.sim.stats()) !== sa,
  `pop ${c.sim.pop.count} vs ${a.sim.pop.count}`);

/* --- 7. tick cost ----------------------------------------------------- */
console.log('\n7. tick cost');
sim.tickMsMax = 0;
const N = 20000;
const tB = performance.now();
for (let k = 0; k < N; k++) sim.tick(0.05);
const meanMs = (performance.now() - tB) / N;
console.log(`   population ${sim.pop.count.toLocaleString('en-US')}  buildings ${sim.pop.nb}`);
console.log(`   mean ${meanMs.toFixed(4)} ms/tick over ${N} ticks   worst single tick ${sim.tickMsMax.toFixed(3)} ms`);
console.log(`   (14-day run earlier: ${totalTicks.toLocaleString('en-US')} ticks in ${Math.round(totalMs)} ms`
  + ` = ${(totalMs / totalTicks).toFixed(4)} ms/tick)`);
check('mean tick ≤ 1.5 ms', meanMs <= 1.5, `${meanMs.toFixed(4)} ms`);
check('worst tick ≤ 1.5 ms', sim.tickMsMax <= 1.5, `${sim.tickMsMax.toFixed(3)} ms`);

/* --- 8. bankruptcy is a state ---------------------------------------- */
console.log('\n8. bankruptcy');
const bk = makeSim(77, cfg, { quiet: true });
bk.sim.econ.setTax({ r: 0, c: 0, i: 0 });
bk.sim.econ.budget = -200000;
for (let m = 0; m < 5; m++) bk.sim.settle();
console.log(`   budget ${money(bk.sim.econ.budget)}  bankrupt=${bk.sim.econ.bankrupt}`
  + `  installations on ${bk.sim.fields.installations.filter((i) => i.on).length}`
  + `/${bk.sim.fields.installations.length}`);
bk.sim.advanceDays(2);
check('bankruptcy is a state, not a crash', bk.sim.econ.bankrupt === true
  && Number.isFinite(bk.sim.econ.budget) && bk.sim.pop.count >= 0,
  `pop ${bk.sim.pop.count}`);
bk.sim.econ.setTax({ r: 0.28, c: 0.28, i: 0.28 });
bk.sim.econ.budget = 50000;
bk.sim.settle(); bk.sim.settle();
check('city recovers from bankruptcy', bk.sim.econ.bankrupt === false,
  `budget ${money(bk.sim.econ.budget)}, ${bk.sim.fields.installations.filter((i) => i.on).length} installations back on`);

/* --- summary ---------------------------------------------------------- */
console.log(`\n=== ${fail.length ? fail.length + ' FAILURE(S): ' + fail.join(', ') : 'all checks passed'} ===\n`);
void STATE;
process.exit(fail.length ? 1 : 0);
