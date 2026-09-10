import * as THREE from 'three';

/**
 * The two instanced glyph batches the showcases use.
 *
 *  · growth arrows — a tapered chevron rising out of the ground at the hottest
 *    growth sites, tinted by the zone that wants the site and scaled by how much
 *    it wants it. One draw call for the shafts, one for the heads.
 *  · service markers — a slim mast with a lit cap at every service installation,
 *    so the coverage field has visible causes rather than being abstract blobs.
 *    One draw call for the masts, one for the caps.
 *
 * Everything is `InstancedMesh` with per-instance colour, so the count scales
 * with the city without the draw-call count moving at all.
 */

const ZONE_COLOR = {
  r: new THREE.Color(0.34, 0.72, 0.42),
  c: new THREE.Color(0.30, 0.60, 0.92),
  i: new THREE.Color(0.94, 0.70, 0.28),
};

/**
 * Give a geometry a white per-vertex colour attribute.
 *
 * This is not decoration, it is the price of using `setColorAt`. In three 0.185
 * `USE_INSTANCING_COLOR` is a **vertex-stage-only** define: the fragment shader
 * declares `vColor` and multiplies it into `diffuseColor` under `USE_COLOR`
 * alone. So an instanced mesh only shows its per-instance colours when the
 * material has `vertexColors: true` — and once it does, `color_vertex` runs
 * `vColor.rgb *= color`, so a geometry with no `color` attribute reads it as
 * (0,0,0) and every instance comes out black (or, with an emissive term, white).
 * A white `color` attribute makes `vColor` exactly `instanceColor`.
 */
