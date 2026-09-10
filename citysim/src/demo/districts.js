import { ZONE } from '../core/World.js';

/**
 * District tuning.
 *
 * `zoning.autoZone()` already produces a defensible plan from the network and
 * the terrain — a core, a mixed ring, a residential body, a green river edge
 * and an industrial estate by the highway. This pass only asserts the handful
 * of things the *demo* wants to be true in every seed, through zoning's public
 * paint API:
 *
 *   · the industrial estate really is downwind and by the ramp,
 *   · downtown has a civic square and the core is not diluted,
 *   · there is a real park in the housing, not just leftover slivers.
 */
export function tuneZoning(ctx, plan, site, autoResult) {
  const z = ctx.get('zoning');
  if (!z || typeof z.paintCircle !== 'function') return null;
  const out = { painted: 0 };

  const core = (z.core && z.core()) || null;
  const c = core ? [core.x, core.z] : plan.core;

  const dab = (x, zz, r, zone) => {
    if (!Number.isFinite(x) || !Number.isFinite(zz)) return;
    try { out.painted += z.paintCircle(x, zz, r, zone) || 0; } catch { /* optional */ }
  };

  /* 1 — a compact tower core with a real edge.
   *
   * The auto-zoner's rank quantiles put roughly a third of the city in the
   * core + downtown ring, which spreads towers over half the map and destroys
   * the height gradient. Reassert the silhouette explicitly: offices tight on
   * the core, commercial on the two flanking arterials, and dense housing —
   * not offices — for the ring beyond, so height falls off with distance. */
  {
    const u = plan.u, v = plan.v;
    dab(c[0], c[1], 245, ZONE.RES_HIGH);        // wipe the over-wide office ring
    dab(c[0] + u[0] * 128, c[1] + u[1] * 128, 88, ZONE.COM_HIGH);
    dab(c[0] - u[0] * 136, c[1] - u[1] * 136, 88, ZONE.COM_HIGH);
    dab(c[0] + v[0] * 158, c[1] + v[1] * 158, 78, ZONE.COM_LOW);
    dab(c[0], c[1], 116, ZONE.OFFICE);
    dab(c[0] - u[0] * 64 - v[0] * 76, c[1] - u[1] * 64 - v[1] * 76, 42, ZONE.CIVIC);
  }

  /* 2 — the industrial estate, downwind of downtown and next to the highway */
  if (plan.industry) {
    const ind = plan.industry;
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      dab(ind.x + Math.cos(a) * ind.r * 0.46, ind.z + Math.sin(a) * ind.r * 0.46, ind.r * 0.52, ZONE.IND);
    }
    dab(ind.x, ind.z, ind.r * 0.55, ZONE.IND);
  }

  /* 3 — one generous park in the housing, one on the water */
  {
    const v = plan.v, u = plan.u;
    const p1 = [c[0] + v[0] * 330 - u[0] * 190, c[1] + v[1] * 330 - u[1] * 190];
    if (site.buildable(p1[0], p1[1], 0.34)) dab(p1[0], p1[1], 86, ZONE.PARK);
    const ns = site.nearestShore(c[0] + u[0] * 260, c[1] + u[1] * 260);
    if (ns) {
      const p2 = [ns.x + v[0] * 62, ns.z + v[1] * 62];
      dab(p2[0], p2[1], 74, ZONE.PARK);
    }
  }

  void autoResult;
  return out;
}

export default tuneZoning;
