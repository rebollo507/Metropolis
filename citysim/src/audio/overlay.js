/**
 * audio/overlay — the visualiser.
 *
 * Audio has nothing to photograph, so the showcase photographs the *signal*: a
 * real-time spectrum, per-bus meters, the active source list, the bus
 * architecture, and where the positional sources stand in the world.
 *
 * The important honesty here is where the numbers come from. When the context
 * is running, the spectrum and the meters are read from `AnalyserNode`s on the
 * live graph. When it is suspended — no user gesture, which is exactly the
 * headless harness's state — the panel renders the *same graph* through an
 * `OfflineAudioContext` and displays that, and says so in the header. Nothing on
 * this overlay is ever a decoration standing in for a measurement.
 *
 * DOM only: no geometry, no draw calls. Everything lives under `#audio-root`
 * plus one `<style>`, both removed on teardown.
 */

import { BUSES } from './Mix.js';
import * as Analysis from './Analysis.js';
import { linToDb, clamp, lerp } from './Dsp.js';

/* ------------------------------------------------------------- tokens ---- */

const T = {
  font: '"Liberation Sans", Carlito, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  ink0: '#f2f6fb', ink1: '#aebbcd', ink2: '#7d8a9c', ink3: '#5c6879',
  accent: '#5cb3f2',
  glass: 'rgba(12, 17, 24, 0.82)',
  glass2: 'rgba(14, 20, 28, 0.88)',
  line: 'rgba(255, 255, 255, 0.085)',
  lineStrong: 'rgba(255, 255, 255, 0.17)',
  wash: 'rgba(255, 255, 255, 0.05)',
  good: '#0ca30c', warn: '#fab219', crit: '#d03b3b',
};

