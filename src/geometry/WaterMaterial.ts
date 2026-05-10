import * as THREE from 'three';

const vertexShader = /* glsl */`
  varying vec2 vWorld;
  void main() {
    vWorld = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  uniform float uTime;
  varying vec2 vWorld;

  void main() {
    // Two noise layers with UV scrolled in opposite directions at slightly different
    // speeds, matching the Catlike Coding river shader technique (Part 6).
    vec2 uv1 = vWorld * 0.0625 + vec2(uTime * 0.005,  -uTime * 0.25);
    vec2 uv2 = vWorld * 0.0625 + vec2(-uTime * 0.0052, -uTime * 0.23);

    float n1 = sin(uv1.x * 20.0) * cos(uv1.y * 20.0) * 0.5 + 0.5;
    float n2 = sin(uv2.x * 20.0) * cos(uv2.y * 20.0) * 0.5 + 0.5;
    float wave = n1 * n2;   // 0..1, dynamic pattern from multiplied layers

    vec3 deep    = vec3(0.04, 0.20, 0.50);
    vec3 shallow = vec3(0.18, 0.48, 0.75);
    vec3 color   = mix(deep, shallow, wave);

    float spec = smoothstep(0.7, 1.0, wave) * 0.4;
    color += spec;

    gl_FragColor = vec4(color, 0.88);
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
