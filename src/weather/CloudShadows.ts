import * as THREE from 'three';

/**
 * Shared cloud-field GLSL. The SAME field is sampled by the terrain shader
 * (to darken ground under clouds) and by PrecipitationLayer (to gate where
 * rain/snow falls), so precipitation visibly falls under the drifting clouds
 * that shade the terrain. Because the two consumers use different coverage
 * thresholds, light clouds can shade the ground without raining — only the
 * denser cores precipitate.
 */
export const CLOUD_GLSL = /* glsl */`
  float cw_hash(vec2 p) {
    return fract(sin(dot(p, vec2(157.31, 269.53))) * 43758.5453);
  }
  float cw_noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(cw_hash(i), cw_hash(i + vec2(1,0)), f.x),
               mix(cw_hash(i + vec2(0,1)), cw_hash(i + vec2(1,1)), f.x), f.y);
  }
  // Raw cloud density 0..1 at a world XZ point. offset is the accumulated
  // wind drift in world units; scale is the cloud feature size.
  float cloudField(vec2 worldXZ, vec2 offset, float scale) {
    vec2 uv = (worldXZ + offset) / max(scale, 1e-3);
    float n = cw_noise(uv) * 0.65 + cw_noise(uv * 2.63 + 19.17) * 0.35;
    // Two-octave value noise clusters tightly around 0.5 — stretch it toward
    // a uniform 0..1 spread so cloudMask's threshold selects roughly the
    // intended coverage fraction and clouds have real contrast. Without this
    // the shadows read as faint grey mush and the precipitation gate (which
    // thresholds high into the field) barely lets anything fall.
    return smoothstep(0.30, 0.70, n);
  }
  // Threshold the field so ~coverage of the ground is under cloud, with a
  // soft edge. coverage 0 -> no clouds, 1 -> overcast.
  float cloudMask(float field, float coverage) {
    float threshold = 1.0 - coverage;
    return smoothstep(threshold, threshold + 0.18, field);
  }
`;

/** Appearance of the drifting cloud shadows in the terrain shader. Unset fields keep their current value. */
export interface CloudShadowOptions {
  /** Show or hide cloud shadows. Defaults to true when configureTerrainClouds is called. */
  enabled?: boolean;
  /** Fraction of ground under cloud shadow, 0–1. Default 0.5. */
  coverage?: number;
  /** How dark a fully clouded point gets (0 = invisible, 1 = full sun blocked). Default 0.55. */
  opacity?: number;
  /** Cloud feature size in world units. Default 30 (a few distinct clouds per screen). */
  scale?: number;
}

/** Uniforms backing the cloud shadows in the terrain shader (clouds off until configured). */
export function cloudShadowUniforms(): Record<string, THREE.IUniform> {
  return {
    uCloudsEnabled: { value: 0 },
    uCloudOffset:   { value: new THREE.Vector2(0, 0) },
    uCloudScale:    { value: 30 },
    uCloudCoverage: { value: 0.5 },
    uCloudOpacity:  { value: 0.55 },
  };
}

/**
 * Configure the drifting cloud-shadow layer baked into the terrain shader.
 * Enabling/restyling is a uniform flip — no recompile. The drift itself is
 * CPU-driven: advance uCloudOffset each frame via {@link advanceTerrainClouds}
 * or a WeatherSystem (which also keeps precipitation in sync with the field).
 */
export function configureTerrainClouds(
  material: THREE.ShaderMaterial,
  opts: CloudShadowOptions = {},
): void {
  const u = material.uniforms;
  if (!u || !('uCloudsEnabled' in u)) return;
  if (opts.coverage !== undefined) u.uCloudCoverage.value = THREE.MathUtils.clamp(opts.coverage, 0, 1);
  if (opts.opacity  !== undefined) u.uCloudOpacity.value  = THREE.MathUtils.clamp(opts.opacity, 0, 1);
  if (opts.scale    !== undefined) u.uCloudScale.value    = Math.max(opts.scale, 1e-3);
  u.uCloudsEnabled.value = (opts.enabled ?? true) ? 1 : 0;
}

/** Show or hide the terrain cloud shadows without touching their styling. */
export function setTerrainCloudsEnabled(material: THREE.ShaderMaterial, enabled: boolean): void {
  const u = material.uniforms;
  if (u && 'uCloudsEnabled' in u) u.uCloudsEnabled.value = enabled ? 1 : 0;
}

/**
 * Drift the cloud field by wind (world units/sec) — call once per frame.
 * Standalone helper for à-la-carte scenes; WeatherSystem does this itself.
 */
export function advanceTerrainClouds(
  material: THREE.ShaderMaterial,
  wind: THREE.Vector2,
  dt: number,
): void {
  const u = material.uniforms;
  if (u && 'uCloudOffset' in u) u.uCloudOffset.value.addScaledVector(wind, dt);
}
