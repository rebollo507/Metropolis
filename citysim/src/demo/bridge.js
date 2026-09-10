/**
 * Where the city crosses its own river.
 *
 * `roads` shipped the deck primitive and an `autoBridge()` fallback, and filed
 * `R-roads-2` handing the *siting* decision here, for a reason it stated
 * plainly: not one of the 40 road ends had another end facing it across water,
 * because the whole city stands on one bank, so its heuristic can only pick the
 * narrowest channel anywhere on the map — which on this seed is the far west
 * frame edge, 900 m from anything anyone would photograph.
 *
 * `demo` knows where the CBD is, where the quay is and which junctions are real,
 * so it can answer the question a planner would actually ask: *which crossing
 * does this city need?* The answer is not "the narrowest" — it is the shortest
 * channel that (a) is close to the centre, (b) springs from a junction that is
 * already part of the street grid rather than a mid-block point, and (c) lands
 * on a bank solid enough to carry a road onward. A bridge that starts nowhere
 * and ends nowhere is a model of a bridge; a bridge that continues a street is
 * a piece of city.
 *
 * Ordering matters and is deliberate: this runs in `build()` *before* the
 * sibling-rebuild step that triggers `roads`' own hook. `autoBridge()` opens
 * with `for (const s of segments) if (s.elevated) return null` — so by crossing
 * first, `demo` uses `roads`' own guard to stand its fallback down. No flag, no
 * coordination, no second bridge.
 */

const SCAN = {
  x0: -260, x1: 430, z0: -230, z1: 130, step: 15,   // the bank near the CBD and the quay
  maxSpan: 300,        // metres of open water we are willing to deck
  minSpan: 40,         // below this it is a culvert, not a bridge
  hostRadius: 70,      // an abutment must attach to the grid within this
  farRoad: [70, 150],  // metres of road on the far bank, so it leads somewhere
};

/**
 * @returns {{length:number, near:number[], far:number[], span:number,
 *            fromDowntown:number, segments:number[], host:number}|null}
 */
