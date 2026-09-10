import * as THREE from 'three';

/**
 * Shared PBR material factory + cache.
 * Rule of the project: colours are authored in **linear-correct sRGB hex**, roughness and
 * metalness are physically motivated, and nothing is ever `MeshBasicMaterial` unless it is
 * genuinely emissive-only (window lights, signage).
 */
export class Materials {
  constructor(renderer, assets, log) {
    this.renderer = renderer;
    this.assets = assets;
    this.log = log;
    this.cache = new Map();
    this.all = new Set();

    /**
     * R-env-5 / R-2 / R-props-1 / R-1 — the single core-owned `onBeforeCompile` chain.
     * Three modules already patch materials independently and the next one would collide.
     * Patches run in registration order, compose with a material's own hook, cover
     * materials created later, and can opt into the depth pass so a patch that moves
     * vertices (wind sway, LOD collapse) also moves the shadow it casts.
     */
    this.patches = [];
    /** Uniforms shared BY REFERENCE with every patched material. */
    this.globalUniforms = {};
  }

  /* ------------------------- shader patch chain ------------------------- */

  /**
   * `fn(shader, material, renderer)` — mutate `shader.vertexShader` /
   * `shader.fragmentShader` / `shader.uniforms` in place.
   * `opts.depth` also applies the patch to depth/distance materials.
   */
  registerShaderPatch(name, fn, opts = {}) {
    if (typeof fn !== 'function') throw new Error('registerShaderPatch needs a function');
    const existing = this.patches.findIndex((p) => p.name === name);
    const entry = { name, fn, depth: !!opts.depth, order: opts.order ?? 0 };
    if (existing >= 0) this.patches[existing] = entry;
    else this.patches.push(entry);
    this.patches.sort((a, b) => a.order - b.order);
    // Late registration must reach materials that already exist.
    for (const m of this.all) this._compose(m);
    this.log?.info?.(`shader patch "${name}" registered (${this.patches.length} total)`);
    return () => this.unregisterShaderPatch(name);
  }

  unregisterShaderPatch(name) {
    this.patches = this.patches.filter((p) => p.name !== name);
    for (const m of this.all) this._compose(m);
  }

  /** Bring an externally-created material into the chain. Call AFTER setting your own hook. */
  adopt(material, { depth = false } = {}) {
    if (!material) return material;
    this.all.add(material);
    this._compose(material, depth);
    return material;
  }

  /** Adopt a mesh's material AND its custom depth material, so shadows follow the patch. */
  adoptMesh(mesh) {
    if (!mesh) return mesh;
    if (mesh.material) this.adopt(mesh.material);
    if (mesh.customDepthMaterial) this.adopt(mesh.customDepthMaterial, { depth: true });
    if (mesh.customDistanceMaterial) this.adopt(mesh.customDistanceMaterial, { depth: true });
    return mesh;
  }

  _compose(material, isDepth = material.__patchDepth === true) {
    material.__patchDepth = isDepth;
    if (material.__ownHook === undefined) {
      // Capture whatever the module set before we wrapped it — exactly once.
      material.__ownHook = material.onBeforeCompile && !material.__chained
        ? material.onBeforeCompile
        : (material.__ownHook || null);
    }
    const own = material.__ownHook;
    const self = this;
    const chain = () => self.patches.filter((p) => (isDepth ? p.depth : true));

    material.onBeforeCompile = function chained(shader, renderer) {
      // Shared uniforms go in by reference, so one write updates every material.
      for (const k of Object.keys(self.globalUniforms)) shader.uniforms[k] = self.globalUniforms[k];
      if (own) own.call(this, shader, renderer);
      for (const p of chain()) {
        try { p.fn(shader, material, renderer); }
        catch (err) { self.log?.error?.(`shader patch "${p.name}" threw`, err); }
      }
    };
    material.__chained = true;

    // three caches programs; the key must change when the patch set changes.
    const prevKey = material.__ownCacheKey ?? material.customProgramCacheKey;
    if (!material.__cacheKeyWrapped) {
      material.__ownCacheKey = typeof prevKey === 'function' ? prevKey : null;
      material.customProgramCacheKey = function key() {
        const base = material.__ownCacheKey ? material.__ownCacheKey.call(this) : '';
        return base + '|' + chain().map((p) => p.name).join(',');
      };
      material.__cacheKeyWrapped = true;
    }
    material.needsUpdate = true;
    return material;
  }

