import * as THREE from 'three';
import { WATER_GLSL } from './WaterMaterial.js';
import { FOG_VERT_DECL, FOG_VERT_BODY, FOG_FRAG_DECL, fogUniforms } from './FogGLSL.js';

const vertexShader = /* glsl */`
  ${FOG_VERT_DECL}
  varying vec2 vUv;
  void main() {
    vUv = uv;
    ${FOG_VERT_BODY}
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  ${FOG_FRAG_DECL}
  uniform float uTime;
  varying vec2 vUv;

  ${WATER_GLSL}

  void main() {
    float r = River(vUv, uTime);

    vec3 deep    = vec3(0.35, 0.50, 0.62);
    vec3 shallow = vec3(0.58, 0.72, 0.82);
    vec3 color   = mix(deep, shallow, r);

    gl_FragColor = vec4(color * vVisibility, 0.78 * vExplored);
  }
`;

export function createRiverMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, ...fogUniforms() },
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
