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

    // Match the water surface exactly at V=0: same noise, same base color.
    float hl = waterNoise(vec3(vWorldXZ * 4.5, uTime * 0.1));
    vec3 waterColor = vec3(0.25, 0.44, 0.64) + hl * 0.2;

    // Foam fades in toward the land edge.
    float foam = Foam(shore, vWorldXZ, uTime);
    vec3 foamCol = vec3(0.92, 0.96, 1.00);

    vec3 color = mix(waterColor, foamCol, foam);

    gl_FragColor = vec4(color, 0.82);
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
