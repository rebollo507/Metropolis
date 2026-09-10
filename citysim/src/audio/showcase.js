/**
 * audio/showcase — three ways to photograph a sound.
 *
 *   default — the composed city with a live spectrum, per-bus meters and the
 *             active source list. What is playing, and how loud.
 *   mix     — the bus architecture as a signal-flow diagram with the gains it is
 *             actually running, including the limiter's settings and the reverb
 *             cross-fade.
 *   sources — the positional field drawn in the world: every bed's position,
 *             reference distance and audible radius, so placement is judgeable
 *             from a still.
 *
 * All three default OFF: the overlay is mounted by `showcase()` (or by
 * `audio.api.setOverlay(true)`) and by nothing else, so another module's shot
 * can never pick up an audio HUD.
 */

import { overlay } from './overlay.js';
import { Markers } from './markers.js';

const REVEAL = ['environment', 'terrain', 'roads', 'zoning', 'buildings',
  'props', 'traffic', 'simulation', 'effects', 'audio'];

const S = { markers: null, ctx: null, variant: null, hidHud: false, markerKey: '', markerAt: 0 };

/**
 * The game HUD is DOM, so hiding module groups does not hide it — and two full
 * HUDs in one frame is a photograph of neither. `ui` publishes `setPanel`, so
 * the audio showcase asks it politely to stand down, and puts it back on
 * teardown. If `ui` is absent or FAILED, nothing happens and nothing breaks.
 */
function hideGameHud(ctx, on) {
  const ui = ctx.get('ui');
  if (!ui || typeof ui.setPanel !== 'function') return false;
  try { ui.setPanel('hidden', on); S.hidHud = on; return true; }
  catch { return false; }
}

function demoFraming(ctx, name) {
  const demo = ctx.get('demo');
  if (!demo) return null;
  try {
    if (typeof demo.build === 'function') demo.build();
    const shots = demo.shots ? demo.shots() : null;
    const f = shots && (shots[name] || shots.overview);
    if (!f) return null;
    return { target: f.target, dist: f.dist, az: f.az, pol: f.pol, fov: f.fov };
  } catch (err) {
    ctx.log.warn('demo city unavailable for the audio showcase:', err.message);
    return null;
  }
}

/** A framing that contains every audible positional source, with air around it. */
function frameSources(ctx, dir, base) {
  if (!dir) return null;
  const list = dir.field.state.sources.filter((s) => (s.weight || 0) > 0.02);
  if (list.length < 2) return null;
  let cx = 0, cz = 0;
  for (const s of list) { cx += s.x; cz += s.z; }
  cx /= list.length; cz /= list.length;
  // Size the shot to the *reference* rings, not the outer reach rings: the
  // question a critic asks of this frame is whether the near field is placed
  // believably, and framing the full 275 m tail of every source answers it from
  // so far away that nothing is legible.
  let r = 90;
  for (const s of list) r = Math.max(r, Math.hypot(s.x - cx, s.z - cz) + s.ref * 1.7);
  const ground = dir.field.groundAt(cx, cz);
  return {
    target: [cx, ground - 14, cz],
    dist: Math.min(470, Math.max(230, r * 2.0)),
    az: Number.isFinite(base.az) ? base.az : 0.95,
    pol: 1.02,
    fov: 44,
  };
}

export function stageShowcase(ctx, dir, variant = 'default') {
  S.ctx = ctx;
  S.variant = variant;

  // The audio module owns no city, so it borrows the composed one — the same
  // one every other module is judged over — and reveals it (R-7/R-8).
  const framingName = variant === 'sources' ? 'overview' : variant === 'mix' ? 'skyline' : 'downtown';
  const framing = demoFraming(ctx, framingName) || {};

  // The host applies the returned framing *after* this call, so a field sampled
  // now would describe wherever the camera happened to be standing. Move the rig
  // first, then sample: the mix, the source positions and the shot then agree.
  try {
    if (framing.target) ctx.cameraRig.applyFraming(framing, true);
    dir?.field.sample(dir.elapsed || 0, true);
    dir?.applyMix(true);
  } catch (err) { ctx.log.warn('framing/field sample failed:', err.message); }

  if (variant === 'sources') {
    if (!S.markers) S.markers = new Markers(ctx);
    S.markers.build(dir ? dir.field.state : { sources: [] }, dir ? dir.lastMix : null);
    // Frame the sources themselves rather than the city: the point of this shot
    // is whether their placement and radii are believable.
    const fit = frameSources(ctx, dir, framing);
    if (fit) Object.assign(framing, fit);
  } else if (S.markers) {
    S.markers.dispose();
    S.markers = null;
  }

  hideGameHud(ctx, true);
  overlay.attach(dir).mount(variant);
  overlay.setVariant(variant);
  try { overlay.refresh(); } catch { /* the first paint may precede any data */ }

  return { ...framing, reveal: REVEAL };
}

/** Called every frame while a showcase is up: cheap, and it must stay cheap. */
export function setOverlayVisible(on, dir, variant = 'default') {
  if (!on) { overlay.unmount(); S.markers?.dispose(); S.markers = null; return false; }
  if (!overlay.mounted) overlay.attach(dir).mount(variant);
  if (overlay.variant !== variant) overlay.setVariant(variant);
  if (S.markers && dir) {
    // The camera framing is applied *after* showcase() returns, so the first
    // world sample was taken from wherever the camera happened to be. Rebuild
    // the markers when the field has actually moved — at most once a second.
    const now = performance.now();
    if (now - S.markerAt > 1000) {
      S.markerAt = now;
      const key = dir.field.state.sources
        .map((x) => `${x.x | 0},${x.z | 0}:${((dir.lastMix && dir.lastMix.layers[x.name]) || 0).toFixed(2)}`)
        .join('|');
      if (key !== S.markerKey) { S.markerKey = key; S.markers.build(dir.field.state, dir.lastMix); }
    }
    S.markers.update(dir.elapsed || 0);
  }
  return true;
}

export function teardownShowcase(ctx) {
  if (S.hidHud && ctx) hideGameHud(ctx, false);
  overlay.unmount();
  S.markers?.dispose();
  S.markers = null;
  S.ctx = null;
  S.variant = null;
}

export default { stageShowcase, setOverlayVisible, teardownShowcase };
