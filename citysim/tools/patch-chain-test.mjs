#!/usr/bin/env node
/** Smoke test for the core shader-patch chain (R-env-5). Run: node tools/patch-chain-test.mjs */
import * as THREE from 'three';
import { Materials } from '../src/core/Materials.js';

const log = { info() {}, warn() {}, error(...a) { console.error(a); } };
const m = new Materials(null, null, log);
const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fail.push(msg); };

// 1. a module's own hook survives, and late-registered patches reach an existing material
const mat = new THREE.MeshStandardMaterial();
mat.onBeforeCompile = (sh) => { sh.own = true; };
m.adopt(mat);
m.registerShaderPatch('csm', (sh) => { sh.csm = true; }, { depth: true });
m.registerShaderPatch('fog', (sh) => { sh.fog2 = true; });
let sh = { uniforms: {}, vertexShader: '', fragmentShader: '' };
mat.onBeforeCompile(sh, null);
ok(sh.own === true, "module's own onBeforeCompile still runs");
ok(sh.csm === true && sh.fog2 === true, 'late-registered patches reach an already-adopted material');

// 2. depth materials get only depth-flagged patches
const dep = new THREE.MeshDepthMaterial();
m.adopt(dep, { depth: true });
const sd = { uniforms: {}, vertexShader: '', fragmentShader: '' };
dep.onBeforeCompile(sd, null);
ok(sd.csm === true && sd.fog2 === undefined, 'depth material gets only depth-flagged patches');

// 3. program cache key changes with the patch set
const k1 = mat.customProgramCacheKey();
m.unregisterShaderPatch('fog');
const k2 = mat.customProgramCacheKey();
ok(k1 !== k2, `cache key tracks the patch set (${k1} -> ${k2})`);

// 4. materials created through the factory join the chain
m.registerShaderPatch('fog', (s) => { s.fog2 = true; });
const made = m.pbr({ color: 0x445566 });
const s3 = { uniforms: {}, vertexShader: '', fragmentShader: '' };
made.onBeforeCompile(s3, null);
ok(s3.csm === true && s3.fog2 === true, 'factory-made material joins the chain');

// 5. shared uniforms go in by reference
m.globalUniforms.uSunDir = new THREE.Uniform(new THREE.Vector3(0, 1, 0));
const s4 = { uniforms: {}, vertexShader: '', fragmentShader: '' };
made.onBeforeCompile(s4, null);
ok(s4.uniforms.uSunDir === m.globalUniforms.uSunDir, 'globalUniforms shared by reference');

// 6. a throwing patch is contained
m.registerShaderPatch('bad', () => { throw new Error('boom'); });
let threw = false;
try { made.onBeforeCompile({ uniforms: {}, vertexShader: '', fragmentShader: '' }, null); }
catch { threw = true; }
ok(!threw, 'a throwing patch does not take the material down');
m.unregisterShaderPatch('bad');

// 7. double adoption does not double-run a patch
let runs = 0;
m.registerShaderPatch('count', () => { runs++; });
m.adopt(mat); m.adopt(mat);
runs = 0;
mat.onBeforeCompile({ uniforms: {}, vertexShader: '', fragmentShader: '' }, null);
ok(runs === 1, `patch runs exactly once after repeated adopt (ran ${runs}x)`);

console.log(fail.length ? `\n${fail.length} FAILED` : '\nall patch-chain checks passed');
process.exit(fail.length ? 1 : 0);
