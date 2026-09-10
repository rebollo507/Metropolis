import * as THREE from 'three';

/**
 * Materials owned by `props`.
 *
 * These are deliberately NOT taken from `ctx.materials`: two of them need an
 * `onBeforeCompile` patch (wind sway + per-instance distance collapse), and the
 * shared cache hands the same object to every module, so patching a cached
 * material would silently reach across a module boundary (see CORE_REQUESTS R-2,
 * which is exactly this problem). Everything created here is disposed in
 * `dispose()`.
 *
 * Two shader features, both injected into `<project_vertex>` so they act on the
 * instance transform rather than on object space:
 *
 *  PROPS_SWAY  — wind. `aSway` is a per-vertex stiffness weight (0 at the trunk
 *                base, 1 at a leaf tip). Phase comes from the instance's own
 *                world position, so a row of trees does not move as one object.
 *  PROPS_CULL  — distance collapse. Beyond `uPropsCull.y` the instance is
 *                collapsed onto its origin, which produces degenerate triangles
 *                and therefore zero fragments, without costing a draw call or a
 *                CPU rebuild. `cameraPosition` is a built-in uniform, so this is
 *                allocation-free and needs no per-frame upload.
 *
 * Note both rely on the module group sitting at identity (props never moves its
 * group — CORE_REQUESTS pass-1 told modules to stop faking camera moves).
 */

const PROJECT_VERTEX = /* glsl */`
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 iOrigin = instanceMatrix[3].xyz;
  #ifdef PROPS_SWAY
    float swPh = iOrigin.x * 0.213 + iOrigin.z * 0.171;
    float swT = uPropsTime * uPropsWind.z;
    float swW = sin( swT + swPh ) * 0.62 + sin( swT * 1.73 + swPh * 1.31 + 1.7 ) * 0.38;
    float swG = sin( swT * 5.1 + swPh * 4.3 ) * 0.17;
    mvPosition.xz += uPropsWind.xy * ( ( swW + swG ) * uPropsWind.w * aSway * aSway );
  #endif
  #ifdef PROPS_GLOW
    // A 9.5 m pool is ~22 px from a 400 m aerial and the lamps are 30 m apart,
    // so unscaled pools read as a dotted line. Grow and brighten them with
    // distance until the chain closes into a continuous lit street.
    float gD = distance( iOrigin, uPropsCam );
    float gT = clamp( ( gD - uPropsGlow.x ) / uPropsGlow.y, 0.0, 1.0 );
    vPropsGlow = 1.0 + gT * uPropsGlow.w;
    mvPosition.xz = iOrigin.xz + ( mvPosition.xz - iOrigin.xz ) * ( 1.0 + gT * uPropsGlow.z );
  #endif
  #ifdef PROPS_CULL
    float dCam = distance( iOrigin, uPropsCam );
    float kCull = smoothstep( uPropsCull.x, uPropsCull.y, dCam )
                * ( 1.0 - smoothstep( uPropsCull.z, uPropsCull.w, dCam ) );
    mvPosition.xyz = mix( iOrigin, mvPosition.xyz, kCull );
  #endif
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

/** `color_fragment` only honours vColor under USE_COLOR; make instanceColor work. */
const COLOR_FRAGMENT = /* glsl */`
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  diffuseColor *= vColor;
#elif defined( USE_INSTANCING_COLOR )
  diffuseColor.rgb *= vColor.rgb;
#endif
#ifdef PROPS_GLOW
  diffuseColor.rgb *= vPropsGlow;
