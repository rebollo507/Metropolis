import { TURN, CTRL, MAX_VEH_WIDTH, angDiff } from './LaneNetwork.js';

/**
 * Vehicle simulation, fixed 20 Hz.
 *
 * Everything lives in preallocated typed arrays; there is no per-agent object
 * anywhere in `step()`. The order of operations each tick is:
 *
 *   1. bucket vehicles by lane and sort by arc length (insertion sort — the
 *      lists are already nearly sorted, so this is O(n) in practice)
 *   2. advance every signalised junction's phase clock
 *   3. resolve one gate per *connector*, not per vehicle: signal aspect,
 *      conflicting movements, and whether the exit lane has room
 *   4. IDM car-following against the true leader (which may be one or two
 *      lanes downstream), plus a virtual stopped leader on a closed stop line
 *   5. integrate, hand over to the next lane in the route, re-route when needed
 *   6. discretionary lane changes with a two-sided gap test
 *
 * The one hard invariant, asserted by tools/simcheck: a vehicle never advances
 * past the end of a lane whose gate is closed.
 */

/* --------------------------------------------------------------- types --- */

export const VEH = {
  car: 0, taxi: 1, van: 2, service: 3, truck: 4, bus: 5,
};
export const VEH_NAMES = ['car', 'taxi', 'van', 'service', 'truck', 'bus'];

export const VEH_SPEC = [
  //  len   wid   height  aMax  bComf  vFactor  mass-ish
  { len: 4.52, wid: 1.80, h: 1.46, a: 2.30, b: 2.6, vf: 1.00 },  // car
  { len: 4.78, wid: 1.82, h: 1.50, a: 2.45, b: 2.8, vf: 1.06 },  // taxi
  { len: 5.36, wid: 1.94, h: 2.24, a: 1.75, b: 2.3, vf: 0.94 },  // van
  { len: 5.60, wid: 1.94, h: 2.10, a: 1.70, b: 2.3, vf: 0.90 },  // service
  { len: 8.60, wid: 2.44, h: 3.10, a: 1.05, b: 1.9, vf: 0.82 },  // truck
  { len: 11.6, wid: 2.50, h: 3.20, a: 1.15, b: 2.0, vf: 0.80 },  // bus
];

/* ------------------------------------------------------------- IDM ------- */

const S0 = 2.1;         // minimum standstill gap, metres
const T_HEAD = 1.15;    // desired time headway, seconds
const B_MAX = 7.0;      // emergency deceleration
const LAT_RATE = 1.5;   // lane-change lateral rate, m/s
/* How far short of the lane end a held vehicle's NOSE waits. Round 1 clamped the
 * vehicle *centre* to 0.35 m short of the end, which put the nose of a 4.5 m car
 * 2.2 m past it and a bus 5.5 m past — straight onto the crossing the pavement
 * graph and `roads`' zebra both put there. The stop line is now measured from
 * the nose, with 3 m of clearance for the crossing itself. */
const STOP_MARGIN = 3.0;

/* signal timing (seconds) */
// A 90 m block cannot absorb a long cycle: the queue from one junction reaches
// back into the last, and the grid locks itself. 31 s total is short for a real
// arterial but it is what keeps a tight lattice flowing without a green wave.
const GREEN_T = 15.0, AMBER_T = 2.4, ALLRED_T = 0.8;
/** Design progression speed for the green wave, m/s (~40 km/h). */
const PROGRESSION = 11.0;

/** Minimum straight-line trip length, metres. */
const MIN_TRIP = 260;

/** Fleet mix by lane class. Heavies only exist where they fit. */
const FLEET_WIDE = [[VEH.car, 70], [VEH.taxi, 8], [VEH.van, 9], [VEH.service, 5], [VEH.truck, 5], [VEH.bus, 3]];
const FLEET_NARROW = [[VEH.car, 76], [VEH.taxi, 9], [VEH.van, 9], [VEH.service, 6]];

export class Sim {
  constructor(net, router, rng, opts = {}) {
    this.net = net;
    this.router = router;
    this.rng = rng;
    this.capacity = opts.capacity || 600;
    this.maxRoute = 56;
    this.routeBudget = opts.routeBudget ?? 6;
    this.tickCount = 0;
    this.simTime = 0;
    this.alloc();
    this.allocLanes();
    this.freezeSignals = false;
    this.frozenGreen = 1;
    this.spawnCursor = 0;
    this.stats = { vehicles: 0, stopped: 0, meanSpeedRatio: 1, reroutes: 0,
      redHoldTicks: 0, laneChanges: 0, separations: 0, ranRed: 0, committed: 0 };
  }

