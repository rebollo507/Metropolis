import * as THREE from 'three';

/**
 * Volumetric-ish precipitation: real geometry in the world, not a screen overlay.
 *
 * Two draw calls total (streaks + splashes), both instanced, both animated
 * entirely in the vertex shader so `update()` writes four uniforms and nothing
 * else. Being real geometry is the point — it is depth-tested, so a building
 * in front of you occludes the rain behind it and the rain has parallax when
 * the camera moves. A screen-space-only rain layer cannot do either, and that
 * is exactly what makes cheap rain look like a particle demo pasted on top.
 *
 * The screen-space half of the weather (water on the front element of the lens)
 * lives in `GradePass`, which is the correct place for it: that is a lens
 * artefact, not something in the world.
 */

const RAIN_VERT = /* glsl */`
precision highp float;
attribute vec4 iSeed;        // x,z in [0,1], phase, size jitter
varying vec2 vUv;
varying float vFade;
uniform vec3  uOrigin;
uniform float uTime;
uniform float uRadius;
uniform float uTop;
uniform float uSpan;
uniform float uFall;
uniform vec2  uWind;
uniform float uWidth;
uniform float uLength;
uniform float uSwirl;

void main() {
  float sz = 0.65 + 0.7 * iSeed.w;
  float ph = fract(iSeed.z + uTime * uFall / uSpan);
  float y = uTop - ph * uSpan;

  vec3 base = uOrigin + vec3((iSeed.x - 0.5) * 2.0 * uRadius, y, (iSeed.y - 0.5) * 2.0 * uRadius);
  // wind drift accumulates as the drop falls; swirl only matters for snow
  base.xz += uWind * (1.0 - ph) * (uSpan / max(0.5, uFall));
  if (uSwirl > 0.0) {
    float a = uTime * 0.6 + iSeed.z * 43.0;
    base.x += sin(a) * uSwirl * (0.4 + iSeed.w);
    base.z += cos(a * 0.83) * uSwirl * (0.4 + iSeed.x);
  }

  vec3 vel = normalize(vec3(uWind.x, -max(0.5, uFall), uWind.y));
  vec3 toCam = cameraPosition - base;
  float camDist = length(toCam);
  vec3 vdir = toCam / max(1e-4, camDist);
  vec3 side = cross(vel, vdir);
  float sl = length(side);
  side = sl > 1e-5 ? side / sl : vec3(1.0, 0.0, 0.0);

  vec3 p = base + side * (position.x * uWidth * sz) + vel * (position.y * uLength * sz);

  vUv = uv;
  vFade = smoothstep(1.2, 4.0, camDist) * (1.0 - smoothstep(uRadius * 0.55, uRadius * 1.05, camDist));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const RAIN_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying float vFade;
uniform vec3  uColor;
uniform float uOpacity;
uniform float uRound;     // 0 = streak, 1 = round flake

void main() {
  float a;
  if (uRound > 0.5) {
    float d = length(vUv - 0.5) * 2.0;
    a = smoothstep(1.0, 0.15, d);
    a *= a;
  } else {
    float x = abs(vUv.x - 0.5) * 2.0;
    a = smoothstep(1.0, 0.0, x);
    a *= smoothstep(0.0, 0.22, vUv.y) * smoothstep(1.0, 0.72, vUv.y);
  }
  a *= vFade * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

const SPLASH_VERT = /* glsl */`
precision highp float;
attribute vec4 iSeed;
varying vec2 vUv;
varying float vA;
uniform vec3  uOrigin;
uniform float uTime;
uniform float uRadius;
uniform float uGroundY;
uniform float uRate;

void main() {
  float t = fract(iSeed.z + uTime * uRate * (0.7 + 0.6 * iSeed.w));
  float r = 0.06 + t * (0.30 + 0.35 * iSeed.w);
  vec3 c = uOrigin + vec3((iSeed.x - 0.5) * 2.0 * uRadius, uGroundY, (iSeed.y - 0.5) * 2.0 * uRadius);
  vec3 p = c + vec3(position.x * r * 2.0, 0.0, position.y * r * 2.0);
  vUv = uv;
  float camDist = length(cameraPosition - c);
  vA = (1.0 - t) * (1.0 - t) * (1.0 - smoothstep(uRadius * 0.5, uRadius, camDist));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const SPLASH_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying float vA;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float ring = smoothstep(0.55, 0.9, d) * smoothstep(1.0, 0.9, d);
  float a = ring * vA * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

function instancedQuad(count, rng, seedFn) {
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.getAttribute('position'));
  g.setAttribute('uv', base.getAttribute('uv'));
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) seedFn(data, i * 4, rng);
  g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(data, 4));
  g.instanceCount = count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  base.dispose();
  return g;
}

