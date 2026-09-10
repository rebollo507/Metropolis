#!/usr/bin/env node
/**
 * Headless verification harness.
 *
 *   node tools/shoot.mjs --module=buildings --preset=street --time=19.5 \
 *                        --seed=1337 --out=docs/shots/buildings_street_1930
 *
 * Loads the app in headless Chromium (ANGLE/SwiftShader WebGL2), waits for
 * window.__GAME__.ready, applies camera preset + time of day, warms up, samples
 * fps and renderer.info, then writes <out>.png and <out>.json.
 *
 * Nothing in this repo may be claimed to work without a PNG from this tool.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv = process.argv.slice(2)) {
  const a = {};
  for (const s of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(s);
    if (m) a[m[1]] = m[2] === undefined ? true : m[2];
  }
  return a;
}

const CHROME_FLAGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--disable-lcd-text',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--mute-audio',
  // this sandbox has no general egress — stop Chrome phoning home
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-default-apps',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-domain-reliability',
  '--metrics-recording-only',
];

/** Prefer the pre-installed Chromium if the pinned Playwright build is absent. */
function resolveExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return undefined;
}

export async function launch() {
  const executablePath = resolveExecutable();
  return chromium.launch({ headless: true, args: CHROME_FLAGS, executablePath });
}

export async function shoot(browser, o = {}) {
  const {
    base = 'http://127.0.0.1:5173',
    module: mod = null,
    variant = 'default',
    preset = 'city',
    time = 13.0,
    seed = 1337,
    weather = 'clear',
    solo = false,
    chrome = false,        // keep the HUD in the frame (main.js hides it for non-ui showcases)
    width = 1920,
    height = 1080,
    dpr = 1,
    out = null,
    warmFrames = 45,
    sampleFrames = 120,
    timeout = 60000,
    shotTimeout = 180000,
    verbose = false,
  } = o;

  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: dpr,
  });

  const consoleErrors = [];
  const consoleWarnings = [];
  const IGNORE = /favicon|Failed to load resource: the server responded with a status of 404/i;
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' && !IGNORE.test(m.text())) consoleErrors.push(m.text().slice(0, 500));
    else if (t === 'warning') consoleWarnings.push(m.text().slice(0, 300));
    if (verbose) console.log(`   · ${t}: ${m.text().slice(0, 160)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + (e.message || String(e)).slice(0, 500)));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (!/favicon/.test(u)) consoleWarnings.push(`requestfailed ${u.slice(0, 120)}`);
  });

  const q = new URLSearchParams({
    seed: String(seed), time: String(time), preset, weather, dpr: String(dpr), headless: '1',
  });
  if (mod) { q.set('showcase', mod); q.set('variant', variant); }
  if (solo) q.set('solo', '1');
  if (chrome) q.set('chrome', '1');
  const url = `${base}/?${q.toString()}`;

  const result = {
    url, module: mod, variant, preset, time, seed, weather, chrome,
    ready: false, fps: 0, fpsMin: 0,
    drawCalls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0,
    moduleStates: {}, worldHash: null, consoleErrors, consoleWarnings,
    png: null, ms: 0, pass: false, reasons: [],
  };
  const t0 = Date.now();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForFunction(() => window.__GAME__ && window.__GAME__.ready === true, null,
      { timeout, polling: 100 });
    result.ready = true;

    // Apply state explicitly (belt and braces — URL params already did it).
    await page.evaluate(([p, t, w]) => {
      window.__GAME__.setPreset(p);
      window.__GAME__.setTime(t);
      window.__GAME__.setWeather(w);
      window.__GAME__.settle();
    }, [preset, time, weather]);

    await waitFrames(page, warmFrames, 60000);
    await page.evaluate(() => window.__GAME__.resetFps());
    await waitFrames(page, sampleFrames, 60000);

    const m = await page.evaluate(() => ({
      fps: window.__GAME__.fps,
      fpsMin: window.__GAME__.fpsMin,
      info: window.__GAME__.info,
      modules: window.__GAME__.modules,
      worldHash: window.__GAME__.worldHash,
      errors: window.__GAME__.errors,
      camera: window.__GAME__.camera(),
      stats: window.__GAME__.stats,
    }));
    Object.assign(result, {
      fps: m.fps, fpsMin: m.fpsMin,
      drawCalls: m.info.drawCalls, triangles: m.info.triangles,
      geometries: m.info.geometries, textures: m.info.textures, programs: m.info.programs,
      moduleStates: m.modules, worldHash: m.worldHash, camera: m.camera, stats: m.stats,
    });
    for (const e of m.errors) if (!consoleErrors.includes(e)) consoleErrors.push(e);

    if (out) {
      const png = path.isAbsolute(out) ? `${out}.png` : path.join(ROOT, `${out}.png`);
      fs.mkdirSync(path.dirname(png), { recursive: true });
      // R-7/R-8 (zoning, effects): under SwiftShader with the composer installed a single
      // 1280x720 frame can exceed Playwright's default 30 s screenshot cap. Give it a real
      // budget and retry — a slow capture is not a failed module.
      let shotErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await page.screenshot({ path: png, type: 'png', timeout: shotTimeout }); shotErr = null; break; }
        catch (e) { shotErr = e; await page.waitForTimeout(1500).catch(() => {}); }
      }
      if (shotErr) throw shotErr;
      result.png = path.relative(ROOT, png);
    }
  } catch (err) {
    result.reasons.push('harness: ' + (err.message || String(err)));
  } finally {
    result.ms = Date.now() - t0;
    await page.close().catch(() => {});
  }

  // Gate — note fps is measured under SwiftShader (software), so the fps budget is
  // only enforced when a real GPU is present (env REAL_GPU=1).
  if (!result.ready) result.reasons.push('never became ready');
  if (consoleErrors.length) result.reasons.push(`${consoleErrors.length} console error(s)`);
  for (const [n, s] of Object.entries(result.moduleStates))
    if (s.state === 'failed') result.reasons.push(`module ${n} FAILED: ${s.error}`);
  if (result.drawCalls > 1500) result.reasons.push(`draw calls ${result.drawCalls} > 1500`);
  if (process.env.REAL_GPU === '1' && result.fps < 50) result.reasons.push(`fps ${result.fps} < 50`);
  result.pass = result.reasons.length === 0;

  if (out) {
    const jsonPath = path.isAbsolute(out) ? `${out}.json` : path.join(ROOT, `${out}.json`);
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  }
  return result;
}

/** Wait for n animation frames, but never hang: bail out after `capMs`. */
async function waitFrames(page, n, capMs = 90000) {
  await page.evaluate(async ([count, cap]) => {
    await new Promise((res) => {
      const t0 = performance.now();
      let i = 0;
      const step = () => {
        if (++i >= count || performance.now() - t0 > cap) return res();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, [n, capMs]);
}

/* --------------------------------- CLI --------------------------------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs();
  const browser = await launch();
  const r = await shoot(browser, {
    base: a.base || 'http://127.0.0.1:5173',
    module: a.module || null,
    variant: a.variant || 'default',
    preset: a.preset || 'city',
    time: a.time !== undefined ? parseFloat(a.time) : 13.0,
    seed: a.seed !== undefined ? parseInt(a.seed, 10) : 1337,
    weather: a.weather || 'clear',
    solo: a.solo === 'true' || a.solo === true,
    chrome: a.chrome === '1' || a.chrome === 'true' || a.chrome === true,
    width: a.width ? parseInt(a.width, 10) : 1920,
    height: a.height ? parseInt(a.height, 10) : 1080,
    out: a.out || `docs/shots/${a.module || 'app'}_${a.preset || 'city'}_${a.time || 13}`,
    warmFrames: a.warm ? parseInt(a.warm, 10) : 30,
    sampleFrames: a.sample ? parseInt(a.sample, 10) : 45,
    shotTimeout: a.shotTimeout ? parseInt(a.shotTimeout, 10) : 180000,
    verbose: !!a.verbose,
  });
  await browser.close();
  console.log(JSON.stringify({
    pass: r.pass, png: r.png, fps: r.fps, drawCalls: r.drawCalls, triangles: r.triangles,
    worldHash: r.worldHash, errors: r.consoleErrors.slice(0, 6), reasons: r.reasons,
    modules: r.moduleStates,
  }, null, 2));
  process.exit(r.pass ? 0 : 1);
}
