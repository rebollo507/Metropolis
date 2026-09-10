/**
 * Lane-graph router.
 *
 * A* over the directed lane graph with a travel-time cost that includes live
 * congestion, plus a small penalty for turns so a route does not zig-zag through
 * a grid when a straight run costs the same. Two caches keep the per-tick budget
 * flat:
 *
 *  - `costOf[lane]`  — the per-lane traversal cost, refreshed in bulk whenever
 *    congestion is re-measured rather than recomputed inside the search.
 *  - `routeCache`    — `fromLane|toLane` → the lane list, with an LRU-ish cap.
 *    Grid cities re-use the same corridors constantly, so the hit rate is high.
 *
 * All storage is preallocated typed arrays; a search touches only the nodes it
 * pops, and a dirty-stamp array avoids clearing them between searches.
 */

const TURN_PENALTY = [0.0, 3.0, 1.6, 9.0];   // straight, left, right, u-turn (seconds)

/**
 * Per-class cost multiplier, by road rank (alley … highway).
 *
 * Free-flow travel time alone does not put traffic where traffic goes: measured
 * on the demo city, 66% of the fleet sat on local streets holding 43% of the
 * lane-km while the boulevard the hero camera points down carried 3%. Real
 * assignment models solve this with link penalties — drivers avoid residential
 * streets out of all proportion to the extra seconds — so local streets cost
 * more per metre than the clock says and arterials cost less.
 */
const CLASS_COST = [2.0, 1.30, 0.82, 0.70, 0.66];

export class Router {
  constructor(net) {
    this.net = net;
    this.routeCache = new Map();
    this.cacheCap = 4096;
    this.alloc();
    this.searches = 0;
    this.expansions = 0;
    this.hits = 0;
  }

  alloc() {
    const n = this.net.count;
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.came = new Int32Array(n);
    this.stamp = new Int32Array(n);
    this.closed = new Uint8Array(n);
    this.epoch = 0;
    this.cost = new Float32Array(n);
    this.endX = new Float32Array(n);
    this.endZ = new Float32Array(n);
    this.heapIdx = new Int32Array(n).fill(-1);
    this.heap = new Int32Array(Math.max(64, n));
    this.heapN = 0;
    this.maxSpeed = 1;
    for (let i = 0; i < n; i++) {
      const o = (this.net.ptOff[i] + this.net.ptCount[i] - 1) * 3;
      this.endX[i] = this.net.pts[o];
      this.endZ[i] = this.net.pts[o + 2];
      this.maxSpeed = Math.max(this.maxSpeed, this.net.speed[i]);
    }
    this.refreshCosts(null);
  }

  /** Rebuild the per-lane cost table. `congestion` is a Float32Array in [0,1]. */
  refreshCosts(congestion) {
    const n = this.net.count;
    for (let i = 0; i < n; i++) {
      const v = this.net.speed[i];
      const c = congestion ? congestion[i] : 0;
      // a fully jammed lane costs ~5x free flow
      const eff = Math.max(1.2, v * (1 - 0.8 * c));
      const cw = CLASS_COST[this.net.rank[i]] ?? 1;
      this.cost[i] = (this.net.len[i] / eff) * cw + (this.net.isConn[i] ? 0.6 : 0);
    }
    this.routeCache.clear();
    return this;
  }

  /* --------------------------------------------------------------- heap -- */