export class WeatherFX {
  constructor(ctx, count = 1200, splashes = 160) {
    this.ctx = ctx;
    this.mode = 0;          // 0 none, 1 rain, 2 snow
    this.intensity = 0;
    this._t = 0;
    this._groundY = 0;

    const rng = ctx.rng;
    const seed = (a, o, r) => { a[o] = r.next(); a[o + 1] = r.next(); a[o + 2] = r.next(); a[o + 3] = r.next(); };

    this.rainMat = new THREE.ShaderMaterial({
      name: 'fx.precip',
      uniforms: {
        uOrigin: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uRadius: { value: 34 },
        uTop: { value: 16 },
        uSpan: { value: 34 },
        uFall: { value: 17 },
        uWind: { value: new THREE.Vector2(1.4, 0.5) },
        uWidth: { value: 0.035 },
        uLength: { value: 1.5 },
        uSwirl: { value: 0 },
        uColor: { value: new THREE.Color(0.55, 0.62, 0.72) },
        uOpacity: { value: 0 },
        uRound: { value: 0 },
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    });

    this.splashMat = new THREE.ShaderMaterial({
      name: 'fx.splash',
      uniforms: {
        uOrigin: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uRadius: { value: 26 },
        uGroundY: { value: 0.03 },
        uRate: { value: 2.4 },
        uColor: { value: new THREE.Color(0.7, 0.76, 0.85) },
        uOpacity: { value: 0 },
      },
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    });

    this.rain = new THREE.Mesh(instancedQuad(count, rng, seed), this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 6;
    this.rain.visible = false;

    this.splash = new THREE.Mesh(instancedQuad(splashes, rng, seed), this.splashMat);
    this.splash.frustumCulled = false;
    this.splash.renderOrder = 5;
    this.splash.visible = false;

    this.group = new THREE.Group();
    this.group.name = 'fx:weather';
    this.group.add(this.rain, this.splash);
  }

  setMode(mode, intensity) {
    this.mode = mode;
    this.intensity = THREE.MathUtils.clamp(intensity, 0, 1);
    const on = mode !== 0 && this.intensity > 0.01;
    this.rain.visible = on;
    this.splash.visible = on && mode === 1;

    const u = this.rainMat.uniforms;
    if (mode === 2) {          // snow
      u.uFall.value = 1.5;
      u.uWidth.value = 0.20;
      u.uLength.value = 0.20;
      u.uSwirl.value = 0.9;
      u.uRound.value = 1;
      u.uSpan.value = 26;
      u.uTop.value = 15;
      u.uRadius.value = 20;   // same instance count in a smaller volume = denser
      u.uColor.value.setRGB(0.92, 0.95, 1.0);
      u.uOpacity.value = 0.85 * this.intensity;
    } else {                   // rain
      u.uFall.value = 19;
      u.uWidth.value = 0.042;
      u.uLength.value = 1.7;
      u.uSwirl.value = 0;
      u.uRound.value = 0;
      u.uSpan.value = 36;
      u.uTop.value = 17;
      u.uRadius.value = 34;
      u.uOpacity.value = 0.42 * this.intensity;
    }
    this.splashMat.uniforms.uOpacity.value = mode === 1 ? 0.55 * this.intensity : 0;
  }

  /** Tint the precipitation with whatever light the sky is actually giving. */
  setLight(skyColor, night) {
    const c = this.rainMat.uniforms.uColor.value;
    if (this.mode === 2) {
      c.setRGB(0.90, 0.94, 1.0).multiplyScalar(night ? 0.5 : 1.35);
    } else {
      // At night a rain streak is only visible when it catches a street lamp,
      // so the sky tint is mixed with sodium rather than used on its own.
      c.copy(skyColor).multiplyScalar(night ? 3.2 : 1.15);
      if (night) { c.r += 0.16; c.g += 0.11; c.b += 0.06; }
      c.r = Math.min(c.r, 1.6); c.g = Math.min(c.g, 1.5); c.b = Math.min(c.b, 1.5);
    }
    this.splashMat.uniforms.uColor.value.copy(c).multiplyScalar(1.4);
  }

  update(dt, camera, terrain) {
    if (!this.rain.visible) return;
    this._t += dt;
    const p = camera.position;
    this.rainMat.uniforms.uTime.value = this._t;
    // snapped to an 8 m lattice rather than glued to the camera, so the drops
    // have real parallax as you move instead of riding along with you
    const S = 8;
    this.rainMat.uniforms.uOrigin.value.set(
      Math.round(p.x / S) * S, Math.round(p.y / S) * S, Math.round(p.z / S) * S
    );
    if (this.splash.visible) {
      // splashes sit on the ground under the camera; sampled once per frame,
      // so on strongly sloped terrain the sheet is flat rather than draped.
      const gy = terrain ? terrain.heightAt(p.x, p.z) : 0;
      if (Number.isFinite(gy)) this._groundY = gy;
      this.splashMat.uniforms.uTime.value = this._t;
      this.splashMat.uniforms.uOrigin.value.set(p.x, this._groundY + 0.04, p.z);
    }
  }

  dispose() {
    this.rain.geometry.dispose();
    this.splash.geometry.dispose();
    this.rainMat.dispose();
    this.splashMat.dispose();
    this.group.removeFromParent();
  }
}

export default WeatherFX;
