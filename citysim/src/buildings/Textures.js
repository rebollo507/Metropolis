import * as THREE from 'three';
import { Rng } from '../core/Rng.js';

/**
 * Procedural PBR texture sets for architectural surfaces.
 *
 * Every set is albedo (sRGB canvas) + tangent-space normal (derived from a
 * grey-scale height canvas) + a packed ORM map (R = ambient occlusion,
 * G = roughness, B = metalness) — the glTF packing three understands when the
 * same texture is handed to `aoMap`, `roughnessMap` and `metalnessMap`.
 *
 * Nothing is downloaded. Everything here is drawn with canvas2d ops from a
 * seeded Rng, so the same seed always produces the same city.
 */

const ALBEDO = 512;
const DETAIL = 256;

/* ------------------------------------------------------------------ utils -- */

function mkCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function rgb(r, g, b) { return `rgb(${r | 0},${g | 0},${b | 0})`; }

function hsl(h, s, l) { return `hsl(${h.toFixed(1)},${(s * 100).toFixed(1)}%,${(l * 100).toFixed(1)}%)`; }

/** Wrap-aware fill that repeats a rect across the seam so the tile is seamless. */
function wrapRect(g, S, x, y, w, h) {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const rx = x + ox * S, ry = y + oy * S;
      if (rx > S || rx + w < 0 || ry > S || ry + h < 0) continue;
      g.fillRect(rx, ry, w, h);
    }
  }
}

/** Low-frequency blotchy grime / soiling pass. */
function grime(g, S, rng, { strength = 0.22, streaks = 0, dark = '0,0,0', blobs = 26, blobMin = 0.08, blobMax = 0.38 } = {}) {
  g.save();
  for (let i = 0; i < blobs; i++) {
    const x = rng.next() * S, y = rng.next() * S;
    const r = S * (blobMin + rng.next() * (blobMax - blobMin));
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const a = strength * (0.35 + rng.next() * 0.65);
    grd.addColorStop(0, `rgba(${dark},${a.toFixed(3)})`);
    grd.addColorStop(1, `rgba(${dark},0)`);
    g.fillStyle = grd;
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++) {
        g.save(); g.translate(ox * S, oy * S); g.fillRect(x - r, y - r, r * 2, r * 2); g.restore();
      }
  }
  for (let i = 0; i < streaks; i++) {
    const x = rng.next() * S;
    const w = S * (0.004 + rng.next() * 0.02);
    const y0 = rng.next() * S * 0.5;
    const len = S * (0.25 + rng.next() * 0.75);
    const grd = g.createLinearGradient(0, y0, 0, y0 + len);
    const a = strength * (0.5 + rng.next() * 0.9);
    grd.addColorStop(0, `rgba(${dark},${a.toFixed(3)})`);
    grd.addColorStop(1, `rgba(${dark},0)`);
    g.fillStyle = grd;
    wrapRect(g, S, x, y0, w, len);
  }
  g.restore();
}

/** Fine per-pixel noise, cheap: a sparse dot spray. */
function speckle(g, S, rng, { count = 4000, lightA = 0.05, darkA = 0.07, size = 1.4 } = {}) {
  for (let i = 0; i < count; i++) {
    const x = rng.next() * S, y = rng.next() * S;
    const up = rng.next() < 0.5;
    g.fillStyle = up ? `rgba(255,255,255,${lightA})` : `rgba(0,0,0,${darkA})`;
    g.fillRect(x, y, size, size);
  }
}

/* --------------------------------------------------- derived maps ---------- */

function normalTexture(heightCanvas, size, strength, renderer) {
  const hg = heightCanvas.getContext('2d', { willReadFrequently: true });
  const src = hg.getImageData(0, 0, size, size).data;
  const m = size - 1;
  const H = (x, y) => src[(((y & m) * size) + (x & m)) * 4] / 255;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      let nx = -dx, ny = dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
  t.needsUpdate = true;
  return t;
}

/**
 * ORM from the same height field: crevices are occluded and (usually) rougher.
 * `rough(h, n)` returns roughness for a height sample plus a hash value.
 */
