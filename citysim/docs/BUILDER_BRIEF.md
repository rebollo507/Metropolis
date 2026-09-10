# Builder brief — read this before writing a line of code

You are a **builder agent** for exactly one module. Read `ARCHITECTURE.md` first; it is the
contract and it wins over anything you assume.

## Hard rules

1. **You own exactly one folder: `src/<yourmodule>/`.** Create as many files in it as you
   like. You may **read** anything. You may **not write** to `src/core/`, to another
   module's folder, to `tools/`, to `index.html`, `vite.config.js` or `package.json`.
   If you need a core change, append a request to `docs/CORE_REQUESTS.md` (append only —
   never rewrite someone else's entry) and code a graceful fallback meanwhile.
2. **Determinism.** `Math.random()` is banned. Use `ctx.rng` (`next/range/int/pick/
   weighted/gauss/shuffle`) and `Noise` from `src/core/Rng.js`.
3. **Assets: procedural only.** The egress proxy in this environment blocks polyhaven.org
   and ambientcg.com — do not try to download anything. Build albedo / normal / roughness
   maps with `ctx.assets.canvasTexture(key, size, draw)` or `dataTexture`, and build meshes
   in code. Never reference a URL under `/assets/` that is not in
   `public/assets/MANIFEST.json`.
4. **Never programmer art.** No flat untextured primaries, no default `MeshBasicMaterial`
   grey, no `GridHelper` in a shipped scene. Every surface needs believable albedo
   variation, sane roughness, and either a normal map or real geometric detail. Colour
   temperature must respond to time of day.
5. **Fail soft.** Your hooks must not throw. Guard every optional dependency
   (`const t = ctx.get('terrain'); const h = t ? t.heightAt(x,z) : 0;`).
6. **Budget.** Your showcase must stay under **1500 draw calls**. Use `ctx.registry.batch()`
   / `InstancedMesh` / merged geometry. State your real draw-call count in your report.
7. **Keep the app loadable at all times.** Other agents are screenshotting the same dev
   server. Never leave `src/<yourmodule>/index.js` in a state that throws at import time.

## The contract you must export from `src/<yourmodule>/index.js`

```js
export default {
  name: '<yourmodule>',         // must match the folder name exactly
  version: '1.0.0',
  dependsOn: [...],             // other module names, or []
  provides: [...],              // method names other modules may call via ctx.get()
  async init(ctx) {},
  rebuild(ctx, what) {},        // optional
  tick(ctx, dt) {},             // optional, fixed dt = 0.05
  update(ctx, dt, elapsed) {},  // optional, per frame, allocation-free
  showcase(ctx, variant) {},    // stage a scene showing ONLY your module
  dispose(ctx) {},
}
```

Add everything you create to **`ctx.group`** (your own THREE.Group), never to `ctx.scene`
directly. Register any method listed in `provides` as a top-level function on the default
export so `ctx.get('<mod>').method()` resolves.

## `ctx` surface

`world, scene, group, renderer, camera, cameraRig, events, rng, materials, registry,
assets, log, get(name), engine, diagnostics, FIXED_DT, setRenderHook(fn)`

Events you may emit/consume are listed in `ARCHITECTURE.md` §4. Emit yours; do not mutate
another module's slice of `world`.

## Verification — non-negotiable

The dev server is already running at **http://127.0.0.1:5173** (do not start another one;
if it is down, `cd /home/claude/citysim && npm run dev &`).

```bash
cd /home/claude/citysim
node tools/contract-check.mjs
node tools/shoot.mjs --module=<yourmodule> --preset=city --time=13 \
                     --width=1280 --height=720 --out=docs/shots/<yourmodule>/dev
```

Then **Read the PNG and actually look at it.** This machine has 2 CPUs and software
(SwiftShader) WebGL, so shots take ~30–90 s and reported fps is meaningless — judge
**draw calls and how it looks**, not fps.

Iterate: shoot → look → fix → shoot again. Take shots at **at least** 13.0 (noon),
18.75 (golden) and 22.0 (night), plus a close preset. You may not report a module as done
without having looked at those images.

## Report back

Finish with: what you built, your real draw-call counts per shot, the paths of the PNGs you
looked at and your honest read of how they look, anything still missing, and any
`CORE_REQUESTS.md` entries you filed. **Never inflate.** Understating is safe; overstating
poisons the whole pipeline.
