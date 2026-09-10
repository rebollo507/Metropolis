/**
 * Rolling time series, so `ui` can graph the city without the simulation ever
 * building an array. Every series is one preallocated Float32Array ring; the
 * only allocation is in `series()`, which is a read path, not a tick path.
 */

import { HISTORY_LEN } from './constants.js';

const SERIES = [
  'population', 'households', 'jobs', 'employed', 'unemployment',
  'budget', 'income', 'expense', 'demandR', 'demandC', 'demandI',
  'landValue', 'pollution', 'coverage', 'traffic', 'commute', 'happiness',
];

export class History {
  constructor(len = HISTORY_LEN) {
    this.len = len;
    this.n = 0;
    this.head = 0;
    this.data = {};
    for (const s of SERIES) this.data[s] = new Float32Array(len);
    this.day = new Float32Array(len);
    this.hour = new Float32Array(len);
  }

  push(sample, day, hour) {
    const i = this.head;
    for (const s of SERIES) {
      const v = sample[s];
      this.data[s][i] = Number.isFinite(v) ? v : 0;
    }
    this.day[i] = day; this.hour[i] = hour;
    this.head = (i + 1) % this.len;
    if (this.n < this.len) this.n++;
  }

  /** Oldest-first copy of one series (or of everything). */
  series(name, count = 0) {
    const n = this.n, take = count > 0 ? Math.min(count, n) : n;
    const start = (this.head - take + this.len * 2) % this.len;
    const pull = (arr) => {
      const out = new Array(take);
      for (let k = 0; k < take; k++) out[k] = arr[(start + k) % this.len];
      return out;
    };
    if (name && this.data[name]) return pull(this.data[name]);
    const o = { day: pull(this.day), hour: pull(this.hour) };
    for (const s of SERIES) o[s] = pull(this.data[s]);
    return o;
  }

  latest(name) {
    if (!this.n) return 0;
    const i = (this.head - 1 + this.len) % this.len;
    return this.data[name] ? this.data[name][i] : 0;
  }

  get names() { return SERIES.slice(); }
}

export default History;
