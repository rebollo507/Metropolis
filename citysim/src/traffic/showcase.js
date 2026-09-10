/**
 * Showcase staging.
 *
 * `traffic` has nothing to show without a street, so each variant lays a real
 * network through the roads module's public API, then asks zoning / buildings /
 * props to dress it and reveals their groups through the `reveal:` field of the
 * showcase return value (CORE_REQUESTS pass 2). No module's `Object3D` is
 * touched by name.
 *
 * Every variant pre-rolls the simulation for a real number of seconds before the
 * harness takes its frames — a still of traffic one tick after spawn shows a
 * grid of evenly spaced cars, which is exactly what traffic does not look like.
 * Pre-rolling lets platoons form behind signals and queues build at stop lines.
 *
 * Signals are frozen for the stills so the aspect props has already baked into
 * its lens colours agrees with the phase the sim is enforcing (R-traffic-2).
 */

const VARIANTS = {
  default: {
    grid: { cols: 7, rows: 7, blockW: 92, blockH: 76, highway: false, ramp: false, organic: true, alleys: true },
    dress: true, density: 1.5, peds: 1.1, preroll: 46,
    reveal: ['roads', 'props', 'buildings'],
    // straight down the north-south boulevard at the central junction. Standing
    // over the carriageway rather than beside it is what keeps `props`' street
    // trees out of the lens.
    framing: { target: [0, 2.0, -4], dist: 71, az: 0.10, pol: 1.383, fov: 46 },
  },
  night: {
    grid: { cols: 7, rows: 7, blockW: 92, blockH: 76, highway: false, ramp: false, organic: true, alleys: true },
    dress: true, density: 2.0, peds: 0.7, preroll: 40,
    reveal: ['roads', 'props', 'buildings'],
    framing: { target: [0, 2.2, -16], dist: 74, az: 0.035, pol: 1.412, fov: 46 },
  },
  flow: {
    // an ODD column/row count is required for `generateGrid` to lay arterials at
    // all: it ranks the middle index as boulevard and index±2 as lane4, and with
    // an even count neither test can ever be true, so the whole city is lane2
    grid: { cols: 9, rows: 9, blockW: 96, blockH: 84, highway: false, ramp: false, organic: false, alleys: false },
    dress: 'light', density: 1.6, peds: 0.4, preroll: 70, freezeR: 0,
    reveal: ['roads', 'buildings'],
    // steep and off the CBD: from a shallow angle the towers hide the very
    // junctions this variant exists to show
    framing: { target: [130, 0, 70], dist: 330, az: 0.72, pol: 0.46, fov: 40 },
  },
  peds: {
    grid: { cols: 7, rows: 7, blockW: 86, blockH: 72, highway: false, ramp: false, organic: true, alleys: true },
    dress: true, density: 1.1, peds: 3.0, preroll: 34,
    reveal: ['roads', 'props', 'buildings'],
    // framing is resolved from the built network — see pickCrossing()
    findCrossing: true, focusR: 60, focusBoost: 34,
    framing: { target: [0, 1.5, 0], dist: 24, az: 0.36, pol: 1.44, fov: 42 },
  },
  // diagnostic: one of every body type plus a rank of pedestrians, parked on a
  // boulevard so the models can be judged rather than guessed at
  lineup: {
    grid: { cols: 3, rows: 3, blockW: 200, blockH: 200, highway: false, ramp: false, organic: false, alleys: false },
    dress: false, density: 0, peds: 0, preroll: 0, lineup: true,
    reveal: ['roads'],
    framing: { target: [0, 1.4, 0], dist: 26, az: 1.10, pol: 1.30, fov: 40 },
  },
};

export default function stageShowcase(ctx, S, variant, helpers) {
  const V = VARIANTS[variant] || VARIANTS.default;
  const { buildNetwork, retarget, reconcile, preroll, setPedFocus } = helpers;
  S.showcaseMode = variant;

  /* 1 · a street to drive on ------------------------------------------- */
  const roads = ctx.get('roads');
  if (roads && roads.generateGrid) {
    try { roads.generateGrid(V.grid); }
    catch (err) { ctx.log.warn('roads.generateGrid failed:', err.message); }
  }
  if (!ctx.world.roads.segments.size) {
    ctx.log.warn('no road network available — traffic has nothing to drive on');
    return { reveal: V.reveal, ...V.framing };
  }

  /* 2 · dress it, so the street reads as a street ----------------------- */
  if (V.dress) {
    const zoning = ctx.get('zoning');
    const buildings = ctx.get('buildings');
    const props = ctx.get('props');
    try { zoning?.autoZone?.(); } catch (err) { ctx.log.warn('zoning:', err.message); }
    try { buildings?.generateForNetwork?.({}); } catch (err) { ctx.log.warn('buildings:', err.message); }
    if (V.dress !== 'light') {
      try { props?.populate?.({ density: 1 }); } catch (err) { ctx.log.warn('props:', err.message); }
    }
  }

  /* 3 · lanes, vehicles, crowd ------------------------------------------ */
  if (!buildNetwork(ctx)) {
    ctx.log.warn('lane network empty');
    return { reveal: V.reveal, ...V.framing };
  }
  if (V.lineup) return stageLineup(ctx, S, V);

  // resolve the framing first: the crowd budget is concentrated where the
  // camera is looking, the way a game spawns agents around the player
  const framing = V.findCrossing ? (pickCrossing(S) || V.framing) : V.framing;
  if (V.focus !== false && framing.target) {
    setPedFocus(ctx, framing.target[0], framing.target[2], V.focusR ?? 85, V.focusBoost ?? 16);
  }

  S.density = V.density;
  retarget(ctx);
  S.targetP = Math.min(S.crowd.cap, Math.round(S.targetP * V.peds));
  for (let k = 0; k < 90; k++) if (reconcile()) break;

  /* 4 · pre-roll with the phase CYCLING, so the queues and platoons that
   *     exist at capture time are the ones a running cycle produces. Freezing
   *     first would jam every minor approach solid. --------------------- */
  S.sim.freezeSignals = false;
  preroll(ctx, Math.round(V.preroll / (ctx.FIXED_DT || 0.05)));

  /* 5 · Round 1 pinned the phase at the junction in shot so the still agreed
   *     with the static aspect props had baked into its lenses. `SignalSync`
   *     now drives those lenses from the live phase instead, so the cycle can
   *     run everywhere and the whole network agrees rather than one junction. */
  S.sim.freezeSignals = false;

  ctx.log.info('showcase', variant, {
    vehicles: S.sim.count, peds: S.crowd.count,
    lanes: S.netStats?.lanes, junctions: S.netStats?.junctions,
    signalled: S.netStats?.signalled,
  });

  return { reveal: V.reveal, ...framing };
}

