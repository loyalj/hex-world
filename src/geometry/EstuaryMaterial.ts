import * as THREE from 'three';
import { WATER_GLSL } from './WaterMaterial.js';

const vertexShader = /* glsl */`
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
    float blend = vUv.x;  // 0 = pure shore effect, 1 = pure river effect
    float shore = vUv.y;  // 0 = water edge, 1 = land edge

    float foam  = Foam(shore, vWorldXZ, uTime);
    float waves = Waves(vWorldXZ, uTime);
    waves *= (1.0 - sqrt(shore));
    float shoreWater = max(foam, waves);

    float river = River(vUv2, uTime);

    float water = mix(shoreWater, river, blend);

    vec3 deep    = vec3(0.35, 0.50, 0.62);
    vec3 shallow = vec3(0.58, 0.72, 0.82);
    vec3 foamCol = vec3(0.92, 0.96, 1.00);

    vec3 color = mix(mix(deep, shallow, waves), foamCol, foam);
    color = mix(color, mix(deep, shallow, river), blend);
    color = clamp(color, 0.0, 1.0);

    gl_FragColor = vec4(color, 0.78);
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
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    side: THREE.DoubleSide,
  });
}
