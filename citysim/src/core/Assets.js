import * as THREE from 'three';

/**
 * Cached, CC0-only asset access. Every loader degrades gracefully:
 * a 404 produces a warning + a procedural fallback, never a hard error.
 */
export class Assets {
  constructor(renderer, log) {
    this.renderer = renderer;
    this.log = log;
    this.textures = new Map();
    this.pending = new Map();
    this.manifest = null;
    this._texLoader = new THREE.TextureLoader();
    this._canvasCache = new Map();
  }

  async loadManifest(url = `${import.meta.env.BASE_URL}assets/MANIFEST.json`) {
    try {
      const r = await fetch(url);
      if (r.ok) this.manifest = await r.json();
    } catch { /* manifest optional in dev */ }
    return this.manifest;
  }

  /** Load a texture with sane colour-space + wrapping defaults. */
  texture(url, { srgb = false, repeat = 1, aniso = 8 } = {}) {
    const key = `${url}|${srgb}|${repeat}`;
    if (this.textures.has(key)) return this.textures.get(key);
    const tex = this._texLoader.load(
      url,
      (t) => {
        t.anisotropy = Math.min(aniso, this.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
        t.needsUpdate = true;
      },
      undefined,
      () => this.log?.warn?.(`texture missing, using fallback: ${url}`)
    );
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    this.textures.set(key, tex);
    return tex;
  }

  /**
   * Procedural canvas texture. `draw(ctx, size)` fills it.
   * Cached by key so repeated calls are free.
   */
  canvasTexture(key, size, draw, { srgb = true, repeat = 1, wrap = THREE.RepeatWrapping } = {}) {
    const ck = `${key}|${size}|${srgb}|${repeat}`;
    if (this._canvasCache.has(ck)) return this._canvasCache.get(ck);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    draw(ctx, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = wrap;
    tex.repeat.set(repeat, repeat);
    tex.anisotropy = Math.min(8, this.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
    tex.needsUpdate = true;
    this._canvasCache.set(ck, tex);
    return tex;
  }

  /** Data texture from a Float32/Uint8 buffer. */
  dataTexture(key, data, w, h, format = THREE.RGBAFormat, type = THREE.UnsignedByteType) {
    if (this._canvasCache.has(key)) return this._canvasCache.get(key);
    const t = new THREE.DataTexture(data, w, h, format, type);
    t.needsUpdate = true;
    this._canvasCache.set(key, t);
    return t;
  }

  dispose() {
    for (const t of this.textures.values()) t.dispose();
    for (const t of this._canvasCache.values()) t.dispose?.();
    this.textures.clear();
    this._canvasCache.clear();
  }
}

export default Assets;
