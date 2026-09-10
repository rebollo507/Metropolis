import * as THREE from 'three';

/**
 * TEMPORARY, SELF-DISABLING lighting rig.
 *
 * The `environment` module owns sky / sun / IBL for the real game. It is being
 * built in parallel, so terrain must still be judgeable on its own: if (and only
 * if) no environment module is present we install our own analytic sky —
 * an equirect gradient + sun disc, PMREM-filtered for IBL, one shadow-casting
 * directional light and a low hemisphere fill — and keep it in step with
 * `time:changed`. As soon as `environment` exists this whole file is inert.
 */

const D2R = Math.PI / 180;

/** Physically-shaped sun position for a mid-latitude summer day. +Z is south. */
export function sunDirection(hours, out = new THREE.Vector3()) {
  const ha = ((hours - 12) / 24) * Math.PI * 2;
  const lat = 0.72, decl = 0.38;
  const sinE = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const elev = Math.asin(Math.max(-1, Math.min(1, sinE)));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat));
  const c = Math.cos(elev);
  return out.set(-c * Math.sin(az), Math.sin(elev), c * Math.cos(az));
}

const mix3 = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
];
const sstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function palette(elevDeg) {
  const night = { zen: [0.006, 0.011, 0.028], hor: [0.020, 0.031, 0.052], gnd: [0.008, 0.009, 0.011] };
  const dusk = { zen: [0.055, 0.083, 0.190], hor: [0.640, 0.290, 0.132], gnd: [0.060, 0.045, 0.036] };
  const day = { zen: [0.108, 0.238, 0.620], hor: [0.560, 0.660, 0.800], gnd: [0.105, 0.098, 0.082] };
  const tDusk = sstep(-9, 2, elevDeg);
  const tDay = sstep(1.5, 16, elevDeg);
  const zen = mix3(mix3(night.zen, dusk.zen, tDusk), day.zen, tDay);
  const hor = mix3(mix3(night.hor, dusk.hor, tDusk), day.hor, tDay);
  const gnd = mix3(mix3(night.gnd, dusk.gnd, tDusk), day.gnd, tDay);
  return { zen, hor, gnd };
}

