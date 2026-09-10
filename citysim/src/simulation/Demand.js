/**
 * The RCI demand model.
 *
 * Demand is not a dial — it is the residual of a set of pressures that the rest
 * of the simulation already measures:
 *
 *   R  wants to grow when there are jobs going begging, housing is tight, tax is
 *      low, commutes are short, the air is clean and the services are there.
 *   C  wants to grow when there are residents to sell to and not enough retail
 *      floor for them, and when the streets are accessible.
 *   I  wants to grow when there is unskilled labour spare and industrial floor is
 *      fully used — and it does not care about pollution or land value.
 *
 * Each is smoothed exponentially so it cannot oscillate, and each is clamped to
 * [0,1] so it can be read directly as a bar in the UI.
 */

import { STATE, EDU, DEMAND, TAX_NEUTRAL, COMMUTE_TOLERANCE_MIN, clamp01, smoothstep } from './constants.js';

export class DemandModel {
  constructor() {
    this.r = 0.5; this.c = 0.4; this.i = 0.3;
    this.terms = {};
  }

  /**
   * @param pop      Population
   * @param fields   Fields
   * @param econ     Economy
   * @param extra    { commuteMin, happiness, bankrupt }
   */
  update(pop, fields, econ, extra = {}) {
    const D = DEMAND;

    /* ---- shared pressures ------------------------------------------- */
    const workforce = Math.max(1, pop.workforce);
    const unemployment = pop.byState[STATE.UNEMPLOYED] / workforce;
    const jobVacancy = pop.jobsTotal > 0 ? pop.freeJobs / pop.jobsTotal : 0;
    const housingVacancy = pop.capTotal > 0 ? 1 - pop.count / pop.capTotal : 1;
    const commute = extra.commuteMin || 0;
    const commutePain = smoothstep(COMMUTE_TOLERANCE_MIN * 0.6, COMMUTE_TOLERANCE_MIN * 2.0, commute);
    const servicePain = 1 - clamp01(fields.stats.coverageMean);
    const pollutionPain = clamp01(fields.stats.pollutionMean);
    const lvMean = clamp01(fields.stats.landValueMean);

    const taxPain = (t) => (t - TAX_NEUTRAL) * D.taxGain;

    /* ---- residential -------------------------------------------------- */
    // jobs available per unemployed person is the single strongest driver
    const jobPull = clamp01(jobVacancy * 2.6) * D.jobsGain;
    let r = 0.34
      + jobPull
      - unemployment * 1.25
      - housingVacancy * D.vacancyGain
      - taxPain(econ.tax.r)
      - commutePain * D.commuteGain * 0.55
      - servicePain * D.serviceGain * 0.55
      - pollutionPain * D.pollutionGain
      + lvMean * 0.16;

    /* ---- commercial ---------------------------------------------------- */
    // shops follow people: how much retail floor exists per resident vs target
    const retailJobs = pop.jobsByClass ? pop.jobsByClass[2] : 0;
    const wantRetail = pop.count * D.retailPerCapita;
    const retailGap = wantRetail > 0 ? clamp01((wantRetail - retailJobs) / Math.max(1, wantRetail)) : 0;
    const retailFill = retailJobs > 0 ? (pop.filledByClass ? pop.filledByClass[2] / retailJobs : 0) : 0;
    let c = 0.16
      + retailGap * 1.35
      + retailFill * 0.42
      - taxPain(econ.tax.c)
      - commutePain * D.commuteGain * 0.30
      - servicePain * D.serviceGain * 0.35
      + lvMean * 0.22
      - housingVacancy * 0.35;

    /* ---- industrial ---------------------------------------------------- */
    const unskilled = (pop.byEdu[EDU.NONE] + pop.byEdu[EDU.SCHOOL]) / Math.max(1, pop.count);
    const indJobs = pop.jobsByClass ? pop.jobsByClass[3] : 0;
    const indFill = indJobs > 0 ? (pop.filledByClass ? pop.filledByClass[3] / indJobs : 0) : 0;
    const wantInd = workforce * D.industryPerWorker * (0.5 + unskilled);
    const indGap = wantInd > 0 ? clamp01((wantInd - indJobs) / Math.max(1, wantInd)) : 0;
    let i = 0.14
      + indGap * 1.15
      + indFill * 0.55
      + unemployment * 0.60
      - taxPain(econ.tax.i)
      - servicePain * 0.20;

    if (extra.bankrupt) { r -= 0.35; c -= 0.30; i -= 0.25; }

    r = clamp01(r); c = clamp01(c); i = clamp01(i);

    const k = DEMAND.smooth;
    this.r += (r - this.r) * k;
    this.c += (c - this.c) * k;
    this.i += (i - this.i) * k;

    this.terms = {
      unemployment: +unemployment.toFixed(4),
      jobVacancy: +jobVacancy.toFixed(4),
      housingVacancy: +housingVacancy.toFixed(4),
      commuteMin: +commute.toFixed(2),
      commutePain: +commutePain.toFixed(3),
      servicePain: +servicePain.toFixed(3),
      pollutionPain: +pollutionPain.toFixed(3),
      landValue: +lvMean.toFixed(3),
      retailGap: +retailGap.toFixed(3),
      indGap: +indGap.toFixed(3),
      taxR: econ.tax.r, taxC: econ.tax.c, taxI: econ.tax.i,
      rawR: +r.toFixed(3), rawC: +c.toFixed(3), rawI: +i.toFixed(3),
    };
    return this;
  }

  value() { return { r: +this.r.toFixed(4), c: +this.c.toFixed(4), i: +this.i.toFixed(4) }; }
}

export default DemandModel;
