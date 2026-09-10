import * as THREE from 'three';
import Engine from './core/Engine.js';

/**
 * Boot. Reads URL params, builds the Engine, registers whichever modules exist.
 * Modules are imported with import.meta.glob so a folder that does not exist yet
 * (or fails to parse) never takes the app down — the page always loads.
 */

const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) ? parseFloat(params.get(k)) : d);

const opts = {
  seed: num('seed', 1337) >>> 0,
  time: num('time', 13.0),
  preset: params.get('preset') || 'city',
  showcase: params.get('showcase') || null,
  variant: params.get('variant') || 'default',
  weather: params.get('weather') || 'clear',
  quality: params.get('quality') || 'ultra',
  maxPixelRatio: num('dpr', 1.5),
  headless: params.get('headless') === '1',
};

// Dependency-ordered module list. Missing entries are skipped silently.
const MODULE_ORDER = [
  'environment', 'terrain', 'roads', 'zoning', 'buildings',
  'props', 'traffic', 'simulation', 'effects', 'tools', 'ui', 'audio', 'demo',
];

const found = import.meta.glob('./*/index.js');

async function boot() {
  const container = document.getElementById('app');
  const engine = new Engine(container, opts);
  window.__ENGINE__ = engine;

  for (const name of MODULE_ORDER) {
    const key = `./${name}/index.js`;
    if (!found[key]) continue;
    try {
      const mod = await found[key]();
      const def = mod.default;
      if (!def || !def.name) {
        console.warn(`[boot] ${name}/index.js has no valid default export — skipped`);
        continue;
      }
      engine.host.register(def);
    } catch (err) {
      console.error(`[boot] module "${name}" failed to load`, err);
    }
  }

  // Nothing registered yet? Put up an honest, non-black holding scene so the
  // dev server is always visually loadable while builders work.
  if (engine.host.modules.size === 0) installHoldingScene(engine);

  await engine.start();

  engine.setWeather(opts.weather);
  engine.setTime(opts.time);
  engine.rig.apply(opts.preset, true);

  if (opts.showcase) {
    const ok = await engine.host.showcase(opts.showcase, opts.variant);
    if (!ok) console.error(`[boot] showcase "${opts.showcase}" unavailable`);
    // showcases are lit by environment + grounded by terrain unless told otherwise
    if (params.get('solo') !== '1') engine.host.reveal(['environment', 'terrain', 'effects']);
    engine.rig.apply(opts.preset === 'city' ? 'showcase' : opts.preset, true);
    if (engine.host.framing) engine.rig.applyFraming(engine.host.framing, true);

    // R-demo-10: the HUD is DOM, so ModuleHost's group hiding never touched it and it was
    // being composited into every judged frame of every other module. A showcase of
    // anything but `ui` is a photograph of that subsystem — hide the chrome unless the
    // caller explicitly asks for it with &chrome=1.
    if (opts.showcase !== 'ui' && params.get('chrome') !== '1') {
      const ui = engine.host.modules.get('ui');
      try { ui?.api?.photoMode?.(true); } catch (err) { console.warn('[boot] photoMode failed', err); }
      // Photo mode still leaves its own shot-picker bar, which is chrome too. A module
      // may declare `ctx.domRoot`; ModuleHost hides it in a showcase exactly as it hides
      // the module's scene group. `ui` has not declared one yet, so fall back to its
      // documented root id.
      for (const [n, e] of engine.host.modules)
        if (n !== opts.showcase && e.ctx.domRoot) e.ctx.domRoot.style.visibility = 'hidden';
      const uiRoot = document.getElementById('ui-root');
      if (uiRoot) uiRoot.style.visibility = 'hidden';
    }
  }

  const boot = document.getElementById('boot');
  if (boot) { boot.classList.add('gone'); setTimeout(() => boot.remove(), 700); }
}

function installHoldingScene(engine) {
  const g = new THREE.Group();
  engine.scene.add(g);
  engine.scene.background = new THREE.Color(0x0a0f18);
  engine.scene.fog = new THREE.FogExp2(0x0a0f18, 0.0016);
  const grid = new THREE.GridHelper(1024, 64, 0x2a3a52, 0x16202e);
  g.add(grid);
  const hemi = new THREE.HemisphereLight(0x87a8d0, 0x1b1a17, 1.2);
  g.add(hemi);
  console.warn('[boot] no modules registered yet — holding scene active');
}

boot().catch((err) => {
  console.error('[boot] fatal', err);
  const b = document.getElementById('boot');
  if (b) b.querySelector('.b').innerHTML = '<b>METROPOLIS</b>boot failed — see console';
});
