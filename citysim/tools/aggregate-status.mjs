#!/usr/bin/env node
/**
 * Fold every shot JSON under docs/shots/ into docs/STATUS.json, merging with whatever
 * the gauntlet and the critic have already written. Read-only over the shots.
 *
 *   node tools/aggregate-status.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'docs/shots');
const STATUS = path.join(ROOT, 'docs/STATUS.json');

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.json') && e.name !== 'measurements.json') out.push(p);
  }
  return out;
};

let status;
try { status = JSON.parse(fs.readFileSync(STATUS, 'utf8')); }
catch { status = { project: 'Metropolis', modules: {}, history: [] }; }

status.updated = new Date().toISOString();
status.budget = { fps: 50, drawCalls: 1500, passScore: 8.5 };
status.environmentNotes = {
  cpus: 2,
  gpu: 'none — headless Chromium / SwiftShader software WebGL2',
  fpsMeaningful: false,
  egress: 'polyhaven.org and ambientcg.com blocked; every asset is procedural',
  note: 'fps is NOT gated (REAL_GPU!=1). Draw calls and console errors are.',
};

const files = walk(SHOTS);
const byModule = new Map();

for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  if (!j || typeof j !== 'object' || !('drawCalls' in j)) continue;
  const rel = path.relative(SHOTS, f);
  const dir = rel.split(path.sep)[0];
  const mod = j.module || (dir.endsWith('.json') ? 'app' : dir);
  if (!byModule.has(mod)) byModule.set(mod, []);
  byModule.get(mod).push({
    shot: rel.replace(/\.json$/, ''),
    preset: j.preset, time: j.time, variant: j.variant,
    pass: !!j.pass, drawCalls: j.drawCalls, triangles: j.triangles,
    errors: (j.consoleErrors || []).length,
    reasons: j.reasons || [],
    worldHash: j.worldHash || null,
    mtime: fs.statSync(f).mtimeMs,
  });
}

for (const [mod, shots] of byModule) {
  shots.sort((a, b) => b.mtime - a.mtime);
  const prev = status.modules[mod] || {};
  const dc = shots.map((s) => s.drawCalls).filter((n) => Number.isFinite(n));
  status.modules[mod] = {
    ...prev,
    shotsTaken: shots.length,
    passing: shots.filter((s) => s.pass).length,
    technicalPass: shots.every((s) => s.pass),
    maxDrawCalls: dc.length ? Math.max(...dc) : null,
    consoleErrorShots: shots.filter((s) => s.errors > 0).length,
    latest: shots.slice(0, 8).map(({ mtime, ...rest }) => rest),
    // critic-owned fields, never written here
    score: prev.score ?? null,
    round: prev.round ?? 0,
    openIssues: prev.openIssues ?? [],
  };
}

const mods = Object.entries(status.modules);
status.summary = {
  modules: mods.length,
  technicalPass: mods.filter(([, m]) => m.technicalPass).length,
  totalShots: mods.reduce((a, [, m]) => a + (m.shotsTaken || 0), 0),
  worstDrawCalls: Math.max(...mods.map(([, m]) => m.maxDrawCalls || 0)),
  shotsWithConsoleErrors: mods.reduce((a, [, m]) => a + (m.consoleErrorShots || 0), 0),
  scored: mods.filter(([, m]) => m.score != null).length,
  passingScore: mods.filter(([, m]) => (m.score ?? 0) >= 8.5).length,
};

fs.writeFileSync(STATUS, JSON.stringify(status, null, 2));
console.log(JSON.stringify(status.summary, null, 2));
for (const [m, s] of mods.sort((a, b) => (b[1].maxDrawCalls || 0) - (a[1].maxDrawCalls || 0)))
  console.log(`  ${m.padEnd(13)} shots ${String(s.shotsTaken).padStart(3)}  pass ${String(s.passing).padStart(3)}  maxDC ${String(s.maxDrawCalls).padStart(5)}  errShots ${s.consoleErrorShots}`);
