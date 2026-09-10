import * as THREE from 'three';
import { Builder, cell2 } from './Geo.js';

/**
 * Procedural trees.
 *
 * A tree is grown as a skeleton (trunk → primaries → secondaries), the skeleton
 * is swept into tapered tubes for the woody parts, and every branch tip carries
 * a *leaf cluster*: three quads crossed around the tip, UV-mapped into a cell of
 * the hand-drawn leaf atlas. That is what makes the canopy read as foliage at
 * 3 m instead of as a green cone — the silhouette is made of individual leaves
 * and the interior has depth because the quads intersect.
 *
 * Every vertex carries `aSway`, 0 at the root and ~1 at a leaf tip, which the
 * material's vertex patch uses for wind.
 *
 * Three tiers per species:
 *   near  — full skeleton + 28-46 clusters
 *   mid   — same skeleton, 8-12 fat clusters (the trunk mesh is shared)
 *   far   — three crossed quads of a painted canopy silhouette, trunk included
 */

const TAU = Math.PI * 2;

export const SPECIES = ['oak', 'plane', 'birch', 'conifer'];

const PARAMS = {
  oak: {
    height: [7.6, 10.2], trunkR: [0.27, 0.38], clear: 0.20,
    primaries: [5, 7], primAng: [0.66, 1.08], primLen: [0.52, 0.74],
    secPer: 3, spread: 1.24, clusters: [66, 86], clusterR: [1.80, 2.55],
    lean: 0.10, twist: 0.5,
  },
  plane: {
    height: [9.0, 12.0], trunkR: [0.24, 0.33], clear: 0.26,
    primaries: [5, 6], primAng: [0.46, 0.84], primLen: [0.46, 0.66],
    secPer: 3, spread: 0.95, clusters: [62, 80], clusterR: [1.90, 2.65],
    lean: 0.06, twist: 0.35,
  },
  birch: {
    height: [8.0, 10.8], trunkR: [0.15, 0.22], clear: 0.24,
    primaries: [6, 8], primAng: [0.56, 1.00], primLen: [0.32, 0.48],
    secPer: 2, spread: 0.78, clusters: [54, 70], clusterR: [1.35, 1.95],
    lean: 0.13, twist: 0.28,
  },
  conifer: {
    height: [10.0, 15.5], trunkR: [0.22, 0.32], clear: 0.08,
    primaries: [10, 13], primAng: [1.05, 1.36], primLen: [0.22, 0.36],
    secPer: 1, spread: 0.5, clusters: [56, 74], clusterR: [1.35, 2.00],
    lean: 0.03, twist: 0.16,
  },
};

/* ----------------------------------------------------------- skeleton ----- */

