/**
 * Bottom tool dock — five categories, their sub-tools, and the keyboard.
 *
 * The dock owns *selection state only*. It never edits the world: it emits
 * `tool:selected` (ARCHITECTURE §4) and the `tools` module acts on it. That
 * module does not exist yet, so the dock is written to be completely useful
 * without it — the selected state, the shortcut hints and the event are the
 * whole contract.
 */
import { h, setAttr } from './dom.js';
import { icon } from './icons.js';
import { ZONE } from '../core/World.js';
import { ZONE_SWATCH as ZONE_SW } from './tokens.js';
const ROAD_SW = { alley: '#6d7480', street: '#8b939f', avenue: '#a6aeba', boulevard: '#c2cad6', highway: '#dfe6ef' };

export const CATEGORIES = [
  {
    id: 'zone', label: 'Zone', key: 'Z', glyph: 'zone',
    tools: [
      { id: 'res_low', label: 'Residential', sw: ZONE_SW.res_low, zone: ZONE.RES_LOW },
      { id: 'res_high', label: 'Apartments', sw: ZONE_SW.res_high, zone: ZONE.RES_HIGH },
      { id: 'com_low', label: 'Commercial', sw: ZONE_SW.com_low, zone: ZONE.COM_LOW },
      { id: 'office', label: 'Office', sw: ZONE_SW.office, zone: ZONE.OFFICE },
      { id: 'industrial', label: 'Industry', sw: ZONE_SW.industrial, zone: ZONE.IND },
      { id: 'park', label: 'Park', sw: ZONE_SW.park, zone: ZONE.PARK },
      { id: 'civic', label: 'Civic', sw: ZONE_SW.civic, zone: ZONE.CIVIC },
      { id: 'dezone', label: 'Dezone', sw: 'none', zone: ZONE.NONE },
    ],
  },
  {
    id: 'road', label: 'Road', key: 'X', glyph: 'road',
    tools: [
      { id: 'alley', label: 'Alley', sw: ROAD_SW.alley, roadClass: 'alley' },
      { id: 'street', label: 'Street', sw: ROAD_SW.street, roadClass: 'lane2' },
      { id: 'avenue', label: 'Avenue', sw: ROAD_SW.avenue, roadClass: 'lane4' },
      { id: 'boulevard', label: 'Boulevard', sw: ROAD_SW.boulevard, roadClass: 'boulevard' },
      { id: 'highway', label: 'Highway', sw: ROAD_SW.highway, roadClass: 'highway' },
    ],
  },
  {
    id: 'service', label: 'Service', key: 'C', glyph: 'service',
    tools: [
      { id: 'power', label: 'Power', sw: '#c98500', service: 'power' },
      { id: 'water', label: 'Water', sw: '#3987e5', service: 'water' },
      { id: 'waste', label: 'Waste', sw: '#7d8a9c', service: 'waste' },
      { id: 'education', label: 'School', sw: '#199e70', service: 'education' },
      { id: 'health', label: 'Clinic', sw: '#d95926', service: 'health' },
      { id: 'police', label: 'Police', sw: '#5cb3f2', service: 'police' },
      { id: 'fire', label: 'Fire', sw: '#d03b3b', service: 'fire' },
    ],
  },
  {
    id: 'terrain', label: 'Terrain', key: 'V', glyph: 'terrain',
    tools: [
      { id: 'raise', label: 'Raise', sw: '#8e7a5a' },
      { id: 'lower', label: 'Lower', sw: '#5a5147' },
      { id: 'level', label: 'Level', sw: '#a8a196' },
      { id: 'water', label: 'Water', sw: '#3987e5' },
    ],
  },
  { id: 'bulldoze', label: 'Bulldoze', key: 'B', glyph: 'bulldoze', tools: [] },
];

export function createDock(opts) {
  const { onSelect } = opts;
  const state = { category: null, tool: null };

  const subrow = h('div.subrow', { style: { display: 'none' } });
  const cats = h('div.cats', { role: 'toolbar', 'aria-label': 'Build tools' });
  const el = h('nav.dock', null, subrow, cats);

  const catBtns = new Map();
  for (const c of CATEGORIES) {
    const b = h('button.cat', {
      type: 'button', title: `${c.label} (${c.key})`, 'aria-pressed': 'false',
      onclick: () => pickCategory(c.id),
    }, icon(c.glyph, 21), h('span.cl', { text: c.label }), h('span.k', { text: c.key }));
    catBtns.set(c.id, b);
    cats.appendChild(b);
  }

  const toolBtns = new Map();

  function buildSubrow(cat) {
    subrow.textContent = '';
    toolBtns.clear();
    if (!cat || !cat.tools.length) { subrow.style.display = 'none'; return; }
    subrow.style.display = 'flex';
    cat.tools.forEach((t, i) => {
      const b = h('button.tool', {
        type: 'button', 'aria-pressed': 'false', title: `${t.label} (${i + 1})`,
        onclick: () => pickTool(cat.id, t.id),
      },
      h('span.sw', {
        style: t.sw === 'none'
          ? { background: 'transparent', border: '1px dashed var(--ink-3)' }
          : { background: t.sw },
      }),
      h('span', { text: t.label }),
      h('span.kbd', { text: String(i + 1) }));
      toolBtns.set(t.id, b);
      subrow.appendChild(b);
    });
  }

  function emit() {
    const cat = CATEGORIES.find((c) => c.id === state.category) || null;
    const tool = cat ? cat.tools.find((t) => t.id === state.tool) || null : null;
    const payload = state.category === null ? { tool: null }
      : {
        tool: tool ? `${cat.id}:${tool.id}` : cat.id,
        category: cat.id,
        id: tool ? tool.id : cat.id,
        label: tool ? tool.label : cat.label,
        ...(tool ? { zone: tool.zone, roadClass: tool.roadClass, service: tool.service } : {}),
      };
    onSelect && onSelect(payload);
  }

  function paint() {
    for (const [id, b] of catBtns) setAttr(b, 'aria-pressed', id === state.category ? 'true' : 'false');
    for (const [id, b] of toolBtns) setAttr(b, 'aria-pressed', id === state.tool ? 'true' : 'false');
  }

  function pickCategory(id) {
    const cat = CATEGORIES.find((c) => c.id === id);
    if (!cat) return;
    if (state.category === id && !cat.tools.length) { clearSel(); return; }
    if (state.category !== id) {
      state.category = id;
      state.tool = cat.tools.length ? cat.tools[0].id : null;
      buildSubrow(cat);
    }
    paint(); emit();
  }

  function pickTool(catId, toolId) {
    if (state.category !== catId) pickCategory(catId);
    state.tool = toolId;
    paint(); emit();
  }

  function clearSel() {
    state.category = null; state.tool = null;
    buildSubrow(null); paint(); emit();
  }

  /** Returns true if the key was consumed. */
  function handleKey(code, key) {
    const upper = (key || '').toUpperCase();
    const cat = CATEGORIES.find((c) => c.key === upper);
    if (cat) { pickCategory(cat.id); return true; }
    if (/^Digit[1-9]$/.test(code) && state.category) {
      const c = CATEGORIES.find((x) => x.id === state.category);
      const i = parseInt(code.slice(5), 10) - 1;
      if (c && c.tools[i]) { pickTool(c.id, c.tools[i].id); return true; }
    }
    return false;
  }

  function setAvailable(hasTools) {
    for (const [, b] of catBtns) b.classList.toggle('disabled', false);
    void hasTools;
  }

  return { el, handleKey, clear: clearSel, state, setAvailable };
}

export default createDock;
