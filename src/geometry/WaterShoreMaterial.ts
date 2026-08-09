import * as THREE from 'three';
import {
  WATER_GLSL, LIQUID_APPEARANCE_GLSL, liquidAppearanceUniforms,
  type LiquidColorOptions,
} from './WaterMaterial.js';
import { FOG_VERT_DECL, FOG_VERT_BODY, FOG_FRAG_DECL, fogUniforms } from './FogGLSL.js';
import { SEASON_VERT_DECL, SEASON_VERT_BODY, SEASON_FRAG_DECL } from '../season/SeasonGLSL.js';

const vertexShader = /* glsl */`
  ${FOG_VERT_DECL}
  ${SEASON_VERT_DECL}
  varying vec2 vUv;
  varying vec2 vWorldXZ;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;
    ${FOG_VERT_BODY}
    ${SEASON_VERT_BODY}
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  ${FOG_FRAG_DECL}
  ${SEASON_FRAG_DECL}
  uniform float uTime;
  uniform vec3  uColor;
  uniform vec3  uFoamColor;
  varying vec2 vUv;
  varying vec2 vWorldXZ;

  ${WATER_GLSL}
  ${LIQUID_APPEARANCE_GLSL}

  void main() {
    float t = uTime * uFlowSpeed;
    float shore = vUv.y;

    float hl = waterNoise(vec3((vWorldXZ + uWindDrift) * 4.5 * uWaveScale, t * 0.1));
    // Same light touch as the open surface, and the same factor — a shoreline
    // that roughened harder than the water it joins would show the seam.
    vec3 waterColor = uColor + hl * 0.2 * (1.0 + 0.12 * uWindChop) * (1.0 - vIce);

    // Surf is the first thing a freeze takes: no waves reaching the shore, no
    // foam where they used to break. What's left is the pale rime the ice
    // color supplies further down.
    //
    // Wind thickens it but does not move it: the foam band is anchored to the
    // shoreline it breaks on, so it takes uWindChop and not uWindDrift.
    float foam = clamp(Foam(shore, vWorldXZ, t) * uFoamIntensity * (1.0 + 0.07 * uWindChop), 0.0, 1.0) * (1.0 - vIce);
    vec3 color = mix(waterColor, uFoamColor, foam);

    gl_FragColor = liquidOutput(color, vVisibility, vExplored, vWorldXZ, vIce);
  }
`;

export function createWaterShoreMaterial(colors?: LiquidColorOptions): THREE.ShaderMaterial {
  const color     = colors?.shallow ?? new THREE.Color(0.25, 0.44, 0.64);
  const foamColor = colors?.foam    ?? new THREE.Color(0.92, 0.96, 1.00);
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime:      { value: 0 },
      uColor:     { value: color },
      uFoamColor: { value: foamColor },
      ...liquidAppearanceUniforms(colors, 0.82),
      ...fogUniforms(),
    },
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