function grow(p, rng) {
  const H = rng.range(p.height[0], p.height[1]);
  const R0 = rng.range(p.trunkR[0], p.trunkR[1]);
  const conifer = p.spread < 0.6;

  // Trunk: 7 nodes, leaning and twisting deterministically.
  const leanA = rng.range(0, TAU);
  const lean = rng.range(0, p.lean);
  const twist = rng.range(-p.twist, p.twist);
  const trunk = [];
  const trunkR = [];
  const N = 7;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const bend = Math.pow(t, 1.7) * lean * H;
    const th = leanA + twist * t;
    const wob = Math.sin(t * 5.3 + leanA) * R0 * 0.9 * (1 - t * 0.5);
    trunk.push([
      Math.cos(th) * bend + Math.cos(th * 2.3) * wob,
      t * H,
      Math.sin(th) * bend + Math.sin(th * 2.3) * wob,
    ]);
    trunkR.push(R0 * (1 - t * 0.60) + 0.014);
  }

  const limbs = [];     // {pts, rad, tip:[x,y,z], order}
  const tips = [];      // {x,y,z, r} leaf-cluster anchors

  const pointOnTrunk = (t) => {
    const f = t * (N - 1);
    const i = Math.min(N - 2, Math.floor(f));
    const k = f - i;
    return [
      trunk[i][0] + (trunk[i + 1][0] - trunk[i][0]) * k,
      trunk[i][1] + (trunk[i + 1][1] - trunk[i][1]) * k,
      trunk[i][2] + (trunk[i + 1][2] - trunk[i][2]) * k,
    ];
  };

  const nPrim = rng.intRange(p.primaries[0], p.primaries[1]);
  const a0 = rng.range(0, TAU);
  for (let i = 0; i < nPrim; i++) {
    const t = p.clear + (1 - p.clear) * ((i + rng.range(0.1, 0.9)) / nPrim);
    if (t > 0.985) continue;
    const base = pointOnTrunk(t);
    const az = a0 + (i / nPrim) * TAU * 1.618 + rng.range(-0.30, 0.30);
    const el = rng.range(p.primAng[0], p.primAng[1]) * (conifer ? 1 : (1 - t * 0.35));
    const len = H * rng.range(p.primLen[0], p.primLen[1]) * (conifer ? (1.25 - t) : 1);
    const r0 = trunkR[Math.floor(t * (N - 1))] * rng.range(0.42, 0.62);

    const pts = [], rad = [];
    const M = 4;
    for (let j = 0; j < M; j++) {
      const u = j / (M - 1);
      // limbs sweep outward then lift (conifers droop instead)
      const droop = conifer ? -Math.pow(u, 1.8) * 0.42 : Math.pow(u, 1.9) * 0.55;
      const horiz = Math.sin(el) * len * u;
      const vert = Math.cos(el) * len * u * (conifer ? 0.35 : 1) + droop * len * 0.5;
      const sw = Math.sin(u * 3.1 + i) * len * 0.055;
      pts.push([
        base[0] + Math.cos(az) * horiz + Math.cos(az + 1.57) * sw,
        base[1] + vert,
        base[2] + Math.sin(az) * horiz + Math.sin(az + 1.57) * sw,
      ]);
      rad.push(r0 * (1 - u * 0.82) + 0.008);
    }
    limbs.push({ pts, rad, t0: t, order: 1 });

    // secondaries off the outer half of each primary
    for (let s = 0; s < p.secPer; s++) {
      const u = 0.45 + (s / Math.max(1, p.secPer)) * 0.5 + rng.range(-0.05, 0.05);
      const f = u * (M - 1);
      const bi = Math.min(M - 2, Math.floor(f)), bk = f - bi;
      const bp = [
        pts[bi][0] + (pts[bi + 1][0] - pts[bi][0]) * bk,
        pts[bi][1] + (pts[bi + 1][1] - pts[bi][1]) * bk,
        pts[bi][2] + (pts[bi + 1][2] - pts[bi][2]) * bk,
      ];
      const saz = az + rng.range(-p.spread, p.spread);
      const sel = el + rng.range(-0.4, 0.5);
      const slen = len * rng.range(0.34, 0.58);
      const sr = rad[bi] * rng.range(0.5, 0.72);
      const sp = [], sradA = [];
      for (let j = 0; j < 3; j++) {
        const v = j / 2;
        sp.push([
          bp[0] + Math.cos(saz) * Math.sin(sel) * slen * v,
          bp[1] + Math.cos(sel) * slen * v * (conifer ? 0.4 : 0.9),
          bp[2] + Math.sin(saz) * Math.sin(sel) * slen * v,
        ]);
        sradA.push(sr * (1 - v * 0.8) + 0.006);
      }
      limbs.push({ pts: sp, rad: sradA, t0: t, order: 2 });
      tips.push({ p: sp[2], t });
    }
    tips.push({ p: pts[M - 1], t });
  }
  // a crown tip so the top is not bald
  tips.push({ p: trunk[N - 1], t: 1 });

  return { H, R0, trunk, trunkR, limbs, tips, conifer };
}

/* ------------------------------------------------------------- clusters --- */

/** Three quads crossed about the tip; `uvc` is the atlas cell for the species. */
function cluster(b, cx, cy, cz, r, uvc, rng, sway, n = 3) {
  const a0 = rng.range(0, TAU);
  for (let i = 0; i < n; i++) {
    b.push();
    b.translate(cx, cy, cz);
    b.rotY(a0 + (i / n) * Math.PI);
    b.rotX(rng.range(-0.42, 0.42));
    b.rotZ(rng.range(-0.34, 0.34));
    const s = r * rng.range(0.86, 1.16);
    b.swayBase = sway;
    b.quadXY(0, 0, s * 2, s * 2, uvc, sway);
    b.pop();
  }
}

/* ---------------------------------------------------------------- build --- */

/**
 * @returns { bark, near, mid, height, radius, tris }
 */
