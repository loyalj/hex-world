import * as THREE from 'three';
import {
  WATER_GLSL, LIQUID_APPEARANCE_GLSL, liquidAppearanceUniforms,
  type LiquidColorOptions,
} from './WaterMaterial.js';
import { FOG_VERT_DECL, FOG_VERT_BODY, FOG_FRAG_DECL, fogUniforms } from './FogGLSL.js';

// ---------------------------------------------------------------------------
// Plunge-pool foam
// ---------------------------------------------------------------------------

const foamVertexShader = /* glsl */`
  ${FOG_VERT_DECL}
  varying vec2 vUv;
  varying vec2 vWorldXZ;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;
    ${FOG_VERT_BODY}
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const foamFragmentShader = /* glsl */`
  ${FOG_FRAG_DECL}
  uniform float uTime;
  uniform vec3  uColor;
  uniform vec3  uFoamColor;
  varying vec2 vUv;
  varying vec2 vWorldXZ;

  ${WATER_GLSL}
  ${LIQUID_APPEARANCE_GLSL}

  void main() {
    float t = uTime * uFlowSpeed;
    float r = vUv.y;                       // 0 at the impact point, 1 at the rim

    // Rings pushed outward from the impact point, torn apart by the shared
    // water noise so the pool churns instead of pulsing like a target.
    float rings = sin(r * 13.0 - t * 3.4) * 0.5 + 0.5;
    float churn = waterNoise(vec3(vWorldXZ * 3.4 * uWaveScale, t * 0.5));
    float edge  = 1.0 - smoothstep(0.15, 1.0, r);
    float foam  = clamp(edge * mix(0.35, 1.15, rings * churn) * uFoamIntensity, 0.0, 1.0);
    if (foam < 0.012) discard;

    vec3 color = mix(uColor, uFoamColor, foam);
    vec4 lit   = liquidOutput(color, vVisibility, vExplored, vWorldXZ);
    gl_FragColor = vec4(lit.rgb, lit.a * foam);
  }
