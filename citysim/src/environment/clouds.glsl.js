/**
 * environment/clouds.glsl.js — the cloud deck.
 *
 * Not a texture on a sphere: every fragment intersects its view ray with a
 * horizontal slab at `uCloudHeight` and evaluates domain-warped fBm at the
 * *world* position of that hit. That is what produces genuine perspective —
 * cells compress and elongate towards the horizon the way real cloud streets
 * do, and the deck slides correctly under a moving camera.
 *
 * Shading fakes a single scattering event: the density gradient towards the
 * sun drives lit/shadow, a forward-scatter lobe adds the silver lining, and
 * the whole thing dissolves into the horizon haze with distance.
 */

export const cloudVert = /* glsl */`
varying vec3 vDir;

void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

export const cloudFrag = /* glsl */`
#include <common>
#include <dithering_pars_fragment>

varying vec3 vDir;

uniform vec3  uSunDir;
uniform vec3  uLitColor;
uniform vec3  uShadowColor;
uniform vec3  uHazeColor;
uniform vec3  uRimColor;
uniform float uCoverage;      // 0..1
uniform float uDensity;       // edge hardness / opacity
uniform float uCloudHeight;   // metres above y=0
uniform float uScale;         // world → noise
uniform vec2  uWind;          // scrolled offset, metres
uniform float uDetail;        // high-frequency erosion amount
uniform float uOpacity;

float h21( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

float vnoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  return mix( mix( h21( i + vec2( 0.0, 0.0 ) ), h21( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( h21( i + vec2( 0.0, 1.0 ) ), h21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}

const mat2 ROT = mat2( 0.8, 0.6, -0.6, 0.8 );

float fbm( vec2 p, int oct ) {
  float a = 0.5, s = 0.0, n = 0.0;
  for ( int i = 0; i < 6; i++ ) {
    if ( i >= oct ) break;
    s += a * vnoise( p );
    n += a;
    p = ROT * p * 2.03;
    a *= 0.5;
  }
  return s / max( n, 1e-4 );
}

void main() {
  vec3 dir = normalize( vDir );
  if ( dir.y < 0.004 ) discard;

  float t = ( uCloudHeight - cameraPosition.y ) / dir.y;
  if ( t <= 0.0 ) discard;

  float fade = 1.0 - smoothstep( 26000.0, 90000.0, t );
  if ( fade <= 0.002 ) discard;

  vec2 p = ( cameraPosition.xz + dir.xz * t + uWind ) * uScale;

  // domain warp — kills the "noise texture" read entirely
  vec2 w = vec2( fbm( p * 0.42 + 13.7, 3 ), fbm( p * 0.42 - 7.1, 3 ) ) - 0.5;
  float n = fbm( p + w * 1.9, 5 );

  // fBm of value noise clusters tightly around 0.5, so a raw coverage threshold
  // only ever catches the top few per cent of the field. Stretch it about the
  // mean first, then coverage maps linearly onto sky fraction the way it reads.
  n = clamp( ( n - 0.5 ) * 2.3 + 0.5, 0.0, 1.0 );

  // erosion by a faster, finer layer gives billowed edges. Subtract about the
  // mean, not the raw value, or this silently eats half the coverage.
  float e = fbm( p * 3.7 - uWind * uScale * 0.6, 4 );
  n -= ( e - 0.5 ) * uDetail * 0.22;

  float thr = 1.0 - uCoverage;
  float d = smoothstep( thr - 0.02, thr + mix( 0.26, 0.07, uDensity ), n );
  if ( d <= 0.003 ) discard;

  // fake self-shadowing: compare density towards the sun
  vec2 so = normalize( uSunDir.xz + vec2( 1e-4 ) ) * 0.62;
  float ns = fbm( p + w * 1.9 + so, 4 );
  float lit = clamp( ( n - ns ) * 2.6 + 0.52 + uSunDir.y * 0.30, 0.0, 1.0 );
  lit = mix( lit, lit * 0.55 + 0.12, uCoverage * 0.7 );   // thick decks self-shadow more

  vec3 col = mix( uShadowColor, uLitColor, lit );

  // forward scattering — silver lining, strongest on thin edges near the sun
  float fwd = pow( max( 0.0, dot( dir, uSunDir ) ), 9.0 );
  col += uRimColor * fwd * ( 1.0 - lit ) * 1.15;
  col += uRimColor * fwd * 0.18;

  // aerial perspective on the deck itself
  float aer = smoothstep( 2500.0, 42000.0, t );
  col = mix( col, uHazeColor, aer * 0.85 );

  float horizon = smoothstep( 0.006, 0.085, dir.y );
  float a = d * fade * horizon * uOpacity;

  gl_FragColor = vec4( col, clamp( a, 0.0, 1.0 ) );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <dithering_fragment>
}
`;

export default { cloudVert, cloudFrag };