  alloc() {
    const C = this.capacity;
    this.alive = new Uint8Array(C);
    this.lane = new Int32Array(C).fill(-1);
    this.s = new Float32Array(C);
    this.v = new Float32Array(C);
    this.acc = new Float32Array(C);
    this.type = new Uint8Array(C);
    this.vlen = new Float32Array(C);
    this.vwid = new Float32Array(C);
    this.lat = new Float32Array(C);
    this.latTarget = new Float32Array(C);
    this.blink = new Int8Array(C);          // -1 right, 0 none, +1 left
    this.blinkT = new Float32Array(C);
    this.route = new Int32Array(C * this.maxRoute);
    this.routeLen = new Uint8Array(C);
    this.routeIdx = new Uint8Array(C);
    this.needRoute = new Uint8Array(C);
    this.waited = new Float32Array(C);
    this.life = new Float32Array(C);
    this.color = new Float32Array(C * 3);
    this.tint = new Float32Array(C);        // per-vehicle roughness/variation seed
    this.prev = new Float32Array(C * 4);    // x,y,z,yaw
    this.cur = new Float32Array(C * 4);
    this.commit = new Uint8Array(C);        // 1 = past the line when it changed
    this.odo = new Float32Array(C);         // distance travelled, drives wheel roll
    this.steer = new Float32Array(C);       // front-wheel angle, radians
    this.gate = new Uint8Array(C);          // 1 while held at a closed stop line
    this.stopped = new Uint8Array(C);
    this.free = new Int32Array(C);
    this.freeN = C;
    for (let i = 0; i < C; i++) this.free[i] = C - 1 - i;
    this.count = 0;
  }

  allocLanes() {
    const n = Math.max(1, this.net.count);
    this.laneCount = new Int32Array(n);
    this.laneStart = new Int32Array(n + 1);
    this.order = new Int32Array(this.capacity);
    this.orderPos = new Int32Array(this.capacity);
    this.connGate = new Uint8Array(n);
    this.laneOcc = new Int32Array(n);
    this.approachEta = new Float32Array(n);
    this.laneSpeedSum = new Float32Array(n);
    this.congestion = new Float32Array(n);
    this.laneQueue = new Int32Array(n);
    const nodes = this.net.nodes.length || 1;
    this.sigGreen = new Int8Array(nodes).fill(1);
    this.sigPhaseT = new Float32Array(nodes);
    this.sigState = new Uint8Array(nodes);   // 0 green, 1 amber, 2 all-red
    /* Signal progression — a green wave along the east-west arterials.
     *
     * Random offsets make a grid stop every platoon at every junction, which is
     * both ugly and (measurably) about a third slower. Offsetting each junction
     * by the time it takes to drive to it lets a platoon released at one signal
     * arrive at the next as it turns green. Group 1 is the east-west phase, so
     * the offset is derived from x. */
    const cycle = GREEN_T + AMBER_T + ALLRED_T;
    const full = cycle * 2;
    for (let i = 0; i < nodes; i++) {
      const nd = this.net.nodes[i];
      const x = nd ? nd.x : 0;
      let o = (x / PROGRESSION) % full;
      if (o < 0) o += full;
      this.sigPhaseT[i] = o % cycle;
      this.sigGreen[i] = (Math.floor(o / cycle) & 1) ? 0 : 1;
    }
  }

  onNetworkRebuilt() {
    this.allocLanes();
    for (let i = 0; i < this.capacity; i++) if (this.alive[i]) this.kill(i);
  }

  /* ------------------------------------------------------------ spawning -- */

  /** Lane ids a vehicle of this width may legally use. */
  _laneOk(lane, width) {
    const net = this.net;
    if (net.isConn[lane]) return false;
    const cls = net.seg[lane] >= 0 ? this._clsOf(lane) : 'lane2';
    return width <= (MAX_VEH_WIDTH[cls] ?? 2.6);
  }

  _clsOf(lane) {
    const segId = this.net.seg[lane];
    const s = this.world ? this.world.roads.segments.get(segId) : null;
    return s ? s.class : 'lane2';
  }

