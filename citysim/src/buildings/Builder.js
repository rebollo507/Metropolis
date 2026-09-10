import * as THREE from 'three';

/**
 * Tiny growable triangle-soup builder.
 *
 * Buildings are generated in local space (x = along the street frontage,
 * z = depth away from the street, y = up, origin at the footprint centre on the
 * ground floor) and then transformed once as they are appended into a merged
 * per-block chunk. Nothing here allocates per triangle.
 */

class Buf {
  constructor(item, cap = 512) {
    this.item = item;
    this.a = new Float32Array(cap * item);
    this.n = 0;
  }
  _grow(need) {
    if (this.n + need <= this.a.length) return;
    let cap = this.a.length || 64;
    while (cap < this.n + need) cap *= 2;
    const b = new Float32Array(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  p1(x) { this._grow(1); this.a[this.n++] = x; }
  p2(x, y) { this._grow(2); this.a[this.n++] = x; this.a[this.n++] = y; }
  p3(x, y, z) { this._grow(3); this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z; }
  p4(x, y, z, w) { this._grow(4); this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z; this.a[this.n++] = w; }
  view() { return this.a.subarray(0, this.n); }
  reset() { this.n = 0; }
}

const _c = new THREE.Color();

export class Builder {
  constructor(withWin = false) {
    this.pos = new Buf(3);
    this.nrm = new Buf(3);
    this.uv = new Buf(2);
    this.col = new Buf(3);
    this.win = withWin ? new Buf(4) : null;
    // aGls = (reflectance multiplier, roughness, spare) — glass only
    this.gls = withWin ? new Buf(3) : null;
    this.cr = 1; this.cg = 1; this.cb = 1;
    this.w0 = 0; this.w1 = 0; this.w2 = 0; this.w3 = 0;
    this.g0 = 6; this.g1 = 0.10; this.g2 = 0;
    this.uOff = 0; this.vOff = 0;
    // per-quad normal tilt in the (du, dv) plane of the emitted quad, radians
    this.ta = 0; this.tb = 0;
    this.verts = 0;
  }

  reset() {
    this.pos.reset(); this.nrm.reset(); this.uv.reset(); this.col.reset();
    if (this.win) this.win.reset();
    if (this.gls) this.gls.reset();
    this.verts = 0;
    this.uOff = 0; this.vOff = 0;
    this.ta = 0; this.tb = 0;
    return this;
  }

  get triangles() { return this.verts / 3; }
  get empty() { return this.verts === 0; }

  /** Current vertex colour from an sRGB hex (stored linear, as three expects). */
  colorHex(hex, mulR = 1, mulG = 1, mulB = 1) {
    _c.setHex(hex, THREE.SRGBColorSpace);
    this.cr = _c.r * mulR; this.cg = _c.g * mulG; this.cb = _c.b * mulB;
    return this;
  }
  colorHSL(h, s, l) {
    _c.setHSL(h, s, l, THREE.SRGBColorSpace);
    this.cr = _c.r; this.cg = _c.g; this.cb = _c.b;
    return this;
  }
  colorLinear(r, g, b) { this.cr = r; this.cg = g; this.cb = b; return this; }
  scaleColor(k) { this.cr *= k; this.cg *= k; this.cb *= k; return this; }

  /** aWin = (phase, occupancyClass, warmth, special) */
  setWin(phase, cls, warm, special) {
    this.w0 = phase; this.w1 = cls; this.w2 = warm; this.w3 = special;
    return this;
  }

  /**
   * aGls = (reflectance multiplier, roughness, spare).
   * The multiplier scales the specular IBL radiance for this pane, which is what
   * turns a flat dark rectangle into architectural glass: a coated curtain-wall
   * pane reflects 25-40 % of the sky, a domestic window nearer 8 %.
   */
  setGls(reflect, rough, spare = 0) {
    this.g0 = reflect; this.g1 = rough; this.g2 = spare;
    return this;
  }

  /**
   * Tilt the next quads' normals by (a, b) radians about the quad's own v and u
   * edges. Real glazing is never perfectly coplanar; a fraction of a degree of
   * per-pane bow is what makes a tower's glass face sparkle instead of reading
   * as one painted sheet.
   */
  setTilt(a, b) { this.ta = a; this.tb = b; return this; }

  uvOffset(u, v) { this.uOff = u; this.vOff = v; return this; }

  _vert(x, y, z, nx, ny, nz, u, v) {
    this.pos.p3(x, y, z);
    this.nrm.p3(nx, ny, nz);
    this.uv.p2(u + this.uOff, v + this.vOff);
    this.col.p3(this.cr, this.cg, this.cb);
    if (this.win) this.win.p4(this.w0, this.w1, this.w2, this.w3);
    if (this.gls) this.gls.p3(this.g0, this.g1, this.g2);
    this.verts++;
  }

  /**
   * Planar quad p0→p1→p2→p3 (counter-clockwise seen from the front face).
   * UVs interpolate (u0,v0) at p0, (u1,v0) at p1, (u1,v1) at p2, (u0,v1) at p3.
   */
  quad(p0, p1, p2, p3, u0, v0, u1, v1) {
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (this.ta !== 0 || this.tb !== 0) {
      const la = Math.hypot(ax, ay, az) || 1, lb = Math.hypot(bx, by, bz) || 1;
      nx += (ax / la) * this.ta + (bx / lb) * this.tb;
      ny += (ay / la) * this.ta + (by / lb) * this.tb;
      nz += (az / la) * this.ta + (bz / lb) * this.tb;
      const l2 = Math.hypot(nx, ny, nz) || 1;
      nx /= l2; ny /= l2; nz /= l2;
    }
    this._vert(p0[0], p0[1], p0[2], nx, ny, nz, u0, v0);
    this._vert(p1[0], p1[1], p1[2], nx, ny, nz, u1, v0);
    this._vert(p2[0], p2[1], p2[2], nx, ny, nz, u1, v1);
    this._vert(p0[0], p0[1], p0[2], nx, ny, nz, u0, v0);
    this._vert(p2[0], p2[1], p2[2], nx, ny, nz, u1, v1);
    this._vert(p3[0], p3[1], p3[2], nx, ny, nz, u0, v1);
    return this;
  }

  tri(p0, p1, p2, u0, v0, u1, v1, u2, v2) {
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this._vert(p0[0], p0[1], p0[2], nx, ny, nz, u0, v0);
    this._vert(p1[0], p1[1], p1[2], nx, ny, nz, u1, v1);
    this._vert(p2[0], p2[1], p2[2], nx, ny, nz, u2, v2);
    return this;
  }

  /**
   * Axis-aligned box from (x0,y0,z0) to (x1,y1,z1) with world-scale UVs.
   * `faces` is a bitmask: 1 -Z, 2 +X, 4 +Z, 8 -X, 16 +Y, 32 -Y.
   */
  box(x0, y0, z0, x1, y1, z1, tile = 2, faces = 63) {
    const t = 1 / (tile || 1);
    const w = x1 - x0, h = y1 - y0, d = z1 - z0;
    if (faces & 1) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], 0, 0, w * t, h * t);
    if (faces & 4) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 0, 0, w * t, h * t);
    if (faces & 2) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], 0, 0, d * t, h * t);
    if (faces & 8) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], 0, 0, d * t, h * t);
    if (faces & 16) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], 0, 0, w * t, d * t);
    if (faces & 32) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], 0, 0, w * t, d * t);
    return this;
  }

  /** Box rotated about Y around its own centre — used for angled clutter. */
  boxRot(cx, cy, cz, sx, sy, sz, rot, tile = 2) {
    const c = Math.cos(rot), s = Math.sin(rot);
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const P = (lx, ly, lz) => [cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c];
    const t = 1 / (tile || 1);
    const a = P(-hx, -hy, -hz), b = P(hx, -hy, -hz), cc = P(hx, hy, -hz), d = P(-hx, hy, -hz);
    const e = P(-hx, -hy, hz), f = P(hx, -hy, hz), g = P(hx, hy, hz), h = P(-hx, hy, hz);
    this.quad(b, a, d, cc, 0, 0, sx * t, sy * t);
    this.quad(e, f, g, h, 0, 0, sx * t, sy * t);
    this.quad(f, b, cc, g, 0, 0, sz * t, sy * t);
    this.quad(a, e, h, d, 0, 0, sz * t, sy * t);
    this.quad(h, g, cc, d, 0, 0, sx * t, sz * t);
    this.quad(a, b, f, e, 0, 0, sx * t, sz * t);
    return this;
  }

  /** Vertical cylinder (tanks, chimneys, antennae). */
  cyl(cx, cy, cz, r, h, seg = 10, tile = 2, cap = true) {
    const t = 1 / (tile || 1);
    const circ = 2 * Math.PI * r;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * r, z0 = cz + Math.sin(a0) * r;
      const x1 = cx + Math.cos(a1) * r, z1 = cz + Math.sin(a1) * r;
      this.quad([x1, cy, z1], [x0, cy, z0], [x0, cy + h, z0], [x1, cy + h, z1],
        (i / seg) * circ * t, 0, ((i + 1) / seg) * circ * t, h * t);
      if (cap) {
        this.tri([cx, cy + h, cz], [x0, cy + h, z0], [x1, cy + h, z1],
          0.5 * r * t, 0.5 * r * t, 0, 0, r * t, r * t);
      }
    }
    return this;
  }

  /** Append another builder's contents, transformed by a 4x4 matrix. */
  append(src, m) {
    if (!src.verts) return this;
    const e = m.elements;
    const sp = src.pos.a, sn = src.nrm.a, su = src.uv.a, sc = src.col.a;
    const sw = src.win ? src.win.a : null;
    const sg = src.gls ? src.gls.a : null;
    const n = src.verts;
    this.pos._grow(n * 3); this.nrm._grow(n * 3); this.uv._grow(n * 2); this.col._grow(n * 3);
    if (this.win) this.win._grow(n * 4);
    if (this.gls) this.gls._grow(n * 3);
    for (let i = 0; i < n; i++) {
      const x = sp[i * 3], y = sp[i * 3 + 1], z = sp[i * 3 + 2];
      this.pos.a[this.pos.n++] = e[0] * x + e[4] * y + e[8] * z + e[12];
      this.pos.a[this.pos.n++] = e[1] * x + e[5] * y + e[9] * z + e[13];
      this.pos.a[this.pos.n++] = e[2] * x + e[6] * y + e[10] * z + e[14];
      const nx = sn[i * 3], ny = sn[i * 3 + 1], nz = sn[i * 3 + 2];
      // rigid transform (rotation about Y + translation) → same basis for normals
      this.nrm.a[this.nrm.n++] = e[0] * nx + e[4] * ny + e[8] * nz;
      this.nrm.a[this.nrm.n++] = e[1] * nx + e[5] * ny + e[9] * nz;
      this.nrm.a[this.nrm.n++] = e[2] * nx + e[6] * ny + e[10] * nz;
      this.uv.a[this.uv.n++] = su[i * 2];
      this.uv.a[this.uv.n++] = su[i * 2 + 1];
      this.col.a[this.col.n++] = sc[i * 3];
      this.col.a[this.col.n++] = sc[i * 3 + 1];
      this.col.a[this.col.n++] = sc[i * 3 + 2];
      if (this.win) {
        if (sw) {
          this.win.a[this.win.n++] = sw[i * 4];
          this.win.a[this.win.n++] = sw[i * 4 + 1];
          this.win.a[this.win.n++] = sw[i * 4 + 2];
          this.win.a[this.win.n++] = sw[i * 4 + 3];
        } else { this.win.n += 4; }
      }
      if (this.gls) {
        if (sg) {
          this.gls.a[this.gls.n++] = sg[i * 3];
          this.gls.a[this.gls.n++] = sg[i * 3 + 1];
          this.gls.a[this.gls.n++] = sg[i * 3 + 2];
        } else { this.gls.n += 3; }
      }
    }
    this.verts += n;
    return this;
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.view().slice(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.view().slice(), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.view().slice(), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.view().slice(), 3));
    if (this.win) g.setAttribute('aWin', new THREE.BufferAttribute(this.win.view().slice(), 4));
    if (this.gls) g.setAttribute('aGls', new THREE.BufferAttribute(this.gls.view().slice(), 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** A named set of builders — one per material slot — for a whole chunk. */
export class BuilderSet {
  constructor() { this.map = new Map(); }
  get(slot) {
    let b = this.map.get(slot);
    if (!b) { b = new Builder(slot === 'glass'); this.map.set(slot, b); }
    return b;
  }
  get slots() { return [...this.map.keys()]; }
  get triangles() { let t = 0; for (const b of this.map.values()) t += b.triangles; return t; }
  clear() { this.map.clear(); }
}

export default Builder;
