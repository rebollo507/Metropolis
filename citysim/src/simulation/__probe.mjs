#!/usr/bin/env node
/**
 * A small in-page probe built on the project harness's own `launch()`.
 *
 * Two jobs:
 *   1. fast screenshot iteration (fewer warm frames than the gauntlet needs)
 *   2. the numeric verification that a screenshot cannot do — run the real
 *      simulation in the real page for many simulated days and read the numbers
 *      back out of `window.__GAME__`.
 *
 *   node src/simulation/__probe.mjs shot   --variant=default --time=13 [--out=…]
 *   node src/simulation/__probe.mjs numbers
 *   node src/simulation/__probe.mjs hash
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, parseArgs } from '../../tools/shoot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'http://127.0.0.1:5173';
const argv = process.argv.slice(2);
const cmd = argv[0] || 'shot';
const a = parseArgs(argv.slice(1));

const N = (k, d) => (a[k] !== undefined ? parseFloat(a[k]) : d);

async function openPage(browser, q, { width = 1280, height = 720 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const url = `${BASE}/?${new URLSearchParams(q).toString()}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__GAME__ && window.__GAME__.ready === true, null,
    { timeout: 120000, polling: 100 });
  return { page, errors, url };
}

async function frames(page, n) {
  await page.evaluate(async (count) => {
    await new Promise((res) => {
      let i = 0;
      const step = () => (++i >= count ? res() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
  }, n);
}

/* ------------------------------------------------------------------ shot -- */

async function shot() {
  const browser = await launch();
  const variant = a.variant || 'default';
  const preset = a.preset || (variant === 'rhythm' ? 'city' : 'aerial');
  const time = N('time', variant === 'rhythm' ? 18.75 : 13);
  const out = a.out || `docs/shots/simulation/_probe_${variant}`;
  const { page, errors } = await openPage(browser, {
    seed: String(N('seed', 1337)), time: String(time), preset,
    weather: a.weather || 'clear', dpr: '1', headless: '1',
    showcase: 'simulation', variant,
  }, { width: N('width', 1280), height: N('height', 720) });

  await page.evaluate(([p, t]) => {
    window.__GAME__.setPreset(p); window.__GAME__.setTime(t); window.__GAME__.settle();
  }, [preset, time]);
  await frames(page, N('warm', 14));

  const info = await page.evaluate(() => {
    const g = window.__GAME__;
    const eng = g.engine;
    const grp = eng.scene.getObjectByName('mod:simulation');
    let mine = 0, meshes = [];
    grp?.traverse((o) => {
      if (o.isMesh && o.visible) {
        mine++;
        meshes.push({ name: o.name, count: o.count || 1, tris: (o.geometry?.index?.count || o.geometry?.attributes?.position?.count || 0) / 3 });
      }
    });
    const api = eng.host.modules.get('simulation')?.api;
    return {
      info: g.info, modules: g.modules, errors: g.errors,
      myMeshes: mine, meshes,
      myDrawCalls: api?.drawCalls ? api.drawCalls() : null,
      stats: api?.stats ? api.stats() : null,
      camera: g.camera(),
    };
  });

  const png = path.join(ROOT, `${out}.png`);
  fs.mkdirSync(path.dirname(png), { recursive: true });
  await page.screenshot({ path: png, type: 'png', timeout: 180000 });
  console.log(JSON.stringify({
    png: path.relative(ROOT, png),
    sceneDrawCalls: info.info.drawCalls, triangles: info.info.triangles,
    simulationDrawCalls: info.myDrawCalls, simulationMeshes: info.meshes,
    consoleErrors: errors.concat(info.errors),
    showcase: info.stats?.showcase, camera: info.camera,
    population: info.stats?.households !== undefined ? {
      population: info.stats.households && info.stats,
    } : null,
  }, null, 2).slice(0, 4000));
  console.log('\nstats:', JSON.stringify(info.stats, null, 1).slice(0, 2600));
  await browser.close();
}

/* --------------------------------------------------------------- numbers -- */

