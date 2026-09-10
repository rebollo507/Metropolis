/**
 * Statistics panel — six charts drawn from `simulation.history()`, plus three
 * meter tiles for the values that are read as a level rather than a curve.
 *
 * The history is a rolling series at one sample per in-game hour, so the
 * horizontal axis is real time in the city, not frames. The panel re-reads it
 * at 0.5 Hz and each chart no-ops when its own last sample has not moved.
 */
import { h, setText, setStyle } from './dom.js';
import { icon } from './icons.js';
import { createChart } from './charts.js';
import { TOKENS, RCI } from './tokens.js';
import { compact, money, pct, n1 } from './format.js';
import { readHistory } from './data.js';

const CW = 189;    // chart width inside the two-column grid
const CH = 58;

const S1 = TOKENS.series[0];   // blue
const S2 = TOKENS.series[1];   // orange
const S3 = TOKENS.series[2];   // aqua-green

export function createStats(opts) {
  const { onClose } = opts;

  const charts = [
    createChart({
      title: 'Population', width: CW, height: CH, fmt: compact, zero: true, xAxis: false,
      series: [{ key: 'population', label: 'Population', color: S1 }],
    }),
    // employed vs jobs is the same unit — people-shaped work — so it is one axis
    createChart({
      title: 'Employment', width: CW, height: CH, fmt: compact, zero: true, xAxis: false,
      series: [
        { key: 'employed', label: 'In work', color: S1 },
        { key: 'jobs', label: 'Jobs', color: S2 },
      ],
    }),
    createChart({
      title: 'Budget', unit: 'monthly', width: CW, height: CH, fmt: money, zero: true, xAxis: false,
      series: [
        { key: 'income', label: 'Income', color: S1 },
        { key: 'expense', label: 'Expense', color: S2 },
      ],
    }),
    createChart({
      title: 'Demand', width: CW, height: CH, fmt: (v) => pct(v), domain: [0, 1], xAxis: false,
      series: [
        { key: 'demandR', label: 'R', color: RCI.r.color },
        { key: 'demandC', label: 'C', color: RCI.c.color },
        { key: 'demandI', label: 'I', color: RCI.i.color },
      ],
    }),
    createChart({
      title: 'Traffic', unit: 'index', width: CW, height: CH, fmt: (v) => pct(v), domain: [0, 1],
      series: [{ key: 'traffic', label: 'Congestion', color: S1 }],
    }),
    createChart({
      title: 'Approval', width: CW, height: CH, fmt: (v) => pct(v), domain: [0, 1],
      series: [{ key: 'happiness', label: 'Approval', color: S3 }],
    }),
  ];

  /* --- live meter tiles: levels now, not curves over time ---------------- */
  const tiles = [
    { key: 'traffic', label: 'Traffic', glyph: 'ovTraffic' },
    { key: 'housing', label: 'Housing', glyph: 'building' },
    { key: 'commute', label: 'Commute', glyph: 'clock' },
    { key: 'coverage', label: 'Services', glyph: 'ovCoverage' },
  ].map((t) => {
    const v = h('span.num', { text: '—', style: { fontSize: '13px' } });
    const bar = h('i', { style: { display: 'block', height: '100%', width: '0%', background: 'var(--accent)', borderRadius: '2px' } });
    const el = h('div', { style: { minWidth: '0' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px', color: 'var(--ink-3)' } },
        icon(t.glyph, 11), h('span', { text: t.label, style: { fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase' } })),
      h('div', { style: { marginTop: '2px' } }, v),
      h('div.meter', { style: { marginTop: '5px' } }, bar));
    return { ...t, el, v, bar };
  });

  const tileRow = h('div', {
    style: {
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px',
      padding: '10px 0 11px', borderBottom: '1px solid var(--line)',
    },
  }, ...tiles.map((t) => t.el));

  const grid = h('div', {
    style: { display: 'grid', gridTemplateColumns: `${CW}px ${CW}px`, columnGap: '14px' },
  }, ...charts.map((c) => c.el));

  const dayLabel = h('span.hint.num', { text: '' });
  const el = h('section.stats.panel', { 'aria-label': 'City statistics' },
    h('div.panel-hd', null,
      h('span', { style: { color: 'var(--ink-2)', display: 'flex' } }, icon('chart', 13)),
      h('h2', { text: 'Statistics' }),
      dayLabel,
      h('button.iconbtn', { type: 'button', title: 'Close statistics (Tab)', onclick: () => onClose && onClose() },
        icon('close', 13))),
    h('div.panel-bd', null, tileRow, grid));

  const noData = h('p.hint', {
    text: 'No history yet — the simulation publishes one sample per in-game hour.',
    style: { padding: '10px 0 2px' },
  });

  let hadData = false;

  function update(ctx, S) {
    const hist = readHistory(ctx);
    if (!hist) {
      hadData = false;
      setStyle(grid, 'display', 'none');
      if (!noData.parentNode) el.querySelector('.panel-bd').appendChild(noData);
    } else {
      if (noData.parentNode) noData.parentNode.removeChild(noData);
      setStyle(grid, 'display', 'grid');
      hadData = true;
      const n = hist.population.length;
      const take = Math.min(n, 96);
      const cut = (a) => (a && a.length > take ? a.slice(a.length - take) : a);
      const data = {};
      for (const k of ['population', 'jobs', 'employed', 'income', 'expense',
        'demandR', 'demandC', 'demandI', 'traffic', 'happiness']) data[k] = cut(hist[k]);
      const labels = [`−${take} h`, 'now'];
      for (const c of charts) c.update(data, labels);
      setText(dayLabel, `last ${take} h`);
    }

    /* tiles — live levels straight off world.stats, not the rolling history */
    setTile(tiles[0], S.traffic, Number.isFinite(S.traffic) ? pct(S.traffic) : '—',
      S.traffic > 0.7 ? 'var(--critical)' : S.traffic > 0.5 ? 'var(--warning)' : 'var(--accent)');
    const housing = Number.isFinite(S.housingVacancy) ? 1 - S.housingVacancy : NaN;
    setTile(tiles[1], housing, Number.isFinite(housing) ? pct(housing) : '—',
      housing > 0.97 ? 'var(--warning)' : 'var(--accent)');
    const cm = S.commute;
    setTile(tiles[2], Number.isFinite(cm) ? Math.min(1, cm / 45) : NaN,
      Number.isFinite(cm) ? `${n1(cm)} min` : '—',
      cm > 32 ? 'var(--warning)' : 'var(--accent)');
    setTile(tiles[3], S.coverage, Number.isFinite(S.coverage) ? pct(S.coverage) : '—',
      S.coverage < 0.5 ? 'var(--warning)' : 'var(--accent)');
  }

  function setTile(t, frac, text, colr) {
    setText(t.v, text);
    setStyle(t.bar, 'width', `${(Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0)) * 100).toFixed(1)}%`);
    setStyle(t.bar, 'background', colr);
  }

  return { el, update };
}

export default createStats;
