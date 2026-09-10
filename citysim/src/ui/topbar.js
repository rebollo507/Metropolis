/**
 * Top bar — identity, the three numbers a mayor watches, live demand, alerts,
 * the clock and the speed control.
 *
 * Everything is built once. A refresh writes text into existing nodes; the only
 * structural churn is the alert-chip row, which is rebuilt when the *set* of
 * alerts changes (a few times a minute at most), not when their values move.
 */
import { h, setText, setAttr, setStyle } from './dom.js';
import { icon } from './icons.js';
import { RCI } from './tokens.js';
import { compact, money, signed, clock, calendar, pct } from './format.js';

const SPEEDS = [
  { v: 1, label: '×1', title: 'Normal speed' },
  { v: 2, label: '×2', title: 'Fast — ] to speed up' },
  { v: 3, label: '×3', title: 'Fastest — [ to slow down' },
];

function stat(glyph, key) {
  const v = h('span.num', { text: '—' });
  const d = h('span.d.num', { text: '' });
  const el = h('div.stat', null,
    h('span.gl', null, icon(glyph, 15)),
    h('div.tx', null,
      h('div.v', { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } }, v, d),
      h('span.k', { text: key })));
  return { el, v, d };
}

export function createTopBar(opts) {
  const { cityName, subtitle, onSpeed, onPause, onAlertClick } = opts;

  const pop = stat('people', 'Population');
  const bud = stat('cash', 'Balance');
  const hap = stat('smile', 'Approval');

  /* --- demand meter: three bars, one per zone family ------------------- */
  const bars = {};
  const demand = h('div', {
    style: { display: 'flex', alignItems: 'flex-end', gap: '5px' },
    title: 'Residential / Commercial / Industrial demand',
  });
  for (const k of ['r', 'c', 'i']) {
    const fill = h('i', {
      style: {
        display: 'block', position: 'absolute', bottom: '0', left: '0', right: '0',
        height: '0%', background: RCI[k].color, borderRadius: '1.5px',
      },
    });
    const track = h('span', {
      style: {
        position: 'relative', display: 'block', width: '7px', height: '21px',
        background: 'rgba(0,0,0,0.34)', border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: '2px', overflow: 'hidden',
      },
    }, fill);
    bars[k] = fill;
    demand.appendChild(h('div', {
      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' },
    }, track, h('span', {
      text: k.toUpperCase(),
      style: { fontSize: '9px', letterSpacing: '0.06em', color: 'var(--ink-3)', lineHeight: '1' },
    })));
  }

  /* --- alerts ----------------------------------------------------------- */
  const chips = h('div.chips');

  /* --- clock + speed ----------------------------------------------------- */
  const tTime = h('span.t.num', { text: '--:--' });
  const tDate = h('span.d', { text: '' });

  const pauseBtn = h('button', {
    type: 'button', title: 'Pause (Space)', 'aria-label': 'Pause', 'aria-pressed': 'false',
    onclick: () => onPause && onPause(),
  }, icon('pause', 13));
  const speedBtns = SPEEDS.map((sp) => h('button', {
    type: 'button', title: sp.title, 'aria-label': sp.title, 'aria-pressed': 'false',
    onclick: () => onSpeed && onSpeed(sp.v),
  }, h('span.lbl', { text: sp.label })));

  const el = h('header.topbar', { role: 'banner' },
    h('div.tb-l', null,
      h('div.city', null,
        h('span.crest', null, icon('crest', 19)),
        h('div', null,
          h('div.nm', { text: cityName }),
          h('div.sub', { text: subtitle || '' }))),
      h('div.tb-sep'),
      pop.el, bud.el, hap.el,
      h('div.tb-sep'),
      demand),
    h('div.tb-c', null, chips),
    h('div.tb-r', null,
      h('div.clock', null, tTime, tDate),
      h('div.tb-sep'),
      h('div.speed', null, pauseBtn, ...speedBtns)));

  let chipSig = '';

  function update(S, alerts) {
    setText(pop.v, Number.isFinite(S.population) ? compact(S.population) : '—');
    setText(pop.d, Number.isFinite(S.jobs) ? `${compact(S.jobs)} jobs` : '');
    pop.d.className = 'd num flat';

    setText(bud.v, Number.isFinite(S.budget) ? money(S.budget) : '—');
    if (Number.isFinite(S.net) && (S.month > 0 || S.income > 0)) {
      setText(bud.d, `${signed(S.net)}/mo`);
      bud.d.className = `d num ${S.net > 0 ? 'up' : S.net < 0 ? 'down' : 'flat'}`;
    } else {
      setText(bud.d, '');
      bud.d.className = 'd num flat';
    }

    setText(hap.v, Number.isFinite(S.happiness) ? pct(S.happiness) : '—');
    setText(hap.d, Number.isFinite(S.unemployment) ? `${pct(S.unemployment)} unemp.` : '');
    hap.d.className = `d num ${Number.isFinite(S.unemployment) && S.unemployment > 0.12 ? 'down' : 'flat'}`;

    for (const k of ['r', 'c', 'i']) {
      const v = S.demand[k];
      setStyle(bars[k], 'height', `${Math.round(Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)) * 100)}%`);
    }

    setText(tTime, clock(S.hours));
    const cal = calendar(S.day);
    setText(tDate, S.weekend ? `${cal.short} ${cal.year} · Weekend` : `${cal.short} ${cal.year}`);

    setAttr(pauseBtn, 'aria-pressed', S.paused ? 'true' : 'false');
    for (let i = 0; i < SPEEDS.length; i++) {
      setAttr(speedBtns[i], 'aria-pressed',
        (!S.paused && Math.round(S.speed) === SPEEDS[i].v) ? 'true' : 'false');
    }

    /* chips: rebuild only when the set changes */
    alerts = alerts.filter((a) => a.chip !== false);
    const sig = alerts.map((a) => a.id + a.title).join('|');
    if (sig !== chipSig) {
      chipSig = sig;
      chips.textContent = '';
      for (const a of alerts.slice(0, 3)) {
        chips.appendChild(h('button', {
          type: 'button', class: `chip ix ${a.level}`, title: a.message,
          onclick: () => onAlertClick && onAlertClick(a),
        }, h('span.cw', null, icon(a.icon, 13)), h('span', { text: a.title })));
      }
      if (alerts.length > 3) chips.appendChild(h('span.chip', { text: `+${alerts.length - 3}` }));
    }
  }

  return { el, update };
}

export default createTopBar;
