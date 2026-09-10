import { ROAD_CLASS } from '../core/World.js';

/**
 * The routable lane network.
 *
 * `roads` owns a graph of cubic-Bezier *segments*. Traffic needs something else:
 * a directed graph of **lanes** — one per carriageway lane per direction — plus
 * short **connector** lanes that carry a vehicle across a junction from the end
 * of one lane to the start of the next. Everything downstream (car-following,
 * routing, conflict resolution) works on lane ids and arc length along a lane,
 * never on Beziers, so the hot loop is a couple of array reads.
 *
 * Layout is structure-of-arrays: one flat Float32Array of polyline points for
 * every lane in the city, indexed by an offset/count pair.
 *
 * Two conventions inherited from `roads`:
 *   - `laneLayout(cls).centres` lists lane offsets; the first half are negative
 *     (right-hand side of increasing-t travel), the second half positive.
 *   - the lateral basis is the **left** normal of the forward tangent,
 *     `n = (-tz, tx)`, so a negative offset is to the driver's right.
 *
 * Kerb-lane note (see docs/CORE_REQUESTS.md R-props-2 / R-traffic-1): `props`
 * parks cars at `half - 1.02` from the centreline on `lane2`, which overlaps the
 * painted lane by ~0.6 m. Until `roads` owns a real parking lane, the driving
 * line on those classes is pulled inboard by KERB_SHIFT so moving traffic clears
 * the bays instead of driving through them.
 */

export const TURN = { STRAIGHT: 0, LEFT: 1, RIGHT: 2, UTURN: 3 };
export const CTRL = { FREE: 0, SIGNAL: 1, YIELD: 2, STOP: 3 };

const CLASS_RANK = { alley: 0, lane2: 1, lane4: 2, boulevard: 3, highway: 4 };

/** How far the driving line is pulled off the kerb to clear parked cars, per class. */
const KERB_SHIFT = { lane2: 0.75, alley: 0, lane4: 0, boulevard: 0, highway: 0 };