  /** Cache the class of every road lane once — `_clsOf` is a map lookup. */
  cacheClasses(world) {
    this.world = world;
    const n = this.net.count;
    this.laneCls = new Uint8Array(n);
    const RANKS = ['alley', 'lane2', 'lane4', 'boulevard', 'highway'];
    this.laneClsName = RANKS;
    this.laneMaxW = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const seg = world.roads.segments.get(this.net.seg[i]);
      const cls = seg ? seg.class : 'lane2';
      this.laneCls[i] = Math.max(0, RANKS.indexOf(cls));
      this.laneMaxW[i] = MAX_VEH_WIDTH[cls] ?? 2.6;
    }
    // connectors inherit their approach lane's allowance
    for (let i = 0; i < n; i++) {
      if (this.net.isConn[i]) {
        const f = this.net.connFrom[i];
        if (f >= 0) { this.laneCls[i] = this.laneCls[f]; this.laneMaxW[i] = this.laneMaxW[f]; }
      }
    }
    this._spawnLanes = null;
  }

  /**
   * Where vehicles start and finish, as a weighted pool.
   *
   * Sampling lanes uniformly is wrong twice over: it over-weights short lanes
   * (an organic fringe throws up 20 m stubs, and each one gets the same share as
   * a 90 m arterial lane), and it ignores road class, so an arterial ends up
   * *less* densely used than a back street — the opposite of a real city.
   * Weighting by length × class rank fixes both. Measured before: lane2 32
   * veh/lane-km against the boulevard's 13.
   */
  _spawnPool(width) {
    if (!this._spawnLanes) this._spawnLanes = new Map();
    const key = width > 2.2 ? 'wide' : 'narrow';
    let pool = this._spawnLanes.get(key);
    if (pool) return pool;
    /* alley, lane2, lane4, boulevard, highway.
     * The highway weight used to be the highest, which put a fifth of the whole
     * fleet on 3 km of motorway that appears in no street shot while the
     * boulevard the hero camera points down carried eight cars. Weight the
     * classes a camera actually sees. */
    const CLS_W = [0, 1.0, 3.2, 5.0, 1.2];
    const ids = [], cum = [];
    let acc = 0;
    for (const id of this.net.roadLanes) {
      if (this.laneMaxW[id] < width) continue;
      if (this.net.len[id] < 16) continue;
      const w = this.net.len[id] * (CLS_W[this.laneCls[id]] ?? 1);
      if (w <= 0) continue;
      acc += w;
      ids.push(id);
      cum.push(acc);
    }
    pool = { ids, cum, total: acc, length: ids.length };
    this._spawnLanes.set(key, pool);
    return pool;
  }

  /** Weighted lane draw from a pool built by `_spawnPool`. */
  _drawLane(pool, u) {
    const n = pool.ids.length;
    if (!n) return -1;
    const target = u * pool.total;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (pool.cum[m] < target) lo = m + 1; else hi = m;
    }
    return pool.ids[lo];
  }

  /**
   * Occupancy map used only by spawning: lane -> sorted arc lengths. The per-tick
   * `order` arrays are stale between ticks, and a bulk spawn has to see the
   * vehicles it just placed.
   */
  _occupancy() {
    const occ = new Map();
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const l = this.lane[i];
      if (l < 0) continue;
      let a = occ.get(l);
      if (!a) { a = []; occ.set(l, a); }
      a.push(this.s[i], this.vlen[i]);
    }
    return occ;
  }

  _clearIn(occ, lane, s, halfLen) {
    const a = occ.get(lane);
    if (!a) return true;
    for (let k = 0; k < a.length; k += 2) {
      if (Math.abs(a[k] - s) < halfLen + a[k + 1] * 0.5 + 3.5) return false;
    }
    return true;
  }

  /** Bulk spawn — one occupancy pass, greedy plans, routes filled in by budget. */
  spawnMany(n) {
    const occ = this._occupancy();
    let made = 0;
    for (let k = 0; k < n; k++) {
      const i = this.spawn({ occ });
      if (i < 0) continue;
      made++;
      const l = this.lane[i];
      let a = occ.get(l);
      if (!a) { a = []; occ.set(l, a); }
      a.push(this.s[i], this.vlen[i]);
    }
    return made;
  }

  /**
   * Pick the *lane* first, then a body type that fits it.
   *
   * Choosing the type first and then a lane that accepts it is what turns an
   * avenue into a lorry park: trucks and buses only fit on the wide classes, so
   * the whole heavy fleet — about 7% of vehicles but two to three times a car's
   * length — piles onto the third of the network the camera is usually pointed
   * at. Picking the lane first makes the heavy share of any given street equal
   * to the heavy share of the fleet.
   */
  spawn(opts = {}) {
    if (this.freeN === 0) return -1;
    const occ = opts.occ || this._occupancy();
    const rng = this.rng;
    const forced = opts.type !== undefined ? opts.type : -1;

    let lane = -1, s = 0, t = forced;
    const pool = forced >= 0 ? this._spawnPool(VEH_SPEC[forced].wid) : this._spawnPool(0);
    if (!pool.length) return -1;
    for (let attempt = 0; attempt < 16; attempt++) {
      const cand = this._drawLane(pool, rng.next());
      if (cand < 0) break;
      const tt = forced >= 0 ? forced
        : rng.weighted(this.laneMaxW[cand] >= 2.5 ? FLEET_WIDE : FLEET_NARROW);
      const L = this.net.len[cand];
      const cs = rng.range(2, Math.max(2.5, L - 2));
      if (this._clearIn(occ, cand, cs, VEH_SPEC[tt].len * 0.5)) { lane = cand; s = cs; t = tt; break; }
    }
    if (lane < 0 || t < 0) return -1;
    const spec = VEH_SPEC[t];

    const i = this.free[--this.freeN];
    this.alive[i] = 1;
    this.count++;
    this.lane[i] = lane;
    this.s[i] = s;
    this.v[i] = Math.min(this.net.speed[lane] * spec.vf, rng.range(3, 9));
    this.acc[i] = 0;
    this.type[i] = t;
    this.vlen[i] = spec.len;
    this.vwid[i] = spec.wid;
    this.lat[i] = 0; this.latTarget[i] = 0;
    this.blink[i] = 0; this.blinkT[i] = 0;
    this.waited[i] = 0; this.life[i] = 0;
    this.gate[i] = 0; this.stopped[i] = 0;
    this.tint[i] = rng.next();
    this.odo[i] = rng.range(0, 40);
    this.steer[i] = 0;
    this.routeIdx[i] = 0; this.routeLen[i] = 0;
    this.needRoute[i] = 1;
    this._setRoute(i, lane, true);      // greedy plan now, A* when the budget allows
    this._writeTransform(i, true);
    return i;
  }

  kill(i) {
    if (!this.alive[i]) return false;
    this.alive[i] = 0;
    this.lane[i] = -1;
    this.free[this.freeN++] = i;
    this.count--;
    return true;
  }

  despawn(n = 1) {
    let removed = 0;
    for (let i = 0; i < this.capacity && removed < n; i++) {
      if (this.alive[i] && this.net.isConn[this.lane[i]] === 0) { this.kill(i); removed++; }
    }
    return removed;
  }

  /* -------------------------------------------------------------- routes -- */

  _setRoute(i, from, greedyOnly = false) {
    const rng = this.rng;
    const pool = this._spawnPool(this.vwid[i]);
    const base = i * this.maxRoute;
    // A journey, not a hop: insist on a destination well away from here, so
    // routes are long enough to actually want an arterial
    const ox = this.router.endX[from], oz = this.router.endZ[from];
    for (let attempt = 0; attempt < (greedyOnly ? 0 : 4); attempt++) {
      const to = this._drawLane(pool, rng.next());
      if (to < 0 || to === from) continue;
      if (attempt < 3) {
        const dx = this.router.endX[to] - ox, dz = this.router.endZ[to] - oz;
        if (dx * dx + dz * dz < MIN_TRIP * MIN_TRIP) continue;
      }
      const r = this.router.route(from, to);
      if (r && r.length > 1) {
        const n = Math.min(this.maxRoute, r.length);
        for (let k = 0; k < n; k++) this.route[base + k] = r[k];
        this.routeLen[i] = n;
        this.routeIdx[i] = 0;
        this.needRoute[i] = 0;
        return true;
      }
    }
    // fall back to a greedy walk so the vehicle never stalls with no plan
    const walk = this.router.greedy(from, rng, 12);
    const n = Math.min(this.maxRoute, walk.length);
    for (let k = 0; k < n; k++) this.route[base + k] = walk[k];
    this.routeLen[i] = Math.max(1, n);
    this.routeIdx[i] = 0;
    // a one-lane plan is no plan: keep asking until something longer turns up
    this.needRoute[i] = (greedyOnly || n < 2) ? 1 : 0;
    return n > 1;
  }

  _nextLane(i) {
    const k = this.routeIdx[i] + 1;
    if (k >= this.routeLen[i]) return -1;
    return this.route[i * this.maxRoute + k];
  }

  /* ------------------------------------------------------- lane ordering -- */

  _bucket() {
    const n = this.net.count;
    this.laneCount.fill(0);
    const C = this.capacity;
    for (let i = 0; i < C; i++) {
      if (!this.alive[i]) continue;
      const l = this.lane[i];
      if (l >= 0) this.laneCount[l]++;
    }
    let acc = 0;
    for (let l = 0; l < n; l++) { this.laneStart[l] = acc; acc += this.laneCount[l]; }
    this.laneStart[n] = acc;
    if (!this._cursor || this._cursor.length !== n) this._cursor = new Int32Array(n);
    this._cursor.set(this.laneStart.subarray(0, n));
    for (let i = 0; i < C; i++) {
      if (!this.alive[i]) continue;
      const l = this.lane[i];
      if (l < 0) continue;
      this.order[this._cursor[l]++] = i;
    }
    // insertion sort each lane by descending s (leader first)
    for (let l = 0; l < n; l++) {
      const a = this.laneStart[l], b = a + this.laneCount[l];
      for (let k = a + 1; k < b; k++) {
        const vi = this.order[k], key = this.s[vi];
        let j = k - 1;
        while (j >= a && this.s[this.order[j]] < key) { this.order[j + 1] = this.order[j]; j--; }
        this.order[j + 1] = vi;
      }
      for (let k = a; k < b; k++) this.orderPos[this.order[k]] = k;
    }
  }

  /* ---------------------------------------------------------- signals ----- */

  /**
   * Pin the phase at junctions within `radius` of a point.
   *
   * A showcase still needs a stable aspect at the junction in frame (and one
   * that agrees with the lens colours `props` baked in). Freezing the *whole*
   * city to do that also stops every upstream junction, so nothing arrives and
   * the approach in shot empties out — which is exactly what the first attempt
   * looked like. Freezing locally keeps the supply flowing.
   */
  freezeNear(x, z, radius, group = 1) {
    const nodes = this.net.nodes;
    if (!this.sigFrozen || this.sigFrozen.length !== nodes.length) {
      this.sigFrozen = new Uint8Array(nodes.length);
    }
    const r2 = radius * radius;
    let n = 0;
    for (let k = 0; k < nodes.length; k++) {
      const d = (nodes[k].x - x) ** 2 + (nodes[k].z - z) ** 2;
      this.sigFrozen[k] = d <= r2 ? 1 : 0;
      if (this.sigFrozen[k]) n++;
    }
    this.frozenGreen = group;
    this.freezeSignals = false;
    return n;
  }

  _signals(dt) {
    const cycle = GREEN_T + AMBER_T + ALLRED_T;
    const nodes = this.net.nodes;
    for (let k = 0; k < nodes.length; k++) {
      if (!nodes[k].signalled) { this.sigState[k] = 0; continue; }
      if (this.freezeSignals || (this.sigFrozen && this.sigFrozen[k])) {
        this.sigGreen[k] = this.frozenGreen;
        this.sigState[k] = 0;
        continue;
      }
      let t = this.sigPhaseT[k] + dt;
      if (t >= cycle) { t -= cycle; this.sigGreen[k] = this.sigGreen[k] ? 0 : 1; }
      this.sigPhaseT[k] = t;
      this.sigState[k] = t < GREEN_T ? 0 : (t < GREEN_T + AMBER_T ? 1 : 2);
    }
  }

  /** Aspect for a lane's approach: 0 green, 1 amber, 2 red. */
  aspect(lane) {
    const slot = this.net.nodeSlot[lane];
    if (slot < 0) return 0;
    const node = this.net.nodes[slot];
    if (!node || !node.signalled) return 0;
    const mine = this.net.sigGroup[lane];
    if (this.sigGreen[slot] !== mine) return 2;
    return this.sigState[slot] === 0 ? 0 : (this.sigState[slot] === 1 ? 1 : 2);
  }

  /* --------------------------------------------------- junction gating ---- */

  _gates() {
    const net = this.net;
    const n = net.count;
    this.laneOcc.set(this.laneCount);
    // ETA of the front vehicle on every approach lane
    for (let l = 0; l < n; l++) {
      if (net.isConn[l]) { this.approachEta[l] = Infinity; continue; }
      const c = this.laneCount[l];
      if (!c) { this.approachEta[l] = Infinity; continue; }
      const front = this.order[this.laneStart[l]];
      // a vehicle that is stopped is not "arriving": treating a queue head as an
      // imminent arrival makes every minor movement yield for ever
      if (this.v[front] < 1.2) { this.approachEta[l] = Infinity; continue; }
      const d = net.len[l] - this.s[front];
      this.approachEta[l] = d / Math.max(1.0, this.v[front]);
    }

    for (let c = 0; c < n; c++) {
      if (!net.isConn[c]) { this.connGate[c] = 1; continue; }
      const from = net.connFrom[c], to = net.connTo[c];
      let open = 1;

      // 1 · signal aspect (amber is treated as "stop if you can" per-vehicle)
      const asp = this.aspect(from);
      if (asp === 2) open = 0;

      // 2a · the connector itself must have room at its mouth. Without this a
      // vehicle can hand over onto a connector a bus is still sitting on, and
      // the separation pass cannot fix it afterwards: pushing the follower back
      // far enough would need a negative arc length, so the overlap survives.
      if (open && this.laneCount[c] > 0) {
        const tail = this.order[this.laneStart[c] + this.laneCount[c] - 1];
        if (this.s[tail] < this.vlen[tail] * 0.5 + 2.6) open = 0;
      }

      // 2b · do not block the box: the exit lane must have room. A vehicle that
      // has already picked up speed is leaving, so it needs much less clearance
      // than one sitting in a queue — without that distinction a busy junction
      // shuts itself down.
      if (open && to >= 0) {
        const cnt = this.laneCount[to];
        if (cnt) {
          const tail = this.order[this.laneStart[to] + cnt - 1];
          const need = this.vlen[tail] * 0.5 + (this.v[tail] < 2.5 ? 5.0 : 1.6);
          if (this.s[tail] < need) open = 0;
        }
      }

      // 3 · reserve the exit. Two connectors that feed the same lane can both be
      // empty at the instant they are polled, so an occupancy test alone lets
      // both commit and the two vehicles arrive on top of each other. Whoever is
      // already on a sibling connector owns the merge; ties go to the lower id.
      if (open && to >= 0) {
        const io = net.inOff[to], ic = net.inCount[to];
        for (let q = 0; q < ic; q++) {
          const sib = net.inList[io + q];
          if (sib === c) continue;
          if (this.laneCount[sib] > 0) { open = 0; break; }
          const theirs = net.prio[sib];
          const mine = net.prio[c];
          if (theirs < mine || (theirs === mine && sib > c)) continue;
          if (this.aspect(net.connFrom[sib]) === 2) continue;
          if (this.approachEta[net.connFrom[sib]] < 1.6) { open = 0; break; }
        }
      }

      // 4 · conflicting movements
      if (open) {
        const o = net.conflictOff[c], k = net.conflictCount[c];
        const myPrio = net.prio[c];
        for (let q = 0; q < k; q++) {
          const other = net.conflictList[o + q];
          if (this.laneCount[other] > 0) { open = 0; break; }      // someone is in the box
          // equal priority (two straight-throughs at an unsignalised cross) is
          // broken deterministically by lane id, so the two never both commit
          const theirs = net.prio[other];
          if (theirs < myPrio || (theirs === myPrio && other > c)) continue;
          if (this.aspect(net.connFrom[other]) === 2) continue;    // they are held at red
          if (this.approachEta[net.connFrom[other]] < 2.0) { open = 0; break; }
        }
      }
      this.connGate[c] = open;
    }
  }

  /* --------------------------------------------------------------- step -- */

  step(dt) {
    const net = this.net;
    if (!net.count) return;
    this.tickCount++;
    this.simTime += dt;

    this._bucket();
    this._signals(dt);
    this._gates();

    const C = this.capacity;
    // snapshot previous transform for render interpolation
    this.prev.set(this.cur);

    let routes = 0;
    let stoppedN = 0, speedSum = 0, speedRef = 0;

    for (let oi = 0; oi < this.laneStart[net.count]; oi++) {
      const i = this.order[oi];
      const lane = this.lane[i];
      const laneLen = net.len[lane];
      const v = this.v[i];
      const spec = VEH_SPEC[this.type[i]];
      const half = this.vlen[i] * 0.5;

      /* --- desired speed ------------------------------------------------ */
      let v0 = net.speed[lane] * spec.vf * (0.92 + this.tint[i] * 0.16);
      const bendSigned = net.bend(lane, this.s[i]);
      const bend = Math.abs(bendSigned);
      if (bend > 1e-4) v0 = Math.min(v0, Math.sqrt(3.2 / bend));
      v0 = Math.max(2.0, v0);

      /* --- leader ------------------------------------------------------- */
      let gap = Infinity, dv = 0;
      const laneA = this.laneStart[lane];
      if (oi > laneA) {
        const ld = this.order[oi - 1];
        gap = (this.s[ld] - this.vlen[ld] * 0.5) - (this.s[i] + half);
        dv = v - this.v[ld];
      } else {
        // look downstream through up to two lanes of the route
        let rest = laneLen - this.s[i] - half;
        let k = this.routeIdx[i] + 1;
        for (let hop = 0; hop < 2 && k < this.routeLen[i]; hop++, k++) {
          const nl = this.route[i * this.maxRoute + k];
          const cnt = this.laneCount[nl];
          if (cnt) {
            const tail = this.order[this.laneStart[nl] + cnt - 1];
            gap = rest + this.s[tail] - this.vlen[tail] * 0.5;
            dv = v - this.v[tail];
            break;
          }
          rest += net.len[nl];
        }
      }
      if (gap < 0.05) gap = 0.05;

      /* --- stop line ---------------------------------------------------- */
      const nextLane = this._nextLane(i);
      let gateOpen = 1;
      if (nextLane >= 0 && net.isConn[nextLane]) {
        gateOpen = this.connGate[nextLane];
        const asp = this.aspect(lane);
        if (gateOpen && asp === 1) {
          // amber: stop unless we are already too close to do so comfortably
          const d = laneLen - half - STOP_MARGIN - this.s[i];
          const stopDist = (v * v) / (2 * spec.b) + v * 0.4;
          if (d > stopDist) gateOpen = 0;
        }
        if (gateOpen && net.ctrl[lane] === CTRL.STOP && this.waited[i] < 0.5 && v > 0.8) {
          const d = laneLen - half - STOP_MARGIN - this.s[i];
          if (d < 6) gateOpen = 0;                    // must actually stop at a stop sign
        }
      } else if (nextLane < 0) {
        gateOpen = 0;                                  // no plan: creep to the line and re-route
      }
      /* Commitment. If the nose is already past the stop line when the gate
       * shuts — the light changed while we were inside the dilemma zone — the
       * only safe move is to clear the junction, not to stand still straddling
       * the crossing. This is also what keeps the invariant meaningful: the rule
       * is that nobody *starts* crossing a closed line, not that a vehicle can
       * teleport back behind one. */
      const stopAtEarly = laneLen - half - STOP_MARGIN;
      this.commit[i] = 0;
      if (!gateOpen && this.s[i] > stopAtEarly - 0.05 && nextLane >= 0 && net.isConn[nextLane]) {
        gateOpen = 1;
        this.commit[i] = 1;
        this.stats.committed++;
      }
      this.gate[i] = gateOpen ? 0 : 1;
      const stopAt = stopAtEarly;                      // arc length of the stop line
      if (!gateOpen) {
        const d = stopAt - this.s[i];
        if (d < gap) { gap = Math.max(0.05, d); dv = v; }
      }

      /* --- IDM ---------------------------------------------------------- */
      const ratio = v / v0;
      const freeTerm = 1 - ratio * ratio * ratio * ratio;
      const sStar = S0 + Math.max(0, v * T_HEAD + (v * dv) / (2 * Math.sqrt(spec.a * spec.b)));
      const interact = (sStar / gap) * (sStar / gap);
      let a = spec.a * (freeTerm - interact);
      if (a < -B_MAX) a = -B_MAX;
      if (a > spec.a) a = spec.a;
      this.acc[i] = a;

      let nv = v + a * dt;
      if (nv < 0) nv = 0;
      this.v[i] = nv;

      /* --- integrate ---------------------------------------------------- */
      let ns = this.s[i] + nv * dt;
      if (!gateOpen) {
        // hard invariant: a held vehicle never advances past the stop line, and
        // never moves backwards to get there either
        const limit = Math.max(this.s[i], stopAt);
        if (ns > limit) { ns = limit; this.v[i] = Math.min(this.v[i], 0.35); }
        this.stats.redHoldTicks++;
      }

      if (ns >= laneLen) {
        const nx = this._nextLane(i);
        if (nx < 0) {
          ns = Math.max(0, Math.min(ns, stopAt));
          this.v[i] = 0;
          this.needRoute[i] = 1;
        } else {
          // never hand over onto a connector whose gate is shut: the clamp above
          // should already have stopped us short, so this is the assertion
          // a committed vehicle clearing the junction is not running a red; the
          // violation we care about is *starting* to cross a closed line
          if (net.isConn[nx] && !this.connGate[nx] && !this.commit[i]) this.stats.ranRed++;
          ns -= laneLen;
          this.routeIdx[i]++;
          this.lane[i] = nx;
          if (this.routeIdx[i] >= this.routeLen[i] - 1) this.needRoute[i] = 1;
        }
      }
      // never sit exactly on a lane end: the hand-over test is `>=`
      this.s[i] = Math.max(0, Math.min(ns, net.len[this.lane[i]] - 0.01));

      /* --- bookkeeping -------------------------------------------------- */
      if (this.v[i] < 0.5) { this.waited[i] += dt; stoppedN++; this.stopped[i] = 1; }
      else { this.waited[i] = 0; this.stopped[i] = 0; }
      this.life[i] += dt;
      // wheel roll and steer, for the vertex-shader wheels
      this.odo[i] += this.v[i] * dt;
      if (this.odo[i] > 1e6) this.odo[i] -= 1e6;
      const wantSteer = Math.max(-0.55, Math.min(0.55,
        bendSigned * 14 + (this.latTarget[i] - this.lat[i]) * 0.22));
      this.steer[i] += (wantSteer - this.steer[i]) * 0.28;
      speedSum += this.v[i];
      speedRef += v0;

      // indicator: on while a lane change is in progress or a turn is imminent
      if (this.latTarget[i] !== 0 || Math.abs(this.lat[i]) > 0.08) {
        this.blink[i] = this.latTarget[i] !== 0
          ? (this.latTarget[i] > 0 ? 1 : -1) : (this.lat[i] > 0 ? -1 : 1);
      } else if (net.isConn[this.lane[i]] && net.turn[this.lane[i]] !== TURN.STRAIGHT) {
        this.blink[i] = net.turn[this.lane[i]] === TURN.LEFT ? 1 : -1;
      } else if (nextLane >= 0 && net.isConn[nextLane] && net.turn[nextLane] !== TURN.STRAIGHT
                 && laneLen - this.s[i] < 26) {
        this.blink[i] = net.turn[nextLane] === TURN.LEFT ? 1 : -1;
      } else this.blink[i] = 0;
      if (this.blink[i]) this.blinkT[i] += dt; else this.blinkT[i] = 0;

      // lateral relaxation for lane changes
      if (this.lat[i] !== this.latTarget[i]) {
        const d = this.latTarget[i] - this.lat[i];
        const stepL = Math.sign(d) * Math.min(Math.abs(d), LAT_RATE * dt);
        this.lat[i] += stepL;
        if (Math.abs(this.latTarget[i] - this.lat[i]) < 0.02) this.lat[i] = this.latTarget[i];
      }
    }

    /* --- routing budget ------------------------------------------------- */
    for (let pass = 0; pass < this.capacity && routes < this.routeBudget; pass++) {
      const i = this.spawnCursor = (this.spawnCursor + 1) % this.capacity;
      if (!this.alive[i] || !this.needRoute[i]) continue;
      const cur = this.lane[i];
      if (cur < 0) continue;
      this._setRoute(i, cur);
      routes++;
      this.stats.reroutes++;
    }

    /* --- lane changes (staggered) ---------------------------------------
     * Re-bucket FIRST. Hand-overs during integration have moved vehicles into
     * lanes that the start-of-tick buckets show as empty, so a gap test run on
     * the stale lists would happily merge a car onto a bus that arrived this
     * tick — which is exactly the residual overlap the audit was still finding. */
    this._bucket();
    this._laneChanges(dt);

    /* --- separation ------------------------------------------------------
     * Re-bucket (hand-overs and lane changes have moved vehicles between lanes)
     * and enforce a hard minimum headway. IDM plus the junction gates keep this
     * from firing in normal flow; it exists so "vehicles never interpenetrate"
     * is true by construction rather than true by argument. */
    this._bucket();
    this._separate();

    /* --- transforms ----------------------------------------------------- */
    for (let i = 0; i < C; i++) if (this.alive[i]) this._writeTransform(i, false);

    this.stats.vehicles = this.count;
    this.stats.stopped = stoppedN;
    this.stats.meanSpeedRatio = speedRef > 0 ? speedSum / speedRef : 1;
  }

  _separate() {
    const net = this.net;
    for (let l = 0; l < net.count; l++) {
      const c = this.laneCount[l];
      if (c < 2) continue;
      const start = this.laneStart[l];
      for (let k = start + 1; k < start + c; k++) {
        const me = this.order[k], ld = this.order[k - 1];
        const minGap = this.vlen[ld] * 0.5 + this.vlen[me] * 0.5 + 0.30;
        const limit = this.s[ld] - minGap;
        if (this.s[me] > limit) {
          if (limit < 0) {
            // no room behind: the follower cannot go back past the lane start,
            // so move the leader up instead
            const room = net.len[ld < 0 ? l : l] - 0.01;
            this.s[ld] = Math.min(room, this.s[me] + minGap);
            this.s[me] = 0;
          } else {
            this.s[me] = Math.max(0, limit);
          }
          if (this.v[me] > this.v[ld]) this.v[me] = this.v[ld];
          this.stats.separations++;
        }
      }
    }
  }

  /* -------------------------------------------------------- lane change -- */

  _laneChanges(dt) {
    const net = this.net;
    const phase = this.tickCount % 8;
    // claims stop two vehicles moving into the same hole on the same tick, which
    // the (stale) per-lane order arrays cannot see
    const claimL = this._claimL || (this._claimL = new Int32Array(64));
    const claimS = this._claimS || (this._claimS = new Float32Array(64));
    let claimN = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      if ((i & 7) !== phase) continue;
      if (this.lat[i] !== this.latTarget[i]) continue;   // still sweeping
      const lane = this.lane[i];
      if (lane < 0 || net.isConn[lane]) continue;
      const L = net.len[lane];
      const s = this.s[i];
      if (s < 6 || s > L - 18) continue;

      // is the current leader holding us up?
      const start = this.laneStart[lane], pos = this.orderPos[i];
      if (pos <= start) continue;                        // nothing in front
      const ld = this.order[pos - 1];
      const gap = (this.s[ld] - this.vlen[ld] * 0.5) - (s + this.vlen[i] * 0.5);
      const v0 = net.speed[lane] * VEH_SPEC[this.type[i]].vf;
      if (this.v[ld] > v0 * 0.82 || gap > 34) continue;

      for (const dirTry of _LC_ORDER) {
        const target = dirTry > 0 ? net.right[lane] : net.left[lane];
        if (target < 0) continue;
        if (this.laneMaxW[target] < this.vwid[i]) continue;
        if (!this._gapOk(i, target, s)) continue;
        let clash = false;
        for (let q = 0; q < claimN; q++) {
          if (claimL[q] === target && Math.abs(claimS[q] - s) < 18) { clash = true; break; }
        }
        if (clash) continue;
        // commit. `off` is in the segment's left-normal basis; a backward lane
        // travels the other way, so its lateral sign flips.
        const sign = net.dir[lane] > 0 ? 1 : -1;
        this.lat[i] = (net.off[lane] - net.off[target]) * sign;
        this.latTarget[i] = 0;
        this.lane[i] = target;
        // the plan is now stale: truncate it so `_nextLane` returns -1 (the
        // vehicle creeps to the line) until the router budget re-plans
        this.route[i * this.maxRoute + this.routeIdx[i]] = target;
        this.routeLen[i] = this.routeIdx[i] + 1;
        this.needRoute[i] = 1;
        this.orderPos[i] = -1;
        this.stats.laneChanges++;
        if (claimN < claimL.length) { claimL[claimN] = target; claimS[claimN] = s; claimN++; }
        break;
      }
    }
    void dt;
  }

  _gapOk(i, target, s) {
    const start = this.laneStart[target], cnt = this.laneCount[target];
    const halfMe = this.vlen[i] * 0.5;
    const v = this.v[i];
    let ahead = -1, behind = -1;
    for (let k = start; k < start + cnt; k++) {
      const j = this.order[k];
      if (this.s[j] >= s) ahead = j; else { behind = j; break; }
    }
    if (ahead >= 0) {
      const g = (this.s[ahead] - this.vlen[ahead] * 0.5) - (s + halfMe);
      if (g < S0 + v * 0.9) return false;
    }
    if (behind >= 0) {
      const vb = this.v[behind];
      const g = (s - halfMe) - (this.s[behind] + this.vlen[behind] * 0.5);
      if (g < S0 + vb * 0.9) return false;
      // would the follower have to brake hard?
      const need = (vb * vb - v * v) / (2 * Math.max(1, g));
      if (need > 2.2) return false;
    }
    return true;
  }

  /* --------------------------------------------------------- transforms -- */

  _writeTransform(i, alsoPrev) {
    const lane = this.lane[i];
    if (lane < 0) return;
    const p = this.net.sample(lane, this.s[i], _sp);
    const nx = -p.hz, nz = p.hx;
    const o = i * 4;
    this.cur[o] = p.x + nx * this.lat[i];
    this.cur[o + 1] = p.y;
    this.cur[o + 2] = p.z + nz * this.lat[i];
    let yaw = Math.atan2(p.hx, p.hz);
    if (this.lat[i] !== this.latTarget[i]) {
      const drift = (this.latTarget[i] - this.lat[i]);
      yaw += Math.max(-0.16, Math.min(0.16, drift * 0.09));
    }
    // keep the interpolated yaw on the same branch as the previous frame
    if (!alsoPrev) {
      const prevYaw = this.prev[o + 3];
      yaw = prevYaw + angDiff(prevYaw, yaw);
    }
    this.cur[o + 3] = yaw;
    if (alsoPrev) {
      this.prev[o] = this.cur[o]; this.prev[o + 1] = this.cur[o + 1];
      this.prev[o + 2] = this.cur[o + 2]; this.prev[o + 3] = yaw;
    }
  }

  /* -------------------------------------------------------- congestion --- */

  measure(alpha = 0.25) {
    const net = this.net;
    const n = net.count;
    for (let l = 0; l < n; l++) {
      const c = this.laneCount[l];
      let occ = 0;
      if (c) {
        const start = this.laneStart[l];
        let sum = 0;
        for (let k = start; k < start + c; k++) sum += this.v[this.order[k]];
        const mean = sum / c;
        const vRef = Math.max(2, net.speed[l]);
        const density = Math.min(1, (c * 7.5) / Math.max(12, net.len[l]));
        occ = Math.min(1, 0.65 * (1 - Math.min(1, mean / vRef)) + 0.55 * density);
      }
      this.congestion[l] = this.congestion[l] * (1 - alpha) + occ * alpha;
    }
    return this.congestion;
  }

  /** Per-segment congestion, 0..1, as a plain object for world.stats. */
  bySegment(out) {
    const o = out || {};
    for (const k of Object.keys(o)) delete o[k];
    const net = this.net;
    for (const [segId, lanes] of net.segLanes) {
      let m = 0;
      for (const l of lanes) m = Math.max(m, this.congestion[l]);
      o[segId] = +m.toFixed(3);
    }
    return o;
  }
}

const _sp = { x: 0, y: 0, z: 0, hx: 1, hz: 0 };
const _LC_ORDER = [-1, 1];   // overtake on the left first (right-hand traffic)

export default Sim;
