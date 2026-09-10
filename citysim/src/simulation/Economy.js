/**
 * The city budget.
 *
 * Revenue is a property tax on assessed value — and assessed value is derived
 * from the land-value field, so a district that gets a park, a school and a
 * quiet street literally pays more tax. Expenditure is the sum of real line
 * items: road maintenance per lane-kilometre, per-building services, per-capita
 * consumables, and the upkeep of every service installation the city owns.
 *
 * Settlement is monthly (30 in-game days). Bankruptcy is a *state*: services
 * degrade, growth stops, and the city can recover if the player raises taxes or
 * shuts installations down. It never throws.
 */

import {
  CLASS, VALUE_PER_M2, RATEABLE_YIELD, UPKEEP_PER_LANE_KM, UPKEEP_PER_BUILDING,
  SERVICE_PER_CAPITA, DEBT_INTEREST_MONTH, BANKRUPT_LIMIT,
  TAX_DEFAULT, TAX_MIN, TAX_MAX, clamp,
} from './constants.js';

export class Economy {
  constructor(startBudget = 100000) {
    this.budget = startBudget;
    this.tax = { ...TAX_DEFAULT };
    this.month = 0;
    this.bankrupt = false;
    this.bankruptMonths = 0;
    this.last = this._emptyLedger();
    this.ledgers = [];          // most recent first, capped
  }

  _emptyLedger() {
    return {
      month: 0,
      income: { residential: 0, commercial: 0, industrial: 0, total: 0 },
      expense: { roads: 0, buildings: 0, services: 0, percapita: 0, interest: 0, total: 0 },
      net: 0, budget: this.budget, bankrupt: false,
      assessed: { residential: 0, commercial: 0, industrial: 0, total: 0 },
    };
  }

  setTax(a, b) {
    if (typeof a === 'object' && a) {
      for (const k of ['r', 'c', 'i']) if (typeof a[k] === 'number') this.tax[k] = clamp(a[k], TAX_MIN, TAX_MAX);
    } else if (typeof a === 'string' && typeof b === 'number') {
      if (a in this.tax) this.tax[a] = clamp(b, TAX_MIN, TAX_MAX);
    }
    return { ...this.tax };
  }

  /**
   * Assessed capital value of the stock, by zone class.
   * Only occupied/used floor is fully assessed — an empty tower is worth less
   * to the treasury than a full one, which is what makes vacancy hurt.
   */
  assess(pop, fields) {
    let r = 0, c = 0, i = 0;
    for (let s = 0; s < pop.nb; s++) {
      const lv = fields.landValue[pop.bCell[s]];
      const value = pop.bArea[s] * VALUE_PER_M2 * (0.28 + 1.35 * lv);
      const cls = pop.bClass[s];
      if (cls === CLASS.RES) {
        const use = pop.bCap[s] > 0 ? pop.bOcc[s] / pop.bCap[s] : 0;
        r += value * (0.42 + 0.58 * use);
      } else if (cls === CLASS.IND) {
        const use = pop.bJobs[s] > 0 ? pop.bFill[s] / pop.bJobs[s] : 0;
        i += value * (0.40 + 0.60 * use);
      } else if (cls === CLASS.CIVIC) {
        /* civic floor is exempt */
      } else {
        const use = pop.bJobs[s] > 0 ? pop.bFill[s] / pop.bJobs[s] : 0;
        c += value * (0.38 + 0.62 * use);
      }
    }
    return { residential: r, commercial: c, industrial: i, total: r + c + i };
  }

  /** Run one monthly settlement. Returns the ledger. */
  settle(pop, fields, world) {
    const led = this._emptyLedger();
    led.month = ++this.month;

    const assessed = this.assess(pop, fields);
    led.assessed = {
      residential: Math.round(assessed.residential),
      commercial: Math.round(assessed.commercial),
      industrial: Math.round(assessed.industrial),
      total: Math.round(assessed.total),
    };

    // property tax is an annual rate on the *rateable* (rental) value of the
    // stock, charged 1/12 monthly — not on the capital sum
    const m = RATEABLE_YIELD / 12;
    led.income.residential = assessed.residential * this.tax.r * m;
    led.income.commercial = assessed.commercial * this.tax.c * m;
    led.income.industrial = assessed.industrial * this.tax.i * m;
    led.income.total = led.income.residential + led.income.commercial + led.income.industrial;

    led.expense.roads = (fields.laneKm || 0) * UPKEEP_PER_LANE_KM;
    led.expense.buildings = pop.nb * UPKEEP_PER_BUILDING;
    let svc = 0;
    for (const inst of fields.installations) if (inst.on) svc += inst.upkeep;
    led.expense.services = svc;
    led.expense.percapita = pop.count * SERVICE_PER_CAPITA;
    led.expense.interest = this.budget < 0 ? -this.budget * DEBT_INTEREST_MONTH : 0;
    led.expense.total = led.expense.roads + led.expense.buildings + led.expense.services
      + led.expense.percapita + led.expense.interest;

    led.net = led.income.total - led.expense.total;
    this.budget += led.net;

    // bankruptcy is a state with hysteresis, never an exception
    if (this.budget < BANKRUPT_LIMIT) {
      this.bankruptMonths++;
      if (this.bankruptMonths >= 2) this.bankrupt = true;
    } else if (this.budget > BANKRUPT_LIMIT * 0.4) {
      this.bankruptMonths = 0;
      this.bankrupt = false;
    }
    led.bankrupt = this.bankrupt;
    led.budget = this.budget;

    for (const k of Object.keys(led.income)) led.income[k] = Math.round(led.income[k]);
    for (const k of Object.keys(led.expense)) led.expense[k] = Math.round(led.expense[k]);
    led.net = Math.round(led.net);
    led.budget = Math.round(led.budget);

    this.last = led;
    this.ledgers.unshift(led);
    if (this.ledgers.length > 36) this.ledgers.pop();
    if (world) world.stats.budget = Math.round(this.budget);
    return led;
  }

  /**
   * When the city is bankrupt, services it cannot pay for go dark: the cheapest
   * installations stay on, the rest are shed until upkeep fits the income.
   * Returns how many were switched off (or back on).
   */
  enforceBankruptcy(fields) {
    const insts = fields.installations;
    if (!insts.length) return 0;
    let changed = 0;
    if (!this.bankrupt) {
      for (const i of insts) if (!i.on) { i.on = true; changed++; }
      return changed;
    }
    // keep the cheapest half running; a dark city is still a running city
    const order = insts.map((i, k) => [i.upkeep, k]).sort((a, b) => a[0] - b[0]);
    const keep = Math.max(1, Math.floor(order.length * 0.5));
    for (let k = 0; k < order.length; k++) {
      const inst = insts[order[k][1]];
      const on = k < keep;
      if (inst.on !== on) { inst.on = on; changed++; }
    }
    return changed;
  }
}

export default Economy;