const CSS = `
#audio-root {
  --ink0:${T.ink0}; --ink1:${T.ink1}; --ink2:${T.ink2}; --ink3:${T.ink3};
  --accent:${T.accent}; --line:${T.line}; --line-strong:${T.lineStrong};
  position: fixed; inset: 0; z-index: 45; pointer-events: none;
  font-family: ${T.font}; font-size: 12px; line-height: 1.35; color: var(--ink0);
  -webkit-font-smoothing: antialiased; user-select: none;
}
#audio-root * { box-sizing: border-box; margin: 0; }
#audio-root [hidden] { display: none !important; }
#audio-root .num { font-variant-numeric: tabular-nums; }
#audio-root .panel {
  background: ${T.glass};
  -webkit-backdrop-filter: blur(20px) saturate(1.25);
  backdrop-filter: blur(20px) saturate(1.25);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 10px 34px rgba(0,0,0,.42), 0 2px 6px rgba(0,0,0,.30), inset 0 1px 0 rgba(255,255,255,.055);
}
#audio-root .hd {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px 8px; border-bottom: 1px solid var(--line);
}
#audio-root .hd h2 {
  font-size: 11px; letter-spacing: .10em; text-transform: uppercase;
  color: var(--ink1); font-weight: 700;
}
#audio-root .hd .sub { font-size: 11px; color: var(--ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#audio-root .hd .tag { white-space: nowrap; flex: 0 0 auto; }
#audio-root .spacer { flex: 1 1 auto; }
#audio-root .tag {
  font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line-strong);
  color: var(--ink1); background: ${T.wash};
}
#audio-root .tag.live { color: #b7f0c8; border-color: rgba(12,163,12,.45); background: rgba(12,163,12,.14); }
#audio-root .tag.off  { color: #cfe3f5; border-color: rgba(92,179,242,.40); background: rgba(92,179,242,.12); }
#audio-root .tag.none { color: #f3cfcf; border-color: rgba(208,59,59,.45); background: rgba(208,59,59,.14); }

/* ------- main analyser panel ------- */
#audio-root .scope { position: absolute; left: 20px; bottom: 20px; width: 616px; }
#audio-root .scope .body { padding: 10px 12px 12px; }
#audio-root canvas.spec { display: block; width: 100%; height: 168px; border-radius: 6px; }
#audio-root .meters { margin-top: 10px; display: grid; gap: 6px; }
#audio-root .meter { display: grid; grid-template-columns: 74px 1fr 52px; align-items: center; gap: 9px; }
#audio-root .meter .nm { font-size: 11px; color: var(--ink1); }
#audio-root .meter .track {
  position: relative; height: 9px; border-radius: 3px;
  background: rgba(255,255,255,.055); overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.05);
}
#audio-root .meter .fill { position: absolute; inset: 0 auto 0 0; width: 0%; border-radius: 3px; }
#audio-root .meter .pk { position: absolute; top: -1px; bottom: -1px; width: 2px; background: rgba(255,255,255,.8); }
#audio-root .meter .db { font-size: 11px; color: var(--ink1); text-align: right; }
#audio-root .scale { display: flex; justify-content: space-between; margin-top: 7px; font-size: 10px; color: var(--ink3); }

/* ------- source list ------- */
#audio-root .srcs { position: absolute; right: 20px; bottom: 20px; width: 328px; }
#audio-root .srcs .body { padding: 4px 4px 8px; max-height: 340px; overflow: hidden; }
#audio-root .subrow { display: flex; gap: 8px; padding: 6px 12px 6px 10px; font-size: 10.5px; color: var(--ink2); border-bottom: 1px solid var(--line); margin-bottom: 4px; }
#audio-root .subrow b { color: var(--ink1); font-weight: 400; }
#audio-root .row {
  display: grid; grid-template-columns: 8px 1fr 46px 44px; align-items: center;
  gap: 8px; padding: 4px 12px 4px 10px;
}
#audio-root .row .dot { width: 7px; height: 7px; border-radius: 50%; }
#audio-root .row .nm { font-size: 11.5px; color: var(--ink0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#audio-root .row .nm small { color: var(--ink3); font-size: 10px; margin-left: 5px; }
#audio-root .row .db, #audio-root .row .ds { font-size: 11px; color: var(--ink1); text-align: right; }
#audio-root .row .ds { color: var(--ink3); }
#audio-root .row.dim .nm, #audio-root .row.dim .db { color: var(--ink3); }
#audio-root .bar { height: 2px; margin: 1px 12px 3px 10px; border-radius: 2px; background: rgba(255,255,255,.06); position: relative; }
#audio-root .bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; }
#audio-root .sep { height: 1px; background: var(--line); margin: 6px 10px; }

/* ------- status strip ------- */
#audio-root .status { position: absolute; left: 20px; top: 20px; padding: 9px 14px; display: flex; gap: 18px; align-items: center; }
#audio-root .status .k { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink3); }
#audio-root .status .v { font-size: 14px; color: var(--ink0); }
#audio-root .status .v small { font-size: 11px; color: var(--ink2); margin-left: 3px; }

/* ------- mix diagram ------- */
#audio-root .diagram { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); width: 940px; }
#audio-root .diagram .body { padding: 6px 10px 12px; }
#audio-root .diagram svg { display: block; width: 100%; height: auto; }
#audio-root .legend { display: flex; gap: 16px; padding: 8px 14px 2px; flex-wrap: wrap; }
#audio-root .legend span { font-size: 11px; color: var(--ink2); display: flex; align-items: center; gap: 6px; }
#audio-root .legend i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }

/* ------- notes ------- */
#audio-root .note {
  position: absolute; left: 20px; bottom: 20px; padding: 8px 12px; max-width: 620px;
  font-size: 11px; color: var(--ink2);
}
`;

/* ------------------------------------------------------------- helpers --- */

const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
};

const F_LO = 20, F_HI = 20000;
const dbNorm = (db, lo = -84, hi = -6) => clamp((db - lo) / (hi - lo), 0, 1);

/** Analyser bins (dBFS, linear frequency) → n log-spaced bands in dB. */
function logBands(binsDb, sr, n, out) {
  const o = out && out.length === n ? out : new Float32Array(n);
  const nb = binsDb.length;
  const df = (sr / 2) / nb;
  for (let i = 0; i < n; i++) {
    const lo = F_LO * Math.pow(F_HI / F_LO, i / n);
    const hi = F_LO * Math.pow(F_HI / F_LO, (i + 1) / n);
    let acc = 0, k = 0;
    const b0 = Math.max(1, Math.floor(lo / df)), b1 = Math.min(nb - 1, Math.ceil(hi / df));
    for (let b = b0; b <= b1; b++) { const lin = Math.pow(10, binsDb[b] / 20); acc += lin * lin; k++; }
    o[i] = k ? linToDb(Math.sqrt(acc / k)) : -120;
  }
  return o;
}

/* ------------------------------------------------------------- overlay --- */

export class Overlay {
  constructor() {
    this.root = null;
    this.style = null;
    this.variant = 'default';
    this.parts = null;
    this.spec = new Float32Array(140);
    this.specPeak = new Float32Array(140);
    this.busDb = {};
    this.busPeak = {};
    this.mode = 'idle';        // 'live' | 'offline' | 'none'
    this.offlineAt = -1e9;
    this.offlineBusy = false;
    this.offlineInfo = null;
    this.nextDraw = 0;
    this.raf = null;
    this.dir = null;
    this.mounted = false;
    this.dpr = 1;
  }

