import * as THREE from 'three';
import { ROAD_CLASS } from '../core/World.js';
import { BAND } from './Textures.js';

/**
 * Graph -> geometry.
 *
 * The whole network becomes THREE merged buffers plus two instanced decal
 * batches, so the entire city's roads cost about five draw calls:
 *
 *   surface  asphalt ribbons + filled intersection polygons        (1)
 *   walk     kerb faces, raised sidewalks, junction corner pads     (1)
 *   verge    graded turf shoulders tying the road into the terrain  (1)
 *   marks    lane lines / crosswalks / stop bars / arrows, one
 *            atlas, alpha-blended, offset 14 mm above the asphalt  (1)
 *   decals   manholes + drain gratings                             (2)
 *
 *
 * Intersections are NOT overlapping quads. Each segment is trimmed back from
 * the node by an exact offset-line distance, and the hole left behind is filled
 * with a real polygon whose corners are quadratic-Bezier fillets.
 */

const KERB_H = 0.15;
const KERB_H_HW = 0.10;
const MARK_LIFT = 0.014;
const DECAL_LIFT = 0.010;
const GUTTER_DROP = 0.035;
const SKIRT_DROP = 0.55;

/** Cross-section sample fractions of the half-width, edge-dense for the gutter. */
const CROSS = [-1, -0.955, -0.86, -0.66, -0.42, -0.18, 0, 0.18, 0.42, 0.66, 0.86, 0.955, 1];
/** the marking overlay only has to follow the crown, so it can be coarser */
const MCROSS = [-1, -0.86, -0.42, 0, 0.42, 0.86, 1];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Built cross-section of a road class — shared with the module's public API. */
export function roadSpec(cls) {
  const c = ROAD_CLASS[cls] || ROAD_CLASS.lane2;
  const half = c.width / 2;
  const highway = cls === 'highway';
  return {
    cls, half,
    lanes: c.lanes,
    median: c.median || 0,
    sidewalk: c.sidewalk > 0 ? c.sidewalk : (highway ? 1.6 : 0.7),
    kerbH: highway ? KERB_H_HW : KERB_H,
    speed: c.speed,
    maxBank: highway ? 0.085 : 0.03,
    crown: Math.min(0.19, half * 0.022),
    band: BAND[cls] ? cls : 'lane2',
    marks: cls !== 'alley',
  };
}
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/* ------------------------------------------------------------------ noise -- */

function h2(ix, iy, s) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi, s), b = h2(xi + 1, yi, s), c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm2(x, y, s) {
  return vnoise(x, y, s) * 0.55 + vnoise(x * 2.13, y * 2.13, s + 7) * 0.28 + vnoise(x * 4.7, y * 4.7, s + 19) * 0.17;
}

/* ---------------------------------------------------------------- buffer -- */

