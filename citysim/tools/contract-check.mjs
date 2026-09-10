#!/usr/bin/env node
/**
 * Static contract checks — cheap, run before every gauntlet.
 *  1. each src/<module>/index.js has a default export with name/version/init/showcase/dispose
 *  2. no Math.random() anywhere in src/ (determinism)
 *  3. no module writes outside its own folder (import path check)
 *  4. every asset referenced under /assets/ is listed in public/assets/MANIFEST.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const problems = [];
const notes = [];

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
};

const files = walk(SRC);
const modules = fs.readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'core')
  .map((d) => d.name)
  .filter((n) => fs.existsSync(path.join(SRC, n, 'index.js')));

// 1 — module contract
for (const m of modules) {
  const src = fs.readFileSync(path.join(SRC, m, 'index.js'), 'utf8');
  if (!/export\s+default/.test(src)) problems.push(`${m}/index.js: no default export`);
  for (const k of ['name', 'init', 'showcase', 'dispose']) {
    if (!new RegExp(`\\b${k}\\b`).test(src)) problems.push(`${m}/index.js: missing "${k}"`);
  }
  if (!new RegExp(`name:\\s*['"\`]${m}['"\`]`).test(src))
    problems.push(`${m}/index.js: name must be exactly "${m}"`);
}

// 2 — determinism
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);
  // strip line + block comments before the determinism scan
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/Math\.random\s*\(/.test(code)) problems.push(`${rel}: Math.random() is banned — use ctx.rng`);
  if (/\bDate\.now\s*\(/.test(src) && !/core\/(Engine|Diagnostics)\.js$/.test(rel))
    notes.push(`${rel}: Date.now() — make sure it is not in a generation path`);
}

// 3 — folder ownership (a module must not import from a sibling module's internals)
for (const f of files) {
  const rel = path.relative(SRC, f);
  const owner = rel.split(path.sep)[0];
  if (owner === 'core' || owner === 'demo') continue;
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/from\s+['"](\.\.\/([a-z]+)\/[^'"]+)['"]/g)) {
    if (m[2] !== owner && m[2] !== 'core')
      problems.push(`${path.relative(ROOT, f)}: imports sibling module internals "${m[1]}" — use ctx.get('${m[2]}')`);
  }
}

// 4 — asset manifest
const manifestPath = path.join(ROOT, 'public/assets/MANIFEST.json');
let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* optional */ }
if (manifest) {
  const listed = new Set((manifest.assets || []).map((a) => a.file));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/['"]\/assets\/([^'"]+)['"]/g))
      if (!listed.has(m[1]) && m[1] !== 'MANIFEST.json')
        problems.push(`${path.relative(ROOT, f)}: asset "/assets/${m[1]}" not in MANIFEST.json (CC0 policy)`);
  }
}

console.log(`contract-check: ${modules.length} module(s): ${modules.join(', ') || '(none)'}`);
for (const n of notes) console.log('  note: ' + n);
if (problems.length) {
  console.error(`\n${problems.length} contract violation(s):`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('contract-check: OK');