export function buildTree(species, rng) {
  const p = PARAMS[species] || PARAMS.oak;
  const si = Math.max(0, SPECIES.indexOf(species));
  const uvc = cell2(si);
  const sk = grow(p, rng);

  const bark = new Builder();
  bark.swayBase = 0;
  bark.tube(sk.trunk, sk.trunkR, 6, 1.4, 0.02, 0.34);
  for (const l of sk.limbs) {
    const s0 = 0.18 + l.t0 * 0.34;
    bark.tube(l.pts, l.rad, l.order === 1 ? 4 : 3, 0.9, s0, s0 + (l.order === 1 ? 0.30 : 0.40));
  }

  const near = new Builder();
  const mid = new Builder();

  const want = rng.intRange(p.clusters[0], p.clusters[1]);
  const tips = sk.tips;
  let radius = 0;
  for (let i = 0; i < want; i++) {
    const tip = tips[i % tips.length];
    const jitter = i >= tips.length ? 1 : 0;
    // filler clusters are cheaper (two crossed quads) and sit between the tips,
    // which is what closes the canopy instead of leaving separate green balls
    const quads = jitter ? 2 : 3;
    const r = rng.range(p.clusterR[0], p.clusterR[1]) * (sk.conifer ? 0.82 : 1) * (jitter ? 0.86 : 1);
    const cx = tip.p[0] * (jitter ? rng.range(0.55, 1.0) : 1) + (jitter ? rng.gauss(0, r * 0.62) : 0);
    const cy = tip.p[1] + (jitter ? rng.gauss(0, r * 0.5) : 0);
    const cz = tip.p[2] * (jitter ? rng.range(0.55, 1.0) : 1) + (jitter ? rng.gauss(0, r * 0.62) : 0);
    if (cy < sk.H * p.clear * 0.8) continue;
    const sway = 0.55 + 0.45 * Math.min(1, cy / sk.H);
    cluster(near, cx, cy, cz, r, uvc, rng, sway, quads);
    radius = Math.max(radius, Math.hypot(cx, cz) + r);
  }

  // mid tier: a coarse re-clustering of the same canopy volume
  const midN = sk.conifer ? 6 : 9;
  for (let i = 0; i < midN; i++) {
    const tip = tips[Math.floor((i / midN) * tips.length)];
    const r = p.clusterR[1] * (sk.conifer ? 1.5 : 2.1);
    cluster(mid, tip.p[0] * 0.85, tip.p[1], tip.p[2] * 0.85, r, uvc, rng, 0.85);
  }

  return {
    bark: bark.build(`props:bark:${species}`),
    near: near.build(`props:leafN:${species}`),
    mid: mid.build(`props:leafM:${species}`),
    height: sk.H,
    radius: Math.max(radius, sk.H * 0.28),
    tris: bark.triangles + near.triangles + mid.triangles,
  };
}

/** Far LOD: three crossed quads of a painted canopy, one per species. */
export function buildCanopyFar(species) {
  const si = Math.max(0, SPECIES.indexOf(species));
  const p = PARAMS[species] || PARAMS.oak;
  const b = new Builder();
  const H = (p.height[0] + p.height[1]) / 2;
  const W = H * (species === 'conifer' ? 0.52 : 0.92);
  for (let i = 0; i < 3; i++) {
    b.push();
    b.rotY((i / 3) * Math.PI);
    b.swayBase = 0.2;
    b.quadXY(0, H * 0.5, W, H, cell2(si), 0.7);
    b.pop();
  }
  return b.build(`props:canopyFar:${species}`);
}

/* ------------------------------------------------------ shrubs & ground --- */

/** Rounded foliage mass — hedges, garden shrubs, park underplanting. */
export function buildShrub(rng, { w = 1.5, h = 1.2, d = 1.4, lobes = 5 } = {}) {
  const b = new Builder();
  b.swayBase = 0.1;
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * TAU + rng.range(-0.4, 0.4);
    const rr = i === 0 ? 0 : rng.range(0.18, 0.34);
    b.blob(
      Math.cos(a) * w * rr, h * rng.range(0.36, 0.56), Math.sin(a) * d * rr,
      w * rng.range(0.40, 0.58), h * rng.range(0.40, 0.56), d * rng.range(0.40, 0.58),
      9, 0.65, 0.72,
      (u, v) => 1 + 0.30 * Math.sin(u * 13 + i * 2.1) * Math.sin(v * 9 + i)
        + 0.14 * Math.sin(u * 27 + i)
    );
  }
  return b.build('props:shrub');
}

