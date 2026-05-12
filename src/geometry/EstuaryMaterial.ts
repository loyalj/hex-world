import * as THREE from 'three';
import { WATER_GLSL } from './WaterMaterial.js';

const vertexShader = /* glsl */`
  attribute vec2 uv2;
  varying vec2 vUv;
  varying vec2 vUv2;
  varying vec2 vWorldXZ;
  void main() {
    vUv  = uv;
    vUv2 = uv2;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  uniform float uTime;
  varying vec2 vUv;    // UV1: (blend, shore)  blend=0 shore, blend=1 river
  varying vec2 vUv2;   // UV2: river flow coordinates
  varying vec2 vWorldXZ;

  ${WATER_GLSL}

  void main() {
    float blend = vUv.x;  // 0 = shore side, 1 = river center
    float shore = vUv.y;  // 0 = water edge, 1 = land edge

    vec3 foamCol = vec3(0.92, 0.96, 1.00);

    float hl = waterNoise(vec3(vWorldXZ * 4.5, uTime * 0.2));
    vec3 waterColor = vec3(0.25, 0.44, 0.64) + hl * 0.2;

    // Shore side: foam at land edge (shore=1), water color at water edge (shore=0).
    float foam = Foam(shore, vWorldXZ, uTime);
    vec3 shoreColor = mix(waterColor, foamCol, foam);

    // River center: flowing pattern blended into water color.
    float river = River(vUv2, uTime);
    vec3 riverColor = mix(vec3(0.25, 0.44, 0.64), foamCol, river * 0.6);

    // blend=0 at outer edges (shore-like), blend=1 at river center.
    vec3 color = mix(shoreColor, riverColor, blend);

    gl_FragColor = vec4(color, 0.82);
  }
`;

export function createEstuaryMaterial(): THREE.ShaderMaterial {
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