#endif
`;

export class PropMaterials {
  constructor(ctx, tex) {
    this.ctx = ctx;
    this.tex = tex;
    this.owned = new Set();
    this.time = { value: 0 };
    // Own the view position: three's built-in `cameraPosition` is the light's
    // position while the shadow map is being drawn, so a depth material patched
    // with the same collapse would cull against the light, not the viewer.
    this.camPos = { value: new THREE.Vector3(0, 0, 0) };
    this.wind = { value: new THREE.Vector4(1, 0, 1, 0.16) };
    this.night = 0;
    this.lamps = [];
    this._build();
  }

  /* ------------------------------------------------------------ factory -- */

  _patch(m, opts = {}) {
    const { sway = 0, cull = null, tint = false, glow = null } = opts;
    m.userData.propsPatch = opts;
    m.defines = m.defines || {};
    if (sway > 0) m.defines.PROPS_SWAY = '';
    if (cull) m.defines.PROPS_CULL = '';
    if (glow) m.defines.PROPS_GLOW = '';
    // cull = [fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd] in metres.
    const c = cull || [-2, -1, 1e6, 1e6 + 1];
    const cullU = { value: new THREE.Vector4(c[0], c[1], c[2], c[3]) };
    m.userData.cull = cullU;
    // glow = [startMetres, spanMetres, extraScale, extraBrightness]
    const gl = glow || [0, 1, 0, 0];
    const glowU = { value: new THREE.Vector4(gl[0], gl[1], gl[2], gl[3]) };
    m.userData.glow = glowU;
    const time = this.time, wind = this.wind, camPos = this.camPos;
    const amp = sway;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uPropsTime = time;
      shader.uniforms.uPropsWind = wind;
      shader.uniforms.uPropsCull = cullU;
      shader.uniforms.uPropsGlow = glowU;
      shader.uniforms.uPropsCam = camPos;
      let head = '';
      if (sway > 0) head += 'attribute float aSway;\nuniform float uPropsTime;\nuniform vec4 uPropsWind;\n';
      if (cull || glow) head += 'uniform vec3 uPropsCam;\n';
      if (cull) head += 'uniform vec4 uPropsCull;\n';
      if (glow) head += 'uniform vec4 uPropsGlow;\nvarying float vPropsGlow;\n';
      shader.vertexShader = head + shader.vertexShader;
      let body = PROJECT_VERTEX;
      if (sway > 0 && amp !== 1) body = body.replace('uPropsWind.w', `( uPropsWind.w * ${amp.toFixed(3)} )`);
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', body);
      if (glow) shader.fragmentShader = 'varying float vPropsGlow;\n' + shader.fragmentShader;
      if (tint || glow) shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', COLOR_FRAGMENT);
    };
    m.customProgramCacheKey = () =>
      `props|${sway}|${cull ? cull.join(',') : 0}|${tint ? 1 : 0}|${glow ? glow.join(',') : 0}`;
    return m;
  }

  _std(opts, patch) {
    const m = new THREE.MeshStandardMaterial(opts);
    this.owned.add(m);
    if (patch) { this._patch(m, patch); m.userData.propsPatch = patch; }
    return m;
  }

  /**
   * A depth material carrying the same sway + distance collapse as its beauty
   * material, so a shadow moves with the wind and — the point of R-props-7 —
   * disappears when its caster does. Adopted with `{depth: true}` so the core
   * chain reaches it too.
   */
  depthFor(mat, { alphaTest = 0, map = null } = {}) {
    const patch = mat.userData && mat.userData.propsPatch;
    const d = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      alphaTest, map: alphaTest > 0 ? map : null,
    });
    this.owned.add(d);
    if (patch) this._patch(d, patch);
    return d;
  }

  /** Hand every material props owns to the core shader-patch chain. */
  adoptAll(ctx) {
    if (!ctx.materials || typeof ctx.materials.adopt !== 'function') return 0;
    let n = 0;
    for (const m of this.owned) {
      if (!m.isMaterial) continue;
      try { ctx.materials.adopt(m, { depth: m.isMeshDepthMaterial === true }); n++; }
      catch { /* never fatal */ }
    }
    return n;
  }

  /* -------------------------------------------------------------- build -- */

  _build() {
    const T = this.tex;
    const rep = (t, r) => {
      if (!t) return null;
      const c = t.clone();
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(r, r);
      c.needsUpdate = true;
      this.owned.add(c);
      return c;
    };

    /* --- vegetation --- */
    this.bark = this._std({
      map: T.bark, normalMap: T.barkN, roughness: 0.94, metalness: 0,
      color: 0xffffff,
    }, { sway: 0.28, cull: [-2, -1, 700, 820], tint: true });
    this.bark.normalScale.set(1.15, 1.15);

    this.leaf = this._std({
      map: T.leaves, alphaTest: 0.42, transparent: false,
      side: THREE.DoubleSide, roughness: 0.82, metalness: 0,
      color: 0xffffff,
    }, { sway: 1.0, cull: [-2, -1, 110, 150], tint: true });

    this.leafMid = this._std({
      map: T.leaves, alphaTest: 0.44, side: THREE.DoubleSide,
      roughness: 0.84, metalness: 0, color: 0xffffff,
    }, { sway: 0.75, cull: [110, 150, 700, 820], tint: true });

    this.canopyFar = this._std({
      map: T.canopyFar, alphaTest: 0.45, side: THREE.DoubleSide,
      roughness: 0.9, metalness: 0, color: 0xffffff,
    }, { sway: 0.35, cull: [700, 820, 2400, 2800], tint: true });

    this.shrub = this._std({
      map: T.shrub, normalMap: T.shrubN, roughness: 0.92, metalness: 0,
      color: 0xffffff,
    }, { sway: 0.45, cull: [-2, -1, 420, 520], tint: true });

    this.grass = this._std({
      map: T.grass, alphaTest: 0.38, side: THREE.DoubleSide,
      roughness: 0.9, metalness: 0, color: 0xffffff,
    }, { sway: 1.35, cull: [-2, -1, 70, 95], tint: true });

    /* --- hard surfaces --- */
    this.metal = this._std({
      map: T.metal, normalMap: T.metalN, roughness: 0.44, metalness: 0.55,
      color: 0xffffff,
    }, { cull: [-2, -1, 760, 880], tint: true });

    this.metalDark = this._std({
      map: T.metal, normalMap: T.metalN, roughness: 0.56, metalness: 0.72,
      color: 0x30343a,
    }, { cull: [-2, -1, 700, 820], tint: true });

    this.concrete = this._std({
      map: rep(T.concrete, 2), normalMap: rep(T.concreteN, 2),
      roughness: 0.95, metalness: 0, color: 0xffffff,
    }, { cull: [-2, -1, 820, 940], tint: true });

    this.wood = this._std({
      map: T.wood, normalMap: T.woodN, roughness: 0.86, metalness: 0,
      color: 0xffffff,
    }, { cull: [-2, -1, 620, 740], tint: true });

    this.brick = this._std({
      map: T.brick, roughness: 0.93, metalness: 0, color: 0xffffff,
    }, { cull: [-2, -1, 700, 820], tint: true });

    this.fabric = this._std({
      map: T.fabric, roughness: 0.88, metalness: 0, side: THREE.DoubleSide,
      color: 0xffffff,
    }, { cull: [-2, -1, 560, 660], tint: true });

    this.plastic = this._std({
      roughness: 0.55, metalness: 0.02, color: 0xffffff,
    }, { cull: [-2, -1, 480, 580], tint: true });

    this.glass = this._std({
      color: 0x93a7b4, roughness: 0.08, metalness: 0.25,
      transparent: true, opacity: 0.34, side: THREE.DoubleSide,
      envMapIntensity: 1.5, depthWrite: false,
    }, { cull: [-2, -1, 480, 580] });

    this.signFace = this._std({
      map: T.signs, roughness: 0.52, metalness: 0.05, side: THREE.DoubleSide,
      color: 0xffffff, alphaTest: 0.5,
    }, { cull: [-2, -1, 520, 620] });

    /* --- vehicles --- */
    // Automotive paint is a dielectric under a clearcoat. Driving it with
    // metalness made every car a mirror of the sky, which is why they read as
    // white wedges rather than as painted metal.
    this.carPaint = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.34, metalness: 0.10,
      clearcoat: 0.72, clearcoatRoughness: 0.09, envMapIntensity: 0.85,
    });
    this.owned.add(this.carPaint);
    this._patch(this.carPaint, { cull: [-2, -1, 820, 950], tint: true });

    // Car glass reads dark and solid from outside; keeping it opaque avoids
    // sort artefacts against the body it is welded to.
    this.carGlass = this._std({
      color: 0x0d1216, roughness: 0.11, metalness: 0.12,
      envMapIntensity: 0.55, side: THREE.DoubleSide,
    }, { cull: [-2, -1, 700, 820] });

    this.tyre = this._std({
      color: 0x17181a, roughness: 0.94, metalness: 0.0,
    }, { cull: [-2, -1, 520, 620] });

    this.chrome = this._std({
      color: 0xcdd3d8, roughness: 0.18, metalness: 0.95, envMapIntensity: 1.4,
    }, { cull: [-2, -1, 480, 580] });

    /* --- emissive / decals --- */
    this.lampLens = new THREE.MeshStandardMaterial({
      color: 0x2a2723, emissive: 0xffd39a, emissiveIntensity: 0.0,
      roughness: 0.28, metalness: 0.0, transparent: true, opacity: 0.94,
    });
    this.owned.add(this.lampLens);
    this._patch(this.lampLens, { cull: [-2, -1, 1200, 1400], tint: true });
    this.lamps.push({ mat: this.lampLens, peak: 11.0 });

    // A basic material so `instanceColor` sets both the aspect colour AND its
    // brightness — a standard material's emissive cannot be driven per instance.
    this.signalLens = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true });
    this.owned.add(this.signalLens);
    this._patch(this.signalLens, { cull: [-2, -1, 700, 820], tint: true });

    // Shop fascia: painted by day, back-lit at night.
    this.shopLight = new THREE.MeshStandardMaterial({
      map: T.signs, emissiveMap: T.signs, color: 0xffffff,
      emissive: 0xffffff, emissiveIntensity: 0.0,
      roughness: 0.62, metalness: 0.02, alphaTest: 0.5,
    });
    this.owned.add(this.shopLight);
    this._patch(this.shopLight, { cull: [-2, -1, 900, 1050], tint: false });
    this.lamps.push({ mat: this.shopLight, peak: 2.1 });

    this.pool = new THREE.MeshBasicMaterial({
      map: T.pool, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      toneMapped: true, side: THREE.FrontSide,
    });
    this.owned.add(this.pool);
    this._patch(this.pool, { cull: [-2, -1, 1100, 1300], tint: true, glow: [110, 300, 1.55, 0.95] });

    this.decal = this._std({
      map: T.dirt, transparent: true, opacity: 0.9, depthWrite: false,
      roughness: 1, metalness: 0, polygonOffset: true,
      polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }, { cull: [-2, -1, 420, 520], tint: true });

    this.gravel = this._std({
      map: rep(T.gravel, 3), roughness: 0.96, metalness: 0, color: 0xffffff,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }, { cull: [-2, -1, 700, 820], tint: true });

    this.paving = this._std({
      map: rep(T.concrete, 3), normalMap: rep(T.concreteN, 3),
      roughness: 0.9, metalness: 0, color: 0xffffff,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }, { cull: [-2, -1, 760, 880], tint: true });

    this._foliage = [this.leaf, this.leafMid, this.canopyFar, this.shrub, this.grass];

    this.poolWater = new THREE.MeshPhysicalMaterial({
      color: 0x2b7f9e, roughness: 0.05, metalness: 0.1,
      normalMap: this.tex.waterN, envMapIntensity: 1.6,
      transparent: true, opacity: 0.86, clearcoat: 1, clearcoatRoughness: 0.04,
    });
    this.owned.add(this.poolWater);
    this._patch(this.poolWater, { cull: [-2, -1, 480, 580] });
  }

  /* -------------------------------------------------------------- state -- */

  /** 0 = full day, 1 = full night. Drives every emissive surface props owns. */
  setNight(n) {
    this.night = Math.max(0, Math.min(1, n));
    for (const l of this.lamps) l.mat.emissiveIntensity = this.night * l.peak;
    this.lampLens.color.setRGB(
      0.16 + this.night * 0.02, 0.155 + this.night * 0.02, 0.14
    );
    this.pool.opacity = Math.pow(this.night, 1.2) * 0.22;
    this.pool.visible = this.night > 0.02;

    // Critic issue 3: foliage kept full daylight saturation at night. Vegetation
    // is lit by a cool fill after dark, so pull the albedo toward blue-grey
    // rather than leaving a vivid green in a night frame.
    const k = this.night * 0.62;
    for (const m of this._foliage) {
      m.color.setRGB(1 - k * 0.52, 1 - k * 0.40, 1 - k * 0.14);
    }
  }

  setWetness(w) {
    const k = Math.max(0, Math.min(1, w || 0));
    this.concrete.roughness = 0.95 - k * 0.62;
    this.paving.roughness = 0.90 - k * 0.58;
    this.metal.roughness = 0.44 - k * 0.24;
    this.wood.roughness = 0.86 - k * 0.34;
    this.gravel.roughness = 0.96 - k * 0.4;
  }

  setWind(dirRad, speed) {
    const s = Math.max(0.2, Math.min(14, speed || 3));
    this.wind.value.set(
      Math.cos(dirRad), Math.sin(dirRad),
      0.55 + s * 0.14,
      0.045 + s * 0.028
    );
  }

  /** LOD bias: >1 keeps detail further out. */
  setLodBias(b) {
    const k = Math.max(0.2, Math.min(5, b || 1));
    if (this._lodBase === undefined) {
      this._lodBase = [];
      for (const m of this.owned) if (m.userData && m.userData.cull) {
        const v = m.userData.cull.value;
        this._lodBase.push([m.userData.cull, v.x, v.y, v.z, v.w]);
      }
    }
    for (const [u, x, y, z, w] of this._lodBase) {
      u.value.set(x < 0 ? x : x * k, y < 0 ? y : y * k, z * k, w * k);
    }
    return k;
  }

  advance(elapsed, camera) {
    this.time.value = elapsed;
    if (camera) this.camPos.value.copy(camera.position);
  }

  dispose() {
    for (const m of this.owned) m.dispose?.();
    this.owned.clear();
    this.lamps.length = 0;
  }
}

export default PropMaterials;