/** 2 m of clipped hedge, meant to be repeated along a run. */
export function buildHedge(rng, { len = 2.0, h = 1.15, w = 0.72 } = {}) {
  const b = new Builder();
  b.swayBase = 0.05;
  const seg = 5;
  const grid = [];
  for (let j = 0; j <= 3; j++) {
    const row = [];
    const vy = j / 3;
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const bump = 1 + 0.10 * Math.sin(u * 9.1 + j * 2.3) + rng.range(-0.03, 0.03);
      row.push({ u, vy, bump });
    }
    grid.push(row);
  }
  // front, back, top as three lightly displaced strips
  const emit = (sign) => {
    const ids = [];
    for (let j = 0; j <= 3; j++) {
      const r = [];
      for (let i = 0; i <= seg; i++) {
        const g = grid[j][i];
        r.push(b.v(
          (g.u - 0.5) * len, g.vy * h,
          sign * (w / 2) * g.bump * (1 - Math.pow(g.vy, 3) * 0.22),
          0, 0.25 * g.vy, sign, g.u * len / 0.7, g.vy * h / 0.7,
          0.02 + g.vy * 0.30
        ));
      }
      ids.push(r);
    }
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < seg; i++) {
        if (sign > 0) b.face(ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i]);
        else b.face(ids[j][i + 1], ids[j][i], ids[j + 1][i], ids[j + 1][i + 1]);
      }
    }
    return ids[3];
  };
  const topA = emit(1);
  const topB = emit(-1);
  for (let i = 0; i < seg; i++) b.face(topA[i], topA[i + 1], topB[i + 1], topB[i]);
  // end caps
  b.face(
    b.v(-len / 2, 0, w / 2, -1, 0, 0, 0, 0, 0.02),
    b.v(-len / 2, 0, -w / 2, -1, 0, 0, w / 0.7, 0, 0.02),
    b.v(-len / 2, h, -w / 2, -1, 0, 0, w / 0.7, h / 0.7, 0.3),
    b.v(-len / 2, h, w / 2, -1, 0, 0, 0, h / 0.7, 0.3)
  );
  b.face(
    b.v(len / 2, 0, -w / 2, 1, 0, 0, 0, 0, 0.02),
    b.v(len / 2, 0, w / 2, 1, 0, 0, w / 0.7, 0, 0.02),
    b.v(len / 2, h, w / 2, 1, 0, 0, w / 0.7, h / 0.7, 0.3),
    b.v(len / 2, h, -w / 2, 1, 0, 0, 0, h / 0.7, 0.3)
  );
  return b.build('props:hedge');
}

/** A tuft of grass: three crossed alpha strips. Cheap, and only drawn near. */
export function buildGrassTuft(rng, { w = 0.55, h = 0.42 } = {}) {
  const b = new Builder();
  const uv = [0.02, 0.02, 0.98, 0.98];
  for (let i = 0; i < 3; i++) {
    b.push();
    b.rotY((i / 3) * Math.PI + rng.range(-0.2, 0.2));
    b.swayBase = 0.15;
    b.quadXY(0, h / 2, w, h, uv, 1.0);
    b.pop();
  }
  return b.build('props:grass');
}

/** Ground-cover patch of taller scrub for undeveloped land. */
export function buildScrub(rng) {
  const b = new Builder();
  const uv = [0.02, 0.02, 0.98, 0.98];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, TAU), r = rng.range(0, 0.7);
    b.push();
    b.translate(Math.cos(a) * r, 0, Math.sin(a) * r);
    b.rotY(rng.range(0, TAU));
    const h = rng.range(0.55, 1.05);
    b.swayBase = 0.1;
    b.quadXY(0, h / 2, h * 1.5, h, uv, 1.0);
    b.rotY(1.57);
    b.quadXY(0, h / 2, h * 1.5, h, uv, 1.0);
    b.pop();
  }
  return b.build('props:scrub');
}

/** Flower bed: low mass with bright speckle handled by instance tint. */
export function buildFlowerBed(rng) {
  const b = new Builder();
  b.swayBase = 0.12;
  for (let i = 0; i < 5; i++) {
    const a = rng.range(0, TAU), r = rng.range(0, 0.55);
    b.blob(Math.cos(a) * r, rng.range(0.13, 0.24), Math.sin(a) * r,
      rng.range(0.24, 0.40), rng.range(0.13, 0.22), rng.range(0.24, 0.40), 7, 0.4, 0.5);
  }
  return b.build('props:flowers');
}

export default { buildTree, buildCanopyFar, buildShrub, buildHedge, buildGrassTuft, buildScrub, buildFlowerBed, SPECIES };
