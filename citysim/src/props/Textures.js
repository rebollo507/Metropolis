import * as THREE from 'three';

/**
 * Procedural texture set for props. Everything is drawn into a canvas at init
 * (no downloads — the egress proxy blocks the CC0 sites), cached through
 * `ctx.assets.canvasTexture` under a `props:` namespace so a second showcase
 * costs nothing.
 *
 * Rules that keep this out of programmer-art territory:
 *   - no flat fills: every albedo carries multi-octave value noise + a second,
 *     larger-scale stain layer, so surfaces break up under a moving camera;
 *   - alpha-tested foliage is drawn leaf by leaf, not as a blurred blob, and the
 *     leaves carry per-leaf hue and luminance scatter plus a darker midrib;
 *   - normal maps are Sobel-derived from the same height field that drove the
 *     albedo, so the lighting agrees with what you see.
 */

/* --------------------------------------------------------------- noise ---- */

function h2(x, y, s) {
  let n = (x * 374761393 + y * 668265263 + s * 1274126177) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi, s), b = h2(xi + 1, yi, s);
  const c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y, s, oct = 4, gain = 0.5) {
  let a = 1, f = 1, sum = 0, nrm = 0;
  for (let i = 0; i < oct; i++) { sum += a * vnoise(x * f, y * f, s + i * 17); nrm += a; a *= gain; f *= 2; }
  return sum / nrm;
}

/* ------------------------------------------------------- canvas helpers ---- */

/** Sobel a height callback into an RGB normal map (tangent space, +Y up). */
function normalFromHeight(g, size, height, strength = 2.2) {
  const img = g.createImageData(size, size);
  const d = img.data;
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) H[y * size + x] = height(x, y);
  const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

function px(g, size, fn) {
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const c = fn(x, y);
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c.length > 3 ? c[3] : 255;
    }
  }
  g.putImageData(img, 0, 0);
}

/* ------------------------------------------------------------- foliage ---- */

/** One leaf, drawn as two mirrored quadratic arcs with a midrib. */
function leaf(g, cx, cy, len, wid, ang, fill, rib, shape) {
  g.save();
  g.translate(cx, cy);
  g.rotate(ang);
  g.beginPath();
  if (shape === 'needle') {
    g.moveTo(0, 0);
    g.quadraticCurveTo(wid * 0.9, len * 0.45, 0, len);
    g.quadraticCurveTo(-wid * 0.9, len * 0.45, 0, 0);
  } else if (shape === 'lobed') {
    g.moveTo(0, 0);
    g.quadraticCurveTo(wid * 1.5, len * 0.16, wid * 0.55, len * 0.34);
    g.quadraticCurveTo(wid * 1.7, len * 0.5, wid * 0.5, len * 0.68);
    g.quadraticCurveTo(wid * 1.05, len * 0.86, 0, len);
    g.quadraticCurveTo(-wid * 1.05, len * 0.86, -wid * 0.5, len * 0.68);
    g.quadraticCurveTo(-wid * 1.7, len * 0.5, -wid * 0.55, len * 0.34);
    g.quadraticCurveTo(-wid * 1.5, len * 0.16, 0, 0);
  } else {
    g.moveTo(0, 0);
    g.quadraticCurveTo(wid, len * 0.36, 0, len);
    g.quadraticCurveTo(-wid, len * 0.36, 0, 0);
  }
  g.fillStyle = fill;
  g.fill();
  if (rib) {
    g.strokeStyle = rib;
    g.lineWidth = Math.max(0.7, len * 0.035);
    g.beginPath();
    g.moveTo(0, len * 0.04);
    g.lineTo(0, len * 0.94);
    g.stroke();
  }
  g.restore();
}

const SPECIES_LEAF = {
  // hue base / spread, leaf shape + proportions, cluster shape.
  // Lightness runs high: the material is lit, and a canopy authored dark reads
  // as a black mass once the sun is behind it.
  oak:    { h: [82, 112], s: [0.34, 0.58], l: [0.31, 0.56], shape: 'lobed',  len: [26, 44], wid: [9, 15], n: 104 },
  plane:  { h: [72, 104], s: [0.36, 0.62], l: [0.36, 0.62], shape: 'lobed',  len: [30, 50], wid: [12, 20], n: 88 },
  birch:  { h: [68, 100], s: [0.38, 0.66], l: [0.42, 0.68], shape: 'oval',   len: [16, 28], wid: [7, 12], n: 158 },
  conifer:{ h: [98, 138], s: [0.28, 0.48], l: [0.21, 0.40], shape: 'needle',len: [30, 52], wid: [3, 6], n: 205 },
};

