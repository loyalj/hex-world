import * as THREE from 'three';
import { WATER_GLSL } from './WaterMaterial.js';
import { FOG_VERT_DECL, FOG_VERT_BODY, FOG_FRAG_DECL, fogUniforms } from './FogGLSL.js';

const vertexShader = /* glsl */`
  ${FOG_VERT_DECL}
  varying vec2 vUv;
  varying vec2 vWorldXZ;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;
    ${FOG_VERT_BODY}
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  ${FOG_FRAG_DECL}
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

    gl_FragColor = vec4(color * vVisibility, 0.82 * vExplored);
  }
`;

export function createWaterShoreMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, ...fogUniforms() },
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
