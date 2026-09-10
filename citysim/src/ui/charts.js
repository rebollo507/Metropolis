/**
 * Charts.
 *
 * Built once, then only path `d` strings and label text are rewritten — the node
 * count of a chart never changes after construction, so a refresh is a handful
 * of attribute writes and no layout.
 *
 * Following the dataviz method: form first (change-over-time → line), colour by
 * job (categorical slots in fixed order, never cycled), 2 px lines, ≥8 px end
 * markers with a 2 px surface ring, hairline solid gridlines, a legend whenever
 * there are ≥2 series (carrying each series' current value, so identity is never
 * colour-alone), selective labels only, one axis, and a crosshair + readout on
 * hover.
 */
import { h, s, setText, setAttr, setStyle } from './dom.js';
import { TOKENS } from './tokens.js';

const PAD_L = 27;         // room for y ticks
const PAD_R = 5;
const PAD_T = 7;
const PAD_B_AXIS = 14;    // with a time axis under the plot
const PAD_B_BARE = 3;     // without — the panel header already says the window

const GRID = 'rgba(255,255,255,0.075)';
const BASE = 'rgba(255,255,255,0.15)';

/** Round a domain out to clean numbers so the ticks read as numbers, not noise. */
function niceDomain(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi - lo < 1e-9) { hi = lo + Math.max(1, Math.abs(lo) * 0.1); }
  const span = hi - lo;
  const step = Math.pow(10, Math.floor(Math.log10(span / 2)));
  const mult = span / 2 / step;
  const nice = step * (mult > 5 ? 10 : mult > 2 ? 5 : mult > 1 ? 2 : 1);
  const l = Math.floor(lo / nice) * nice;
  const u = Math.ceil(hi / nice) * nice;
  return [l, u === l ? l + nice : u];
}

/**
 * createChart({ title, unit, series, height, fmt, domain, xlabels, area })
 *   series: [{ key, label, color, fmt? }]  — fixed order, never re-assigned
 */