/**
 * Find a signalised junction on a modest street and frame its near crossing from
 * over the carriageway. Hard-coding a coordinate is fragile: `generateGrid` skips
 * nodes on unbuildable ground, and an even column count puts no junction at the
 * origin at all — which is how the first attempt ended up inside a building.
 */
function pickCrossing(S) {
  const net = S.net;
  if (!net || !net.nodes.length) return null;
  let best = null, bestScore = -Infinity;
  for (const nd of net.nodes) {
    if (!nd.signalled || nd.degree < 3) continue;
    // prefer the narrowest arm at the junction: an intimate street beats a
    // 24 m boulevard for judging a crossing
    let narrow = 9, approach = -1;
    for (const l of nd.approaches) {
      if (net.rank[l] <= narrow) { narrow = net.rank[l]; approach = l; }
    }
    if (approach < 0) continue;
    const d = Math.hypot(nd.x, nd.z);
    const score = -narrow * 220 - d;
    if (score > bestScore) { bestScore = score; best = { nd, approach }; }
  }
  if (!best) return null;

  // outward direction along the chosen arm = the reverse of its travel heading
  const { nd, approach } = best;
  const n = net.ptCount[approach], o = net.ptOff[approach];
  const ex = net.pts[(o + n - 1) * 3], ez = net.pts[(o + n - 1) * 3 + 2];
  const ax = net.pts[(o + n - 2) * 3], az2 = net.pts[(o + n - 2) * 3 + 2];
  let ux = ex - ax, uz = ez - az2;
  const ul = Math.hypot(ux, uz) || 1;
  ux = -ux / ul; uz = -uz / ul;                    // outward from the junction

  const cross = { x: nd.x + ux * 11.5, y: nd.y, z: nd.z + uz * 11.5 };
  const eye = { x: nd.x + ux * 30, y: nd.y + 5.2, z: nd.z + uz * 30 };
  const dx = eye.x - cross.x, dy = eye.y - (cross.y + 1.5), dz = eye.z - cross.z;
  const dist = Math.hypot(dx, dy, dz);
  return {
    target: [cross.x, cross.y + 1.5, cross.z],
    dist,
    az: Math.atan2(dx, dz),
    pol: Math.acos(Math.max(-1, Math.min(1, dy / dist))),
    fov: 42,
  };
}

/** One of each body type, spaced along the longest lane, plus a rank of walkers. */
function stageLineup(ctx, S, V) {
  const sim = S.sim, net = S.net;
  let best = -1, bestLen = 0, bestScore = -Infinity;
  for (const id of net.roadLanes) {
    const o = (net.ptOff[id] + Math.floor(net.ptCount[id] / 2)) * 3;
    const d = Math.hypot(net.pts[o], net.pts[o + 2]);
    const score = net.len[id] - d * 2;
    if (score > bestScore) { bestScore = score; best = id; bestLen = net.len[id]; }
  }
  if (best < 0) return { reveal: V.reveal, ...V.framing };

  const n = 6;
  let s = Math.max(6, bestLen * 0.5 - 30);
  for (let t = 0; t < n; t++) {
    const i = sim.spawn({ type: t });
    if (i < 0) continue;
    sim.lane[i] = best;
    sim.s[i] = Math.min(bestLen - 2, s);
    sim.v[i] = 0;
    sim.acc[i] = 0;
    sim.routeLen[i] = 1;
    sim.routeIdx[i] = 0;
    sim.route[i * sim.maxRoute] = best;
    sim.needRoute[i] = 0;
    sim._writeTransform(i, true);
    s += 7.6;
  }
  S.crowd.spawn(26);
  for (let k = 0; k < 200; k++) S.crowd.step(0.05, () => true);
  S.crowd.prev.set(S.crowd.cur);
  sim._bucket();

  // frame the middle of the rank
  const p = net.sample(best, Math.max(6, bestLen * 0.5 - 30) + 12, { x: 0, y: 0, z: 0, hx: 1, hz: 0 });
  return {
    reveal: V.reveal,
    target: [p.x, 1.4, p.z],
    dist: 34, az: Math.atan2(p.hx, p.hz) + 1.24, pol: 1.395, fov: 46,
  };
}