  /* ---------------------------------------------------------- mount ----- */

  mount(variant = 'default') {
    if (this.mounted) { this.setVariant(variant); return this; }
    if (typeof document === 'undefined') return this;
    this.style = el('style');
    this.style.id = 'audio-style';
    this.style.textContent = CSS;
    document.head.appendChild(this.style);

    this.root = el('div');
    this.root.id = 'audio-root';
    document.body.appendChild(this.root);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this._buildScope();
    this._buildSources();
    this._buildStatus();
    this._buildDiagram();

    this.mounted = true;
    this.setVariant(variant);
    this._loop();
    return this;
  }

  unmount() {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    this.root?.remove();
    this.style?.remove();
    this.root = this.style = null;
    this.parts = null;
    this.mounted = false;
  }

  setVariant(v) {
    this.variant = v || 'default';
    if (!this.parts) return this;
    const p = this.parts;
    // `sources` gives the frame to the world markers: the meters would only
    // cover the thing the shot exists to show.
    const showScope = this.variant === 'default';
    p.scope.hidden = !showScope;
    p.srcs.hidden = this.variant === 'mix';
    p.status.hidden = this.variant === 'mix';
    p.diagram.hidden = this.variant !== 'mix';
    if (this.variant === 'sources') {
      p.srcsTitle.textContent = 'Positional sources';
    } else {
      p.scope.style.width = '616px';
      p.srcsTitle.textContent = 'Active sources';
    }
    return this;
  }

  /* ---------------------------------------------------------- build ----- */

  _buildScope() {
    const wrap = el('div', 'panel scope');
    const hd = el('div', 'hd');
    const h = el('h2', null, 'Spectrum');
    const sub = el('div', 'sub', 'master bus · 20 Hz – 20 kHz');
    const tag = el('div', 'tag', '—');
    hd.append(h, sub, el('div', 'spacer'), tag);

    const body = el('div', 'body');
    const cv = el('canvas', 'spec');
    const scale = el('div', 'scale');
    for (const t of ['20', '100', '500', '2k', '8k', '20k']) scale.appendChild(el('span', null, t));
    const meters = el('div', 'meters');
    body.append(cv, scale, meters);
    wrap.append(hd, body);
    this.root.appendChild(wrap);

    const rows = new Map();
    for (const b of BUSES) {
      const m = el('div', 'meter');
      const nm = el('div', 'nm', b.label);
      const track = el('div', 'track');
      const fill = el('div', 'fill');
      fill.style.background = `linear-gradient(90deg, ${b.color}aa, ${b.color})`;
      const pk = el('div', 'pk');
      pk.style.left = '0%';
      track.append(fill, pk);
      const db = el('div', 'db num', '−∞');
      m.append(nm, track, db);
      meters.appendChild(m);
      rows.set(b.key, { fill, pk, db });
    }
    // master last, visually separated
    const m = el('div', 'meter');
    const nm = el('div', 'nm', 'Master');
    nm.style.color = T.ink0;
    const track = el('div', 'track');
    track.style.height = '12px';
    const fill = el('div', 'fill');
    fill.style.background = 'linear-gradient(90deg, #5cb3f2aa, #9fe0ff)';
    const pk = el('div', 'pk');
    track.append(fill, pk);
    const db = el('div', 'db num', '−∞');
    m.append(nm, track, db);
    meters.appendChild(m);
    rows.set('master', { fill, pk, db });

    this.parts = this.parts || {};
    this.parts.scope = wrap;
    this.parts.canvas = cv;
    this.parts.tag = tag;
    this.parts.scopeSub = sub;
    this.parts.rows = rows;
  }

  _buildSources() {
    const wrap = el('div', 'panel srcs');
    const hd = el('div', 'hd');
    const h = el('h2', null, 'Active sources');
    hd.append(h, el('div', 'spacer'));
    const body = el('div', 'body');
    const sub = el('div', 'subrow');
    body.appendChild(sub);
    wrap.append(hd, body);
    this.root.appendChild(wrap);
    this.parts.srcs = wrap;
    this.parts.srcsBody = body;
    this.parts.srcsTitle = h;
    this.parts.srcsSub = sub;
    this.parts.rowCache = [];
  }

