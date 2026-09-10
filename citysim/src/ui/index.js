/**
 * ui — the interface layer.
 *
 * Owns DOM only. It adds **nothing** to `ctx.group`, allocates no geometry and
 * no material, and therefore contributes exactly zero draw calls, zero
 * triangles and zero textures to the frame. Everything it creates lives under a
 * single `#ui-root` element and one `<style>` tag, both removed in dispose().
 *
 * Cost control:
 *  · `update()` is a clock, not a renderer. It never touches the DOM per frame.
 *    World state is re-read at 4 Hz, alerts derived at 1 Hz, charts rebuilt at
 *    0.5 Hz, and the pick raycast runs at most 10 Hz and only when the pointer
 *    has actually moved outside the chrome.
 *  · every write goes through setText/setAttr/setStyle, which compare first, so
 *    an unchanged value costs a string compare and no DOM mutation.
 *  · nothing reads layout (offsetWidth/getBoundingClientRect) in the update
 *    path; the one rect read is cached per resize.
 *
 * Every panel degrades: a module that is absent or FAILED produces em-dashes and
 * an explanatory line, never a fabricated number, and its failure is surfaced as
 * a badge because failure isolation is only a feature if you can see it.
 */
import { CSS } from './css.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { hashString } from '../core/Rng.js';
import { makeState, readState } from './data.js';
import { deriveAlerts } from './alerts.js';
import { createTopBar } from './topbar.js';
import { createDock } from './dock.js';
import { createOverlays } from './overlays.js';
import { createInspector } from './inspector.js';
import { createStats } from './statspanel.js';
import { createToasts } from './notify.js';
import { createPhoto } from './photo.js';
import { groundAt, subjectAt, pickLandmark } from './picking.js';
import { stageShowcase } from './showcase.js';

const CITY_NAMES = [
  'Vantage Bay', 'Northgate', 'Port Meridian', 'Ashford', 'Kestrel Bay',
  'Cinderhaven', 'Rivermouth', 'Halden', 'Solence', 'Marrowport',
  'Fairwater', 'Brackenmoor',
];

/* Refresh cadences, in *wall-clock* milliseconds.
 *
 * Deliberately not accumulated from the frame `dt`: `Engine` clamps dt to 0.1 s,
 * so on a slow renderer (SwiftShader draws this city at ~1 fps) a dt-accumulated
 * 2 s cadence would really be 20 s and the panels would sit visibly stale. Wall
 * time is what a reader perceives, so wall time is what throttles the DOM. */
const T_STATE = 250;
const T_ALERT = 1000;
const T_CHART = 2000;
const T_PICK = 100;

const S = {
  ctx: null,
  root: null,
  style: null,
  parts: null,
  state: null,
  alerts: [],
  offEvents: [],
  listeners: [],
  next: { state: 0, alert: 0, chart: 0, pick: 0 },
  panels: { inspector: false, stats: false, photo: false, hidden: false },
  pointer: { x: 0, y: 0, inside: false, moved: false, overChrome: false },
  rect: null,
  subject: null,
  pinned: null,
  tool: null,
  mounted: false,
  showcaseMode: null,
};

function api(ctx, name) { try { return ctx.get(name); } catch { return null; } }

/* ------------------------------------------------------------------ mount -- */

function cityNameFor(world) {
  const i = hashString('city:name', world.seed >>> 0) % CITY_NAMES.length;
  return CITY_NAMES[i];
}

function mount(ctx) {
  const style = document.createElement('style');
  style.id = 'ui-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = h('div#ui-root', { role: 'application', 'aria-label': 'City interface' });

  const topbar = createTopBar({
    cityName: cityNameFor(ctx.world),
    subtitle: `Region ${ctx.world.seed}`,
    onSpeed: (v) => setSpeed(ctx, v),
    onPause: () => setSpeed(ctx, ctx.world.time.paused ? (ctx.world.time.speed || 1) : 0),
    onAlertClick: () => togglePanel('stats', true),
  });

  const dock = createDock({
    onSelect: (payload) => {
      S.tool = payload.tool;
      try { ctx.events.emit('tool:selected', payload); }
      catch (err) { ctx.log.warn('tool:selected listener threw:', err.message); }
    },
  });

  const overlays = createOverlays({ apply: (id) => applyOverlay(ctx, id) });

  const failbar = h('div.failbar');
  overlays.el.insertBefore(failbar, overlays.el.firstChild);

  const inspector = createInspector({ onClose: () => togglePanel('inspector', false) });
  const stats = createStats({ onClose: () => togglePanel('stats', false) });
  const toasts = createToasts();
  const photo = createPhoto({ onShot: (nme) => applyShot(ctx, nme) });

  root.append(topbar.el, overlays.el, inspector.el, stats.el, dock.el, toasts.el, photo.el);
  document.body.appendChild(root);

  S.root = root;
  S.style = style;
  S.parts = { topbar, dock, overlays, inspector, stats, toasts, photo, failbar };
  applyPanels();
  return S.parts;
}

