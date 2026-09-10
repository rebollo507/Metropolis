#!/usr/bin/env node
/**
 * Runs the full verification matrix and rewrites docs/STATUS.json.
 *
 *   node tools/gauntlet.mjs                     # every registered module
 *   node tools/gauntlet.mjs --only=buildings,roads
 *   node tools/gauntlet.mjs --full              # all times × all presets
 *   node tools/gauntlet.mjs --determinism       # two loads, same seed, hash must match
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, shoot, parseArgs } from './shoot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATUS = path.join(ROOT, 'docs/STATUS.json');

export const TIMES = { dawn: 6.5, noon: 13.0, golden: 18.75, night: 22.0 };
const QUICK_TIMES = { noon: 13.0, golden: 18.75, night: 22.0 };

/** Per-module camera presets — a street module is judged from the street. */
export const MODULE_PRESETS = {
  terrain:     ['aerial', 'city'],
  environment: ['skyline', 'aerial'],
  roads:       ['city', 'street'],
  zoning:      ['aerial', 'city'],
  buildings:   ['street', 'city', 'closeup'],
  props:       ['closeup', 'street'],
  traffic:     ['street', 'city'],
  effects:     ['skyline', 'street'],
  simulation:  ['city'],
  tools:       ['city'],
  ui:          ['city'],
  audio:       ['city'],
  demo:        ['aerial', 'skyline', 'street', 'city'],
};

function listModules() {
  const src = path.join(ROOT, 'src');
  return fs.readdirSync(src, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'core')
    .filter((d) => fs.existsSync(path.join(src, d.name, 'index.js')))
    .map((d) => d.name);
}

function loadStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS, 'utf8')); }
  catch { return { updated: null, modules: {}, history: [] }; }
}

async function main() {
  const a = parseArgs();
  const base = a.base || 'http://127.0.0.1:5173';
  const full = !!a.full;
  const times = full ? TIMES : QUICK_TIMES;
  const only = a.only ? String(a.only).split(',').map((s) => s.trim()) : null;
  const modules = (only || listModules()).filter(Boolean);

  if (!modules.length) { console.log('no modules to test yet'); return; }

  const browser = await launch();
  const status = loadStatus();
  status.updated = new Date().toISOString();
  status.budget = { fps: 50, drawCalls: 1500, passScore: 8.5 };

  for (const mod of modules) {
    const presets = MODULE_PRESETS[mod] || ['city'];
    const shots = [];
    for (const preset of presets) {
      for (const [label, t] of Object.entries(times)) {
        const out = `docs/shots/${mod}/${preset}_${label}`;
        process.stdout.write(`  · ${mod} ${preset} ${label} … `);
        const r = await shoot(browser, {
          base, module: mod, preset, time: t,
          width: full ? 1920 : 1600, height: full ? 1080 : 900,
          warmFrames: 30, sampleFrames: 60, out,
        });
        console.log(r.pass ? `ok  ${r.drawCalls}dc ${r.fps}fps` : `FAIL ${r.reasons.join('; ').slice(0, 120)}`);
        shots.push({
          preset, time: label, png: r.png, pass: r.pass, fps: r.fps,
          drawCalls: r.drawCalls, triangles: r.triangles,
          errors: r.consoleErrors.slice(0, 5), reasons: r.reasons,
        });
      }
    }
    const prev = status.modules[mod] || {};
    status.modules[mod] = {
      ...prev,
      lastRun: status.updated,
      technicalPass: shots.every((s) => s.pass),
      maxDrawCalls: Math.max(...shots.map((s) => s.drawCalls)),
      minFps: Math.min(...shots.map((s) => s.fps)),
      shots,
      // critic fields — written by the critic agent, never inflated here
      score: prev.score ?? null,
      round: prev.round ?? 0,
      openIssues: prev.openIssues ?? [],
    };
  }

  if (a.determinism) {
    const r1 = await shoot(browser, { base, preset: 'aerial', time: 13, seed: 4242, warmFrames: 20, sampleFrames: 10 });
    const r2 = await shoot(browser, { base, preset: 'aerial', time: 13, seed: 4242, warmFrames: 20, sampleFrames: 10 });
    status.determinism = { seed: 4242, a: r1.worldHash, b: r2.worldHash, match: r1.worldHash === r2.worldHash };
    console.log(`  · determinism: ${status.determinism.match ? 'OK' : 'MISMATCH'} (${r1.worldHash} vs ${r2.worldHash})`);
  }

  await browser.close();
  fs.mkdirSync(path.dirname(STATUS), { recursive: true });
  fs.writeFileSync(STATUS, JSON.stringify(status, null, 2));

  const failed = Object.entries(status.modules).filter(([, m]) => !m.technicalPass).map(([n]) => n);
  console.log(`\nSTATUS.json updated. technical pass: ${modules.length - failed.length}/${modules.length}` +
    (failed.length ? `  failing: ${failed.join(', ')}` : ''));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
