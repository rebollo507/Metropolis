/**
 * Right-hand inspector.
 *
 * Shows whatever the cursor is over, or whatever is pinned by a click. Every
 * field is read from the world model or from a module's public API — where a
 * module is missing the row is dropped rather than filled with a plausible
 * number.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { ZONE, ROAD_CLASS } from '../core/World.js';
import { n0, n1, pct, dist, address, streetName, compact } from './format.js';
import { ZONE_COLOR } from './tokens.js';

const KIND_LABEL = {
  house: 'Detached house', rowhouse: 'Row house', midrise: 'Mid-rise block',
  tower: 'Tower', landmark: 'Landmark tower', warehouse: 'Warehouse',
  civic: 'Civic building', retail: 'Retail unit',
};
const ZONE_LABEL = {
  [ZONE.NONE]: 'Unzoned', [ZONE.RES_LOW]: 'Residential · low', [ZONE.RES_HIGH]: 'Residential · high',
  [ZONE.COM_LOW]: 'Commercial · low', [ZONE.COM_HIGH]: 'Commercial · high',
  [ZONE.IND]: 'Industrial', [ZONE.OFFICE]: 'Office', [ZONE.PARK]: 'Park',
  [ZONE.CIVIC]: 'Civic', [ZONE.ROAD]: 'Road', [ZONE.WATER]: 'Water', [ZONE.RESERVED]: 'Reserved',
};
const CLASS_LABEL = {
  alley: 'Service alley', lane2: 'Two-lane street', lane4: 'Four-lane avenue',
  boulevard: 'Boulevard', highway: 'Highway',
};

const METER_COLOR = (v) => (v > 0.8 ? 'var(--critical)' : v > 0.55 ? 'var(--warning)' : 'var(--accent)');

function row(dl, label, value) {
  if (value === null || value === undefined) return;
  dl.appendChild(h('dt', { text: label }));
  dl.appendChild(h('dd.num', { text: value }));
}

/** A zone tag whose dot carries the zone hue — never the hue alone. */
function zoneTag(zone) {
  const colr = ZONE_COLOR[zone];
  return h('span.tag', null,
    colr ? h('span.dotc', { style: { background: colr } }) : null,
    ZONE_LABEL[zone] || 'Unzoned');
}

function meter(v, colr) {
  const w = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  return h('div.meter', null, h('i', {
    style: { width: `${(w * 100).toFixed(1)}%`, background: colr || METER_COLOR(w) },
  }));
}