`;

/**
 * The churning foam pool at the foot of a waterfall — drawn over the receiving
 * channel by {@link buildWaterfallFoamGeometry}'s elliptical fan, fading to
 * nothing at the rim so it blends into the river rather than stamping a disc
 * on it. Honours the same descriptor appearance fields as the other liquid
 * layers, so `foamIntensity: 0` turns it off and lava's slow `flowSpeed`
 * makes its pool churn as sluggishly as its surface.
 */
export function createWaterfallFoamMaterial(colors?: LiquidColorOptions): THREE.ShaderMaterial {
  const color     = colors?.shallow ?? new THREE.Color(0.42, 0.60, 0.74);
  const foamColor = colors?.foam    ?? new THREE.Color(0.94, 0.98, 1.00);
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime:      { value: 0 },
      uColor:     { value: color },
      uFoamColor: { value: foamColor },
      ...liquidAppearanceUniforms(colors, 0.85),
      ...fogUniforms(),
    },
    vertexShader:   foamVertexShader,
    fragmentShader: foamFragmentShader,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -5,
    polygonOffsetUnits: -5,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// Spray / mist particles
// ---------------------------------------------------------------------------

const sprayVertexShader = /* glsl */`
  ${FOG_VERT_DECL}
  uniform float uTime;
  uniform float uFlowSpeed;
  uniform float uOpacity;
  uniform float uRate;
  uniform float uRise;
  uniform float uSway;
  uniform float uArc;
  uniform float uDrift;
  uniform float uSize;

  attribute float aSeed;
  attribute vec4  aSite;   // xy = flow direction, z = channel half-width, w = drop height

  varying float vAlpha;
  varying vec2  vWorldXZ;

  float sprayHash(float n) { return fract(sin(n) * 43758.5453123); }

  void main() {
    vec2 dir   = aSite.xy;
    vec2 right = vec2(-dir.y, dir.x);
    float halfW = aSite.z;
    float drop  = aSite.w;

    float h1 = sprayHash(aSeed *  91.7 + 1.3);   // spawn across the channel
    float h2 = sprayHash(aSeed *  37.3 + 4.1);   // launch energy / drift
    float h3 = sprayHash(aSeed * 157.1 + 8.7);   // lifetime rate, veil depth
    float h4 = sprayHash(aSeed * 211.3 + 2.9);   // spawn along the flow
    float h5 = sprayHash(aSeed *  73.9 + 6.5);   // spawn height

    // Each particle runs its own looping 0→1 lifetime, offset by its seed so a
    // fall emits continuously instead of pulsing whole batches at once.
    float life = fract(uTime * uRate * uFlowSpeed * (0.7 + 0.6 * h3) + aSeed * 7.13);

    // A minority of particles are veil mist clinging to the falling sheet;
    // the rest are the plume kicked up where it lands.
    float veil = step(0.74, aSeed);

    // Spawn across a VOLUME, not a point. Emitting every particle from the
    // impact point stacks them into one saturated blob however low their
    // individual alpha is; a slim headwater still needs a visible puff, hence
    // the floor under the channel-derived term.
    vec3 p = position;
    float spread = halfW + 0.14;
    p.xz += right * (h1 - 0.5) * 2.0 * spread
          + dir   * (h4 - 0.5) * 1.4 * spread;

    // Plume particles are born at the pool, veil particles partway up the
    // cliff face and slightly upstream of it, hugging the sheet.
    p.y  += mix(h5 * 0.12, drop * (0.10 + 0.70 * h3), veil);
    p.xz -= dir * veil * (0.10 + 0.22 * h3);

    // "Spray" covers two different physical things, blended by uArc.
    //
    // Mist RISES (uArc 0): monotonic climb, no gravity, slower for the veil
    // clinging to the face. Molten spatter is THROWN (uArc 1): a real
    // ballistic arc that peaks mid-life and falls back to where it started.
    // The arc is written as k·life·(1−life) so it lands at life 1 for any k —
    // gravity is implicit and scales with uRise, keeping the trajectory the
    // same shape at every energy instead of needing its own uniform.
    float climb = uRise * life * (0.6 + 0.8 * h2) * mix(1.0, 0.55, veil);
    float toss  = uRise * (3.0 + 2.5 * h2) * life * (1.0 - life);

    // Turbulent wander stands in for the eddies coming off the sheet. Scaled
    // by life so a puff leaves the source tight and frays as it rises — and
    // all but switched off for spatter, which follows its throw, not the air.
    vec2 wander = uSway * life * (1.0 - 0.85 * uArc) * vec2(
      sin(uTime * 0.9 + aSeed * 41.0 + climb * 2.6),
      cos(uTime * 0.7 + aSeed * 27.0 + climb * 2.2)
    );

    p.y  += mix(climb, toss, uArc);
    p.xz += wander + dir * uDrift * life * (0.4 + 0.7 * h2)
          // Spatter also flies outward from the impact, which mist does not.
          + (right * (h1 - 0.5) + dir * (h4 - 0.5)) * uArc * spread * 1.6 * life;

    ${FOG_VERT_BODY}

    // Mist is born small and fairly solid, then swells and thins as it climbs
    // — the read that makes a puff dissipate instead of pop. A thrown droplet
    // does neither: it holds its size and opacity and then is simply gone.
    float decay = mix(pow(1.0 - life, 1.25), 1.0 - smoothstep(0.55, 1.0, life), uArc);
    float fade  = smoothstep(0.0, 0.07, life) * decay;
    vAlpha   = uOpacity * fade * mix(1.0, 0.7, veil);
    vWorldXZ = (modelMatrix * vec4(p, 1.0)).xz;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float grow = mix(0.35 + life * 1.95, 1.0 + life * 0.15, uArc) * mix(1.0, 1.2, veil);
    // Perspective attenuation is CLAMPED: an RTS camera can get within a few
    // units of a fall, where an unbounded 1/z would inflate one particle to
    // fill the screen. 7× is about where a puff still reads as mist up close.
    float atten = min(110.0 / max(-mv.z, 1.0), 7.0);
    gl_PointSize = uSize * grow * atten;
    gl_Position = projectionMatrix * mv;
  }