  _buildStatus() {
    const wrap = el('div', 'panel status');
    const add = (k, v) => {
      const box = el('div');
      box.append(el('div', 'k', k), el('div', 'v num', v));
      wrap.appendChild(box);
      return box.lastChild;
    };
    this.parts.status = wrap;
    this.parts.stState = add('Engine', '—');
    this.parts.stRate = add('Rate', '—');
    this.parts.stVoices = add('Voices', '—');
    this.parts.stLimBox = add('Limiter', '—');
    this.parts.stLim = this.parts.stLimBox;
    this.parts.stCpu = add('Update', '—');
    this.parts.stMix = add('Listener', '—');
    this.root.appendChild(wrap);
  }

  _buildDiagram() {
    const wrap = el('div', 'panel diagram');
    const hd = el('div', 'hd');
    hd.append(el('h2', null, 'Mix architecture'), el('div', 'sub', 'source groups · buses · master chain'));
    const tag = el('div', 'tag', '');
    hd.append(el('div', 'spacer'), tag);
    const body = el('div', 'body');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 860 560');
    body.appendChild(svg);
    const legend = el('div', 'legend');
    wrap.append(hd, body, legend);
    this.root.appendChild(wrap);
    this.parts.diagram = wrap;
    this.parts.svg = svg;
    this.parts.diagramTag = tag;
    this.parts.legend = legend;
    wrap.hidden = true;
  }

  /* ----------------------------------------------------------- loop ----- */

  attach(dir) { this.dir = dir; return this; }

  _loop() {
    this.raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    if (now < this.nextDraw) return;
    const live = !!(this.dir && this.dir.running);
    this.nextDraw = now + (live ? 66 : 400);
    try { this.refresh(); } catch { /* the overlay must never break a frame */ }
  }

  refresh() {
    const dir = this.dir;
    if (!dir || !this.mounted) return;
    if (dir.running && dir.mix) {
      this.mode = 'live';
      this._pullLive(dir);
    } else if (dir.available && Analysis.canRenderOffline()) {
      this.mode = 'offline';
      this._pullOffline(dir);
    } else {
      this.mode = 'none';
    }
    this._paint(dir);
  }

  _pullLive(dir) {
    const bins = dir.mix.readSpectrum();
    if (bins) logBands(bins, dir.actx.sampleRate, this.spec.length, this.spec);
    dir.mix.readLevels();
    for (const [k, b] of dir.mix.buses) this.busDb[k] = linToDb(b.level || 0);
    this.busDb.master = linToDb(dir.mix.masterLevel || 0);
  }

  /**
   * Render the current mix offline and read the result. Runs at most every 6 s,
   * never re-entrant, and never blocks the frame — the panel shows the previous
   * render until the new one lands.
   */
  _pullOffline(dir) {
    const now = performance.now();
    if (this.offlineBusy || now - this.offlineAt < 6000) return;
    this.offlineBusy = true;
    this.offlineAt = now;
    const state = JSON.parse(JSON.stringify(dir.field.state));
    const sr = 32000, seconds = 2.2;
    Analysis.renderState(state, { seconds, sampleRate: sr, seed: dir.seed, musicGain: dir.musicGain })
      .then((r) => {
        const disp = Analysis.displaySpectrum(r.left, r.sampleRate, this.spec.length);
        this.spec.set(disp);
        const m = Analysis.metrics(r.left, r.sampleRate, 0.4);
        this.busDb.master = m.rmsDb;
        this.offlineInfo = {
          seconds, sampleRate: sr, renderMs: r.renderMs, rt: r.realtimeFactor,
          peakDb: m.peakDb, rmsDb: m.rmsDb, centroid: m.centroid, over: m.samplesOverUnity,
        };
        return this._offlineBuses(state, dir);
      })
      .catch(() => { this.mode = 'none'; })
      .then(() => { this.offlineBusy = false; });
  }

  async _offlineBuses(state, dir) {
    for (const b of BUSES) {
      const r = await Analysis.renderState(state, {
        seconds: 1.8, sampleRate: 24000, seed: dir.seed, solo: b.key, musicGain: dir.musicGain,
      });
      const m = Analysis.metrics(r.left, r.sampleRate, 0.35);
      this.busDb[b.key] = m.rmsDb;
    }
  }

  /* ---------------------------------------------------------- paint ----- */

