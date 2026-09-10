/**
 * Alert derivation.
 *
 * Every alert here is a threshold on a number the simulation actually publishes.
 * Nothing is scripted, nothing fires on a timer, and when the simulation is
 * absent the list is simply empty rather than invented. The same list feeds the
 * top bar's chips and the toast stack, so the two can never disagree.
 */

export const SERVICE_LABEL = {
  power: 'Power', water: 'Water', waste: 'Waste', education: 'Schools',
  health: 'Health', police: 'Police', fire: 'Fire',
};

const RANK = { critical: 0, serious: 1, warning: 2, good: 3 };

export function deriveAlerts(S) {
  const out = [];
  const add = (id, level, icon, title, message, chip = true) =>
    out.push({ id, level, icon, title, message, chip });

  /* Failure isolation is a first-class alert — but it already has a permanent
     badge beside the overlay rail, so it does not also take a top-bar chip. */
  for (const name of S.failed) {
    add(`fail:${name}`, 'critical', 'warn', `${name} offline`,
      'Module quarantined — the rest of the city keeps running.', false);
  }

  if (S.hasSim) {
    if (S.bankrupt) {
      add('bankrupt', 'critical', 'alert', 'Treasury empty',
        'Services are being cut. Raise taxes or reduce upkeep.');
    } else if (Number.isFinite(S.budget) && S.budget < 0) {
      add('overdrawn', 'critical', 'alert', 'Budget overdrawn', 'The city is spending money it does not have.');
    } else if (Number.isFinite(S.net) && S.net < 0 && Number.isFinite(S.budget)
      && S.budget + S.net * 3 < 0) {
      add('deficit', 'warning', 'warn', 'Deficit spending',
        'At this monthly rate the treasury runs out within three months.');
    }

    /* blackout — coverage is a real field, one per service */
    const cov = S.services || {};
    for (const k of ['power', 'water']) {
      const v = cov[k];
      if (Number.isFinite(v) && v < 0.35 && S.population > 0) {
        add(`svc:${k}`, k === 'power' ? 'critical' : 'serious', 'bolt',
          k === 'power' ? 'Blackout' : 'Water shortage',
          `${SERVICE_LABEL[k]} reaches only ${Math.round(v * 100)}% of the city.`);
      }
    }

    if (Number.isFinite(S.unemployment) && S.unemployment > 0.12 && S.population > 40) {
      add('unemp', S.unemployment > 0.2 ? 'serious' : 'warning', 'people',
        `Unemployment ${Math.round(S.unemployment * 100)}%`,
        'Citizens cannot find work. Commercial and industrial zones create jobs.');
    }

    if (Number.isFinite(S.housingVacancy) && S.housingVacancy < 0.02
      && Number.isFinite(S.demand.r) && S.demand.r > 0.55) {
      add('housing', 'warning', 'building', 'Housing shortage',
        'Every home is occupied and residential demand is still rising.');
    }

    if (Number.isFinite(S.pollution) && S.pollution > 0.34) {
      add('pollution', 'serious', 'ovPollution', 'Air quality poor',
        'Industry upwind of housing is pushing pollution over the tolerable band.');
    }
  }

  if (Number.isFinite(S.traffic) && S.traffic > 0.5) {
    add('traffic', S.traffic > 0.7 ? 'serious' : 'warning', 'ovTraffic',
      `Traffic ${Math.round(S.traffic * 100)}%`,
      'Junctions on the main arterials are backing up at this hour.');
  }

  out.sort((a, b) => RANK[a.level] - RANK[b.level]);

  if (!out.length && S.hasSim && S.population > 0) {
    add('stable', 'good', 'check', 'City stable', 'No outstanding problems.');
  }
  return out;
}

export default deriveAlerts;