function skyEquirect(hours, W = 512, H = 256) {
  const sun = sunDirection(hours);
  const elevDeg = Math.asin(sun.y) / D2R;
  const p = palette(elevDeg);
  const night = 1 - sstep(-6, 6, elevDeg);

  // the sun/moon disc itself
  const sunUp = Math.max(0, sun.y);
  const discCol = night > 0.5
    ? [0.85, 0.92, 1.15]
    : mix3([2.2, 0.85, 0.42], [7.0, 6.6, 6.0], sstep(0, 22, elevDeg));
  const discInt = night > 0.5 ? 3.0 : 26 * (0.28 + 0.72 * sstep(-2, 14, elevDeg));
  const moonDir = night > 0.5 ? sun.clone().multiplyScalar(-1) : sun;

  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const phi = (0.5 - (y + 0.5) / H) * Math.PI;       // +pi/2 at top
    const sy = Math.sin(phi), cy = Math.cos(phi);
    for (let x = 0; x < W; x++) {
      const theta = ((x + 0.5) / W) * Math.PI * 2 - Math.PI;
      const dx = cy * Math.sin(theta), dz = cy * Math.cos(theta);
      let r, g, b;
      if (sy >= 0) {
        const t = Math.pow(sy, 0.42);
        const c = mix3(p.hor, p.zen, t);
        r = c[0]; g = c[1]; b = c[2];
        // warm glow banked around the sun azimuth, strongest near the horizon
        const cosSun = dx * moonDir.x + sy * moonDir.y + dz * moonDir.z;
        const halo = Math.pow(Math.max(0, cosSun), 6) * (0.55 + 1.9 * (1 - sstep(0, 18, elevDeg)));
        const warm = night > 0.5 ? [0.10, 0.13, 0.22] : [1.35, 0.72, 0.34];
        r += warm[0] * halo; g += warm[1] * halo; b += warm[2] * halo;
        const disc = Math.pow(Math.max(0, cosSun), 3600) * discInt;
        r += discCol[0] * disc; g += discCol[1] * disc; b += discCol[2] * disc;
      } else {
        const t = sstep(0, -0.35, sy);
        const c = mix3(p.hor, p.gnd, t);
        r = c[0] * 0.85; g = c[1] * 0.85; b = c[2] * 0.85;
      }
      const k = (y * W + x) * 4;
      data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { tex, sun, elevDeg, palette: p, night, sunUp };
}

export class FallbackSky {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'terrain:fallback-sky';
    ctx.group.add(this.group);

    this.sun = new THREE.DirectionalLight(0xfff2e2, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 20;
    this.sun.shadow.camera.far = 2400;
    const s = 620;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 1.2;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.target.position.set(0, 0, 0);
    this.group.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0x9fbede, 0x3b3226, 0.35);
    this.group.add(this.hemi);

    this.pmrem = new THREE.PMREMGenerator(ctx.renderer);
    this.pmrem.compileEquirectangularShader();
    this.rt = null;
    this.ownsBackground = !ctx.scene.background;
    this.ownsFog = !ctx.scene.fog;
    this.bgTex = null;
    this.dir = new THREE.Vector3();
  }

  setTime(hours) {
    const ctx = this.ctx;
    const { tex, sun, elevDeg, palette: p, night } = skyEquirect(hours);

    // key light
    const up = Math.max(0.0, sun.y);
    const dayI = 3.4 * sstep(-2, 12, elevDeg);
    const isNight = elevDeg < -1.5;
    this.dir.copy(isNight ? sun.clone().multiplyScalar(-1) : sun);
    if (this.dir.y < 0.02) this.dir.y = 0.02;
    this.sun.position.copy(this.dir).multiplyScalar(1200);
    if (isNight) {
      this.sun.color.setRGB(0.45, 0.58, 0.95);
      this.sun.intensity = 0.16;
    } else {
      const warm = sstep(18, 1, elevDeg);
      this.sun.color.setRGB(
        1.0,
        1.0 - 0.42 * warm,
        1.0 - 0.70 * warm
      );
      this.sun.intensity = Math.max(0.12, dayI);
    }
    this.hemi.color.setRGB(p.zen[0] * 3.2 + 0.05, p.zen[1] * 3.0 + 0.06, p.zen[2] * 2.4 + 0.09);
    this.hemi.groundColor.setRGB(p.gnd[0] * 2.2 + 0.02, p.gnd[1] * 2.1 + 0.018, p.gnd[2] * 2.0 + 0.014);
    this.hemi.intensity = 0.18 + 0.5 * (1 - night);

    // IBL + background
    if (this.rt) this.rt.dispose();
    this.rt = this.pmrem.fromEquirectangular(tex);
    ctx.scene.environment = this.rt.texture;
    if (this.ownsBackground) {
      if (this.bgTex) this.bgTex.dispose();
      this.bgTex = tex;
      ctx.scene.background = tex;
      ctx.scene.backgroundIntensity = 1.0;
    } else {
      tex.dispose();
    }
    if (this.ownsFog) {
      const f = ctx.scene.fog instanceof THREE.FogExp2 ? ctx.scene.fog : new THREE.FogExp2(0x000000, 0.00035);
      f.color.setRGB(p.hor[0] * 1.05 + 0.02, p.hor[1] * 1.05 + 0.025, p.hor[2] * 1.08 + 0.035);
      f.density = 0.00030 + 0.00016 * night;
      ctx.scene.fog = f;
    }
    return { sun: this.dir.clone(), elevDeg, night, isNight };
  }

  dispose() {
    this.rt?.dispose();
    this.bgTex?.dispose();
    this.pmrem?.dispose();
    this.group.removeFromParent();
    if (this.ownsBackground) this.ctx.scene.background = null;
    this.ctx.scene.environment = null;
  }
}

export default FallbackSky;
