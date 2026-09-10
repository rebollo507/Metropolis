import * as THREE from 'three';
import Events from './Events.js';
import World from './World.js';
import { Rng } from './Rng.js';
import Assets from './Assets.js';
import Materials from './Materials.js';
import Registry from './Registry.js';
import CameraRig from './CameraRig.js';
import ModuleHost from './ModuleHost.js';
import Diagnostics from './Diagnostics.js';
import Quality, { byName } from './Quality.js';

const FIXED_DT = 0.05;   // 20 Hz simulation

export class Engine {
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.diagnostics = new Diagnostics();

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      logarithmicDepthBuffer: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio ?? 1.5));
    this.renderer.setSize(container.clientWidth || 1280, container.clientHeight || 720);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;

    this.camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 12000);
    this.camera.position.set(180, 160, 220);

    this.world = World.create(opts.seed ?? 1337);
    if (opts.time !== undefined) this.world.time.hours = opts.time;

    this.events = new Events((owner, err, type) => {
      if (owner) this.host?.fail(owner, err, `event:${type}`);
      else this.diagnostics.pushError(`event ${type}: ${err.message}`);
    });

    this.rig = new CameraRig(this.camera, this.renderer.domElement, this.events);
    this.assets = new Assets(this.renderer, this._mkLog('assets'));
    this.materials = new Materials(this.renderer, this.assets, this._mkLog('materials'));
    this.registry = new Registry();

    // Adaptive quality. The harness PINS a tier so shots stay comparable across machines
    // and rounds; the shipped game leaves it automatic. See Quality.js for why this exists.
    this.quality = new Quality({
      target: opts.fpsTarget ?? 50,
      start: opts.quality || 'ultra',
      auto: !opts.headless && opts.quality !== 'pin' && !opts.pinQuality,
    });
    this._applyQuality(this.quality.tier, true);

    this.clock = new THREE.Clock();
    this.accum = 0;
    this.elapsed = 0;
    this.tickCount = 0;
    this.running = false;
    this._renderHook = null;      // effects module may install a composer here

    const engine = this;
    this.host = new ModuleHost({
      engine,
      world: this.world,
      scene: this.scene,
      renderer: this.renderer,
      camera: this.camera,
      cameraRig: this.rig,
      events: this.events,
      assets: this.assets,
      materials: this.materials,
      registry: this.registry,
      diagnostics: this.diagnostics,
      opts,
      FIXED_DT,
      makeRng: (name) => Rng.derive(this.world.seed, name),
      makeLog: (name) => this._mkLog(name),
      /** Modules ask the engine to render through a composer instead of directly. */
      setRenderHook: (fn) => { this._renderHook = fn; },
      /** R-env-1: public, so `environment` can pick its fog colour space. */
      hasRenderHook: () => !!this._renderHook,
      /** R-audio-3: the module owning the solar model publishes the full time payload. */
      claimTimePublisher: (fn) => { this._timePublisher = fn; },
      /** Current advisory quality settings; modules also get `quality:changed`. */
      quality: () => this.quality.tier,
    });

    this.diagnostics.install(this);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  _mkLog(name) {
    return {
      info: (...a) => console.log(`[${name}]`, ...a),
      warn: (...a) => console.warn(`[${name}]`, ...a),
      error: (...a) => console.error(`[${name}]`, ...a),
    };
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.events.emit('resize', { w, h });
  }

  /**
   * R-audio-3: `setTime` used to emit a thin `{hours, day}` payload, so on the harness
   * path — which calls it on every single shot — consumers lost `sunDir`, `isNight` and
   * the rest of the R-5 fields. A module that owns the solar model may claim publication
   * via `ctx.claimTimePublisher(fn)`; core falls back to the thin emit when nobody has.
   */
  setTime(hours) {
    this.world.time.hours = ((hours % 24) + 24) % 24;
    if (this._timePublisher) {
      try { this._timePublisher(this.world.time.hours, this.world.time.day); return this.world.time.hours; }
      catch (err) { this.diagnostics.pushWarning(`time publisher threw: ${err.message}`); }
    }
    this.events.emit('time:changed', { hours: this.world.time.hours, day: this.world.time.day });
    return this.world.time.hours;
  }

  setWeather(preset) {
    this.world.weather.preset = preset;
    this.events.emit('weather:changed', { ...this.world.weather });
    return preset;
  }

  async start() {
    await this.host.initAll();
    this.events.emit('world:ready', { world: this.world });
    this.running = true;
    this.clock.start();
    this._loop();
    // Two warm frames so renderer.info and shadow maps are populated before "ready".
    this.diagnostics.ready = true;
    return this;
  }

  _loop = () => {
    if (!this.running) return;
    requestAnimationFrame(this._loop);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += dt;

    if (!this.world.time.paused) {
      this.accum += dt * this.world.time.speed;
      let guard = 0;
      while (this.accum >= FIXED_DT && guard++ < 5) {
        this.accum -= FIXED_DT;
        this.tickCount++;
        this.host.tick(FIXED_DT);
      }
    }

    this.rig.update(dt);

    // R-terr-2: reset BEFORE modules update. A module may render its own pass inside
    // update() — terrain's planar water reflection is 296 draw calls — and resetting
    // afterwards silently erased it from renderer.info, so the harness had been
    // under-reporting the frame against the 1500 budget.
    this.renderer.info.reset();
    this.host.update(dt, this.elapsed);

    if (this._renderHook) this._renderHook(dt);
    else this.renderer.render(this.scene, this.camera);

    this.diagnostics.sampleFps(dt);

    const stepped = this.quality.sample(dt);
    if (stepped) this._applyQuality(stepped);
  };

  /** Apply the parts of a tier that core owns, then tell every module. */
  _applyQuality(tier, silent = false) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.pixelRatio));
    this.renderer.shadowMap.enabled = tier.shadows;
    this.renderer.shadowMap.needsUpdate = true;
    if (!silent) {
      this.events.emit('quality:changed', { ...tier });
      console.log(`[quality] -> ${tier.name} (target ${this.quality.target} fps)`);
    }
    return tier;
  }

  /** Pin a named tier (also what the UI's graphics setting calls). */
  setQuality(name) {
    const t = this.quality.set(name);
    if (t) this._applyQuality(t);
    return t;
  }

  hasRenderHook() { return !!this._renderHook; }

  stop() { this.running = false; }

  dispose() {
    this.stop();
    this.host.disposeAll();
    this.registry.dispose();
    this.materials.dispose();
    this.assets.dispose();
    this.renderer.dispose();
  }
}

export default Engine;
