import * as THREE from 'three';

/**
 * environment/csm.js — real cascaded shadow maps on the core patch chain.
 *
 * ## How this works without a custom shadow renderer
 *
 * three allocates one shadow map per shadow-casting light and uploads
 * `directionalShadowMap[i]`, `directionalLightShadows[i]` and the varying
 * `vDirectionalShadowCoord[i]` to every lit material. So three `DirectionalLight`s
 * pointing the same way give us three independently-fitted shadow maps *for free*,
 * with three's own caster culling, its own depth-material derivation (including
 * `customDepthMaterial`, so vertex animation reaches the shadow) and its own PCF.
 *
 * Only **light 0 carries intensity**; lights 1 and 2 are zero-intensity and exist
 * purely to own cascades 1 and 2. Verified against three's source: `WebGLLights`
 * gates shadow allocation on `castShadow` alone and never culls a zero-intensity
 * light.
 *
 * The shader patch then does the one thing three cannot: it replaces the per-light
 * shadow lookup with a cascade *selection*. Cascades are ordered near → far, and a
 * fragment takes the first cascade whose shadow coordinate is inside the unit box —
 * i.e. the tightest one that contains it — cross-fading over the last few per cent
 * of the box so no split is visible.
 *
 * Selection is done in shadow-map space, not by view depth, which means it needs
 * **no new uniforms and no new varyings** — `vDirectionalShadowCoord` is already
 * there. `globalUniforms` stays free for the aerial-perspective work.
 *
 * The patch is applied per material through `ctx.materials.registerShaderPatch`,
 * never by mutating `THREE.ShaderChunk`, so it composes with the hooks `terrain`,
 * `roads`, `props` and `buildings` already install.
 */

export const CASCADES = 3;

/** Blend width at a cascade edge, in normalised shadow-box units. */
const BLEND = 0.055;

/**
 * `onBeforeCompile` runs *before* three resolves `#include`s, so the fragment
 * shader still says `#include <lights_fragment_begin>` at patch time. We inline
 * the chunk ourselves with the directional-shadow line rewritten; three's
 * `unrollLoops` still runs afterwards over the inlined text, so
 * `UNROLLED_LOOP_INDEX` keeps working.
 */
const DIR_SHADOW_LINE =
  /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\(\s*directionalShadowMap\[ i \][\s\S]*?vDirectionalShadowCoord\[ i \] \) : 1\.0;/;

// Only light 0 carries intensity, so only light 0 needs the shadow term. This
// also keeps the cost at one cascade lookup per fragment instead of three.
const DIR_SHADOW_REPLACEMENT = `
		#if ( UNROLLED_LOOP_INDEX == 0 )
		directLight.color *= ( directLight.visible && receiveShadow ) ? envCsmShadow() : 1.0;
		#endif`;

const CSM_HELPER = /* glsl */`

/* ---- environment: cascaded shadow selection ---------------------------- */
// Guarded: the shadow uniforms only exist when USE_SHADOWMAP is defined, and
// this helper is appended to every lit material including unshadowed ones.
#ifdef USE_SHADOWMAP

// Signed distance to the nearest side wall of the unit shadow box; > 0 means the
// fragment is inside this cascade, and the value doubles as the blend weight.
// Only x/y — the footprint — exactly as three's own frustumTest does. Folding
// depth into the same min() rejects everything near the cascade's near plane and
// silently demotes it to a coarser cascade.
float envCsmEdge( vec4 sc ) {
	vec3 c = sc.xyz / sc.w;
	if ( c.z > 1.0 ) return -1.0;
	vec2 d = min( c.xy, vec2( 1.0 ) - c.xy );
	return min( d.x, d.y );
}

#define ENV_CSM_GET( I ) getShadow( directionalShadowMap[ I ], directionalLightShadows[ I ].shadowMapSize, directionalLightShadows[ I ].shadowIntensity, directionalLightShadows[ I ].shadowBias, directionalLightShadows[ I ].shadowRadius, vDirectionalShadowCoord[ I ] )

float envCsmShadow() {

	#if NUM_DIR_LIGHT_SHADOWS >= 3

		float e0 = envCsmEdge( vDirectionalShadowCoord[ 0 ] );
		if ( e0 > 0.0 ) {
			float s0 = ENV_CSM_GET( 0 );
			float w = smoothstep( 0.0, ${BLEND.toFixed(3)}, e0 );
			if ( w >= 1.0 ) return s0;
			return mix( ENV_CSM_GET( 1 ), s0, w );
		}

		float e1 = envCsmEdge( vDirectionalShadowCoord[ 1 ] );
		if ( e1 > 0.0 ) {
			float s1 = ENV_CSM_GET( 1 );
			float w = smoothstep( 0.0, ${BLEND.toFixed(3)}, e1 );
			if ( w >= 1.0 ) return s1;
			return mix( ENV_CSM_GET( 2 ), s1, w );
		}

		return ENV_CSM_GET( 2 );

	#else

		// Fewer cascades than expected (another module added a shadow-casting
		// directional light, or shadows are off). Degrade to three's behaviour.
		return ENV_CSM_GET( 0 );

	#endif
}
#endif
`;

/** Build the patch function to hand to `ctx.materials.registerShaderPatch`. */
export function makeCsmPatch(log) {
  let warned = false;
  return function csmPatch(shader) {
    if (shader.__envCsm) return;

    const lightsChunk = THREE.ShaderChunk.lights_fragment_begin;
    if (!DIR_SHADOW_LINE.test(lightsChunk)) {
      if (!warned) {
        warned = true;
        log?.warn?.('CSM: three\'s lights_fragment_begin does not match the expected shape — cascades disabled, single shadow map still active');
      }
      return;
    }

    // inline the shadow-map declarations plus our helper
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <shadowmap_pars_fragment>',
      THREE.ShaderChunk.shadowmap_pars_fragment + CSM_HELPER
    );

    // inline the lighting chunk with the directional shadow lookup rewritten
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_begin>',
      lightsChunk.replace(DIR_SHADOW_LINE, DIR_SHADOW_REPLACEMENT)
    );

    shader.__envCsm = true;
  };
}

/* ------------------------------------------------------------------------ */

/**
 * Practical split scheme: a blend of a logarithmic and a uniform split.
 * Log-weighted keeps cascade 0 tight enough for contact shadows; the uniform
 * term stops the far cascade from having to swallow the whole range.
 */
export function splitDistances(near, far, n, lambda = 0.88) {
  const out = [];
  const n0 = Math.max(near, 8);
  for (let i = 1; i <= n; i++) {
    const p = i / n;
    const logD = n0 * Math.pow(far / n0, p);
    const uniD = n0 + (far - n0) * p;
    out.push(lambda * logD + (1 - lambda) * uniD);
  }
  out[n - 1] = far;
  return out;
}

/**
 * Bounding sphere of one frustum slice, in the camera's own space.
 * The radius is invariant under camera rotation, which is what makes texel
 * snapping able to stop shadow edges crawling when the camera pans.
 */
export function sliceSphere(near, far, tanX, tanY) {
  const t2 = tanX * tanX + tanY * tanY;
  let cz = ((far + near) * (t2 + 1)) / 2;
  if (cz > far) cz = far;
  const dz = cz - far;
  const radius = Math.max(4, Math.sqrt(far * far * t2 + dz * dz));
  return { cz, radius };
}

export default { CASCADES, makeCsmPatch, splitDistances, sliceSphere };
