import * as THREE from 'three';
import { Noise } from '../core/Rng.js';
import { ZONE } from '../core/World.js';

/**
 * Urban ground — the strip nobody owned.
 *
 * `docs/CORE_REQUESTS.md` R-8 (buildings) / R-props-4: the land between the
 * back of the pavement and the building line has no owner, so terrain renders
 * grass there and every plot reads as a shed dropped on a lawn. Integrator
 * pass 2 deferred it "to props + demo integration". This is that integration.
 *
 * It is one terrain-conforming decal mesh over the built-up area: a 4 m
 * lattice whose per-vertex alpha is the *urbanness* of that square metre, read
 * from `zoning.zoneAt()`, blurred, broken up with noise and faded to nothing at
 * the city edge. Downtown it is concrete and flagstone, the industrial estate
 * is oil-stained hardstanding, the suburbs keep their gardens.
 *
 * Cost: one draw call, ~50-70 k triangles, no per-frame work.
 */

const PAVE_TILE = 9.0;     // metres per texture repeat
const LIFT = 0.10;         // above the heightfield; the carriageway is cut out, so no fight

/* ------------------------------------------------------------- textures -- */

function paveTextures(ctx, seed) {
  const n = new Noise((seed ^ 0x9e37) >>> 0);
  const S = 512;

  // shared height field: slab joints + aggregate, so albedo/rough/normal agree
  const height = new Float32Array(S * S);
  const joint = new Float32Array(S * S);
  const SLAB = 128;                    // 128 px = 2.25 m flags
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const k = y * S + x;
      // slab grid, offset every other row like real paving
      const row = Math.floor(y / SLAB);
      const ox = (row & 1) ? SLAB * 0.5 : 0;
      const jx = Math.min(((x + ox) % SLAB), SLAB - ((x + ox) % SLAB));
      const jy = Math.min((y % SLAB), SLAB - (y % SLAB));
      const j = Math.min(jx, jy);
      const g = 1 - Math.min(1, j / 3.0);          // 0 in the slab, 1 in the joint
      joint[k] = g;
      const grain = n.fbm(x * 0.055, y * 0.055, 4) * 0.5 + 0.5;
      const fine = n.simplex2(x * 0.42, y * 0.42) * 0.5 + 0.5;
      height[k] = grain * 0.55 + fine * 0.18 - g * 0.75;
    }
  }

  const albedo = ctx.assets.canvasTexture('demo:pave:albedo', S, (g2d, size) => {
    const img = g2d.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const k = y * size + x;
        const i = k * 4;
        // per-slab tonal variation: real paving is never one colour
        const row = Math.floor(y / SLAB);
        const ox = (row & 1) ? SLAB * 0.5 : 0;
        const sx = Math.floor((x + ox) / SLAB), sy = row;
        const slabTone = (n.simplex2(sx * 3.11 + 0.5, sy * 2.73 - 1.7) * 0.5 + 0.5);
        const grain = n.fbm(x * 0.045, y * 0.045, 4) * 0.5 + 0.5;
        const spec = n.simplex2(x * 1.7, y * 1.7) * 0.5 + 0.5;
        const stain = Math.max(0, n.fbm(x * 0.011 + 31.0, y * 0.011 - 12.0, 3));
        let l = 0.50 + slabTone * 0.10 + grain * 0.12 + spec * 0.05;
        l *= 1 - stain * 0.30;                    // damp patches and tyre marks
        l *= 1 - joint[k] * 0.42;                 // dark mortar line
        const warm = 1 + (slabTone - 0.5) * 0.06;
        d[i] = Math.min(255, l * 255 * 1.00 * warm);
        d[i + 1] = Math.min(255, l * 255 * 0.985);
        d[i + 2] = Math.min(255, l * 255 * 0.945 / warm);
        d[i + 3] = 255;
      }
    }
    g2d.putImageData(img, 0, 0);
  }, { srgb: true, repeat: 1 });

  const rough = ctx.assets.canvasTexture('demo:pave:rough', S, (g2d, size) => {
    const img = g2d.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const k = y * size + x;
        const i = k * 4;
        const grain = n.fbm(x * 0.045, y * 0.045, 3) * 0.5 + 0.5;
        const polish = Math.max(0, n.fbm(x * 0.008 - 7.0, y * 0.008 + 3.0, 2));
        const r = 0.94 - grain * 0.10 - polish * 0.16 + joint[k] * 0.04;
        const v = Math.max(0, Math.min(1, r)) * 255;
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
      }
    }
    g2d.putImageData(img, 0, 0);
  }, { srgb: false, repeat: 1 });

  const normal = ctx.assets.canvasTexture('demo:pave:normal', S, (g2d, size) => {
    const img = g2d.createImageData(size, size);
    const d = img.data;
    const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const dx = (at(x + 1, y) - at(x - 1, y)) * 2.4;
        const dy = (at(x, y + 1) - at(x, y - 1)) * 2.4;
        let nx = -dx, ny = -dy, nz = 1;
        const L = Math.hypot(nx, ny, nz) || 1;
        nx /= L; ny /= L; nz /= L;
        d[i] = (nx * 0.5 + 0.5) * 255;
        d[i + 1] = (ny * 0.5 + 0.5) * 255;
        d[i + 2] = (nz * 0.5 + 0.5) * 255;
        d[i + 3] = 255;
      }
    }
    g2d.putImageData(img, 0, 0);
  }, { srgb: false, repeat: 1 });

  return { albedo, rough, normal };
}