function applyPanels() {
  const { inspector, stats } = S.parts;
  inspector.el.style.display = S.panels.inspector ? 'block' : 'none';
  stats.el.style.display = S.panels.stats ? 'flex' : 'none';
  S.root.classList.toggle('photo', S.panels.photo);
  S.root.classList.toggle('hidden', S.panels.hidden);
}

function togglePanel(name, force) {
  S.panels[name] = force === undefined ? !S.panels[name] : !!force;
  applyPanels();
  if (name === 'photo' && S.panels.photo) S.parts.photo.sync(S.ctx);
}

/* --------------------------------------------------------------- controls -- */

function setSpeed(ctx, v) {
  const sim = api(ctx, 'simulation');
  if (sim && sim.setSpeed) { try { sim.setSpeed(v); return; } catch { /* fall through */ } }
  // No simulation to own the clock. Core exposes no speed API (see R-ui-1), so
  // the pause button would otherwise be a dead control.
  const t = ctx.world.time;
  t.paused = v === 0;
  if (v > 0) t.speed = v;
  try { ctx.events.emit('sim:speed', { speed: t.speed, paused: t.paused }); } catch { /* ignore */ }
}

function nudgeSpeed(ctx, dir) {
  const t = ctx.world.time;
  const cur = t.paused ? 0 : Math.round(t.speed || 1);
  setSpeed(ctx, Math.max(0, Math.min(3, cur + dir)));
}

/** Returns the overlay id that actually took effect (null if none did). */
function applyOverlay(ctx, id) {
  const zon = api(ctx, 'zoning');
  const sim = api(ctx, 'simulation');
  try { zon && zon.setOverlay && zon.setOverlay(false); } catch { /* ignore */ }
  try { sim && sim.setOverlay && sim.setOverlay(null); } catch { /* ignore */ }
  if (!id) return null;

  if (id === 'zoning') {
    if (!zon || !zon.setOverlay) { offline(ctx, 'zoning'); return null; }
    try { return zon.setOverlay(true) ? 'zoning' : null; } catch { return null; }
  }
  if (!sim || !sim.setOverlay) { offline(ctx, 'simulation'); return null; }
  try { return sim.setOverlay(id) ? id : null; } catch { return null; }
}

function offline(ctx, name) {
  S.parts.toasts.push({
    id: `offline:${name}`, level: 'warning', icon: 'warn',
    title: `${name} unavailable`, message: 'That overlay is drawn by a module that is not running.',
  }, performance.now());
  void ctx;
}

