/**
 * Tunables and enums for the simulation module.
 *
 * Everything here is a plain number so the whole model can be reasoned about,
 * unit-tested in node, and diffed. No three.js, no DOM.
 */

/* Building use classes. Mirrors buildings/BuildingMaterials OCC (RES/OFFICE/
   RETAIL/IND) and adds CIVIC, which buildings tags by `kind` rather than occ. */
export const CLASS = { RES: 0, OFFICE: 1, RETAIL: 2, IND: 3, CIVIC: 4 };
export const CLASS_NAME = ['res', 'office', 'retail', 'ind', 'civic'];
export const NCLASS = 5;

/* Citizen life state. */
export const STATE = { CHILD: 0, STUDENT: 1, EMPLOYED: 2, UNEMPLOYED: 3, RETIRED: 4 };
export const STATE_NAME = ['child', 'student', 'employed', 'unemployed', 'retired'];
export const NSTATE = 5;

/* Highest education reached. */
export const EDU = { NONE: 0, SCHOOL: 1, HIGH: 2, COLLEGE: 3 };
export const EDU_NAME = ['none', 'school', 'highschool', 'college'];

/* Age cohorts, upper bound exclusive. */
export const COHORTS = [
  ['child', 0, 15], ['teen', 15, 20], ['young', 20, 35],
  ['adult', 35, 55], ['mature', 55, 65], ['senior', 65, 200],
];

/* Coverage / service fields. Order is the wire order of the coverage arrays. */
export const SERVICES = ['power', 'water', 'waste', 'education', 'health', 'police', 'fire'];
export const SERVICE_INDEX = Object.fromEntries(SERVICES.map((s, i) => [s, i]));

/**
 * One service installation archetype. `radius` is the effective service radius
 * in metres, `capacity` how many residents it can serve at full quality,
 * `upkeep` the monthly cost, `build` the one-off capital cost.
 * These are the line items the budget is actually made of.
 */
export const SERVICE_SPEC = {
  power:     { radius: 900, capacity: 26000, upkeep: 5200, build: 62000, pollution: 0.55 },
  water:     { radius: 820, capacity: 30000, upkeep: 3100, build: 41000, pollution: 0.10 },
  waste:     { radius: 760, capacity: 22000, upkeep: 4300, build: 38000, pollution: 0.42 },
  education: { radius: 520, capacity: 9000,  upkeep: 6100, build: 54000, pollution: 0.00 },
  health:    { radius: 620, capacity: 14000, upkeep: 7400, build: 71000, pollution: 0.00 },
  police:    { radius: 560, capacity: 16000, upkeep: 4600, build: 33000, pollution: 0.00 },
  fire:      { radius: 640, capacity: 18000, upkeep: 4900, build: 36000, pollution: 0.00 },
};

/* Floor area accounting. Gross footprint × levels × EFFICIENCY = usable area. */
export const EFFICIENCY = 0.82;
/** m² of usable residential floor per resident, by density band. */
export const AREA_PER_RESIDENT = { low: 52, mid: 40, high: 33 };
/** m² of usable floor per job. */
export const AREA_PER_JOB = { office: 21, retail: 34, ind: 62, civic: 38 };

/* Labour force. */
export const WORK_AGE_MIN = 18;
export const WORK_AGE_MAX = 66;
export const SCHOOL_AGE_MIN = 5;

/* Demography rates, per citizen per day. Small numbers on purpose: the city
   grows mostly by migration, which is what a builder actually feels. */
export const BIRTH_RATE_DAY = 0.00016;      // per eligible household
export const DEATH_BASE_DAY = 0.0000090;    // baseline hazard
export const DEATH_AGE_K = 0.000000098;     // × (age-45)^2 above 45

/* Migration. Fractions of current population per day, before demand scaling. */
export const IMMIGRATION_MAX_DAY = 0.045;
export const EMIGRATION_MAX_DAY = 0.030;
export const SEED_FILL = 0.72;              // initial occupancy of housing stock

/* Taxes — fraction of assessed annual value, charged monthly at 1/12. */
export const TAX_DEFAULT = { r: 0.11, c: 0.11, i: 0.10 };
export const TAX_MIN = 0.0, TAX_MAX = 0.29;
export const TAX_NEUTRAL = 0.11;            // demand is unaffected at this rate

/* Money. All figures are monthly unless stated. */
export const VALUE_PER_M2 = 1650;           // assessed capital value at landValue 1.0
/** Annual rateable value as a fraction of capital value (a rental yield).
 *  Tax is charged on this, not on the capital sum — which is why an 11 % rate
 *  raises roughly 0.6 % of the city's capital value a year, not 11 % of it. */