/* ------------------------------------------------------------ urbanness -- */

/**
 * How paved is this square metre? 0 = leave the grass alone.
 * Not a binary: a suburb has driveways and verges, downtown is solid.
 */
const ZONE_PAVE = {
  [ZONE.OFFICE]: 1.00,
  [ZONE.COM_HIGH]: 1.00,
  [ZONE.COM_LOW]: 0.92,
  [ZONE.CIVIC]: 0.90,
  [ZONE.RES_HIGH]: 0.66,
  [ZONE.IND]: 0.95,
  [ZONE.ROAD]: 1.00,
  [ZONE.RES_LOW]: 0.20,
  [ZONE.RESERVED]: 0.30,
  [ZONE.PARK]: 0.0,
  [ZONE.WATER]: 0.0,
  [ZONE.NONE]: 0.0,
};

const ZONE_TINT = {
  [ZONE.IND]: [0.60, 0.59, 0.57],
  [ZONE.OFFICE]: [0.86, 0.86, 0.87],
  [ZONE.COM_HIGH]: [0.84, 0.84, 0.85],
  [ZONE.COM_LOW]: [0.80, 0.79, 0.78],
  [ZONE.CIVIC]: [0.90, 0.89, 0.86],
  [ZONE.RES_HIGH]: [0.74, 0.74, 0.73],
  [ZONE.RES_LOW]: [0.68, 0.68, 0.66],
  [ZONE.ROAD]: [0.78, 0.78, 0.78],
};

/**
 * Build the decal.
 * @returns {{mesh, triangles, cells}} or null
 */
