import * as THREE from 'three';
import { FOG_VERT_DECL, FOG_VERT_BODY, FOG_FRAG_DECL, fogUniforms } from './FogGLSL.js';
import { CLOUD_GLSL, cloudShadowUniforms } from '../weather/CloudShadows.js';
import { ATMOSPHERE_GLSL, atmosphereUniforms } from '../sky/Atmosphere.js';
import {
  SEASON_VERT_DECL, SEASON_VERT_BODY, SEASON_FRAG_DECL, seasonUniforms, freezeUniforms,
} from '../season/SeasonGLSL.js';
// Type-only (erased at compile) — no runtime cycle with LiquidTypes.
import type { LiquidMaterialSet } from './LiquidTypes.js';

/**
 * Shared GLSL functions used by open water, shore, and estuary shaders.
 */
export const WATER_GLSL = /* glsl */`
  // --- 3D Simplex noise (Ashima Arts, MIT License) ---
  vec3 sn_mod289(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 sn_mod289(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 sn_permute(vec4 x) { return sn_mod289(((x*34.0)+1.0)*x); }
  vec4 sn_taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g  = step(x0.yzx, x0.xyz);
    vec3 l  = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = sn_mod289(i);
    vec4 p = sn_permute(sn_permute(sn_permute(
               i.z + vec4(0.0, i1.z, i2.z, 1.0))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
             + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3  ns = n_ * D.wyz - D.xzx;
    vec4 j  = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x  = x_ * ns.x + ns.yyyy;
    vec4 y  = y_ * ns.x + ns.yyyy;
    vec4 h  = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = sn_taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  float waterNoise(vec3 pos) {
    float result  = 0.0;
    float persMax = 0.0;
    for (int g = 0; g < 5; g++) {
      float freq = pow(2.0, float(g));
      float pers = pow(0.5, float(g));
      persMax += pers;
      result  += pers * snoise(freq * pos);
    }
    return result / persMax + 0.5;
  }

  float waveNoise(vec2 p, vec2 off) {
    return sin(p.x * 0.5 + off.x) * cos(p.y * 0.5 + off.y) * 0.5 + 0.5;
  }

  float Waves(vec2 worldXZ, float time) {
    vec2 uv1 = worldXZ; uv1.y += time;
    vec2 uv2 = worldXZ; uv2.x += time;
    float n1z = waveNoise(uv1, vec2(0.00, 0.00));
    float n1w = waveNoise(uv1, vec2(1.30, 0.90));
    float n2x = waveNoise(uv2, vec2(0.70, 2.10));
    float n2y = waveNoise(uv2, vec2(2.30, 0.30));
    float n1y = waveNoise(uv1, vec2(0.50, 1.70));
    float n2z = waveNoise(uv2, vec2(1.10, 0.70));
    float blendWave = sin((worldXZ.x + worldXZ.y) * 0.1 + (n1y + n2z) + time);
    blendWave *= blendWave;
    float waves = mix(n1z, n1w, blendWave) + mix(n2x, n2y, blendWave);
    return smoothstep(0.75, 2.0, waves);
  }

  float Foam(float shore, vec2 worldXZ, float time) {
    shore = sqrt(shore) * 0.9;
    vec2 noiseUV = worldXZ + time * 0.25;
    float n1 = sin(noiseUV.x * 0.3 + noiseUV.y * 0.2) * 0.5 + 0.5;
    float n2 = cos(noiseUV.x * 0.25 - noiseUV.y * 0.35 + 1.7) * 0.5 + 0.5;
    float distortion1 = n1 * (1.0 - shore);
    float foam1 = sin((shore + distortion1) * 10.0 - time);
    foam1 *= foam1;
    float distortion2 = n2 * (1.0 - shore);
    float foam2 = sin((shore + distortion2) * 10.0 + time + 2.0);
    foam2 *= foam2 * 0.7;
    return max(foam1, foam2) * shore;
  }

  float River(vec2 riverUV, float time) {
    vec2 uv1 = riverUV;
    uv1.x = uv1.x * 0.0625 + time * 0.005;
    uv1.y -= time * 0.25;
    float n1 = sin(uv1.x * 20.0) * cos(uv1.y * 20.0) * 0.5 + 0.5;
    vec2 uv2 = riverUV;
    uv2.x = uv2.x * 0.0625 - time * 0.0052;
    uv2.y -= time * 0.23;
    float n2 = sin(uv2.x * 20.0) * cos(uv2.y * 20.0) * 0.5 + 0.5;
    return n1 * n2;
  }
`;

// ---------------------------------------------------------------------------