export function createInspector(opts) {
  const { onClose } = opts;
  const body = h('div.panel-bd');
  const title = h('h2', { text: 'Inspector' });
  const el = h('aside.inspector.panel', { 'aria-label': 'Inspector' },
    h('div.panel-hd', null,
      title,
      h('span.kbd', { text: 'I' }),
      h('button.iconbtn', { type: 'button', title: 'Close inspector (I)', onclick: () => onClose && onClose() },
        icon('close', 13))),
    body);

  let sig = '';

  function api(ctx, name) { try { return ctx.get(name); } catch { return null; } }

  function render(ctx, subject, pinned) {
    const key = subject
      ? `${subject.kind}:${subject.id ?? subject.segmentId ?? ''}:${Math.round((subject.point?.x || 0) / 4)}:${Math.round((subject.point?.z || 0) / 4)}:${pinned}`
      : 'none';
    if (key === sig) { refreshLive(ctx, subject); return; }
    sig = key;
    clear(body);
    title.textContent = pinned ? 'Selected' : 'Inspector';

    if (!subject) { renderEmpty(); return; }
    if (subject.kind === 'building') renderBuilding(ctx, subject);
    else if (subject.kind === 'road') renderRoad(ctx, subject);
    else if (subject.kind === 'lot') renderLot(ctx, subject);
    else renderGround(ctx, subject);
  }

  function renderEmpty() {
    body.appendChild(h('div.empty', null,
      h('span.ic', null, icon('cursor', 22)),
      h('p', { text: 'Move the cursor over the city to inspect a building, a street or a lot. Click to pin.' })));
  }

  /* ------------------------------------------------------------ building -- */
  let live = null;   // nodes that are cheap to refresh without a rebuild

  function renderBuilding(ctx, sub) {
    const b = ctx.world.buildings.get(sub.id) || sub.record || {};
    const fp = b.footprint || [0, 0];
    const roads = api(ctx, 'roads');
    let cls = 'lane2';
    if (roads && b.address && b.address.segmentId !== undefined) {
      const seg = ctx.world.roads.segments.get(b.address.segmentId);
      if (seg) cls = seg.class;
    }
    const addr = b.address ? address(b.address.segmentId, b.address.t, cls) : null;

    const zn = zoneOf(ctx, b);
    body.appendChild(h('div.insp-title', null,
      h('h3', { text: KIND_LABEL[b.kind] || 'Building' }),
      zoneTag(zn)));
    if (addr) body.appendChild(h('div.addr', null, icon('pin', 11), ' ', addr));

    const dl = h('dl.kv');
    row(dl, 'Height', Number.isFinite(b.height) ? `${n1(b.height)} m` : null);
    row(dl, 'Floors', Number.isFinite(b.levels) ? n0(b.levels) : null);
    row(dl, 'Footprint', fp[0] ? `${Math.round(fp[0])} × ${Math.round(fp[1])} m` : null);
    body.appendChild(dl);

    /* occupancy — only when the simulation knows this building */
    const pop = simPop(ctx);
    if (pop && pop.slotOfId && pop.slotOfId.has(b.id)) {
      const slot = pop.slotOfId.get(b.id);
      const cap = pop.bCap[slot], occ = pop.bOcc[slot];
      const jobs = pop.bJobs[slot], fill = pop.bFill[slot];
      const sect = h('div.sect');
      sect.appendChild(h('div.eyebrow', { text: cap > 0 ? 'Occupancy' : 'Employment' }));
      const dl2 = h('dl.kv');
      if (cap > 0) {
        row(dl2, 'Residents', `${n0(occ)} of ${n0(cap)}`);
        sect.appendChild(dl2);
        sect.appendChild(meter(cap ? occ / cap : 0, 'var(--accent)'));
      } else if (jobs > 0) {
        row(dl2, 'Jobs filled', `${n0(fill)} of ${n0(jobs)}`);
        sect.appendChild(dl2);
        sect.appendChild(meter(jobs ? fill / jobs : 0, 'var(--accent)'));
      } else {
        row(dl2, 'Occupants', '—');
        sect.appendChild(dl2);
      }
      body.appendChild(sect);
    }

    body.appendChild(fieldSection(ctx, b.pos ? { x: b.pos[0], z: b.pos[2] } : sub.point));
  }

  function zoneOf(ctx, b) {
    const zon = api(ctx, 'zoning');
    if (zon && zon.zoneAt && b.pos) { try { return zon.zoneAt(b.pos[0], b.pos[2]); } catch { /* ignore */ } }
    return b.zone;
  }

  /* ---------------------------------------------------------------- road -- */
  function renderRoad(ctx, sub) {
    const seg = ctx.world.roads.segments.get(sub.segmentId);
    const cls = ROAD_CLASS[sub.class] || ROAD_CLASS.lane2;
    body.appendChild(h('div.insp-title', null,
      h('h3', { text: streetName(sub.segmentId, sub.class) }),
      h('span.tag', { text: 'Road' })));
    body.appendChild(h('div.addr', { text: CLASS_LABEL[sub.class] || sub.class }));

    const dl = h('dl.kv');
    row(dl, 'Lanes', n0(cls.lanes));
    row(dl, 'Speed limit', `${n0(cls.speed)} km/h`);
    row(dl, 'Carriageway', `${n1(cls.width)} m`);
    row(dl, 'Length', seg ? dist(seg.length) : null);
    body.appendChild(dl);

    const traf = api(ctx, 'traffic');
    if (traf) {
      const sect = h('div.sect');
      sect.appendChild(h('div.eyebrow', { text: 'Traffic' }));
      let cong = NaN, veh = NaN;
      try { cong = traf.congestionAt(sub.segmentId); } catch { cong = NaN; }
      try { veh = (traf.vehiclesNear(sub.point, 60) || []).length; } catch { veh = NaN; }
      const dl2 = h('dl.kv');
      row(dl2, 'Congestion', Number.isFinite(cong) ? pct(cong) : '—');
      row(dl2, 'Vehicles within 60 m', Number.isFinite(veh) ? n0(veh) : '—');
      sect.appendChild(dl2);
      sect.appendChild(meter(cong));
      live = { cong: dl2.querySelectorAll('dd')[0], veh: dl2.querySelectorAll('dd')[1], bar: sect.querySelector('.meter i') };
      body.appendChild(sect);
    }
  }

  /* ----------------------------------------------------------------- lot -- */
  function renderLot(ctx, sub) {
    const lot = sub.lot;
    body.appendChild(h('div.insp-title', null,
      h('h3', { text: ZONE_LABEL[sub.zone] || 'Unzoned land' }),
      h('span.tag', null,
        ZONE_COLOR[sub.zone] ? h('span.dotc', { style: { background: ZONE_COLOR[sub.zone] } }) : null,
        lot ? 'Lot' : 'Parcel')));
    if (lot && lot.segId !== undefined) {
      const seg = ctx.world.roads.segments.get(lot.segId);
      body.appendChild(h('div.addr', null, icon('pin', 11), ' ',
        address(lot.segId, lot.t ?? 0.5, seg ? seg.class : 'lane2')));
    }
    const dl = h('dl.kv');
    if (lot) {
      row(dl, 'Frontage', Number.isFinite(lot.w) ? `${n1(lot.w)} m` : null);
      row(dl, 'Depth', Number.isFinite(lot.d) ? `${n1(lot.d)} m` : null);
      row(dl, 'Area', Number.isFinite(lot.area) ? `${n0(lot.area)} m²`
        : (Number.isFinite(lot.w) && Number.isFinite(lot.d) ? `${n0(lot.w * lot.d)} m²` : null));
      row(dl, 'Corner plot', lot.corner ? 'Yes' : 'No');
    } else {
      row(dl, 'Zone', ZONE_LABEL[sub.zone] || '—');
    }
    body.appendChild(dl);
    body.appendChild(fieldSection(ctx, sub.point));
  }

  /* -------------------------------------------------------------- ground -- */
  function renderGround(ctx, sub) {
    const terrain = api(ctx, 'terrain');
    body.appendChild(h('div.insp-title', null,
      h('h3', { text: 'Open ground' }), h('span.tag', { text: 'Terrain' })));
    const dl = h('dl.kv');
    row(dl, 'Elevation', Number.isFinite(sub.point.y) ? `${n1(sub.point.y)} m` : null);
    if (terrain && terrain.slopeAt) {
      let sl = NaN; try { sl = terrain.slopeAt(sub.point.x, sub.point.z); } catch { sl = NaN; }
      row(dl, 'Slope', Number.isFinite(sl) ? pct(sl, 1) : null);
    }
    if (sub.near) {
      row(dl, 'Nearest road', streetName(sub.near.segmentId, sub.near.class));
      row(dl, 'Distance', dist(sub.near.dist));
    }
    body.appendChild(dl);
    body.appendChild(fieldSection(ctx, sub.point));
  }

  /* ------- the simulation's fields at a point: value, pressure, services -- */
  function fieldSection(ctx, p) {
    const sim = api(ctx, 'simulation');
    const sect = h('div.sect');
    if (!sim || !p) {
      sect.appendChild(h('div.eyebrow', { text: 'Land' }));
      sect.appendChild(h('p.hint', { text: 'Simulation offline — no land value or coverage to report.' }));
      return sect;
    }
    let lv = NaN, gp = null, cov = NaN;
    try { lv = sim.landValueAt(p.x, p.z); } catch { lv = NaN; }
    try { gp = sim.growthPressureAt(p.x, p.z); } catch { gp = null; }
    try { cov = sim.coverageAt('education', p.x, p.z); } catch { cov = NaN; }
    sect.appendChild(h('div.eyebrow', { text: 'Land' }));
    const dl = h('dl.kv');
    row(dl, 'Land value', Number.isFinite(lv) ? pct(lv) : '—');
    sect.appendChild(dl);
    sect.appendChild(meter(Number.isFinite(lv) ? lv : 0, 'var(--accent)'));
    const dl2 = h('dl.kv');
    if (gp) {
      const nameOf = { r: 'Residential', c: 'Commercial', i: 'Industrial' };
      row(dl2, 'Growth pressure', `${nameOf[gp.best] || '—'} ${pct(gp.value)}`);
    }
    row(dl2, 'School coverage', Number.isFinite(cov) ? pct(cov) : '—');
    sect.appendChild(dl2);
    return sect;
  }

  function simPop(ctx) {
    const sim = api(ctx, 'simulation');
    try { return sim && sim.sim ? sim.sim().pop : null; } catch { return null; }
  }

  /** Cheap per-refresh updates for values that move fast (traffic). */
  function refreshLive(ctx, subject) {
    if (!live || !subject || subject.kind !== 'road') return;
    const traf = api(ctx, 'traffic');
    if (!traf) return;
    let cong = NaN, veh = NaN;
    try { cong = traf.congestionAt(subject.segmentId); } catch { /* ignore */ }
    try { veh = (traf.vehiclesNear(subject.point, 60) || []).length; } catch { /* ignore */ }
    if (live.cong) live.cong.textContent = Number.isFinite(cong) ? pct(cong) : '—';
    if (live.veh) live.veh.textContent = Number.isFinite(veh) ? n0(veh) : '—';
    if (live.bar && Number.isFinite(cong)) {
      live.bar.style.width = `${(Math.max(0, Math.min(1, cong)) * 100).toFixed(1)}%`;
      live.bar.style.background = METER_COLOR(cong);
    }
  }

  void compact;
  return { el, render };
}

export default createInspector;
