/**
 * Overlay control + legend.
 *
 * The overlays themselves belong to other modules — `zoning.setOverlay(bool)`
 * and `simulation.setOverlay(kind)`. This file only decides which one is on and
 * says what its colours mean. They default OFF and are never switched on except
 * by a click (or by the `overlays` showcase variant).
 *
 * The legend ramps mirror `simulation/Overlay.js`' own GLSL ramps, converted
 * from the shader's scene-linear stops through the sRGB transfer, so the swatch
 * and the ground agree.
 */
import { h, setAttr, clear } from './dom.js';
import { icon } from './icons.js';
import { pct } from './format.js';
import { SERVICE_LABEL } from './alerts.js';
import { ZONE_COLOR } from './tokens.js';

/**
 * The two ramps `simulation/Overlay.js` actually draws, converted from its
 * scene-linear GLSL stops through the sRGB transfer, and placed at the centres
 * of that shader's smoothstep bands — so the swatch and the ground agree.
 */
const RAMP_VALUE = ['#495369 0%', '#6e778d 11%', '#a494a2 31%', '#d4a690 54%', '#f2cb84 75%', '#feefbe 100%'];
/** rampDiverge() — service coverage: hot = underserved, so it reads deficit-first. */
const RAMP_COVER = ['#f47674 0%', '#f5b06e 14%', '#e9d694 38%', '#b3b5c0 63%', '#939aad 100%'];

const ZONE_LEGEND = [
  ['Residential · low', ZONE_COLOR[1]], ['Residential · high', ZONE_COLOR[2]],
  ['Commercial · low', ZONE_COLOR[3]], ['Commercial · high', ZONE_COLOR[4]],
  ['Office', ZONE_COLOR[6]], ['Industrial', ZONE_COLOR[5]],
  ['Park & green', ZONE_COLOR[7]], ['Civic', ZONE_COLOR[8]],
];

export const OVERLAYS = [
  { id: 'zoning', label: 'Zoning', glyph: 'ovZone', title: 'Land use (zoning)' },
  { id: 'landValue', label: 'Land value', glyph: 'ovValue', title: 'Land value' },
  { id: 'coverage', label: 'Services', glyph: 'ovCoverage', title: 'Service coverage' },
  { id: 'pollution', label: 'Pollution', glyph: 'ovPollution', title: 'Ground pollution' },
];

function ramp(stops) {
  return h('div.ramp', {
    style: { background: `linear-gradient(90deg, ${stops.join(', ')})` },
  });
}

export function createOverlays(opts) {
  const { apply } = opts;   // apply(id|null) → the id that actually took effect
  let active = null;

  const bar = h('div.ovbar', { role: 'group', 'aria-label': 'Map overlays' },
    h('span.lb', { text: 'Overlays' }));
  const btns = new Map();
  for (const o of OVERLAYS) {
    const b = h('button.ov', {
      type: 'button', title: o.title, 'aria-label': o.title, 'aria-pressed': 'false',
      onclick: () => toggle(o.id),
    }, icon(o.glyph, 16));
    btns.set(o.id, b);
    bar.appendChild(b);
  }

  const legendBody = h('div.panel-bd');
  const legendTitle = h('h2', { text: '' });
  const legend = h('section.panel.legend.ix', { style: { display: 'none' } },
    h('div.panel-hd', null, legendTitle,
      h('button.iconbtn', { type: 'button', title: 'Hide overlay', onclick: () => toggle(active) },
        icon('close', 13))),
    legendBody);

  const el = h('div.rail', null, bar, legend);

  function toggle(id) {
    const next = active === id ? null : id;
    const got = apply ? apply(next) : next;
    active = got === undefined ? next : got;
    for (const [k, b] of btns) setAttr(b, 'aria-pressed', k === active ? 'true' : 'false');
    legend.style.display = active ? 'block' : 'none';
    if (active) drawLegend(active, null);
    return active;
  }

  let sig = '';
  function drawLegend(id, S) {
    const o = OVERLAYS.find((x) => x.id === id);
    legendTitle.textContent = o ? o.label : '';
    const key = `${id}|${S ? Math.round((S.landValue || 0) * 100) : 0}|${S ? Math.round((S.pollution || 0) * 100) : 0}|${S ? Object.values(S.services || {}).map((v) => Math.round(v * 20)).join(',') : ''}`;
    if (key === sig) return;
    sig = key;
    clear(legendBody);

    if (id === 'zoning') {
      const rows = h('div.rows');
      for (const [label, colr] of ZONE_LEGEND) {
        rows.appendChild(h('div.row', null,
          h('span.sw', { style: { background: colr, width: '10px', height: '10px' } }),
          h('span', { text: label })));
      }
      legendBody.appendChild(rows);
      return;
    }

    if (id === 'coverage') {
      legendBody.appendChild(ramp(RAMP_COVER));
      legendBody.appendChild(h('div.ends', null,
        h('span', { text: '0% · underserved' }), h('span', { text: 'covered · 100%' })));
      const rows = h('div.rows');
      const cov = (S && S.services) || {};
      for (const k of ['power', 'water', 'waste', 'education', 'health', 'police', 'fire']) {
        const v = cov[k];
        rows.appendChild(h('div.row', null,
          h('span', { text: SERVICE_LABEL[k] }),
          h('span.v.num', { text: Number.isFinite(v) ? pct(v) : '—' })));
      }
      legendBody.appendChild(rows);
      return;
    }

    legendBody.appendChild(ramp(RAMP_VALUE));
    if (id === 'landValue') {
      legendBody.appendChild(h('div.ends', null,
        h('span', { text: 'low' }), h('span', { text: 'high' })));
      legendBody.appendChild(h('div.rows', null, h('div.row', null,
        h('span', { text: 'City mean' }),
        h('span.v.num', { text: S && Number.isFinite(S.landValue) ? pct(S.landValue) : '—' }))));
    } else {
      legendBody.appendChild(h('div.ends', null,
        h('span', { text: 'clean' }), h('span', { text: 'polluted' })));
      legendBody.appendChild(h('div.rows', null, h('div.row', null,
        h('span', { text: 'City mean' }),
        h('span.v.num', { text: S && Number.isFinite(S.pollution) ? pct(S.pollution) : '—' }))));
    }
  }

  function update(S) {
    if (active) drawLegend(active, S);
  }

  return { el, update, toggle, get active() { return active; } };
}

export default createOverlays;
