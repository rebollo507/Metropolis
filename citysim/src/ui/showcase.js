/**
 * Showcase staging.
 *
 * `ui` has no scene of its own, so its showcase is the opposite of every other
 * module's: instead of hiding the world it composes it. It asks `demo` to build
 * the city (the host has hidden every other group, so the return value reveals
 * them again) and then puts the HUD into the state each variant is about.
 *
 * If `demo` is absent or FAILED nothing here throws — the HUD is staged over
 * whatever the app does have, with the placeholders that implies.
 */

const REVEAL = [
  'environment', 'terrain', 'roads', 'zoning', 'buildings',
  'props', 'traffic', 'simulation', 'effects', 'tools', 'demo',
];

function api(ctx, name) { try { return ctx.get(name); } catch { return null; } }

/**
 * Give the statistics panel something true to draw.
 *
 * `demo.build()` calls `simulation.advanceDays(3)`, but `CitySim.advanceHours`
 * steps the sim object directly and the module's own `tick()` is what services
 * the `S.dirty` rebuild — so at that point the population is still zero and the
 * whole rolling history is pushed as zeros. Rebuilding first through the public
 * `rebuildNow()` and then advancing again produces real curves. This runs only
 * in a showcase; the live app is not touched.
 */
function warmSimulation(ctx) {
  const sim = api(ctx, 'simulation');
  if (!sim) return;
  try { sim.rebuildNow && sim.rebuildNow('ui-showcase'); }
  catch (err) { ctx.log.warn('simulation rebuild failed:', err.message); }
  // `economy.last` only exists after a settlement, and a month is longer than a
  // showcase — so settle once for a real ledger, run two days of hours through
  // the history, and settle again so the top bar's monthly delta is real too.
  try { sim.settle && sim.settle(); } catch (err) { ctx.log.warn('settle failed:', err.message); }
  try { sim.advanceDays && sim.advanceDays(2); }
  catch (err) { ctx.log.warn('simulation advance failed:', err.message); }
  try { sim.settle && sim.settle(); } catch { /* already reported */ }
}

/** Compose the city and return `demo`'s framing for a named shot. */
function stageCity(ctx, shot) {
  const demo = api(ctx, 'demo');
  if (!demo) { warmSimulation(ctx); return null; }
  try {
    const st = demo.stats ? demo.stats() : null;
    if (!st || !st.built) demo.build({});
  } catch (err) { ctx.log.warn('demo.build failed, staging over the bare app:', err.message); }
  warmSimulation(ctx);
  try {
    const f = demo.shot ? demo.shot(shot) : null;
    if (f && Array.isArray(f.target)) {
      return { target: f.target, dist: f.dist, az: f.az, pol: f.pol, fov: f.fov };
    }
  } catch (err) { ctx.log.warn('demo.shot failed:', err.message); }
  return null;
}

export function stageShowcase(ctx, S, variant, ops) {
  const { togglePanel, readState, deriveAlerts, refreshState, pickLandmark } = ops;

  /* every variant starts from the same clean HUD state */
  togglePanel('photo', false);
  togglePanel('hidden', false);
  togglePanel('inspector', false);
  togglePanel('stats', false);
  S.pinned = null; S.subject = null;
  S.parts.toasts.clearAll();
  if (S.parts.overlays.active) S.parts.overlays.toggle(S.parts.overlays.active);

  let framing = null;

  if (variant === 'panels') {
    framing = stageCity(ctx, 'aerial');
    togglePanel('inspector', true);
    togglePanel('stats', true);
    const core = demoCore(ctx);
    S.pinned = pickLandmark(ctx, core);
    S.parts.dock.handleKey('KeyC', 'C');            // Service category, first tool
  } else if (variant === 'overlays') {
    // Land value rather than zoning: `zoning`'s overlay only covers the 37 blocks
    // it has planned, and from an aerial framing the buildings standing on them
    // hide most of it — the simulation's field covers the whole built area, so
    // the ramp legend has something to be a legend *for*.
    framing = stageCity(ctx, 'aerial');
    const sim = api(ctx, 'simulation');
    S.parts.overlays.toggle(sim ? 'landValue' : 'zoning');
    S.parts.dock.handleKey('KeyZ', 'Z');            // Zone category — the overlay's subject
  } else if (variant === 'photo') {
    framing = stageCity(ctx, 'skyline');
    togglePanel('photo', true);
    S.parts.photo.sync(ctx);
    S.parts.photo.select('skyline');
  } else {
    framing = stageCity(ctx, 'skyline');
    S.parts.dock.handleKey('KeyZ', 'Z');
    S.parts.dock.handleKey('Digit2', '2');          // high-density residential
  }

  /* refresh everything from the city that now exists */
  readState(ctx, S.state);
  S.alerts = deriveAlerts(S.state);
  refreshState(ctx);
  if (S.panels.stats) S.parts.stats.update(ctx, S.state);
  if (S.panels.inspector) S.parts.inspector.render(ctx, S.pinned || S.subject, !!S.pinned);
  if (variant !== 'photo') S.parts.toasts.update(S.alerts, performance.now());

  const out = framing || {};
  out.reveal = REVEAL;
  return out;
}

function demoCore(ctx) {
  const demo = api(ctx, 'demo');
  try {
    const st = demo && demo.stats ? demo.stats() : null;
    if (st && st.anchors && Array.isArray(st.anchors.skyline)) {
      return [st.anchors.skyline[0], 0, st.anchors.skyline[1]];
    }
  } catch { /* ignore */ }
  return null;
}

export default stageShowcase;
