/**
 * audio/markers — the positional sources, drawn.
 *
 * For the `sources` showcase. Each positional bed gets:
 *
 *   · a soft pool of light on the ground, brightness following its current gain;
 *   · a **crisp ring at its reference distance** — the radius at which the
 *     inverse-distance law has taken the first 6 dB off it — because a soft glow
 *     alone tells you where a sound is but not how far it carries;
 *   · a fainter ring at the radius where it falls under the city's own floor;
 *   · a pin and a label that hold a constant size on screen, so an aerial frame
 *     and a street frame are both readable.
 *
 * Colour follows the bus. Everything is generated in code — the pool and the
 * label plate are canvas textures built at stage time — and the whole set is
 * about five draw calls per source.
 */

import * as THREE from 'three';
import { BUSES } from './Mix.js';
import { clamp } from './Dsp.js';

const _v = new THREE.Vector3();

/* Screen regions the overlay's own panels occupy, in fractions of the frame. */
const BLOCKED = [
  { x0: 0, y0: 0, x1: 0.40, y1: 0.13 },      // status strip
  { x0: 0.71, y0: 0.62, x1: 1, y1: 1 },      // source list
];
const _size = new THREE.Vector2();

const COLOR = {};
for (const b of BUSES) COLOR[b.key] = b.color;

const FONT = '"Liberation Sans", Carlito, ui-sans-serif, system-ui, Arial, sans-serif';

