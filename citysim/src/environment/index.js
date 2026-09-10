import * as THREE from 'three';
import { skyVert, skyFrag } from './sky.glsl.js';
import { cloudVert, cloudFrag } from './clouds.glsl.js';
import { SkyModel, solarPosition, lunarPosition, dirFromAltAz, kelvinToLinearRGB } from './skyModel.js';
import { installAerialFog, uninstallAerialFog } from './aerialFog.js';
import { agxToneMap } from './tonemap.js';
import { stage as stageShowcase } from './showcase.js';
import { CASCADES, makeCsmPatch, splitDistances, sliceSphere } from './csm.js';
import { makeAerialPatch, solveInscatter } from './aerial.js';

/**
 * environment — sky, sun, moon, weather, atmosphere, IBL, time of day.
 *
 * Everything else in the city is lit by this module, so it owns the whole
 * light transport chain end to end:
 *
 *   sky shader ──┬─► on-screen dome (the sun disc you actually see)
 *                ├─► cube render target ─► PMREM ─► scene.environment (IBL)
 *                └─► CPU mirror ─► fog colour, hemisphere fill, skyColorAt()
 *
 * The one honest shortfall is listed in the report: shadows use a single
 * camera-fitted cascade rather than true CSM (see `_fitShadow`).
 */

const SKY_RADIUS = 9000;
/**
 * Per-cascade shadow map size. The far cascade always spans to the shadow range
 * and its extent is fixed by the frustum, not by where the split falls, so it is
 * the only one that benefits from more texels — the near two are already at
 * 3 cm and 9 cm at street level.
 */
const SHADOW_MAP_SIZES = [2048, 2048, 3072];
const SHADOW_MAP = 2048;

/**
 * Radiance calibration. The Preetham single-scattering integral returns values
 * around 9.0 at the horizon at noon, which AgX at exposure 1.0 clips to flat
 * white. 0.14 puts the noon zenith near linear 0.7 (a real blue after AgX) and
 * the hazy horizon near 0.9, which is where a photograph sits.
 */
const SKY_SCALE = 0.085;
const TWILIGHT = 0.40;
const SUN_PEAK = 9.0;

/**
 * Shadow-fit bounds. Every one of these exists so the single cascade can never
 * diverge: `RADIUS_MAX` caps the ortho extent however far the camera orbits,
 * `MAX_CASTER_H` is the tallest thing the city is allowed to build (landmarks
 * are specced to 230 m), and `UPSUN_MAX` caps the up-sun reach term that would
 * otherwise go to infinity as the sun touches the horizon.
 */
const RADIUS_MAX = 700;
const MAX_CASTER_H = 260;
const UPSUN_MAX = 3200;
/**
 * How much of the view depth one cascade tries to cover, as a multiple of the
 * camera's orbit radius. This is the whole texel-density trade: 2.3 covered the
 * entire visible city at 1.46 m/texel, where a 2.49 m normal bias erased every
 * shadow smaller than a building. 1.3 covers the hero foreground instead and
 * gets to ~0.21 m/texel at the skyline camera. Beyond the box three's frustum
 * test reports "lit", which reads as a distance fade.
 */
const SHADOW_SPAN = 1.3;
const SHADOW_FAR_MAX = 900;

/** Dry warm concrete/earth — the city's mean ground albedo, linear sRGB. */
const GROUND_ALBEDO = [0.20, 0.185, 0.163];
/** Must match K_FALLOFF in aerialFog.js — the shared extinction profile. */
const FOG_FALLOFF = 0.0022;
const AERIAL_MIE_G = 0.55;
const DEG = Math.PI / 180;
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

/* -------------------------------------------------------------------------
   Weather presets. `wetness` and `cloudCover` are written back into
   `world.weather` because roads, effects and audio read them.
   ------------------------------------------------------------------------- */
const WEATHER = {
  clear: {
    cover: 0.07, turbidity: 2.3, rayleigh: 2.35, mie: 0.0045, mieG: 0.80,
    sunScale: 1.00, fog: 0.00040, wetness: 0.00, cloudDensity: 0.75, detail: 0.9,
    overcast: 0.00, ambient: 1.00, windSpeed: 2.4,
  },
  partly: {
    cover: 0.42, turbidity: 3.1, rayleigh: 2.20, mie: 0.0055, mieG: 0.79,
    sunScale: 0.93, fog: 0.00062, wetness: 0.00, cloudDensity: 0.68, detail: 1.0,
    overcast: 0.10, ambient: 1.08, windSpeed: 4.0,
  },
  overcast: {
    cover: 0.94, turbidity: 5.6, rayleigh: 1.55, mie: 0.011, mieG: 0.74,
    sunScale: 0.30, fog: 0.00110, wetness: 0.16, cloudDensity: 0.30, detail: 0.55,
    overcast: 0.82, ambient: 1.30, windSpeed: 6.0,
  },
  rain: {
    cover: 1.00, turbidity: 7.6, rayleigh: 1.25, mie: 0.015, mieG: 0.72,
    sunScale: 0.17, fog: 0.00165, wetness: 0.88, cloudDensity: 0.22, detail: 0.45,
    overcast: 0.94, ambient: 1.22, windSpeed: 9.5,
  },
  fog: {
    cover: 0.55, turbidity: 5.0, rayleigh: 1.75, mie: 0.013, mieG: 0.76,
    sunScale: 0.42, fog: 0.00520, wetness: 0.34, cloudDensity: 0.35, detail: 0.6,
    overcast: 0.55, ambient: 1.25, windSpeed: 1.6,
  },
};