  _paint(dir) {
    const p = this.parts;
    if (!p) return;
    const st = dir ? dir.stats() : null;

    /* header tag */
    const tag = p.tag;
    if (this.mode === 'live') { tag.className = 'tag live'; tag.textContent = 'live analyser'; }
    else if (this.mode === 'offline') { tag.className = 'tag off'; tag.textContent = 'offline render'; }
    else { tag.className = 'tag none'; tag.textContent = 'unavailable'; }

    if (this.mode === 'offline' && this.offlineInfo) {
      const o = this.offlineInfo;
      p.scopeSub.textContent = `context suspended · ${o.seconds.toFixed(1)} s rendered offline @ ${(o.sampleRate / 1000).toFixed(0)} kHz`;
    } else if (this.mode === 'live') {
      p.scopeSub.textContent = 'master bus · 20 Hz – 20 kHz';
    } else {
      p.scopeSub.textContent = 'no AudioContext in this browser';
    }

    this._paintSpectrum();
    this._paintMeters();
    this._paintStatus(st, dir);
    if (this.variant === 'mix') this._paintDiagram(dir, st);
    else this._paintSources(dir, st);
  }

  _paintSpectrum() {
    const cv = this.parts.canvas;
    const w = cv.clientWidth || 590, h = cv.clientHeight || 168;
    const dpr = this.dpr;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    // ground
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, 'rgba(10,15,22,.55)');
    bg.addColorStop(1, 'rgba(10,15,22,.80)');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    // grid — decade lines and dB rows
    g.strokeStyle = 'rgba(255,255,255,.055)';
    g.lineWidth = 1;
    g.font = '9px ' + T.font;
    g.fillStyle = 'rgba(255,255,255,.22)';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(w * Math.log(f / F_LO) / Math.log(F_HI / F_LO)) + 0.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
    for (let db = -12; db >= -84; db -= 12) {
      const y = Math.round(h - h * dbNorm(db)) + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      g.fillText(`${db}`, 3, y - 2);
    }