export function createChart(cfg) {
  const W = cfg.width || 322;
  const axis = cfg.xAxis !== false;
  const PAD_B = axis ? PAD_B_AXIS : PAD_B_BARE;
  const H = (cfg.height || 74) - (axis ? 0 : PAD_B_AXIS - PAD_B_BARE);
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const fmt = cfg.fmt || ((v) => (Number.isFinite(v) ? String(Math.round(v)) : '—'));
  const single = cfg.series.length === 1;

  // A multi-series chart's legend already carries every current value; repeating
  // the first one in the header is the same number twice.
  const now = h('span.now.num', { text: single ? '—' : '' });
  const unit = h('span.u', { text: cfg.unit || '' });
  const head = h('div.chart-hd', null, h('span.t', { text: cfg.title }), unit, now);

  const svg = s('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    role: 'img', 'aria-label': cfg.title,
  });

  /* --- chrome: two hairline gridlines + a baseline --------------------- */
  const gTop = s('line', { x1: PAD_L, x2: W - PAD_R, y1: PAD_T, y2: PAD_T, stroke: GRID, 'stroke-width': 1 });
  const gMid = s('line', {
    x1: PAD_L, x2: W - PAD_R, y1: PAD_T + plotH / 2, y2: PAD_T + plotH / 2,
    stroke: GRID, 'stroke-width': 1,
  });
  const base = s('line', {
    x1: PAD_L, x2: W - PAD_R, y1: PAD_T + plotH, y2: PAD_T + plotH,
    stroke: BASE, 'stroke-width': 1,
  });
  const tHi = s('text', { class: 'axis', x: PAD_L - 6, y: PAD_T + 3.5, 'text-anchor': 'end' });
  const tLo = s('text', { class: 'axis', x: PAD_L - 6, y: PAD_T + plotH + 3.5, 'text-anchor': 'end' });
  const xL = s('text', { class: 'axis', x: PAD_L, y: H - 3, 'text-anchor': 'start' });
  const xR = s('text', { class: 'axis', x: W - PAD_R, y: H - 3, 'text-anchor': 'end' });
  svg.append(gTop, gMid, base, tHi, tLo);
  if (axis) svg.append(xL, xR);

  /* --- marks ------------------------------------------------------------ */
  const marks = cfg.series.map((sr, i) => {
    const fill = single || cfg.area
      ? s('path', { fill: sr.color, 'fill-opacity': 0.10, stroke: 'none', d: '' })
      : null;
    const line = s('path', {
      fill: 'none', stroke: sr.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', d: '',
    });
    // ≥8 px end marker with a 2 px ring in the surface colour
    const dot = s('circle', {
      r: 4, cx: -20, cy: -20, fill: sr.color,
      stroke: TOKENS.surface, 'stroke-width': 2,
    });
    if (fill) svg.appendChild(fill);
    svg.appendChild(line);
    svg.appendChild(dot);
    return { sr, i, fill, line, dot, values: null };
  });

  /* --- hover crosshair --------------------------------------------------- */
  const cross = s('line', {
    y1: PAD_T, y2: PAD_T + plotH, stroke: 'rgba(255,255,255,0.32)',
    'stroke-width': 1, visibility: 'hidden',
  });
  svg.appendChild(cross);
  const hoverDots = cfg.series.map((sr) => {
    const c = s('circle', {
      r: 3.5, fill: sr.color, stroke: TOKENS.surface, 'stroke-width': 2, visibility: 'hidden',
    });
    svg.appendChild(c);
    return c;
  });
  const tip = h('div', {
    style: {
      position: 'absolute', pointerEvents: 'none', visibility: 'hidden',
      background: 'rgba(8,12,18,0.94)', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: '5px', padding: '5px 7px', fontSize: '11px', whiteSpace: 'nowrap',
      transform: 'translate(-50%, -100%)', zIndex: '2', boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
    },
  });

  /* --- legend (≥2 series) ------------------------------------------------ */
  let keys = null;
  const keyVals = [];
  if (!single) {
    keys = h('div.keys');
    for (const sr of cfg.series) {
      const v = h('span.kval.num', { text: '—' });
      keyVals.push(v);
      keys.appendChild(h('div.key', null,
        h('span.kd', { style: { background: sr.color } }),
        h('span', { text: sr.label }), v));
    }
  }

  const el = h('div.chart', { style: { position: 'relative' } }, head, svg, keys, tip);

  let dom = [0, 1];
  let count = 0;
  let sig = '';

  function update(data, xlabels) {
    // one cheap signature so an unchanged history costs nothing
    let sg = '';
    for (const m of cfg.series) {
      const a = data && data[m.key];
      sg += a ? `${a.length}:${a[a.length - 1]}|` : '-|';
    }
    if (sg === sig) return;
    sig = sg;

    let lo = Infinity, hi = -Infinity, n = 0;
    for (const m of marks) {
      const a = data ? data[m.sr.key] : null;
      m.values = a && a.length > 1 ? a : null;
      if (!m.values) continue;
      n = Math.max(n, m.values.length);
      for (const v of m.values) { if (!Number.isFinite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    count = n;

    if (!n || lo === Infinity) {
      for (const m of marks) { setAttr(m.line, 'd', ''); if (m.fill) setAttr(m.fill, 'd', ''); setAttr(m.dot, 'cx', -20); }
      if (single) setText(now, '—');
      setText(tHi, ''); setText(tLo, '');
      setText(xL, ''); setText(xR, 'no data yet');
      return;
    }

    if (cfg.domain) dom = cfg.domain.slice();
    else { dom = niceDomain(Math.min(lo, cfg.zero ? 0 : lo), hi); }
    const [d0, d1] = dom;
    const yOf = (v) => PAD_T + plotH - ((v - d0) / (d1 - d0 || 1)) * plotH;
    const xOf = (i) => PAD_L + (n <= 1 ? plotW : (i / (n - 1)) * plotW);

    for (const m of marks) {
      if (!m.values) { setAttr(m.line, 'd', ''); if (m.fill) setAttr(m.fill, 'd', ''); setAttr(m.dot, 'cx', -20); continue; }
      const a = m.values;
      let d = '';
      for (let i = 0; i < a.length; i++) {
        const v = Number.isFinite(a[i]) ? a[i] : d0;
        d += (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(v).toFixed(1);
      }
      setAttr(m.line, 'd', d);
      if (m.fill) {
        setAttr(m.fill, 'd',
          `${d}L${xOf(a.length - 1).toFixed(1)} ${(PAD_T + plotH).toFixed(1)}L${xOf(0).toFixed(1)} ${(PAD_T + plotH).toFixed(1)}Z`);
      }
      const last = a[a.length - 1];
      setAttr(m.dot, 'cx', xOf(a.length - 1).toFixed(1));
      setAttr(m.dot, 'cy', yOf(Number.isFinite(last) ? last : d0).toFixed(1));
    }

    // An all-zero series is "nothing recorded", not a measured zero — say so
    // rather than letting a flat line at the baseline pass for a measurement.
    const empty = hi === 0 && lo === 0;
    const lead = marks[0].values;
    if (single) setText(now, (lead && !empty) ? (cfg.series[0].fmt || fmt)(lead[lead.length - 1]) : '—');
    setText(tHi, fmt(d1));
    setText(tLo, fmt(d0));
    setText(xL, (xlabels && xlabels[0]) || '');
    setText(xR, empty ? 'not recorded yet' : ((xlabels && xlabels[1]) || 'now'));
    if (!axis) setText(unit, empty ? 'not recorded yet' : (cfg.unit || ''));
    if (keys) {
      for (let i = 0; i < marks.length; i++) {
        const a = marks[i].values;
        setText(keyVals[i], a ? (cfg.series[i].fmt || fmt)(a[a.length - 1]) : '—');
      }
    }
  }

  /* hit target is the whole plot; only active while the pointer is inside */
  svg.style.pointerEvents = 'auto';
  svg.addEventListener('pointermove', (ev) => {
    if (!count) return;
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / (r.width || 1)) * W;
    const f = (px - PAD_L) / (W - PAD_L - PAD_R);
    const i = Math.max(0, Math.min(count - 1, Math.round(f * (count - 1))));
    const x = PAD_L + (count <= 1 ? plotW : (i / (count - 1)) * plotW);
    setAttr(cross, 'x1', x.toFixed(1)); setAttr(cross, 'x2', x.toFixed(1));
    setAttr(cross, 'visibility', 'visible');
    let html = '';
    const [d0, d1] = dom;
    for (let k = 0; k < marks.length; k++) {
      const a = marks[k].values;
      if (!a) { setAttr(hoverDots[k], 'visibility', 'hidden'); continue; }
      const v = a[Math.min(i, a.length - 1)];
      const y = PAD_T + plotH - ((v - d0) / (d1 - d0 || 1)) * plotH;
      setAttr(hoverDots[k], 'cx', x.toFixed(1));
      setAttr(hoverDots[k], 'cy', y.toFixed(1));
      setAttr(hoverDots[k], 'visibility', 'visible');
      html += `${cfg.series[k].label} ${(cfg.series[k].fmt || fmt)(v)}` + (k < marks.length - 1 ? ' · ' : '');
    }
    tip.textContent = html;
    setStyle(tip, 'visibility', 'visible');
    setStyle(tip, 'left', `${(x / W) * 100}%`);
    setStyle(tip, 'top', `${PAD_T + 22}px`);
  });
  svg.addEventListener('pointerleave', () => {
    setAttr(cross, 'visibility', 'hidden');
    for (const c of hoverDots) setAttr(c, 'visibility', 'hidden');
    setStyle(tip, 'visibility', 'hidden');
  });

  return { el, update };
}

export default createChart;
