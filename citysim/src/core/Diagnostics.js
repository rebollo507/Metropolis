/**
 * window.__GAME__ — the only surface the headless verification harness touches.
 * Keep it stable: tools/shoot.mjs depends on these fields.
 */
export class Diagnostics {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.ready = false;
    this.fpsSamples = [];
    this.frame = 0;
    this._hookConsole();
  }

  _hookConsole() {
    const origErr = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    console.error = (...a) => { this.errors.push(this._fmt(a)); origErr(...a); };
    console.warn = (...a) => { this.warnings.push(this._fmt(a)); origWarn(...a); };
    window.addEventListener('error', (e) => this.pushError(`uncaught: ${e.message} @${e.filename}:${e.lineno}`));
    window.addEventListener('unhandledrejection', (e) =>
      this.pushError(`unhandled rejection: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));
  }

  _fmt(args) {
    return args.map((x) => {
      if (x instanceof Error) return x.stack || x.message;
      if (typeof x === 'object') { try { return JSON.stringify(x).slice(0, 400); } catch { return String(x); } }
      return String(x);
    }).join(' ').slice(0, 900);
  }

  pushError(msg) { this.errors.push(msg); this._banner(msg); }
  pushWarning(msg) { this.warnings.push(msg); }

  _banner(msg) {
    const el = document.getElementById('err');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = (el.textContent ? el.textContent + '\n' : '') + msg.slice(0, 300);
  }

  install(engine) {
    this.engine = engine;
    const self = this;
    window.__GAME__ = {
      get ready() { return self.ready; },
      get errors() { return self.errors.slice(); },
      get warnings() { return self.warnings.slice(); },
      get frame() { return self.frame; },
      get fps() {
        const s = self.fpsSamples;
        if (!s.length) return 0;
        return Math.round(s.reduce((a, b) => a + b, 0) / s.length);
      },
      get fpsMin() { return self.fpsSamples.length ? Math.round(Math.min(...self.fpsSamples)) : 0; },
      resetFps() { self.fpsSamples.length = 0; },
      get info() {
        const i = engine.renderer.info;
        return {
          drawCalls: i.render.calls,
          triangles: i.render.triangles,
          geometries: i.memory.geometries,
          textures: i.memory.textures,
          programs: i.programs ? i.programs.length : 0,
        };
      },
      get modules() { return engine.host.states(); },
      get quality() { return engine.quality.report(); },
      setQuality: (n) => engine.setQuality(n),
      get worldHash() { try { return engine.world.hash(); } catch { return 'err'; } },
      get stats() { return JSON.parse(JSON.stringify(engine.world.stats)); },
      setTime: (h) => engine.setTime(h),
      setPreset: (p) => {
        engine.rig.apply(p, true);
        // R-4: a showcase's returned framing overrides the preset for the shot.
        if (engine.host.framing) engine.rig.applyFraming(engine.host.framing, true);
        return p;
      },
      get framing() { return engine.host.framing || null; },
      setWeather: (p) => engine.setWeather(p),
      camera: () => ({
        pos: engine.camera.position.toArray().map((v) => +v.toFixed(2)),
        target: engine.rig.target.toArray().map((v) => +v.toFixed(2)),
        preset: engine.rig.presetName,
      }),
      settle: () => { engine.rig.settle(); return true; },
      showcase: (m, v) => engine.host.showcase(m, v),
      engine,
    };
  }

  sampleFps(dt) {
    this.frame++;
    if (dt > 0) this.fpsSamples.push(1 / dt);
    if (this.fpsSamples.length > 600) this.fpsSamples.shift();
  }
}

export default Diagnostics;