function ormTexture(heightCanvas, size, { metal = 0, roughFn, aoStrength = 0.55 }, renderer, rng) {
  const hg = heightCanvas.getContext('2d', { willReadFrequently: true });
  const src = hg.getImageData(0, 0, size, size).data;
  const m = size - 1;
  const H = (x, y) => src[(((y & m) * size) + (x & m)) * 4] / 255;
  const out = new Uint8Array(size * size * 4);
  // one cheap deterministic hash lattice for roughness break-up
  const lat = new Float32Array(64 * 64);
  for (let i = 0; i < lat.length; i++) lat[i] = rng.next();
  const noise = (x, y) => lat[(((y >> 2) & 63) * 64) + ((x >> 2) & 63)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = H(x, y);
      // local cavity term
      const avg = (H(x - 2, y) + H(x + 2, y) + H(x, y - 2) + H(x, y + 2)) * 0.25;
      const cav = Math.max(0, avg - h);
      const ao = Math.max(0, Math.min(1, 1 - cav * aoStrength * 3.2 - (1 - h) * aoStrength * 0.35));
      const r = Math.max(0.03, Math.min(1, roughFn(h, noise(x, y))));
      const i = (y * size + x) * 4;
      out[i] = ao * 255;
      out[i + 1] = r * 255;
      out[i + 2] = metal * 255;
      out[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
  t.needsUpdate = true;
  return t;
}

function albedoTexture(canvas, renderer) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------ the surfaces -- */

/** Running-bond or Flemish brick. */
function brick(rng, opts) {
  const { courses = 22, perRow = 8.5, hue = 12, sat = 0.34, light = 0.40, bond = 'running' } = opts;
  const drawAll = (g, S, isHeight) => {
    const ch = S / courses;
    const bw = S / perRow;
    const mortarL = isHeight ? 0.30 : light * 1.55;
    g.fillStyle = isHeight ? rgb(76, 76, 76) : hsl(hue + 8, sat * 0.16, Math.min(0.72, mortarL));
    g.fillRect(0, 0, S, S);
    const r2 = new Rng(rng.int(1e9) >>> 0);
    for (let row = 0; row < courses; row++) {
      let off = (row % 2) * bw * 0.5;
      if (bond === 'flemish') off = (row % 2) * bw * 0.5 + (row % 4 < 2 ? bw * 0.25 : 0);
      const y = row * ch;
      for (let k = -1; k < perRow + 1; k++) {
        const x = k * bw + off;
        const jw = bond === 'flemish' && (k % 3 === 1) ? bw * 0.52 : bw;
        const v = r2.next();
        const v2 = r2.next();
        if (isHeight) {
          const h = 168 + v * 62 - (v2 < 0.08 ? 70 : 0);
          g.fillStyle = rgb(h, h, h);
        } else {
          const l = light * (0.74 + v * 0.52);
          const s = sat * (0.72 + v2 * 0.6);
          const hh = hue + (v2 - 0.5) * 16;
          g.fillStyle = hsl(hh, Math.min(0.9, s), Math.min(0.82, l));
        }
        const pad = Math.max(1, ch * 0.10);
        wrapRect(g, S, x + pad * 0.5, y + pad * 0.5, jw - pad, ch - pad);
      }
    }
    if (!isHeight) {
      speckle(g, S, r2, { count: 5200, lightA: 0.035, darkA: 0.06, size: 1.5 });
      grime(g, S, r2, { strength: 0.17, streaks: 16, dark: '24,20,16', blobs: 18, blobMin: 0.03, blobMax: 0.18 });
    } else {
      speckle(g, S, r2, { count: 3000, lightA: 0.06, darkA: 0.08, size: 1.6 });
    }
  };
  return {
    albedo: (g, S) => drawAll(g, S, false),
    height: (g, S) => drawAll(g, S, true),
    normalStrength: 5.0,
    orm: { metal: 0, aoStrength: 0.75, roughFn: (h, n) => 0.90 - h * 0.16 + n * 0.06 },
  };
}

/** Painted render / stucco — the workhorse of low-rise streets. */
function stucco(rng, opts) {
  const { hue = 38, sat = 0.14, light = 0.62 } = opts;
  const drawAll = (g, S, isHeight) => {
    g.fillStyle = isHeight ? rgb(180, 180, 180) : hsl(hue, sat, light);
    g.fillRect(0, 0, S, S);
    const r2 = new Rng(rng.int(1e9) >>> 0);
    // trowel blotches
    for (let i = 0; i < 240; i++) {
      const x = r2.next() * S, y = r2.next() * S;
      const w = S * (0.02 + r2.next() * 0.09), h = w * (0.4 + r2.next() * 0.9);
      const v = r2.next();
      if (isHeight) g.fillStyle = `rgba(${v > 0.5 ? 255 : 0},${v > 0.5 ? 255 : 0},${v > 0.5 ? 255 : 0},0.10)`;
      else g.fillStyle = hsl(hue + (v - 0.5) * 10, sat * (0.6 + v * 0.7), light * (0.93 + v * 0.14));
      g.save(); g.globalAlpha = isHeight ? 0.10 : 0.42;
      wrapRect(g, S, x, y, w, h);
      g.restore();
    }
    speckle(g, S, r2, { count: isHeight ? 7000 : 9000, lightA: 0.05, darkA: 0.05, size: 1.3 });
    // hairline cracks
    g.strokeStyle = isHeight ? 'rgba(0,0,0,0.55)' : 'rgba(40,34,28,0.22)';
    for (let i = 0; i < 9; i++) {
      g.lineWidth = 0.8 + r2.next() * 0.8;
      g.beginPath();
      let x = r2.next() * S, y = r2.next() * S;
      g.moveTo(x, y);
      for (let k = 0; k < 8; k++) {
        x += (r2.next() - 0.5) * S * 0.10; y += r2.next() * S * 0.07;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    if (!isHeight) grime(g, S, r2, { strength: 0.18, streaks: 16, dark: '30,26,20', blobs: 16, blobMin: 0.03, blobMax: 0.18 });
  };
  return {
    albedo: (g, S) => drawAll(g, S, false),
    height: (g, S) => drawAll(g, S, true),
    normalStrength: 2.0,
    orm: { metal: 0, aoStrength: 0.35, roughFn: (h, n) => 0.86 + n * 0.10 - h * 0.06 },
  };
}

/** Precast concrete panels — board-formed with visible joints. */
function concrete(rng, opts) {
  const { light = 0.55, hue = 34, sat = 0.045, panels = 3 } = opts;
  const drawAll = (g, S, isHeight) => {
    g.fillStyle = isHeight ? rgb(190, 190, 190) : hsl(hue, sat, light);
    g.fillRect(0, 0, S, S);
    const r2 = new Rng(rng.int(1e9) >>> 0);
    // subtle board-form horizontal banding
    const bands = 26;
    for (let i = 0; i < bands; i++) {
      const y = (i / bands) * S;
      const v = r2.next();
      g.fillStyle = isHeight
        ? `rgba(${v > 0.5 ? 255 : 0},${v > 0.5 ? 255 : 0},${v > 0.5 ? 255 : 0},0.07)`
        : `rgba(${v > 0.5 ? 255 : 20},${v > 0.5 ? 255 : 20},${v > 0.5 ? 250 : 20},${0.035 + v * 0.05})`;
      g.fillRect(0, y, S, S / bands * (0.5 + v * 0.5));
    }
    speckle(g, S, r2, { count: isHeight ? 9000 : 7000, lightA: 0.022, darkA: 0.026, size: 1.3 });
    // aggregate pocks
    for (let i = 0; i < 300; i++) {
      const x = r2.next() * S, y = r2.next() * S, rr = 0.6 + r2.next() * 1.5;
      g.fillStyle = isHeight ? 'rgba(0,0,0,0.5)' : 'rgba(30,28,26,0.10)';
      g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
    }
    // panel joints
    const pj = S / panels;
    g.fillStyle = isHeight ? 'rgba(0,0,0,0.9)' : 'rgba(46,44,42,0.42)';
    for (let i = 0; i < panels; i++) {
      g.fillRect(0, i * pj, S, Math.max(1.5, S * 0.008));
      g.fillRect(i * pj, 0, Math.max(1.5, S * 0.008), S);
    }
    if (!isHeight) {
      grime(g, S, r2, { strength: 0.13, streaks: 20, dark: '26,26,26', blobs: 14, blobMin: 0.03, blobMax: 0.14 });
    }
  };
  return {
    albedo: (g, S) => drawAll(g, S, false),
    height: (g, S) => drawAll(g, S, true),
    normalStrength: 3.0,
    orm: { metal: 0, aoStrength: 0.55, roughFn: (h, n) => 0.80 + n * 0.12 - h * 0.05 },
  };
}

/** Ashlar limestone — big coursed blocks, civic and pre-war commercial. */
function stone(rng, opts) {
  const { light = 0.66, hue = 42, sat = 0.09, courses = 7 } = opts;
  const drawAll = (g, S, isHeight) => {
    g.fillStyle = isHeight ? rgb(96, 96, 96) : hsl(hue, sat * 0.5, light * 0.78);
    g.fillRect(0, 0, S, S);
    const r2 = new Rng(rng.int(1e9) >>> 0);
    const ch = S / courses;
    for (let row = 0; row < courses; row++) {
      const y = row * ch;
      let x = -ch * (0.4 + r2.next());
      while (x < S + ch) {
        const w = ch * (1.5 + r2.next() * 1.6);
        const v = r2.next(), v2 = r2.next();
        if (isHeight) { const h = 180 + v * 55; g.fillStyle = rgb(h, h, h); }
        else g.fillStyle = hsl(hue + (v2 - 0.5) * 8, sat * (0.7 + v * 0.6), light * (0.90 + v * 0.18));
        const pad = Math.max(1.2, ch * 0.045);
        wrapRect(g, S, x + pad, y + pad, w - pad * 2, ch - pad * 2);
        // veining
        if (!isHeight && v2 > 0.55) {
          g.strokeStyle = `rgba(120,110,96,${0.10 + v * 0.12})`;
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(x + pad, y + ch * (0.2 + v * 0.6));
          g.lineTo(x + w - pad, y + ch * (0.2 + v2 * 0.6));
          g.stroke();
        }
        x += w;
      }
    }
    speckle(g, S, r2, { count: 6000, lightA: 0.028, darkA: 0.03, size: 1.3 });
    if (!isHeight) grime(g, S, r2, { strength: 0.17, streaks: 18, dark: '34,32,28', blobs: 16, blobMin: 0.03, blobMax: 0.16 });
  };
  return {
    albedo: (g, S) => drawAll(g, S, false),
    height: (g, S) => drawAll(g, S, true),
    normalStrength: 3.6,
    orm: { metal: 0, aoStrength: 0.7, roughFn: (h, n) => 0.72 - h * 0.10 + n * 0.10 },
  };
}

/** Corrugated / profiled steel sheet — industrial sheds. */
function corrugated(rng, opts) {
  const { hue = 200, sat = 0.06, light = 0.52, ribs = 16, rust = 0.5 } = opts;
  const drawAll = (g, S, isHeight) => {
    const r2 = new Rng(rng.int(1e9) >>> 0);
    const rw = S / ribs;
    for (let x = 0; x < S; x++) {
      const p = (x % rw) / rw;
      const w = Math.cos(p * Math.PI * 2) * 0.5 + 0.5;   // 1 at rib crest
      if (isHeight) { const h = 60 + w * 190; g.fillStyle = rgb(h, h, h); }
      else g.fillStyle = hsl(hue, sat, light * (0.72 + w * 0.5));
      g.fillRect(x, 0, 1.02, S);
    }
    // fixings every so often
    g.fillStyle = isHeight ? rgb(255, 255, 255) : hsl(hue, sat * 0.5, light * 1.25);
    for (let i = 0; i < ribs; i++) {
      for (let k = 0; k < 5; k++) {
        g.beginPath();
        g.arc(i * rw + rw * 0.5, (k + 0.5) * S / 5, S * 0.006, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (!isHeight) {
      // rust bleed from fixings and base
      for (let i = 0; i < 26 * rust; i++) {
        const x = r2.next() * S, y = r2.next() * S;
        const len = S * (0.08 + r2.next() * 0.4);
        const grd = g.createLinearGradient(0, y, 0, y + len);
        grd.addColorStop(0, `rgba(122,64,26,${(0.16 + r2.next() * 0.28).toFixed(3)})`);
        grd.addColorStop(1, 'rgba(122,64,26,0)');
        g.fillStyle = grd;
        wrapRect(g, S, x, y, S * (0.006 + r2.next() * 0.016), len);
      }
      grime(g, S, r2, { strength: 0.22, streaks: 10, dark: '30,30,32' });
      speckle(g, S, r2, { count: 5000, lightA: 0.05, darkA: 0.05, size: 1.2 });
    }
  };
  return {
    albedo: (g, S) => drawAll(g, S, false),
    height: (g, S) => drawAll(g, S, true),
    normalStrength: 6.0,
    orm: { metal: 0.72, aoStrength: 0.4, roughFn: (h, n) => 0.44 + (1 - h) * 0.28 + n * 0.10 },
  };
}

/** Asphalt shingle / clay tile roofing. */
function shingle(rng, opts) {
  const { hue = 26, sat = 0.20, light = 0.30, rows = 12, tile = false } = opts;
  const drawAll = (g, S, isHeight) => {
    g.fillStyle = isHeight ? rgb(70, 70, 70) : hsl(hue, sat * 0.7, light * 0.6);
    g.fillRect(0, 0, S, S);
    const r2 = new Rng(rng.int(1e9) >>> 0);
    const ch = S / rows;
    const per = tile ? 20 : 7;
    const bw = S / per;
    for (let row = rows - 1; row >= 0; row--) {
      const y = row * ch;
      const off = (row % 2) * bw * 0.5;
      for (let k = -1; k < per + 1; k++) {
        const v = r2.next(), v2 = r2.next();
        if (isHeight) { const h = 130 + v * 70 + (row % 2) * 12; g.fillStyle = rgb(h, h, h); }
        else g.fillStyle = hsl(hue + (v2 - 0.5) * 14, sat * (0.7 + v * 0.7), light * (0.78 + v * 0.56));
        if (tile) {
          g.beginPath();
          g.roundRect?.(k * bw + off, y, bw * 0.94, ch * 1.35, [bw * 0.4, bw * 0.4, 0, 0]);
          if (g.roundRect) g.fill(); else g.fillRect(k * bw + off, y, bw * 0.94, ch * 1.3);
        } else {
          wrapRect(g, S, k * bw + off, y, bw * 0.96, ch * 1.18);
        }
      }
      // shadow line under each course
      g.fillStyle = isHeight ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.30)';
      g.fillRect(0, y + ch * 1.14, S, Math.max(1.2, ch * 0.08));
    }
    speckle(g, S, r2, { count: 9000, lightA: 0.05, darkA: 0.06, size: 1.5 });
    if (!isHeight) grime(g, S, r2, { strength: 0.20, streaks: 6, dark: '20,20,18' });
  };
  return {
    albedo: (g, S) => drawAll(g, S, false),
    height: (g, S) => drawAll(g, S, true),
    normalStrength: 4.4,
    orm: { metal: 0, aoStrength: 0.7, roughFn: (h, n) => 0.90 - h * 0.10 + n * 0.06 },
  };
}

/** Flat-roof membrane + gravel ballast + seams. */
function membrane(rng, opts) {
  const { light = 0.33, hue = 210, sat = 0.03 } = opts;
  const drawAll = (g, S, isHeight) => {
    g.fillStyle = isHeight ? rgb(150, 150, 150) : hsl(hue, sat, light);
    g.fillRect(0, 0, S, S);
    const r2 = new Rng(rng.int(1e9) >>> 0);
    // rolled seams
    const seams = 5;
    for (let i = 0; i < seams; i++) {
      const y = (i / seams) * S + r2.next() * 4;
      g.fillStyle = isHeight ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.05)';
      g.fillRect(0, y, S, Math.max(2, S * 0.012));
      g.fillStyle = isHeight ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.16)';
      g.fillRect(0, y + S * 0.012, S, Math.max(1, S * 0.005));
    }
    // gravel / patches
    for (let i = 0; i < 2600; i++) {
      const x = r2.next() * S, y = r2.next() * S, rr = 0.8 + r2.next() * 2.4;
      const v = r2.next();
      if (isHeight) g.fillStyle = `rgba(255,255,255,${(0.10 + v * 0.3).toFixed(2)})`;
      else g.fillStyle = `hsla(${hue + (v - 0.5) * 40},${(sat * 220).toFixed(0)}%,${((light * (0.6 + v * 1.0)) * 100).toFixed(0)}%,0.55)`;
      g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
    }
    if (!isHeight) {
      // ponding stains
      grime(g, S, r2, { strength: 0.30, streaks: 0, dark: '18,20,22' });
      grime(g, S, r2, { strength: 0.14, streaks: 0, dark: '210,205,190' });
    }
  };
  return {
    albedo: (g, S) => drawAll(g, S, false),
    height: (g, S) => drawAll(g, S, true),
    normalStrength: 2.4,
    orm: { metal: 0, aoStrength: 0.4, roughFn: (h, n) => 0.88 + n * 0.10 - h * 0.10 },
  };
}

/** Painted trim / metalwork — window frames, cornices, railings, mullions. */
function paint(rng, opts) {
  const { light = 0.80, hue = 40, sat = 0.05 } = opts;
  const drawAll = (g, S, isHeight) => {
    g.fillStyle = isHeight ? rgb(200, 200, 200) : hsl(hue, sat, light);
    g.fillRect(0, 0, S, S);
    const r2 = new Rng(rng.int(1e9) >>> 0);
    speckle(g, S, r2, { count: 5000, lightA: 0.04, darkA: 0.05, size: 1.2 });
    // chipping / wear
    for (let i = 0; i < 120; i++) {
      const x = r2.next() * S, y = r2.next() * S, w = 1 + r2.next() * 4;
      g.fillStyle = isHeight ? 'rgba(0,0,0,0.4)' : 'rgba(60,54,46,0.18)';
      g.fillRect(x, y, w, w * (0.4 + r2.next()));
    }
    if (!isHeight) grime(g, S, r2, { strength: 0.16, streaks: 8, dark: '40,38,34' });
  };
  return {
    albedo: (g, S) => drawAll(g, S, false),
    height: (g, S) => drawAll(g, S, true),
    normalStrength: 1.4,
    orm: { metal: 0.08, aoStrength: 0.3, roughFn: (h, n) => 0.52 + n * 0.16 },
  };
}

/* -------------------------------------------------- window interior atlas -- */

/**
 * What is *behind* the glass.
 *
 * A window with nothing behind it is a flat rectangle no matter how good the
 * reflection on it is. This draws a 4x4 atlas of interiors — venetian blinds
 * pulled to different heights, curtains, a lit back wall, a dark empty room,
 * a ceiling slab catching light — which every pane samples one cell of. It is
 * the single cheapest thing that makes glazing read as depth rather than paint.
 *
 * Cells are deliberately low-contrast and dark: the pane's specular reflection
 * of the sky is meant to dominate by day, and this to take over at night.
 */
export const INTERIOR_CELLS = 4;

function drawInterior(g, S, seed) {
  const N = INTERIOR_CELLS;
  const cs = S / N;
  const rng = new Rng(seed >>> 0);
  for (let cy = 0; cy < N; cy++) {
    for (let cx = 0; cx < N; cx++) {
      const x0 = cx * cs, y0 = cy * cs;
      const idx = cy * N + cx;
      if (idx === N * N - 1) {
        // reserved "no room behind this" cell — glass balustrades, spandrel
        // infill, anything that is a sheet of glass rather than a window
        const gg = g.createLinearGradient(0, y0, 0, y0 + cs);
        gg.addColorStop(0, hsl(206, 0.10, 0.31));
        gg.addColorStop(1, hsl(206, 0.12, 0.21));
        g.fillStyle = gg;
        g.fillRect(x0, y0, cs, cs);
        continue;
      }
      // room tone: mostly cool-dark, a few warm
      const warm = rng.next() < 0.34;
      const base = 0.055 + rng.next() * 0.10;
      const hue = warm ? 32 : 214;
      const sat = warm ? 0.26 : 0.20;
      const grd = g.createLinearGradient(0, y0, 0, y0 + cs);
      grd.addColorStop(0, hsl(hue, sat, base * 1.9));      // ceiling catches light
      grd.addColorStop(0.35, hsl(hue, sat, base));
      grd.addColorStop(1, hsl(hue, sat, base * 0.55));     // floor falls away
      g.fillStyle = grd;
      g.fillRect(x0, y0, cs, cs);

      // back wall / lit slab deeper in the room
      if (rng.next() < 0.55) {
        const bw = cs * (0.30 + rng.next() * 0.55);
        const bh = cs * (0.22 + rng.next() * 0.40);
        const bx = x0 + rng.next() * (cs - bw);
        const by = y0 + cs * 0.18 + rng.next() * (cs * 0.4);
        g.fillStyle = hsl(hue, sat * 0.6, base * (1.5 + rng.next() * 1.5));
        g.fillRect(bx, by, bw, bh);
      }

      // ceiling strip — a fluorescent batten or a soffit
      g.fillStyle = hsl(warm ? 36 : 200, 0.14, base * (1.7 + rng.next() * 1.2));
      g.fillRect(x0, y0, cs, Math.max(2, cs * (0.05 + rng.next() * 0.05)));

      // furniture / partition silhouettes along the cill
      const nf = Math.floor(rng.next() * 3);
      for (let k = 0; k < nf; k++) {
        const fw = cs * (0.10 + rng.next() * 0.26);
        const fh = cs * (0.12 + rng.next() * 0.26);
        g.fillStyle = `rgba(0,0,0,${(0.30 + rng.next() * 0.35).toFixed(2)})`;
        g.fillRect(x0 + rng.next() * (cs - fw), y0 + cs - fh, fw, fh);
      }

      const dress = idx % 4;
      if (dress === 0 || (dress === 3 && rng.next() < 0.5)) {
        // venetian blinds, dropped to a per-cell height
        const drop = cs * (0.20 + rng.next() * 0.78);
        const slats = Math.max(4, Math.round(drop / (cs * 0.055)));
        const l = 0.21 + rng.next() * 0.19;
        for (let s = 0; s < slats; s++) {
          const yy = y0 + (s / slats) * drop;
          g.fillStyle = hsl(warm ? 40 : 210, 0.06, l);
          g.fillRect(x0, yy, cs, (drop / slats) * 0.62);
          g.fillStyle = 'rgba(0,0,0,0.28)';
          g.fillRect(x0, yy + (drop / slats) * 0.62, cs, (drop / slats) * 0.38);
        }
      } else if (dress === 1) {
        // drawn curtains at one or both jambs
        const sides = rng.next() < 0.35 ? [0] : [0, 1];
        for (const sd of sides) {
          const cw = cs * (0.16 + rng.next() * 0.24);
          const cx0 = sd ? x0 + cs - cw : x0;
          const folds = 5;
          for (let f = 0; f < folds; f++) {
            const l = 0.12 + 0.12 * Math.abs(Math.sin((f / folds) * Math.PI * 2.2));
            g.fillStyle = hsl(warm ? 28 : 206, 0.14, l);
            g.fillRect(cx0 + (f / folds) * cw, y0, cw / folds + 1, cs);
          }
        }
      } else if (dress === 2 && rng.next() < 0.6) {
        // roller blind, half down, plus a bright sliver of room under it
        const drop = cs * (0.3 + rng.next() * 0.4);
        g.fillStyle = hsl(warm ? 38 : 208, 0.08, 0.19 + rng.next() * 0.11);
        g.fillRect(x0, y0, cs, drop);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x0, y0 + drop - Math.max(1.5, cs * 0.012), cs, Math.max(1.5, cs * 0.012));
      }

      g.save(); g.translate(x0, y0);
      speckle(g, cs, rng, { count: 240, lightA: 0.02, darkA: 0.05, size: 1.4 });
      g.restore();
      // dark gutter so mip bleed between cells stays dark rather than glowing
      g.fillStyle = 'rgba(0,0,0,0.72)';
      g.fillRect(x0, y0, cs, 2);
      g.fillRect(x0, y0 + cs - 2, cs, 2);
      g.fillRect(x0, y0, 2, cs);
      g.fillRect(x0 + cs - 2, y0, 2, cs);
    }
  }
}

/* ---------------------------------------------------------------- factory -- */

const RECIPES = {
  brickRed:    (r) => brick(r, { hue: 10, sat: 0.42, light: 0.33, courses: 22, perRow: 8.5 }),
  brickBuff:   (r) => brick(r, { hue: 28, sat: 0.22, light: 0.50, courses: 22, perRow: 8.5, bond: 'flemish' }),
  brickDark:   (r) => brick(r, { hue: 14, sat: 0.20, light: 0.30, courses: 22, perRow: 8.5 }),
  stucco:      (r) => stucco(r, { hue: 40, sat: 0.13, light: 0.66 }),
  stuccoWarm:  (r) => stucco(r, { hue: 24, sat: 0.22, light: 0.56 }),
  concrete:    (r) => concrete(r, { light: 0.56, panels: 3 }),
  concreteDk:  (r) => concrete(r, { light: 0.40, hue: 220, sat: 0.03, panels: 2 }),
  stone:       (r) => stone(r, { light: 0.66, courses: 7 }),
  metal:       (r) => corrugated(r, { hue: 205, sat: 0.05, light: 0.50, ribs: 16, rust: 0.7 }),
  metalWarm:   (r) => corrugated(r, { hue: 32, sat: 0.10, light: 0.42, ribs: 20, rust: 1.2 }),
  shingle:     (r) => shingle(r, { hue: 24, sat: 0.10, light: 0.24, rows: 12 }),
  tileRoof:    (r) => shingle(r, { hue: 16, sat: 0.42, light: 0.34, rows: 10, tile: true }),
  membrane:    (r) => membrane(r, { light: 0.34 }),
  paint:       (r) => paint(r, { light: 0.82, hue: 40, sat: 0.04 }),
};

export class BuildingTextures {
  constructor(renderer, seed, quality = 'high') {
    this.renderer = renderer;
    this.seed = seed >>> 0;
    this.quality = quality;
    this.sets = new Map();
    this._disposables = [];
  }

  /** Build (or fetch) an {map, normalMap, ormMap} set by recipe name. */
  set(name) {
    if (this.sets.has(name)) return this.sets.get(name);
    const recipe = RECIPES[name] || RECIPES.stucco;
    const rng = Rng.derive(this.seed, 'tex:' + name);
    const spec = recipe(rng);

    const aSize = this.quality === 'low' ? 256 : ALBEDO;
    const dSize = this.quality === 'low' ? 128 : DETAIL;

    const ac = mkCanvas(aSize);
    spec.albedo(ac.getContext('2d'), aSize);
    const hc = mkCanvas(dSize);
    spec.height(hc.getContext('2d', { willReadFrequently: true }), dSize);

    const out = {
      map: albedoTexture(ac, this.renderer),
      normalMap: normalTexture(hc, dSize, spec.normalStrength, this.renderer),
      ormMap: ormTexture(hc, dSize, spec.orm, this.renderer, Rng.derive(this.seed, 'orm:' + name)),
    };
    this._disposables.push(out.map, out.normalMap, out.ormMap);
    this.sets.set(name, out);
    return out;
  }

  /** The 4x4 window-interior atlas, shared by every pane of glass in the city. */
  interior() {
    if (this._interior) return this._interior;
    const size = this.quality === 'low' ? 256 : 512;
    const c = mkCanvas(size);
    drawInterior(c.getContext('2d'), size, (this.seed ^ 0x1f2e3d4c) >>> 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    // atlas: never wrap, or a pane bleeds into its neighbour cell
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = Math.min(8, this.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
    t.needsUpdate = true;
    this._disposables.push(t);
    this._interior = t;
    return t;
  }

  dispose() {
    for (const t of this._disposables) t.dispose?.();
    this._disposables.length = 0;
    this.sets.clear();
    this._interior = null;
  }
}

export const RECIPE_NAMES = Object.keys(RECIPES);
export default BuildingTextures;