/** Shared appearance uniform declarations + final-color helper for liquid shaders. */
export const LIQUID_APPEARANCE_GLSL = /* glsl */`
  uniform float uOpacity;
  uniform float uFlowSpeed;
  uniform float uWaveScale;
  uniform float uFoamIntensity;
  uniform vec3  uEmissive;
  uniform float uEmissiveStrength;
  uniform vec3  uLightTint;
  uniform vec3  uIceColor;
  uniform float uIceOpacity;

  // Drifting cloud shadows — the SAME field the terrain shader samples (a
  // WeatherSystem keeps offset/coverage in sync), so clouds darken lakes and
  // rivers in step with the ground under them.
  uniform float uCloudsEnabled;
  uniform vec2  uCloudOffset;
  uniform float uCloudScale;
  uniform float uCloudCoverage;
  uniform float uCloudOpacity;

  // The shared world wind, from the same Wind the clouds above drift by (see
  // setMaterialWind). uWindDrift is how far the ripple pattern has marched
  // downwind, in world units, integrated on the CPU so a change of wind turns
  // the surface rather than teleporting it; uWindChop is 0–1 surface wind, and
  // roughens the water and builds the surf as it rises.
  //
  // Only *open* water reads these. A river's direction is its channel's, not
  // the weather's — see RiverMaterial — so it and the estuary leave them alone
  // and a wind never runs a stream backwards uphill. Both are zero until a wind
  // drives them, which is what keeps a scene with none looking untouched.
  uniform vec2  uWindDrift;
  uniform float uWindChop;

  ${CLOUD_GLSL}
  ${ATMOSPHERE_GLSL}

  // Emissive is nearly exempt from fog dimming — a glowing surface should
  // punch through explored-but-unseen darkness at close to full strength
  // (hidden unexplored cells still vanish via the explored alpha term).
  // uLightTint is the scene-light tint (white by default; a day/night cycle
  // darkens it at night) — deliberately NOT applied to emissive, so lava and
  // acid keep glowing in the dark. Cloud shadows follow the same rule.
  // ice is how far this liquid has frozen at this cell, derived per material
  // from the climate temperature against its own freezePoint (see SeasonGLSL):
  // 0 open, 1 solid. Liquids with no freezePoint — lava, acid — always pass 0.
  vec4 liquidOutput(vec3 color, float visibility, float explored, vec2 worldXZ, float ice) {
    // Frozen liquid stops being liquid: it goes pale, its glow dies, and it
    // turns opaque enough to read as a surface you could stand on rather than
    // a window onto the bed below.
    color = mix(color, uIceColor, ice);

    vec3 tint = uLightTint;
    if (uCloudsEnabled > 0.5) {
      float cloud = cloudMask(cloudField(worldXZ, uCloudOffset, uCloudScale), uCloudCoverage);
      // Liquids are unlit, so scale the darkening by the ~55% of their light
      // budget that reads as direct sun — matching how the terrain keeps its
      // ambient share under full cloud.
      tint *= 1.0 - cloud * uCloudOpacity * 0.55;
    }
    vec3 lit = color * tint * visibility
             + uEmissive * uEmissiveStrength * mix(0.75, 1.0, visibility) * (1.0 - ice);
    // Distance haze last, and on color only: alpha is unchanged because the
    // terrain showing through a far lake is hazed to the same value anyway.
    return vec4(applyAtmosphere(lit, worldXZ), mix(uOpacity, uIceOpacity, ice) * explored);
  }

  // Pre-seasons signature, kept so custom liquid shaders built against the
  // exported GLSL keep compiling untouched.
  vec4 liquidOutput(vec3 color, float visibility, float explored, vec2 worldXZ) {
    return liquidOutput(color, visibility, explored, worldXZ, 0.0);
  }
`;

const vertexShader = /* glsl */`
  ${FOG_VERT_DECL}
  ${SEASON_VERT_DECL}
  attribute float depth;
  varying vec2  vWorldXZ;
  varying float vDepth;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;
    vDepth   = depth;
    ${FOG_VERT_BODY}
    ${SEASON_VERT_BODY}
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  ${FOG_FRAG_DECL}
  ${SEASON_FRAG_DECL}
  uniform float uTime;
  uniform vec3  uShallow;
  uniform vec3  uDeep;
  varying vec2  vWorldXZ;
  varying float vDepth;

  ${WATER_GLSL}
  ${LIQUID_APPEARANCE_GLSL}

  void main() {
    vec3 color = mix(uShallow, uDeep, vDepth);
    // Damp the moving highlight rather than the clock: scaling uTime would
    // rewind the wave's phase as ice forms, which reads as the lake flowing
    // backwards into winter.
    float hl = waterNoise(vec3((vWorldXZ + uWindDrift) * 4.5 * uWaveScale, uTime * uFlowSpeed * 0.2));
    // Wind roughens the surface as well as moving it — a lake under a storm
    // that only drifts faster still reads as a calm lake. Kept to a light touch
    // on the existing highlight rather than a second effect: this term rides on
    // top of a value that is already the brightest thing on the water, so it
    // reaches "visibly choppier" well before it reaches "obviously turned up".
    color += hl * 0.2 * (1.0 + 0.12 * uWindChop) * (1.0 - vIce);
    gl_FragColor = liquidOutput(color, vVisibility, vExplored, vWorldXZ, vIce);
  }
`;

