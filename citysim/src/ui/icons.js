/**
 * Iconography. Every glyph is authored here on a 16×16 grid with a 1.4 px
 * stroke, round caps and round joins, drawn in `currentColor` so a glyph
 * inherits whatever ink its context sets. No emoji, no icon font, no CDN.
 *
 * Shape language: geometric, flat-topped, one visual weight; nothing is a
 * pictograph where a diagram will do (the overlay glyphs are literally small
 * diagrams of what the overlay shows).
 */
import { s } from './dom.js';

const P = (d) => ['path', d];
const C = (cx, cy, r) => ['circle', cx, cy, r];
const R = (x, y, w, h, rx) => ['rect', x, y, w, h, rx];
const F = (parts) => ({ fill: true, parts });

const I = {
  /* --- identity ------------------------------------------------------- */
  crest: [P('M2.6 13.9V6.9l3.7-2.8 3.7 2.8v7'), P('M10 13.9V9.4h3.6v4.5'),
    P('M1.4 13.9h13.2'), F([C(5.1, 8.4, 0.55), C(7.5, 8.4, 0.55), C(5.1, 10.7, 0.55),
      C(7.5, 10.7, 0.55), C(11.8, 11.3, 0.55)])],

  /* --- top-bar metrics ------------------------------------------------ */
  people: [C(6, 5.7, 2.2), P('M1.9 13.6c0-2.3 1.8-3.9 4.1-3.9s4.1 1.6 4.1 3.9'),
    C(11.4, 6.4, 1.6), P('M11.4 9.7c1.7 0 3 1.5 3 3.4')],
  cash: [R(1.7, 4.1, 12.6, 7.8, 1.3), C(8, 8, 1.9),
    F([C(4.3, 6.3, 0.5), C(11.7, 9.7, 0.5)])],
  smile: [C(8, 8, 6.1), P('M5.4 9.5c.6 1.2 1.5 1.8 2.6 1.8s2-.6 2.6-1.8'),
    F([C(6, 6.4, 0.62), C(10, 6.4, 0.62)])],
  clock: [C(8, 8, 6.1), P('M8 4.6V8l2.4 1.6')],

  /* --- time controls --------------------------------------------------- */
  play: [F([P('M5.6 3.5 12.6 8l-7 4.5z')])],
  pause: [F([R(5, 3.7, 2, 8.6, 0.8), R(9, 3.7, 2, 8.6, 0.8)])],
  ff2: [F([P('M2.9 4.1 7.4 8l-4.5 3.9z'), P('M8.4 4.1 12.9 8l-4.5 3.9z')])],
  ff3: [F([P('M1.4 4.4 5 8l-3.6 3.6z'), P('M6 4.4 9.6 8 6 11.6z'), P('M10.6 4.4 14.2 8l-3.6 3.6z')])],

  /* --- tool categories -------------------------------------------------- */
  zone: [R(2.2, 2.2, 4.7, 4.7, 0.9), R(9.1, 2.2, 4.7, 4.7, 0.9),
    R(2.2, 9.1, 4.7, 4.7, 0.9), R(9.1, 9.1, 4.7, 4.7, 0.9)],
  road: [P('M4.4 14.3 6 1.7'), P('M11.6 14.3 10 1.7'),
    P('M8 2.9v2.3'), P('M8 6.9v2.3'), P('M8 10.9v2.3')],
  service: [P('M8 1.8 13.7 4v4.3c0 3.2-2.4 5.4-5.7 6.1-3.3-.7-5.7-2.9-5.7-6.1V4z'),
    P('M8 5.7v4.6'), P('M5.7 8h4.6')],
  terrain: [P('M1.5 12.6 5.9 5.1l2.7 4.3'), P('M6.9 12.6 10.2 7l3.4 5.6'),
    P('M1.3 12.6h13.4'), F([C(11.6, 3.6, 1.5)])],
  bulldoze: [R(1.9, 6.6, 6.2, 4.2, 0.9), P('M8.1 8.7h2.6'),
    P('M11.3 3.9h2.5v8.2h-2.5z'), F([C(3.8, 12.4, 1.4), C(7, 12.4, 1.4)])],

  /* --- overlays (small diagrams of the field they show) ------------------ */
  ovZone: [R(2.2, 2.2, 11.6, 11.6, 1.2), P('M2.2 8h11.6'), P('M8 2.2v11.6'),
    F([R(2.9, 2.9, 4.4, 4.4, 0.6)])],
  ovValue: [R(2.2, 2.2, 11.6, 11.6, 1.2), P('M4.9 10.9 7.6 6.6l2.1 2.6 1.6-2.4')],
  ovDemand: [F([R(2.4, 8.6, 2.6, 5, 0.5), R(6.7, 5.6, 2.6, 8, 0.5), R(11, 3.2, 2.6, 10.4, 0.5)])],
  ovCoverage: [C(8, 8, 1.6), C(8, 8, 4), C(8, 8, 6.3)],
  ovPollution: [P('M3.1 9.4a2.6 2.6 0 0 1 .5-5 3.6 3.6 0 0 1 6.7-1 2.9 2.9 0 0 1 2.6 6z'),
    P('M3.4 12.4c1.1-.9 2.2-.9 3.3 0s2.2.9 3.3 0 2.2-.9 3.3 0')],
  ovTraffic: [P('M2.6 13.4V7.2l1.5-3.4h7.8l1.5 3.4v6.2'),
    P('M2.6 9.6h10.8'), F([C(4.7, 11.4, 0.9), C(11.3, 11.4, 0.9)])],

  /* --- status / alerts --------------------------------------------------- */
  check: [P('M3.3 8.5 6.5 11.7 12.9 4.7')],
  warn: [P('M8 2.3 14.4 13.4H1.6z'), P('M8 6.4v3.3'), F([C(8, 11.6, 0.72)])],
  alert: [C(8, 8, 6.1), P('M8 4.7V8.7'), F([C(8, 11.2, 0.72)])],
  info: [C(8, 8, 6.1), P('M8 7.5v3.7'), F([C(8, 5.1, 0.72)])],
  bolt: [P('M9.3 1.7 4.1 9.1h3.3l-.7 5.2 5.2-7.4H8.6z')],

  /* --- inspector subjects ------------------------------------------------ */
  building: [P('M3.3 14V3.4a1 1 0 0 1 1-1h5.2a1 1 0 0 1 1 1V14'),
    P('M10.5 14V6.9h2.2V14'), P('M1.6 14h12.8'),
    F([C(5.4, 5.3, 0.55), C(8.4, 5.3, 0.55), C(5.4, 8, 0.55), C(8.4, 8, 0.55),
      C(5.4, 10.7, 0.55), C(8.4, 10.7, 0.55)])],
  lot: [P('M2.4 5.2 8 2.2l5.6 3v5.6L8 13.8l-5.6-3z'), P('M8 2.2v11.6')],
  pin: [P('M8 14.3s4.7-4.3 4.7-7.6a4.7 4.7 0 1 0-9.4 0c0 3.3 4.7 7.6 4.7 7.6z'), C(8, 6.6, 1.8)],
  cursor: [P('M3.4 2.2 12.6 7l-3.9 1.4L7.2 12.4z')],

  /* --- panels ------------------------------------------------------------ */
  chart: [P('M2.4 2.2v11.4h11.2'), P('M4.6 10.8 7.3 7.4l2.3 2.1 3.4-4.6')],
  camera: [P('M2.2 5.4h2.9l1.2-1.8h3.4l1.2 1.8h2.9a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H2.2a1 1 0 0 1-1-1V6.4a1 1 0 0 1 1-1z'),
    C(8, 9.2, 2.5)],
  close: [P('M4.2 4.2 11.8 11.8'), P('M11.8 4.2 4.2 11.8')],
  layers: [P('M8 1.9 14.3 5.3 8 8.7 1.7 5.3z'), P('M2.6 8.2 8 11.1l5.4-2.9'),
    P('M2.6 11.1 8 14l5.4-2.9')],
};

/** Build an <svg> for a named glyph. Unknown names return an empty box. */
export function icon(name, size = 16, cls = null) {
  const el = s('svg', {
    width: size, height: size, viewBox: '0 0 16 16',
    fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false', class: cls,
  });
  emit(el, I[name] || [], false);
  return el;
}

function emit(root, parts, filled) {
  for (const p of parts) {
    if (!Array.isArray(p)) { if (p && p.parts) emit(root, p.parts, true); continue; }
    const attrs = filled ? { fill: 'currentColor', stroke: 'none' } : null;
    if (p[0] === 'path') root.appendChild(s('path', { d: p[1], ...attrs }));
    else if (p[0] === 'circle') root.appendChild(s('circle', { cx: p[1], cy: p[2], r: p[3], ...attrs }));
    else if (p[0] === 'rect') {
      root.appendChild(s('rect', { x: p[1], y: p[2], width: p[3], height: p[4], rx: p[5], ...attrs }));
    }
  }
}

export const ICON_NAMES = Object.keys(I);
export default icon;
