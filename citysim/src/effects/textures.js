import * as THREE from 'three';

/**
 * Procedural textures for the effects showcase block. Everything is drawn to a
 * canvas in-repo — no downloads (the egress proxy blocks the CC0 hosts) and no
 * flat primaries anywhere.
 */

/** Deterministic value noise on a canvas, used as a base for grime and grain. */
function noiseField(rng, size, octaves = 4) {
  const n = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = 4 << o;
    const grid = new Float32Array((cells + 1) * (cells + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
    const step = size / cells;
    for (let y = 0; y < size; y++) {
      const gy = y / step, y0 = Math.floor(gy), fy = gy - y0;
      const sy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < size; x++) {
        const gx = x / step, x0 = Math.floor(gx), fx = gx - x0;
        const sx = fx * fx * (3 - 2 * fx);
        const a = grid[y0 * (cells + 1) + x0], b = grid[y0 * (cells + 1) + x0 + 1];
        const c = grid[(y0 + 1) * (cells + 1) + x0], d = grid[(y0 + 1) * (cells + 1) + x0 + 1];
        n[y * size + x] += amp * ((a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < n.length; i++) n[i] /= total;
  return n;
}

/** Height field -> tangent-space normal map. */
function normalFromHeight(h, size, strength = 2.2) {
  const out = new Uint8Array(size * size * 4);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

export function asphaltSet(ctx, rng) {
  const S = 256;
  const n = noiseField(rng, S, 5);
  const grain = noiseField(rng, S, 6);

  const albedo = ctx.assets.canvasTexture('fx:asphalt', S, (c) => {
    const img = c.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const v = n[i], g = grain[i];
      // dark bituminous base, aggregate speckle, occasional lighter patch
      let l = 0.105 + v * 0.055 + (g > 0.72 ? (g - 0.72) * 0.60 : 0);
      if (v > 0.74) l += (v - 0.74) * 0.30;
      // real asphalt is a neutral-to-warm grey; a very dark albedo makes the
      // sky IBL dominate and the road reads electric blue at noon
      const r = l * 255 * 1.04, gg = l * 255 * 1.0, b = l * 255 * 0.93;
      img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }, { srgb: true, repeat: 1 });

  const nrmData = normalFromHeight(grain, S, 3.0);
  const normal = ctx.assets.dataTexture('fx:asphaltN', nrmData, S, S);
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  normal.colorSpace = THREE.NoColorSpace;
  normal.needsUpdate = true;

  const rough = ctx.assets.canvasTexture('fx:asphaltR', S, (c) => {
    const img = c.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const v = 0.72 + n[i] * 0.22 + (grain[i] - 0.5) * 0.10;
      const b = Math.max(0, Math.min(255, v * 255));
      img.data[i * 4] = b; img.data[i * 4 + 1] = b; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }, { srgb: false });

  return { albedo, normal, rough };
}

export function concreteSet(ctx, rng) {
  const S = 256;
  const n = noiseField(rng, S, 5);
  const albedo = ctx.assets.canvasTexture('fx:conc', S, (c) => {
    const img = c.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const v = n[i];
      const l = 0.225 + v * 0.085;
      img.data[i * 4] = l * 255 * 1.0;
      img.data[i * 4 + 1] = l * 255 * 0.99;
      img.data[i * 4 + 2] = l * 255 * 0.95;
      img.data[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    // slab joints
    c.strokeStyle = 'rgba(0,0,0,0.28)';
    c.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      const p = (i / 4) * S;
      c.beginPath(); c.moveTo(p, 0); c.lineTo(p, S); c.stroke();
      c.beginPath(); c.moveTo(0, p); c.lineTo(S, p); c.stroke();
    }
  }, { srgb: true });
  const normal = ctx.assets.dataTexture('fx:concN', normalFromHeight(n, S, 1.4), S, S);
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  normal.colorSpace = THREE.NoColorSpace;
  normal.needsUpdate = true;
  return { albedo, normal };
}

/**
 * Facade albedo + matching window emissive mask.
 * One tile = 4×4 window bays, so the geometry UVs can be authored in bays and a
 * single material serves every building in the block.
 */
export function facadeSet(ctx, rng) {
  const S = 512, BAYS = 4, cell = S / BAYS;
  const lit = [];
  for (let i = 0; i < BAYS * BAYS; i++) lit.push(rng.next());

  const albedo = ctx.assets.canvasTexture('fx:facade', S, (c) => {
    const g = c.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, '#54585d');
    g.addColorStop(1, '#484c51');
    c.fillStyle = g; c.fillRect(0, 0, S, S);
    // panel grain
    for (let i = 0; i < 2600; i++) {
      const x = rng.next() * S, y = rng.next() * S;
      c.fillStyle = `rgba(${20 + rng.next() * 60 | 0},${20 + rng.next() * 60 | 0},${24 + rng.next() * 60 | 0},0.06)`;
      c.fillRect(x, y, 1 + rng.next() * 3, 1 + rng.next() * 2);
    }
    for (let j = 0; j < BAYS; j++) {
      for (let i = 0; i < BAYS; i++) {
        const x = i * cell, y = j * cell;
        // spandrel band under each window
        c.fillStyle = 'rgba(28,30,34,0.55)';
        c.fillRect(x + cell * 0.06, y + cell * 0.70, cell * 0.88, cell * 0.20);
        // glazing: dark, slightly blue, with a reveal shadow at the head
        c.fillStyle = '#161c24';
        c.fillRect(x + cell * 0.16, y + cell * 0.14, cell * 0.68, cell * 0.52);
        c.fillStyle = 'rgba(0,0,0,0.55)';
        c.fillRect(x + cell * 0.16, y + cell * 0.14, cell * 0.68, cell * 0.09);
        c.fillStyle = 'rgba(120,140,160,0.10)';
        c.fillRect(x + cell * 0.16, y + cell * 0.23, cell * 0.30, cell * 0.30);
        // mullion
        c.fillStyle = 'rgba(30,32,36,0.9)';
        c.fillRect(x + cell * 0.49, y + cell * 0.14, cell * 0.02, cell * 0.52);
      }
    }
  }, { srgb: true });

  const windows = ctx.assets.canvasTexture('fx:windowsE', S, (c) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, S, S);
    for (let j = 0; j < BAYS; j++) {
      for (let i = 0; i < BAYS; i++) {
        const k = lit[j * BAYS + i];
        if (k < 0.42) continue;                    // dark flat
        const warm = 0.55 + rng.next() * 0.45;
        const r = 255, g = 190 + warm * 45, b = 120 + warm * 90;
        const a = 0.30 + (k - 0.42) * 1.15;
        const x = i * cell, y = j * cell;
        c.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${Math.min(1, a).toFixed(3)})`;
        c.fillRect(x + cell * 0.16, y + cell * 0.14, cell * 0.68, cell * 0.52);
        // a brighter sill where the ceiling light pools
        c.fillStyle = `rgba(255,${(g + 20) | 0},${(b + 30) | 0},${Math.min(1, a * 1.25).toFixed(3)})`;
        c.fillRect(x + cell * 0.16, y + cell * 0.14, cell * 0.68, cell * 0.14);
      }
    }
  }, { srgb: true });

  return { albedo, windows, bays: BAYS };
}

/** Soft radial falloff — lamp glows, light pools, neon tube cores. */
export function glowTexture(ctx) {
  return ctx.assets.canvasTexture('fx:glow', 128, (c, S) => {
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.22, 'rgba(255,255,255,0.72)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.20)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, S, S);
  }, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
}

export default { asphaltSet, concreteSet, facadeSet, glowTexture };
