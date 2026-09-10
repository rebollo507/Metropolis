/**
 * The daily rhythm — the part of the simulation you can actually see.
 *
 * Four activity curves (outbound commute, inbound commute, retail, freight) are
 * evaluated against the clock and the weekday/weekend flag, then combined into
 * (a) a traffic density the `traffic` module is driven with, and (b) per-class
 * occupancy figures that `buildings` reads for its window lights.
 *
 * The curves are wrapped and interpolated, so nothing steps at the hour mark.
 */

import { RHYTHM, WEEKEND, TRAFFIC_MIX, curveAt, clamp, clamp01 } from './constants.js';

export class Rhythm {
  constructor() {
    this.hours = 13;
    this.weekend = false;
    this.commuteOut = 0; this.commuteIn = 0; this.retail = 0; this.freight = 0;
    this.trafficDensity = 1;
    this.occupancy = { res: 0.5, office: 0.3, retail: 0.3, ind: 0.4 };
    this.activity = 0.5;
  }

  /**
   * @param hours     0..24
   * @param day       integer day index (day % 7 >= 5 is the weekend)
   * @param employRate 0..1 — a city with no jobs has no rush hour
   * @param scale     multiplier from population/city size, 0..~1.6
   */
  update(hours, day, employRate = 1, scale = 1) {
    this.hours = hours;
    const dow = ((day % 7) + 7) % 7;
    const weekend = dow >= 5;
    this.weekend = weekend;

    const wo = weekend ? WEEKEND.commuteOut : 1;
    const wi = weekend ? WEEKEND.commuteIn : 1;
    const wr = weekend ? WEEKEND.retail : 1;
    const wf = weekend ? WEEKEND.freight : 1;

    this.commuteOut = curveAt(RHYTHM.commuteOut, hours) * wo * employRate;
    this.commuteIn = curveAt(RHYTHM.commuteIn, hours) * wi * employRate;
    this.retail = curveAt(RHYTHM.retail, hours) * wr;
    this.freight = curveAt(RHYTHM.freight, hours) * wf;

    const commute = Math.max(this.commuteOut, this.commuteIn);
    const d = TRAFFIC_MIX.base
      + TRAFFIC_MIX.commute * commute
      + TRAFFIC_MIX.retail * this.retail
      + TRAFFIC_MIX.freight * this.freight;
    this.trafficDensity = clamp(d * scale, 0, 4);
    this.activity = clamp01((commute * 1.1 + this.retail * 0.7 + this.freight * 0.4) / 2.2);

    /* ---- who is where -------------------------------------------------- */
    // residential occupancy is the complement of "out at work or shopping"
    const away = clamp01(this.commuteOut * 0.55 + this.retail * 0.30 * (weekend ? 1.15 : 0.75));
    this.occupancy.res = clamp01(1 - away * 0.72);
    // offices fill after the morning peak and empty after the evening one
    const office = clamp01(integrate(RHYTHM.commuteOut, RHYTHM.commuteIn, hours)) * (weekend ? 0.18 : 1);
    this.occupancy.office = clamp01(office * employRate);
    this.occupancy.retail = clamp01(this.retail);
    this.occupancy.ind = clamp01(0.28 + 0.62 * this.freight);
    return this;
  }

  /** Trip generation for the hour, as a fraction of the workforce. */
  tripShare() {
    return {
      toWork: this.commuteOut, toHome: this.commuteIn,
      shopping: this.retail, freight: this.freight,
    };
  }
}

/**
 * How full a workplace is: the running integral of arrivals minus departures
 * over the day, normalised. Cheap closed-ish form — 24 adds, no state.
 */
function integrate(outCurve, inCurve, hours) {
  const h = ((hours % 24) + 24) % 24;
  let acc = 0, peak = 0;
  for (let i = 0; i < 24; i++) {
    acc += outCurve[i] - inCurve[i];
    if (acc > peak) peak = acc;
  }
  if (peak <= 0) return 0;
  let cur = 0;
  const n = Math.floor(h);
  for (let i = 0; i < n; i++) cur += outCurve[i] - inCurve[i];
  const f = h - n;
  cur += (outCurve[n % 24] - inCurve[n % 24]) * f;
  return clamp01(cur / peak);
}

export default Rhythm;