/** Per-liquid color and appearance options for the four liquid material factories. */
export interface LiquidColorOptions {
  /** Shallow-water / surface liquid color. Default: blue-green water. */
  shallow?: THREE.Color;
  /** Deep-water color (surface material only). Default: dark blue. */
  deep?: THREE.Color;
  /** Foam / crest color (shore and estuary materials). Default: near-white. */
  foam?: THREE.Color;
  /** Surface alpha 0–1. Default 0.82 (0.78 for the river material). */
  opacity?: number;
  /** Animation time multiplier for waves/foam/flow. Default 1. */
  flowSpeed?: number;
  /** Self-illumination color, scaled by emissiveStrength. Default black. */
  emissive?: THREE.Color;
  /** Emissive intensity; only partially dimmed by fog-of-war. Default 0. */
  emissiveStrength?: number;
  /** Surface-noise frequency multiplier. Default 1. */
  waveScale?: number;
  /** Shore/estuary foam intensity multiplier. Default 1. */
  foamIntensity?: number;
  /**
   * Season-adjusted temperature at or below which this liquid freezes, on the
   * generator's 0–1 scale. Undefined means it never freezes — see
   * `LiquidTypeDescriptor.freezePoint`.
   */
  freezePoint?: number;
  /** Width of the transition around {@link LiquidColorOptions.freezePoint}. Default 0.06. */
  freezeBand?: number;
  /** Color a frozen surface blends toward. Default a pale blue-white. */
  iceColor?: THREE.Color;
  /**
   * Surface alpha once fully frozen. Higher than {@link LiquidColorOptions.opacity}
   * on purpose — ice you can see straight through reads as water that stopped
   * moving. Default 0.97.
   */
  iceOpacity?: number;
}

/** Builds the uniform set matching LIQUID_APPEARANCE_GLSL. */
export function liquidAppearanceUniforms(
  colors: LiquidColorOptions | undefined,
  defaultOpacity: number,
): Record<string, THREE.IUniform> {
  return {
    uOpacity:          { value: colors?.opacity          ?? defaultOpacity },
    uFlowSpeed:        { value: colors?.flowSpeed        ?? 1 },
    uWaveScale:        { value: colors?.waveScale        ?? 1 },
    uFoamIntensity:    { value: colors?.foamIntensity    ?? 1 },
    uEmissive:         { value: colors?.emissive         ?? new THREE.Color(0, 0, 0) },
    uEmissiveStrength: { value: colors?.emissiveStrength ?? 0 },
    uLightTint:        { value: new THREE.Color(1, 1, 1) },
    uWindDrift:        { value: new THREE.Vector2() },
    uWindChop:         { value: 0 },
    uIceColor:         { value: colors?.iceColor         ?? new THREE.Color(0xdce9f2) },
    uIceOpacity:       { value: colors?.iceOpacity       ?? 0.97 },
    ...cloudShadowUniforms(),
    ...atmosphereUniforms(),
    ...seasonUniforms(),
    ...freezeUniforms(colors?.freezePoint, colors?.freezeBand),
  };
}

/**
 * Push a scene-light tint onto every material in the given liquid material
 * sets (white = fully lit, dark blue = night). Emissive contributions are
 * unaffected — this is the day/night hook that lets lava glow after dark.
 * Custom materials without a uLightTint uniform are skipped.
 */
export function setLiquidLightTint(
  sets: Iterable<LiquidMaterialSet>,
  tint: THREE.Color,
): void {
  for (const set of sets) {
    // Inlined rather than using liquidMaterialList — importing it here would
    // make LiquidTypes a runtime dependency of this module, and it already
    // depends on us.
    for (const mat of [set.surface, set.shore, set.estuary, set.river, set.waterfallFoam, set.waterfallSpray]) {
      if (mat instanceof THREE.ShaderMaterial && mat.uniforms.uLightTint) {
        mat.uniforms.uLightTint.value.copy(tint);
      }
    }
  }
}

export function createWaterMaterial(colors?: LiquidColorOptions): THREE.ShaderMaterial {
  const shallow = colors?.shallow ?? new THREE.Color(0.32, 0.52, 0.70);
  const deep    = colors?.deep    ?? new THREE.Color(0.12, 0.28, 0.48);
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime:    { value: 0 },
      uShallow: { value: shallow },
      uDeep:    { value: deep },
      ...liquidAppearanceUniforms(colors, 0.82),
      ...fogUniforms(),
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.DoubleSide,
  });
}