async function numbers() {
  const browser = await launch();
  const { page, errors } = await openPage(browser, {
    seed: '1337', time: '6', preset: 'aerial', weather: 'clear', dpr: '1', headless: '1',
    showcase: 'simulation', variant: 'default',
  }, { width: 640, height: 360 });

  const r = await page.evaluate(async () => {
    const eng = window.__GAME__.engine;
    const api = eng.host.modules.get('simulation').api;
    const sim = api.sim();
    const out = { curve: [], rhythm: [], tax: {}, perf: {}, build: {} };

    out.build = {
      buildings: sim.pop.nb, housing: sim.pop.capTotal, jobs: sim.pop.jobsTotal,
      installations: sim.fields.installations.length,
      laneKm: +(sim.fields.laneKm || 0).toFixed(2),
      byClass: (() => {
        const c = [0, 0, 0, 0, 0];
        for (let i = 0; i < sim.pop.nb; i++) c[sim.pop.bClass[i]]++;
        return { res: c[0], office: c[1], retail: c[2], ind: c[3], civic: c[4] };
      })(),
    };

    // 12 simulated days, sampled daily
    for (let d = 0; d < 12; d++) {
      sim.advanceDays(1);
      out.curve.push({
        day: sim.day, pop: sim.pop.count, hh: sim.pop.hcount,
        employed: sim.pop.employed, workforce: sim.pop.workforce,
        unemployment: +sim.pop.unemployment().toFixed(4),
        budget: Math.round(sim.econ.budget),
        income: sim.econ.last.income.total, expense: sim.econ.last.expense.total,
        landValue: +sim.fields.stats.landValueMean.toFixed(3),
        coverage: +sim.fields.stats.coverageMean.toFixed(3),
        commute: +sim.commuteMin.toFixed(2),
        demand: sim.demand.value(),
        happiness: +sim.happiness.toFixed(3),
      });
    }

    // traffic response across the day, reading the traffic module back
    const traffic = eng.host.modules.get('traffic')?.api;
    for (const h of [3, 6, 8, 12, 15, 18, 21]) {
      sim.rhythm.update(h, 3, 1, 1);
      const d = sim.rhythm.trafficDensity;
      let veh = null;
      if (traffic?.setDensity) {
        traffic.setDensity(d);
        veh = traffic.stats().vehicles;
      }
      out.rhythm.push({ hour: h, density: +d.toFixed(3), vehicles: veh,
        occRes: +sim.rhythm.occupancy.res.toFixed(3),
        occOffice: +sim.rhythm.occupancy.office.toFixed(3) });
    }

    // tax shock
    const before = sim.demand.value();
    api.setTaxRate('r', 0.26);
    sim.advanceDays(5);
    const after = sim.demand.value();
    api.setTaxRate('r', 0.04);
    sim.advanceDays(5);
    out.tax = { before, afterRise: after, afterCut: sim.demand.value() };

    // tick cost in the real page
    sim.tickMsMax = 0;
    const t0 = performance.now();
    const NT = 12000;
    for (let k = 0; k < NT; k++) sim.tick(0.05);
    out.perf = {
      population: sim.pop.count,
      meanTickMs: +((performance.now() - t0) / NT).toFixed(4),
      worstTickMs: +sim.tickMsMax.toFixed(3),
      ticks: NT,
    };

    // invariants
    let occ = 0, fill = 0, over = 0, bad = 0;
    for (let i = 0; i < sim.pop.nb; i++) {
      occ += sim.pop.bOcc[i]; fill += sim.pop.bFill[i];
      if (sim.pop.bOcc[i] > sim.pop.bCap[i] || sim.pop.bFill[i] > sim.pop.bJobs[i]) over++;
    }
    for (let i = 0; i < sim.fields.landValue.length; i++) {
      const v = sim.fields.landValue[i];
      if (!Number.isFinite(v) || v < 0 || v > 1.0001) bad++;
    }
    out.invariants = {
      occupancyMatchesPopulation: occ === sim.pop.count,
      jobsMatchEmployed: fill === sim.pop.employed,
      overfullBuildings: over,
      badLandValueCells: bad,
      populationNonNegative: sim.pop.count >= 0,
      statsFinite: (() => {
        const s = JSON.stringify(window.__GAME__.stats);
        return !/null|NaN|Infinity/.test(s);
      })(),
    };
    out.services = api.services();
    out.history = { len: sim.history.n, population: sim.history.series('population', 10) };
    return out;
  });

  console.log(JSON.stringify(r, null, 1));
  if (errors.length) console.log('CONSOLE ERRORS:', errors);
  await browser.close();
}

