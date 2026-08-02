import * as THREE from 'three';
import {
  WATER_GLSL, LIQUID_APPEARANCE_GLSL, liquidAppearanceUniforms,
  type LiquidColorOptions,
} from './WaterMaterial.js';
import { FOG_VERT_DECL, FOG_VERT_BODY, FOG_FRAG_DECL, fogUniforms } from './FogGLSL.js';

const vertexShader = /* glsl */`
  ${FOG_VERT_DECL}
  attribute vec2 uv2;
  varying vec2 vUv;
  varying vec2 vUv2;
  varying vec2 vWorldXZ;
  void main() {
    vUv  = uv;
    vUv2 = uv2;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;
    ${FOG_VERT_BODY}
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  ${FOG_FRAG_DECL}
  uniform float uTime;
  uniform vec3  uColor;
  uniform vec3  uFoamColor;
  varying vec2 vUv;    // UV1: (blend, shore)  blend=0 shore, blend=1 river
  varying vec2 vUv2;   // UV2: river flow coordinates
  varying vec2 vWorldXZ;

  ${WATER_GLSL}
  ${LIQUID_APPEARANCE_GLSL}

  void main() {
    float t = uTime * uFlowSpeed;
    float blend = vUv.x;  // 0 = shore side, 1 = river center
    float shore = vUv.y;  // 0 = water edge, 1 = land edge

    float hl = waterNoise(vec3(vWorldXZ * 4.5 * uWaveScale, t * 0.2));
    vec3 waterColor = uColor + hl * 0.2;

    // Shore side: foam at land edge (shore=1), water color at water edge (shore=0).
    float foam = clamp(Foam(shore, vWorldXZ, t) * uFoamIntensity, 0.0, 1.0);
    vec3 shoreColor = mix(waterColor, uFoamColor, foam);

    // River center: flowing pattern blended into water color.
    float river = River(vUv2, t);
    vec3 riverColor = mix(uColor, uFoamColor, river * 0.6);

    // blend=0 at outer edges (shore-like), blend=1 at river center.
    vec3 color = mix(shoreColor, riverColor, blend);

    gl_FragColor = liquidOutput(color, vVisibility, vExplored);
  }
`;

export function createEstuaryMaterial(colors?: LiquidColorOptions): THREE.ShaderMaterial {
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
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
  });
}
