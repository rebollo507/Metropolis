# ARCHITECTURE.md — Metropolis (working title)

> **Scope assumption (stated, not asked).** The project goal line says "Sims 4", but every
> named subsystem (terrain, roads, zoning, buildings, traffic, demo city) and the entire
> critic rubric reference **Cities: Skylines II**. This is therefore built as a
> **city-builder**: top-down/orbital camera, road network, zoned districts, simulated
> traffic and citizens, day/night city. Interior/character sim is explicitly out of scope.

---

## 0. Non-negotiables

| Rule | Value |
|---|---|
| Units | **metres**, right-handed, **+Y up**, +Z south / −Z north |
| Time | seconds (float). Sim ticks at fixed 20 Hz, render decoupled |
| Determinism | **seeded RNG only.** `Math.random` is banned; lint rule enforces it |
| Perf budget | **≥50 fps @ 1920×1080**, **≤1500 draw calls**, ≤600 MB GPU |
| Art bar | photographic PBR, physically plausible sun/sky, atmospheric depth. **Never programmer art** |
| Assets | **CC0 only** — Poly Haven, ambientCG, or procedurally generated in-repo |
| Failure isolation | one broken module must never take the app down |
| Availability | the dev server stays up and `/` stays loadable at all times |

---

## 1. Repository layout

```
/
├── ARCHITECTURE.md              this file — the contract
├── index.html                   single entry, no bundler magic
├── vite.config.js
├── package.json
├── docs/
│   ├── STATUS.json              live scoreboard: per-module score, round, open issues
│   ├── CORE_REQUESTS.md         builders append core-change requests here
│   └── shots/                   verification PNGs + JSON logs (gitignored)
├── tools/
│   ├── shoot.mjs                headless-Chromium screenshot + metrics harness
│   ├── gauntlet.mjs             batch: every module × every preset
│   └── contract-check.mjs       static check that each module exports the required API
├── public/
│   └── assets/                  CC0 textures/HDRIs (fetched, not committed)
└── src/
    ├── main.js                  boot: reads URL params, builds Engine, registers modules
    ├── core/                    ◀ ONLY the integrator agent may edit this folder
    │   ├── Engine.js            renderer, clock, frame loop, resize, stats
    │   ├── ModuleHost.js        registry + lifecycle + failure isolation
    │   ├── World.js             the shared world data model (single source of truth)
    │   ├── Events.js            typed event bus
    │   ├── Rng.js               seeded PRNG (sfc32) + noise
    │   ├── CameraRig.js         orbital/free camera + named presets
    │   ├── Materials.js         shared PBR material factory + texture cache
    │   ├── Registry.js          shared geometry/material/instance pools
    │   ├── Showcase.js          per-module showcase router
    │   └── Diagnostics.js       window.__GAME__ probe surface for the harness
    ├── terrain/
    ├── environment/             sky, sun, weather, fog, HDRI, water
    ├── roads/
    ├── zoning/
    ├── buildings/
    ├── props/
    ├── traffic/
    ├── effects/                 post-processing, particles, lights-at-night
    ├── simulation/              population, economy, demand, agents
    ├── tools/                   in-game build tools (road drawing, zone painting)
    ├── ui/
    ├── audio/
    └── demo/                    the showcase city that composes everything
```

**Ownership rule.** A builder agent may create/modify files **only inside its own module
folder**. Anything it needs from `src/core/` is appended as a numbered request to
`docs/CORE_REQUESTS.md`; only the **integrator** agent edits `src/core/`.

---

## 2. Shared world data model (`src/core/World.js`)

One plain, serialisable object graph. No Three.js objects inside it — rendering is a
*projection* of this data. This is what makes determinism and headless testing possible.

