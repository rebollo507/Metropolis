/**
 * environment/sky.glsl.js — the physical sky.
 *
 * Single-scattering Rayleigh + Mie atmosphere after Preetham et al., with a
 * real sun disc (limb-darkened), plus a night hemisphere: deep blue-black
 * gradient, seeded twinkle-free star field, a phased moon with maria, a soft
 * Milky Way band and warm city glow banked against the horizon.
 *
 * Day and night are additive: the scattering term self-extinguishes as the sun
 * drops, and `uNight` fades the night terms in over civil twilight.
 */

export const skyVert = /* glsl */`
varying vec3 vDir;

void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

export const skyFrag = /* glsl */`
#include <common>
#include <dithering_pars_fragment>

varying vec3 vDir;

uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform float uTurbidity;
uniform float uRayleigh;
uniform float uMieCoefficient;
uniform float uMieG;
uniform float uSunE;
uniform float uSkyScale;
uniform float uNight;
uniform float uStars;
uniform float uMoonBright;
uniform float uCityGlow;
uniform vec3  uCityGlowColor;
uniform vec3  uGroundColor;
uniform vec3  uGroundBounce;
uniform float uOvercast;
uniform float uSeed;
uniform float uTwilight;

const vec3  UP = vec3( 0.0, 1.0, 0.0 );
const vec3  RAYLEIGH_BETA = vec3( 5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5 );
const vec3  MIE_CONST     = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );
const float RAY_ZENITH = 8.4E3;
const float MIE_ZENITH = 1.25E3;
// Preetham's hard cutoff kills all scattering the instant the sun touches the
// horizon, which turns civil twilight into a black frame. Pushing the cutoff a
// few degrees below the horizon keeps a physically-shaped afterglow alive
// through dusk and still reaches zero by the end of nautical twilight.
const float CUTOFF = 1.70;                 // ≈ 97.4°
const float STEEP  = 1.5;
const float EE     = 1000.0;
const float SUN_COS = 0.9999566769;        // cos( 0.267 deg ) — real angular radius
const float SUN_RAD = 0.00465;             // radians

float sunIntensity( float zc ) {
  zc = clamp( zc, -1.0, 1.0 );
  return EE * max( 0.0, 1.0 - exp( -( ( CUTOFF - acos( zc ) ) / STEEP ) ) );
}

float rayleighPhase( float c ) { return ( 3.0 / ( 16.0 * PI ) ) * ( 1.0 + c * c ); }

float hgPhase( float c, float g ) {
  float g2 = g * g;
  return ( 1.0 / ( 4.0 * PI ) ) * ( ( 1.0 - g2 ) / pow( max( 1e-4, 1.0 + g2 - 2.0 * g * c ), 1.5 ) );
}

/* --- hashes (integer-free but precision-safe on ANGLE/SwiftShader) -------- */

vec3 hash33( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.xxy + p.yxx ) * p.zyx );
}

float hash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}

