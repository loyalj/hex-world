import * as THREE from 'three';
import { FOG_VERT_DECL, FOG_VERT_BODY, FOG_FRAG_DECL, fogUniforms } from './FogGLSL.js';

const vertexShader = /* glsl */`
  ${FOG_VERT_DECL}
  varying vec2 vUv;
  varying vec2 vWorldXZ;
  varying vec3 vColor;
  void main() {
    vUv = uv;
    vColor = color;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;
    ${FOG_VERT_BODY}
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  ${FOG_FRAG_DECL}
  varying vec2 vUv;
  varying vec2 vWorldXZ;
  varying vec3 vColor;

  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i),               hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  void main() {
    // Three-octave noise for dirt/gravel color variation
    float n = vnoise(vWorldXZ * 3.5)  * 0.6
            + vnoise(vWorldXZ * 10.0) * 0.3
            + vnoise(vWorldXZ * 26.0) * 0.1;
    float variation = (n - 0.5) * 0.18;

    // Low-frequency cloud noise: rough edges + subtle opacity patches
    float cloud = vnoise(vWorldXZ * 0.9) * 0.65
                + vnoise(vWorldXZ * 2.4) * 0.35;
    float edgeJitter = (cloud - 0.5) * 0.14;
    float blend = smoothstep(0.4 + edgeJitter, 0.68 + edgeJitter, vUv.x);
    blend *= 0.84 + cloud * 0.20;
    if (blend < 0.01) discard;

    gl_FragColor = vec4(clamp(vColor + variation, 0.0, 1.0) * vVisibility, clamp(blend, 0.0, 1.0) * vExplored);
  }
`;

export function createRoadMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...fogUniforms() },
    vertexShader,
    fragmentShader,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}