function drawLeafCell(g, ox, oy, cell, spec, seed) {
  const cx = ox + cell / 2, cy = oy + cell / 2;
  const R = cell * 0.46;
  let k = seed;
  const rnd = () => { k = (k * 1664525 + 1013904223) >>> 0; return k / 4294967296; };

  // soft interior mass so the cluster does not read as scattered confetti
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, R);
  grd.addColorStop(0, 'rgba(80,112,56,0.52)');
  grd.addColorStop(0.7, 'rgba(94,126,62,0.30)');
  grd.addColorStop(1, 'rgba(86,118,58,0)');
  g.fillStyle = grd;
  // an irregular blob rather than a disc, so no cluster shows a circular edge
  g.beginPath();
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const rr = R * (0.72 + 0.30 * Math.abs(Math.sin(a * 2.3 + seed * 0.001)));
    const px2 = cx + Math.cos(a) * rr, py2 = cy + Math.sin(a) * rr;
    i ? g.lineTo(px2, py2) : g.moveTo(px2, py2);
  }
  g.closePath(); g.fill();

  for (let i = 0; i < spec.n; i++) {
    // bias toward the rim so the silhouette is made of leaves, not of the blob
    const rr = Math.pow(rnd(), 0.55) * R;
    const a = rnd() * Math.PI * 2;
    const lx = cx + Math.cos(a) * rr;
    const ly = cy + Math.sin(a) * rr;
    const len = spec.len[0] + rnd() * (spec.len[1] - spec.len[0]);
    const wid = spec.wid[0] + rnd() * (spec.wid[1] - spec.wid[0]);
    if (rr + len > R * 1.5) continue;
    const hue = spec.h[0] + rnd() * (spec.h[1] - spec.h[0]);
    const sat = spec.s[0] + rnd() * (spec.s[1] - spec.s[0]);
    // leaves nearer the rim catch more light
    const lum = (spec.l[0] + rnd() * (spec.l[1] - spec.l[0])) * (0.74 + 0.46 * (rr / R));
    const fill = `hsl(${hue.toFixed(0)},${(sat * 100).toFixed(0)}%,${(lum * 100).toFixed(0)}%)`;
    const rib = `hsl(${(hue - 6).toFixed(0)},${(sat * 100).toFixed(0)}%,${(lum * 62).toFixed(0)}%)`;
    leaf(g, lx, ly, len, wid, a + Math.PI / 2 + (rnd() - 0.5) * 1.6, fill, len > 22 ? rib : null, spec.shape);
  }
}

/* ------------------------------------------------------------- exports ---- */