function poolTexture(assets) {
  return assets.canvasTexture('audio:pool', 256, (g, s) => {
    const r = s / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0.00, 'rgba(255,255,255,0.85)');
    grd.addColorStop(0.30, 'rgba(255,255,255,0.34)');
    grd.addColorStop(0.65, 'rgba(255,255,255,0.10)');
    grd.addColorStop(1.00, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
}

function coreTexture(assets) {
  return assets.canvasTexture('audio:core', 128, (g, s) => {
    const r = s / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0.00, 'rgba(255,255,255,1)');
    grd.addColorStop(0.22, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1.00, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
}

/**
 * The label plate. Its own 512×160 canvas rather than `assets.canvasTexture`,
 * which is square — a square texture on a wide sprite squashes the type, which
 * is exactly the sort of detail that makes an overlay look unconsidered.
 */
function labelTexture(title, sub, color) {
  const W = 512, H = 160;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const r = 18, x = 4, y = 4, w = W - 8, h = H - 8;
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
  g.fillStyle = 'rgba(9,13,19,0.90)';
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.20)';
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = color;
  g.fillRect(x + 3, y + 16, 7, h - 32);
  g.textBaseline = 'middle';
  g.fillStyle = '#f2f6fb';
  g.font = `700 44px ${FONT}`;
  g.fillText(title, x + 28, y + 50);
  g.fillStyle = '#93a3b6';
  g.font = `29px ${FONT}`;
  g.fillText(sub, x + 28, y + 108);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function ringMesh(radius, thickness, color, opacity) {
  const inner = Math.max(0.001, 1 - thickness / Math.max(radius, 1));
  const geo = new THREE.RingGeometry(inner, 1, 96);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, depthTest: false,
    side: THREE.DoubleSide, toneMapped: false,
  });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.scale.set(radius, radius, 1);
  m.renderOrder = 4;
  return m;
}

export class Markers {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'audio:markers';
    this.items = [];
    this.pool = poolTexture(ctx.assets);
    this.core = coreTexture(ctx.assets);
    this.owned = [];
    ctx.group.add(this.group);
  }

  build(state, mix) {
    this.clear();
    const quad = new THREE.PlaneGeometry(1, 1);
    this.owned.push(quad);

    for (const s of state.sources || []) {
      const hex = COLOR[s.bus] || '#5cb3f2';
      const color = new THREE.Color(hex);
      const gain = mix && mix.layers ? (mix.layers[s.name] || 0) : (s.weight || 0);
      const lit = clamp(gain, 0, 1);
      const item = { name: s.name, gain, nodes: [], pos: new THREE.Vector3(s.x, s.y, s.z) };
      item.order = this.items.length;

      // ground pool
      const poolMat = new THREE.MeshBasicMaterial({
        map: this.pool, color, transparent: true, opacity: 0.30 + 0.55 * lit,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      });
      const pool = new THREE.Mesh(quad, poolMat);
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(s.x, s.y + 0.6, s.z);
      const pr = s.ref * 2.0;
      pool.scale.set(pr, pr, 1);
      pool.renderOrder = 3;
      this.group.add(pool);
      item.nodes.push(pool);

      // reference-distance ring (−6 dB) — crisp, so it can be judged
      const ref = ringMesh(s.ref, Math.max(1.8, s.ref * 0.05), color, 0.42 + 0.34 * lit);
      ref.position.set(s.x, s.y + 1.1, s.z);
      this.group.add(ref);
      item.nodes.push(ref);
      item.ref = ref;

      // the radius where this source has fallen ~18 dB: its practical reach
      const farR = Math.min(s.max, s.ref * 5);
      const far = ringMesh(farR, Math.max(1.4, farR * 0.014), color, 0.14 + 0.16 * lit);
      far.position.set(s.x, s.y + 0.9, s.z);
      this.group.add(far);
      item.nodes.push(far);

      // core + pin
      const coreMat = new THREE.SpriteMaterial({
        map: this.core, color, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending, opacity: 0.5 + 0.5 * lit, toneMapped: false,
      });
      const core = new THREE.Sprite(coreMat);
      core.position.set(s.x, s.y + 2, s.z);
      core.renderOrder = 10;
      this.group.add(core);
      item.nodes.push(core);
      item.core = core;

      const pinMat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.45 + 0.3 * lit, depthWrite: false, depthTest: false,
        side: THREE.DoubleSide, toneMapped: false,
      });
      const pin = new THREE.Mesh(quad, pinMat);
      pin.position.set(s.x, s.y + 2, s.z);
      pin.renderOrder = 10;
      this.group.add(pin);
      item.nodes.push(pin);
      item.pin = pin;

      const tex = labelTexture(
        LABEL[s.name] || s.name,
        `ref ${Math.round(s.ref)} m · reach ${Math.round(Math.min(s.max, s.ref * 5))} m · `
        + `${gain > 0.002 ? (20 * Math.log10(gain)).toFixed(1) + ' dB' : 'silent'}`,
        hex);
      const lblMat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, depthTest: false, opacity: 0.97, toneMapped: false,
      });
      const lbl = new THREE.Sprite(lblMat);
      lbl.center.set(0.5, 0);
      lbl.position.set(s.x, s.y + 2, s.z);
      lbl.renderOrder = 12;
      this.group.add(lbl);
      item.nodes.push(lbl);
      item.label = lbl;
      item.labelTex = tex;

      this.items.push(item);
    }
    this.group.visible = true;
    this.update(0);
    return this;
  }

  /**
   * Keep the pins and labels at a constant *screen* size, so the same staging
   * reads from a street corner and from 400 m up. Called per frame; it touches
   * only scale and position on a handful of sprites.
   */
  update(t) {
    const cam = this.ctx.camera;
    if (!cam) return;
    const fov = (cam.fov || 40) * Math.PI / 180;
    let W = 1280, H = 720;
    try { const sz = this.ctx.renderer.getSize(_size); W = sz.x || W; H = sz.y || H; } catch { /* defaults */ }

    // First pass: where would each label sit on screen at its base height?
    // Nearest first — the closest source is the one the eye looks for, so it
    // gets the low, obvious position and the distant ones stack above it.
    const placed = [];
    const order = this.items.map((x, k) => k)
      .sort((a, b) => cam.position.distanceTo(this.items[a].pos) - cam.position.distanceTo(this.items[b].pos));
    for (const i of order) {
      const it = this.items[i];
      const dist = cam.position.distanceTo(it.pos) || 1;
      const upp = (2 * Math.tan(fov / 2) * dist) / H;      // world units per pixel
      _v.set(it.pos.x, it.pos.y + 2, it.pos.z).project(cam);
      const sx = (_v.x * 0.5 + 0.5) * W;
      const sy = (1 - (_v.y * 0.5 + 0.5)) * H;
      it._upp = upp;
      it._sx = sx;
      it._sy = sy;
      it._front = _v.z < 1;
      // Choose a pin height whose plate clears the labels already placed *and*
      // the two DOM panels the overlay puts over the frame. Five sources in one
      // downtown block would otherwise stack their labels on each other, and the
      // furthest one would end up behind the status strip.
      const PW = 100, PH = 34;                     // half plate width / height, px
      const penalty = (y) => {
        let p = 0;
        if (y - PH < 6 || y + PH > H - 6) p += 1000;                 // outside the frame
        for (const q of placed) {
          const dx = Math.abs(q.x - sx), dy = Math.abs(q.y - y);
          if (dx < PW * 2 && dy < PH * 2) p += 100 + (PH * 2 - dy);  // over another label
        }
        for (const b of BLOCKED) {
          if (sx + PW > b.x0 * W && sx - PW < b.x1 * W && y + PH > b.y0 * H && y - PH < b.y1 * H) p += 300;
        }
        return p;
      };
      // Take the best slot available rather than the first acceptable one: in a
      // dense downtown every candidate can be blocked, and "the first one" then
      // means "on top of the last label".
      let pin = 58, best = Infinity;
      for (const cand of [58, 128, 198, 268, 338, -34, -104, -174]) {
        const p = penalty(sy - cand) + Math.abs(cand) * 0.02;
        if (p < best) { best = p; pin = cand; }
      }
      it._pinPx = pin;
      placed.push({ x: sx, y: sy - it._pinPx });
    }

    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const upp = it._upp || 1;
      const pulse = 1 + 0.04 * Math.sin(t * 0.8 + i * 1.7) * clamp(it.gain * 3, 0, 1);
      const pinH = it._pinPx * upp * pulse;
      if (it.pin) {
        it.pin.scale.set(Math.max(0.35, 1.8 * upp), Math.abs(pinH), 1);
        it.pin.position.y = it.pos.y + 2 + pinH / 2;
        it.pin.quaternion.copy(cam.quaternion);
      }
      if (it.core) {
        const s = (14 + 34 * clamp(it.gain, 0, 1)) * upp * pulse;
        it.core.scale.set(s, s, 1);
      }
      if (it.label) {
        const w = 196 * upp;                    // ≈ 196 px wide at any distance
        it.label.scale.set(w, w * (160 / 512), 1);
        it.label.center.set(0.5, pinH >= 0 ? 0 : 1);
        it.label.position.y = it.pos.y + 2 + pinH;
      }
    }
  }

  clear() {
    for (const it of this.items) {
      for (const n of it.nodes) {
        n.removeFromParent();
        if (n.geometry && n.geometry.type === 'RingGeometry') n.geometry.dispose();
        n.material?.map?.dispose?.();
        n.material?.dispose?.();
      }
    }
    this.items.length = 0;
    for (const g of this.owned) g.dispose?.();
    this.owned.length = 0;
  }

  dispose() {
    this.clear();
    this.group.removeFromParent();
  }
}

const LABEL = {
  'zone.industry': 'Industrial plant',
  'zone.retail': 'Retail frontage',
  'zone.green': 'Trees / park',
  'road.a': 'Arterial — near',
  'road.b': 'Arterial — far',
};

export default Markers;
