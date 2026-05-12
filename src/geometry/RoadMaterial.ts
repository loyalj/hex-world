import * as THREE from 'three';

const vertexShader = /* glsl */`
  varying vec2 vUv;
  varying vec2 vWorldXZ;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  varying vec2 vUv;
  varying vec2 vWorldXZ;

  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i),               hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  void main() {
    float blend = smoothstep(0.4, 0.7, vUv.x);
    if (blend < 0.01) discard;

    // Three-octave noise for dirt/gravel variation
    float n = vnoise(vWorldXZ * 3.5)  * 0.6
            + vnoise(vWorldXZ * 10.0) * 0.3
            + vnoise(vWorldXZ * 26.0) * 0.1;
    float variation = (n - 0.5) * 0.18;

    vec3 base = vec3(0.78, 0.64, 0.46);
    gl_FragColor = vec4(clamp(base + variation, 0.0, 1.0), blend);
  }
`;

export function createRoadMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}