  _push(id) {
    const h = this.heap, f = this.f;
    let i = this.heapN++;
    h[i] = id; this.heapIdx[id] = i;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[h[p]] <= f[h[i]]) break;
      const t = h[p]; h[p] = h[i]; h[i] = t;
      this.heapIdx[h[p]] = p; this.heapIdx[h[i]] = i;
      i = p;
    }
  }

  _pop() {
    const h = this.heap, f = this.f;
    const top = h[0];
    this.heapIdx[top] = -1;
    const last = --this.heapN;
    if (last > 0) {
      h[0] = h[last];
      this.heapIdx[h[0]] = 0;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < last && f[h[l]] < f[h[m]]) m = l;
        if (r < last && f[h[r]] < f[h[m]]) m = r;
        if (m === i) break;
        const t = h[m]; h[m] = h[i]; h[i] = t;
        this.heapIdx[h[m]] = m; this.heapIdx[h[i]] = i;
        i = m;
      }
    }
    return top;
  }

  _sift(id) {
    const h = this.heap, f = this.f;
    let i = this.heapIdx[id];
    if (i < 0) return;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[h[p]] <= f[h[i]]) break;
      const t = h[p]; h[p] = h[i]; h[i] = t;
      this.heapIdx[h[p]] = p; this.heapIdx[h[i]] = i;
      i = p;
    }
  }

  /* -------------------------------------------------------------- search -- */

  /**
   * Shortest lane sequence from `from` to `to`, INCLUDING both endpoints.
   * Returns an Int32Array, or null when unreachable / budget exceeded.
   */
  route(from, to, maxExpand = 4000) {
    if (from === to) return Int32Array.of(from);
    if (from < 0 || to < 0 || from >= this.net.count || to >= this.net.count) return null;
    const key = from * this.net.count + to;
    const cached = this.routeCache.get(key);
    if (cached) { this.hits++; return cached; }

    const net = this.net;
    const ep = ++this.epoch;
    this.heapN = 0;
    this.searches++;

    const tx = this.endX[to], tz = this.endZ[to];
    const inv = 1 / this.maxSpeed;
    const h = (id) => Math.hypot(this.endX[id] - tx, this.endZ[id] - tz) * inv;

    this.stamp[from] = ep; this.g[from] = 0; this.f[from] = h(from);
    this.came[from] = -1; this.closed[from] = 0;
    this._push(from);

    let expanded = 0;
    let found = false;
    while (this.heapN > 0) {
      const cur = this._pop();
      if (cur === to) { found = true; break; }
      if (this.closed[cur] === 1 && this.stamp[cur] === ep) { /* already done */ }
      this.closed[cur] = 1;
      if (++expanded > maxExpand) break;

      const o = net.outOff[cur], c = net.outCount[cur];
      const gc = this.g[cur];
      for (let k = 0; k < c; k++) {
        const nx = net.outList[o + k];
        const step = this.cost[nx] + (net.isConn[nx] ? TURN_PENALTY[net.turn[nx]] : 0);
        const ng = gc + step;
        if (this.stamp[nx] !== ep) {
          this.stamp[nx] = ep; this.closed[nx] = 0;
          this.g[nx] = ng; this.f[nx] = ng + h(nx); this.came[nx] = cur;
          this._push(nx);
        } else if (ng < this.g[nx]) {
          this.g[nx] = ng; this.f[nx] = ng + h(nx); this.came[nx] = cur;
          if (this.heapIdx[nx] >= 0) this._sift(nx); else if (!this.closed[nx]) this._push(nx);
        }
      }
    }
    this.expansions += expanded;
    if (!found) return null;

    let n = 0;
    for (let c = to; c !== -1; c = this.came[c]) { n++; if (n > 512) return null; }
    const out = new Int32Array(n);
    let i = n - 1;
    for (let c = to; c !== -1; c = this.came[c]) out[i--] = c;

    if (this.routeCache.size > this.cacheCap) this.routeCache.clear();
    this.routeCache.set(key, out);
    return out;
  }

  /** Cheap forward walk when a full search is not affordable this tick. */
  greedy(from, rng, steps = 12, outArr = null) {
    const net = this.net;
    const out = outArr || [];
    out.length = 0;
    let cur = from;
    out.push(cur);
    for (let i = 0; i < steps; i++) {
      const c = net.outCount[cur];
      if (!c) break;
      const o = net.outOff[cur];
      let pick = net.outList[o + (rng ? rng.int(c) : 0)];
      // prefer straight-on so a greedy walk still reads like a journey
      if (rng && rng.next() < 0.55) {
        for (let k = 0; k < c; k++) {
          const cand = net.outList[o + k];
          if (net.turn[cand] === 0) { pick = cand; break; }
        }
      }
      out.push(pick);
      const c2 = net.outCount[pick];
      if (!c2) break;
      cur = net.outList[net.outOff[pick]];
      out.push(cur);
      i++;
    }
    return out;
  }

  stats() {
    return {
      searches: this.searches, cacheHits: this.hits,
      cached: this.routeCache.size,
      meanExpand: this.searches ? Math.round(this.expansions / this.searches) : 0,
    };
  }
}

export default Router;