export const RATEABLE_YIELD = 0.055;
export const UPKEEP_PER_LANE_KM = 2400;     // road maintenance, monthly
export const UPKEEP_PER_BUILDING = 55;      // refuse/inspection, monthly
export const SERVICE_PER_CAPITA = 14;       // consumables scaling with population
export const UPKEEP_SCALE = 2.2;            // multiplier on SERVICE_SPEC.upkeep
export const DEBT_INTEREST_MONTH = 0.0075;  // 9 %/yr on negative balance
export const BANKRUPT_LIMIT = -250000;      // below this for 2 settlements → bankrupt

/* Commuting. Door-to-door, so this is not the road speed limit: it folds in
   junctions, parking and the walk at both ends of the trip. 5.5 m/s ≈ 20 km/h,
   which is what an urban car trip actually averages. */
export const COMMUTE_SPEED_MPS = 5.5;
export const COMMUTE_FIXED_MIN = 6.0;       // access + egress, minutes
export const COMMUTE_DETOUR = 1.35;         // grid network vs straight line
export const COMMUTE_CONGESTION_K = 1.45;   // ×congestion added to travel time
export const COMMUTE_TOLERANCE_MIN = 16;    // above this, happiness and demand suffer

/* Labour-market friction. Without it every job fills instantly and
   unemployment sits at 0.1 %, which is not a city, it is a spreadsheet. */
export const HIRE_BASE = 0.10;              // chance per visit when jobs are scarce
export const HIRE_VACANCY_GAIN = 0.45;      // …plus this × job vacancy
export const JOB_CHURN = 0.005;             // chance per visit of leaving a job

/* Field grid. */
export const CELL_SIZE = 32;                // metres per coarse cell
export const SDF_RANGE = 96;                // metres encoded into the overlay edge fade

/* Land value weights — must stay a partition of ±1 so the field is bounded. */
export const LV = {
  base: 0.10,
  access: 0.30,
  amenity: 0.26,
  service: 0.20,
  centrality: 0.14,
  pollution: -0.34,
  congestion: -0.16,
  industry: -0.12,
};

/* Demand response gains. */
export const DEMAND = {
  smooth: 0.12,               // exponential smoothing per hourly evaluation
  jobsGain: 0.85, vacancyGain: 1.10, taxGain: 2.2,
  commuteGain: 0.9, serviceGain: 0.8, pollutionGain: 0.55,
  retailPerCapita: 1 / 26,    // retail jobs wanted per resident
  industryPerWorker: 0.30,    // industrial jobs wanted per unskilled worker
};

/* Daily rhythm. Hour-indexed activity curves, wrapped. */
export const RHYTHM = {
  // outbound commute (home → work); weekday shape
  commuteOut: [0.01, 0.01, 0.01, 0.01, 0.02, 0.08, 0.30, 0.82, 1.00, 0.62, 0.28, 0.18,
    0.16, 0.15, 0.14, 0.16, 0.22, 0.30, 0.22, 0.12, 0.07, 0.05, 0.03, 0.02],
  // inbound commute (work → home)
  commuteIn: [0.03, 0.02, 0.01, 0.01, 0.01, 0.02, 0.05, 0.10, 0.16, 0.18, 0.18, 0.20,
    0.26, 0.24, 0.24, 0.34, 0.62, 0.96, 1.00, 0.70, 0.40, 0.24, 0.14, 0.07],
  // shopping / leisure trips
  retail: [0.02, 0.01, 0.01, 0.01, 0.01, 0.02, 0.06, 0.14, 0.34, 0.58, 0.80, 0.92,
    0.96, 0.90, 0.86, 0.88, 0.92, 0.88, 0.76, 0.62, 0.44, 0.26, 0.12, 0.05],
  // freight / industrial shift changes
  freight: [0.24, 0.20, 0.18, 0.20, 0.34, 0.62, 0.86, 0.78, 0.66, 0.62, 0.60, 0.58,
    0.60, 0.66, 0.82, 0.74, 0.62, 0.56, 0.50, 0.44, 0.52, 0.60, 0.44, 0.30],
};

/* Weekend multipliers applied to the curves above. */
export const WEEKEND = { commuteOut: 0.22, commuteIn: 0.24, retail: 1.18, freight: 0.35 };

/* Traffic density mapping: density = clamp(BASE + Σ w·activity, 0, 4). */
export const TRAFFIC_MIX = { base: 0.16, commute: 1.55, retail: 0.62, freight: 0.48 };

/* History. One sample per in-game hour, 21 days deep. */
export const HISTORY_LEN = 512;

/* Work scheduling. */
export const SLICE_MIN = 64;                // citizens visited per tick, floor
export const SLICE_MAX = 3072;              // …and ceiling, so one tick can't spike
export const SLICE_TARGET_TICKS = 4800;     // aim for a full pass every N ticks (4 min)
export const FIELD_PHASES = 24;             // field refresh is spread over this many ticks

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};
/** Hour-curve lookup with linear interpolation and wraparound. */
export function curveAt(curve, hours) {
  const h = ((hours % 24) + 24) % 24;
  const i = Math.floor(h), f = h - i;
  return curve[i] * (1 - f) + curve[(i + 1) % 24] * f;
}