export function placeCrossing(ctx, plan, log) {
  const roads = safe(ctx, 'roads');
  const terr = safe(ctx, 'terrain');
  if (!roads || !terr || !roads.bridgeBetween || !roads.addNode || !terr.isWater) return null;

  const net = roads.network && roads.network();
  if (!net) return null;
  for (const s of net.segments.values()) if (s.elevated) return null;   // already crossed

  const W = ctx.world?.terrain?.water ?? 0;
  const land = (x, z) => !terr.isWater(x, z) && terr.heightAt(x, z) > W + 0.9;
  const steep = (x, z) => (terr.slopeAt ? terr.slopeAt(x, z) > 0.5 : false);

  // The centre we are siting relative to: the plan's core, which is the CBD.
  const CX = plan?.core?.[0] ?? 0;
  const CZ = plan?.core?.[2] ?? plan?.core?.[1] ?? 0;

  /* Junctions of the built grid, with the direction of the street they carry.
   * degree >= 3 is a real junction; degree 2 is a point mid-street, where a
   * bridge would arrive as a T and read as an afterthought. */
  const hosts = [];
  for (const n of net.nodes.values()) {
    const deg = n.degree ?? (n.edges ? n.edges.length : 0);
    if (deg < 2) continue;
    if (!land(n.pos[0], n.pos[2])) continue;
    hosts.push({ id: n.id, x: n.pos[0], z: n.pos[2], deg });
  }
  if (!hosts.length) return null;
  const nearestHost = (x, z) => {
    let best = null, bd = 1e9;
    for (const h of hosts) {
      const d = Math.hypot(h.x - x, h.z - z);
      if (d < bd) { bd = d; best = h; }
    }
    return best ? { ...best, d: bd } : null;
  };

  /* ---- scan the near bank ------------------------------------------------ */
  const cands = [];
  for (let x = SCAN.x0; x <= SCAN.x1; x += SCAN.step) {
    for (let z = SCAN.z0; z <= SCAN.z1; z += SCAN.step) {
      if (!land(x, z)) continue;
      const host = nearestHost(x, z);
      if (!host || host.d > SCAN.hostRadius) continue;   // must join the grid

      // shortest crossing from here, over all headings that start in water
      let best = null;
      for (let a = 0; a < 360; a += 5) {
        const rad = a * Math.PI / 180, dx = Math.cos(rad), dz = Math.sin(rad);
        if (!terr.isWater(x + dx * 12, z + dz * 12)) continue;
        for (let s = SCAN.minSpan; s < SCAN.maxSpan; s += 4) {
          if (!land(x + dx * s, z + dz * s)) continue;
          let solid = true;
          for (let k = 15; k <= 105; k += 15) {
            const px = x + dx * (s + k), pz = z + dz * (s + k);
            if (!land(px, pz) || steep(px, pz)) { solid = false; break; }
          }
          if (!solid) continue;
          if (!best || s < best.span) best = { dx, dz, span: s };
          break;
        }
      }
      if (!best) continue;

      /* The planner's score, in metres so the weights are readable:
       *   deck length is what it costs to build,
       *   distance from the CBD is what makes it useful,
       *   distance from a junction is how much approach road it wastes,
       *   and a degree-2 host is penalised because a bridge should continue a
       *   street, not tee off the middle of one. */
      const fromCore = Math.hypot(x - CX, z - CZ);
      const score = -best.span * 0.55 - fromCore * 0.42 - host.d * 0.9
        - (host.deg >= 3 ? 0 : 55);
      cands.push({ x, z, ...best, host, fromCore, score });
    }
  }
  if (!cands.length) { log?.info?.('crossing: no channel near the centre'); return null; }
  cands.sort((a, b) => b.score - a.score);
  const c = cands[0];

  /* ---- build it ---------------------------------------------------------- */
  const at = (d) => [c.x + c.dx * d, 0, c.z + c.dz * d];
  let out = null;
  try {
    roads.batch(() => {
      const cls = 'lane4';
      // near abutment, set back a little from the waterline onto solid ground
      const aId = roads.addNode([c.x, 0, c.z], 'junction');
      if (aId === null || aId === undefined) return;
      roads.addSegment(c.host.id, aId, cls);              // join the grid

      const bId = roads.addNode(at(c.span + 16), 'junction');
      if (bId === null || bId === undefined) return;
      const r = roads.bridgeBetween(aId, bId);            // sets deck levels + spans
      if (!r) return;

      // enough road on the far bank that the crossing leads somewhere
      let prev = bId;
      for (const d of SCAN.farRoad) {
        const p = at(c.span + 16 + d);
        if (!land(p[0], p[2]) || steep(p[0], p[2])) break;
        const id = roads.addNode(p, 'junction');
        if (id !== null && roads.addSegment(prev, id, cls) !== null) prev = id;
      }
      out = {
        length: Math.round(r.length), span: c.span, segments: r.segments,
        near: [Math.round(c.x), Math.round(c.z)],
        far: [Math.round(c.x + c.dx * (c.span + 16)), Math.round(c.z + c.dz * (c.span + 16))],
        mid: [c.x + c.dx * (c.span + 16) * 0.5, W, c.z + c.dz * (c.span + 16) * 0.5],
        axis: [c.dx, c.dz],
        fromDowntown: Math.round(c.fromCore),
        host: c.host.id, hostDeg: c.host.deg,
      };
    });
  } catch (err) {
    log?.warn?.('crossing failed: ' + err.message);
    return null;
  }
  if (out) {
    log?.info?.(`crossing: ${out.length} m deck, ${out.span} m channel, `
      + `${out.fromDowntown} m from the CBD, off junction ${out.host} (deg ${out.hostDeg})`);
  }
  return out;
}

function safe(ctx, name) {
  try { const m = ctx.get(name); return m || null; } catch { return null; }
}