export function buildUrbanGround(ctx, plan, site, opts = {}) {
  const zoning = ctx.get('zoning');
  if (!zoning || typeof zoning.zoneAt !== 'function') return null;
  const roads = ctx.get('roads');
  const b = roads && roads.network ? roads.network().bounds : null;
  if (!b || !Number.isFinite(b.minX)) return null;

  const pad = opts.pad ?? 46;
  const cell = opts.cell ?? 4;
  const x0 = Math.floor((b.minX - pad) / cell) * cell;
  const z0 = Math.floor((b.minZ - pad) / cell) * cell;
  const nx = Math.min(420, Math.ceil((b.maxX + pad - x0) / cell) + 1);
  const nz = Math.min(420, Math.ceil((b.maxZ + pad - z0) / cell) + 1);
  if (nx < 4 || nz < 4) return null;

  const n = new Noise((ctx.world.seed ^ 0x5c1d) >>> 0);
  const raw = new Float32Array(nx * nz);
  const tint = new Float32Array(nx * nz * 3);

  /* Confine paving to the streets. The unowned strip is the one between the
   * kerb and the building line, so stamp a corridor along every carriageway
   * (and around every building) and let the zone only decide how *much* of that
   * corridor is hard. Without this the paving spreads over open country
   * wherever the zone grid happens to be painted. */
  const reach = new Float32Array(nx * nz);
  const stamp = (ax, az, bx, bz, r) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (cell * 0.6)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
      const i0 = Math.max(0, Math.floor((px - r - x0) / cell));
      const i1 = Math.min(nx - 1, Math.ceil((px + r - x0) / cell));
      const j0 = Math.max(0, Math.floor((pz - r - z0) / cell));
      const j1 = Math.min(nz - 1, Math.ceil((pz + r - z0) / cell));
      const r2 = r * r;
      for (let j = j0; j <= j1; j++) {
        const cz = z0 + j * cell;
        for (let i = i0; i <= i1; i++) {
          const cx = x0 + i * cell;
          const d2 = (cx - px) * (cx - px) + (cz - pz) * (cz - pz);
          if (d2 > r2) continue;
          const k = j * nx + i;
          const w = 1 - Math.sqrt(d2) / r;
          if (w > reach[k]) reach[k] = w;
        }
      }
    }
  };

  /* The carriageway itself is `roads`' surface and sits 15 cm proud of the
   * heightfield; paving under it would z-fight through and hide the asphalt.
   * Cut it out of the mask instead — the paving starts at the kerb line, which
   * is exactly the strip that had no owner. */
  const carriage = new Float32Array(nx * nz);
  const cut = (ax, az, bx, bz, r) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (cell * 0.6)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
      const i0 = Math.max(0, Math.floor((px - r - x0) / cell));
      const i1 = Math.min(nx - 1, Math.ceil((px + r - x0) / cell));
      const j0 = Math.max(0, Math.floor((pz - r - z0) / cell));
      const j1 = Math.min(nz - 1, Math.ceil((pz + r - z0) / cell));
      const r2 = r * r;
      for (let j = j0; j <= j1; j++) {
        const cz = z0 + j * cell;
        for (let i = i0; i <= i1; i++) {
          const cx = x0 + i * cell;
          if ((cx - px) * (cx - px) + (cz - pz) * (cz - pz) > r2) continue;
          carriage[j * nx + i] = 1;
        }
      }
    }
  };

  const CORRIDOR = { alley: 13, lane2: 22, lane4: 26, boulevard: 30, highway: 0 };
  const HALF = { alley: 3.0, lane2: 4.5, lane4: 8.0, boulevard: 12.0, highway: 11.0 };
  if (roads.pointAt) {
    for (const s of roads.network().segments.values()) {
      const r = CORRIDOR[s.class] ?? 26;
      const steps = Math.max(2, Math.min(28, Math.ceil(s.length / 18)));
      let prev = roads.pointAt(s.id, 0);
      for (let q = 1; q <= steps; q++) {
        const p = roads.pointAt(s.id, q / steps);
        if (r > 0) stamp(prev.x, prev.z, p.x, p.z, r);
        cut(prev.x, prev.z, p.x, p.z, (HALF[s.class] ?? 4.5) + 1.4);
        prev = p;
      }
    }
  }
  // and the ground each building actually stands on
  for (const b of ctx.world.buildings.values()) {
    if (!b.pos) continue;
    const fp = b.footprint || [16, 14];
    stamp(b.pos[0], b.pos[2], b.pos[0], b.pos[2], Math.max(fp[0], fp[1]) * 0.5 + 5);
  }

  for (let j = 0; j < nz; j++) {
    const z = z0 + j * cell;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * cell;
      const k = j * nx + i;
      let zn = ZONE.NONE;
      try { zn = zoning.zoneAt(x, z); } catch { zn = ZONE.NONE; }
      let a = ZONE_PAVE[zn] ?? 0;
      // the corridor is the hard limit; the zone only says how paved it is
      a *= Math.min(1, reach[k] * 2.9);
      if (carriage[k]) a = 0;
      if (a > 0) {
        if (site.isWater(x, z)) a = 0;
        else if (site.heightAt(x, z) < site.water + 0.6) a = 0;
        else if (site.slopeAt(x, z) > 0.42) a *= 0.25;
      }
      raw[k] = a;
      const t = ZONE_TINT[zn] || [1, 1, 1];
      tint[k * 3] = t[0]; tint[k * 3 + 1] = t[1]; tint[k * 3 + 2] = t[2];
    }
  }

  // blur so the paving does not end on a cell boundary, then break the edge
  const blur = (src, passes) => {
    let a = src, bufr = new Float32Array(src.length);
    for (let p = 0; p < passes; p++) {
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          let s = 0, w = 0;
          for (let dj = -1; dj <= 1; dj++) {
            const jj = j + dj; if (jj < 0 || jj >= nz) continue;
            for (let di = -1; di <= 1; di++) {
              const ii = i + di; if (ii < 0 || ii >= nx) continue;
              const ww = (di === 0 && dj === 0) ? 3 : 1;
              s += a[jj * nx + ii] * ww; w += ww;
            }
          }
          bufr[k] = s / w;
        }
      }
      const t = a; a = bufr; bufr = t;
    }
    return a;
  };
  const mask = blur(raw, 2);
  const tintB = [blur(sliceCh(tint, 0, nx * nz), 1), blur(sliceCh(tint, 1, nx * nz), 1), blur(sliceCh(tint, 2, nx * nz), 1)];

  /* ------------------------------------------------------------- mesh -- */
  const pos = [];
  const uv = [];
  const col = [];
  const nrm = [];
  const index = [];
  const vmap = new Int32Array(nx * nz).fill(-1);

  const alphaAt = (i, j) => {
    const k = j * nx + i;
    const x = x0 + i * cell, z = z0 + j * cell;
    // noisy threshold: the paving edge crumbles into the grass instead of
    // ending on a perfect contour
    const wobble = n.fbm(x * 0.055, z * 0.055, 3) * 0.20;
    return Math.max(0, Math.min(1, (mask[k] + wobble - 0.16) / 0.55));
  };

  const emit = (i, j) => {
    const k = j * nx + i;
    if (vmap[k] >= 0) return vmap[k];
    const x = x0 + i * cell, z = z0 + j * cell;
    const y = site.heightAt(x, z) + LIFT;
    const idx = pos.length / 3;
    pos.push(x, y, z);
    uv.push(x / PAVE_TILE, z / PAVE_TILE);
    const nn = site.t && site.t.normalAt ? site.t.normalAt(x, z, 4) : [0, 1, 0];
    nrm.push(nn[0], nn[1], nn[2]);
    const a = alphaAt(i, j);
    col.push(tintB[0][k], tintB[1][k], tintB[2][k], a);
    vmap[k] = idx;
    return idx;
  };

  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a0 = alphaAt(i, j), a1 = alphaAt(i + 1, j), a2 = alphaAt(i + 1, j + 1), a3 = alphaAt(i, j + 1);
      if (a0 + a1 + a2 + a3 < 0.02) continue;
      const v0 = emit(i, j), v1 = emit(i + 1, j), v2 = emit(i + 1, j + 1), v3 = emit(i, j + 1);
      index.push(v0, v3, v2, v0, v2, v1);
    }
  }
  if (!index.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  geo.setIndex(index);
  geo.computeBoundingSphere();

  const tex = paveTextures(ctx, ctx.world.seed >>> 0);
  const mat = ctx.materials.pbr({
    color: 0xa8a59d,
    roughness: 0.92,
    metalness: 0.0,
    map: tex.albedo,
    normalMap: tex.normal,
    roughnessMap: tex.rough,
    normalScale: 0.75,
    envMapIntensity: 1.0,
    vertexColors: true,
    transparent: true,
  });
  // the cache key is unique to these textures, so tuning the instance is safe
  // NO slope-scaled polygon offset: at an oblique aerial angle it biases this
  // near-horizontal surface far enough forward to win the depth test against
  // the road ribbon 5 cm above it, and the asphalt vanishes under the paving.
  mat.depthWrite = false;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 0;
  mat.polygonOffsetUnits = -2;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'demo:urban-ground';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 1;

  return { mesh, triangles: index.length / 3, cells: nx * nz, nx, nz, cell };
}

function sliceCh(src, ch, count) {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = src[i * 3 + ch];
  return out;
}

export default buildUrbanGround;
