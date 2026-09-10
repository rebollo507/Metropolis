import * as THREE from 'three';

/**
 * Traffic materials + the procedural maps they need.
 *
 * Paint is a clearcoat physical material tinted per instance through
 * `instanceColor`; roughness carries a faint panel-scale variation so a row of
 * cars does not read as a row of identical plastic toys. Tail lamps are an
 * emissive material patched so `instanceColor` scales *emissive* radiance, which
 * is what lets a braking car brighten without a second draw call.
 *
 * Everything is generated in-repo — no downloads (asset policy §7).
 */

/** Deterministic value hash in [0,1) — canvas draws must not use Math.random. */
function h2(x, y, s = 0) {
  let n = (x * 374761393 + y * 668265263 + s * 2246822519) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function fbm(x, y, s, oct = 4) {
  let a = 0.5, f = 1, sum = 0, norm = 0;
  for (let o = 0; o < oct; o++) {
    const xi = Math.floor(x * f), yi = Math.floor(y * f);
    const fx = x * f - xi, fy = y * f - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const v00 = h2(xi, yi, s + o), v10 = h2(xi + 1, yi, s + o);
    const v01 = h2(xi, yi + 1, s + o), v11 = h2(xi + 1, yi + 1, s + o);
    const v = (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
    sum += a * v; norm += a; a *= 0.55; f *= 2.1;
  }
  return sum / norm;
}

export function trafficTextures(assets, seed = 0) {
  const T = {};

  T.paintRough = assets.canvasTexture('traffic:paintRough', 128, (g, s) => {
    const img = g.createImageData(s, s);
    const d = img.data;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const i = (y * s + x) * 4;
        const n = fbm(x / 16, y / 16, seed & 255, 4);
        // orange-peel: mostly smooth with faint low-frequency waviness
        const r = 60 + n * 46 + h2(x, y, seed) * 7;
        d[i] = d[i + 1] = d[i + 2] = r; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, { srgb: false, repeat: 1 });

  T.tyre = assets.canvasTexture('traffic:tyre', 64, (g, s) => {
    g.fillStyle = '#141416';
    g.fillRect(0, 0, s, s);
    g.strokeStyle = 'rgba(60,60,64,0.75)';
    g.lineWidth = 2;
    for (let i = 0; i < 16; i++) {
      const x = (i / 16) * s;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 6, s); g.stroke();
    }
    g.fillStyle = 'rgba(90,90,96,0.28)';
    g.fillRect(0, s * 0.44, s, s * 0.12);
  }, { srgb: true, repeat: 1 });

  T.tailLens = assets.canvasTexture('traffic:tailLens', 64, (g, s) => {
    const grd = g.createLinearGradient(0, 0, 0, s);
    grd.addColorStop(0, '#ffd8cc');
    grd.addColorStop(0.35, '#ff5236');
    grd.addColorStop(1, '#c01608');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    g.globalAlpha = 0.45;
    g.fillStyle = '#000';
    for (let i = 0; i < 8; i++) g.fillRect(0, (i / 8) * s, s, 1.5);
    g.globalAlpha = 1;
  }, { srgb: true, repeat: 1 });

  T.headLens = assets.canvasTexture('traffic:headLens', 64, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s * 0.6);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.45, '#fff4de');
    grd.addColorStop(1, '#8f8a7a');
    g.fillStyle = '#101014';
    g.fillRect(0, 0, s, s);
    g.fillStyle = grd;
    g.beginPath(); g.ellipse(s / 2, s / 2, s * 0.46, s * 0.36, 0, 0, 6.283); g.fill();
  }, { srgb: true, repeat: 1 });

  T.glow = assets.canvasTexture('traffic:glow', 128, (g, s) => {
    const img = g.createImageData(s, s);
    const d = img.data;
    const c = s / 2;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const i = (y * s + x) * 4;
        const dx = (x - c) / c, dy = (y - c) / c;
        const r = Math.min(1, Math.hypot(dx, dy));
        const a = Math.pow(Math.max(0, 1 - r), 3.4);
        d[i] = 255; d[i + 1] = 244; d[i + 2] = 222; d[i + 3] = a * 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, { srgb: true, repeat: 1, wrap: THREE.ClampToEdgeWrapping });

  T.shaft = assets.canvasTexture('traffic:shaft', 64, (g, s) => {
    const img = g.createImageData(s, s);
    const d = img.data;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const i = (y * s + x) * 4;
        const u = x / (s - 1), v = y / (s - 1);
        const radial = Math.pow(Math.max(0, 1 - Math.abs(u * 2 - 1)), 1.7);
        const along = Math.pow(Math.max(0, 1 - v), 1.5);
        const a = radial * along;
        d[i] = 255; d[i + 1] = 240; d[i + 2] = 214; d[i + 3] = a * 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, { srgb: true, repeat: 1, wrap: THREE.ClampToEdgeWrapping });

  return T;
}

/* ---------------------------------------------------------- materials --- */

export class TrafficMaterials {
  constructor(ctx, tex) {
    this.ctx = ctx;
    this.tex = tex;
    this.owned = new Set();
    this.night = 0;

    const own = (m) => { this.owned.add(m); return m; };

    this.paint = own(new THREE.MeshPhysicalMaterial({
      color: 0xffffff, metalness: 0.22, roughness: 0.36,
      roughnessMap: tex.paintRough,
      clearcoat: 0.9, clearcoatRoughness: 0.055,
      envMapIntensity: 1.35,
    }));

    this.glass = own(new THREE.MeshPhysicalMaterial({
      color: 0x11181e, metalness: 0.55, roughness: 0.075,
      envMapIntensity: 2.1, transparent: true, opacity: 0.86,
    }));

    this.rubber = own(new THREE.MeshStandardMaterial({
      color: 0x1a1a1d, roughness: 0.92, metalness: 0.02,
      map: tex.tyre, envMapIntensity: 0.4,
    }));
    /* Wheels turn and steer in the vertex shader.
     *
     * `aWheel` is per-vertex (hub xyz, flags) and `aSpin` is per-instance
     * (roll angle, steer angle), so a whole city's wheels rotate for one extra
     * vec2 per vehicle and no extra draw calls. A wheel that does not turn is
     * the single loudest tell at close range, and the critic named it twice.
     * Vertices with flags 0 — the arch collars, bumpers and shut-lines that
     * share this material — are left alone. */
    this.rubber.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec4 aWheel;
attribute vec2 aSpin;
vec3 wheelTurn(vec3 v, vec4 w, vec2 sp, bool translate) {
  vec3 q = translate ? v - w.xyz : v;
  float c = cos(sp.x), s = sin(sp.x);
  q = vec3(q.x, q.y * c - q.z * s, q.y * s + q.z * c);
  if (w.w > 2.5) {
    float cs = cos(sp.y), ss = sin(sp.y);
    q = vec3(q.x * cs + q.z * ss, q.y, -q.x * ss + q.z * cs);
  }
  return translate ? q + w.xyz : q;
}`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
if (aWheel.w > 0.5) objectNormal = wheelTurn(objectNormal, aWheel, aSpin, false);`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
if (aWheel.w > 0.5) transformed = wheelTurn(transformed, aWheel, aSpin, true);`);
    };
    this.rubber.customProgramCacheKey = () => 'traffic-wheel-v1';

    this.head = own(new THREE.MeshStandardMaterial({
      color: 0x0b0b0d, emissive: 0xfff0d2, emissiveIntensity: 0.02,
      emissiveMap: tex.headLens, map: tex.headLens,
      roughness: 0.25, metalness: 0.1, toneMapped: true,
    }));

    this.tail = own(new THREE.MeshStandardMaterial({
      color: 0x14070a, emissive: 0xff2a12, emissiveIntensity: 0.9,
      emissiveMap: tex.tailLens, map: tex.tailLens,
      roughness: 0.28, metalness: 0.05, toneMapped: true,
    }));
    // instanceColor scales emissive radiance so a braking car can brighten
    // without needing its own draw call
    this.tail.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n#if defined( USE_INSTANCING_COLOR )\n  totalEmissiveRadiance *= vColor;\n#endif'
      );
    };
    this.tail.customProgramCacheKey = () => 'traffic-tail-v1';

    this.pool = own(new THREE.MeshBasicMaterial({
      map: tex.glow, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      toneMapped: true, side: THREE.DoubleSide,
    }));

    this.shaft = own(new THREE.MeshBasicMaterial({
      map: tex.shaft, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      toneMapped: true, side: THREE.DoubleSide,
    }));

    this.ped = own(new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.86, metalness: 0.0, envMapIntensity: 0.9,
    }));
  }

  /**
   * Join the core shader-patch chain (integrator pass 5, and `props`' R-props-8
   * asking every module to adopt its own rather than be walked for).
   * `{depth:true}` matters for the two materials that move vertices — the walk
   * cycle and the wheels — so the shadow they cast moves with them.
   */
  adoptAll(ctx) {
    const m = ctx.materials;
    if (!m || typeof m.adopt !== 'function') return 0;
    let n = 0;
    for (const mat of this.owned) {
      const moves = (mat === this.ped || mat === this.rubber);
      try { m.adopt(mat, { depth: moves }); n++; }
      catch (err) { ctx.log.warn('material adopt failed:', err.message); }
    }
    return n;
  }

  /**
   * `n` in [0,1] — 0 full daylight, 1 full night. Drives lamp emissive and the
   * additive shafts/pools, which are the whole reason a night street reads.
   */
  setNight(n, wetness = 0) {
    this.night = n;
    this.head.emissiveIntensity = 0.02 + n * 4.2;
    this.tail.emissiveIntensity = 0.55 + n * 1.35;
    // pools overlap additively in a queue, so they have to be modest one by one
    this.pool.opacity = n * (0.26 + wetness * 0.22);
    this.shaft.opacity = n * 0.10;
    this.paint.envMapIntensity = 1.35 - n * 0.55;
    this.glass.envMapIntensity = 2.1 - n * 0.9;
    return this;
  }

  setWetness(w) {
    this.paint.roughness = 0.36 - w * 0.12;
    this.rubber.roughness = 0.92 - w * 0.25;
    return this;
  }

  dispose() {
    for (const m of this.owned) m.dispose();
    this.owned.clear();
  }
}

export default TrafficMaterials;