export default function propTextures(assets, seed = 1337) {
  const T = {};
  const key = (k) => `props:${k}:${seed}`;

  /* ---- bark ------------------------------------------------------------ */
  const barkH = (x, y, s) => {
    const ridge = Math.abs(Math.sin(x * 0.115 + fbm(x * 0.02, y * 0.012, s, 3) * 5.2));
    const fis = Math.pow(1 - ridge, 2.4);
    return 0.55 + fbm(x * 0.06, y * 0.03, s + 5, 4) * 0.35 - fis * 0.62;
  };
  T.bark = assets.canvasTexture(key('bark'), 512, (g, S) => {
    px(g, S, (x, y) => {
      const h = barkH(x, y, seed);
      const grime = fbm(x * 0.011, y * 0.011, seed + 91, 3);
      const moss = Math.max(0, fbm(x * 0.018, y * 0.014, seed + 33, 3) - 0.58) * 2.4;
      let r = 96 + h * 78, gg = 82 + h * 66, b = 66 + h * 50;
      r *= 0.82 + grime * 0.34; gg *= 0.82 + grime * 0.34; b *= 0.80 + grime * 0.3;
      r = r * (1 - moss * 0.55) + 62 * moss;
      gg = gg * (1 - moss * 0.35) + 92 * moss;
      b = b * (1 - moss * 0.6) + 48 * moss;
      return [r, gg, b];
    });
  }, { srgb: true, repeat: 1 });

  T.barkN = assets.canvasTexture(key('barkN'), 512, (g, S) => {
    normalFromHeight(g, S, (x, y) => barkH(x, y, seed), 1.35);
  }, { srgb: false, repeat: 1 });

  /* ---- leaf cluster atlas (2x2) --------------------------------------- */
  T.leaves = assets.canvasTexture(key('leaves'), 1024, (g, S) => {
    g.clearRect(0, 0, S, S);
    const cell = S / 2;
    const names = ['oak', 'plane', 'birch', 'conifer'];
    for (let i = 0; i < 4; i++) {
      const ox = (i % 2) * cell, oy = Math.floor(i / 2) * cell;
      drawLeafCell(g, ox, oy, cell, SPECIES_LEAF[names[i]], (seed + i * 7717) >>> 0);
    }
  }, { srgb: true, repeat: 1, wrap: THREE.ClampToEdgeWrapping });

  /* ---- distant canopy silhouettes (2x2), one per species --------------- */
  T.canopyFar = assets.canvasTexture(key('canopyFar'), 512, (g, S) => {
    g.clearRect(0, 0, S, S);
    const cell = S / 2;
    const tone = [
      ['#5c7f42', '#3b5b2b'], ['#679049', '#42632f'],
      ['#7d9c56', '#55763a'], ['#456c3c', '#2b4529'],
    ];
    for (let i = 0; i < 4; i++) {
      const ox = (i % 2) * cell, oy = Math.floor(i / 2) * cell;
      const cx = ox + cell / 2, cy = oy + cell * 0.5;
      let k = (seed + i * 104729) >>> 0;
      const rnd = () => { k = (k * 1664525 + 1013904223) >>> 0; return k / 4294967296; };
      // a mass built from overlapping discs so the edge is lumpy, not circular
      const conif = i === 3;
      for (let b = 0; b < 46; b++) {
        const a = rnd() * Math.PI * 2;
        const rr = Math.pow(rnd(), 0.5) * cell * (conif ? 0.24 : 0.34);
        const yy = conif ? cy + (rnd() - 0.5) * cell * 0.8 : cy + (rnd() - 0.5) * cell * 0.55;
        const sq = conif ? 1 - Math.abs(yy - oy - cell * 0.15) / (cell * 0.9) : 1;
        const rad = cell * (conif ? 0.16 : 0.19) * (0.5 + rnd() * 0.8) * Math.max(0.15, sq);
        const t = rnd();
        g.fillStyle = t > 0.5 ? tone[i][0] : tone[i][1];
        g.globalAlpha = 0.55 + rnd() * 0.45;
        g.beginPath();
        g.arc(cx + Math.cos(a) * rr, yy, rad, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      // trunk stub so the far LOD still reads as a tree
      g.fillStyle = '#4a3a2a';
      g.fillRect(cx - cell * 0.022, oy + cell * 0.62, cell * 0.044, cell * 0.36);
    }
  }, { srgb: true, repeat: 1, wrap: THREE.ClampToEdgeWrapping });

  /* ---- grass tuft / low scrub alpha strip ------------------------------ */
  T.grass = assets.canvasTexture(key('grass'), 256, (g, S) => {
    g.clearRect(0, 0, S, S);
    let k = seed ^ 0x5bd1;
    const rnd = () => { k = (k * 1664525 + 1013904223) >>> 0; return k / 4294967296; };
    for (let i = 0; i < 46; i++) {
      const x = 8 + rnd() * (S - 16);
      const h = S * (0.42 + rnd() * 0.55);
      const bend = (rnd() - 0.5) * S * 0.30;
      const w = 2.0 + rnd() * 3.4;
      const hue = 74 + rnd() * 34;
      const lum = 20 + rnd() * 24;
      g.strokeStyle = `hsl(${hue.toFixed(0)},${(38 + rnd() * 26).toFixed(0)}%,${lum.toFixed(0)}%)`;
      g.lineWidth = w;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x, S);
      g.quadraticCurveTo(x + bend * 0.4, S - h * 0.55, x + bend, S - h);
      g.stroke();
    }
  }, { srgb: true, repeat: 1, wrap: THREE.ClampToEdgeWrapping });

  /* ---- hedge / shrub foliage ------------------------------------------ */
  T.shrub = assets.canvasTexture(key('shrub'), 512, (g, S) => {
    px(g, S, (x, y) => {
      const n = fbm(x * 0.055, y * 0.055, seed + 7, 5, 0.55);
      const m = fbm(x * 0.19, y * 0.19, seed + 71, 3);
      const l = 0.30 + n * 0.62 + m * 0.22;
      return [26 + l * 58, 44 + l * 96, 22 + l * 42];
    });
  }, { srgb: true, repeat: 1 });
  T.shrubN = assets.canvasTexture(key('shrubN'), 512, (g, S) => {
    normalFromHeight(g, S, (x, y) => fbm(x * 0.09, y * 0.09, seed + 7, 4, 0.6), 2.6);
  }, { srgb: false, repeat: 1 });

  /* ---- painted metal --------------------------------------------------- */
  T.metal = assets.canvasTexture(key('metal'), 256, (g, S) => {
    px(g, S, (x, y) => {
      const brush = fbm(x * 0.9, y * 0.06, seed + 13, 3);
      const dirt = fbm(x * 0.013, y * 0.013, seed + 47, 3);
      const chip = h2(x >> 1, y >> 1, seed + 3) > 0.995 ? 0.55 : 1;
      const l = (0.80 + brush * 0.20) * (0.86 + dirt * 0.2) * chip;
      return [232 * l, 234 * l, 236 * l];
    });
  }, { srgb: true, repeat: 1 });
  T.metalN = assets.canvasTexture(key('metalN'), 256, (g, S) => {
    normalFromHeight(g, S, (x, y) => fbm(x * 0.9, y * 0.06, seed + 13, 3) * 0.4
      + (h2(x >> 1, y >> 1, seed + 3) > 0.995 ? -0.5 : 0), 0.9);
  }, { srgb: false, repeat: 1 });

  /* ---- concrete / precast --------------------------------------------- */
  T.concrete = assets.canvasTexture(key('concrete'), 512, (g, S) => {
    px(g, S, (x, y) => {
      const n = fbm(x * 0.028, y * 0.028, seed + 21, 5);
      const grit = h2(x, y, seed + 4) * 0.11;
      const stain = Math.max(0, fbm(x * 0.007, y * 0.009, seed + 61, 3) - 0.5) * 1.2;
      const l = (0.66 + n * 0.30 + grit) * (1 - stain * 0.26);
      return [214 * l, 212 * l, 205 * l];
    });
  }, { srgb: true, repeat: 1 });
  T.concreteN = assets.canvasTexture(key('concreteN'), 512, (g, S) => {
    normalFromHeight(g, S, (x, y) => fbm(x * 0.06, y * 0.06, seed + 21, 4) + h2(x, y, seed + 4) * 0.25, 1.1);
  }, { srgb: false, repeat: 1 });

  /* ---- timber ---------------------------------------------------------- */
  T.wood = assets.canvasTexture(key('wood'), 512, (g, S) => {
    px(g, S, (x, y) => {
      const grain = Math.sin((y + fbm(x * 0.02, y * 0.006, seed + 9, 3) * 34) * 0.62);
      const knot = Math.max(0, 1 - Math.hypot(x - 190, y - 320) / 26);
      const n = fbm(x * 0.09, y * 0.02, seed + 29, 4);
      const l = 0.56 + grain * 0.10 + n * 0.26 - knot * 0.42;
      return [176 * l, 132 * l, 84 * l];
    });
  }, { srgb: true, repeat: 1 });
  T.woodN = assets.canvasTexture(key('woodN'), 512, (g, S) => {
    normalFromHeight(g, S, (x, y) =>
      Math.sin((y + fbm(x * 0.02, y * 0.006, seed + 9, 3) * 34) * 0.62) * 0.35
      + fbm(x * 0.09, y * 0.02, seed + 29, 3) * 0.4, 0.8);
  }, { srgb: false, repeat: 1 });

  /* ---- brick / masonry for garden walls -------------------------------- */
  T.brick = assets.canvasTexture(key('brick'), 512, (g, S) => {
    px(g, S, (x, y) => {
      const row = Math.floor(y / 32);
      const off = (row & 1) ? 32 : 0;
      const bx = (x + off) % 64, by = y % 32;
      const mortar = bx < 4 || by < 4;
      const jitter = h2(Math.floor((x + off) / 64), row, seed + 6);
      const n = fbm(x * 0.12, y * 0.12, seed + 66, 3);
      if (mortar) { const l = 0.66 + n * 0.22; return [196 * l, 190 * l, 178 * l]; }
      const l = (0.56 + n * 0.36) * (0.76 + jitter * 0.42);
      return [162 * l, 84 * l, 62 * l];
    });
  }, { srgb: true, repeat: 1 });

  /* ---- fabric (awnings, parasols) — tinted per instance ---------------- */
  T.fabric = assets.canvasTexture(key('fabric'), 256, (g, S) => {
    px(g, S, (x, y) => {
      const stripe = ((x >> 5) & 1) ? 1.0 : 0.68;
      const weave = 0.9 + 0.1 * Math.sin(x * 3.1) * Math.sin(y * 3.1);
      const dirt = fbm(x * 0.02, y * 0.02, seed + 88, 3);
      const l = stripe * weave * (0.84 + dirt * 0.22);
      return [246 * l, 244 * l, 240 * l];
    });
  }, { srgb: true, repeat: 1 });

  /* ---- signage atlas 4x4 of 256 px cells ------------------------------- */
  T.signs = assets.canvasTexture(key('signs'), 1024, (g, S) => {
    const C = S / 4;
    const cell = (i) => [(i % 4) * C, Math.floor(i / 4) * C];
    g.clearRect(0, 0, S, S);
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    const plate = (ox, oy, bg) => { g.fillStyle = bg; g.fillRect(ox, oy, C, C); };
    const poly = (ox, oy, n, rot, r, fill, stroke, lw) => {
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = rot + (i / n) * Math.PI * 2;
        const x = ox + C / 2 + Math.cos(a) * r, y = oy + C / 2 + Math.sin(a) * r;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      if (fill) { g.fillStyle = fill; g.fill(); }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
    };

    // 0 STOP
    let [ox, oy] = cell(0);
    plate(ox, oy, '#00000000');
    poly(ox, oy, 8, Math.PI / 8, C * 0.46, '#b0231f', '#f4f0e8', 7);
    g.fillStyle = '#f6f2ea'; g.font = `bold ${C * 0.30}px sans-serif`;
    g.fillText('STOP', ox + C / 2, oy + C / 2 + C * 0.015);

    // 1 YIELD
    [ox, oy] = cell(1);
    poly(ox, oy, 3, -Math.PI / 2, C * 0.5, '#f4f0e8', '#b0231f', C * 0.10);
    g.fillStyle = '#8e1c19'; g.font = `bold ${C * 0.15}px sans-serif`;
    g.fillText('YIELD', ox + C / 2, oy + C * 0.42);

    // 2 street-name plate (green)
    [ox, oy] = cell(2);
    plate(ox, oy, '#1d5136');
    g.strokeStyle = '#e8eee6'; g.lineWidth = 4; g.strokeRect(ox + 8, oy + C * 0.30, C - 16, C * 0.40);
    g.fillStyle = '#eef3ec'; g.font = `bold ${C * 0.17}px sans-serif`;
    g.fillText('MAPLE ST', ox + C / 2, oy + C * 0.50);

    // 3 no parking
    [ox, oy] = cell(3);
    poly(ox, oy, 40, 0, C * 0.42, '#f2eee6', '#b0231f', 12);
    g.strokeStyle = '#b0231f'; g.lineWidth = 14;
    g.beginPath(); g.moveTo(ox + C * 0.24, oy + C * 0.24); g.lineTo(ox + C * 0.76, oy + C * 0.76); g.stroke();
    g.fillStyle = '#25303a'; g.font = `bold ${C * 0.40}px sans-serif`;
    g.fillText('P', ox + C / 2, oy + C / 2);

    // 4 speed limit
    [ox, oy] = cell(4);
    plate(ox, oy, '#f3efe7');
    g.strokeStyle = '#2a2f34'; g.lineWidth = 8; g.strokeRect(ox + 12, oy + 12, C - 24, C - 24);
    g.fillStyle = '#23282d'; g.font = `bold ${C * 0.13}px sans-serif`;
    g.fillText('SPEED', ox + C / 2, oy + C * 0.26);
    g.fillText('LIMIT', ox + C / 2, oy + C * 0.40);
    g.font = `bold ${C * 0.34}px sans-serif`;
    g.fillText('30', ox + C / 2, oy + C * 0.66);

    // 5 one way
    [ox, oy] = cell(5);
    plate(ox, oy, '#20252b');
    g.fillStyle = '#eceff2';
    g.fillRect(ox + C * 0.14, oy + C * 0.46, C * 0.60, C * 0.08);
    g.beginPath();
    g.moveTo(ox + C * 0.88, oy + C * 0.50);
    g.lineTo(ox + C * 0.70, oy + C * 0.36);
    g.lineTo(ox + C * 0.70, oy + C * 0.64);
    g.closePath(); g.fill();
    g.font = `bold ${C * 0.13}px sans-serif`;
    g.fillText('ONE WAY', ox + C / 2, oy + C * 0.76);

    // 6 bus stop flag
    [ox, oy] = cell(6);
    plate(ox, oy, '#14456e');
    g.fillStyle = '#f0f4f7'; g.font = `bold ${C * 0.15}px sans-serif`;
    g.fillText('BUS', ox + C / 2, oy + C * 0.34);
    g.fillText('STOP', ox + C / 2, oy + C * 0.52);
    g.fillRect(ox + C * 0.26, oy + C * 0.64, C * 0.48, 5);

    // 7 pedestrian crossing (yellow diamond)
    [ox, oy] = cell(7);
    poly(ox, oy, 4, Math.PI / 4, C * 0.48, '#e8b81f', '#2a2f34', 8);
    g.fillStyle = '#20252b';
    g.beginPath(); g.arc(ox + C * 0.48, oy + C * 0.34, C * 0.055, 0, Math.PI * 2); g.fill();
    g.lineWidth = C * 0.05; g.strokeStyle = '#20252b';
    g.beginPath();
    g.moveTo(ox + C * 0.48, oy + C * 0.40); g.lineTo(ox + C * 0.46, oy + C * 0.58);
    g.moveTo(ox + C * 0.46, oy + C * 0.58); g.lineTo(ox + C * 0.38, oy + C * 0.72);
    g.moveTo(ox + C * 0.46, oy + C * 0.58); g.lineTo(ox + C * 0.58, oy + C * 0.70);
    g.moveTo(ox + C * 0.36, oy + C * 0.46); g.lineTo(ox + C * 0.60, oy + C * 0.44);
    g.stroke();

    // 8..11 shop fascias
    const shops = [
      ['#7a1f2b', 'DELI', '#f0e6d8'],
      ['#1c4b52', 'CAFÉ', '#f2ede2'],
      ['#2b3a52', 'BOOKS', '#e9e4d6'],
      ['#5a4327', 'BAKERY', '#f6efdd'],
    ];
    for (let i = 0; i < 4; i++) {
      [ox, oy] = cell(8 + i);
      plate(ox, oy, shops[i][0]);
      // weathering so a flat fascia is not a flat fill
      for (let j = 0; j < 900; j++) {
        const rx = ox + (h2(j, i, seed) * C), ry = oy + (h2(j, i + 40, seed) * C);
        g.fillStyle = `rgba(0,0,0,${0.02 + h2(j, i + 90, seed) * 0.05})`;
        g.fillRect(rx, ry, 3, 3);
      }
      g.fillStyle = shops[i][2];
      g.font = `bold ${C * 0.22}px Georgia, serif`;
      g.fillText(shops[i][1], ox + C / 2, oy + C / 2);
      g.fillRect(ox + C * 0.16, oy + C * 0.72, C * 0.68, 3);
    }

    // 12 A-board chalk menu
    [ox, oy] = cell(12);
    plate(ox, oy, '#242524');
    g.strokeStyle = '#6b5a3c'; g.lineWidth = 10; g.strokeRect(ox + 6, oy + 6, C - 12, C - 12);
    g.fillStyle = '#e8e2cf'; g.font = `italic ${C * 0.16}px Georgia, serif`;
    g.fillText('Today', ox + C / 2, oy + C * 0.28);
    g.font = `${C * 0.10}px Georgia, serif`;
    g.fillText('soup  ·  3.50', ox + C / 2, oy + C * 0.48);
    g.fillText('coffee  ·  2.20', ox + C / 2, oy + C * 0.62);
    g.fillText('cake  ·  4.00', ox + C / 2, oy + C * 0.76);

    // 13 hoarding / advertising
    [ox, oy] = cell(13);
    plate(ox, oy, '#d8d2c4');
    g.fillStyle = '#b23b2e'; g.fillRect(ox, oy + C * 0.18, C, C * 0.26);
    g.fillStyle = '#f3efe6'; g.font = `bold ${C * 0.14}px sans-serif`;
    g.fillText('METROPOLIS', ox + C / 2, oy + C * 0.31);
    g.fillStyle = '#4a5560'; g.font = `${C * 0.09}px sans-serif`;
    g.fillText('city of tomorrow', ox + C / 2, oy + C * 0.58);

    // 14 utility-cabinet door (grey with vents + notice)
    [ox, oy] = cell(14);
    plate(ox, oy, '#8f938d');
    for (let v = 0; v < 7; v++) {
      g.fillStyle = 'rgba(30,34,32,0.55)';
      g.fillRect(ox + C * 0.16, oy + C * 0.14 + v * C * 0.045, C * 0.68, C * 0.018);
    }
    g.fillStyle = '#e3c22a'; g.fillRect(ox + C * 0.34, oy + C * 0.58, C * 0.32, C * 0.20);
    g.fillStyle = '#2a2b28'; g.font = `bold ${C * 0.09}px sans-serif`;
    g.fillText('DANGER', ox + C / 2, oy + C * 0.68);

    // 15 licence-plate / misc white
    [ox, oy] = cell(15);
    plate(ox, oy, '#eceade');
    g.fillStyle = '#22303f'; g.font = `bold ${C * 0.22}px monospace`;
    g.fillText('MP 4471', ox + C / 2, oy + C / 2);
  }, { srgb: true, repeat: 1, wrap: THREE.ClampToEdgeWrapping });

  /* ---- radial light pool (additive ground gobo) ------------------------ */
  T.pool = assets.canvasTexture(key('pool'), 256, (g, S) => {
    px(g, S, (x, y) => {
      const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
      const r = Math.hypot(dx, dy);
      let a = Math.max(0, 1 - r);
      a = Math.pow(a, 2.6);
      // gentle speckle so the pool is not a perfect mathematical disc
      a *= 0.86 + 0.14 * fbm(x * 0.06, y * 0.06, seed + 5, 3);
      return [255, 232, 196, a * 255];
    });
  }, { srgb: true, repeat: 1, wrap: THREE.ClampToEdgeWrapping });

  /* ---- worn ground decal (tree pits, dirt patches, oil) ---------------- */
  T.dirt = assets.canvasTexture(key('dirt'), 256, (g, S) => {
    px(g, S, (x, y) => {
      const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
      const r = Math.hypot(dx, dy) * (0.82 + 0.34 * fbm(x * 0.05, y * 0.05, seed + 12, 3));
      const a = Math.max(0, 1 - Math.pow(r, 2.2));
      const n = fbm(x * 0.07, y * 0.07, seed + 27, 4);
      const l = 0.42 + n * 0.44;
      return [86 * l, 70 * l, 52 * l, a * 235];
    });
  }, { srgb: true, repeat: 1, wrap: THREE.ClampToEdgeWrapping });

  /* ---- gravel / hardstanding ------------------------------------------- */
  T.gravel = assets.canvasTexture(key('gravel'), 512, (g, S) => {
    px(g, S, (x, y) => {
      const c = fbm(x * 0.35, y * 0.35, seed + 44, 3);
      const big = fbm(x * 0.04, y * 0.04, seed + 45, 3);
      const l = 0.42 + c * 0.46 + big * 0.22;
      return [150 * l, 144 * l, 132 * l];
    });
  }, { srgb: true, repeat: 1 });

  /* ---- water (pools) ---------------------------------------------------- */
  T.waterN = assets.canvasTexture(key('waterN'), 256, (g, S) => {
    normalFromHeight(g, S, (x, y) =>
      Math.sin(x * 0.21 + fbm(x * 0.03, y * 0.03, seed + 2, 3) * 6) * 0.5
      + Math.sin(y * 0.17) * 0.4, 0.55);
  }, { srgb: false, repeat: 1 });

  return T;
}
