import * as THREE from 'three';
import { Pipeline } from './Pipeline.js';
import { WeatherFX } from './weather.js';
import { stage as stageShowcase } from './showcase.js';

/**
 * effects — the post-processing pipeline, precipitation, and the night-lights
 * response that ties them to the clock.
 *
 * The module takes over the render call through `ctx.setRenderHook`. That is a
 * privileged position: if this throws, nothing is drawn. So the hook is a
 * try/catch that, on the first failure, tears itself out and hands rendering
 * back to `Engine.renderer.render()` — the frame after a bad shader link is a
 * plain, correct image, not a black screen. `?nopost=1` disables the whole
 * chain from the URL for A/B without touching code.
 *
 * See `Pipeline.js` for the pass order and the HDR/tone-map contract.
 */

const clamp = THREE.MathUtils.clamp;

/** Lights-on curve: dusk 17.6→19.4, dawn 5.4→7.0. */
function lightsOn(hours) {
  const h = ((hours % 24) + 24) % 24;
  const up = THREE.MathUtils.smoothstep(h, 17.6, 19.4);
  const down = 1 - THREE.MathUtils.smoothstep(h, 5.4, 7.0);
  return clamp(Math.max(up, down), 0, 1);
}

export default {
  name: 'effects',
  version: '1.0.0',
  dependsOn: [],
  provides: ['setQuality', 'setBloom', 'setDof', 'enable', 'disable', 'pipelineInfo'],

  async init(ctx) {
    const S = (this.S = {});
    S.ctx = ctx;
    S.enabled = true;
    S.failed = false;
    S.show = null;
    S.elapsed = 0;
    S.skyC = new THREE.Color(0.4, 0.5, 0.65);
    S.up = new THREE.Vector3(0, 1, 0);

    let params = null;
    try { params = new URLSearchParams(location.search); } catch { /* non-browser */ }
    const wanted = params?.get('quality') || ctx.opts?.quality || 'high';
    S.forceOff = params?.get('nopost') === '1';
    S.raw = params?.get('fxraw') ? (params.get('fxraw') === '1' ? true : params.get('fxraw')) : false;

    try {
      S.pipeline = new Pipeline(ctx, wanted);
      S.pipeline.raw = S.raw;
      S.pipeline.debug = parseInt(params?.get('fxdebug') || '0', 10) || 0;
    } catch (err) {
      ctx.log.warn('composer unavailable, falling back to direct render:', err.message);
      S.pipeline = null;
      S.failed = true;
    }

    S.weather = new WeatherFX(ctx, 1300, 190);
    ctx.group.add(S.weather.group);

    /* ---------------- events ---------------- */
    S.onResize = ({ w, h }) => {
      try { S.pipeline?.setSize(w, h); } catch (e) { ctx.log.warn('resize', e.message); }
    };
    S.onPreset = ({ name }) => S.pipeline?.onPreset(name);
    S.onWeather = (p) => this._applyWeather(ctx, p);
    S.onTime = () => { S.lightsDirty = true; };

    ctx.events.on('resize', S.onResize, 'effects');
    ctx.events.on('camera:preset', S.onPreset, 'effects');
    ctx.events.on('weather:changed', S.onWeather, 'effects');
    ctx.events.on('time:changed', S.onTime, 'effects');

    this._applyWeather(ctx, ctx.world.weather || {});

    /* ---------------- take over the render call ---------------- */
    if (S.pipeline && !S.forceOff) this._install(ctx);
    else if (S.forceOff) ctx.log.info('post-processing disabled by ?nopost=1');

    ctx.log.info(`pipeline "${S.pipeline?.quality}" — ${S.pipeline ? S.pipeline.order.length : 0} passes`);
  },

  _install(ctx) {
    const S = this.S;
    S.hook = (dt) => {
      if (!S.enabled || !S.pipeline || S.failed) {
        ctx.renderer.setRenderTarget(null);
        ctx.renderer.render(ctx.scene, ctx.camera);
        return;
      }
      try {
        S.pipeline.render(dt);
      } catch (err) {
        S.failed = true;
        ctx.log.error('render pipeline failed, reverting to direct render:', err.message);
        ctx.renderer.setRenderTarget(null);
        ctx.renderer.render(ctx.scene, ctx.camera);
      }
    };
    ctx.setRenderHook(S.hook);
    S.installed = true;
  },

  _applyWeather(ctx, p) {
    const S = this.S;
    if (!S) return;
    const preset = p?.preset ?? ctx.world.weather?.preset ?? 'clear';
    const wetness = clamp(p?.wetness ?? ctx.world.weather?.wetness ?? 0, 0, 1);
    let mode = 0, amount = 0;
    if (S.forceSnow) { mode = 2; amount = 0.9; }
    else if (preset === 'rain') { mode = 1; amount = 1.0; }
    else if (preset === 'snow') { mode = 2; amount = 0.9; }
    S.weather.setMode(mode, amount);
    // the lens layer is water on the front element: rain and fog both leave it
    const lens = mode === 2 ? 0.8 : clamp(wetness * (preset === 'rain' ? 1.0 : 0.35), 0, 1);
    S.pipeline?.setWeatherMode(mode === 0 ? (wetness > 0.25 ? 1 : 0) : mode, lens);
  },

  update(ctx, dt) {
    const S = this.S;
    if (!S) return;
    S.elapsed += dt;

    /* --- night lights: emissive strength + the handful of real lamps --- */
    const on = lightsOn(ctx.world.time.hours);
    const sc = S.show;
    if (sc) {
      sc.facadeMat.emissiveIntensity = on * 1.05;
      sc.headMat.emissiveIntensity = on * 2.2;
      const k = 0.03 + on * 1.5;
      sc.emitMat.color.setRGB(k, k, k);
      // ~9 cd at 7 m is about 0.12 in the same relative-radiance scale the
      // environment's key light uses (peak 7.2), which reads as a lit street
      // without blowing the tarmac to white under every pole.
      for (const L of sc.state.lights) L.intensity = on * 9;
    }

    /* --- tint precipitation with the sky the environment is actually showing --- */
    const env = ctx.get('environment');
    if (env && env.skyColorAt && S.weather.mode !== 0) {
      env.skyColorAt(S.up, S.skyC);
      const night = env.isNight ? env.isNight() : on > 0.5;
      S.weather.setLight(S.skyC, night);
    }
    S.weather.update(dt, ctx.camera, ctx.get('terrain'));
  },

  /* ============================== provides ============================== */

  /** 'low' | 'medium' | 'high'. Returns the quality actually in force. */
  setQuality(name) {
    const S = this.S;
    if (!S || !S.pipeline) return 'off';
    try { return S.pipeline.setQuality(name); }
    catch (e) { S.ctx.log.warn('setQuality failed', e.message); return S.pipeline.quality; }
  },

  /** Multiplier on the time-of-day bloom curve. 1 = as authored, 0 = off. */
  setBloom(scale) { this.S?.pipeline?.setBloom(scale); return scale; },

  /** Multiplier on the preset-driven depth of field. 0 = always sharp. */
  setDof(scale) { this.S?.pipeline?.setDof(scale); return scale; },

  enable() {
    const S = this.S;
    if (!S) return false;
    if (S.forceOff) return false;          // ?nopost=1 wins over everything
    S.enabled = true;
    S.failed = false;
    if (!S.installed && S.pipeline) this._install(S.ctx);
    return true;
  },

  /** Hands rendering back to the engine — the honest A/B control. */
  disable() {
    const S = this.S;
    if (!S) return false;
    S.enabled = false;
    S.ctx.setRenderHook(null);
    S.installed = false;
    return true;
  },

  /** Pass list, enabled flags and per-pass CPU submit time. */
  pipelineInfo() {
    const S = this.S;
    if (!S) return { enabled: false };
    if (!S.pipeline) return { enabled: false, reason: 'composer failed to build' };
    return { enabled: S.enabled && !S.failed && S.installed, ...S.pipeline.info() };
  },

  /* ============================== showcase ============================== */

  showcase(ctx, variant = 'default') {
    const S = this.S;
    if (!S) return;
    ctx.group.visible = true;

    if (!S.show) {
      S.show = stageShowcase(ctx, variant, ctx.group);
      ctx.group.add(S.weather.group);   // keep precipitation on top of the block
    }

    S.forceSnow = variant === 'snow';

    if (variant === 'off') {
      this.disable();
    } else {
      this.enable();
    }

    if (variant === 'rain' || variant === 'snow') {
      const env = ctx.get('environment');
      if (env && env.setWeather) env.setWeather('rain');
      else this._applyWeather(ctx, { preset: 'rain', wetness: 0.88 });
    }
    this._applyWeather(ctx, ctx.world.weather || {});

    // wet asphalt: the road is the surface the SSR pass actually acts on
    const wet = clamp(ctx.world.weather?.wetness ?? 0, 0, 1);
    S.show.roadMat.roughness = THREE.MathUtils.lerp(1.0, 0.34, wet);
    S.show.roadMat.metalness = wet * 0.20;
    S.show.roadMat.envMapIntensity = 1 + wet * 0.8;
    S.show.roadMat.needsUpdate = true;

    if (variant === 'compare') {
      // the A/B variant: same block, quality switchable live from the console
      // or the harness via ctx.get('effects').setQuality('low'|'medium'|'high')
      ctx.log.info('showcase "compare": setQuality(\'low\'|\'medium\'|\'high\'), '
        + 'setBloom(k), setDof(k), disable()/enable(); pipelineInfo() lists the chain.');
    }

    ctx.log.info(`showcase "${variant}" — ground ${S.show.ground.toFixed(2)} m, quality ${S.pipeline?.quality}`);
    return S.show.framing;
  },

  dispose(ctx) {
    const S = this.S;
    if (!S) return;
    ctx.events.off('resize', S.onResize);
    ctx.events.off('camera:preset', S.onPreset);
    ctx.events.off('weather:changed', S.onWeather);
    ctx.events.off('time:changed', S.onTime);
    try { ctx.setRenderHook(null); } catch { /* ignore */ }
    try { S.pipeline?.dispose(); } catch { /* ignore */ }
    S.weather.dispose();
    if (S.show) {
      for (const g of S.show.state.geometries) g.dispose?.();
      for (const m of S.show.state.materials) m.dispose?.();
    }
    this.S = null;
  },
};
