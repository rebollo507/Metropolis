# Metropolis

A city builder in Three.js + Vite, plain ES modules, built from an empty folder by a fleet
of agents working against a written architecture and a screenshot-driven verification loop.

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

Nothing is downloaded at runtime. **Every texture, mesh, heightfield and sound in this
project is generated procedurally in code** — the build environment's egress proxy blocks
polyhaven.org and ambientcg.com, so the CC0 asset policy was satisfied by its third option.

---

## What it is

A 2 km² seeded river-valley site with a generated road network, land-use zoning, procedural
architecture, dressed streets, simulated traffic and pedestrians, an economy, build tools,
a HUD, and a fully synthesised soundscape — running in a browser at 1297–1361 draw calls.

| | |
|---|---|
| Modules | **13** — terrain, environment, roads, zoning, buildings, props, traffic, effects, simulation, tools, ui, audio, demo |
| Source | ~51 000 lines across 165 ES modules |
| Verified screenshots | **238**, each with a JSON metrics record |
| Draw calls, worst frame | **1361** of a 1500 budget |
| Console errors | **0** across every judged frame |
| Whole-game art score | **8.0 / 10** after three critic rounds (pass mark 8.5) |

### Some numbers that are load-bearing

* Terrain: 513² heightfield, hydraulic + thermal erosion, a carved river, 4-layer procedural
  PBR splat driven by a landform control map (flow accumulation, curvature, field parcels,
  rock exposure). 4 draw calls.
* Environment: analytic Preetham sky with real solar/lunar astronomy, **3-cascade CSM**
  (0.033 m/texel at street level), PMREM IBL, and per-pixel Rayleigh/Mie aerial perspective.
* Roads: Bézier graph with true mitred and filleted intersection polygons, kerbs, a
  procedural lane-marking atlas, terrain cuttings, and a 158 m three-span river bridge.
  The entire network is **6 draw calls**.
* Buildings: 292 buildings from a seeded generator, 20 m → 214 m, per-tenancy shopfronts
  with recessed glazing and coloured fascias, window interiors, night occupancy.
* Props: 607-light clustered forward lighting pass, 10 000+ instances, four procedural tree
  species with vertex-shader wind. 137 draw calls.
* Traffic: 810-lane routable network, 20 Hz IDM simulation at **0.44 ms/tick** with 425
  vehicles, plus a stateless ambient crowd (890–1605 pedestrians visible per frame).
* Simulation: population, households, RCI demand, a monthly budget, 7 coverage fields —
  **0.049 ms mean tick at 265 000 population**.
* Audio: 5 789 lines of Web Audio synthesis. No sample is above 1.0 in any state.

---

## How it was built

```
ARCHITECTURE.md            the contract — written before any feature code
docs/BUILDER_BRIEF.md      the rules every builder agent read first
docs/CORE_REQUESTS.md      builders' core-change requests + 7 integrator decision logs
docs/CRITIC.md             three whole-game critic rounds, with the trajectory intact
docs/STATUS.json           per-module scores, 238 shot records, open risks
tools/shoot.mjs            headless-Chromium screenshot + metrics harness
tools/gauntlet.mjs         module × time-of-day × camera matrix
tools/contract-check.mjs   static API / determinism / asset-policy checks
tools/patch-chain-test.mjs 7 checks on the core shader-patch chain
```

Rules that were actually enforced, not just written down:

* **One folder per agent.** A builder could read anything and write only its own module.
  Core changes went through `docs/CORE_REQUESTS.md` and an integrator.
* **`Math.random` is banned** — `tools/contract-check.mjs` fails the build on it. Everything
  derives from a seeded sfc32 stream, and `World.hash()` is order-independent so undo/redo
  can be asserted.
* **No agent may claim anything it has not screenshotted and looked at.** Every module
  reports real draw-call counts, and several caught their own bugs only in the image.
* **Modules fail soft.** A throwing module is quarantined, its group hidden, the app keeps
  rendering, and the harness records it as FAILED.

## What it does not do, stated plainly

* **The 50 fps budget has never been measured.** This environment has no GPU. `src/core/Quality.js`
  is a 5-tier adaptive governor that measures the real machine and degrades with hysteresis —
  that bounds the risk, it does not close it. Run it on real hardware.
* **The blind A/B against real Cities: Skylines II screenshots could not be run** — the sandbox
  blocks every image source, and fabricating a reference would have made the comparison
  worthless. Every art score is an unblinded, from-memory comparison. The pixel measurements
  in `docs/CRITIC.md` are facts about our own frames; the CS2 comparisons are not checkable.
* **No lettering anywhere in the city**, pedestrians are flat-colour figures, and there is one
  cloud family. All three are downstream of procedural-only assets.

`docs/CRITIC.md` has the full ranked list of what still stands between this and 8.5.
