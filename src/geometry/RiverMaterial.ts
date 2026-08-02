import * as THREE from 'three';
import {
  WATER_GLSL, LIQUID_APPEARANCE_GLSL, liquidAppearanceUniforms,
  type LiquidColorOptions,
} from './WaterMaterial.js';
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
  uniform vec3  uDeep;
  uniform vec3  uShallow;
  varying vec2 vUv;

  ${WATER_GLSL}
  ${LIQUID_APPEARANCE_GLSL}

  void main() {
    float r    = River(vUv, uTime * uFlowSpeed);
    vec3 color = mix(uDeep, uShallow, r);
    gl_FragColor = liquidOutput(color, vVisibility, vExplored);
  }
`;

export function createRiverMaterial(colors?: LiquidColorOptions): THREE.ShaderMaterial {
  const deep    = colors?.deep    ?? new THREE.Color(0.35, 0.50, 0.62);
  const shallow = colors?.shallow ?? new THREE.Color(0.58, 0.72, 0.82);
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime:    { value: 0 },
      uDeep:    { value: deep },
      uShallow: { value: shallow },
      ...liquidAppearanceUniforms(colors, 0.78),
      ...fogUniforms(),
    },
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
