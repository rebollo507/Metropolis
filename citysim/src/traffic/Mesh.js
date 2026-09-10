import * as THREE from 'three';

/**
 * A compact mesh builder. Traffic authors every vehicle and pedestrian in code
 * (the asset policy is procedural-only), so this is the whole modelling toolkit:
 * a transform stack, boxes, lathes and — the important one — `loft`, which
 * stitches a stack of closed rings into a shell with exact analytic normals.
 *
 * A car built from a box reads as a doorstop. A car lofted through five rings
 * with a tumblehome at the shoulder and a raked screen reads as a car, and it is
 * the same number of triangles.
 */

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

export class Builder {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.idx = [];
    this.m = new THREE.Matrix4();
    this.nm = new THREE.Matrix3();
    this.stack = [];
    this.extra = null;            // optional per-vertex attribute (part id, pivot)
  }

  push() { this.stack.push(this.m.clone()); return this; }
  pop() { this.m.copy(this.stack.pop()); this.nm.getNormalMatrix(this.m); return this; }
  translate(x, y, z) { this.m.multiply(_T.makeTranslation(x, y, z)); this.nm.getNormalMatrix(this.m); return this; }
  rotY(a) { this.m.multiply(_T.makeRotationY(a)); this.nm.getNormalMatrix(this.m); return this; }
  rotX(a) { this.m.multiply(_T.makeRotationX(a)); this.nm.getNormalMatrix(this.m); return this; }
  rotZ(a) { this.m.multiply(_T.makeRotationZ(a)); this.nm.getNormalMatrix(this.m); return this; }
  scale(x, y, z) { this.m.multiply(_T.makeScale(x, y, z)); this.nm.getNormalMatrix(this.m); return this; }

  v(x, y, z, nx, ny, nz, u = 0, w = 0) {
    _v.set(x, y, z).applyMatrix4(this.m);
    _n.set(nx, ny, nz).applyMatrix3(this.nm).normalize();
    this.pos.push(_v.x, _v.y, _v.z);
    this.nrm.push(_n.x, _n.y, _n.z);
    this.uv.push(u, w);
    if (this.extra) this.extra.push(...this.extraValue);
    return this.pos.length / 3 - 1;
  }

  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  box(cx, cy, cz, sx, sy, sz, uvS = 1) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const F = (nx, ny, nz, pts) => {
      const ids = pts.map((p, k) => this.v(
        cx + p[0] * hx, cy + p[1] * hy, cz + p[2] * hz, nx, ny, nz,
        (k === 1 || k === 2) ? sx / uvS : 0, (k >= 2) ? sy / uvS : 0
      ));
      this.quad(ids[0], ids[1], ids[2], ids[3]);
    };
    F(0, 0, 1, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]);
    F(0, 0, -1, [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]);
    F(1, 0, 0, [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]);
    F(-1, 0, 0, [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]);
    F(0, 1, 0, [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]);
    F(0, -1, 0, [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]);
    return this;
  }

  /** Flat quad in the local XY plane facing +Z (lamps, plates, signs). */
  plate(cx, cy, cz, w, h) {
    const a = this.v(cx - w / 2, cy - h / 2, cz, 0, 0, 1, 0, 0);
    const b = this.v(cx + w / 2, cy - h / 2, cz, 0, 0, 1, 1, 0);
    const c = this.v(cx + w / 2, cy + h / 2, cz, 0, 0, 1, 1, 1);
    const d = this.v(cx - w / 2, cy + h / 2, cz, 0, 0, 1, 0, 1);
    this.quad(a, b, c, d);
    return this;
  }

  /** Cylinder about the local X axis — a wheel. */
  wheel(cx, cy, cz, r, halfW, seg = 12, hubR = 0) {
    const ring = (x, rr, nx) => {
      const ids = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const cy2 = Math.cos(a), sz = Math.sin(a);
        ids.push(this.v(cx + x, cy + cy2 * rr, cz + sz * rr, nx || 0, nx ? 0 : cy2, nx ? 0 : sz,
          i / seg, nx ? 0 : 1));
      }
      return ids;
    };
    const l = ring(-halfW, r, 0), rgt = ring(halfW, r, 0);
    for (let i = 0; i < seg; i++) {
      const k = (i + 1) % seg;
      this.quad(l[i], rgt[i], rgt[k], l[k]);
    }
    for (const [x, nx] of [[-halfW, -1], [halfW, 1]]) {
      const outer = ring(x, r, nx);
      const inner = hubR > 0 ? ring(x, hubR, nx) : null;
      const centre = this.v(cx + x, cy, cz, nx, 0, 0, 0.5, 0.5);
      for (let i = 0; i < seg; i++) {
        const k = (i + 1) % seg;
        if (inner) {
          if (nx > 0) { this.quad(inner[i], outer[i], outer[k], inner[k]); this.tri(centre, inner[k], inner[i]); }
          else { this.quad(inner[k], outer[k], outer[i], inner[i]); this.tri(centre, inner[i], inner[k]); }
        } else if (nx > 0) this.tri(centre, outer[i], outer[k]);
        else this.tri(centre, outer[k], outer[i]);
      }
    }
    return this;
  }

  /**
   * Stitch closed rings into a shell. `rings` = [{y, pts:[[x,z],...]}] with the
   * same point count in every ring. Normals come from the two surface tangents.
   */
  loft(rings, capTop = true, capBottom = true, uvS = 1.4) {
    const R = rings.length, N = rings[0].pts.length;
    const P = rings.map((r) => r.pts.map((p) => [p[0], r.y, p[1]]));
    const ids = [];
    let flip = 0;
    for (let j = 0; j < R; j++) {
      const row = [];
      for (let i = 0; i < N; i++) {
        const p = P[j][i];
        const a = P[j][(i + 1) % N], c = P[j][(i - 1 + N) % N];
        const tu = [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
        const hi = P[Math.min(R - 1, j + 1)][i], lo = P[Math.max(0, j - 1)][i];
        const tv = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
        let n = [
          tv[1] * tu[2] - tv[2] * tu[1],
          tv[2] * tu[0] - tv[0] * tu[2],
          tv[0] * tu[1] - tv[1] * tu[0],
        ];
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        n = [n[0] / l, n[1] / l, n[2] / l];
        if (j === 0 && i === 0) flip = (n[0] * p[0] + n[2] * p[2]) < 0 ? -1 : 1;
        row.push(this.v(p[0], p[1], p[2], n[0] * flip, n[1] * flip, n[2] * flip,
          (i / N) * 3 / uvS, p[1] / uvS));
      }
      ids.push(row);
    }
    for (let j = 0; j < R - 1; j++) {
      const A = ids[j], B = ids[j + 1];
      for (let i = 0; i < N; i++) {
        const k = (i + 1) % N;
        this.quad(A[i], B[i], B[k], A[k]);
      }
    }
    const fan = (ring, y, up) => {
      const c = ring.map((p) => this.v(p[0], p[1], p[2], 0, up, 0, (p[0] + 4) / uvS, (p[2] + 4) / uvS));
      const centre = this.v(0, y, 0, 0, up, 0, 0.5, 0.5);
      for (let i = 0; i < N; i++) {
        const k = (i + 1) % N;
        if (up > 0) this.tri(centre, c[k], c[i]); else this.tri(centre, c[i], c[k]);
      }
    };
    if (capTop) fan(P[R - 1], rings[R - 1].y, 1);
    if (capBottom) fan(P[0], rings[0].y, -1);
    return ids;
  }

  build(name = 'traffic') {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }

  get triangles() { return this.idx.length / 3; }
}

const _T = new THREE.Matrix4();

/** Rounded rectangle in XZ (length along Z, width along X), centred. */
export function roundRect(len, wid, r, n = 4) {
  const hx = wid / 2 - r, hz = len / 2 - r;
  const pts = [];
  const corners = [[hx, hz], [-hx, hz], [-hx, -hz], [hx, -hz]];
  const start = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i <= n; i++) {
      const a = start[c] + (i / n) * (Math.PI / 2);
      pts.push([corners[c][0] + Math.cos(a) * r, corners[c][1] + Math.sin(a) * r]);
    }
  }
  return pts;
}

export default Builder;
