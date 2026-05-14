import * as THREE from 'three';

/** Fog-of-war GLSL fragment for GLSL1-style vertex shaders. Inject into the shader source. */

export const FOG_VERT_DECL = /* glsl */`
  attribute float cellIndex;
  uniform sampler2D uFogData;
  uniform vec2 uFogDataSize;
  uniform float uFogEnabled;
  uniform float uHideUnexplored;
  uniform float uDimExplored;
  varying float vVisibility;
  varying float vExplored;
`;

export const FOG_VERT_BODY = /* glsl */`
  if (uFogEnabled > 0.5) {
    float _fx = mod(cellIndex, uFogDataSize.x);
    float _fy = floor(cellIndex / uFogDataSize.x);
    vec4 _fd = texture2D(uFogData, (vec2(_fx, _fy) + 0.5) / uFogDataSize);
    vExplored   = uHideUnexplored > 0.5 ? _fd.b : 1.0;
    vVisibility = uDimExplored    > 0.5 ? mix(0.25, 1.0, _fd.r) : 1.0;
  } else {
    vVisibility = 1.0;
    vExplored   = 1.0;
  }
`;

export const FOG_FRAG_DECL = /* glsl */`
  varying float vVisibility;
  varying float vExplored;
`;

let _dummy: THREE.DataTexture | null = null;
function dummy(): THREE.DataTexture {
  if (!_dummy) {
    _dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    _dummy.needsUpdate = true;
  }
  return _dummy;
}

export function fogUniforms(): Record<string, { value: unknown }> {
  return {
    uFogData:        { value: dummy() },
    uFogDataSize:    { value: new THREE.Vector2(1, 1) },
    uFogEnabled:     { value: 0 },
    uHideUnexplored: { value: 1 },
    uDimExplored:    { value: 1 },
  };
}
