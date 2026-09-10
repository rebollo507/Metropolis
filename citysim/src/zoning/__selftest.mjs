/* Node-side self test for the pure-geometry half of the module (no three.js).
 * Run: node src/zoning/__selftest.mjs                                        */
import { subdivideBlock, ZONE_PARAMS } from './Lots.js';
import { area2, offsetInward } from './geom.js';
import { Rng } from '../core/Rng.js';

function rect(w, h, cx = 0, cz = 0) {
  return [[cx - w / 2, cz - h / 2], [cx + w / 2, cz - h / 2], [cx + w / 2, cz + h / 2], [cx - w / 2, cz + h / 2]];
}

function mkBlock(poly, zoneName, roadDist = 12) {
  const tags = poly.map((_, i) => ({ segmentId: 100 + i, cls: 'lane2' }));
  return {
    id: 1, poly, tags,
    roadDist: poly.map(() => roadDist),
    area: Math.abs(area2(poly)),
    centroid: [0, 0],
    zone: 1, zoneName,
  };
}

const env = {
  terrain: null, waterLevel: 0,
  polys: new Map(),
  maxSlope: 0.5,
  rngFor: () => new Rng(7),
};

let fail = 0;
const check = (name, cond, extra = '') => {
  if (!cond) { fail++; console.log('  FAIL ' + name + ' ' + extra); }
  else console.log('  ok   ' + name + ' ' + extra);
};

console.log('-- CCW square 106x88 block face, RES_LOW --');
{
  const b = mkBlock(rect(106, 88), 'RES_LOW');
  const r = subdivideBlock(b, env);
  const P = ZONE_PARAMS.RES_LOW;
  const inW = 106 - 2 * (12 + P.setback), inH = 88 - 2 * (12 + P.setback);
  console.log(`   inset ${inW.toFixed(1)} x ${inH.toFixed(1)}, expect ~${Math.round(inW / P.lotW) * 2 + Math.round(inH / P.lotW) * 2} lots`);
  console.log(`   got ${r.lots.length} lots, areas`, r.lots.map((l) => Math.round(l.area)).join(','));
  console.log('   widths', r.lots.map((l) => l.frontage.width.toFixed(1)).join(','));
  console.log('   depths', r.lots.map((l) => l.depth.toFixed(1)).join(','));
  check('lot count', r.lots.length >= 9, `(${r.lots.length})`);
  const cov = coverage(r.inset, r.lots);
  console.log(`   inset coverage ${(cov * 100).toFixed(0)}%`);
  check('coverage', cov > 0.72, `(${(cov * 100).toFixed(0)}%)`);
  const sides = new Set(r.lots.map((l) => l.frontage.segmentId));
  check('all four sides used', sides.size === 4, `(${sides.size})`);
}

console.log('-- clockwise input (orientation robustness) --');
{
  const b = mkBlock(rect(106, 88).reverse(), 'RES_LOW');
  const r = subdivideBlock(b, env);
  check('cw lot count', r.lots.length >= 9, `(${r.lots.length})`);
}

console.log('-- thin block 106x34 --');
{
  const b = mkBlock(rect(106, 34), 'RES_LOW');
  const r = subdivideBlock(b, env);
  console.log(`   got ${r.lots.length} lots, depths`, r.lots.map((l) => l.depth.toFixed(1)).join(','));
}

console.log('-- L-shaped (non-convex) block --');
{
  const poly = [[-60, -50], [60, -50], [60, 10], [10, 10], [10, 50], [-60, 50]];
  const b = mkBlock(poly, 'RES_LOW');
  const r = subdivideBlock(b, env);
  console.log(`   got ${r.lots.length} lots, min area ${Math.min(...r.lots.map((l) => l.area)).toFixed(0)}`);
  check('L-shape lots', r.lots.length >= 10, `(${r.lots.length})`);
  // overlap test
  let overlaps = 0;
  for (let i = 0; i < r.lots.length; i++) {
    for (let j = i + 1; j < r.lots.length; j++) {
      if (polyOverlapArea(r.lots[i].poly, r.lots[j].poly) > 4) overlaps++;
    }
  }
  check('no overlapping lots', overlaps === 0, `(${overlaps})`);
}

console.log('-- offsetInward sanity --');
{
  const p = rect(100, 80);
  const o = offsetInward(p, [10, 10, 10, 10], null);
  check('inset area', Math.abs(area2(o.pts) - 80 * 60) < 1, `(${area2(o.pts).toFixed(1)} vs 4800)`);
}

function coverage(inset, lots) {
  if (!inset) return 0;
  const inside = (poly, x, z) => {
    let s = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) s = !s;
    }
    return s;
  };
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const p of inset) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
  const step = 0.8;
  let tot = 0, hit = 0;
  for (let z = z0; z < z1; z += step) for (let x = x0; x < x1; x += step) {
    if (!inside(inset, x, z)) continue;
    tot++;
    for (const l of lots) if (inside(l.poly, x, z)) { hit++; break; }
  }
  return tot ? hit / tot : 0;
}

/* crude overlap: sample the first polygon's interior on a lattice */
function polyOverlapArea(a, b) {
  const inside = (poly, x, z) => {
    let s = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) s = !s;
    }
    return s;
  };
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const p of a) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
  const step = 0.6;
  let n = 0;
  for (let z = z0; z < z1; z += step) for (let x = x0; x < x1; x += step) if (inside(a, x, z) && inside(b, x, z)) n++;
  return n * step * step;
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall ok');
process.exit(fail ? 1 : 0);