float vnoise3( vec3 p ) {
  vec3 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float n = mix(
    mix( mix( hash13( i + vec3( 0, 0, 0 ) ), hash13( i + vec3( 1, 0, 0 ) ), f.x ),
         mix( hash13( i + vec3( 0, 1, 0 ) ), hash13( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( hash13( i + vec3( 0, 0, 1 ) ), hash13( i + vec3( 1, 0, 1 ) ), f.x ),
         mix( hash13( i + vec3( 0, 1, 1 ) ), hash13( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
  return n;
}

/* --- stars: one candidate per lattice cell, deterministic, no time term --- */

vec3 starField( vec3 dir ) {
  vec3 total = vec3( 0.0 );
  vec3 p = dir * 205.0 + uSeed;
  vec3 cell = floor( p );
  vec3 f = p - cell;
  vec3 h  = hash33( cell + 11.0 );
  vec3 h2 = hash33( cell + 71.0 );
  float present = step( 0.885, h2.z );
  vec3 sp = vec3( 0.17 ) + h * 0.66;
  float d = length( f - sp );
  float mag = pow( h2.x, 4.0 );
  float b = present * smoothstep( 0.075, 0.004, d ) * ( 0.05 + 1.9 * mag );
  vec3 tint = mix( vec3( 0.70, 0.79, 1.0 ), vec3( 1.0, 0.85, 0.63 ), h2.y );
  total += tint * b;

  // Milky Way — a broad, faintly clumpy band on a tilted great circle.
  vec3 axis = normalize( vec3( 0.36, 0.60, -0.71 ) );
  float bd = abs( dot( dir, axis ) );
  float band = pow( 1.0 - smoothstep( 0.0, 0.40, bd ), 2.0 );
  float clump = 0.45 + 0.55 * vnoise3( dir * 9.0 + uSeed );
  total += vec3( 0.026, 0.029, 0.043 ) * band * clump;
  return total;
}

/* --- the moon: phased disc with maria + a tight forward-scatter halo ------ */

vec3 moonTerm( vec3 dir ) {
  float mc = dot( dir, uMoonDir );
  float ang = acos( clamp( mc, -1.0, 1.0 ) );
  const float R = 0.0048;

  vec3 mu = normalize( uMoonDir );
  vec3 t1 = normalize( cross( mu, vec3( 0.0, 1.0, 0.0001 ) ) );
  vec3 t2 = cross( mu, t1 );
  vec2 uv = vec2( dot( dir, t1 ), dot( dir, t2 ) ) / R;
  float rr = dot( uv, uv );

  float disc = 1.0 - smoothstep( 0.92, 1.02, sqrt( max( rr, 0.0 ) ) );
  vec3 n = vec3( uv, sqrt( max( 0.0, 1.0 - min( rr, 1.0 ) ) ) );
  vec3 L = normalize( vec3( 0.52, 0.30, 0.80 ) );          // waxing gibbous
  float lam = clamp( dot( n, L ), 0.0, 1.0 );

  float maria = vnoise3( vec3( uv * 1.6, 0.5 ) ) * 0.55 + vnoise3( vec3( uv * 4.3, 2.5 ) ) * 0.45;
  vec3 surf = vec3( 0.95, 0.93, 0.88 ) * ( 0.70 + 0.44 * maria );

  vec3 c = surf * disc * ( 0.035 + 1.05 * pow( lam, 0.55 ) );
  c += vec3( 0.62, 0.70, 0.92 ) * 0.020 * exp( -ang / 0.028 );   // halo
  c += vec3( 0.55, 0.64, 0.90 ) * 0.006 * exp( -ang / 0.16 );    // wide glow
  return c * uMoonBright;
}

void main() {
  vec3 dir = normalize( vDir );
  float dy = dir.y;
  vec3 sun = uSunDir;

  /* ---- scattering ---- */
  float sunfade = 1.0 - clamp( 1.0 - exp( sun.y / 0.9 ), 0.0, 1.0 );
  float rc = uRayleigh - ( 1.0 - sunfade );
  vec3 betaR = RAYLEIGH_BETA * rc;
  vec3 betaM = 0.434 * ( 0.2 * uTurbidity * 10E-18 ) * MIE_CONST * uMieCoefficient;

  float sunE = sunIntensity( sun.y ) * uSunE;

  float vy = max( dy, -0.06 );
  float zen = acos( clamp( vy, 0.0, 1.0 ) );
  float denom = cos( zen ) + 0.15 * pow( max( 1e-3, 93.885 - ( zen * 180.0 ) / PI ), -1.253 );
  vec3 Fex = exp( -( betaR * ( RAY_ZENITH / denom ) + betaM * ( MIE_ZENITH / denom ) ) );

  float cosT = dot( dir, sun );
  vec3 bRT = betaR * rayleighPhase( cosT * 0.5 + 0.5 );
  vec3 bMT = betaM * hgPhase( cosT, uMieG );
  vec3 beta = ( bRT + bMT ) / ( betaR + betaM );

  vec3 Lin = pow( max( vec3( 0.0 ), sunE * beta * ( 1.0 - Fex ) ), vec3( 1.5 ) );
  // three's Sky example multiplies the WHOLE dome by sqrt(sunE * beta * Fex)
  // whenever the sun is low. That factor is ~(1.58, 1.20, 0.81) at 8 deg of
  // elevation — it boosts red and crushes blue, which turns the mid-sky GREEN
  // at exactly the hours the game is photographed (measured: rgb(0.254, 0.341,
  // 0.268) at 8.3 deg, green dominant). The effect it is standing in for —
  // forward-scattered, heavily reddened light near the setting sun — belongs
  // only close to the sun and close to the horizon, so gate it on both.
  float sunward = pow( clamp( cosT * 0.5 + 0.5, 0.0, 1.0 ), 6.0 );
  float lowView = 1.0 - smoothstep( 0.02, 0.28, dy );
  float warmK = clamp( pow( max( 0.0, 1.0 - sun.y ), 5.0 ), 0.0, 1.0 ) * sunward * lowView;
  Lin *= mix( vec3( 1.0 ),
              pow( max( vec3( 0.0 ), sunE * beta * Fex ), vec3( 0.5 ) ),
              warmK );

  /* ---- sun disc with limb darkening ---- */
  float edge = smoothstep( SUN_COS - 0.0000075, SUN_COS + 0.0000075, cosT );
  float r = clamp( acos( clamp( cosT, -1.0, 1.0 ) ) / SUN_RAD, 0.0, 1.0 );
  float limb = mix( 1.0, pow( max( 0.0, 1.0 - r * r ), 0.28 ), 0.75 );
  float discGate = smoothstep( -0.006, 0.022, sun.y );   // no sun after it has set

  vec3 L0 = vec3( 0.1 ) * Fex * ( 1.0 - uNight );

  // The IBL capture writes into a half-float cube (max 65504) and is then
  // blurred by PMREM: a full-intensity sun disc overflows to Inf and the blur
  // smears that Inf across every direction, poisoning all indirect lighting.
  // The DirectionalLight already carries the sun's energy, so the capture keeps
  // only enough disc to give metals a believable specular highlight.
  #ifdef ENV_CAPTURE
    L0 += sunE * 200.0 * Fex * edge * limb * discGate;
  #else
    L0 += sunE * 17000.0 * Fex * edge * limb * discGate;
  #endif

  vec3 col = ( Lin + L0 ) * 0.04 * uSkyScale;

  /* ---- twilight: the warm band that survives after the sun is down ---- */
  if ( uTwilight > 0.0001 ) {
    float twAmt = smoothstep( 0.11, -0.02, sun.y ) * smoothstep( -0.32, -0.06, sun.y );
    if ( twAmt > 0.001 ) {
      vec2 dh = dir.xz, sh = sun.xz;
      float sunAz = dot( dh, sh ) / ( max( length( dh ), 1e-4 ) * max( length( sh ), 1e-4 ) );
      float band = pow( clamp( 1.0 - abs( dy ) * 3.0, 0.0, 1.0 ), 2.5 );
      float lobe = pow( clamp( sunAz * 0.5 + 0.5, 0.0, 1.0 ), 3.0 );
      vec3 warm = mix( vec3( 0.95, 0.34, 0.11 ), vec3( 0.52, 0.30, 0.52 ),
                       smoothstep( -0.02, -0.22, sun.y ) );
      col += warm * ( twAmt * band * lobe * uTwilight );
      // counter-twilight: the cool Belt of Venus opposite the sun
      col += vec3( 0.20, 0.20, 0.34 ) * ( twAmt * band * ( 1.0 - lobe ) * uTwilight * 0.42 );
    }
  }

  /* ---- night hemisphere ---- */
  if ( uNight > 0.001 ) {
    float t = clamp( dy * 1.9 + 0.08, 0.0, 1.0 );
    vec3 night = mix( vec3( 0.0125, 0.0182, 0.0340 ), vec3( 0.0042, 0.0068, 0.0158 ), t );

    float band = pow( clamp( 1.0 - abs( dy ) * 4.2, 0.0, 1.0 ), 2.2 );
    float az = atan( dir.z, dir.x );
    float lobes = 0.55 + 0.30 * sin( az * 2.3 + 1.1 ) + 0.15 * sin( az * 5.7 - 2.0 );
    night += uCityGlowColor * ( uCityGlow * band * lobes );

    night += starField( dir ) * uStars * smoothstep( 0.005, 0.16, dy );
    night += moonTerm( dir );

    col += night * uNight;
  }

  /* ---- overcast desaturation ---- */
  if ( uOvercast > 0.001 ) {
    float lum = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
    col = mix( col, vec3( lum ) * vec3( 1.02, 1.01, 1.0 ), uOvercast * 0.75 );
  }

  /* ---- below the horizon: plausible lit ground, so the IBL bottom hemisphere
          carries real bounce instead of black ---- */
  if ( dy < 0.0 ) {
    float k = clamp( -dy / 0.30, 0.0, 1.0 );
    k = k * k * ( 3.0 - 2.0 * k ) * 0.92;
    // The lower hemisphere is the city's own ground bounce, computed on the CPU
    // from the key light actually placed (albedo x (sun irradiance + sky)). At
    // golden hour that is a strong WARM term, and it is what stops shadows
    // reading cyan: a shadow lit only by a blue sky is not what a photograph of
    // sunlit concrete looks like.
    // Brightest just under the horizon, where the ground reflects sky at a
    // grazing angle, falling away as the view turns straight down.
    float grade = mix( 0.95, 0.45, clamp( -dy * 3.0, 0.0, 1.0 ) );
    col = mix( col, uGroundBounce * grade, k );
  }

  col = max( col, vec3( 0.0 ) );
  #ifdef ENV_CAPTURE
    col = min( col, vec3( 4000.0 ) );   // hard guard against half-float overflow
  #else
    // Bound what leaves the sky. Straight to the canvas this is invisible — AgX
    // clips the disc to white either way — but a composer feeds this radiance
    // into a half-float target and a bloom mip pyramid, where an unbounded sun
    // (~5.3e3 at golden hour, ~2.8e4 at noon) veils the entire frame and strips
    // the colour out of every facade. 1200 is still ~1000x the scene mean, so
    // the sun still reads as a sun and still blooms hard.
    col = min( col, vec3( 1200.0 ) );
  #endif

  gl_FragColor = vec4( col, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <dithering_fragment>
}
`;

export default { skyVert, skyFrag };
