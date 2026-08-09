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
    vec3 waterColor = uColor + hl * 0.2 * (1.0 - vIce);

    // Tutorial Part 8 composition: the fan is filled by wave crests rolling
    // toward the shore, foam takes over at the land edge, and the river's
    // flow pattern radiates from the mouth (blend=1). Unlike the tutorial our
    // open water has no Waves term, so the crests are enveloped to fade out
    // before the fan's open-water edge instead of stopping there abruptly.
    float foam  = Foam(shore, vWorldXZ, t);
    // ×6: the tutorial's Waves wavelength suits its ~10-unit hexes; ours are
    // size 1, so compress the pattern to get visible crests across one fan.
    float waves = Waves(vWorldXZ * 6.0 * uWaveScale, t)
                * (1.0 - shore) * smoothstep(0.0, 0.45, shore);
    float shoreWater = max(foam, waves);
    float river = River(vUv2, t);
    float water = mix(shoreWater, river, blend);

    vec3 color = mix(waterColor, uFoamColor, clamp(water * uFoamIntensity, 0.0, 1.0));
    gl_FragColor = liquidOutput(color, vVisibility, vExplored, vWorldXZ);
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
