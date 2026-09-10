import * as THREE from 'three';

/**
 * A tiny mesh builder. Every prop is authored as real geometry (no primitives
 * dropped in a row), merged into one indexed BufferGeometry per (shape,
 * material) pair so the whole city costs one draw call per pair.
 *
 * Attributes written: position, normal, uv, aSway (wind stiffness weight, used
 * by the shader patch in Materials.js). aSway is always present so a geometry
 * can be moved onto a swaying material later without a rebuild.
 */

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

export class Builder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.sway = [];
    this.idx = [];
    this.m = new THREE.Matrix4();
    this.nm = new THREE.Matrix3();
    this.stack = [];
    this.swayBase = 0;
  }

  /* ------------------------------------------------------------ transform */

  push() { this.stack.push(this.m.clone()); return this; }
  pop() { this.m.copy(this.stack.pop()); this.nm.getNormalMatrix(this.m); return this; }
  identity() { this.m.identity(); this.nm.identity(); return this; }
  translate(x, y, z) { this.m.multiply(new THREE.Matrix4().makeTranslation(x, y, z)); this.nm.getNormalMatrix(this.m); return this; }
  rotY(a) { this.m.multiply(new THREE.Matrix4().makeRotationY(a)); this.nm.getNormalMatrix(this.m); return this; }
  rotX(a) { this.m.multiply(new THREE.Matrix4().makeRotationX(a)); this.nm.getNormalMatrix(this.m); return this; }
  rotZ(a) { this.m.multiply(new THREE.Matrix4().makeRotationZ(a)); this.nm.getNormalMatrix(this.m); return this; }
  scale(x, y, z) { this.m.multiply(new THREE.Matrix4().makeScale(x, y, z)); this.nm.getNormalMatrix(this.m); return this; }

  /* ----------------------------------------------------------- primitives */

  v(x, y, z, nx, ny, nz, u, vv, s) {
    _v.set(x, y, z).applyMatrix4(this.m);
    _n.set(nx, ny, nz).applyMatrix3(this.nm).normalize();
    this.pos.push(_v.x, _v.y, _v.z);
    this.nrm.push(_n.x, _n.y, _n.z);
    this.uv.push(u, vv);
    this.sway.push(s === undefined ? this.swayBase : s);
    return this.pos.length / 3 - 1;
  }

  tri(a, b, c) { this.idx.push(a, b, c); }
  face(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  /** Axis-aligned box in the current frame. uvS = metres per texture tile. */
  box(cx, cy, cz, sx, sy, sz, uvS = 1, swayTop = null) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
    const sB = this.swayBase, sT = swayTop === null ? this.swayBase : swayTop;
    const F = (nx, ny, nz, pts, us, vs) => {
      const ids = [];
      for (let i = 0; i < 4; i++) {
        const p = pts[i];
        ids.push(this.v(p[0], p[1], p[2], nx, ny, nz, us[i] / uvS, vs[i] / uvS, p[1] > cy ? sT : sB));
      }
      this.face(ids[0], ids[1], ids[2], ids[3]);
    };
    F(0, 0, 1, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [x0, x1, x1, x0], [y0, y0, y1, y1]);
    F(0, 0, -1, [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [x1, x0, x0, x1], [y0, y0, y1, y1]);
    F(1, 0, 0, [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [z1, z0, z0, z1], [y0, y0, y1, y1]);
    F(-1, 0, 0, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [z0, z1, z1, z0], [y0, y0, y1, y1]);
    F(0, 1, 0, [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [x0, x1, x1, x0], [z1, z1, z0, z0]);
    F(0, -1, 0, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [x0, x1, x1, x0], [z0, z0, z1, z1]);
    return this;
  }

  /** Box with explicit atlas UVs on all faces (signs, cabinets, crates). */
  boxUV(cx, cy, cz, sx, sy, sz, [u0, v0, u1, v1]) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
    const F = (nx, ny, nz, pts) => {
      const ids = [
        this.v(pts[0][0], pts[0][1], pts[0][2], nx, ny, nz, u0, v0),
        this.v(pts[1][0], pts[1][1], pts[1][2], nx, ny, nz, u1, v0),
        this.v(pts[2][0], pts[2][1], pts[2][2], nx, ny, nz, u1, v1),
        this.v(pts[3][0], pts[3][1], pts[3][2], nx, ny, nz, u0, v1),
      ];
      this.face(ids[0], ids[1], ids[2], ids[3]);
    };
    F(0, 0, 1, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
    F(0, 0, -1, [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]);
    F(1, 0, 0, [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]);
    F(-1, 0, 0, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
    F(0, 1, 0, [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]);
    F(0, -1, 0, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
    return this;
  }

  /** Single quad in XY (facing +Z) with atlas UVs — leaves, sign faces, decals. */
  quadXY(cx, cy, w, h, [u0, v0, u1, v1], swayTop = null, cz = 0) {
    const sB = this.swayBase, sT = swayTop === null ? this.swayBase : swayTop;
    const a = this.v(cx - w / 2, cy - h / 2, cz, 0, 0, 1, u0, v0, sB);
    const b = this.v(cx + w / 2, cy - h / 2, cz, 0, 0, 1, u1, v0, sB);
    const c = this.v(cx + w / 2, cy + h / 2, cz, 0, 0, 1, u1, v1, sT);
    const d = this.v(cx - w / 2, cy + h / 2, cz, 0, 0, 1, u0, v1, sT);
    this.face(a, b, c, d);
    return this;
  }

  /** Horizontal quad in XZ facing +Y — ground decals, light pools, slabs. */
  quadXZ(cx, cz, w, d, [u0, v0, u1, v1], y = 0) {
    const a = this.v(cx - w / 2, y, cz + d / 2, 0, 1, 0, u0, v0);
    const b = this.v(cx + w / 2, y, cz + d / 2, 0, 1, 0, u1, v0);
    const c = this.v(cx + w / 2, y, cz - d / 2, 0, 1, 0, u1, v1);
    const d2 = this.v(cx - w / 2, y, cz - d / 2, 0, 1, 0, u0, v1);
    this.face(a, b, c, d2);
    return this;
  }

  /**
   * Tapered tube along a polyline. `pts` = [[x,y,z],...], `rad` = radius per
   * point, `sides` radial resolution. Used for trunks, limbs, poles and pipes.
   */
  tube(pts, rad, sides = 6, uvS = 0.6, swayFrom = 0, swayTo = 0, capTop = false) {
    const n = pts.length;
    if (n < 2) return this;
    const rings = [];
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const ref = new THREE.Vector3();
    const bx = new THREE.Vector3();
    const bz = new THREE.Vector3();
    let vAcc = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (dir.lengthSq() < 1e-9) dir.set(0, 1, 0);
      dir.normalize();
      ref.copy(Math.abs(dir.y) > 0.94 ? new THREE.Vector3(1, 0, 0) : up);
      bx.crossVectors(ref, dir).normalize();
      bz.crossVectors(dir, bx).normalize();
      if (i > 0) {
        const q = pts[i - 1];
        vAcc += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      }
      const t = i / (n - 1);
      const sw = swayFrom + (swayTo - swayFrom) * t * t;
      const ring = [];
      for (let s = 0; s < sides; s++) {
        const ang = (s / sides) * Math.PI * 2;
        const ox = Math.cos(ang), oz = Math.sin(ang);
        const nx = bx.x * ox + bz.x * oz, ny = bx.y * ox + bz.y * oz, nz = bx.z * ox + bz.z * oz;
        ring.push(this.v(
          p[0] + nx * rad[i], p[1] + ny * rad[i], p[2] + nz * rad[i],
          nx, ny, nz, (s / sides) * (Math.PI * 2 * 0.35) / uvS, vAcc / uvS, sw
        ));
      }
      // duplicate the seam vertex for a clean UV wrap
      ring.push(this.v(
        p[0] + bx.x * rad[i], p[1] + bx.y * rad[i], p[2] + bx.z * rad[i],
        bx.x, bx.y, bx.z, (Math.PI * 2 * 0.35) / uvS, vAcc / uvS, sw
      ));
      rings.push(ring);
    }
    for (let i = 1; i < n; i++) {
      const A = rings[i - 1], B = rings[i];
      for (let s = 0; s < sides; s++) this.face(A[s], A[s + 1], B[s + 1], B[s]);
    }
    if (capTop) {
      const p = pts[n - 1];
      const c = this.v(p[0], p[1], p[2], 0, 1, 0, 0.5, 0.5, swayTo);
      const R = rings[n - 1];
      for (let s = 0; s < sides; s++) this.tri(c, R[s], R[s + 1]);
    }
    return this;
  }

  /** Low-poly ellipsoid (bollard heads, hedges, shrub masses, car bodies). */
  blob(cx, cy, cz, rx, ry, rz, seg = 8, uvS = 1, swayTop = 0, squash = null) {
    const rows = Math.max(3, Math.round(seg / 2));
    const grid = [];
    for (let j = 0; j <= rows; j++) {
      const v = j / rows;
      const phi = v * Math.PI;
      const row = [];
      for (let i = 0; i <= seg; i++) {
        const u = i / seg;
        const th = u * Math.PI * 2;
        let nx = Math.sin(phi) * Math.cos(th);
        let ny = Math.cos(phi);
        let nz = Math.sin(phi) * Math.sin(th);
        let px = nx * rx, py = ny * ry, pz = nz * rz;
        if (squash) { const k = squash(u, v); px *= k; pz *= k; }
        row.push(this.v(cx + px, cy + py, cz + pz, nx, ny, nz,
          (u * Math.PI * rx) / uvS, (v * Math.PI * ry) / uvS,
          this.swayBase + (swayTop - this.swayBase) * Math.max(0, ny)));
      }
      grid.push(row);
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < seg; i++) {
        this.face(grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]);
      }
    }
    return this;
  }

  /** Prism from a closed 2D polygon extruded in Y. Kerbs, planters, plinths. */
  prism(poly, y0, y1, uvS = 1) {
    const n = poly.length;
    const top = [], bot = [];
    for (let i = 0; i < n; i++) {
      const p = poly[i], q = poly[(i + 1) % n];
      const dx = q[0] - p[0], dz = q[1] - p[1];
      const l = Math.hypot(dx, dz) || 1;
      const nx = dz / l, nz = -dx / l;
      const a = this.v(p[0], y0, p[1], nx, 0, nz, 0, y0 / uvS);
      const b = this.v(q[0], y0, q[1], nx, 0, nz, l / uvS, y0 / uvS);
      const c = this.v(q[0], y1, q[1], nx, 0, nz, l / uvS, y1 / uvS);
      const d = this.v(p[0], y1, p[1], nx, 0, nz, 0, y1 / uvS);
      // CCW polygons in (x,z) wind the *other* way once lifted into 3D:
      // a-b-c-d faces inward, a-d-c-b faces out.
      this.face(a, d, c, b);
    }
    for (let i = 0; i < n; i++) {
      top.push(this.v(poly[i][0], y1, poly[i][1], 0, 1, 0, poly[i][0] / uvS, poly[i][1] / uvS));
      bot.push(this.v(poly[i][0], y0, poly[i][1], 0, -1, 0, poly[i][0] / uvS, poly[i][1] / uvS));
    }
    for (let i = 1; i < n - 1; i++) {
      this.tri(top[0], top[i + 1], top[i]);
      this.tri(bot[0], bot[i], bot[i + 1]);
    }
    return this;
  }

  get triangles() { return this.idx.length / 3; }

  build(name = 'props', { smooth = false } = {}) {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.setIndex(this.idx);
    // Lofted shells (car bodies) get their normals recomputed: the per-ring
    // normal used while building is only correct in the horizontal plane.
    if (smooth) g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** Atlas cell helper: 4x4 grid of a 1024 px atlas, inset to avoid bleeding. */
export function cell4(i, inset = 0.004) {
  const c = 0.25;
  const x = (i % 4) * c, y = Math.floor(i / 4) * c;
  // canvas textures are not flipped by three's default flipY=true handling for
  // CanvasTexture: uv.y = 1 - pixelY/size, so invert the row here.
  const v1 = 1 - y - inset, v0 = 1 - y - c + inset;
  return [x + inset, v0, x + c - inset, v1];
}

/** Atlas cell helper for a 2x2 atlas (leaf clusters, far canopies). */
export function cell2(i, inset = 0.006) {
  const c = 0.5;
  const x = (i % 2) * c, y = Math.floor(i / 2) * c;
  const v1 = 1 - y - inset, v0 = 1 - y - c + inset;
  return [x + inset, v0, x + c - inset, v1];
}

export default Builder;
