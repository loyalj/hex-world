import * as THREE from 'three';

/**
 * Shared GLSL functions used by open water, shore, and estuary shaders.
 *
 * Waves() — two scrolling noise layers plus a diagonal blend wave, matching the
 *   Part 8 "Blend Waves" approach. Uses procedural sin/cos instead of a texture.
 *
 * Foam() — two distorted sine waves advancing/receding from shore (V coordinate).
 *   Distortion grows weaker near shore so it better matches the coastline.
 *
 * River() — two-layer scroll using river UV (u scrolls slowly, v flows fast).
 */
export const WATER_GLSL = /* glsl */`
  // One "channel" of procedural noise, analogous to a texture channel.
  float waveNoise(vec2 p, vec2 off) {
    return sin(p.x * 0.5 + off.x) * cos(p.y * 0.5 + off.y) * 0.5 + 0.5;
  }

  // Open-water wave pattern from Part 8 "Blend Waves".
  // worldXZ: raw world-space XZ position; time: uTime in seconds.
  float Waves(vec2 worldXZ, float time) {
    vec2 uv1 = worldXZ;
    uv1.y += time;
    vec2 uv2 = worldXZ;
    uv2.x += time;

    float n1z = waveNoise(uv1, vec2(0.00, 0.00));
    float n1w = waveNoise(uv1, vec2(1.30, 0.90));
    float n2x = waveNoise(uv2, vec2(0.70, 2.10));
    float n2y = waveNoise(uv2, vec2(2.30, 0.30));
    float n1y = waveNoise(uv1, vec2(0.50, 1.70));
    float n2z = waveNoise(uv2, vec2(1.10, 0.70));

    float blendWave = sin(
      (worldXZ.x + worldXZ.y) * 0.1 +
      (n1y + n2z) + time
    );
    blendWave *= blendWave;

    float waves = mix(n1z, n1w, blendWave) + mix(n2x, n2y, blendWave);
    return smoothstep(0.75, 2.0, waves);
  }

  // Shore foam from Part 8 "Shore Foam" + "More Shore Water".
  // shore: raw UV.y (0=water edge, 1=land edge).
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

  // River flow from Part 8 "River Shader Function".
  // riverUV: flow-space UV (U across channel, V downstream).
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

const vertexShader = /* glsl */`
  varying vec2 vWorldXZ;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  uniform float uTime;
  varying vec2 vWorldXZ;

  ${WATER_GLSL}

  void main() {
    float waves = Waves(vWorldXZ, uTime);

    vec3 deep    = vec3(0.35, 0.50, 0.62);
    vec3 shallow = vec3(0.58, 0.72, 0.82);
    vec3 color   = mix(deep, shallow, waves);

    float spec = smoothstep(0.7, 1.0, waves) * 0.3;
    color += spec;

    gl_FragColor = vec4(color, 0.78);
  }
`;

export function createWaterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
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