/** Widest vehicle allowed on each class (parked cars steal the kerb on lane2). */
export const MAX_VEH_WIDTH = { alley: 2.0, lane2: 1.95, lane4: 2.6, boulevard: 2.6, highway: 2.6 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Shortest signed difference between two headings. */
export function angDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class LaneNetwork {
  constructor(world, roads, log) {
    this.world = world;
    this.roads = roads;
    this.log = log || { info() {}, warn() {} };
    this.version = -1;
    this.count = 0;
    this._empty();
  }

  _empty() {
    this.count = 0;
    this.pts = new Float32Array(0);
    this.cum = new Float32Array(0);
    this.ptOff = new Int32Array(0);
    this.ptCount = new Int32Array(0);
    this.len = new Float32Array(0);
    this.speed = new Float32Array(0);
    this.seg = new Int32Array(0);
    this.dir = new Int8Array(0);
    this.idx = new Int8Array(0);
    this.nodeIn = new Int32Array(0);
    this.nodeOut = new Int32Array(0);
    this.isConn = new Uint8Array(0);
    this.turn = new Uint8Array(0);
    this.rank = new Uint8Array(0);
    this.prio = new Uint8Array(0);
    this.ctrl = new Uint8Array(0);
    this.sigGroup = new Int8Array(0);
    this.left = new Int32Array(0);
    this.right = new Int32Array(0);
    this.outOff = new Int32Array(0);
    this.outCount = new Uint8Array(0);
    this.outList = new Int32Array(0);
    this.inOff = new Int32Array(0);
    this.inCount = new Uint8Array(0);
    this.inList = new Int32Array(0);
    this.conflictOff = new Int32Array(0);
    this.conflictCount = new Uint8Array(0);
    this.conflictList = new Int32Array(0);
    this.width = new Float32Array(0);
    this.nodes = [];
    this.nodeIndex = new Map();
    this.roadLanes = [];      // ids of non-connector lanes
    this.segLanes = new Map();// segId -> [laneIds]
    this._grid = null;
  }

  /* ------------------------------------------------------------- build --- */

  build() {
    const roads = this.roads;
    const world = this.world;
    if (!roads || !world.roads || world.roads.segments.size === 0) { this._empty(); return this.stats(); }

    const layout = (cls) => {
      try {
        const l = roads.laneLayout ? roads.laneLayout(cls) : null;
        if (l && l.centres && l.centres.length) return l;
      } catch { /* fall through */ }
      const c = ROAD_CLASS[cls] || ROAD_CLASS.lane2;
      const half = c.width / 2, median = c.median || 0;
      const perSide = Math.max(1, c.lanes / 2);
      const drivable = (c.width - median) / 2;
      const lw = drivable / perSide;
      const centres = [];
      for (let i = 0; i < perSide; i++) centres.push(-(median / 2) - lw * (i + 0.5));
      for (let i = 0; i < perSide; i++) centres.push((median / 2) + lw * (i + 0.5));
      return { half, lanes: c.lanes, perSide, laneWidth: lw, median, centres, sidewalk: c.sidewalk };
    };

    const segments = world.roads.segments;
    const nodes = world.roads.nodes;

    /* node radius: how far a lane must be trimmed back to clear the junction */
    const nodeR = new Map();
    for (const n of nodes.values()) {
      let r = 3;
      for (const sid of n.edges || []) {
        const s = segments.get(sid);
        const c = s && ROAD_CLASS[s.class];
        if (c) r = Math.max(r, c.width / 2);
      }
      nodeR.set(n.id, (n.edges && n.edges.length > 1) ? r + 0.6 : 1.0);
    }

    /* ---- pass 1: road lanes ------------------------------------------- */
    const L = [];                       // build-time lane records
    const ptsArr = [];                  // flat point buffer under construction
    const segLanes = new Map();

    const pushLane = (rec, samples) => {
      const id = L.length;
      rec.id = id;
      rec.ptOff = ptsArr.length / 3;
      rec.ptCount = samples.length;
      let acc = 0;
      rec.cum = new Float32Array(samples.length);
      for (let k = 0; k < samples.length; k++) {
        const p = samples[k];
        if (k > 0) {
          const q = samples[k - 1];
          acc += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
        }
        rec.cum[k] = acc;
        ptsArr.push(p.x, p.y, p.z);
      }
      rec.len = acc;
      L.push(rec);
      return id;
    };

    const tmpP = { x: 0, y: 0, z: 0 };
    const tmpT = { x: 0, y: 0, z: 0 };

    for (const s of segments.values()) {
      const cls = s.class;
      const c = ROAD_CLASS[cls] || ROAD_CLASS.lane2;
      const lay = layout(cls);
      const segLen = s.length || 0;
      const trimA = Math.min(nodeR.get(s.a) ?? 3, segLen * 0.34);
      const trimB = Math.min(nodeR.get(s.b) ?? 3, segLen * 0.34);
      const usable = segLen - trimA - trimB;
      if (!(usable > 3)) continue;
      const t0 = trimA / segLen, t1 = 1 - trimB / segLen;
      const vmax = (c.speed || 45) / 3.6;
      const shift = KERB_SHIFT[cls] ?? 0;
      const perSide = Math.max(1, Math.round(lay.centres.length / 2));
      const laneW = lay.laneWidth || 3.5;

      // Alleys carry no through traffic. 6 m between kerbs with `props` parking
      // on both sides leaves no two-way carriageway, and a network of one-way
      // service lanes generates dead-end traps a router cannot escape. They stay
      // in the walk graph, so pedestrians still use them.
      if (cls === 'alley') continue;

      const specs = [];
      {
        for (let i = 0; i < perSide; i++) {
          const base = lay.centres[i];
          const kerb = (i === perSide - 1) ? shift : 0;
          specs.push({ laneIdx: i, off: base + kerb, dir: 1, pos: i, of: perSide });
        }
        for (let i = 0; i < perSide; i++) {
          const base = lay.centres[perSide + i];
          const kerb = (i === perSide - 1) ? -shift : 0;
          specs.push({ laneIdx: perSide + i, off: base + kerb, dir: -1, pos: i, of: perSide });
        }
      }

      const n = clamp(Math.ceil(usable / 6) + 1, 2, 48);
      const ids = [];
      for (const sp of specs) {
        const samples = [];
        for (let k = 0; k < n; k++) {
          const u = k / (n - 1);
          const t = sp.dir > 0 ? lerp(t0, t1, u) : lerp(t1, t0, u);
          roads.pointAt(s.id, t, tmpP);
          roads.tangentAt(s.id, t, tmpT);
          samples.push({
            x: tmpP.x + -tmpT.z * sp.off,
            y: tmpP.y,
            z: tmpP.z + tmpT.x * sp.off,
          });
        }
        const id = pushLane({
          seg: s.id, cls, dir: sp.dir, idx: sp.laneIdx, off: sp.off,
          pos: sp.pos, of: sp.of,
          nodeIn: sp.dir > 0 ? s.a : s.b,
          nodeOut: sp.dir > 0 ? s.b : s.a,
          speed: vmax, isConn: 0, turn: TURN.STRAIGHT,
          rank: CLASS_RANK[cls] ?? 1,
          width: laneW,
          left: -1, right: -1, node: -1, sigGroup: -1, ctrl: CTRL.FREE,
        }, samples);
        ids.push(id);
      }
      segLanes.set(s.id, ids);
    }

    // adjacent lanes for lane changes: same segment, same direction, neighbouring pos
    for (const ids of segLanes.values()) {
      for (const a of ids) {
        for (const b of ids) {
          if (a === b) continue;
          if (L[a].dir !== L[b].dir) continue;
          if (L[b].pos === L[a].pos - 1) L[a].left = b;    // toward the centreline
          if (L[b].pos === L[a].pos + 1) L[a].right = b;   // toward the kerb
        }
      }
    }

    /* ---- pass 2: connectors through junctions -------------------------- */
    const inAt = new Map();   // nodeId -> [laneId]
    const outAt = new Map();
    for (const l of L) {
      if (!inAt.has(l.nodeOut)) inAt.set(l.nodeOut, []);
      inAt.get(l.nodeOut).push(l.id);
      if (!outAt.has(l.nodeIn)) outAt.set(l.nodeIn, []);
      outAt.get(l.nodeIn).push(l.id);
    }

    const headingAtEnd = (l) => {
      const o = l.ptOff * 3, n = l.ptCount;
      const ax = ptsArr[o + (n - 2) * 3], az = ptsArr[o + (n - 2) * 3 + 2];
      const bx = ptsArr[o + (n - 1) * 3], bz = ptsArr[o + (n - 1) * 3 + 2];
      const d = Math.hypot(bx - ax, bz - az) || 1;
      return { x: (bx - ax) / d, z: (bz - az) / d, px: bx, py: ptsArr[o + (n - 1) * 3 + 1], pz: bz };
    };
    const headingAtStart = (l) => {
      const o = l.ptOff * 3;
      const ax = ptsArr[o], az = ptsArr[o + 2];
      const bx = ptsArr[o + 3], bz = ptsArr[o + 5];
      const d = Math.hypot(bx - ax, bz - az) || 1;
      return { x: (bx - ax) / d, z: (bz - az) / d, px: ax, py: ptsArr[o + 1], pz: az };
    };

    const nodeRecs = [];
    const nodeIndex = new Map();
    const connByNode = new Map();

    /** Build one connector lane from `inId` to `outId` through node `nid`. */
    const makeConnector = (inId, outId, nid, turn) => {
      const li = L[inId], lo = L[outId];
      const he = headingAtEnd(li);
      const hs2 = headingAtStart(lo);
      const dist = Math.hypot(hs2.px - he.px, hs2.pz - he.pz);
      if (dist < 0.05) return -1;
      const h = Math.max(1.5, dist * 0.46);
      const c0x = he.px, c0y = he.py, c0z = he.pz;
      const c1x = he.px + he.x * h, c1z = he.pz + he.z * h;
      const c2x = hs2.px - hs2.x * h, c2z = hs2.pz - hs2.z * h;
      const c3x = hs2.px, c3y = hs2.py, c3z = hs2.pz;
      const steps = turn === TURN.STRAIGHT ? 3 : 7;
      const samples = [];
      for (let k = 0; k <= steps; k++) {
        const t = k / steps, mt = 1 - t;
        const a = mt * mt * mt, b = 3 * mt * mt * t, cc = 3 * mt * t * t, d = t * t * t;
        samples.push({
          x: a * c0x + b * c1x + cc * c2x + d * c3x,
          y: lerp(c0y, c3y, t),
          z: a * c0z + b * c1z + cc * c2z + d * c3z,
        });
      }
      const vturn = turn === TURN.STRAIGHT
        ? Math.min(li.speed, lo.speed) * 0.9
        : (turn === TURN.UTURN ? 3.0 : Math.min(7.5, Math.min(li.speed, lo.speed) * 0.55));
      const cid = pushLane({
        seg: -1, cls: li.cls, dir: 0, idx: -1, off: 0, pos: 0, of: 1,
        nodeIn: nid, nodeOut: nid,
        speed: Math.max(2.5, vturn), isConn: 1, turn,
        rank: Math.min(li.rank, lo.rank),
        width: li.width,
        left: -1, right: -1, node: nid,
        sigGroup: -1, ctrl: CTRL.FREE,
        from: inId, to: outId,
      }, samples);
      li.succ = li.succ || [];
      li.succ.push(cid);
      L[cid].succ = [outId];
      lo.pred = lo.pred || [];
      lo.pred.push(cid);
      return cid;
    };

    /** Classify the movement from one lane's end to another's start. */
    const classify = (inId, outId) => {
      const he = headingAtEnd(L[inId]);
      const hs = headingAtStart(L[outId]);
      const dot = he.x * hs.x + he.z * hs.z;
      const cross = he.x * hs.z - he.z * hs.x;      // >0 = turning left
      if (dot < -0.55) return TURN.UTURN;
      if (Math.abs(cross) < 0.36) return TURN.STRAIGHT;
      return cross > 0 ? TURN.LEFT : TURN.RIGHT;
    };

    for (const [nid, ins] of inAt) {
      const outs = outAt.get(nid) || [];
      if (!outs.length) continue;
      const nd = nodes.get(nid);
      const degree = nd ? (nd.edges ? nd.edges.length : 0) : 0;

      // does this junction carry signals? mirror props' rule so the heads it has
      // already placed agree with the phase we run.
      let maxRank = 0, arms = new Set();
      for (const id of ins) { maxRank = Math.max(maxRank, L[id].rank); arms.add(L[id].seg); }
      for (const id of outs) { maxRank = Math.max(maxRank, L[id].rank); arms.add(L[id].seg); }
      const signalled = maxRank >= 2 && arms.size >= 3;

      const nodeSlot = nodeRecs.length;
      nodeIndex.set(nid, nodeSlot);
      nodeRecs.push({
        id: nid, slot: nodeSlot, signalled, degree,
        x: nd ? nd.pos[0] : 0, y: nd ? nd.pos[1] : 0, z: nd ? nd.pos[2] : 0,
        radius: nodeR.get(nid) ?? 3,
        conns: [], approaches: ins.slice(),
      });
      const conns = [];

      for (const inId of ins) {
        const li = L[inId];
        const he = headingAtEnd(li);
        // group outgoing lanes by (segment, direction)
        const groups = new Map();
        for (const outId of outs) {
          const lo = L[outId];
          const key = lo.seg + ':' + lo.dir;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(outId);
        }
        for (const g of groups.values()) g.sort((a, b) => L[a].pos - L[b].pos);

        for (const [, g] of groups) {
          const lo0 = L[g[0]];
          const turn = classify(inId, g[0]);

          if (turn === TURN.UTURN && degree > 1) continue;
          if (lo0.seg === li.seg && turn !== TURN.UTURN) continue;

          // Turn permissions by lane position — but a degree-2 node is a bend in
          // the road, not a junction, so every lane continues through it.
          const isBend = degree <= 2;
          let targetPos;
          if (turn === TURN.LEFT) {
            if (!isBend && li.pos !== 0) continue;
            targetPos = isBend ? Math.min(li.pos, g.length - 1) : 0;
          } else if (turn === TURN.RIGHT) {
            if (!isBend && li.pos !== li.of - 1) continue;
            targetPos = isBend ? Math.min(li.pos, g.length - 1) : g.length - 1;
          } else {
            targetPos = Math.min(li.pos, g.length - 1);
          }
          const outId = g[Math.min(targetPos, g.length - 1)];
          const cid = makeConnector(inId, outId, nid, turn);
          if (cid >= 0) conns.push(cid);
        }
        void he;
      }
      connByNode.set(nid, conns);
      nodeRecs[nodeSlot].conns = conns;
    }

    /* ---- pass 2b: repair orphans ---------------------------------------
     * A lane whose turn permissions leave it with nowhere to go is a trap: a
     * vehicle that enters it stops at the line for ever. That happens at sharp
     * bends and at T-junctions where the only continuation is on the "wrong"
     * side. Give every such lane the best-aligned movement available, ignoring
     * the position rule. */
    let repaired = 0;
    for (const l of L) {
      if (l.isConn || (l.succ && l.succ.length)) continue;
      const outs = outAt.get(l.nodeOut);
      if (!outs || !outs.length) continue;
      let best = -1, bestScore = -Infinity;
      const he = headingAtEnd(l);
      for (const outId of outs) {
        const lo = L[outId];
        if (lo.seg === l.seg && lo.dir === l.dir) continue;
        const hs = headingAtStart(lo);
        const score = he.x * hs.x + he.z * hs.z
          - Math.hypot(hs.px - he.px, hs.pz - he.pz) * 0.02;
        if (score > bestScore) { bestScore = score; best = outId; }
      }
      if (best < 0) {
        // truly a dead end: allow the U-turn back down the same segment
        for (const outId of outs) if (L[outId].seg === l.seg) { best = outId; break; }
      }
      if (best < 0) continue;
      const nid = l.nodeOut;
      const cid = makeConnector(l.id, best, nid, classify(l.id, best));
      if (cid >= 0) {
        repaired++;
        const slot = nodeIndex.get(nid);
        if (slot !== undefined) nodeRecs[slot].conns.push(cid);
        const arr = connByNode.get(nid);
        if (arr) arr.push(cid);
      }
    }
    this.repaired = repaired;

    // predecessors of connectors are their approach lanes
    for (const l of L) {
      if (l.isConn && l.from !== undefined) {
        l.pred = [l.from];
      }
    }

    /* ---- pass 3: signal groups + control ------------------------------- */
    for (const nr of nodeRecs) {
      for (const inId of nr.approaches) {
        const li = L[inId];
        const he = headingAtEnd(li);
        // props derives its lens colour from the *outward* arm bearing
        const bearing = Math.atan2(-he.x, -he.z);
        const g = Math.abs(Math.round(bearing * 2)) % 2;
        li.sigGroup = g;
        li.node = nr.id;
        if (nr.signalled && li.cls !== 'alley') li.ctrl = CTRL.SIGNAL;
        else if (nr.degree >= 3) li.ctrl = li.rank >= 2 ? CTRL.YIELD : CTRL.STOP;
        else li.ctrl = CTRL.FREE;
      }
      for (const cid of nr.conns) {
        const lc = L[cid];
        lc.sigGroup = L[lc.from].sigGroup;
        lc.prio = lc.rank * 4 + (lc.turn === TURN.STRAIGHT ? 3 : lc.turn === TURN.RIGHT ? 2 : 1);
      }
    }

    /* ---- pass 4: junction conflicts ------------------------------------ */
    const conflictOf = new Array(L.length);
    const pxy = (id, k) => {
      const o = (L[id].ptOff + k) * 3;
      return [ptsArr[o], ptsArr[o + 2]];
    };
    for (const nr of nodeRecs) {
      const cs = nr.conns;
      for (let i = 0; i < cs.length; i++) {
        const a = cs[i];
        if (!conflictOf[a]) conflictOf[a] = [];
        for (let j = 0; j < cs.length; j++) {
          if (i === j) continue;
          const b = cs[j];
          if (L[a].from === L[b].from) continue;             // diverge, not a conflict
          let hit = L[a].to === L[b].to;                      // merge
          if (!hit) {
            outer:
            for (let ka = 0; ka < L[a].ptCount; ka++) {
              const [ax, az] = pxy(a, ka);
              for (let kb = 0; kb < L[b].ptCount; kb++) {
                const [bx, bz] = pxy(b, kb);
                // 2.6 m: tight enough that two opposing straight-throughs (≈3.0 m
                // apart on a lane2) are not flagged, wide enough to catch a real cross.
                if ((ax - bx) * (ax - bx) + (az - bz) * (az - bz) < 6.76) { hit = true; break outer; }
              }
            }
          }
          if (hit) conflictOf[a].push(b);
        }
      }
    }

    /* ---- flatten ------------------------------------------------------- */
    const N = L.length;
    this.count = N;
    this.pts = new Float32Array(ptsArr);
    this.cum = new Float32Array(ptsArr.length / 3);
    this.ptOff = new Int32Array(N);
    this.ptCount = new Int32Array(N);
    this.len = new Float32Array(N);
    this.speed = new Float32Array(N);
    this.seg = new Int32Array(N);
    this.dir = new Int8Array(N);
    this.idx = new Int8Array(N);
    this.off = new Float32Array(N);
    this.nodeIn = new Int32Array(N);
    this.nodeOut = new Int32Array(N);
    this.isConn = new Uint8Array(N);
    this.turn = new Uint8Array(N);
    this.rank = new Uint8Array(N);
    this.prio = new Uint8Array(N);
    this.ctrl = new Uint8Array(N);
    this.sigGroup = new Int8Array(N);
    this.node = new Int32Array(N);
    this.nodeSlot = new Int32Array(N);
    this.left = new Int32Array(N);
    this.right = new Int32Array(N);
    this.width = new Float32Array(N);
    this.lanePos = new Int8Array(N);
    this.laneOf = new Int8Array(N);

    let outTotal = 0, inTotal = 0, cTotal = 0;
    for (let i = 0; i < N; i++) {
      outTotal += (L[i].succ ? L[i].succ.length : 0);
      inTotal += (L[i].pred ? L[i].pred.length : 0);
      cTotal += (conflictOf[i] ? conflictOf[i].length : 0);
    }
    this.outOff = new Int32Array(N);
    this.outCount = new Uint8Array(N);
    this.outList = new Int32Array(outTotal);
    this.inOff = new Int32Array(N);
    this.inCount = new Uint8Array(N);
    this.inList = new Int32Array(inTotal);
    this.conflictOff = new Int32Array(N);
    this.conflictCount = new Uint8Array(N);
    this.conflictList = new Int32Array(cTotal);

    let oc = 0, ic = 0, cc = 0;
    for (let i = 0; i < N; i++) {
      const l = L[i];
      this.ptOff[i] = l.ptOff;
      this.ptCount[i] = l.ptCount;
      this.len[i] = l.len;
      this.speed[i] = l.speed;
      this.seg[i] = l.seg;
      this.dir[i] = l.dir;
      this.idx[i] = l.idx;
      this.off[i] = l.off;
      this.nodeIn[i] = l.nodeIn;
      this.nodeOut[i] = l.nodeOut;
      this.isConn[i] = l.isConn;
      this.turn[i] = l.turn;
      this.rank[i] = l.rank;
      this.prio[i] = l.prio || (l.rank * 4 + 3);
      this.ctrl[i] = l.ctrl;
      this.sigGroup[i] = l.sigGroup;
      this.node[i] = l.node;
      this.nodeSlot[i] = nodeIndex.has(l.isConn ? l.node : l.nodeOut)
        ? nodeIndex.get(l.isConn ? l.node : l.nodeOut) : -1;
      this.left[i] = l.left;
      this.right[i] = l.right;
      this.width[i] = l.width;
      this.lanePos[i] = l.pos;
      this.laneOf[i] = l.of;
      this.cum.set(l.cum, l.ptOff);

      this.outOff[i] = oc;
      const su = l.succ || [];
      this.outCount[i] = Math.min(255, su.length);
      for (const v of su) this.outList[oc++] = v;
      this.inOff[i] = ic;
      const pr = l.pred || [];
      this.inCount[i] = Math.min(255, pr.length);
      for (const v of pr) this.inList[ic++] = v;
      this.conflictOff[i] = cc;
      const cf = conflictOf[i] || [];
      this.conflictCount[i] = Math.min(255, cf.length);
      for (const v of cf) this.conflictList[cc++] = v;
    }

    this.connFrom = new Int32Array(N).fill(-1);
    this.connTo = new Int32Array(N).fill(-1);
    for (let i = 0; i < N; i++) {
      if (L[i].isConn) { this.connFrom[i] = L[i].from; this.connTo[i] = L[i].to; }
    }

    this.nodes = nodeRecs;
    this.nodeIndex = nodeIndex;
    this.roadLanes = [];
    for (let i = 0; i < N; i++) if (!this.isConn[i]) this.roadLanes.push(i);
    this.segLanes = segLanes;
    this.version = world.roads.version;
    this._buildGrid();
    return this.stats();
  }

  /* ------------------------------------------------------------ queries -- */

  /** World position + heading at arc length `s` along lane `id`. */
  sample(id, s, out) {
    const o = out || (this._s || (this._s = { x: 0, y: 0, z: 0, hx: 1, hz: 0 }));
    const n = this.ptCount[id];
    if (n < 2) { o.x = 0; o.y = 0; o.z = 0; o.hx = 1; o.hz = 0; return o; }
    const base = this.ptOff[id];
    const cum = this.cum;
    const len = this.len[id];
    s = clamp(s, 0, len);
    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      const m = (lo + hi) >> 1;
      if (cum[base + m] <= s) lo = m; else hi = m;
    }
    const c0 = cum[base + lo], c1 = cum[base + hi];
    const u = c1 - c0 > 1e-5 ? (s - c0) / (c1 - c0) : 0;
    const p = this.pts;
    const a = (base + lo) * 3, b = (base + hi) * 3;
    o.x = lerp(p[a], p[b], u);
    o.y = lerp(p[a + 1], p[b + 1], u);
    o.z = lerp(p[a + 2], p[b + 2], u);
    const dx = p[b] - p[a], dz = p[b + 2] - p[a + 2];
    const d = Math.hypot(dx, dz) || 1;
    o.hx = dx / d; o.hz = dz / d;
    return o;
  }

  /** Curvature proxy: heading change per metre around `s`. */
  bend(id, s) {
    const n = this.ptCount[id];
    if (n < 3) return 0;
    const a = this.sample(id, Math.max(0, s - 4), _b0);
    const b = this.sample(id, Math.min(this.len[id], s + 4), _b1);
    return angDiff(Math.atan2(a.hx, a.hz), Math.atan2(b.hx, b.hz)) / 8;
  }

  /* ------------------------------------------------------ spatial index -- */

  _buildGrid() {
    const cs = 48;
    const g = new Map();
    for (const id of this.roadLanes) {
      const n = this.ptCount[id], o = this.ptOff[id];
      for (let k = 0; k < n; k++) {
        const x = this.pts[(o + k) * 3], z = this.pts[(o + k) * 3 + 2];
        const key = Math.floor(x / cs) + ',' + Math.floor(z / cs);
        let a = g.get(key);
        if (!a) { a = []; g.set(key, a); }
        if (a[a.length - 1] !== id) a.push(id);
      }
    }
    this._grid = g;
    this._gridCell = cs;
  }

  /** Nearest lane + arc length to a world point, or null. */
  nearestLane(x, z, radius = 60) {
    if (!this._grid) return null;
    const cs = this._gridCell;
    const i0 = Math.floor((x - radius) / cs), i1 = Math.floor((x + radius) / cs);
    const j0 = Math.floor((z - radius) / cs), j1 = Math.floor((z + radius) / cs);
    let best = -1, bestD = radius * radius, bestS = 0;
    const seen = new Set();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const arr = this._grid.get(i + ',' + j);
        if (!arr) continue;
        for (const id of arr) {
          if (seen.has(id)) continue;
          seen.add(id);
          const n = this.ptCount[id], o = this.ptOff[id];
          for (let k = 0; k < n; k++) {
            const px = this.pts[(o + k) * 3], pz = this.pts[(o + k) * 3 + 2];
            const d = (px - x) * (px - x) + (pz - z) * (pz - z);
            if (d < bestD) { bestD = d; best = id; bestS = this.cum[o + k]; }
          }
        }
      }
    }
    return best < 0 ? null : { lane: best, s: bestS, dist: Math.sqrt(bestD) };
  }

  stats() {
    let conns = 0, roadLen = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.isConn[i]) conns++; else roadLen += this.len[i];
    }
    return {
      lanes: this.count,
      roadLanes: this.count - conns,
      connectors: conns,
      junctions: this.nodes.length,
      signalled: this.nodes.filter((n) => n.signalled).length,
      laneKm: +(roadLen / 1000).toFixed(2),
    };
  }
}

const _b0 = { x: 0, y: 0, z: 0, hx: 1, hz: 0 };
const _b1 = { x: 0, y: 0, z: 0, hx: 1, hz: 0 };

export default LaneNetwork;
