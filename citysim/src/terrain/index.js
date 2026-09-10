import * as THREE from 'three';
import { generate, makeSampler, SITE } from './Heightfield.js';
import { buildLayers, buildWaterNormal } from './layers.js';
import { createTerrainMaterial } from './TerrainMaterial.js';
import { buildTerrainMeshes } from './mesh.js';
import { createWater, PlanarReflection, refreshDepthRegion } from './Water.js';
import { buildControlMap, refreshControlRegion } from './ControlMap.js';
import { FallbackSky, sunDirection } from './fallbackSky.js';

/**
 * terrain — the city site.
 *
 * Owns the heightfield (world.terrain.heights), its LOD mesh, the four-layer
 * procedural splat material, the landform control map and the river surface.
 * Everything downstream (roads, zoning, buildings, props, tools) grounds itself
 * through the API below.
 */

const S = {
  ready: false,
  sampler: null,
  material: null,
  layers: null,
  meshes: [],
  updateRegion: null,
  water: null,
  reflection: null,
  ctl: null,
  sky: null,
  river: null,
  corridor: null,       // Uint8Array on the heightfield lattice
  genMs: 0,
  buildMs: 0,
  triangles: 0,
  wet: 0,
  variant: 'default',
  waterLevel: 0,
  sunDir: new THREE.Vector3(0.4, 0.7, 0.55).normalize(),
  ctxRef: null,
  edits: 0,
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function installLighting(ctx) {
  if (S.sky) return;
  if (ctx.get('environment')) return;              // the real thing exists — stand down
  let hasSun = false;
  ctx.scene.traverse((o) => { if (o.isDirectionalLight) hasSun = true; });
  if (hasSun) return;
  S.sky = new FallbackSky(ctx);
  S.sky.setTime(ctx.world.time.hours);
  ctx.log.warn('no environment module — terrain installed its own temporary sun/sky/IBL so the material is judgeable');
}

/**
 * `environment` now publishes the real solar vector on `time:changed` (R-5,
 * delivered in integrator pass 5), so the water glint sits on the light that is
 * actually in the scene instead of on a model we re-derived and hoped matched.
 */
function applyTime(ctx, payload = {}) {
  const hours = payload.hours ?? ctx.world.time.hours;
  const info = S.sky ? S.sky.setTime(hours) : null;
  if (!S.water) return;
  const u = S.water.uniforms;

  let elev = payload.elevation;
  let night = payload.isNight;
  let dir = null;

  if (payload.sunDir) {
    const d = payload.sunDir;
    dir = new THREE.Vector3(d.x ?? d[0], d.y ?? d[1], d.z ?? d[2]);
  }
  if (elev === undefined) {
    const solar = sunDirection(hours);
    elev = Math.asin(Math.max(-1, Math.min(1, solar.y))) * 180 / Math.PI;
    if (!dir) dir = solar;
  }
  if (night === undefined) night = elev < -1.5;
  if (night && payload.moonDir) {
    const d = payload.moonDir;
    dir = new THREE.Vector3(d.x ?? d[0], d.y ?? d[1], d.z ?? d[2]);
  } else if (night && !payload.moonDir) {
    dir = (dir || sunDirection(hours)).clone().multiplyScalar(-1);
  }
  if (info) dir = info.sun;
  if (!dir) dir = sunDirection(hours);

  S.sunDir.copy(dir).normalize();
  u.uSunDir.value.copy(S.sunDir);
  u.uNight.value = night ? 1 : 0;

  if (night) {
    u.uSunTint.value.setRGB(0.42, 0.55, 0.86);
    u.uGlintPow.value = 48;
    u.uGlintInt.value = 2.2;
    u.uShallow.value.setRGB(0.030, 0.055, 0.062);
    u.uDeep.value.setRGB(0.008, 0.016, 0.026);
    u.uFoamCol.value.setRGB(0.055, 0.075, 0.095);
    u.uWaveAmp.value = 0.45;
  } else {
    const warm = Math.max(0, Math.min(1, (16 - elev) / 15));
    if (payload.sunColor) {
      const c = payload.sunColor;
      u.uSunTint.value.setRGB(c.r ?? c[0] ?? 1, c.g ?? c[1] ?? 1, c.b ?? c[2] ?? 1);
    } else {
      u.uSunTint.value.setRGB(1.0, 1.0 - 0.35 * warm, 1.0 - 0.62 * warm);
    }
    // A low sun makes a BROAD glitter path, not a tight highlight: the specular
    // lobe has to widen as the sun drops or the river just reads as grey mud.
    u.uGlintPow.value = 320 - 250 * warm;
    u.uGlintInt.value = 3.2 + 9.0 * warm;
    u.uShallow.value.setRGB(0.055, 0.148, 0.132).multiplyScalar(0.6 + 0.4 * Math.min(1, elev / 25 + 0.4));
    u.uDeep.value.setRGB(0.008, 0.030, 0.046);
    u.uFoamCol.value.setRGB(0.50, 0.56, 0.56);
    u.uWaveAmp.value = 0.62;
  }
}

function applyWeather(ctx) {
  const w = ctx.world.weather || {};
  S.wet = Math.max(0, Math.min(1, w.wetness || 0));
  if (S.material) S.material.userData.uniforms.uWetness.value = S.wet;
  if (S.water) {
    S.water.uniforms.uWind.value.set(
      0.55 + Math.cos(w.windDir || 0) * (0.35 + 0.08 * (w.windSpeed || 3)),
      0.30 + Math.sin(w.windDir || 0) * (0.35 + 0.08 * (w.windSpeed || 3))
    );
  }
}

/** Is any water under the camera frustum? Skips the reflection pass if not. */
const _rayPts = [[0, 0], [-0.75, -0.75], [0.75, -0.75], [-0.75, 0.6], [0.75, 0.6], [0, -0.9], [0, 0.7]];
const _v = new THREE.Vector3();
const _o = new THREE.Vector3();
function waterInView(camera, group) {
  if (!S.sampler) return false;
  const half = S.sampler.half, wy = S.waterLevel + group.position.y;
  _o.setFromMatrixPosition(camera.matrixWorld);
  if (_o.y <= wy) return false;
  for (const [nx, ny] of _rayPts) {
    _v.set(nx, ny, 0.5).unproject(camera).sub(_o);
    if (_v.y >= -1e-4) continue;
    const t = (wy - _o.y) / _v.y;
    if (t <= 0 || t > 7000) continue;
    const hx = _o.x + _v.x * t - group.position.x;
    const hz = _o.z + _v.z * t - group.position.z;
    if (Math.abs(hx) > half || Math.abs(hz) > half) continue;
    if (S.sampler.heightAt(hx, hz) < S.waterLevel - 0.05) return true;
  }
  return false;
}

/** Lattice index box for a world-space AABB, padded. */
function latticeBox(box, pad = 2) {
  const { n, half, step } = S.sampler;
  return {
    i0: Math.max(0, Math.floor((box.minX + half) / step) - pad),
    j0: Math.max(0, Math.floor((box.minZ + half) / step) - pad),
    i1: Math.min(n - 1, Math.ceil((box.maxX + half) / step) + pad),
    j1: Math.min(n - 1, Math.ceil((box.maxZ + half) / step) + pad),
  };
}

/** Push a heightfield edit through mesh, depth texture, control map and events. */
function publishEdit(box) {
  if (!S.sampler || !box) return 0;
  const lb = latticeBox(box, 3);
  const touched = S.updateRegion ? S.updateRegion(box) : 0;
  if (S.water) refreshDepthRegion(S.ctxRef.world, S.water.depth, lb.i0, lb.j0, lb.i1, lb.j1);
  if (S.ctl) refreshControlRegion(S.ctxRef.world, S.ctl, lb.i0, lb.j0, lb.i1, lb.j1);
  S.ctxRef.world.terrain.version = (S.ctxRef.world.terrain.version || 0) + 1;
  S.edits++;
  return touched;
}

/**
 * Coarse search for a patch that shows off the splat: mid altitude, and a wide
 * spread of local slopes so grass, dry soil and cliff rock all appear in one
 * frame. Cheap enough (~17k height samples) to run inside showcase().
 */
function findDetailSpot() {
  if (!S.sampler) return null;
  const h = S.sampler.heightAt;
  const slope = (x, z) => {
    const e = 4;
    const nx = h(x - e, z) - h(x + e, z), nz = h(x, z - e) - h(x, z + e), ny = 2 * e;
    const L = Math.hypot(nx, ny, nz), c = ny / L;
    return Math.sqrt(Math.max(0, 1 - c * c)) / c;
  };
  let best = null;
  for (let z = -720; z <= 720; z += 32) {
    for (let x = -720; x <= 720; x += 32) {
      const d = Math.hypot(x - SITE.basinCx, z - SITE.basinCz);
      if (d < 240 || d > 720) continue;
      const hh = h(x, z);
      if (hh < 14 || hh > 80) continue;
      let lo = 1e9, hi = -1e9, mn = 9, mx = 0, sum = 0, n = 0;
      for (let dz = -60; dz <= 60; dz += 20) {
        for (let dx = -60; dx <= 60; dx += 20) {
          const g = h(x + dx, z + dz);
          if (g < lo) lo = g;
          if (g > hi) hi = g;
        }
      }
      if (lo < 4 || hi - lo > 26) continue;
      for (let dz = -16; dz <= 16; dz += 16) {
        for (let dx = -16; dx <= 16; dx += 16) {
          const v = slope(x + dx, z + dz);
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          sum += v; n++;
        }
      }
      const avg = sum / n;
      if (mx > 1.1) continue;
      const score = Math.min(mx, 0.9) * 1.6 + (mx - mn) - Math.abs(avg - 0.34) * 2.2;
      if (!best || score > best.score) best = { x, z, h: hh, min: mn, max: mx, score };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */

export default {
  name: 'terrain',
  version: '2.0.0',
  dependsOn: [],
  provides: [
    'heightAt', 'normalAt', 'slopeAt', 'raycastGround', 'isWater', 'bounds',
    'flattenAlong', 'applyHeightPatch', 'rebuildRegion', 'setHeights', 'stats',
  ],

  async init(ctx) {
    const t0 = performance.now();
    const world = ctx.world;
    S.ctxRef = ctx;

    /* 1 — heightfield ------------------------------------------------ */
    const gen = generate(world, ctx.rng, ctx.log);
    S.genMs = gen.ms;
    S.river = gen.poly;
    S.riverStep = gen.polyStep;
    S.riverX0 = -world.terrain.size / 2 - 300;
    S.waterLevel = world.terrain.water;
    S.sampler = makeSampler(world.terrain);
    S.corridor = new Uint8Array(world.terrain.resolution * world.terrain.resolution);

    /* 2 — landform control map (drainage, curvature, parcels, rock) --- */
    S.ctl = buildControlMap(world, world.seed, ctx.log);

    /* 3 — procedural PBR layers -------------------------------------- */
    const tTex = performance.now();
    S.layers = buildLayers(ctx.assets, world.seed);
    const waterN = buildWaterNormal(ctx.assets, world.seed);
    const texMs = performance.now() - tTex;

    /* 4 — material + LOD mesh ---------------------------------------- */
    S.material = createTerrainMaterial(S.layers, S.ctl.tex, {
      waterLevel: world.terrain.water,
      size: world.terrain.size,
      scales: new THREE.Vector4(1 / 4.0, 1 / 3.2, 1 / 6.5, 1 / 2.6),
      normalStrength: 0.95,
    });

    const inCorridor = (x, z) => {
      const { n, half, step } = S.sampler;
      const i = Math.round((x + half) / step), j = Math.round((z + half) / step);
      if (i < 0 || j < 0 || i >= n || j >= n) return false;
      return S.corridor[j * n + i] !== 0;
    };

    const tMesh = performance.now();
    const built = buildTerrainMeshes(S.sampler.heightAt, S.material, inCorridor);
    S.meshes = built.meshes;
    S.triangles = built.triangles;
    S.updateRegion = built.updateRegion;
    for (const m of S.meshes) ctx.group.add(m);
    S.buildMs = performance.now() - tMesh;

    /* 5 — water ------------------------------------------------------- */
    S.water = createWater(world, waterN, { extent: 3400, segments: 64 });
    ctx.group.add(S.water.mesh);
    S.water.mesh.updateMatrixWorld(true);
    try {
      S.reflection = new PlanarReflection(ctx.renderer, S.water.mesh, S.water.uniforms, world.terrain.water);
    } catch (err) {
      ctx.log.warn('planar reflection unavailable, falling back to IBL only:', err.message);
      S.reflection = null;
    }

    /* 6 — join the core shader-patch chain (integrator pass 5) --------
       so environment's CSM cascades and props' clustered lights compose with
       our own onBeforeCompile instead of overwriting it. */
    if (ctx.materials.adopt) {
      try {
        ctx.materials.adopt(S.material, { depth: true });
        ctx.materials.adopt(S.water.material);
        for (const m of S.meshes) ctx.materials.adoptMesh?.(m);
      } catch (err) {
        ctx.log.warn('materials.adopt failed, running unpatched:', err.message);
      }
    }

    /* 7 — lighting fallback (only when `environment` is absent) -------- */
    installLighting(ctx);

    /* 8 — wiring ------------------------------------------------------ */
    ctx.events.on('time:changed', (p) => applyTime(ctx, p), 'terrain');
    ctx.events.on('weather:changed', () => applyWeather(ctx), 'terrain');
    ctx.events.on('resize', ({ w, h }) => S.reflection?.setSize(w, h), 'terrain');

    applyTime(ctx, { hours: world.time.hours });
    applyWeather(ctx);

    S.ready = true;
    const total = performance.now() - t0;
    ctx.log.info(
      `ready in ${total.toFixed(0)} ms — heightfield ${S.genMs.toFixed(0)} ms, ` +
      `control ${S.ctl.ms.toFixed(0)} ms, textures ${texMs.toFixed(0)} ms, mesh ${S.buildMs.toFixed(0)} ms, ` +
      `${S.triangles.toLocaleString()} tris in ${S.meshes.length} LOD rings + water` +
      `${S.reflection ? ' + planar reflection' : ''}`
    );

    ctx.events.emit('terrain:changed', { bounds: this.bounds() });
  },

  update(ctx, dt, elapsed) {
    if (S.water) S.water.uniforms.uTime.value = elapsed;
    if (S.reflection && ctx.group.visible) {
      if (waterInView(ctx.camera, ctx.group)) S.reflection.update(ctx.scene, ctx.camera);
      else S.water.uniforms.uReflStrength.value = 0;
    }
  },

  /** The host calls this when a dependency changed; re-upload the whole ground. */
  rebuild(ctx, what) {
    if (!S.ready || !S.updateRegion) return;
    if (what && what !== 'terrain' && what !== 'all') return;
    const b = this.bounds();
    publishEdit({ minX: b.minX, minZ: b.minZ, maxX: b.maxX, maxZ: b.maxZ });
    ctx.events.emit('terrain:changed', { bounds: b, reason: 'rebuild' });
  },

  /* ---------------- public API (ctx.get('terrain')) ---------------- */

  /** Exact bilinear height of the heightfield at world (x,z), metres. */
  heightAt(x, z) {
    return S.sampler ? S.sampler.heightAt(x, z) : 0;
  },

  /** Unit surface normal as [x,y,z]. */
  normalAt(x, z, eps = 3) {
    if (!S.sampler) return [0, 1, 0];
    const h = S.sampler.heightAt;
    const nx = h(x - eps, z) - h(x + eps, z);
    const nz = h(x, z - eps) - h(x, z + eps);
    const ny = 2 * eps;
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx / len, ny / len, nz / len];
  },

  /** Ground gradient (rise/run, i.e. tan of the slope angle). 0 = dead flat. */
  slopeAt(x, z, eps = 3) {
    const n = this.normalAt(x, z, eps);
    const ny = Math.max(1e-4, n[1]);
    return Math.sqrt(Math.max(0, 1 - ny * ny)) / ny;
  },

  /** True where the terrain surface is below the water level. */
  isWater(x, z) {
    return S.sampler ? S.sampler.heightAt(x, z) < (S.waterLevel ?? 0) + 0.001 : false;
  },

  /**
   * March a ray against the heightfield.
   * @param {{x,y,z}} origin @param {{x,y,z}} dir (need not be normalised)
   * @returns {{x,y,z,distance}|null}
   */
  raycastGround(origin, dir, maxDist = 6000) {
    if (!S.sampler) return null;
    const h = S.sampler.heightAt;
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const dx = dir.x / len, dy = dir.y / len, dz = dir.z / len;
    let t = 0, step = 2.0;
    let prevT = 0;
    const prevDiff = origin.y - h(origin.x, origin.z);
    if (prevDiff <= 0) return { x: origin.x, y: origin.y, z: origin.z, distance: 0 };
    while (t < maxDist) {
      t += step;
      step = Math.min(24, step * 1.06);
      const px = origin.x + dx * t, py = origin.y + dy * t, pz = origin.z + dz * t;
      if (py - h(px, pz) <= 0) {
        let lo = prevT, hi = t;
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) * 0.5;
          const mx = origin.x + dx * mid, my = origin.y + dy * mid, mz = origin.z + dz * mid;
          if (my - h(mx, mz) > 0) lo = mid; else hi = mid;
        }
        const ft = (lo + hi) * 0.5;
        return { x: origin.x + dx * ft, y: origin.y + dy * ft, z: origin.z + dz * ft, distance: ft };
      }
      prevT = t;
    }
    return null;
  },

  bounds() {
    const T = S.sampler;
    const half = T ? T.half : 1024;
    return {
      minX: -half, maxX: half, minZ: -half, maxZ: half,
      size: half * 2,
      resolution: T ? T.n : 513,
      cellSize: T ? T.step : 4,
      water: S.waterLevel ?? 0,
      basin: { x: SITE.basinCx, z: SITE.basinCz, radius: SITE.basinR0 },
    };
  },

  /**
   * R-6 / R-tools-5. Stamp road corridors into the heightfield and re-upload
   * the affected LOD ring vertices, so roads sit in cuttings and on embankments
   * instead of on unexplained graded shelves.
   *
   * @param {Array} polylines  array of polylines; each is an array of points,
   *        `{x,y,z}` or `[x,y,z]` / `[x,z]`. A `y` on a point is taken as the
   *        desired carriageway level; without one the local ground is smoothed.
   * @param {object} [opts] `width` (m, default 9), `falloff` (m, default 14),
   *        `maxCut` / `maxFill` clamps in metres.
   * @returns {{cells:number, verts:number, ms:number}}
   */
  flattenAlong(polylines, opts = {}) {
    if (!S.sampler || !polylines) return { cells: 0, verts: 0, ms: 0 };
    const t0 = performance.now();
    const { width = 9, falloff = 14, maxCut = 14, maxFill = 14 } = opts;
    const lines = Array.isArray(polylines[0]) || polylines[0]?.x !== undefined
      ? (Array.isArray(polylines[0]) && typeof polylines[0][0] === 'number' ? [polylines] : polylines)
      : polylines;

    const T = S.ctxRef.world.terrain;
    const n = T.resolution, half = T.size / 2, step = T.size / (n - 1);
    const h = T.heights;
    const halfW = width * 0.5, reach = halfW + falloff;

    if (!S._acc || S._acc.length !== n * n) {
      S._acc = new Float32Array(n * n);
      S._accW = new Float32Array(n * n);
      S._dirtyList = new Int32Array(n * n);
    }
    const acc = S._acc, accW = S._accW, dirty = S._dirtyList;
    let dn = 0;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

    const px = (p) => (Array.isArray(p) ? p[0] : p.x);
    const pz = (p) => (Array.isArray(p) ? (p.length > 2 ? p[2] : p[1]) : p.z);
    const py = (p) => (Array.isArray(p) ? (p.length > 2 ? p[1] : undefined) : p.y);

    for (const line of lines) {
      if (!line || line.length < 2) continue;
      for (let s = 0; s < line.length - 1; s++) {
        const ax = px(line[s]), az = pz(line[s]), ay = py(line[s]);
        const bx = px(line[s + 1]), bz = pz(line[s + 1]), by = py(line[s + 1]);
        if (!isFinite(ax) || !isFinite(bx)) continue;
        const ex = bx - ax, ez = bz - az;
        const el2 = ex * ex + ez * ez;
        if (el2 < 1e-6) continue;

        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach + half) / step));
        const i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx) + reach + half) / step));
        const j0 = Math.max(0, Math.floor((Math.min(az, bz) - reach + half) / step));
        const j1 = Math.min(n - 1, Math.ceil((Math.max(az, bz) + reach + half) / step));

        for (let j = j0; j <= j1; j++) {
          const z = -half + j * step;
          for (let i = i0; i <= i1; i++) {
            const x = -half + i * step;
            let t = ((x - ax) * ex + (z - az) * ez) / el2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = x - (ax + ex * t), qz = z - (az + ez * t);
            const d = Math.hypot(qx, qz);
            if (d > reach) continue;

            const k = j * n + i;
            // profile height at the projected point
            let target;
            if (ay !== undefined && by !== undefined) target = ay + (by - ay) * t;
            else target = h[k];

            // 1 in the carriageway, easing to 0 at the far edge of the batter
            const w = 1 - smoother(Math.max(0, Math.min(1, (d - halfW) / falloff)));
            if (w <= 0.0005) continue;
            if (accW[k] === 0) { dirty[dn++] = k; }
            acc[k] += target * w;
            accW[k] += w;
            if (d <= halfW + falloff * 0.55) S.corridor[k] = 1;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
          }
        }
      }
    }

    let changed = 0;
    for (let d = 0; d < dn; d++) {
      const k = dirty[d];
      const w = Math.min(1, accW[k]);
      const target = acc[k] / accW[k];
      acc[k] = 0; accW[k] = 0;
      let want = h[k] + (target - h[k]) * w;
      const delta = want - h[k];
      if (delta < -maxCut) want = h[k] - maxCut;
      else if (delta > maxFill) want = h[k] + maxFill;
      if (Math.abs(want - h[k]) < 1e-4) continue;
      h[k] = want;
      changed++;
    }

    let verts = 0;
    if (changed) verts = publishEdit({ minX, minZ, maxX, maxZ });
    const ms = performance.now() - t0;
    S.ctxRef.log.info(`flattenAlong: ${changed} cells, ${verts} ring vertices in ${ms.toFixed(1)} ms`);
    return { cells: changed, verts, ms };
  },

  /** R-tools-5. Re-upload ring geometry after somebody mutated `heights`. */
  applyHeightPatch(box) {
    if (!box) return 0;
    const b = {
      minX: box.minX ?? box.x0 ?? -Infinity, maxX: box.maxX ?? box.x1 ?? Infinity,
      minZ: box.minZ ?? box.z0 ?? -Infinity, maxZ: box.maxZ ?? box.z1 ?? Infinity,
    };
    const g = this.bounds();
    b.minX = Math.max(b.minX, g.minX); b.maxX = Math.min(b.maxX, g.maxX);
    b.minZ = Math.max(b.minZ, g.minZ); b.maxZ = Math.min(b.maxZ, g.maxZ);
    const verts = publishEdit(b);
    S.ctxRef?.events.emit('terrain:changed', { bounds: g, reason: 'edit', region: b });
    return verts;
  },

  rebuildRegion(box) { return this.applyHeightPatch(box); },

  /**
   * Write heights directly. `fn(x, z, current)` returns the new height, or pass
   * a Float32Array of the full lattice.
   */
  setHeights(fn, box) {
    if (!S.sampler) return 0;
    const T = S.ctxRef.world.terrain;
    const n = T.resolution, half = T.size / 2, step = T.size / (n - 1), h = T.heights;
    const b = box || { minX: -half, maxX: half, minZ: -half, maxZ: half };
    if (fn && fn.length !== undefined && typeof fn !== 'function') {
      h.set(fn.subarray ? fn.subarray(0, h.length) : fn);
    } else if (typeof fn === 'function') {
      const lb = latticeBox(b, 0);
      for (let j = lb.j0; j <= lb.j1; j++) {
        for (let i = lb.i0; i <= lb.i1; i++) {
          const k = j * n + i;
          const v = fn(-half + i * step, -half + j * step, h[k]);
          if (isFinite(v)) h[k] = v;
        }
      }
    }
    return this.applyHeightPatch(b);
  },

  stats() {
    return {
      triangles: S.triangles,
      rings: S.meshes.length,
      drawCalls: S.meshes.length + (S.water ? 1 : 0),
      reflectionCalls: S.reflection ? S.reflection.lastCalls : 0,
      reflectionActive: !!(S.water && S.water.uniforms.uReflStrength.value > 0),
      edits: S.edits,
      genMs: Math.round(S.genMs),
    };
  },

  /* ---------------- showcase ---------------- */

  showcase(ctx, variant = 'default') {
    S.variant = variant;
    installLighting(ctx);
    ctx.group.position.set(0, 0, 0);

    // The camera presets the harness uses are pinned to the world origin, so the
    // only way to frame a specific feature is to slide the site under them. The
    // splat and the water both index in TERRAIN space, so this no longer moves
    // the material off the landform (round 1 bug).
    if (variant === 'closeup') {
      const p = findDetailSpot();
      if (p) {
        ctx.group.position.set(-p.x, -(p.h - 3.5), -p.z);
        ctx.log.info(`showcase:closeup — framing (${p.x | 0}, ${p.z | 0}) h=${p.h.toFixed(1)} m, slope ${p.min.toFixed(2)}..${p.max.toFixed(2)}`);
      }
    }

    if (variant === 'water' && S.river) {
      const px = 60;
      const p = Math.round((px - S.riverX0) / S.riverStep);
      const pz = S.river[Math.min(S.river.length / 2 - 1, Math.max(0, p)) * 2 + 1];
      ctx.group.position.set(-px, 0, -pz - 40);
      ctx.log.info(`showcase:water — framing the river bank at (${px | 0}, ${pz | 0})`);
    }

    ctx.group.updateMatrixWorld(true);
    applyTime(ctx, { hours: ctx.world.time.hours });
    applyWeather(ctx);
    return true;
  },

  dispose(ctx) {
    ctx.events.offOwner('terrain');
    for (const m of S.meshes) { m.geometry.dispose(); m.removeFromParent(); }
    S.meshes.length = 0;
    S.material?.dispose();
    S.reflection?.dispose();
    if (S.water) {
      S.water.mesh.geometry.dispose();
      S.water.material.dispose();
      S.water.depthTex.dispose();
      S.water.mesh.removeFromParent();
    }
    S.ctl?.tex.dispose();
    S.sky?.dispose();
    S.sky = null;
    S.water = null;
    S.reflection = null;
    S.material = null;
    S.ready = false;
  },
};

function smoother(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * t * (t * (t * 6 - 15) + 10);
}
