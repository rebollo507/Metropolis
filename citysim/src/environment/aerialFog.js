import * as THREE from 'three';

/**
 * environment/aerialFog.js — real aerial perspective for every lit material.
 *
 * three's built-in `FogExp2` is a flat, distance-only blend: a tower's spire is
 * as hazed as its base, which is exactly what makes cheap city renders read as
 * flat. Real atmosphere thins out with altitude, so we replace the four fog
 * ShaderChunks with the analytic integral of an exponentially-decaying density
 * profile along the view ray:
 *
 *     optical = ρ₀ · e^(−k·y_cam) · L · (1 − e^(−k·Δy)) / (k·Δy)
 *
 * Everything it needs is already present in every three shader — `mvPosition`
 * in the vertex stage, `cameraPosition`, `fogColor` and `fogDensity` in the
 * fragment stage — so **no new uniforms are introduced**. That matters: other
 * modules build their own `ShaderMaterial`s, and an extra uniform they did not
 * declare would fail to link. Everything here is additive to chunks they
 * already include.
 *
 * The fog colour itself is the sky sampled towards the horizon along the
 * camera's view azimuth (the environment module refreshes it every frame); the
 * shader then tilts it slightly brighter looking up and slightly deeper looking
 * down, which is the part of view-direction dependence you actually notice.
 */

const K_FALLOFF = 0.0022;   // 1/m — density halves every ~315 m
const Y0 = 0.0;             // metres; the altitude fogDensity refers to

const ORIGINALS = {};
let installed = false;

export function installAerialFog() {
  if (installed) return true;
  for (const k of ['fog_pars_vertex', 'fog_vertex', 'fog_pars_fragment', 'fog_fragment']) {
    ORIGINALS[k] = THREE.ShaderChunk[k];
  }

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldRay;
#endif
`;

  // mat3(viewMatrix) is a pure rotation, so multiplying from the right is its
  // inverse: this recovers the world-space camera → fragment offset without
  // needing `transformed` (which some built-in shaders never define).
  THREE.ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorldRay = mvPosition.xyz * mat3( viewMatrix );
#endif
`;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldRay;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
`;

  THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogDist = max( length( vFogWorldRay ), 1e-3 );
		float fogDY = vFogWorldRay.y;
		float fogT = ${K_FALLOFF.toExponential()} * fogDY;
		float fogInteg = ( abs( fogT ) > 1e-4 ) ? ( 1.0 - exp( -fogT ) ) / fogT : 1.0;
		float fogBase = exp( -${K_FALLOFF.toExponential()} * max( cameraPosition.y - ${Y0.toFixed(1)}, -400.0 ) );
		float fogOptical = fogDensity * fogDist * fogBase * fogInteg;
		float fogFactor = 1.0 - exp( - fogOptical );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	vec3 fogTinted = fogColor * mix( 0.86, 1.16, clamp( vFogWorldRay.y / max( length( vFogWorldRay ), 1e-3 ) * 1.6 + 0.42, 0.0, 1.0 ) );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTinted, clamp( fogFactor, 0.0, 1.0 ) );
#endif
`;

  installed = true;
  return true;
}

export function uninstallAerialFog() {
  if (!installed) return;
  for (const k of Object.keys(ORIGINALS)) THREE.ShaderChunk[k] = ORIGINALS[k];
  installed = false;
}

export default installAerialFog;
