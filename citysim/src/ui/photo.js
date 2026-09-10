/**
 * Photo mode.
 *
 * Hides every piece of chrome, lays a rule-of-thirds guide over the frame, and
 * exposes the composed camera framings `demo` already knows about
 * (`demo.shot(name)`) as named presets. When `demo` is absent it falls back to
 * the CameraRig's own preset names, so the mode is useful in any showcase.
 */
import { h, setAttr } from './dom.js';

const RIG_PRESETS = ['aerial', 'city', 'skyline', 'street', 'closeup', 'topdown'];

const LABEL = {
  overview: 'Overview', skyline: 'Skyline', downtown: 'Downtown',
  residential: 'Residential', waterfront: 'Waterfront', aerial: 'Aerial',
  night: 'Night', city: 'City', street: 'Street', closeup: 'Close-up', topdown: 'Top-down',
};

export function createPhoto(opts) {
  const { onShot } = opts;
  const bar = h('div.photobar', { role: 'toolbar', 'aria-label': 'Camera presets' },
    h('span.pl', { text: 'Photo' }));
  const thirds = h('div.thirds', null,
    h('i.v', { style: { left: '33.333%' } }), h('i.v', { style: { left: '66.667%' } }),
    h('i.h', { style: { top: '33.333%' } }), h('i.h', { style: { top: '66.667%' } }));
  const el = h('div', null, thirds, bar);

  let btns = [];
  let current = null;

  function build(names) {
    for (const b of btns) b.remove();
    btns = [];
    const esc = bar.querySelector('.esc');
    if (esc) esc.remove();
    for (const nme of names) {
      const b = h('button', {
        type: 'button', 'aria-pressed': 'false', title: `Camera: ${LABEL[nme] || nme}`,
        onclick: () => select(nme),
      }, h('span', { text: LABEL[nme] || nme }));
      btns.push(b);
      bar.appendChild(b);
    }
    bar.appendChild(h('span.esc', { text: 'ESC to exit' }));
  }

  function select(nme) {
    current = nme;
    for (const b of btns) setAttr(b, 'aria-pressed', b.textContent === (LABEL[nme] || nme) ? 'true' : 'false');
    onShot && onShot(nme);
  }

  /** Refresh the preset list from whatever the app can actually offer. */
  function sync(ctx) {
    let names = null;
    try {
      const demo = ctx.get('demo');
      if (demo) {
        if (demo.stats) { const st = demo.stats(); if (st && st.shots && st.shots.length) names = st.shots; }
        if (!names && demo.shots) { const sh = demo.shots(); if (sh) names = Object.keys(sh); }
      }
    } catch { names = null; }
    if (!names || !names.length) names = RIG_PRESETS;
    const sig = names.join(',');
    if (sig === build.__sig) return;
    build.__sig = sig;
    build(names);
    if (current && names.includes(current)) select(current);
  }

  return { el, sync, select, get current() { return current; } };
}

export default createPhoto;