`;

const sprayFragmentShader = /* glsl */`
  ${FOG_FRAG_DECL}
  uniform vec3 uFoamColor;
  varying float vAlpha;
  varying vec2  vWorldXZ;

  ${LIQUID_APPEARANCE_GLSL}

  void main() {
    // Falloff runs all the way to the center — no flat plateau, or overlapping
    // particles composite into a hard-edged ball instead of building haze.
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = vAlpha * smoothstep(1.0, 0.0, d) * vExplored;
    if (a < 0.006) discard;
    // Colour (not alpha) comes from the shared liquid path, so mist picks up
    // the day/night tint, cloud shadows, and any emissive glow the liquid has.
    vec4 lit = liquidOutput(uFoamColor, vVisibility, vExplored, vWorldXZ);
    gl_FragColor = vec4(lit.rgb, a);
  }
`;

/** Tuning for the waterfall spray particle animation. */
export interface WaterfallSprayMaterialOptions extends LiquidColorOptions {
  /** Particle lifetime cycles per second (before `flowSpeed`). Default 0.9. */
  rate?: number;
  /**
   * How far a puff climbs (or, at `arc` 1, how high it is thrown), world
   * units. Default 0.75.
   */
  rise?: number;
  /** Turbulent horizontal wander amplitude, world units. Default 0.13. */
  sway?: number;
  /**
   * Rises-vs-thrown, 0–1. See {@link LiquidTypeDescriptor.sprayArc}. Default 0.
   */
  arc?: number;
  /** Downstream drift over a particle's life, world units. Default 0.55. */
  drift?: number;
  /**
   * Base point size in pixels at 110 world units of depth (attenuation is
   * clamped at 6×, so this is not the on-screen size up close). Default 3.5.
   */
  size?: number;
}

/**
 * Mist rising off the point where a waterfall lands, plus a thinner veil
 * clinging to the sheet itself. Puffs are born small and fairly solid and
 * swell as they thin, wandering on turbulence rather than following a
 * trajectory — they are not thrown, so there is no arc and no gravity term.
 * Drawn as `THREE.Points` over the geometry from
 * {@link buildWaterfallSprayGeometry}; every particle's motion is computed in
 * this vertex shader from `uTime`, so the CPU cost per frame is one uniform
 * write no matter how many falls are on screen.
 *
 * Depth-tested (a ridge in front of the fall occludes its mist) but never
 * depth-writing, so particles composite against each other without popping.
 */
export function createWaterfallSprayMaterial(
  colors?: WaterfallSprayMaterialOptions,
): THREE.ShaderMaterial {
  const foamColor = colors?.foam ?? new THREE.Color(0.96, 0.99, 1.00);
  const arc = Math.min(1, Math.max(0, colors?.arc ?? 0));
  // Mist piles up at the impact point, so each puff has to stay faint or the
  // stack saturates to solid white. Thrown droplets separate as they fly and
  // want to read as matter, not haze — so the ceiling rises with `arc`.
  const maxAlpha = 0.34 + 0.36 * arc;
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime:      { value: 0 },
      uFoamColor: { value: foamColor },
      uRate:      { value: colors?.rate  ?? 0.9 },
      uRise:      { value: colors?.rise  ?? 0.75 },
      uSway:      { value: colors?.sway  ?? 0.13 },
      uArc:       { value: arc },
      uDrift:     { value: colors?.drift ?? 0.55 },
      uSize:      { value: colors?.size  ?? 4.5 },
      ...liquidAppearanceUniforms(colors, maxAlpha),
      uOpacity:   { value: Math.min(colors?.opacity ?? maxAlpha, maxAlpha) },
      ...fogUniforms(),
    },
    vertexShader:   sprayVertexShader,
    fragmentShader: sprayFragmentShader,
    transparent: true,
    depthWrite: false,
  });
}
