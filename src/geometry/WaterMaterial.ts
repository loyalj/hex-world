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

  // 5-octave fractal simplex noise, output in [0,1].
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
  // --- end simplex noise ---

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
  attribute float depth;
  varying vec2  vWorldXZ;
  varying float vDepth;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;
    vDepth   = depth;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  uniform float uTime;
  varying vec2  vWorldXZ;
  varying float vDepth;

  ${WATER_GLSL}

  void main() {
    vec3 shallow = vec3(0.32, 0.52, 0.70);
    vec3 deep    = vec3(0.12, 0.28, 0.48);
    vec3 color   = mix(shallow, deep, vDepth);

    float hl = waterNoise(vec3(vWorldXZ * 4.5, uTime * 0.2));
    color += hl * 0.2;
    gl_FragColor = vec4(color, 0.82);
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