function withVertexColors(g, base = 0.62, tip = 1.0) {
  const pos = g.attributes.position;
  const n = pos.count;
  g.computeBoundingBox();
  const y0 = g.boundingBox.min.y, y1 = g.boundingBox.max.y;
  const span = Math.max(1e-6, y1 - y0);
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // a vertical gradient baked into the attribute, so each glyph has some form
    // of its own instead of reading as a flat sticker
    const t = (pos.getY(i) - y0) / span;
    const v = base + (tip - base) * t;
    c[i * 3] = v; c[i * 3 + 1] = v; c[i * 3 + 2] = v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** A chevron head: a four-sided pyramid, apex up. */
function arrowHeadGeo() {
  const g = new THREE.ConeGeometry(1, 1.6, 4, 1);
  g.rotateY(Math.PI / 4);
  g.translate(0, 0.8, 0);
  return withVertexColors(g);
}

/** The shaft: a slim tapered box. */
function arrowShaftGeo() {
  const g = new THREE.CylinderGeometry(0.42, 0.58, 1, 6, 1, true);
  g.translate(0, 0.5, 0);
  return withVertexColors(g);
}

export class Glyphs {
  constructor(ctx) {
    this.ctx = ctx;
    this.objects = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  /**
   * An annotation glyph material.
   *
   * These are unlit on purpose. A lit `MeshStandardMaterial` glyph is at the
   * mercy of the sun: at 13:00 the irradiance drives even a modest albedo well
   * past 1.0 and AgX desaturates it to white, so a green residential arrow and
   * an amber industrial one come out the same colour — which destroys the only
   * thing the glyph is there to say. And `toneMapped = false` cannot save it,
   * because with the `effects` composer installed the scene is drawn into a
   * linear target (three disables the per-material tonemap chunk there) and
   * `OutputPass` tone-maps the lot afterwards.
   *
   * So: `MeshBasicMaterial` with `vertexColors`, and instance colours kept in
   * the 0.2–0.6 linear range where AgX still holds a hue. The vertical gradient
   * baked into each geometry's `color` attribute is what gives the glyph form
   * without lighting, and it means the glyph reads identically at 13:00 and at
   * 22:00 — correct for a diagram element, which should not go dark at night.
   */
  _glyph(opacity = 1) {
    return new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
    });
  }

  /**
   * @param sites [{x, z, zone:'r'|'c'|'i', p:0..1}]
   * @param hAt   (x,z) => ground height
   */
  buildArrows(sites, hAt, { maxHeight = 46, minP = 0.10 } = {}) {
    this.clearArrows();
    const list = sites.filter((s) => s.p >= minP);
    if (!list.length) return 0;

    const shaftMat = this._glyph();
    const headMat = this._glyph();
    const shaft = new THREE.InstancedMesh(arrowShaftGeo(), shaftMat, list.length);
    const head = new THREE.InstancedMesh(arrowHeadGeo(), headMat, list.length);
    shaft.name = 'simulation:growth:shaft';
    head.name = 'simulation:growth:head';
    shaft.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    head.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    shaft.castShadow = false; head.castShadow = false;
    shaft.frustumCulled = false; head.frustumCulled = false;

    const col = new THREE.Color();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const y = hAt ? hAt(s.x, s.z) : 0;
      const h = 8 + maxHeight * Math.pow(s.p, 0.75);
      const w = 3.0 + 5.0 * s.p;
      this._p.set(s.x, y + 1.0, s.z);
      this._q.identity();
      this._s.set(w, h, w);
      this._m.compose(this._p, this._q, this._s);
      shaft.setMatrixAt(i, this._m);
      this._p.set(s.x, y + 1.0 + h, s.z);
      this._s.set(w * 2.1, w * 2.6, w * 2.1);
      this._m.compose(this._p, this._q, this._s);
      head.setMatrixAt(i, this._m);
      const base = ZONE_COLOR[s.zone] || ZONE_COLOR.r;
      col.copy(base).multiplyScalar(0.30 + 0.22 * s.p);
      shaft.setColorAt(i, col);
      col.copy(base).multiplyScalar(0.44 + 0.30 * s.p);
      head.setColorAt(i, col);
    }
    shaft.instanceMatrix.needsUpdate = true;
    head.instanceMatrix.needsUpdate = true;
    if (shaft.instanceColor) shaft.instanceColor.needsUpdate = true;
    if (head.instanceColor) head.instanceColor.needsUpdate = true;
    this.ctx.group.add(shaft); this.ctx.group.add(head);
    this.objects.push(shaft, head);
    this.arrows = [shaft, head];
    return list.length;
  }

  /**
   * @param installations [{kind, x, z, quality}]
   */
  buildMarkers(installations, hAt) {
    this.clearMarkers();
    if (!installations.length) return 0;
    const n = installations.length;
    const mastGeo = new THREE.CylinderGeometry(0.55, 1.1, 1, 6, 1, false);
    mastGeo.translate(0, 0.5, 0);
    withVertexColors(mastGeo);
    const capGeo = withVertexColors(new THREE.OctahedronGeometry(1, 0));

    // A flat annulus on the ground as well as the mast: from an aerial preset a
    // vertical glyph is foreshortened to almost nothing and its lit cap blows
    // out to white, whereas a ring lying on the ground keeps both its size and
    // its colour. The mast is what makes the position readable at street level;
    // the ring is what makes it readable from 800 m up.
    const ringGeo = withVertexColors(new THREE.RingGeometry(0.80, 1, 44, 1), 0.85, 1.0);
    ringGeo.rotateX(-Math.PI / 2);

    const mast = new THREE.InstancedMesh(mastGeo, this._glyph(), n);
    const cap = new THREE.InstancedMesh(capGeo, this._glyph(), n);
    const ringMat = this._glyph(0.92);
    ringMat.side = THREE.DoubleSide;
    ringMat.depthWrite = false;
    ringMat.polygonOffset = true;
    ringMat.polygonOffsetFactor = -4;
    const ring = new THREE.InstancedMesh(ringGeo, ringMat, n);
    ring.name = 'simulation:service:ring';
    ring.castShadow = false; ring.frustumCulled = false;
    ring.renderOrder = 7;
    mast.name = 'simulation:service:mast';
    cap.name = 'simulation:service:cap';
    mast.castShadow = false; cap.castShadow = false;
    mast.frustumCulled = false; cap.frustumCulled = false;

    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const inst = installations[i];
      const y = hAt ? hAt(inst.x, inst.z) : 0;
      const q = inst.quality === undefined ? 1 : inst.quality;
      const h = 74 + 34 * (1 - q);
      this._p.set(inst.x, y, inst.z);
      this._q.identity();
      this._s.set(6.5, h, 6.5);
      this._m.compose(this._p, this._q, this._s);
      mast.setMatrixAt(i, this._m);
      this._p.set(inst.x, y + h + 9.0, inst.z);
      this._s.setScalar(15.0 + 7.0 * (1 - q));
      this._m.compose(this._p, this._q, this._s);
      cap.setMatrixAt(i, this._m);
      // The same colour language as the deficit ramp beneath: a starved
      // installation burns red, a comfortable one sits back in slate.
      const r = 34 + 16 * (1 - q);
      this._p.set(inst.x, y + 1.1, inst.z);
      this._s.set(r, 1, r);
      this._m.compose(this._p, this._q, this._s);
      ring.setMatrixAt(i, this._m);
      col.setRGB(0.98 - 0.52 * q, 0.20 + 0.26 * q, 0.16 + 0.34 * q);
      mast.setColorAt(i, col.clone().multiplyScalar(0.80));
      cap.setColorAt(i, col);
      ring.setColorAt(i, col);
    }
    mast.instanceMatrix.needsUpdate = true;
    cap.instanceMatrix.needsUpdate = true;
    ring.instanceMatrix.needsUpdate = true;
    if (mast.instanceColor) mast.instanceColor.needsUpdate = true;
    if (cap.instanceColor) cap.instanceColor.needsUpdate = true;
    if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
    this.ctx.group.add(mast); this.ctx.group.add(cap); this.ctx.group.add(ring);
    this.objects.push(mast, cap, ring);
    this.markers = [mast, cap, ring];
    return n;
  }

  clearArrows() { this._dispose(this.arrows); this.arrows = null; }
  clearMarkers() { this._dispose(this.markers); this.markers = null; }

  _dispose(list) {
    if (!list) return;
    for (const o of list) {
      o.geometry?.dispose();
      o.material?.dispose();
      o.removeFromParent();
      const k = this.objects.indexOf(o);
      if (k >= 0) this.objects.splice(k, 1);
    }
  }

  drawCalls() { return this.objects.filter((o) => o.visible && o.count > 0).length; }

  dispose() {
    this._dispose([...this.objects]);
    this.objects.length = 0;
    this.arrows = null; this.markers = null;
  }
}

export default Glyphs;