```js
World = {
  seed: 1337,
  time: { day: 0, hours: 13.5, speed: 1, paused: false },   // hours ∈ [0,24)
  weather: { preset: 'clear', wetness: 0, windDir: 0.7, windSpeed: 3.2 },

  terrain: {
    size: 2048,            // metres per side
    resolution: 513,       // heightfield samples per side (2^n+1)
    heights: Float32Array, // metres, row-major, length resolution²
    water: 0,              // sea level, metres
    biome: 'temperate',
  },

  // Road network as a graph. Everything downstream (zoning, traffic, props) reads it.
  roads: {
    nodes: Map<id, { id, pos:[x,y,z], type, degree }>,
    segments: Map<id, { id, a:nodeId, b:nodeId, class:'lane2'|'lane4'|'highway'|'alley',
                        curve:[p0,p1,p2,p3], length, elevation }>,
    version: 0,            // bumped on any mutation → consumers rebuild
  },

  zoning: {
    cells: Uint8Array,     // grid over the map, enum ZONE
    cellSize: 8,           // metres
    gridW, gridH,
    version: 0,
  },

  buildings: Map<id, { id, lot:[cells], footprint, height, levels, kind, zone,
                       rotation, address:{segmentId,t}, seed, state }>,

  agents: {               // traffic + pedestrians, fixed-capacity typed arrays
    count, pos:Float32Array, vel:Float32Array, kind:Uint8Array, path:Int32Array,
  },

  stats: { population, jobs, happiness, budget, demand:{r,c,i}, traffic },
}
```

`World` exposes only: `create(seed)`, `serialize()`, `deserialize(json)`,
`hash()` (for determinism assertions) and mutation helpers that bump the right `version`.

---

## 3. The module contract

Every module folder exports a default object from `src/<name>/index.js`:

```js
export default {
  name: 'terrain',
  version: '1.0.0',
  dependsOn: ['core'],            // module names; host orders init by this
  provides: ['heightAt', 'raycastGround'],

  /** Called once. MUST NOT throw; MUST return within 5 s. */
  async init(ctx) {},

  /** Called when a dependency's data version changed. Optional. */
  rebuild(ctx, what) {},

  /** Fixed 20 Hz simulation step. dt is always 0.05. Optional. */
  tick(ctx, dt) {},

  /** Per-frame visual update. Keep allocation-free. Optional. */
  update(ctx, dt, elapsed) {},

  /** Stage a self-contained scene demonstrating ONLY this module. */
  showcase(ctx, variant = 'default') {},

  /** Release GPU resources. Must leave zero leaked textures/geometries. */
  dispose(ctx) {},
}
```

### `ctx` — everything a module is allowed to touch

```js
ctx = {
  world,          // the World object above (read freely; mutate only your own slice)
  scene,          // THREE.Scene
  group,          // THREE.Group owned by THIS module — add everything here
  renderer, camera, cameraRig,
  events,         // ctx.events.on/off/emit
  rng,            // ctx.rng.next() / range(a,b) / int(n) / pick(arr) — seeded per module
  materials,      // ctx.materials.pbr({...}) — cached, shared, sRGB-correct
  registry,       // shared geometry/instanced-mesh pools
  assets,         // ctx.assets.texture(url) / hdri(url) — cached, CC0 manifest-checked
  log,            // namespaced logger; log.error() is what the critic counts
  get: (name) => moduleApi,   // typed access to another module's `provides`
}
```

**Failure isolation.** `ModuleHost` wraps `init/tick/update/rebuild/showcase/dispose` in
try/catch. First throw → module marked `FAILED`, its `group` hidden, error pushed to
`window.__GAME__.errors`, and it is skipped for the rest of the session. The app keeps
rendering. `Diagnostics` reports `modules: {name: 'ok'|'failed', error}`.

---

## 4. Events (`src/core/Events.js`)

Emitters are authoritative; nobody mutates another module's slice directly.

| Event | Payload | Emitted by | Typical consumers |
|---|---|---|---|
| `world:ready` | `{world}` | core | all |
| `terrain:changed` | `{bounds}` | terrain | roads, zoning, props, buildings, water |
| `roads:changed` | `{version, added, removed}` | roads | zoning, buildings, traffic, props |
| `zoning:changed` | `{version, cells}` | zoning | buildings, simulation |
| `buildings:spawned` | `{ids}` | buildings | props, effects, simulation, audio |
| `buildings:removed` | `{ids}` | buildings | props, traffic |
| `time:changed` | `{hours, day}` | environment | effects, buildings (window lights), audio, traffic |
| `weather:changed` | `{preset, wetness}` | environment | effects, materials, audio |
| `sim:tick` | `{tick, stats}` | simulation | ui, traffic |
| `camera:preset` | `{name}` | cameraRig | effects (DOF), ui |
| `tool:selected` | `{tool}` | ui | tools |
| `module:failed` | `{name, error}` | core | ui (badge), diagnostics |

---

## 5. Determinism

