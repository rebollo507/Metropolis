/**
 * The shared world data model — the single source of truth.
 * Plain, serialisable data only. NO three.js objects live in here;
 * rendering is a projection of this state.
 */

export const ZONE = {
  NONE: 0,
  RES_LOW: 1, RES_HIGH: 2,
  COM_LOW: 3, COM_HIGH: 4,
  IND: 5, OFFICE: 6,
  PARK: 7, CIVIC: 8,
  ROAD: 9, WATER: 10, RESERVED: 11,
};

export const ROAD_CLASS = {
  alley:    { width: 6,  lanes: 1, speed: 20, sidewalk: 1.2 },
  lane2:    { width: 9,  lanes: 2, speed: 45, sidewalk: 2.2 },
  lane4:    { width: 16, lanes: 4, speed: 60, sidewalk: 3.0 },
  boulevard:{ width: 24, lanes: 4, speed: 60, sidewalk: 3.4, median: 4 },
  highway:  { width: 22, lanes: 4, speed: 100, sidewalk: 0 },
};

let _nextId = 1;
export const nextId = () => _nextId++;
export const resetIds = (n = 1) => { _nextId = n; };

export class World {
  constructor(seed = 1337) {
    this.seed = seed >>> 0;

    this.time = { day: 0, hours: 13.0, speed: 1, paused: false };
    this.weather = { preset: 'clear', wetness: 0, cloudCover: 0.25, windDir: 0.7, windSpeed: 3.2 };

    this.terrain = {
      size: 2048,
      resolution: 513,
      heights: null,        // Float32Array, filled by the terrain module
      water: 0,
      biome: 'temperate',
      version: 0,
    };

    this.roads = { nodes: new Map(), segments: new Map(), version: 0 };

    this.zoning = { cells: null, cellSize: 8, gridW: 0, gridH: 0, version: 0 };

    this.buildings = new Map();
    this.props = { version: 0, count: 0 };

    this.agents = { count: 0, capacity: 0, pos: null, vel: null, kind: null, path: null };

    this.stats = {
      population: 0, jobs: 0, happiness: 0.5, budget: 100000,
      demand: { r: 0.5, c: 0.4, i: 0.3 }, traffic: 0,
    };
  }

  static create(seed = 1337) { resetIds(1); return new World(seed); }

  /* ---- terrain helpers (safe before the terrain module has run) ---- */

  heightAt(x, z) {
    const t = this.terrain;
    if (!t.heights) return 0;
    const n = t.resolution, half = t.size / 2, step = t.size / (n - 1);
    const fx = (x + half) / step, fz = (z + half) / step;
    const i0 = Math.max(0, Math.min(n - 2, Math.floor(fx)));
    const j0 = Math.max(0, Math.min(n - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - i0));
    const tz = Math.max(0, Math.min(1, fz - j0));
    const h = t.heights;
    const h00 = h[j0 * n + i0], h10 = h[j0 * n + i0 + 1];
    const h01 = h[(j0 + 1) * n + i0], h11 = h[(j0 + 1) * n + i0 + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  normalAt(x, z, eps = 2) {
    const hL = this.heightAt(x - eps, z), hR = this.heightAt(x + eps, z);
    const hD = this.heightAt(x, z - eps), hU = this.heightAt(x, z + eps);
    const nx = hL - hR, nz = hD - hU, ny = 2 * eps;
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx / len, ny / len, nz / len];
  }

  /* ---- versioning ---- */

  touch(slice) {
    const s = this[slice];
    if (s && typeof s.version === 'number') s.version++;
    return s ? s.version : 0;
  }

  /* ---- serialisation & determinism hash ---- */

  serialize() {
    return {
      seed: this.seed,
      time: { ...this.time },
      weather: { ...this.weather },
      terrain: {
        size: this.terrain.size, resolution: this.terrain.resolution,
        water: this.terrain.water, biome: this.terrain.biome,
        heights: this.terrain.heights ? Array.from(this.terrain.heights) : null,
      },
      roads: {
        nodes: [...this.roads.nodes.values()],
        segments: [...this.roads.segments.values()],
      },
      zoning: {
        cellSize: this.zoning.cellSize, gridW: this.zoning.gridW, gridH: this.zoning.gridH,
        cells: this.zoning.cells ? Array.from(this.zoning.cells) : null,
      },
      buildings: [...this.buildings.values()],
      stats: JSON.parse(JSON.stringify(this.stats)),
    };
  }

  /** FNV-1a over a stable, low-precision projection of the model. */
  hash() {
    let h = 0x811c9dc5;
    const put = (s) => {
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    };
    put('s' + this.seed);
    const t = this.terrain;
    put('t' + t.size + ',' + t.resolution + ',' + t.water);
    if (t.heights) {
      // sample a fixed lattice so the hash is stable but sensitive
      for (let j = 0; j < t.resolution; j += 8)
        for (let i = 0; i < t.resolution; i += 8)
          put(t.heights[j * t.resolution + i].toFixed(2));
    }
    put('n' + this.roads.nodes.size + 'g' + this.roads.segments.size);
    // R-tools-2: order-independent. Map insertion order changes after an undo/redo
    // even when the content is identical, which made the hash useless for asserting
    // that undo restored the world. Sort by id.
    for (const s of [...this.roads.segments.values()].sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0)))
      put(s.id + s.class + s.a + s.b + (s.length || 0).toFixed(1));
    if (this.zoning.cells) {
      let acc = 0;
      for (let i = 0; i < this.zoning.cells.length; i++) acc = (acc * 31 + this.zoning.cells[i]) >>> 0;
      put('z' + acc);
    }
    put('b' + this.buildings.size);
    for (const b of [...this.buildings.values()].sort((x, y) => (x.id > y.id ? 1 : x.id < y.id ? -1 : 0)))
      put(b.id + b.kind + b.levels + b.height.toFixed(1) + b.rotation.toFixed(2));
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}

export default World;
