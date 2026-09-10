import * as THREE from 'three';

/**
 * Procedural road surface texture set.
 *
 * Everything here is generated in-repo (CC0 policy option 3): no downloads, no
 * `/assets/` references. Deterministic — driven by integer hashes, never Math.random.
 *
 * Produced maps
 *   asphalt  : albedo (patches, tar seams, oil, aggregate) + normal + roughness
 *   concrete : albedo (panel joints, aggregate, staining) + normal + roughness
 *   markings : 1024 x 2048 atlas, 8 horizontal bands. X = ACROSS the road,
 *              Y = ALONG the road. Both axes ClampToEdge; the mesh builder emits
 *              duplicated rings at band-cycle boundaries so no quad ever wraps.
 *   decals   : 512 x 256 atlas — left half manhole cover, right half drain grating.
 */

/* ------------------------------------------------------------------ noise -- */

function hash2(ix, iy, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise that tiles exactly over `period` lattice cells. */
function pnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const p = period | 0;
  const wrap = (a) => ((a % p) + p) % p;
  const x0 = wrap(xi), x1 = wrap(xi + 1), y0 = wrap(yi), y1 = wrap(yi + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Tiling fbm. u,v in [0,1). Returns [0,1]. */
function pfbm(u, v, basePeriod, octaves, seed, gain = 0.5) {
  let amp = 1, sum = 0, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    const p = basePeriod * f;
    sum += amp * pnoise(u * p, v * p, p, seed + o * 1319);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/* --------------------------------------------------------------- plumbing -- */

function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toTexture(canvas, { srgb = false, wrapS = THREE.RepeatWrapping, wrapT = THREE.RepeatWrapping, aniso = 8, renderer = null, flipY = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.flipY = flipY;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = wrapS; t.wrapT = wrapT;
  t.anisotropy = Math.min(aniso, renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Sobel a height field into a tangent-space normal map canvas. */
function heightToNormal(height, S, strength) {
  const c = mkCanvas(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;
  const at = (x, y) => height[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const i = (y * S + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Run `fn` nine times so canvas strokes wrap seamlessly across the tile edge. */
function wrapDraw(g, S, fn) {
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      g.save();
      g.translate(ox * S, oy * S);
      fn(g);
      g.restore();
    }
  }
}

/* --------------------------------------------------------------- asphalt --- */

function buildAsphalt(S, seed) {
  let h = seed;
  const rnd = () => { h = (Math.imul(h ^ (h >>> 15), 2246822519) + 3266489917) | 0; return ((h >>> 8) & 0xffffff) / 0xffffff; };

  // 1. repair patches. Few, small, hard-ish edged — a resurfaced strip reads as
  //    a slightly different asphalt mix, never as a bleached blob.
  const pc = mkCanvas(S, S);
  const pg = pc.getContext('2d');
  pg.fillStyle = '#000'; pg.fillRect(0, 0, S, S);
  for (let i = 0; i < 4; i++) {
    const cx = rnd() * S, cy = rnd() * S;
    const w = S * (0.07 + rnd() * 0.15), hh = S * (0.05 + rnd() * 0.13);
    const tone = 0.55 + rnd() * 0.45;
    wrapDraw(pg, S, (g) => {
      g.translate(cx, cy);
      g.rotate((rnd() - 0.5) * 0.25);
      g.fillStyle = `rgba(255,255,255,${tone.toFixed(3)})`;
      const steps = 16;
      for (let s = 0; s < steps; s++) {
        const t = s / (steps - 1);
        const jx = (pnoise(t * 9 + i * 13, 0.5, 64, seed + 7) - 0.5) * w * 0.10;
        g.fillRect(-w / 2 + jx, -hh / 2 + (hh / steps) * s, w, hh / steps + 1);
      }
    });
  }
  pg.filter = 'blur(1.2px)';
  pg.drawImage(pc, 0, 0);
  pg.filter = 'none';
  const patch = pg.getImageData(0, 0, S, S).data;

  // 2. tar seams (a handful of long ones) plus a few hairline cracks
  const sc = mkCanvas(S, S);
  const sg = sc.getContext('2d');
  sg.fillStyle = '#000'; sg.fillRect(0, 0, S, S);
  sg.lineCap = 'round';
  const stroke = (count, wMin, wMax, brightMin, brightMax, wobble, salt) => {
    for (let i = 0; i < count; i++) {
      const vertical = rnd() < 0.5;
      const base = rnd() * S;
      const width = wMin + rnd() * (wMax - wMin);
      const bright = brightMin + rnd() * (brightMax - brightMin);
      wrapDraw(sg, S, (g) => {
        g.strokeStyle = `rgba(255,255,255,${bright.toFixed(3)})`;
        g.lineWidth = width;
        g.beginPath();
        const N = 30;
        for (let k = 0; k <= N; k++) {
          const t = k / N;
          const wob = (pfbm(t * 1.6, i * 0.41, 5, 3, seed + salt) - 0.5) * S * wobble;
          const x = vertical ? base + wob : t * S;
          const y = vertical ? t * S : base + wob;
          if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      });
    }
  };
  stroke(4, 1.6, 3.4, 0.55, 1.0, 0.07, 41);    // tar seams
  stroke(7, 0.7, 1.3, 0.30, 0.62, 0.13, 67);   // hairline cracks
  const seams = sg.getImageData(0, 0, S, S).data;

  // 3. compose albedo + height + roughness
  const albC = mkCanvas(S, S);
  const ag = albC.getContext('2d');
  const albImg = ag.createImageData(S, S);
  const A = albImg.data;
  const height = new Float32Array(S * S);
  const rough = new Uint8ClampedArray(S * S * 4);

  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const i = y * S + x;
      const i4 = i * 4;

      const chip = pnoise(u * 210, v * 210, 210, seed + 71);   // individual aggregate
      const grain = pfbm(u, v, 64, 3, seed + 3);               // clumping of chip
      const meso = pfbm(u, v, 10, 3, seed + 17);               // mottling
      const macro = pfbm(u, v, 3, 2, seed + 29);               // large tonal drift
      const pm = patch[i4] / 255;
      const sm = seams[i4] / 255;
      const oil = Math.max(0, pfbm(u, v, 5, 3, seed + 55) - 0.66) * 3.0;

      // These are sRGB-ENCODED values: weathered asphalt reads around 0.35 on
      // screen (~0.10 linear), not the 0.11 you get if you author the linear
      // number into an sRGB texture by mistake.
      let l = 0.296
        + (chip - 0.5) * 0.058
        + (grain - 0.5) * 0.050
        + (meso - 0.5) * 0.048
        + (macro - 0.5) * 0.040;
      // resurfaced patches: a darker, fresher, bluer mix with a defined edge
      l = l * (1 - pm * 0.55) + pm * (0.238 + (chip - 0.5) * 0.048);
      // tar seams and cracks are near-black
      l = l * (1 - sm * 0.70) + sm * 0.120;
      // oil staining
      l *= 1 - oil * 0.24;

      let r = l * 0.985, gch = l * 1.0, b = l * 1.05;    // faintly blue-grey
      if (pm > 0.2) { r *= 0.98; b *= 1.03; }

      A[i4] = Math.min(255, Math.max(0, r * 255));
      A[i4 + 1] = Math.min(255, Math.max(0, gch * 255));
      A[i4 + 2] = Math.min(255, Math.max(0, b * 255));
      A[i4 + 3] = 255;

      // height: individual chips stand proud, tar seams sit slightly raised,
      // hairline cracks bite in
      height[i] = chip * 0.62 + grain * 0.30 + (meso - 0.5) * 0.20 + sm * 0.55;

      // roughness: coarse asphalt is rough; tar + oil are smooth
      const rr = 0.86 + (chip - 0.5) * 0.20 + (meso - 0.5) * 0.10 - sm * 0.48 - oil * 0.32 + pm * 0.04;
      const q = Math.min(255, Math.max(0, rr * 255));
      rough[i4] = q; rough[i4 + 1] = q; rough[i4 + 2] = q; rough[i4 + 3] = 255;
    }
  }
  ag.putImageData(albImg, 0, 0);

  const roughC = mkCanvas(S, S);
  const rg = roughC.getContext('2d');
  const rImg = rg.createImageData(S, S);
  rImg.data.set(rough);
  rg.putImageData(rImg, 0, 0);

  return { albedo: albC, normal: heightToNormal(height, S, 1.05), rough: roughC };
}

/* -------------------------------------------------------------- concrete --- */

function buildConcrete(S, seed) {
  const albC = mkCanvas(S, S);
  const ag = albC.getContext('2d');
  const img = ag.createImageData(S, S);
  const A = img.data;
  const height = new Float32Array(S * S);
  const rough = new Uint8ClampedArray(S * S * 4);

  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const i = y * S + x, i4 = i * 4;
      const grain = pfbm(u, v, 110, 3, seed + 5);
      const meso = pfbm(u, v, 14, 3, seed + 21);
      const macro = pfbm(u, v, 4, 2, seed + 37);
      const stain = Math.max(0, pfbm(u, v, 7, 4, seed + 61) - 0.55) * 2.0;

      // sRGB-encoded: pavement concrete sits around 0.55 on screen
      let l = 0.472 + (grain - 0.5) * 0.115 + (meso - 0.5) * 0.085 + (macro - 0.5) * 0.070;
      l *= 1 - stain * 0.20;

      A[i4] = Math.min(255, l * 255 * 1.00);
      A[i4 + 1] = Math.min(255, l * 255 * 0.985);
      A[i4 + 2] = Math.min(255, l * 255 * 0.945);
      A[i4 + 3] = 255;

      height[i] = grain * 0.8 + (meso - 0.5) * 0.4;
      const rr = 0.86 + (grain - 0.5) * 0.16 - stain * 0.10;
      const q = Math.min(255, Math.max(0, rr * 255));
      rough[i4] = q; rough[i4 + 1] = q; rough[i4 + 2] = q; rough[i4 + 3] = 255;
    }
  }
  ag.putImageData(img, 0, 0);

  // sawn control joints — a 4 m tile with a joint every 2 m reads as slab paving
  ag.strokeStyle = 'rgba(30,28,25,0.55)';
  ag.lineWidth = 2.2;
  for (const p of [0, 0.5]) {
    ag.beginPath(); ag.moveTo(p * S, 0); ag.lineTo(p * S, S); ag.stroke();
    ag.beginPath(); ag.moveTo(0, p * S); ag.lineTo(S, p * S); ag.stroke();
  }
  // engrave the joints into the height field too
  for (const p of [0, 0.5]) {
    const c0 = Math.round(p * S);
    for (let k = -1; k <= 1; k++) {
      const c = ((c0 + k) % S + S) % S;
      const w = k === 0 ? 0.55 : 0.25;
      for (let t = 0; t < S; t++) { height[t * S + c] -= w; height[c * S + t] -= w; }
    }
  }

  const roughC = mkCanvas(S, S);
  const rg = roughC.getContext('2d');
  const rImg = rg.createImageData(S, S);
  rImg.data.set(rough);
  rg.putImageData(rImg, 0, 0);

  return { albedo: albC, normal: heightToNormal(height, S, 1.5), rough: roughC };
}


/* ----------------------------------------------------------------- verge --- */

/**
 * Roadside verge: scrubby turf over compacted soil, with bare patches and
 * small stones. Used for the graded shoulder that ties a road standing proud
 * of the terrain back down into it.
 */
function buildVerge(S, seed) {
  const albC = mkCanvas(S, S);
  const ag = albC.getContext('2d');
  const img = ag.createImageData(S, S);
  const A = img.data;
  const height = new Float32Array(S * S);
  const rough = new Uint8ClampedArray(S * S * 4);

  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const i = y * S + x, i4 = i * 4;

      const blade = pfbm(u, v, 170, 2, seed + 13);       // blade-scale break-up
      const clump = pfbm(u, v, 31, 3, seed + 47);        // tufts
      const macro = pfbm(u, v, 5, 2, seed + 91);         // wet/dry drift

      /* R-terr-1 / critic N2. The old `bare` mask was
       *   smooth01(pfbm(u, v, 9, 3), 0.54, 0.74)
       * — a SINGLE lattice period, which is exactly "blobs at one scale,
       * tiling visibly". Three periods that share no common factor, combined
       * multiplicatively, give a mask with no dominant scale. The threshold is
       * also raised so bare ground is the exception rather than half the tile.
       */
      const b1 = pfbm(u, v, 7, 2, seed + 133);
      const b2 = pfbm(u, v, 19, 2, seed + 181);
      const b3 = pfbm(u, v, 53, 2, seed + 227);
      const bare = smooth01(b1 * 0.45 + b2 * 0.34 + b3 * 0.21, 0.545, 0.78) * 0.82;

      // Living turf.
      const gl = 0.352 + (blade - 0.5) * 0.20 + (clump - 0.5) * 0.17 + (macro - 0.5) * 0.12;
      const gr = gl * 0.78, gg = gl * 1.06, gb = gl * 0.55;

      /* Where the grass thins it goes to DRY grass, not to pink soil. The old
       * soil was R:G:B 1.06:0.93:0.58 — R-G positive, which the effects grade
       * then saturates into the salmon mottle the critic measured (8.0% ->
       * 26.9% pink pixels). Khaki keeps R and G within a couple of percent of
       * each other, so nothing downstream can pull it toward magenta.
       */
      const sl = 0.330 + (blade - 0.5) * 0.13 + (clump - 0.5) * 0.11;
      const sr = sl * 0.985, sg2 = sl * 0.965, sb = sl * 0.60;

      const k = 1 - bare;
      A[i4] = Math.min(255, Math.max(0, (gr * k + sr * bare) * 255));
      A[i4 + 1] = Math.min(255, Math.max(0, (gg * k + sg2 * bare) * 255));
      A[i4 + 2] = Math.min(255, Math.max(0, (gb * k + sb * bare) * 255));
      A[i4 + 3] = 255;

      height[i] = clump * 0.9 + blade * 0.5;
      const rr = 0.94 - bare * 0.05 + (clump - 0.5) * 0.05;
      const q = Math.min(255, Math.max(0, rr * 255));
      rough[i4] = q; rough[i4 + 1] = q; rough[i4 + 2] = q; rough[i4 + 3] = 255;
    }
  }
  ag.putImageData(img, 0, 0);

  const roughC = mkCanvas(S, S);
  const rg = roughC.getContext('2d');
  const rImg = rg.createImageData(S, S);
  rImg.data.set(rough);
  rg.putImageData(rImg, 0, 0);

  return { albedo: albC, normal: heightToNormal(height, S, 1.35), rough: roughC };
}

function smooth01(x, e0, e1) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/* -------------------------------------------------------------- markings --- */


export const MARK_W = 1024;
export const MARK_H = 2048;
export const BANDS = 8;
const BH = MARK_H / BANDS;   // 256 px per band

/**
 * Band table. `along` is how many metres the band's 256 px represents.
 * `across` is how many metres its 1024 px represents — `null` means
 * "normalised to the road width" (the line-pattern bands).
 */
export const BAND = {
  alley:     { i: 0, along: 12, across: null },
  lane2:     { i: 1, along: 12, across: null },
  lane4:     { i: 2, along: 12, across: null },
  boulevard: { i: 3, along: 12, across: null },
  highway:   { i: 4, along: 14, across: null },
  crosswalk: { i: 5, along: 4.5, across: 28 },
  stopbar:   { i: 6, along: 1.2, across: 20 },
  arrows:    { i: 7, along: 4.0, across: 10.5 },   // three 3.5 m glyph columns
};

const WHITE = 'rgba(232,233,230,1)';
const YELLOW = 'rgba(226,178,58,1)';

function buildMarkings(seed) {
  const c = mkCanvas(MARK_W, MARK_H);
  const g = c.getContext('2d');
  g.clearRect(0, 0, MARK_W, MARK_H);

  /** helper: draw inside band b with a local coordinate system */
  const band = (b, fn) => { g.save(); g.translate(0, b * BH); g.beginPath(); g.rect(0, 0, MARK_W, BH); g.clip(); fn(g); g.restore(); };

  /** longitudinal line: f = across fraction 0..1, wM = line width in metres, W = road width */
  const line = (g2, f, wM, W, color, dashOnM = 0, dashOffM = 0, alongM = 12) => {
    const px = (wM / W) * MARK_W;
    const x = f * MARK_W - px / 2;
    g2.fillStyle = color;
    if (dashOnM <= 0) { g2.fillRect(x, -2, px, BH + 4); return; }
    const pxPerM = BH / alongM;
    const cyc = (dashOnM + dashOffM) * pxPerM;
    for (let y = -cyc; y < BH + cyc; y += cyc) g2.fillRect(x, y, px, dashOnM * pxPerM);
  };

  // --- band 0: alley — no markings, just a faint worn crown of tyre polish -----
  // (left empty on purpose; wheel polish is a vertex attribute, not paint)

  // --- band 1: lane2 (W = 9 m) ------------------------------------------------
  band(BAND.lane2.i, (g2) => {
    const W = 9;
    line(g2, 0.55 / W, 0.16, W, WHITE);
    line(g2, 1 - 0.55 / W, 0.16, W, WHITE);
    line(g2, 0.5, 0.15, W, WHITE, 3, 3, 12);
  });

  // --- band 2: lane4 (W = 16 m) ----------------------------------------------
  band(BAND.lane4.i, (g2) => {
    const W = 16;
    line(g2, 0.5 / W, 0.17, W, WHITE);
    line(g2, 1 - 0.5 / W, 0.17, W, WHITE);
    line(g2, 0.5 - 0.19 / W, 0.14, W, YELLOW);
    line(g2, 0.5 + 0.19 / W, 0.14, W, YELLOW);
    line(g2, 0.25, 0.14, W, WHITE, 3, 4.5, 12);
    line(g2, 0.75, 0.14, W, WHITE, 3, 4.5, 12);
  });

  // --- band 3: boulevard (W = 24 m, 4 m painted median) ----------------------
  band(BAND.boulevard.i, (g2) => {
    const W = 24;
    const m0 = (W / 2 - 2) / W, m1 = (W / 2 + 2) / W;
    line(g2, 0.5 / W, 0.17, W, WHITE);
    line(g2, 1 - 0.5 / W, 0.17, W, WHITE);
    line(g2, m0, 0.16, W, YELLOW);
    line(g2, m1, 0.16, W, YELLOW);
    /* No chevron hatching: the boulevard median is a RAISED kerbed island now,
     * not paint, and the markings layer is polygon-offset toward the camera so
     * anything drawn here bleeds through the island that occludes it. */
    line(g2, (W / 2 - 7) / W, 0.14, W, WHITE, 3, 4.5, 12);
    line(g2, (W / 2 + 7) / W, 0.14, W, WHITE, 3, 4.5, 12);
  });

  // --- band 4: highway (W = 22 m, 4 lanes + shoulders) ----------------------
  band(BAND.highway.i, (g2) => {
    const W = 22, along = 14;
    line(g2, 0.65 / W, 0.22, W, WHITE);
    line(g2, 1 - 0.65 / W, 0.22, W, WHITE);
    line(g2, 0.5 - 0.22 / W, 0.16, W, YELLOW);
    line(g2, 0.5 + 0.22 / W, 0.16, W, YELLOW);
    line(g2, 0.25, 0.16, W, WHITE, 4, 8, along);
    line(g2, 0.75, 0.16, W, WHITE, 4, 8, along);
  });

  // --- band 5: crosswalk zebra (metric: 20 m across, 4.5 m deep) -------------
  band(BAND.crosswalk.i, (g2) => {
    const across = BAND.crosswalk.across;
    const pxPerM = MARK_W / across;
    const barW = 0.62 * pxPerM, pitch = 1.0 * pxPerM;
    g2.fillStyle = WHITE;
    for (let x = pitch * 0.2; x < MARK_W; x += pitch) g2.fillRect(x, 6, barW, BH - 12);
  });

  // --- band 6: stop bar ------------------------------------------------------
  band(BAND.stopbar.i, (g2) => {
    g2.fillStyle = WHITE;
    g2.fillRect(0, BH * 0.16, MARK_W, BH * 0.68);
  });

  // --- band 7: turn arrows (3 columns: straight, left, right) ---------------
  band(BAND.arrows.i, (g2) => {
    const colW = MARK_W / 3;
    const drawArrow = (cx, kind) => {
      const s = colW * 0.30;               // shaft half-width scale
      const yTip = BH * 0.10, yTail = BH * 0.92;
      g2.fillStyle = WHITE;
      // shaft
      g2.fillRect(cx - s * 0.20, yTip + s * 0.75, s * 0.40, yTail - yTip - s * 0.75);
      // head
      g2.beginPath();
      g2.moveTo(cx, yTip);
      g2.lineTo(cx + s * 0.62, yTip + s * 0.95);
      g2.lineTo(cx + s * 0.20, yTip + s * 0.95);
      g2.lineTo(cx + s * 0.20, yTip + s * 1.15);
      g2.lineTo(cx - s * 0.20, yTip + s * 1.15);
      g2.lineTo(cx - s * 0.20, yTip + s * 0.95);
      g2.lineTo(cx - s * 0.62, yTip + s * 0.95);
      g2.closePath();
      g2.fill();
      if (kind !== 0) {
        // hooked branch peeling off the shaft
        const dir = kind;                   // -1 left, +1 right
        const bx = cx + dir * s * 0.95, by = BH * 0.42;
        g2.save();
        g2.strokeStyle = WHITE;
        g2.lineWidth = s * 0.40;
        g2.lineCap = 'butt';
        g2.beginPath();
        g2.moveTo(cx, BH * 0.66);
        g2.quadraticCurveTo(cx + dir * s * 0.9, BH * 0.62, bx, by);
        g2.stroke();
        g2.restore();
        g2.beginPath();
        g2.moveTo(bx + dir * s * 0.42, by - s * 0.02);
        g2.lineTo(bx - dir * s * 0.05, by - s * 0.50);
        g2.lineTo(bx - dir * s * 0.05, by + s * 0.46);
        g2.closePath();
        g2.fill();
      }
    };
    drawArrow(colW * 0.5, 0);
    drawArrow(colW * 1.5, -1);
    drawArrow(colW * 2.5, +1);
  });

  // --- wear pass: erode every marking with tiling noise so paint looks used --
  const wear = mkCanvas(256, 256);
  const wg = wear.getContext('2d');
  const wImg = wg.createImageData(256, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const n = pfbm(x / 256, y / 256, 26, 4, seed + 91);
      const a = Math.max(0, n - 0.46) * 340;
      const i = (y * 256 + x) * 4;
      wImg.data[i] = wImg.data[i + 1] = wImg.data[i + 2] = 255;
      wImg.data[i + 3] = Math.min(190, a);
    }
  }
  wg.putImageData(wImg, 0, 0);
  g.save();
  g.globalCompositeOperation = 'destination-out';
  g.globalAlpha = 0.55;
  const pat = g.createPattern(wear, 'repeat');
  g.fillStyle = pat;
  g.fillRect(0, 0, MARK_W, MARK_H);
  g.restore();

  return c;
}

/* ---------------------------------------------------------------- decals --- */

function buildDecals(seed) {
  const W = 512, H = 256;
  const c = mkCanvas(W, H);
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);

  // --- left half: cast-iron manhole cover ---
  const cx = 128, cy = 128, R = 116;
  const grd = g.createRadialGradient(cx - 30, cy - 34, 10, cx, cy, R);
  grd.addColorStop(0, '#4a463f');
  grd.addColorStop(0.7, '#3a3730');
  grd.addColorStop(1, '#2a2822');
  g.fillStyle = grd;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(20,19,16,0.85)'; g.lineWidth = 7;
  g.beginPath(); g.arc(cx, cy, R - 4, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = 'rgba(96,90,78,0.55)'; g.lineWidth = 3;
  g.beginPath(); g.arc(cx, cy, R - 16, 0, Math.PI * 2); g.stroke();
  // radial rib pattern
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    g.strokeStyle = i % 2 ? 'rgba(112,105,92,0.42)' : 'rgba(26,24,20,0.55)';
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * (R * 0.30), cy + Math.sin(a) * (R * 0.30));
    g.lineTo(cx + Math.cos(a) * (R * 0.84), cy + Math.sin(a) * (R * 0.84));
    g.stroke();
  }
  g.fillStyle = 'rgba(30,28,24,0.75)';
  g.beginPath(); g.arc(cx, cy, R * 0.26, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(120,112,98,0.5)'; g.lineWidth = 3;
  g.beginPath(); g.arc(cx, cy, R * 0.26, 0, Math.PI * 2); g.stroke();

  // --- right half: kerbside drain grating ---
  g.save();
  g.translate(256, 0);
  g.fillStyle = '#39362f';
  g.fillRect(18, 46, 220, 164);
  g.strokeStyle = 'rgba(20,19,16,0.9)'; g.lineWidth = 9;
  g.strokeRect(18, 46, 220, 164);
  g.fillStyle = 'rgba(10,10,9,0.94)';
  for (let i = 0; i < 7; i++) g.fillRect(34, 62 + i * 22, 188, 12);
  g.strokeStyle = 'rgba(108,101,88,0.45)'; g.lineWidth = 3;
  g.strokeRect(26, 54, 204, 148);
  g.restore();

  // grime dusting over everything
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] < 8) continue;
      const n = pfbm(x / W, y / H, 30, 3, seed + 77);
      const k = 0.82 + n * 0.34;
      d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------------- api --- */