  _key(o) {
    return JSON.stringify(o, (k, v) => (v && v.isTexture ? `tex:${v.uuid}` : v));
  }

  /** Standard physically-based surface. */
  pbr(opts = {}) {
    const key = 'pbr' + this._key(opts);
    if (this.cache.has(key)) return this.cache.get(key);
    const {
      color = 0x9aa0a6, roughness = 0.8, metalness = 0.0,
      map = null, normalMap = null, roughnessMap = null, aoMap = null,
      normalScale = 1, emissive = 0x000000, emissiveIntensity = 0,
      envMapIntensity = 1, transparent = false, opacity = 1,
      side = THREE.FrontSide, flatShading = false, vertexColors = false,
      clearcoat = 0, sheen = 0, transmission = 0, ior = 1.5, dithering = true,
    } = opts;

    const usePhysical = clearcoat > 0 || sheen > 0 || transmission > 0;
    const Ctor = usePhysical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;

    const m = new Ctor({
      color, roughness, metalness, map, normalMap, roughnessMap, aoMap,
      emissive, emissiveIntensity, envMapIntensity, transparent, opacity,
      side, flatShading, vertexColors, dithering,
    });
    if (normalMap) m.normalScale = new THREE.Vector2(normalScale, normalScale);
    if (usePhysical) {
      m.clearcoat = clearcoat;
      m.clearcoatRoughness = opts.clearcoatRoughness ?? 0.1;
      m.sheen = sheen;
      m.sheenColor = new THREE.Color(opts.sheenColor ?? 0xffffff);
      m.transmission = transmission;
      m.ior = ior;
      m.thickness = opts.thickness ?? 0.5;
    }
    this.cache.set(key, m);
    this.all.add(m);
    if (this.patches.length) this._compose(m);
    return m;
  }

  /** Emissive-only surface (window lights, neon, headlights). */
  emissive(color = 0xffd9a0, intensity = 1, opts = {}) {
    const key = 'em' + color + intensity + this._key(opts);
    if (this.cache.has(key)) return this.cache.get(key);
    const m = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: color,
      emissiveIntensity: intensity,
      roughness: 1, metalness: 0,
      toneMapped: opts.toneMapped ?? true,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
      side: opts.side ?? THREE.FrontSide,
      map: opts.map ?? null,
      emissiveMap: opts.emissiveMap ?? null,
    });
    this.cache.set(key, m);
    this.all.add(m);
    if (this.patches.length) this._compose(m);
    return m;
  }

  /** Architectural glass — reflective, slightly tinted, cheap (no transmission). */
  glass(tint = 0x2a3a48, { roughness = 0.06, metalness = 0.9, opacity = 1 } = {}) {
    return this.pbr({
      color: tint, roughness, metalness, envMapIntensity: 1.6,
      transparent: opacity < 1, opacity,
    });
  }

  /** Asphalt / concrete road surface with wetness response. */
  road(kind = 'asphalt', wetness = 0) {
    const base = kind === 'concrete'
      ? { color: 0x8d8b86, roughness: 0.92 }
      : { color: 0x2f3134, roughness: 0.82 };
    const r = THREE.MathUtils.lerp(base.roughness, 0.16, wetness);
    return this.pbr({ ...base, roughness: r, metalness: wetness * 0.25, envMapIntensity: 1 + wetness });
  }

  setEnvMapIntensity(v) {
    for (const m of this.all) if ('envMapIntensity' in m) { m.envMapIntensity = v; m.needsUpdate = false; }
  }

  dispose() {
    for (const m of this.all) m.dispose();
    this.all.clear();
    this.cache.clear();
  }
}

export default Materials;