    const n = this.spec.length;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n * w;
      const v = dbNorm(this.spec[i]);
      pts.push([x, h - v * (h - 6) - 3]);
      // peak hold
      const cur = this.specPeak[i];
      this.specPeak[i] = this.spec[i] > cur ? this.spec[i] : lerp(cur, this.spec[i], 0.06);
    }

    // filled curve
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(120, 200, 255, 0.55)');
    grad.addColorStop(0.55, 'rgba(92, 179, 242, 0.26)');
    grad.addColorStop(1, 'rgba(92, 179, 242, 0.04)');
    g.beginPath();
    g.moveTo(0, h);
    for (const [x, y] of pts) g.lineTo(x, y);
    g.lineTo(w, h);
    g.closePath();
    g.fillStyle = grad;
    g.fill();

    g.beginPath();
    for (let i = 0; i < pts.length; i++) { const [x, y] = pts[i]; if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
    g.strokeStyle = 'rgba(190, 228, 255, 0.92)';
    g.lineWidth = 1.4;
    g.stroke();

    // peak-hold trace
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n * w;
      const y = h - dbNorm(this.specPeak[i]) * (h - 6) - 3;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokeStyle = 'rgba(255,255,255,.28)';
    g.lineWidth = 1;
    g.stroke();

    g.strokeStyle = 'rgba(255,255,255,.08)';
    g.strokeRect(0.5, 0.5, w - 1, h - 1);
  }

  _paintMeters() {
    for (const [k, row] of this.parts.rows) {
      const db = this.busDb[k];
      const has = Number.isFinite(db) && db > -119;
      const v = has ? dbNorm(db, -72, -3) : 0;
      row.fill.style.width = (v * 100).toFixed(1) + '%';
      const pk = Math.max(this.busPeak[k] ?? 0, v);
      this.busPeak[k] = lerp(pk, v, 0.04);
      row.pk.style.left = (this.busPeak[k] * 100).toFixed(1) + '%';
      row.pk.style.opacity = this.busPeak[k] > 0.01 ? '.75' : '0';
      row.db.textContent = has ? `${db.toFixed(1)}` : '−∞';
    }
  }

  _paintStatus(st, dir) {
    const p = this.parts;
    if (!st) return;
    const state = st.state || 'idle';
    const nice = { running: 'running', suspended: 'suspended', idle: 'idle', closed: 'closed', unavailable: 'unavailable' }[state] || state;
    p.stState.innerHTML = `${nice}<small>${st.muted ? ' muted' : ''}</small>`;
    p.stRate.innerHTML = st.sampleRate ? `${(st.sampleRate / 1000).toFixed(1)}<small>kHz</small>` : '—';
    p.stVoices.innerHTML = `${st.voices.active}<small>/ ${st.voices.max}</small>`;
    const gr = st.limiterDb;
    const offline = this.mode === 'offline' && this.offlineInfo;
    p.stLim.innerHTML = offline
      ? `${this.offlineInfo.peakDb.toFixed(1)}<small>dBFS</small>`
      : `${gr.toFixed(1)}<small>dB GR</small>`;
    const k = p.stLim.previousSibling;
    if (k) k.textContent = offline ? 'True peak' : 'Limiter';
    p.stCpu.innerHTML = `${st.updateMs.toFixed(2)}<small>ms</small>`;
    const m = st.mix || {};
    const agl = dir ? dir.field.state.camera.agl : 0;
    p.stMix.innerHTML = `${agl.toFixed(0)}<small>m AGL · ${(m.altitude ?? 0).toFixed(2)} aerial</small>`;
  }

  /* ------------------------------------------------------- source list -- */

  _paintSources(dir, st) {
    const body = this.parts.srcsBody;
    if (!dir || !dir.lastMix) return;
    const mix = dir.lastMix;
    const state = dir.field.state;
    const L = state.listener;

    const items = [];
    for (const [name, g] of Object.entries(mix.layers)) {
      const s = state.sources.find((x) => x.name === name);
      const positional = !!s;
      if (this.variant === 'sources' && !positional) continue;
      const dist = s ? Math.hypot(s.x - L.x, s.z - L.z) : null;
      items.push({
        name, gain: g, db: linToDb(g), dist, positional,
        bus: this._busOf(name),
        label: LABELS[name] || name,
      });
    }
    items.sort((a, b) => b.gain - a.gain);
    const live = dir.pool ? dir.pool.live() : [];
    const rows = items.slice(0, this.variant === 'sources' ? 6 : 9);

    body.textContent = '';
    body.appendChild(this.parts.srcsSub);
    for (const it of rows) {
      const r = el('div', 'row' + (it.gain < 0.02 ? ' dim' : ''));
      const dot = el('div', 'dot');
      dot.style.background = COLOR[it.bus] || T.accent;
      const nm = el('div', 'nm');
      nm.append(document.createTextNode(it.label));
      const small = el('small', null, it.positional ? 'positional' : 'bed');
      nm.appendChild(small);
      const db = el('div', 'db num', it.gain > 0.0015 ? it.db.toFixed(1) : '−∞');
      const ds = el('div', 'ds num', it.dist === null ? '—' : `${it.dist.toFixed(0)} m`);
      r.append(dot, nm, db, ds);
      body.appendChild(r);
      const bar = el('div', 'bar');
      const i = el('i');
      i.style.width = (clamp(it.gain, 0, 1) * 100).toFixed(1) + '%';
      i.style.background = (COLOR[it.bus] || T.accent) + 'cc';
      bar.appendChild(i);
      body.appendChild(bar);
    }
    if (live.length) {
      body.appendChild(el('div', 'sep'));
      for (const v of live.slice(0, 4)) {
        const r = el('div', 'row');
        const dot = el('div', 'dot');
        dot.style.background = COLOR[v.bus] || T.accent;
        const nm = el('div', 'nm');
        nm.append(document.createTextNode(v.label));
        nm.appendChild(el('small', null, 'one-shot'));
        r.append(dot, nm, el('div', 'db num', linToDb(v.gain).toFixed(1)), el('div', 'ds num', `${v.remain.toFixed(1)} s`));
        body.appendChild(r);
      }
    }
    const d = mix.derived;
    const sub = this.parts.srcsSub;
    sub.textContent = '';
    const cell = (k, v) => { const e = el('span'); e.append(document.createTextNode(k + ' '), el('b', null, v)); return e; };
    sub.append(cell('activity', `${(d.activity * 100).toFixed(0)}%`),
      cell('urban', `${(d.urban * 100).toFixed(0)}%`),
      cell('traffic', `${(d.vehicles * 100).toFixed(0)}%`));
    if (d.rain > 0.02) sub.append(cell('rain', `${(d.rain * 100).toFixed(0)}%`));
    else if (d.nightness > 0.3) sub.append(cell('night', `${(d.nightness * 100).toFixed(0)}%`));
    void st;
  }

  _busOf(name) {
    if (name.startsWith('traffic') || name.startsWith('road')) return 'traffic';
    if (name.startsWith('rain') || name === 'wind') return 'weather';
    return 'ambience';
  }

  /* ---------------------------------------------------------- diagram --- */

  _paintDiagram(dir, st) {
    const svg = this.parts.svg;
    if (!dir) return;
    const desc = dir.mix ? dir.mix.describe() : null;
    const mix = dir.lastMix;
    const NS = 'http://www.w3.org/2000/svg';
    svg.textContent = '';

    const add = (tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
      if (text !== undefined) n.textContent = text;
      svg.appendChild(n);
      return n;
    };
    const box = (x, y, w, h, fill, stroke, r = 7) =>
      add('rect', { x, y, width: w, height: h, rx: r, fill, stroke, 'stroke-width': 1 });
    const label = (x, y, t, o = {}) => add('text', {
      x, y, fill: o.fill || T.ink0, 'font-size': o.size || 12,
      'font-family': T.font, 'text-anchor': o.anchor || 'start',
      'letter-spacing': o.ls || 0, 'font-weight': o.weight || 400,
    }, t);
    const link = (x1, y1, x2, y2, color, w = 1.4, dash = null) => {
      const mx = (x1 + x2) / 2;
      const p = add('path', {
        d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
        fill: 'none', stroke: color, 'stroke-width': w,
      });
      if (dash) p.setAttribute('stroke-dasharray', dash);
      return p;
    };

    /* ---- geometry ------------------------------------------------------ */
    const groups = [
      { key: 'ambience', items: ['City roar', 'City body', 'Air / tyre hiss', 'Retail babble', 'Plant hum', 'Foliage', 'Night insects'] },
      { key: 'traffic', items: ['Tyre wash', 'Engines', 'Arterials ×2', 'Passes · horns'] },
      { key: 'weather', items: ['Rain (street)', 'Rain (aerial)', 'Wind', 'Thunder'] },
      { key: 'ui', items: ['Clicks', 'Confirm / refuse', 'Alerts'] },
      { key: 'music', items: ['Pads', 'Sub drone', 'Bells'] },
    ];
    const colX = 18, colW = 186, busX = 258, busW = 156;
    const sumX = 470, sumW = 148, dstX = 690, dstW = 150;
    const chainTop = 58, chainH = 46, chainGap = 10;
    const verbY = 400, verbX = 470, verbW = 218, verbH = 50;

    /* ---- sources → buses ------------------------------------------------ */
    let y = 26;
    const busPorts = [];
    for (const gdef of groups) {
      const b = BUSES.find((x) => x.key === gdef.key);
      const h = 22 + gdef.items.length * 15;
      box(colX, y, colW, h, 'rgba(255,255,255,.035)', 'rgba(255,255,255,.09)');
      label(colX + 11, y + 16, b.label.toUpperCase(), { size: 9.5, fill: b.color, ls: 1.2, weight: 700 });
      gdef.items.forEach((t, i) => label(colX + 11, y + 32 + i * 15, t, { size: 11, fill: T.ink2 }));

      const by = y + h / 2;
      const bus = dir.mix ? dir.mix.bus(gdef.key) : null;
      const design = (BUSES.find((x) => x.key === gdef.key) || {}).gain;
      const g = bus ? bus.gain.gain.value : design * (mix ? (mix.buses[gdef.key] ?? 1) : 1);
      const tilt = bus ? bus.tone.gain.value : (mix ? (mix.tilt[gdef.key] ?? 0) : 0);
      const send = bus && bus.send ? bus.send.gain.value : (BUSES.find((x) => x.key === gdef.key) || {}).send;
      box(busX, by - 23, busW, 46, 'rgba(12,17,24,.70)', b.color + '77', 8);
      label(busX + 12, by - 5, b.label, { size: 12.5 });
      label(busX + 12, by + 12,
        `${g.toFixed(2)} · tilt ${tilt >= 0 ? '+' : ''}${tilt.toFixed(1)} dB · send ${send.toFixed(2)}`,
        { size: 10, fill: T.ink2 });
      link(colX + colW, by, busX, by, b.color + 'aa', 1.6);
      busPorts.push({ y: by, color: b.color, send: !!send });
      y += h + 10;
    }

    /* ---- master chain --------------------------------------------------- */
    const lim = desc ? desc.limiter : { threshold: -8, ratio: 20, knee: 2, attack: 0.002, release: 0.18 };
    const master = desc ? desc.master : (dir.muted ? 0 : dir.master);
    const chain = [
      ['Σ sum', 'five buses + reverb return'],
      ['High-pass', '26 Hz · 0.6 Q'],
      ['Limiter', `${lim.threshold} dB · ${lim.ratio}:1 · ${(lim.attack * 1000).toFixed(0)}/${(lim.release * 1000).toFixed(0)} ms`],
      ['Ceiling', 'tanh soft clip, 2× oversampled'],
      ['Master', `gain ${Number(master).toFixed(2)}${dir.muted ? ' · muted' : ''}`],
    ];
    let cy = chainTop;
    const chainY = [];
    chain.forEach(([t, sub], i) => {
      chainY.push(cy);
      box(sumX, cy, sumW, chainH, 'rgba(12,17,24,.76)',
        i === 2 ? 'rgba(250,178,25,.5)' : i === 4 ? 'rgba(92,179,242,.45)' : 'rgba(255,255,255,.13)', 8);
      label(sumX + 13, cy + 19, t, { size: 12.5 });
      label(sumX + 13, cy + 34, sub, { size: 9.5, fill: T.ink2 });
      if (i > 0) link(sumX + sumW / 2, cy - chainGap, sumX + sumW / 2, cy, 'rgba(255,255,255,.28)', 1.3);
      cy += chainH + chainGap;
    });
    const sumMid = chainTop + chainH / 2;
    for (const p of busPorts) link(busX + busW, p.y, sumX, sumMid, p.color + '99', 1.5);

    /* ---- destination ---------------------------------------------------- */
    const masterY = chainY[4];
    box(dstX, masterY, dstW, chainH, 'rgba(92,179,242,.10)', 'rgba(92,179,242,.45)', 8);
    label(dstX + 14, masterY + 19, 'Destination', { size: 12.5 });
    label(dstX + 14, masterY + 34,
      st && st.sampleRate ? `${(st.sampleRate / 1000).toFixed(1)} kHz · stereo` : 'stereo out',
      { size: 9.5, fill: T.ink2 });
    link(sumX + sumW, masterY + chainH / 2, dstX, masterY + chainH / 2, 'rgba(92,179,242,.75)', 1.8);

    /* ---- reverb --------------------------------------------------------- */
    const verb = desc && desc.reverb;
    box(verbX, verbY, verbW, verbH, 'rgba(12,17,24,.70)', 'rgba(143,122,224,.45)', 8);
    label(verbX + 13, verbY + 20, 'Convolution reverb', { size: 12.5 });
    label(verbX + 13, verbY + 35,
      verb ? `canyon ${verb.canyon.toFixed(2)} · open ${verb.open.toFixed(2)} · wet ${verb.wet.toFixed(2)}`
        : `street canyon 0.58 s · open air 1.06 s · ${mix ? 'blend ' + mix.space.toFixed(2) : 'blended by altitude'}`,
      { size: 9.5, fill: T.ink2 });
    for (const p of busPorts) {
      if (!p.send) continue;
      link(busX + busW, p.y + 17, verbX, verbY + verbH / 2, p.color + '55', 1.1, '3 3');
    }
    link(verbX + verbW - 24, verbY, sumX + sumW - 24, chainTop + chainH, 'rgba(143,122,224,.55)', 1.4, '4 3');

    /* ---- footer --------------------------------------------------------- */
    const bank = dir.bank ? dir.bank.stats() : null;
    label(colX, 545,
      `5 buses · 14 sustained beds · ${dir.opts.voices || 24}-voice pool`
      + (bank ? ` · ${bank.entries} synthesised sources, ${bank.megabytes} MB` : ' · library baked on first gesture'),
      { size: 11, fill: T.ink3 });

    /* legend */
    const lg = this.parts.legend;
    lg.textContent = '';
    for (const b of BUSES) {
      const sp = el('span');
      const i = el('i');
      i.style.background = b.color;
      sp.append(i, document.createTextNode(b.label));
      lg.appendChild(sp);
    }
    lg.appendChild(el('span', null, '— — reverb send'));
    this.parts.diagramTag.className = 'tag ' + (this.mode === 'live' ? 'live' : this.mode === 'offline' ? 'off' : 'none');
    this.parts.diagramTag.textContent = this.mode === 'live' ? 'live gains' : this.mode === 'offline' ? 'gains from world state' : 'unavailable';
  }
}

const COLOR = {};
for (const b of BUSES) COLOR[b.key] = b.color;

const LABELS = {
  'hum.low': 'City roar', 'hum.mid': 'City body', 'hum.air': 'Air / tyre hiss',
  'traffic.wash': 'Tyre wash', 'traffic.engines': 'Engines',
  wind: 'Wind', 'rain.street': 'Rain — street', 'rain.aerial': 'Rain — aerial',
  night: 'Night insects', 'zone.industry': 'Industrial plant',
  'zone.retail': 'Retail frontage', 'zone.green': 'Trees / park',
  'road.a': 'Arterial (near)', 'road.b': 'Arterial (far)',
};

export const overlay = new Overlay();
export default overlay;