* `src/core/Rng.js` implements **sfc32** seeded from `World.seed`. Each module receives a
  *derived* stream: `rng = Rng.derive(seed, moduleName)` — so adding a module never shifts
  another module's sequence.
* Noise: seeded simplex/value noise in the same file. No `Math.random`, no `Date.now()` in
  generation paths (only in the render clock).
* `World.hash()` (FNV-1a over the serialised model) must be identical for identical seed +
  identical action log. `tools/gauntlet.mjs` asserts this across two loads.

---

## 6. Performance budget & how it is met

| Technique | Where |
|---|---|
| `InstancedMesh` for every repeated element | buildings, props, traffic, trees |
| Geometry merging per city block | buildings shells, road decals |
| Texture atlases + `KTX2`/basis where available; shared `Materials` cache | all |
| 3-tier LOD + frustum + distance culling driven by `CameraRig` | buildings, props, traffic |
| Cascaded shadow maps, 3 cascades, tight fit to view frustum | environment |
| Render targets at device pixel ratio capped to 1.5 | core |
| Fixed 20 Hz sim, interpolated render transforms | simulation, traffic |

Hard numbers are asserted by the harness: `fps < 50` or `drawCalls > 1500` is a **fail**,
reported in `docs/STATUS.json`, not silently tolerated.

---

## 7. Asset policy

> **Measured constraint (2026-09-03):** this build environment's egress proxy **blocks
> polyhaven.org and ambientcg.com**. Every texture, HDRI and mesh is therefore
> **generated procedurally in-repo** — canvas/DataTexture albedo-normal-roughness sets,
> an analytic Hosek-Wilkie-style sky, and code-built geometry. This is fully inside the
> CC0 policy (option 3) and removes the runtime download failure mode entirely. If the
> proxy is opened later, `Assets.texture()` already prefers a real file when present.

* **CC0 only**: [Poly Haven](https://polyhaven.com) (HDRIs, PBR textures),
  [ambientCG](https://ambientcg.com) (PBR textures), or generated procedurally in-repo.
* Every downloaded file is recorded in `public/assets/MANIFEST.json` with source URL,
  licence and SHA-256. `tools/contract-check.mjs` fails the build on an unlisted asset.
* No third-party model rips, no textures of unclear provenance, ever.
* Everything must degrade: if an HDRI 404s, `environment` falls back to its procedural
  physical sky and logs a warning — not an error.

---

## 8. Verification loop (built *before* the game)

`node tools/shoot.mjs --module=buildings --preset=street --time=19.5 --out=docs/shots/…`

1. Boots Vite preview, opens headless Chromium with WebGL2 (ANGLE/SwiftShader).
2. Navigates to `/?showcase=<module>&variant=<v>&seed=<s>&time=<h>&preset=<cam>`.
3. Waits for `window.__GAME__.ready === true` (or fails after 30 s).
4. Warms 60 frames, samples fps and `renderer.info` over 120 frames.
5. Writes `<out>.png` and `<out>.json`:
   `{module, preset, time, ready, fps, drawCalls, triangles, textures, programs,
     consoleErrors:[], moduleStates:{}, worldHash}`.

**Rule: no agent may claim a module works without taking a screenshot and looking at it.**

`tools/gauntlet.mjs` runs the full matrix (every module × {dawn 06:30, noon 13:00,
golden 18:45, night 22:00} × {aerial, street, closeup}) and updates `docs/STATUS.json`.

---

## 9. Build order (waves)

* **Wave 1** — no cross-module deps: `terrain`, `environment`, `roads`, `simulation`,
  `ui`, `audio`, `effects`
* **Integrator pass** — apply `CORE_REQUESTS.md`, fix seams, re-run gauntlet
* **Wave 2** — `zoning`, `buildings`, `props`, `traffic`, `tools`
* **Integrator pass**
* **Wave 3** — `demo` city composing everything
* **Gate** — per-module critic (≥8.5/10, zero console errors, budget met, up to 4 rounds),
  then whole-game critic, then blind A/B against real Cities: Skylines II screenshots.

## 10. Scoring rubric (used by the critic agent)

| Score | Meaning |
|---|---|
| 10 | Indistinguishable from Cities: Skylines II |
| 8.5 | AAA with nits — **pass mark** |
| 7 | Good indie |
| 5 | Programmer art |

Scores are never inflated. Failed rounds, real fps and what is still missing are all
recorded in `docs/STATUS.json`.
