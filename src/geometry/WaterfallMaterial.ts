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
  uniform float uGravity;
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

    float h1 = sprayHash(aSeed *  91.7 + 1.3);
    float h2 = sprayHash(aSeed *  37.3 + 4.1);
    float h3 = sprayHash(aSeed * 157.1 + 8.7);

    // Each particle runs its own looping 0→1 lifetime, offset by its seed so a
    // fall emits continuously instead of pulsing whole batches at once.
    float life = fract(uTime * uRate * uFlowSpeed * (0.7 + 0.6 * h3) + aSeed * 7.13);

    // A minority of particles are veil mist clinging to the falling sheet;
    // the rest are the plume kicked up where it lands.
    float veil = step(0.74, aSeed);

    vec3 p = position;
    p.xz += right * (h1 - 0.5) * 2.0 * halfW * 1.2;

    // Plume: ballistic arc up and downstream, spreading as it goes.
    vec3 plume = vec3(0.0);
    plume.y  = uRise * (0.55 + 0.9 * h2) * sqrt(life) - uGravity * life * life;
    plume.xz = dir * uDrift * life * (0.5 + h2);

    // Veil: born partway up the cliff face, sliding down it and drifting out.
    // Clamped at the pool so a long-lived flake never sinks through the water.
    vec3 mist = vec3(0.0);
    mist.y  = max(0.0, drop * (0.15 + 0.75 * h2) - drop * 0.6 * life);
    mist.xz = -dir * ((0.10 + 0.25 * h3) - uDrift * 0.25 * life);

    p += mix(plume, mist, veil);

    ${FOG_VERT_BODY}

    float fade = smoothstep(0.0, 0.18, life) * (1.0 - smoothstep(0.45, 1.0, life));
    vAlpha   = uOpacity * fade * mix(1.0, 0.6, veil);
    vWorldXZ = (modelMatrix * vec4(p, 1.0)).xz;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float grow = mix(0.6 + life * 2.4, 0.9 + life * 0.7, veil);
    gl_PointSize = uSize * grow * (110.0 / max(-mv.z, 1.0));
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
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = vAlpha * smoothstep(1.0, 0.3, d) * vExplored;
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
  /** Upward launch height of the plume, world units. Default 0.75. */
  rise?: number;
  /**
   * Downward pull applied over a particle's life, world units. Defaults to
   * two thirds of `rise`, which keeps the arc the same shape at any launch
   * height — so `rise` alone reads as "how energetic is this liquid". Set it
   * explicitly only to make a liquid fall faster or slower than it is thrown.
   */
  gravity?: number;
  /** Downstream drift over a particle's life, world units. Default 0.55. */
  drift?: number;
  /** Base point size in pixels at 110 world units of depth. Default 7. */
  size?: number;
}

/**
 * Mist thrown up where a waterfall lands, plus a thinner veil drifting down
 * the sheet itself. Drawn as `THREE.Points` over the geometry from
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
  const rise      = colors?.rise ?? 0.75;
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime:      { value: 0 },
      uFoamColor: { value: foamColor },
      uRate:      { value: colors?.rate    ?? 0.9 },
      uRise:      { value: rise },
      uGravity:   { value: colors?.gravity ?? rise * (2 / 3) },
      uDrift:     { value: colors?.drift   ?? 0.55 },
      uSize:      { value: colors?.size    ?? 7 },
      ...liquidAppearanceUniforms(colors, 0.6),
      // Spray is a haze, not a surface — cap its alpha below the liquid's own
      // so a fall reads as mist even for an opaque liquid like lava.
      uOpacity:   { value: Math.min(colors?.opacity ?? 0.6, 0.6) },
      ...fogUniforms(),
    },
    vertexShader:   sprayVertexShader,
    fragmentShader: sprayFragmentShader,
    transparent: true,
    depthWrite: false,
  });
}
