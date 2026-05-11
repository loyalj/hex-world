import * as THREE from 'three';
import { WATER_GLSL } from './WaterMaterial.js';

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  uniform float uTime;
  varying vec2 vUv;

  ${WATER_GLSL}

  void main() {
    float r = River(vUv, uTime);

    vec3 deep    = vec3(0.35, 0.50, 0.62);
    vec3 shallow = vec3(0.58, 0.72, 0.82);
    vec3 color   = mix(deep, shallow, r);

    gl_FragColor = vec4(color, 0.78);
  }
`;

export function createRiverMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
  });
}