function applyShot(ctx, nme) {
  const demo = api(ctx, 'demo');
  if (demo && demo.shot) { try { demo.shot(nme); return; } catch { /* fall through */ } }
  try { ctx.cameraRig.apply(nme, false); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ input -- */

function bindInput(ctx) {
  const canvas = ctx.renderer.domElement;
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    S.listeners.push([target, type, fn, opts]);
  };

  const measure = () => { S.rect = canvas.getBoundingClientRect(); };
  measure();
  on(window, 'resize', measure);
  S.offEvents.push(ctx.events.on('resize', measure, 'ui'));

  on(window, 'pointermove', (e) => {
    S.pointer.x = e.clientX; S.pointer.y = e.clientY;
    S.pointer.moved = true;
    S.pointer.overChrome = !!(S.root && e.target && S.root.contains(e.target));
    S.pointer.inside = !S.pointer.overChrome;
  });
  on(canvas, 'pointerleave', () => { S.pointer.inside = false; });

  on(canvas, 'click', () => {
    if (S.panels.photo) return;
    S.pinned = S.subject && S.subject.kind !== 'ground' ? S.subject : null;
    togglePanel('inspector', !!S.pinned);
  });

  on(window, 'keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    let used = true;
    switch (e.code) {
      case 'Space': setSpeed(ctx, ctx.world.time.paused ? (ctx.world.time.speed || 1) : 0); break;
      case 'BracketRight': nudgeSpeed(ctx, +1); break;
      case 'BracketLeft': nudgeSpeed(ctx, -1); break;
      case 'Tab': togglePanel('stats'); break;
      case 'KeyI': togglePanel('inspector'); break;
      case 'KeyP': togglePanel('photo'); break;
      case 'KeyH': togglePanel('hidden'); break;
      case 'Backslash': S.parts.overlays.toggle(S.parts.overlays.active); break;
      case 'Escape':
        if (S.panels.photo) togglePanel('photo', false);
        else if (S.pinned) { S.pinned = null; togglePanel('inspector', false); }
        else S.parts.dock.clear();
        break;
      default:
        used = S.parts.dock.handleKey(e.code, e.key);
    }
    if (used) e.preventDefault();
  });
}

/* ------------------------------------------------------------------ frame -- */

function refreshState(ctx) {
  readState(ctx, S.state);
  S.parts.topbar.update(S.state, S.alerts);
  if (S.panels.inspector) S.parts.inspector.render(ctx, S.pinned || S.subject, !!S.pinned);
  S.parts.overlays.update(S.state);
  renderFailBadges();
}

function renderFailBadges() {
  const bar = S.parts.failbar;
  const sig = S.state.failed.join(',');
  if (bar.__sig === sig) return;
  bar.__sig = sig;
  bar.textContent = '';
  for (const nme of S.state.failed) {
    bar.appendChild(h('div.failbadge', {
      title: `The ${nme} module was quarantined after an error. The rest of the city keeps running.`,
    }, h('span.ic', null, icon('warn', 12)), h('span', { text: `${nme} failed` })));
  }
}

function refreshPick(ctx) {
  if (S.panels.photo || S.panels.hidden) return;
  if (!S.pointer.inside || S.pointer.overChrome) return;
  if (!S.pointer.moved) return;
  S.pointer.moved = false;
  if (!S.rect) return;
  const p = groundAt(ctx, S.pointer.x, S.pointer.y, S.rect);
  S.subject = p ? subjectAt(ctx, p) : null;
  if (!S.pinned && S.subject && S.subject.kind !== 'ground' && !S.panels.inspector) {
    togglePanel('inspector', true);
  }
  if (S.panels.inspector) S.parts.inspector.render(ctx, S.pinned || S.subject, !!S.pinned);
}

/* ------------------------------------------------------------- the module -- */