/**
 * Build (and memoise) the whole texture set.
 * `renderer` is only used to pick a sane anisotropy level.
 */
export function roadTextures(renderer, seed = 1337, quality = 'high') {
  const key = `roads:tex:${seed}:${quality}`;
  if (cacheStore.has(key)) return cacheStore.get(key);

  const S = quality === 'low' ? 256 : 512;
  const asp = buildAsphalt(S, seed >>> 0);
  const con = buildConcrete(S, (seed ^ 0x9e3779b9) >>> 0);
  const mk = buildMarkings((seed ^ 0x5bf03635) >>> 0);
  const dc = buildDecals((seed ^ 0x2545f491) >>> 0);
  const vg = buildVerge(S, (seed ^ 0x27d4eb2f) >>> 0);

  const out = {
    asphaltMap: toTexture(asp.albedo, { srgb: true, renderer }),
    asphaltNormal: toTexture(asp.normal, { renderer }),
    asphaltRough: toTexture(asp.rough, { renderer }),
    concreteMap: toTexture(con.albedo, { srgb: true, renderer }),
    concreteNormal: toTexture(con.normal, { renderer }),
    concreteRough: toTexture(con.rough, { renderer }),
    vergeMap: toTexture(vg.albedo, { srgb: true, renderer }),
    vergeNormal: toTexture(vg.normal, { renderer }),
    vergeRough: toTexture(vg.rough, { renderer }),
    // flipY = false so canvas pixel (x,y) maps straight to uv (x/W, y/H):
    // band b then occupies v in [b/8, (b+1)/8) exactly as it was drawn.
    markings: toTexture(mk, {
      srgb: true, renderer, aniso: 16, flipY: false,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    }),
    decals: toTexture(dc, {
      srgb: true, renderer, aniso: 8, flipY: false,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    }),
    /** metres covered by one tile of the asphalt/concrete maps */
    asphaltTile: 8,
    concreteTile: 4,
    vergeTile: 4.5,
    dispose() {
      for (const k of Object.keys(out)) if (out[k] && out[k].isTexture) out[k].dispose();
      cacheStore.delete(key);
    },
  };
  cacheStore.set(key, out);
  return out;
}

const cacheStore = new Map();

export default roadTextures;