/* ------------------------------------------------------------------ hash -- */

async function hash() {
  const browser = await launch();
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const { page } = await openPage(browser, {
      seed: '1337', time: '13', preset: 'aerial', weather: 'clear', dpr: '1', headless: '1',
      showcase: 'simulation', variant: 'default',
    }, { width: 480, height: 270 });
    const r = await page.evaluate(() => {
      const eng = window.__GAME__.engine;
      const api = eng.host.modules.get('simulation').api;
      const sim = api.sim();
      sim.advanceDays(3);
      const s = api.stats(); delete s.tickMs; delete s.tickMsMax; delete s.showcase;
      let lvHash = 0x811c9dc5;
      for (let k = 0; k < sim.fields.landValue.length; k++) {
        const v = Math.round(sim.fields.landValue[k] * 1e6).toString();
        for (let c = 0; c < v.length; c++) { lvHash ^= v.charCodeAt(c); lvHash = Math.imul(lvHash, 0x01000193) >>> 0; }
      }
      return {
        worldHash: window.__GAME__.worldHash,
        simStats: JSON.stringify(s),
        landValueHash: (lvHash >>> 0).toString(16),
        population: sim.pop.count, budget: Math.round(sim.econ.budget),
      };
    });
    runs.push(r);
    await page.close();
  }
  console.log(JSON.stringify({
    worldHashMatch: runs[0].worldHash === runs[1].worldHash,
    worldHash: [runs[0].worldHash, runs[1].worldHash],
    simStatsMatch: runs[0].simStats === runs[1].simStats,
    landValueHashMatch: runs[0].landValueHash === runs[1].landValueHash,
    landValueHash: [runs[0].landValueHash, runs[1].landValueHash],
    population: [runs[0].population, runs[1].population],
    budget: [runs[0].budget, runs[1].budget],
  }, null, 1));
  await browser.close();
}

/* ----------------------------------------------------------------- field -- */
/** ASCII dump of a field + the built mask, to see the truth instead of guessing. */
async function field() {
  const browser = await launch();
  const { page } = await openPage(browser, {
    seed: '1337', time: '13', preset: 'aerial', weather: 'clear', dpr: '1', headless: '1',
    showcase: 'simulation', variant: a.variant || 'default',
  }, { width: 480, height: 270 });
  const r = await page.evaluate((name) => {
    const api = window.__GAME__.engine.host.modules.get('simulation').api;
    const sim = api.sim();
    const f = api.field(name) || api.field('landValue');
    const built = api.field('built');
    const g = sim.grid;
    const ramp = ' .:-=+*#%@';
    const draw = (data, scale) => {
      const rows = [];
      for (let j = 0; j < g.h; j += 1) {
        let s = '';
        for (let i = 0; i < g.w; i += 1) {
          const v = Math.max(0, Math.min(1, data[j * g.w + i] * scale));
          s += ramp[Math.round(v * 9)];
        }
        rows.push(s);
      }
      return rows;
    };
    let bMin = 9, bMax = -9, over = 0;
    for (let i = 0; i < g.n; i++) {
      const v = built.data[i];
      if (v < bMin) bMin = v; if (v > bMax) bMax = v;
      if (v > 0.06) over++;
    }
    return {
      grid: { w: g.w, h: g.h, cellSize: g.cellSize, origin: g.origin },
      bbox: sim.fields.bbox(),
      maskCellsOver006: over, maskRange: [bMin, bMax],
      builtRows: draw(built.data, 1),
      valueRows: draw(f.data, 1),
      buildingCells: (() => { const s = new Set(); for (let i = 0; i < sim.pop.nb; i++) s.add(sim.pop.bCell[i]); return s.size; })(),
    };
  }, a.field || 'landValue');
  console.log('grid', JSON.stringify(r.grid), 'bbox', JSON.stringify(r.bbox));
  console.log('building cells', r.buildingCells, ' mask cells > 0.06:', r.maskCellsOver006,
    'of', r.grid.w * r.grid.h, ' mask range', r.maskRange.map((v) => v.toFixed(3)).join('..'));
  console.log('\n--- built mask ---');
  for (const row of r.builtRows) console.log(row);
  console.log('\n--- field ---');
  for (const row of r.valueRows) console.log(row);
  await browser.close();
}

