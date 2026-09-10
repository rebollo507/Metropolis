import * as THREE from 'three';

/**
 * environment/aerial.js — per-pixel aerial perspective (R-1 / R-env-10).
 *
 * ## What was wrong
 *
 * three mixes fog toward a single `fogColor`. `environment` set that colour once
 * per frame by sampling the sky along the camera's view azimuth, so every fogged
 * pixel in the frame converged on **one** colour. At golden hour that is nearly
 * right, because the sky is dominated by one warm lobe. At noon it is badly
 * wrong: the sky overhead is blue, the horizon is pale, the sunward side is warm,
 * and collapsing all of that to one sample turns the whole mid-distance into flat
 * grey-white. Measured: noon relSat 0.089 against golden hour's 0.576.
 *
 * ## What this does
 *
 * Replaces the mix target with a real inscattering term evaluated **per pixel in
 * the view direction**, split into its Rayleigh and Mie parts:
 *
 *     inscatter(θ) = betaR · rayleighPhase(θ) + betaM · henyeyGreenstein(θ, g)
 *
 * where θ is the angle between the view ray and the sun. Rayleigh is blue and
 * near-isotropic; Mie is the sun's own colour and sharply forward-scattering. So
 * geometry seen against the anti-solar sky desaturates toward *blue*, geometry
 * seen toward the sun desaturates toward *warm haze*, and the two are the same
 * physical model that draws the sky dome — not two hand-tuned colours.
 *
 * `betaR` and `betaM` are solved on the CPU each frame so that the term exactly
 * reproduces `SkyModel`'s own radiance at two anchor directions (the sunward and
 * anti-solar horizon). That keeps the haze locked to the sky it is seen against
 * even as turbidity, weather and hour change.
 *
 * Extinction is unchanged — the same analytic exponential-height-fog integral the
 * global chunk uses — so the near field is untouched and only the mix target
 * changes.
 *
 * ## Why this is a patch and not a ShaderChunk override
 *
 * It needs four uniforms. `environment` already overrides the fog chunks globally
 * (R-3), and those must keep working for any material that is *not* on the patch
 * chain — a material without these uniforms declared would fail to link. So the
 * global chunk keeps the old single-colour path as the fallback, and this patch
 * upgrades only materials on `ctx.materials`' chain (which, since `props`,
 * `terrain`, `roads`, `buildings` and `traffic` all adopt, is essentially the
 * whole scene).
 */

const AERIAL_PARS = /* glsl */`
#ifdef USE_FOG
	uniform vec3 uAerRay;    // Rayleigh inscatter, pre-multiplied, output space
	uniform vec3 uAerMie;    // Mie inscatter, pre-multiplied, output space
	uniform vec3 uAerSun;    // unit vector toward the sun (or moon)
	uniform vec4 uAerCfg;    // x: height falloff  y: base altitude  z: mie g  w: enable
#endif
`;

const AERIAL_FRAGMENT = /* glsl */`
#ifdef USE_FOG
	#ifdef FOG_EXP2

		float fogDist = max( length( vFogWorldRay ), 1e-3 );
		vec3  fogDir  = vFogWorldRay / fogDist;

		// analytic integral of an exponentially-decaying density along the ray
		float fogK = uAerCfg.x;
		float fogT = fogK * vFogWorldRay.y;
		float fogInteg = ( abs( fogT ) > 1e-4 ) ? ( 1.0 - exp( -fogT ) ) / fogT : 1.0;
		float fogBase = exp( -fogK * max( cameraPosition.y - uAerCfg.y, -400.0 ) );
		float fogFactor = 1.0 - exp( - ( fogDensity * fogDist * fogBase * fogInteg ) );

	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		vec3  fogDir = normalize( vFogWorldRay );
	#endif

	vec3 fogTarget;
	if ( uAerCfg.w > 0.5 ) {

		float cosT = dot( fogDir, uAerSun );
		float rPhase = 0.0596831 * ( 1.0 + cosT * cosT );
		float g = uAerCfg.z;
		float g2 = g * g;
		float mPhase = 0.0795775 * ( 1.0 - g2 ) * pow( max( 1e-4, 1.0 + g2 - 2.0 * g * cosT ), -1.5 );
		fogTarget = max( uAerRay * rPhase + uAerMie * mPhase, vec3( 0.0 ) );

	} else {
		// uniforms not published yet — fall back to the flat colour
		fogTarget = fogColor;
	}

	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTarget, clamp( fogFactor, 0.0, 1.0 ) );
#endif
`;

/** Patch factory for `ctx.materials.registerShaderPatch`. */
export function makeAerialPatch() {
  return function aerialPatch(shader) {
    if (shader.__envAerial) return;
    if (shader.fragmentShader.indexOf('#include <fog_fragment>') < 0) return;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', THREE.ShaderChunk.fog_pars_fragment + AERIAL_PARS)
      .replace('#include <fog_fragment>', AERIAL_FRAGMENT);
    shader.__envAerial = true;
  };
}

/* ------------------------------------------------------------------------- */

const RP = (c) => 0.0596831 * (1 + c * c);
const MP = (c, g) => {
  const g2 = g * g;
  return 0.0795775 * (1 - g2) * Math.pow(Math.max(1e-4, 1 + g2 - 2 * g * c), -1.5);
};

const _a = { r: 0, g: 0, b: 0 };
const _s = { r: 0, g: 0, b: 0 };

/**
 * Solve the two-term inscattering model so it reproduces the sky model's own
 * radiance at the sunward and anti-solar horizon. Writes into `outRay`/`outMie`.
 *
 * @param {SkyModel} model
 * @param {{x,y,z}} sun      unit vector toward the sun
 * @param {number} g         Mie asymmetry
 * @param {(rgb:{r,g,b})=>void} encode  maps HDR radiance into the output space
 */
export function solveInscatter(model, sun, g, encode, outRay, outMie) {
  const hx = sun.x, hz = sun.z;
  const hl = Math.hypot(hx, hz) || 1;
  // two anchors on the horizon: straight toward the sun and straight away
  const sy = 0.06;
  const sN = Math.sqrt(1 - sy * sy);
  const sdx = (hx / hl) * sN, sdz = (hz / hl) * sN;

  model.radiance(sdx, sy, sdz, _s);
  model.radiance(-sdx, sy, -sdz, _a);
  encode(_s);
  encode(_a);

  const cs = sdx * sun.x + sy * sun.y + sdz * sun.z;
  const ca = -sdx * sun.x + sy * sun.y - sdz * sun.z;

  const rs = RP(cs), ra = RP(ca);
  const ms = MP(cs, g), ma = MP(ca, g);
  const det = ra * ms - rs * ma;

  if (Math.abs(det) < 1e-9) {
    outRay.setRGB(_a.r / Math.max(ra, 1e-4), _a.g / Math.max(ra, 1e-4), _a.b / Math.max(ra, 1e-4));
    outMie.setRGB(0, 0, 0);
    return;
  }
  const rr = (_a.r * ms - _s.r * ma) / det;
  const rg = (_a.g * ms - _s.g * ma) / det;
  const rb = (_a.b * ms - _s.b * ma) / det;
  const mr = (_s.r * ra - _a.r * rs) / det;
  const mg = (_s.g * ra - _a.g * rs) / det;
  const mb = (_s.b * ra - _a.b * rs) / det;

  outRay.setRGB(Math.max(0, rr), Math.max(0, rg), Math.max(0, rb));
  outMie.setRGB(Math.max(0, mr), Math.max(0, mg), Math.max(0, mb));
}

export default { makeAerialPatch, solveInscatter };