/* scratch — update() must not allocate */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();
const _az = new THREE.Vector3();
const _up = new THREE.Vector3();
const _center = new THREE.Vector3();
const _rgb = { r: 0, g: 0, b: 0 };
const _rgb2 = { r: 0, g: 0, b: 0 };
const _tm = { r: 0, g: 0, b: 0 };

export default {
  name: 'environment',
  version: '1.0.0',
  dependsOn: [],
  provides: ['sunDirection', 'sunColor', 'skyColorAt', 'envMap', 'setTime', 'setWeather', 'isNight', 'weatherParams'],

  /* ===================================================================== */

  async init(ctx) {
    const S = (this.S = {});
    S.ctx = ctx;
    S.log = ctx.log;
    S.model = new SkyModel();
    S.sunDir = new THREE.Vector3(0, 1, 0);
    S.moonDir = new THREE.Vector3(0, -1, 0);
    S.sunColor = new THREE.Color(1, 1, 1);
    S.hours = ctx.world.time.hours;
    S.lastEmittedHour = -1;
    S.lastEnvHours = -999;
    S.envDirty = true;
    S.envForce = true;
    S.night = 0;
    S.lastFogSpacePost = null;
    S.freezeTime = !!ctx.opts?.headless;

    // weather: current (animated) and target parameter sets
    S.weatherName = ctx.world.weather?.preset in WEATHER ? ctx.world.weather.preset : 'clear';
    S.wTarget = { ...WEATHER[S.weatherName] };
    S.wCur = { ...WEATHER[S.weatherName] };

    installAerialFog();

    // Real CSM rides the core patch chain (R-env-5) rather than mutating
    // THREE.ShaderChunk, so it composes with terrain/roads/props/buildings.
    if (typeof ctx.materials?.registerShaderPatch === 'function') {
      ctx.materials.registerShaderPatch('environment:csm', makeCsmPatch(ctx.log), { order: 50 });
      S.csmActive = true;

      // R-1 / R-env-10: per-pixel aerial perspective. The four uniforms live in
      // the shared block so one term reaches every adopted material at no draw
      // cost. Ordered after CSM so it mixes over the lit result.
      const gu = ctx.materials.globalUniforms;
      gu.uAerRay = gu.uAerRay || { value: new THREE.Color(0, 0, 0) };
      gu.uAerMie = gu.uAerMie || { value: new THREE.Color(0, 0, 0) };
      gu.uAerSun = gu.uAerSun || { value: new THREE.Vector3(0, 1, 0) };
      gu.uAerCfg = gu.uAerCfg || { value: new THREE.Vector4(FOG_FALLOFF, 0, 0.76, 0) };
      S.aer = gu;
      ctx.materials.registerShaderPatch('environment:aerial', makeAerialPatch(), { order: 60 });
      S.aerialActive = true;
    } else {
      S.csmActive = false;
      S.aerialActive = false;
      ctx.log.warn('materials.registerShaderPatch unavailable — falling back to a single shadow cascade');
    }

    /* ---- sky + cloud materials (one uniform block, four materials) ---- */
    const seed = Math.floor(ctx.rng.next() * 4096);

    S.skyU = {
      uSunDir: { value: S.sunDir },
      uMoonDir: { value: S.moonDir },
      uTurbidity: { value: 2.3 },
      uRayleigh: { value: 2.35 },
      uMieCoefficient: { value: 0.0045 },
      uMieG: { value: 0.8 },
      uSunE: { value: 1.0 },
      uSkyScale: { value: 1.0 },
      uNight: { value: 0 },
      uStars: { value: 0 },
      uMoonBright: { value: 0 },
      uCityGlow: { value: 0 },
      uCityGlowColor: { value: new THREE.Color(1.0, 0.50, 0.20) },
      uGroundColor: { value: new THREE.Color(0.165, 0.150, 0.128) },
      uGroundBounce: { value: new THREE.Color(0.02, 0.018, 0.016) },
      uOvercast: { value: 0 },
      uSeed: { value: seed },
      uTwilight: { value: 0 },
    };

    S.cloudU = {
      uSunDir: { value: S.sunDir },
      uLitColor: { value: new THREE.Color(1, 1, 1) },
      uShadowColor: { value: new THREE.Color(0.35, 0.4, 0.5) },
      uHazeColor: { value: new THREE.Color(0.5, 0.6, 0.72) },
      uRimColor: { value: new THREE.Color(1.0, 0.85, 0.6) },
      uCoverage: { value: 0.07 },
      uDensity: { value: 0.75 },
      uCloudHeight: { value: 1650 },
      uScale: { value: 0.00042 },
      uWind: { value: new THREE.Vector2(0, 0) },
      uDetail: { value: 0.9 },
      uOpacity: { value: 1.0 },
    };

    // Display and capture share one uniform block; only `toneMapped` and the
    // ENV_CAPTURE define differ, so the IBL can never drift from the visible sky.
    const mkSky = (capture) => new THREE.ShaderMaterial({
      uniforms: S.skyU, vertexShader: skyVert, fragmentShader: skyFrag,
      defines: capture ? { ENV_CAPTURE: '' } : {},
      side: THREE.BackSide, depthWrite: false, depthTest: false,
      toneMapped: !capture, dithering: !capture, fog: false,
    });
    const mkCloud = (capture) => new THREE.ShaderMaterial({
      uniforms: S.cloudU, vertexShader: cloudVert, fragmentShader: cloudFrag,
      side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: true,
      toneMapped: !capture, dithering: !capture, fog: false,
    });

    S.skyMat = mkSky(false);
    S.skyMatEnv = mkSky(true);
    S.cloudMat = mkCloud(false);
    S.cloudMatEnv = mkCloud(true);

    S.skyGeo = new THREE.SphereGeometry(SKY_RADIUS, 44, 26);
    S.cloudGeo = new THREE.SphereGeometry(SKY_RADIUS * 0.94, 72, 26, 0, Math.PI * 2, 0, Math.PI * 0.56);

    S.sky = new THREE.Mesh(S.skyGeo, S.skyMat);
    S.sky.name = 'env:sky';
    S.sky.renderOrder = -1000;
    S.sky.frustumCulled = false;
    S.sky.matrixAutoUpdate = true;

    S.clouds = new THREE.Mesh(S.cloudGeo, S.cloudMat);
    S.clouds.name = 'env:clouds';
    S.clouds.renderOrder = -990;
    S.clouds.frustumCulled = false;

    ctx.group.add(S.sky, S.clouds);

    /* ---- the scene the cube camera sees (same uniforms, no tone mapping) ---- */
    S.envScene = new THREE.Scene();
    S.envSky = new THREE.Mesh(S.skyGeo, S.skyMatEnv);
    S.envSky.renderOrder = -1000;
    S.envSky.frustumCulled = false;
    S.envClouds = new THREE.Mesh(S.cloudGeo, S.cloudMatEnv);
    S.envClouds.renderOrder = -990;
    S.envClouds.frustumCulled = false;
    S.envScene.add(S.envSky, S.envClouds);

    // 256, not 128: terrain's water is roughness 0.04 — a near-mirror — and it
    // reflects `scene.environment` through three's IBL path. A 128 cube gives
    // its top PMREM mip nothing to show but a smooth blur, which is why the
    // critic measured "water reflects nothing at any hour".
    S.cubeRT = new THREE.WebGLCubeRenderTarget(256, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    S.cubeCam = new THREE.CubeCamera(1, 40000, S.cubeRT);
    S.pmrem = new THREE.PMREMGenerator(ctx.renderer);
    S.pmremRT = null;

    /* ---- lights ---- */
    // Three directional lights pointing the same way = three independently
    // fitted shadow maps, with three's own caster culling and depth-material
    // derivation. Only light 0 carries intensity; 1 and 2 own cascades only.
    S.cascades = [];
    for (let i = 0; i < CASCADES; i++) {
      const L = new THREE.DirectionalLight(0xffffff, i === 0 ? 3.2 : 0);
      L.name = `env:key${i}`;
      L.castShadow = true;
      const ms = SHADOW_MAP_SIZES[i] || SHADOW_MAP;
      L.shadow.mapSize.set(ms, ms);
      L.shadow.camera.near = 1;
      L.shadow.camera.far = 4000;
      L.shadow.bias = -0.0001;
      L.shadow.normalBias = 0.05;
      const T = new THREE.Object3D();
      L.target = T;
      ctx.group.add(L, T);
      S.cascades.push({ light: L, target: T });
    }
    S.key = S.cascades[0].light;         // the one that actually lights the scene
    S.keyTarget = S.cascades[0].target;

    S.hemi = new THREE.HemisphereLight(0x9dc0e8, 0x40382c, 0.35);
    S.hemi.name = 'env:bounce';

    ctx.group.add(S.hemi);

    /* ---- atmosphere ---- */
    S.fog = new THREE.FogExp2(0x9fb6cc, 0.00042);
    ctx.scene.fog = S.fog;

    /* ---- showcase stage lives in its own child group ---- */
    S.stageGroup = new THREE.Group();
    S.stageGroup.name = 'env:stage';
    ctx.group.add(S.stageGroup);

    /* ---- events ---- */
    S.onTime = (p) => {
      const h = typeof p?.hours === 'number' ? p.hours : ctx.world.time.hours;
      if (Math.abs(h - S.hours) > 1e-6) S.envDirty = true;
      S.hours = h;
      this._recompute(ctx, true);
    };
    S.onWeather = (p) => {
      const name = p?.preset;
      if (name && WEATHER[name] && name !== S.weatherName) this._applyWeather(ctx, name, false);
    };
    ctx.events.on('time:changed', S.onTime, 'environment');
    ctx.events.on('weather:changed', S.onWeather, 'environment');

    this._recompute(ctx, true);
    ctx.log.info(
      `sky ready — site lat ${42}°N, sunrise ≈ 06:03, sunset ≈ 19:39, ` +
      `weather "${S.weatherName}", time ${S.hours.toFixed(2)}h` +
      (S.freezeTime ? ' (clock frozen: headless)' : '')
    );
  },

  /* ===================================================================== */

  tick(ctx, dt) {
    const S = this.S;
    if (!S || S.freezeTime) return;
    const t = ctx.world.time;
    // 1 in-game minute per real second at speed 1 (tick is 20 Hz)
    t.hours += dt / 60;
    while (t.hours >= 24) { t.hours -= 24; t.day++; }
    S.hours = t.hours;

    const bucket = Math.floor(t.hours);
    if (bucket !== S.lastEmittedHour) {
      S.lastEmittedHour = bucket;
      ctx.events.emit('time:changed', this._timePayload(ctx));
    }
  },

  update(ctx, dt) {
    const S = this.S;
    if (!S) return;

    // ease weather towards its target
    let moved = false;
    const k = 1 - Math.pow(0.02, Math.min(dt, 0.1));
    for (const key of Object.keys(S.wTarget)) {
      const a = S.wCur[key], b = S.wTarget[key];
      if (Math.abs(a - b) > 1e-6) { S.wCur[key] = lerp(a, b, k); moved = true; }
    }
    if (moved) S.envDirty = true;

    if (!S.freezeTime) S.hours = ctx.world.time.hours;
    this._recompute(ctx, false);

    // the dome rides with the camera so it never clips or parallaxes
    S.sky.position.copy(ctx.camera.position);
    S.clouds.position.copy(ctx.camera.position);

    this._fitShadow(ctx);
    this._updateFog(ctx);

    // IBL is expensive (6 cube faces + a PMREM chain); refresh only when the
    // sun has actually moved a quarter hour, or on an explicit state change.
    const dh = Math.abs(S.hours - S.lastEnvHours);
    const moved15 = S.lastEnvHours < -900 || Math.min(dh, 24 - dh) > 0.25;
    if (S.envDirty && (S.envForce || moved15)) this._refreshEnv(ctx);
  },

  /* ===================================================================== */

  /** Recompute everything that depends on hour + weather. */
  _recompute(ctx, force) {
    const S = this.S;
    const w = S.wCur;
    const hours = S.hours;
    const day = ctx.world.time.day | 0;

    const sp = solarPosition(hours, day);
    dirFromAltAz(sp.alt, sp.az, S.sunDir);
    const mp = lunarPosition(hours, day);
    dirFromAltAz(mp.alt, mp.az, S.moonDir);

    const sy = S.sunDir.y;
    const night = 1 - smoothstep(-0.16, -0.01, sy);
    const stars = smoothstep(-0.09, -0.21, sy);
    const moonUp = smoothstep(-0.02, 0.10, S.moonDir.y);
    const moonBright = smoothstep(0.02, -0.08, sy) * moonUp;
    const glow = smoothstep(-0.01, -0.15, sy);
    S.night = night;

    /* ---- sky uniforms ---- */
    const U = S.skyU;
    U.uTurbidity.value = w.turbidity;
    U.uRayleigh.value = w.rayleigh;
    U.uMieCoefficient.value = w.mie;
    U.uMieG.value = w.mieG;
    U.uNight.value = night;
    U.uStars.value = stars;
    U.uMoonBright.value = moonBright;
    U.uCityGlow.value = glow * 0.020 * (1 + w.overcast * 1.6);
    U.uOvercast.value = w.overcast;
    U.uSunE.value = 1.0;
    U.uSkyScale.value = SKY_SCALE;
    U.uTwilight.value = TWILIGHT * lerp(1, 0.35, w.overcast);

    /* ---- CPU mirror stays in lockstep ---- */
    const M = S.model;
    M.sun.x = S.sunDir.x; M.sun.y = S.sunDir.y; M.sun.z = S.sunDir.z;
    M.turbidity = w.turbidity; M.rayleigh = w.rayleigh;
    M.mieCoefficient = w.mie; M.mieG = w.mieG;
    M.night = night; M.overcast = w.overcast;
    M.cityGlow = U.uCityGlow.value;
    M.skyScale = SKY_SCALE;
    M.twilight = U.uTwilight.value;

    /* ---- sun colour: atmospheric transmittance blended with a Kelvin ramp ---- */
    M.sunTransmittance(_rgb);
    const alt01 = smoothstep(-0.02, 0.55, sy);
    const kelvin = lerp(1850, 5800, Math.pow(alt01, 0.62));
    kelvinToLinearRGB(kelvin, _rgb2);
    const mixK = 0.55;
    S.sunColor.setRGB(
      lerp(_rgb.r, _rgb2.r, mixK),
      lerp(_rgb.g, _rgb2.g, mixK),
      lerp(_rgb.b, _rgb2.b, mixK)
    );

    /* ---- key light: sun above the horizon, moon below ---- */
    const sunAmt = smoothstep(-0.045, 0.22, sy);
    const transLum = 0.2126 * _rgb.r + 0.7152 * _rgb.g + 0.0722 * _rgb.b;
    const sunPower = SUN_PEAK * sunAmt * (0.55 + 0.45 * transLum) * w.sunScale;

    if (sunAmt > 0.012) {
      S.keyDir = S.sunDir;
      S.key.color.copy(S.sunColor);
      S.key.intensity = sunPower;
    } else {
      S.keyDir = S.moonDir;
      S.key.color.setRGB(0.52, 0.62, 0.92);
      S.key.intensity = 0.105 * moonUp * lerp(1, 0.25, w.overcast);
    }

    /* ---- hemisphere bounce fill, tuned off the real sky ---- */
    M.radiance(0, 1, 0, _rgb);
    const zLum = 0.2126 * _rgb.r + 0.7152 * _rgb.g + 0.0722 * _rgb.b;
    // Ground bounce: albedo x (sun irradiance on a horizontal surface + sky).
    // This is the term that decides what colour a shadow is. Feed it to the sky
    // shader's lower hemisphere so the IBL — not just the hemisphere light —
    // carries warm bounce, which is what desaturates shadows correctly.
    const sunIrr = Math.max(0, sy) * S.key.intensity * (sunAmt > 0.012 ? 1 : 0);
    const gb = U.uGroundBounce.value;
    gb.setRGB(
      GROUND_ALBEDO[0] * (S.sunColor.r * sunIrr + _rgb.r * 2.2) / Math.PI,
      GROUND_ALBEDO[1] * (S.sunColor.g * sunIrr + _rgb.g * 2.2) / Math.PI,
      GROUND_ALBEDO[2] * (S.sunColor.b * sunIrr + _rgb.b * 2.2) / Math.PI
    );
    // A city lights its own ground. Without this the bounce term goes to ~0 at
    // night and every unlit facade falls to black — which is why `demo` had to
    // add its own HemisphereLight fill (R-demo-7.2).
    const ng = glow * 0.024;
    gb.setRGB(gb.r + ng, gb.g + ng * 0.62, gb.b + ng * 0.30);
    M.groundBounce[0] = gb.r; M.groundBounce[1] = gb.g; M.groundBounce[2] = gb.b;

    // A fully saturated sky hue in the bounce fill makes golden-hour shadows read
    // cyan; real ones are a muted blue-grey because of the warm bounce above.
    const hn = 0.9 / (zLum + 1e-4);
    S.hemi.color.setRGB(
      lerp(_rgb.r * hn, 0.9, 0.62),
      lerp(_rgb.g * hn, 0.9, 0.62),
      lerp(_rgb.b * hn, 0.9, 0.62)
    );
    S.hemi.groundColor.setRGB(0.30 + glow * 0.28, 0.27 + glow * 0.14, 0.24 + glow * 0.05);
    // Deliberately a *fill*, not the main ambient — scene.environment already
    // carries the sky's irradiance, so this only softens the shadow side.
    S.hemi.intensity = clamp(
      (0.02 + zLum * 0.9) * w.ambient * lerp(1, 0.5, night) + night * 0.070,
      0.015, 0.9
    );

    /* ---- cloud shading, lit by the same sun ---- */
    const C = S.cloudU;
    C.uCoverage.value = w.cover;
    C.uDensity.value = w.cloudDensity;
    C.uDetail.value = w.detail;
    C.uOpacity.value = clamp(0.5 + w.cover * 0.75, 0, 1);
    C.uScale.value = 0.00055;

    // wind scroll is driven by the clock, so a given time always looks the same
    const windPhase = hours * 3600 * w.windSpeed;
    C.uWind.value.set(
      Math.cos(ctx.world.weather?.windDir ?? 0.7) * windPhase,
      Math.sin(ctx.world.weather?.windDir ?? 0.7) * windPhase
    );

    const litK = clamp(0.28 + sunAmt * 1.55, 0.1, 2.0) * lerp(1, 0.55, w.overcast);
    C.uLitColor.value.setRGB(
      lerp(0.62, S.sunColor.r * 1.05, 0.55) * litK + night * 0.012,
      lerp(0.66, S.sunColor.g * 1.02, 0.55) * litK + night * 0.014,
      lerp(0.74, S.sunColor.b * 1.00, 0.55) * litK + night * 0.020
    );
    M.radiance(0, 0.35, 0, _rgb);
    C.uShadowColor.value.setRGB(
      _rgb.r * 1.6 + night * 0.016,
      _rgb.g * 1.6 + night * 0.014,
      _rgb.b * 1.7 + night * 0.018
    );
    C.uRimColor.value.setRGB(S.sunColor.r * 1.5 * sunAmt, S.sunColor.g * 1.25 * sunAmt, S.sunColor.b * 0.95 * sunAmt);

    /* ---- exposure: AgX needs help at the ends of the day ---- */
    const dayness = smoothstep(-0.15, 0.42, sy);
    ctx.renderer.toneMappingExposure = lerp(1.85, 1.0, dayness) * lerp(1, 1.12, w.overcast);

    // A high sun makes the sky IBL a large, nearly ACHROMATIC term on every
    // surface, which is what collapses albedo chroma at noon (relSat 0.089 vs
    // 0.576 at golden hour). Real noon sky:sun irradiance is about 1:5; ours was
    // closer to 1:2. Pull the indirect back as the sun climbs — golden hour and
    // dawn are untouched because the ramp only starts above 20 degrees.
    ctx.scene.environmentIntensity = lerp(1.0, 0.72, smoothstep(0.35, 0.85, sy));

    if (force) S.envDirty = true;
  },

  /**
   * R-5 payload. `terrain` re-derived its own solar model for the water glint and
   * it disagreed with the light actually placed; `props`/`traffic`/`buildings`
   * want `isNight`. Consumers must still work if these are absent, so this is
   * purely additive to `{hours, day}`.
   */
  _timePayload(ctx) {
    const S = this.S;
    const d = S.keyDir || S.sunDir;
    return {
      hours: ctx.world.time.hours,
      day: ctx.world.time.day,
      sunDir: [S.sunDir.x, S.sunDir.y, S.sunDir.z],
      moonDir: [S.moonDir.x, S.moonDir.y, S.moonDir.z],
      sunColor: [S.key.color.r, S.key.color.g, S.key.color.b],
      elevation: Math.asin(clamp(S.sunDir.y, -1, 1)),
      isNight: S.sunDir.y < -0.02,
      keyDir: [d.x, d.y, d.z],
      weather: S.weatherName,
    };
  },

  /** Fog colour = the sky along the camera's view azimuth, tone-mapped to match. */
  _updateFog(ctx) {
    const S = this.S;
    ctx.camera.getWorldDirection(_v1);
    _v1.y = 0;
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 0, -1);
    _v1.normalize();
    _v2.set(_v1.x * 0.9992, 0.04, _v1.z * 0.9992).normalize();

    S.model.radiance(_v2.x, _v2.y, _v2.z, _rgb);

    // R-7 (effects). three mixes fog AFTER <tonemapping_fragment> and
    // <colorspace_fragment>. Straight to the canvas those are real, so the fog
    // colour has to be display-referred and we run the sky through the same AgX
    // curve the sky mesh gets. Inside a composer the scene target is linear
    // half-float and both chunks are no-ops, so the very same value would be
    // mixed in scene-linear space and then tone-mapped again by OutputPass —
    // which is the extra distance haze effects measured at mean 3.9/255.
    // Publish scene-linear radiance in that case instead.
    const eng = ctx.engine;
    const post = typeof eng?.hasRenderHook === 'function'
      ? !!eng.hasRenderHook()
      : !!(eng && eng._renderHook);
    if (post !== S.lastFogSpacePost) {
      S.lastFogSpacePost = post;
      ctx.log.info(`fog published in ${post ? 'scene-linear (composer active)' : 'display-referred AgX'} space`);
    }
    if (post) {
      S.fog.color.setRGB(_rgb.r * 0.97, _rgb.g * 0.97, _rgb.b * 0.99);
    } else {
      agxToneMap(_rgb.r * 0.97, _rgb.g * 0.97, _rgb.b * 0.99, ctx.renderer.toneMappingExposure, _tm);
      S.fog.color.setRGB(_tm.r, _tm.g, _tm.b);
    }
    S.fog.density = S.wCur.fog;

    /* ---- per-pixel aerial perspective (R-1) ---- */
    if (S.aerialActive && S.aer) {
      // The inscatter colours must land in whatever space the fog chunk mixes
      // in — scene-linear under a composer, display-referred AgX otherwise —
      // exactly like fogColor above.
      const expo = ctx.renderer.toneMappingExposure;
      const encode = post
        ? (c) => { c.r *= 0.97; c.g *= 0.97; c.b *= 0.99; }
        : (c) => { agxToneMap(c.r * 0.97, c.g * 0.97, c.b * 0.99, expo, _tm); c.r = _tm.r; c.g = _tm.g; c.b = _tm.b; };
      const d = S.keyDir || S.sunDir;
      // A gentler asymmetry than the sky dome's own (0.8): the coefficients are
      // solved from two horizon anchors, and a 0.8 lobe is 262x more peaked at
      // cosT = 1 than at the anchors, so extrapolating it puts a bright halo on
      // any geometry near the sun. 0.55 keeps the sunward warm bias, stays
      // exact at both anchors, and bounds the extrapolation to ~16x.
      solveInscatter(S.model, d, AERIAL_MIE_G, encode, S.aer.uAerRay.value, S.aer.uAerMie.value);
      S.aer.uAerSun.value.copy(d);
      S.aer.uAerCfg.value.set(FOG_FALLOFF, 0, AERIAL_MIE_G, 1);
    }
  },

  /**
   * Single camera-fitted shadow cascade.
   *
   * The ortho box is refit every frame to the bounding sphere of the *shadow
   * slice* of the view frustum (near → an adaptive shadow distance derived from
   * the camera's orbit radius). The sphere is used rather than the raw corner
   * AABB because its radius is invariant under camera rotation, and the centre
   * is snapped to the shadow map's texel grid — together those remove the
   * crawling edges you otherwise get when panning.
   *
   * This is one cascade, not three: real CSM in plain three.js means patching
   * every material in the scene, and this module cannot reach into other
   * modules' materials. Texel size is 2r/2048, so ~0.15 m at street distance
   * and ~1.7 m from a 1800 m aerial orbit; beyond the box, three's frustum test
   * simply reports "lit", which reads as a clean distance fade.
   */
  /**
   * Fit all three cascades. Each gets its own bounding-sphere fit of its slice
   * of the view frustum, texel-snapped in its own light space so edges do not
   * crawl when the camera pans, and its own bias scaled to its own texel size —
   * which is the whole point: cascade 0's bias is ~30x smaller than the single
   * cascade's used to be, and that is what lets a contact shadow exist.
   */
  _fitShadow(ctx) {
    const S = this.S;
    if (!S.cascades) return;
    const cam = ctx.camera;
    const dir = S.keyDir || S.sunDir;
    if (!dir) return;

    // A key at or below the horizon has nothing meaningful to cast, and fitting
    // an ortho box to y <= 0 puts the light underground shining upward.
    if (dir.y < 0.015) {
      for (const c of S.cascades) if (c.light.castShadow) c.light.castShadow = false;
      return;
    }
    for (const c of S.cascades) if (!c.light.castShadow) c.light.castShadow = true;

    const orbit = ctx.cameraRig?.dist ?? 300;
    const range = clamp(orbit * 2.2, 180, SHADOW_FAR_MAX);
    // Split the range starting from where the *content* is, not from the lens.
    // An aerial camera 510 m up has nothing at all inside 200 m, so a split
    // scheme anchored at the near plane spends cascades 0 and 1 on empty air and
    // leaves the whole visible city to the coarsest cascade.
    const near = clamp(orbit * 0.25, Math.max(cam.near, 0.5), 250);

    const tanY = Math.tan((cam.fov * DEG) / 2);
    const tanX = tanY * cam.aspect;

    if (!S.splits || S.splitRange !== range) {
      S.splits = splitDistances(near, range, CASCADES);
      S.splitRange = range;
    }
    const splits = S.splits;

    cam.getWorldDirection(_v1);

    // light-space basis, matching what three's LightShadow.lookAt will build
    _az.copy(dir).normalize();
    if (Math.abs(_az.y) > 0.97) _up.set(0, 0, 1); else _up.set(0, 1, 0);
    _ax.crossVectors(_up, _az).normalize();
    _ay.crossVectors(_az, _ax);

    // How far up-sun a caster can stand and still throw into the box:
    // H / tan(theta). Clamped so it cannot diverge as the sun nears the horizon.
    const reach = clamp(MAX_CASTER_H / Math.max(_az.y, 0.06), 300, UPSUN_MAX);

    S.csmTexels = S.csmTexels || [];
    for (let i = 0; i < CASCADES; i++) {
      const n = i === 0 ? near : splits[i - 1];
      const f = splits[i];
      const { cz, radius } = sliceSphere(n, f, tanX, tanY);

      _center.copy(cam.position).addScaledVector(_v1, cz);

      const texel = (radius * 2) / (SHADOW_MAP_SIZES[i] || SHADOW_MAP);
      const cx = Math.round(_center.dot(_ax) / texel) * texel;
      const cy = Math.round(_center.dot(_ay) / texel) * texel;
      const cc = _center.dot(_az);
      _v3.set(0, 0, 0).addScaledVector(_ax, cx).addScaledVector(_ay, cy).addScaledVector(_az, cc);

      const c = S.cascades[i];
      const back = radius + reach;
      c.target.position.copy(_v3);
      c.target.updateMatrixWorld();
      c.light.position.copy(_v3).addScaledVector(_az, back);
      c.light.up.copy(_up);

      const sc = c.light.shadow.camera;
      sc.up.copy(_up);
      const farPlane = back + radius + 200;
      if (sc.left !== -radius || sc.far !== farPlane) {
        sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius;
        sc.near = 1; sc.far = farPlane;
        sc.updateProjectionMatrix();
      }
      // Bias scales with this cascade's own texel, so the near cascade is not
      // punished for the far one's coarseness. 0.8x texel with PCF; the floor
      // keeps a 3 cm texel from self-shadowing on curved geometry.
      c.light.shadow.normalBias = clamp(texel * 0.8, 0.012, 1.2);
      c.light.shadow.bias = -0.00008 - texel * 0.00002;
      S.csmTexels[i] = texel;
    }
  },

  /** Render the sky into a cube target and PMREM it into `scene.environment`. */
  _refreshEnv(ctx) {
    const S = this.S;
    try {
      S.cubeCam.update(ctx.renderer, S.envScene);
      const rt = S.pmrem.fromCubemap(S.cubeRT.texture, S.pmremRT || null);
      S.pmremRT = rt;
      ctx.scene.environment = rt.texture;
      S.lastEnvHours = S.hours;
      S.envDirty = false;
      S.envForce = false;
    } catch (err) {
      S.envDirty = false;
      ctx.log.warn('IBL refresh failed, keeping previous environment:', err.message);
    }
  },

  _applyWeather(ctx, name, emit = true) {
    const S = this.S;
    if (!WEATHER[name]) { ctx.log.warn(`unknown weather "${name}" — ignored`); return S.weatherName; }
    S.weatherName = name;
    S.wTarget = { ...WEATHER[name] };
    ctx.world.weather.preset = name;
    ctx.world.weather.wetness = WEATHER[name].wetness;
    ctx.world.weather.cloudCover = WEATHER[name].cover;
    ctx.world.weather.windSpeed = WEATHER[name].windSpeed;
    S.envDirty = true;
    S.envForce = true;
    if (emit) {
      ctx.events.emit('weather:changed', {
        preset: name,
        wetness: WEATHER[name].wetness,
        cloudCover: WEATHER[name].cover,
        windDir: ctx.world.weather.windDir,
        windSpeed: WEATHER[name].windSpeed,
      });
    }
    return name;
  },

  /* ============================== provides ============================== */

  /** Unit vector pointing at the sun (or the moon when the sun is down). */
  sunDirection(out) {
    const S = this.S;
    if (!S) return out ? out.set(0, 1, 0) : new THREE.Vector3(0, 1, 0);
    const d = S.keyDir || S.sunDir;
    return out ? out.copy(d) : d.clone();
  },

  /** Linear-sRGB colour of the key light right now. */
  sunColor(out) {
    const S = this.S;
    if (!S) return out ? out.setRGB(1, 1, 1) : new THREE.Color(1, 1, 1);
    return out ? out.copy(S.key.color) : S.key.color.clone();
  },

  /** HDR sky radiance in a world direction (same model the shader runs). */
  skyColorAt(dir, out) {
    const S = this.S;
    const o = out || new THREE.Color();
    if (!S) return o.setRGB(0, 0, 0);
    const n = 1 / (Math.hypot(dir.x, dir.y, dir.z) || 1);
    S.model.radiance(dir.x * n, dir.y * n, dir.z * n, _rgb);
    return o.setRGB(_rgb.r, _rgb.g, _rgb.b);
  },

  /** The PMREM'd environment texture (also installed as `scene.environment`). */
  envMap() {
    const S = this.S;
    return S && S.pmremRT ? S.pmremRT.texture : null;
  },

  setTime(h) {
    const S = this.S;
    if (!S) return 0;
    const ctx = S.ctx;
    const hh = ((h % 24) + 24) % 24;
    ctx.world.time.hours = hh;
    S.hours = hh;
    S.envDirty = true;
    S.envForce = true;
    this._recompute(ctx, true);
    S.lastEmittedHour = Math.floor(hh);
    ctx.events.emit('time:changed', this._timePayload(ctx));
    return hh;
  },

  setWeather(name) {
    const S = this.S;
    if (!S) return 'clear';
    return this._applyWeather(S.ctx, name, true);
  },

  isNight() {
    const S = this.S;
    return !!S && S.sunDir.y < -0.02;
  },

  /** Read-only snapshot of the animated weather parameters (effects/audio use it). */
  weatherParams() {
    const S = this.S;
    return S ? { name: S.weatherName, ...S.wCur } : null;
  },

  /* ============================== showcase ============================== */

  showcase(ctx, variant = 'default') {
    const S = this.S;
    if (!S) return;
    ctx.group.visible = true;
    stageShowcase(ctx, variant, S.stageGroup);
    if (variant === 'weather' && S.weatherName === 'clear') this._applyWeather(ctx, 'partly', true);
    S.envDirty = true;
    S.envForce = true;
    ctx.log.info(`showcase "${variant}" staged — ${S.stageGroup.children.length} objects`);
  },

  dispose(ctx) {
    const S = this.S;
    if (!S) return;
    ctx.events.off('time:changed', S.onTime);
    ctx.events.off('weather:changed', S.onWeather);
    uninstallAerialFog();
    ctx.scene.fog = null;
    ctx.scene.environment = null;
    ctx.renderer.toneMappingExposure = 1.0;
    S.skyGeo.dispose();
    S.cloudGeo.dispose();
    S.skyMat.dispose(); S.skyMatEnv.dispose();
    S.cloudMat.dispose(); S.cloudMatEnv.dispose();
    S.cubeRT.dispose();
    S.pmremRT?.dispose();
    S.pmrem.dispose();
    if (S.csmActive) ctx.materials.unregisterShaderPatch?.('environment:csm');
    if (S.aerialActive) ctx.materials.unregisterShaderPatch?.('environment:aerial');
    for (const c of (S.cascades || [])) c.light.shadow.dispose?.();
    S.stageGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.S = null;
  },
};
