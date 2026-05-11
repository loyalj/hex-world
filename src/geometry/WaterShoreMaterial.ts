import * as THREE from 'three';
import { WATER_GLSL } from './WaterMaterial.js';

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
  uniform float uTime;
  varying vec2 vUv;
  varying vec2 vWorldXZ;

  ${WATER_GLSL}

  void main() {
    float shore = vUv.y;

    // Foam: distorted sine waves, stronger near the land edge.
    float foam = Foam(shore, vWorldXZ, uTime);

    // Open-water waves faded toward land (so they blend smoothly with shore foam).
    float waves = Waves(vWorldXZ, uTime);
    waves *= (1.0 - shore);

    float water = max(foam, waves);

    vec3 deep    = vec3(0.35, 0.50, 0.62);
    vec3 shallow = vec3(0.58, 0.72, 0.82);
    vec3 foamCol = vec3(0.92, 0.96, 1.00);

    // Blend between the base water color and white foam.
    vec3 color = mix(mix(deep, shallow, waves), foamCol, foam);
    color = clamp(color, 0.0, 1.0);

    gl_FragColor = vec4(color, 0.78);
  }
`;

export function createWaterShoreMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    side: THREE.DoubleSide,
  });
}