/* --------------------------------------------------------------- traffic -- */
/**
 * The claim "the simulation visibly changes the traffic" measured end to end:
 * set the clock, let the rhythm recompute, let it push `traffic.setDensity`,
 * and read the vehicle count back out of the traffic module itself.
 * Uses the rhythm variant because that is the one that stages a drivable
 * network (see the R-sim-2 note in showcase.js).
 */
async function traffic() {
  const browser = await launch();
  const { page } = await openPage(browser, {
    seed: '1337', time: '18.75', preset: 'city', weather: 'clear', dpr: '1', headless: '1',
    showcase: 'simulation', variant: 'rhythm',
  }, { width: 320, height: 180 });
  const r = await page.evaluate(async () => {
    const eng = window.__GAME__.engine;
    const sim = eng.host.modules.get('simulation').api.sim();
    const tr = eng.host.modules.get('traffic')?.api;
    const out = [];
    const frames = (n) => new Promise((res) => {
      let i = 0; const step = () => (++i >= n ? res() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    for (const h of [3, 8, 13, 18, 22]) {
      eng.world.time.hours = h;
      sim.hourBucket = -1;
      sim._lastSeenHours = h;
      sim._advanceClock(0.05);
      await frames(3);
      const st = tr ? tr.stats() : null;
      out.push({
        hour: h,
        density: +sim.rhythm.trafficDensity.toFixed(3),
        vehicles: st ? st.vehicles : null,
        pedestrians: st ? st.pedestrians : null,
        trafficIndex: eng.world.stats.traffic && eng.world.stats.traffic.index,
        occRes: +sim.rhythm.occupancy.res.toFixed(3),
        occOffice: +sim.rhythm.occupancy.office.toFixed(3),
        occRetail: +sim.rhythm.occupancy.retail.toFixed(3),
      });
    }
    // weekend comparison at the same hour
    const weekday = [];
    for (const day of [3, 6]) {
      eng.world.time.day = day; eng.world.time.hours = 8;
      sim.day = day; sim.hourBucket = -1; sim._lastSeenHours = 8;
      sim._advanceClock(0.05);
      await frames(3);
      weekday.push({ day, weekend: sim.rhythm.weekend,
        density: +sim.rhythm.trafficDensity.toFixed(3),
        vehicles: tr ? tr.stats().vehicles : null });
    }
    return { hours: out, weekday };
  });
  console.log('hour  density  vehicles  peds  trafficIndex  occRes occOffice occRetail');
  for (const h of r.hours) {
    console.log(String(h.hour).padStart(4), String(h.density).padStart(8), String(h.vehicles).padStart(9),
      String(h.pedestrians).padStart(5), String(h.trafficIndex).padStart(13),
      String(h.occRes).padStart(7), String(h.occOffice).padStart(9), String(h.occRetail).padStart(9));
  }
  console.log('\nweekday vs weekend at 08:00:', JSON.stringify(r.weekday));
  await browser.close();
}

if (cmd === 'shot') await shot();
else if (cmd === 'field') await field();
else if (cmd === 'traffic') await traffic();
else if (cmd === 'numbers') await numbers();
else if (cmd === 'hash') await hash();
else { console.error('usage: __probe.mjs shot|numbers|hash'); process.exit(2); }