class Buf {
  constructor(withRoad = false) {
    this.p = []; this.u = []; this.c = []; this.i = [];
    this.r = withRoad ? [] : null;
    this.n = 0;
  }
  v(x, y, z, u, vv, cr, cg, cb, r0, r1, r2) {
    this.p.push(x, y, z);
    this.u.push(u, vv);
    this.c.push(cr, cg, cb);
    if (this.r) this.r.push(r0 || 0, r1 || 0, r2 || 0);
    return this.n++;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  get empty() { return this.i.length === 0; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (this.r) g.setAttribute('aRoad', new THREE.Float32BufferAttribute(this.r, 3));
    g.setIndex(this.i.length > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Bridge two index rows. Rows run along +across (or bottom->top for walls) and
 * A -> B runs along +s. `flip` reverses the winding, which is what the junction
 * corner pads need because their perimeter runs against the arm direction.
 */
function quadStrip(buf, A, B, flip = false) {
  const n = Math.min(A.length, B.length) - 1;
  if (flip) for (let m = 0; m < n; m++) buf.quad(A[m + 1], A[m], B[m], B[m + 1]);
  else for (let m = 0; m < n; m++) buf.quad(A[m], A[m + 1], B[m + 1], B[m]);
}

/* -------------------------------------------------------------- geometry -- */

export class RoadMeshBuilder {
  constructor(net, opts = {}) {
    this.net = net;
    this.seed = (opts.seed ?? 1337) >>> 0;
    this.tile = opts.asphaltTile ?? 8;
    this.walkTile = opts.concreteTile ?? 4;
    this.vergeTile = opts.vergeTile ?? 4.5;
    this.quality = opts.quality || 'high';
    this.surface = new Buf(true);
    this.walk = new Buf(false);
    this.verge = new Buf(false);
    this.marks = new Buf(false);
    this.decals = [];
    this.junctions = new Map();
  }

  /* ---------------------------------------------------- class geometry --- */

  spec(cls) { return roadSpec(cls); }

  /* ------------------------------------------------------- ribbon frame --- */

  /** Frame of the road at arc length `s` along `seg`. */
  frame(seg, s, sp, out) {
    const net = this.net;
    const L = seg.length || 1;
    const t = clamp(s / L, 0, 1);
    const p = net.pointAt(seg, t, out ? out.p : undefined) || {};
    const d = net.tangentAt(seg, t, out ? out.d : undefined);
    const k = net.curvatureAt(seg, t);
    const v = (sp.speed / 3.6) * 0.72;
    let bank = clamp(k * v * v / 9.81 * 0.35, -sp.maxBank, sp.maxBank);
    // taper the banking out at the segment ends so it meets junctions flat
    const fade = smoothstep(0, 0.18, t) * smoothstep(0, 0.18, 1 - t);
    bank *= fade;
    return {
      x: p.x, y: p.y, z: p.z,
      dx: d.x, dz: d.z,
      nx: -d.z, nz: d.x,
      bankSlope: -bank,
      sp,
    };
  }

  /** World point at across-offset `a` in a frame, including crown + gutter. */
  cross(fr, a, out) {
    const sp = fr.sp;
    const q = Math.abs(a) / sp.half;
    let y = fr.y + a * fr.bankSlope - sp.crown * q * q;
    if (q > 0.94) y -= GUTTER_DROP * ((q - 0.94) / 0.06);
    const o = out || { x: 0, y: 0, z: 0 };
    o.x = fr.x + fr.nx * a;
    o.y = y;
    o.z = fr.z + fr.nz * a;
    return o;
  }

  /* ------------------------------------------------------- surface attrs --- */

  /** (polish, grime, puddle) for a point across the road. */
  roadAttr(sp, a, x, z) {
    const half = sp.half;
    const q = Math.abs(a) / half;
    // wheel-polished tracks: two per lane, 1.7 m apart
    const perSide = Math.max(1, sp.lanes / 2);
    const drive = (half * 2 - sp.median) / 2;
    const lw = drive / perSide;
    let polish = 0;
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < perSide; i++) {
        const c = side * (sp.median / 2 + lw * (i + 0.5));
        for (const w of [-0.85, 0.85]) {
          const dd = (a - (c + w)) / (lw * 0.30);
          polish = Math.max(polish, Math.exp(-dd * dd));
        }
      }
    }
    polish *= 0.55 + 0.45 * fbm2(x * 0.055, z * 0.055, this.seed + 3);
    // kerbside grime + dust
    const grime = smoothstep(0.62, 1.0, q) * (0.55 + 0.45 * fbm2(x * 0.09, z * 0.09, this.seed + 11));
    // puddles pool in the gutter and in low patches
    const n = fbm2(x * 0.045, z * 0.045, this.seed + 23);
    const pud = clamp(smoothstep(0.55, 1.0, q) * 0.85 + smoothstep(0.58, 0.86, n) * 0.75, 0, 1);
    return [clamp(polish, 0, 1), clamp(grime, 0, 1), pud];
  }

  segTone(seg) {
    const r = h2(seg.id, 17, this.seed);
    const r2 = h2(seg.id, 31, this.seed);
    const k = 0.90 + r * 0.20;
    return [k, k * (0.995 + r2 * 0.012), k * (1.0 + r2 * 0.03)];
  }

  /* ---------------------------------------------------------- junctions --- */

  /** Per-node incident-edge table with exact trim distances. */
  analyseJunctions() {
    const net = this.net;
    for (const node of net.roads.nodes.values()) {
      const arms = [];
      for (const sid of node.edges) {
        const seg = net.segment(sid);
        if (!seg || seg.length < 0.5) continue;
        const atA = seg.a === node.id;
        const t = atA ? 0 : 1;
        const tan = net.tangentAt(seg, t);
        const dx = atA ? tan.x : -tan.x;
        const dz = atA ? tan.z : -tan.z;
        const sp = this.spec(seg.class);
        arms.push({
          seg, sid, atA, dx, dz,
          nx: -dz, nz: dx,
          half: sp.half, sw: sp.sidewalk, sp,
          ang: Math.atan2(dz, dx),
          trim: 0,
        });
      }
      arms.sort((p, q) => p.ang - q.ang);

      const N = arms.length;
      if (N >= 2) {
        const maxW = Math.max(...arms.map((a) => a.half));
        const cap = 2.6 * maxW + 9;
        for (let i = 0; i < N; i++) {
          const j = (i + 1) % N;
          let d = arms[j].ang - arms[i].ang;
          while (d <= 0) d += Math.PI * 2;
          if (d > Math.PI - 0.012) continue;                // straight-through or reflex
          const dd = Math.max(0.14, d);
          const s = Math.sin(dd), co = Math.cos(dd);
          const wi = arms[i].half, wj = arms[j].half;
          // exact offset-line intersection: where arm i's left edge meets arm j's right edge
          const ci = (wi * co + wj) / s;
          const cj = (wj * co + wi) / s;
          arms[i].trim = Math.max(arms[i].trim, clamp(ci, 0, cap));
          arms[j].trim = Math.max(arms[j].trim, clamp(cj, 0, cap));
        }
        // Pull the mouths back a little FURTHER than the exact mitre point, so the
        // corner between them has room for a real fillet instead of a knife edge.
        const minHalf = Math.min(...arms.map((a) => a.half));
        let extra = 0;
        if (N >= 3) extra = clamp(minHalf * 0.85, 2.5, 7.5);
        else if (arms.some((a) => a.trim > 0.05)) extra = clamp(minHalf * 0.35, 0.6, 2.2);
        for (const a of arms) a.trim += extra;
        if (N >= 3) for (const a of arms) a.trim = Math.max(a.trim, a.half * 0.42);
      }
      for (const a of arms) a.trim = Math.min(a.trim, a.seg.length * 0.42);
      this.junctions.set(node.id, { node, arms });
    }

    // a segment's two trims must leave a usable middle
    for (const seg of this.net.roads.segments.values()) {
      const ja = this.junctions.get(seg.a), jb = this.junctions.get(seg.b);
      const aa = ja?.arms.find((x) => x.sid === seg.id);
      const ab = jb?.arms.find((x) => x.sid === seg.id);
      const ta = aa ? aa.trim : 0, tb = ab ? ab.trim : 0;
      const total = ta + tb;
      const room = seg.length - 1.2;
      if (total > room && total > 0) {
        const k = Math.max(0, room) / total;
        if (aa) aa.trim = ta * k;
        if (ab) ab.trim = tb * k;
      }
    }
    return this;
  }

  trimOf(seg, atA) {
    const j = this.junctions.get(atA ? seg.a : seg.b);
    const arm = j?.arms.find((x) => x.sid === seg.id);
    return arm ? arm.trim : 0;
  }

  /* ------------------------------------------------------------- build --- */

  build() {
    this.analyseJunctions();
    for (const seg of this.net.roads.segments.values()) this.buildSegment(seg);
    for (const j of this.junctions.values()) this.buildJunction(j);
    return {
      surface: this.surface.empty ? null : this.surface.geometry(),
      walk: this.walk.empty ? null : this.walk.geometry(),
      verge: this.verge.empty ? null : this.verge.geometry(),
      marks: this.marks.empty ? null : this.marks.geometry(),
      decals: this.decals,
    };
  }

  /* ------------------------------------------------------ one segment --- */

  buildSegment(seg) {
    const sp = this.spec(seg.class);
    const net = this.net;
    const L = seg.length;
    const s0 = this.trimOf(seg, true);
    const s1 = L - this.trimOf(seg, false);
    if (s1 - s0 < 0.8) return;

    const tone = this.segTone(seg);
    const cycle = BAND[sp.band].along;
    const sub = this.quality === 'low' ? 4 : 6;
    const step = cycle / sub;

    // ---- collect ring positions, duplicating at marking-cycle boundaries ---
    const rings = [];
    let k = 0;
    for (;;) {
      const s = s0 + k * step;
      if (s >= s1 - 1e-4) break;
      const vv = (k % sub) / sub;
      if (k > 0 && k % sub === 0) {
        rings.push({ s, v: 1, cut: true });          // close the previous strip
        rings.push({ s, v: 0, cut: false });         // open the next one
      } else {
        rings.push({ s, v: vv, cut: false });
      }
      k++;
    }
    rings.push({ s: s1, v: ((s1 - s0) / cycle) % 1 || 1, cut: true });
    if (rings.length < 2) return;

    // ---- emit ---------------------------------------------------------------
    const surf = this.surface, walk = this.walk, marks = this.marks;
    const tmp = { x: 0, y: 0, z: 0 };

    let prevSurf = null, prevMark = null;
    let prevMed = null, lastMed = null;
    let prevL = null, prevR = null;
    let firstSurf = null, lastSurf = null;

    const doMarks = sp.marks;
    const bandInfo = BAND[sp.band];
    const v0 = bandInfo.i / 8, vh = 1 / 8;

    for (let ri = 0; ri < rings.length; ri++) {
      const R = rings[ri];
      // The duplicated ring at a marking-cycle boundary sits at the same arc
      // position as its predecessor: it exists only to break the marking UV
      // strip, so the asphalt and kerb geometry is not re-emitted for it.
      const dup = ri > 0 && Math.abs(rings[ri - 1].s - R.s) < 1e-6;
      const fr = this.frame(seg, R.s, sp);

      // --- asphalt ring ---
      if (!dup) {
        const row = [];
        for (let m = 0; m < CROSS.length; m++) {
          const a = CROSS[m] * sp.half;
          this.cross(fr, a, tmp);
          const at = this.roadAttr(sp, a, tmp.x, tmp.z);
          row.push(surf.v(
            tmp.x, tmp.y, tmp.z,
            tmp.x / this.tile, tmp.z / this.tile,
            tone[0], tone[1], tone[2],
            at[0], at[1], at[2]
          ));
        }
        if (prevSurf) quadStrip(surf, prevSurf, row);
        prevSurf = row;
        if (!firstSurf) firstSurf = { row, fr };
        lastSurf = { row, fr };
      }

      // --- lane-marking ring (same cross-section, lifted) ---
      if (doMarks) {
        const mrow = [];
        const mv = v0 + R.v * vh;
        for (let m = 0; m < MCROSS.length; m++) {
          const a = MCROSS[m] * sp.half;
          this.cross(fr, a, tmp);
          const u = 0.5 + a / (sp.half * 2);
          mrow.push(marks.v(tmp.x, tmp.y + MARK_LIFT, tmp.z, u, mv, 1, 1, 1));
        }
        if (prevMark && !rings[ri - 1].cut) quadStrip(marks, prevMark, mrow);
        prevMark = mrow;
      }

      // --- raised median island (boulevards) ---
      if (!dup && sp.median > 0.5 && !seg.elevated) {
        const m = sp.median / 2;
        const yl = this.cross(fr, -m, tmp).y;
        const yr = this.cross(fr, m, tmp).y;
        const y0 = Math.max(yl, yr) + sp.kerbH;
        const wear = 0.80 + 0.15 * fbm2(fr.x * 0.11, fr.z * 0.11, this.seed + 41);
        // one continuous profile ordered along +across: left kerb face (faces
        // -n), island top (faces up), right kerb face (faces +n)
        const row = [
          [-m, yl, 0.78], [-m, y0, 1.0], [m, y0, 1.0], [m, yr, 0.78],
        ].map(([a, y, k]) => walk.v(
          fr.x + fr.nx * a, y, fr.z + fr.nz * a,
          (fr.x + fr.nx * a) / this.walkTile, (fr.z + fr.nz * a) / this.walkTile,
          wear * k, wear * k, wear * k * 0.97));
        if (prevMed) quadStrip(walk, prevMed, row);
        else walk.quad(row[3], row[2], row[1], row[0]);   // nose, facing -d
        prevMed = row;
        lastMed = row;
      }

      // --- kerb + sidewalk, both sides ---
      if (dup) continue;
      const sides = [];
      for (const side of [1, -1]) {
        const aEdge = side * sp.half;
        this.cross(fr, aEdge, tmp);
        const ex = tmp.x, ey = tmp.y, ez = tmp.z;
        const top = ey + sp.kerbH;
        const ox = fr.x + fr.nx * (aEdge + side * sp.sidewalk);
        const oz = fr.z + fr.nz * (aEdge + side * sp.sidewalk);
        const oy = top - 0.016 * sp.sidewalk;

        const wear = 0.82 + 0.15 * fbm2(ex * 0.11, ez * 0.11, this.seed + 41);
        const slab = 0.92 + 0.16 * h2(Math.floor(ex / 2.4), Math.floor(ez / 2.4), this.seed + 83);
        const stain = (1 - 0.14 * fbm2(ex * 0.3, ez * 0.3, this.seed + 53)) * slab;
        const cr = wear * stain, cg = wear * stain * 0.995, cb = wear * stain * 0.97;

        // vertical faces are wound top->bottom on the +n side, bottom->top on -n
        const face = side > 0
          ? [walk.v(ex, top, ez, ex / this.walkTile, ez / this.walkTile, cr * 1.03, cg * 1.03, cb * 1.03),
             walk.v(ex, ey, ez, ex / this.walkTile, (ez + sp.kerbH) / this.walkTile, cr * 0.8, cg * 0.8, cb * 0.8)]
          : [walk.v(ex, ey, ez, ex / this.walkTile, (ez + sp.kerbH) / this.walkTile, cr * 0.8, cg * 0.8, cb * 0.8),
             walk.v(ex, top, ez, ex / this.walkTile, ez / this.walkTile, cr * 1.03, cg * 1.03, cb * 1.03)];

        const topRow = side > 0
          ? [walk.v(ex, top, ez, ex / this.walkTile, ez / this.walkTile, cr, cg, cb),
             walk.v(ox, oy, oz, ox / this.walkTile, oz / this.walkTile, cr * 0.98, cg * 0.98, cb * 0.98)]
          : [walk.v(ox, oy, oz, ox / this.walkTile, oz / this.walkTile, cr * 0.98, cg * 0.98, cb * 0.98),
             walk.v(ex, top, ez, ex / this.walkTile, ez / this.walkTile, cr, cg, cb)];

        const verge = seg.elevated
          ? this.deckEdgeRow(walk, fr, side, aEdge + side * sp.sidewalk, oy, cr, cg, cb)
          : this.vergeRow(this.verge, ox, oy, oz, fr.nx * side, fr.nz * side, side);

        sides.push({ face, topRow, verge });
      }
      if (prevL) {
        const vb = seg.elevated ? walk : this.verge;
        quadStrip(walk, prevL.face, sides[0].face);
        quadStrip(walk, prevL.topRow, sides[0].topRow);
        quadStrip(vb, prevL.verge, sides[0].verge);
        quadStrip(walk, prevR.face, sides[1].face);
        quadStrip(walk, prevR.topRow, sides[1].topRow);
        quadStrip(vb, prevR.verge, sides[1].verge);
      }
      prevL = sides[0]; prevR = sides[1];
    }

    // close the far end of the median island
    if (lastMed) walk.quad(lastMed[0], lastMed[1], lastMed[2], lastMed[3]);

    // --- junction paint on the approaches --------------------------------
    this.paintApproach(seg, sp, true, s0, s1);
    this.paintApproach(seg, sp, false, s0, s1);

    // --- gutter drains + manholes ----------------------------------------
    if (!seg.elevated) this.scatterDecals(seg, sp, s0, s1);
    else this.buildPiers(seg, sp, s0, s1);

    // --- cap dead ends ----------------------------------------------------
    const degA = net.node(seg.a)?.degree ?? 0;
    const degB = net.node(seg.b)?.degree ?? 0;
    if (!seg.elevated) {
      if (degA === 1 && firstSurf) this.capEnd(seg, sp, firstSurf.fr, -1);
      if (degB === 1 && lastSurf) this.capEnd(seg, sp, lastSurf.fr, 1);
    }
  }

  /**
   * Graded earth verge from the outer edge of the sidewalk down to the
   * terrain. Without this the smoothed road profile leaves the whole network
   * standing on a vertical concrete plinth wherever it is proud of the ground.
   * Returns an index row ordered along +across (reverse it for the -n side).
   */
  vergeRow(buf, ox, oy, oz, nx, nz, side) {
    // Width follows the drop: a road standing 1.5 m proud needs ~6 m of
    // shoulder to reach the ground at a walkable 1:4, otherwise the verge
    // degenerates into a vertical retaining wall.
    const probe = this.net.groundAt(ox + nx * 2.5, oz + nz * 2.5);
    const drop = Math.max(0, oy - probe);
    const VW = clamp(1.9 + drop * 3.0, 1.9, 13);
    const vx = ox + nx * VW, vz = oz + nz * VW;
    const g = this.net.groundAt(vx, vz) + 0.05;
    const vy = clamp(g, oy - 6.0, oy + 2.0);
    const bx = vx + nx * 0.7, bz = vz + nz * 0.7;
    const by = vy - 0.6;

    const n1 = 0.80 + 0.30 * fbm2(vx * 0.08, vz * 0.08, this.seed + 61);
    // Earth tone. The break from concrete to soil happens AT the back of the
    // sidewalk, not gradually across the verge — otherwise the whole shoulder
    // reads as more pavement.
    /* Vertex tints stay near-neutral. The round-1 `lip` was 1.02:0.92:0.78 —
     * a strongly warm multiplier on ground that is already warm where the turf
     * thins, and `effects`' grade adds saturation on top. That product is what
     * the critic measured as a salmon mottle (R-G 33 -> 45). Anything here that
     * pushes R above G gets amplified twice downstream, so it does not. */
    const lip = [0.97 * n1, 0.98 * n1, 0.92 * n1];  // scuffed, trodden, slightly pale
    const e = [1.00 * n1, 1.01 * n1, 1.00 * n1];    // turf, essentially untinted
    const d = [0.74 * n1, 0.75 * n1, 0.72 * n1];    // buried, shaded

    // The verge lives in the ASPHALT buffer, not the concrete one: the paving
    // map carries sawn slab joints that have no business printing themselves
    // onto an earth embankment, and the asphalt map is fine-grained and
    // jointless. Tinted to soil it reads as compacted gravel. Costs nothing:
    // it merges into a mesh that already exists.
    const vt = this.vergeTile;
    const A = buf.v(ox, oy, oz, ox / vt, oz / vt, lip[0], lip[1], lip[2], 0, 0, 0.20);
    const B = buf.v(vx, vy, vz, vx / vt, vz / vt, e[0], e[1], e[2], 0, 0, 0.15);
    const C = buf.v(bx, by, bz, bx / vt, (bz + 1) / vt, d[0], d[1], d[2], 0, 0, 0.15);
    return side > 0 ? [A, B, C] : [C, B, A];
  }

  /**
   * R-demo-6. The edge of a bridge deck, as one continuous cross-section
   * polyline emitted per ring: parapet inner face, coping, fascia, soffit
   * return. Winding follows the same rule as everything else here — horizontal
   * runs ordered along +across face up, vertical runs ordered top-to-bottom
   * face +n — so the whole profile is built once for the +n side and reversed
   * for the other.
   */
  deckEdgeRow(walk, fr, side, aOuter, oy, cr, cg, cb) {
    const PAR_H = 0.98, COPE = 0.30, DECK_T = 1.35;
    const prof = [
      [aOuter, oy, 0.86],                       // back of footway
      [aOuter, oy + PAR_H, 1.04],               // parapet, inner face
      [aOuter + side * COPE, oy + PAR_H, 1.10], // coping
      [aOuter + side * COPE, oy - DECK_T, 0.62],// fascia
      [aOuter * 0.55, oy - DECK_T, 0.44],       // soffit
    ];
    const row = (side > 0 ? prof : prof.slice().reverse()).map(([a, y, k]) => walk.v(
      fr.x + fr.nx * a, y, fr.z + fr.nz * a,
      (fr.x + fr.nx * a) / this.walkTile, (fr.z + fr.nz * a + y) / this.walkTile,
      cr * k, cg * k, cb * k
    ));
    return row;
  }

  /** Rectangular piers from the deck soffit down into the bed. */
  buildPiers(seg, sp, s0, s1) {
    const walk = this.walk;
    const span = s1 - s0;
    if (span < 14) return;
    const n = Math.max(1, Math.round(span / 34));
    const w = Math.min(sp.half * 0.62, 3.4), t = 1.7;
    for (let i = 1; i <= n; i++) {
      const ss = s0 + (span * i) / (n + 1);
      const fr = this.frame(seg, ss, sp);
      const top = fr.y - 1.35;
      const base = this.net.groundAt(fr.x, fr.z) - 1.2;
      if (top - base < 1.5) continue;
      // four corners in the road's own frame
      const c = [];
      for (const [da, dt] of [[-w, -t], [w, -t], [w, t], [-w, t]]) {
        c.push([fr.x + fr.nx * da + fr.dx * dt, fr.z + fr.nz * da + fr.dz * dt]);
      }
      const shade = 0.62 + 0.16 * fbm2(fr.x * 0.07, fr.z * 0.07, this.seed + 97);
      const ring = (y, k) => c.map(([x, z]) => walk.v(
        x, y, z, x / this.walkTile, (z + y) / this.walkTile, shade * k, shade * k, shade * k * 0.97));
      const hi = ring(top, 1.0), lo = ring(base, 0.6);
      for (let m = 0; m < 4; m++) {
        const a = m, b = (m + 1) % 4;
        walk.quad(hi[a], hi[b], lo[b], lo[a]);
      }
      // capping slab so the pier head is not open from above
      walk.quad(hi[0], hi[3], hi[2], hi[1]);
    }
  }

  capEnd(seg, sp, fr, dir) {
    const walk = this.walk;
    const tmp = { x: 0, y: 0, z: 0 };
    const N = CROSS.length;
    const top = [], bot = [];
    for (let m = 0; m < N; m++) {
      const idx = dir > 0 ? m : N - 1 - m;
      const a = CROSS[idx] * sp.half;
      this.cross(fr, a, tmp);
      const gy = Math.min(tmp.y, this.net.groundAt(tmp.x, tmp.z)) - SKIRT_DROP;
      top.push(walk.v(tmp.x, tmp.y, tmp.z, tmp.x / this.walkTile, tmp.z / this.walkTile, 0.55, 0.55, 0.54));
      bot.push(walk.v(tmp.x, gy, tmp.z, tmp.x / this.walkTile, (tmp.z + 1) / this.walkTile, 0.35, 0.35, 0.34));
    }
    quadStrip(walk, top, bot);
  }

  /* ---------------------------------------------------- junction paint --- */

  /** Crosswalk, stop bar and turn arrows on one approach of one segment. */
  paintApproach(seg, sp, atA, s0, s1) {
    if (!sp.marks) return;
    const node = this.net.node(atA ? seg.a : seg.b);
    if (!node || node.degree < 3) return;
    const usable = s1 - s0;
    if (usable < 9) return;

    // distances measured from the junction end, converted to arc length
    const near = atA ? s0 : s1;
    const sign = atA ? 1 : -1;
    const at = (d) => near + sign * d;

    const cw = BAND.crosswalk, sb = BAND.stopbar, ar = BAND.arrows;

    // crosswalk
    this.paintPatch(seg, sp, at(0.9), at(0.9 + cw.along), -sp.half + 0.2, sp.half - 0.2,
      (a) => 0.5 + a / cw.across, cw.i, sign > 0);

    if (usable < 15) return;

    // stop bar on the approaching (right-hand) half, which is +n when the arm
    // direction points away from the junction
    const inner = sp.median / 2 + 0.3;
    const outer = sp.half - 0.35;
    if (outer > inner + 0.5) {
      const a0 = sign > 0 ? inner : -outer;
      const a1 = sign > 0 ? outer : -inner;
      this.paintPatch(seg, sp, at(1.2 + cw.along), at(1.2 + cw.along + sb.along), a0, a1,
        () => 0.5, sb.i, sign > 0, 0.06, 0.94);
    }

    if (usable < 22) return;

    // turn arrows, one per approaching lane
    const perSide = Math.max(1, sp.lanes / 2);
    const drive = (sp.half * 2 - sp.median) / 2;
    const lw = drive / perSide;
    const aStart = at(3.4 + cw.along), aEnd = at(3.4 + cw.along + ar.along);
    for (let i = 0; i < perSide; i++) {
      const c = (sp.median / 2 + lw * (i + 0.5)) * (sign > 0 ? 1 : -1);
      let col = 0;
      if (perSide > 1) col = i === 0 ? 1 : (i === perSide - 1 ? 2 : 0);
      const u0 = col / 3 + 0.015, u1 = (col + 1) / 3 - 0.015;
      const w = Math.min(lw * 0.46, 1.8);
      const lo = c - w, hi = c + w;
      this.paintPatch(seg, sp, aStart, aEnd, Math.min(lo, hi), Math.max(lo, hi),
        (a) => u0 + (u1 - u0) * ((a - Math.min(lo, hi)) / (2 * w)), ar.i, sign > 0);
    }
  }

  /**
   * A marking quad-patch that conforms to the road cross-section.
   * `uOf(a)` maps across-offset to atlas U; band `bi` supplies V.
   */
  paintPatch(seg, sp, sA, sB, aLo, aHi, uOf, bi, forward, vLo = 0.02, vHi = 0.98) {
    const marks = this.marks;
    const L = seg.length;
    let s0 = Math.min(sA, sB), s1 = Math.max(sA, sB);
    if (s1 <= 0 || s0 >= L) return;
    s0 = clamp(s0, 0, L); s1 = clamp(s1, 0, L);
    if (s1 - s0 < 0.05) return;

    const v0 = bi / 8, vh = 1 / 8;
    const NS = 3, NA = Math.max(2, Math.min(10, Math.ceil((aHi - aLo) / 1.6)));
    const tmp = { x: 0, y: 0, z: 0 };
    let prev = null;
    for (let i = 0; i <= NS; i++) {
      const t = i / NS;
      const s = lerp(s0, s1, t);
      // v runs along the road; when the arm points backwards the glyph flips
      const lv = forward ? lerp(vLo, vHi, t) : lerp(vHi, vLo, t);
      const fr = this.frame(seg, s, sp);
      const row = [];
      for (let m = 0; m <= NA; m++) {
        const a = lerp(aLo, aHi, m / NA);
        this.cross(fr, a, tmp);
        row.push(marks.v(tmp.x, tmp.y + MARK_LIFT + 0.002, tmp.z, clamp(uOf(a), 0.002, 0.998), v0 + lv * vh, 1, 1, 1));
      }
      if (prev) quadStrip(marks, prev, row);
      prev = row;
    }
  }

  /* ---------------------------------------------------------- junction --- */

  buildJunction(j) {
    const arms = j.arms;
    if (arms.length < 2) return;
    if (arms.every((a) => a.trim < 0.06)) return;

    const surf = this.surface, walk = this.walk;
    const tmp = { x: 0, y: 0, z: 0 };

    // --- perimeter -----------------------------------------------------------
    const per = [];           // {x,y,z, sp, kind}
    const corners = [];       // fillet ranges for the sidewalk pads
    for (let i = 0; i < arms.length; i++) {
      const A = arms[i];
      const fr = this.frame(A.seg, A.atA ? A.trim : A.seg.length - A.trim, A.sp);
      // walk the mouth from -half to +half in the ARM's outgoing frame
      const flip = !A.atA;
      const startIdx = per.length;
      for (let m = 0; m < CROSS.length; m++) {
        const aa = CROSS[m] * A.half;
        // frame normal is relative to the segment's own direction; if the arm
        // leaves the node backwards, across flips sign
        this.cross(fr, flip ? -aa : aa, tmp);
        per.push({ x: tmp.x, y: tmp.y, z: tmp.z, sp: A.sp });
      }
      const Lc = per[per.length - 1];                 // a = +half in arm frame
      const B = arms[(i + 1) % arms.length];
      const frB = this.frame(B.seg, B.atA ? B.trim : B.seg.length - B.trim, B.sp);
      this.cross(frB, (!B.atA ? 1 : -1) * B.half, tmp);
      const Rc = { x: tmp.x, y: tmp.y, z: tmp.z, sp: B.sp };

      // fillet: quadratic Bezier through the mitre point
      // the mitre point lies BACK along both arm directions from the two mouths
      const ctrl = intersectRays(Lc.x, Lc.z, -A.dx, -A.dz, Rc.x, Rc.z, -B.dx, -B.dz);
      const M = 5;
      const fillet = [];
      for (let k = 1; k <= M; k++) {
        const t = k / (M + 1);
        let px, pz;
        if (ctrl) {
          const mt = 1 - t;
          px = mt * mt * Lc.x + 2 * mt * t * ctrl.x + t * t * Rc.x;
          pz = mt * mt * Lc.z + 2 * mt * t * ctrl.z + t * t * Rc.z;
        } else {
          px = lerp(Lc.x, Rc.x, t); pz = lerp(Lc.z, Rc.z, t);
        }
        const py = lerp(Lc.y, Rc.y, t);
        fillet.push({ x: px, y: py, z: pz, sp: A.sp });
      }
      for (const f of fillet) per.push(f);
      corners.push({
        i, startIdx, arcStart: Lc, arcEnd: Rc, fillet,
        nStart: [A.nx, A.nz], nEnd: [-B.nx, -B.nz],
        sw: Math.max(A.sw, B.sw), kerbH: Math.max(A.sp.kerbH, B.sp.kerbH),
      });
      void startIdx;
    }
    if (per.length < 3) return;

    // --- fill (fan from the node centre; the polygon is star-shaped) --------
    let cx = 0, cy = 0, cz = 0;
    for (const p of per) { cx += p.x; cy += p.y; cz += p.z; }
    cx /= per.length; cy /= per.length; cz /= per.length;
    const tone = [0.96, 0.96, 0.98];
    const cAttr = this.roadAttr(arms[0].sp, 0, cx, cz);
    const centre = surf.v(cx, cy, cz, cx / this.tile, cz / this.tile, tone[0], tone[1], tone[2], cAttr[0] * 0.5, 0, cAttr[2] * 0.6);
    const ring = per.map((p) => {
      const q = Math.hypot(p.x - cx, p.z - cz);
      const at = this.roadAttr(p.sp, clamp(q - p.sp.half * 0.2, 0, p.sp.half), p.x, p.z);
      return surf.v(p.x, p.y, p.z, p.x / this.tile, p.z / this.tile, tone[0], tone[1], tone[2], at[0] * 0.35, at[1] * 0.8, at[2]);
    });
    // perimeter is ordered by increasing atan2(z,x) = clockwise seen from +Y
    for (let i = 0; i < ring.length; i++) surf.tri(centre, ring[(i + 1) % ring.length], ring[i]);

    // --- rounded kerb + sidewalk pad in every corner ------------------------
    for (const c of corners) {
      if (c.sw <= 0.05) continue;
      const pts = [c.arcStart, ...c.fillet, c.arcEnd];
      const M = pts.length - 1;
      let prevFace = null, prevTop = null, prevSkirt = null;
      for (let k = 0; k <= M; k++) {
        const t = k / M;
        const p = pts[k];
        let nx = lerp(c.nStart[0], c.nEnd[0], t);
        let nz = lerp(c.nStart[1], c.nEnd[1], t);
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl; nz /= nl;
        const top = p.y + c.kerbH;
        const ox = p.x + nx * c.sw, oz = p.z + nz * c.sw;
        const oy = top - 0.016 * c.sw;
        const wear = 0.82 + 0.15 * fbm2(p.x * 0.11, p.z * 0.11, this.seed + 41);

        const face = [
          walk.v(p.x, top, p.z, p.x / this.walkTile, p.z / this.walkTile, wear * 1.03, wear * 1.03, wear),
          walk.v(p.x, p.y, p.z, p.x / this.walkTile, (p.z + c.kerbH) / this.walkTile, wear * 0.8, wear * 0.8, wear * 0.78),
        ];
        const topRow = [
          walk.v(p.x, top, p.z, p.x / this.walkTile, p.z / this.walkTile, wear, wear, wear * 0.97),
          walk.v(ox, oy, oz, ox / this.walkTile, oz / this.walkTile, wear * 0.98, wear * 0.98, wear * 0.95),
        ];
        const skirt = this.vergeRow(this.verge, ox, oy, oz, nx, nz, 1);
        if (prevFace) {
          // the corner perimeter runs *against* the arm direction, so flip
          quadStrip(walk, prevFace, face, true);
          quadStrip(walk, prevTop, topRow, true);
          quadStrip(this.verge, prevSkirt, skirt, true);
        }
        prevFace = face; prevTop = topRow; prevSkirt = skirt;
      }
    }
  }

  /* ------------------------------------------------------------ decals --- */

  scatterDecals(seg, sp, s0, s1) {
    const usable = s1 - s0;
    if (usable < 12) return;
    const tmp = { x: 0, y: 0, z: 0 };

    // gutter drains, alternating sides
    const gap = 27;
    let flip = (seg.id & 1) === 0;
    for (let s = s0 + 8; s < s1 - 4; s += gap) {
      const jitter = (h2(seg.id, Math.round(s), this.seed + 5) - 0.5) * 6;
      const ss = clamp(s + jitter, s0 + 2, s1 - 2);
      const fr = this.frame(seg, ss, sp);
      const side = flip ? 1 : -1;
      flip = !flip;
      this.cross(fr, side * (sp.half - 0.42), tmp);
      this.decals.push({
        type: 'grate',
        x: tmp.x, y: tmp.y + DECAL_LIFT, z: tmp.z,
        rot: Math.atan2(-fr.dz, fr.dx),
        sx: 0.78, sz: 0.46,
      });
    }

    // manholes near lane centres
    const mgap = 58;
    for (let s = s0 + 20; s < s1 - 6; s += mgap) {
      const r = h2(seg.id, Math.round(s) + 91, this.seed + 13);
      const jitter = (h2(seg.id, Math.round(s) + 7, this.seed + 29) - 0.5) * 14;
      const ss = clamp(s + jitter, s0 + 3, s1 - 3);
      const fr = this.frame(seg, ss, sp);
      const a = (r - 0.5) * 2 * (sp.half - 1.4);
      this.cross(fr, a, tmp);
      this.decals.push({
        type: 'manhole',
        x: tmp.x, y: tmp.y + DECAL_LIFT, z: tmp.z,
        rot: r * Math.PI,
        sx: 0.72, sz: 0.72,
      });
    }
  }
}

/** Intersection of ray (p, d) with ray (q, e) in XZ, or null if near-parallel. */
function intersectRays(px, pz, dx, dz, qx, qz, ex, ez) {
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-4) return null;
  const t = ((qx - px) * ez - (qz - pz) * ex) / den;
  if (!Number.isFinite(t) || t < 0 || t > 400) return null;
  return { x: px + dx * t, z: pz + dz * t };
}

export default RoadMeshBuilder;