const mod = {
  name: 'ui',
  version: '1.0.0',
  dependsOn: [],
  provides: ['setPanel', 'selectTool', 'setOverlay', 'photoMode', 'notify', 'state'],

  api: {},

  async init(ctx) {
    S.ctx = ctx;
    S.state = makeState();
    if (typeof document === 'undefined') { ctx.log.warn('no document — ui idle'); return; }
    mount(ctx);
    bindInput(ctx);
    S.mounted = true;

    S.offEvents.push(ctx.events.on('module:failed', () => { S.next.state = 0; S.next.chart = 0; }, 'ui'));
    S.offEvents.push(ctx.events.on('sim:tick', () => { /* sampled by the clock below */ }, 'ui'));

    readState(ctx, S.state);
    S.alerts = deriveAlerts(S.state);
    refreshState(ctx);
    ctx.log.info('ready — HUD mounted, 0 draw calls');
  },

  update(ctx) {
    if (!S.mounted) return;
    const now = performance.now();
    const n = S.next;

    if (now >= n.pick) { n.pick = now + T_PICK; refreshPick(ctx); }

    if (now >= n.alert) {
      n.alert = now + T_ALERT;
      readState(ctx, S.state);
      S.alerts = deriveAlerts(S.state);
      S.parts.toasts.update(S.alerts, now);
    }

    if (now >= n.state) { n.state = now + T_STATE; refreshState(ctx); }

    if (now >= n.chart) {
      n.chart = now + T_CHART;
      if (S.panels.stats) S.parts.stats.update(ctx, S.state);
    }
  },

  showcase(ctx, variant = 'default') {
    S.ctx = ctx;
    S.showcaseMode = variant;
    if (!S.mounted) return null;
    return stageShowcase(ctx, S, variant, {
      togglePanel, applyOverlay, readState, deriveAlerts, refreshState, pickLandmark,
    });
  },

  dispose(ctx) {
    for (const off of S.offEvents) { try { off(); } catch { /* ignore */ } }
    S.offEvents.length = 0;
    try { ctx.events.offOwner?.('ui'); } catch { /* ignore */ }
    for (const [target, type, fn, opts] of S.listeners) {
      try { target.removeEventListener(type, fn, opts); } catch { /* ignore */ }
    }
    S.listeners.length = 0;
    try { S.root?.remove(); } catch { /* ignore */ }
    try { S.style?.remove(); } catch { /* ignore */ }
    S.root = null; S.style = null; S.parts = null; S.mounted = false;
    S.subject = null; S.pinned = null; S.tool = null;
    S.panels.inspector = false; S.panels.stats = false; S.panels.photo = false; S.panels.hidden = false;
  },

  /* ----------------------------------------------------------------- API -- */

  /** `setPanel('inspector'|'stats'|'photo'|'hidden', on?)` → the new state. */
  setPanel(name, on) {
    if (!S.mounted || !(name in S.panels)) return null;
    togglePanel(name, on);
    return S.panels[name];
  },

  /** Programmatic tool selection; emits `tool:selected` exactly as a click does. */
  selectTool(toolId) {
    if (!S.mounted) return null;
    if (!toolId) { S.parts.dock.clear(); return null; }
    const [cat, sub] = String(toolId).split(':');
    return mod.api.pick(cat, sub);
  },

  /** `setOverlay('zoning'|'landValue'|'coverage'|'pollution'|null)`. */
  setOverlay(id) {
    if (!S.mounted) return null;
    const cur = S.parts.overlays.active;
    if (cur === id) return cur;
    if (cur) S.parts.overlays.toggle(cur);
    return id ? S.parts.overlays.toggle(id) : null;
  },

  photoMode(on) { return mod.setPanel('photo', on); },

  /** Push a one-off message into the toast stack. */
  notify(title, message, level = 'warning') {
    if (!S.mounted) return false;
    S.parts.toasts.push({
      id: `notify:${title}`, level, icon: level === 'good' ? 'check' : 'info',
      title: String(title), message: String(message || ''),
    }, performance.now());
    return true;
  },

  /** The snapshot the HUD is currently drawing (for tests and the harness). */
  state() { return S.state ? JSON.parse(JSON.stringify(S.state)) : null; },
};

mod.api = {
  /** Select a dock category + sub-tool by id. */
  pick(cat, sub) {
    if (!S.mounted) return null;
    const key = { zone: 'Z', road: 'X', service: 'C', terrain: 'V', bulldoze: 'B' }[cat];
    if (!key) return null;
    S.parts.dock.handleKey(`Key${key}`, key);
    // sub-tools are addressed positionally by the same path a keypress takes
    const idx = sub && SUB_INDEX[cat] ? SUB_INDEX[cat].indexOf(sub) : -1;
    if (idx >= 0) S.parts.dock.handleKey(`Digit${idx + 1}`, String(idx + 1));
    return S.tool;
  },
  panels: () => ({ ...S.panels }),
  activeOverlay: () => (S.mounted ? S.parts.overlays.active : null),
  subject: () => S.pinned || S.subject || null,
  /** This module contributes no GPU work at all. */
  drawCalls: () => 0,
};

/** Sub-tool ids, in dock order — used by `api.pick`. */
const SUB_INDEX = {
  zone: ['res_low', 'res_high', 'com_low', 'office', 'industrial', 'park', 'civic', 'dezone'],
  road: ['alley', 'street', 'avenue', 'boulevard', 'highway'],
  service: ['power', 'water', 'waste', 'education', 'health', 'police', 'fire'],
  terrain: ['raise', 'lower', 'level', 'water'],
  bulldoze: [],
};

export default mod;
