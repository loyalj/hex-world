import * as THREE from 'three';

const vertexShader = /* glsl */`
  in vec3 terrainType;
  in vec3 cellIndex;

  uniform sampler2D uFogData;
  uniform vec2      uFogDataSize;
  uniform float     uFogEnabled;
  uniform float     uHideUnexplored;
  uniform float     uDimExplored;

  out vec3  vColor;
  out vec3  vWorldPos;
  out vec3  vNormal;
  out vec3  vTerrainType;
  out float vVisibility;
  out float vExplored;

  vec2 fogCellUV(float ci) {
    float x = mod(ci, uFogDataSize.x);
    float y = floor(ci / uFogDataSize.x);
    return (vec2(x, y) + 0.5) / uFogDataSize;
  }

  void main() {
    vColor       = color;
    vTerrainType = terrainType;

    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos     = worldPos.xyz;
    vNormal       = normalize(normal);

    if (uFogEnabled > 0.5) {
      vec4 fd0 = texture(uFogData, fogCellUV(cellIndex.x));
      vec4 fd1 = texture(uFogData, fogCellUV(cellIndex.y));
      vec4 fd2 = texture(uFogData, fogCellUV(cellIndex.z));
      float explored = (fd0.g + fd1.g + fd2.g) / 3.0;
      float vis      = (fd0.r + fd1.r + fd2.r) / 3.0;
      vExplored   = uHideUnexplored > 0.5 ? explored : 1.0;
      vVisibility = uDimExplored    > 0.5 ? mix(0.25, 1.0, vis) : 1.0;
    } else {
      vVisibility = 1.0;
      vExplored   = 1.0;
    }

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  precision highp sampler2DArray;

  uniform sampler2DArray uTerrainTex;
  uniform float uTexScale;
  uniform vec3  uLightDir;
  uniform vec3  uLightColor;
  uniform vec3  uAmbient;

  in vec3  vColor;
  in vec3  vWorldPos;
  in vec3  vNormal;
  in vec3  vTerrainType;
  in float vVisibility;
  in float vExplored;

  out vec4 fragColor;

  float tHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float tNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(tHash(i), tHash(i + vec2(1,0)), f.x),
               mix(tHash(i + vec2(0,1)), tHash(i + vec2(1,1)), f.x), f.y);
  }

  vec4 sampleTriplanar(float typeIdx) {
    vec3 blend = pow(abs(vNormal), vec3(8.0));
    blend /= dot(blend, vec3(1.0));

    vec4 xSample = texture(uTerrainTex, vec3(vWorldPos.yz * uTexScale, typeIdx));
    vec4 ySample = texture(uTerrainTex, vec3(vWorldPos.xz * uTexScale, typeIdx));
    vec4 zSample = texture(uTerrainTex, vec3(vWorldPos.xy * uTexScale, typeIdx));

    return xSample * blend.x + ySample * blend.y + zSample * blend.z;
  }

  vec4 sampleSlot(int slot, float typeIdx) {
    return sampleTriplanar(typeIdx) * vColor[slot];
  }

  void main() {
    vec4 c = sampleSlot(0, vTerrainType.x)
           + sampleSlot(1, vTerrainType.y)
           + sampleSlot(2, vTerrainType.z);

    vec3  n     = gl_FrontFacing ? vNormal : -vNormal;
    float diff  = max(dot(n, normalize(uLightDir)), 0.0);
    vec3  light = uAmbient + uLightColor * diff;

    float mv = tNoise(vWorldPos.xz * 0.28) * 0.7 + tNoise(vWorldPos.xz * 0.07) * 0.3;
    c.rgb *= 0.93 + mv * 0.14;

    float cliff = 1.0 - abs(n.y);
    c.rgb *= 1.0 - cliff * 0.125;

    if (vExplored < 0.5) discard;
    fragColor = vec4(c.rgb * light * vVisibility, 1.0);
  }
`;

// Shared 1×1 black texture used when fog is disabled (sampler must be bound).
let _dummyFogTex: THREE.DataTexture | null = null;
function dummyFogTexture(): THREE.DataTexture {
  if (!_dummyFogTex) {
    _dummyFogTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    _dummyFogTex.needsUpdate = true;
  }
  return _dummyFogTex;
}

export interface TerrainMaterialOptions {
  texScale?: number;
  lightDir?: THREE.Vector3;
  lightColor?: THREE.Color;
  ambient?: THREE.Color;
}

export function createTerrainMaterial(
  terrainTex: THREE.DataArrayTexture,
  opts: TerrainMaterialOptions = {},
): THREE.ShaderMaterial {
  const lightDir = (opts.lightDir ?? new THREE.Vector3(0.6, 1, 0.5)).clone().normalize();

  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    vertexColors: true,
    uniforms: {
      uTerrainTex:  { value: terrainTex },
      uTexScale:    { value: opts.texScale    ?? 0.2 },
      uLightDir:    { value: lightDir },
      uLightColor:  { value: opts.lightColor  ?? new THREE.Color(0xffffff) },
      uAmbient:     { value: opts.ambient     ?? new THREE.Color(0x595959) },
      uFogData:        { value: dummyFogTexture() },
      uFogDataSize:    { value: new THREE.Vector2(1, 1) },
      uFogEnabled:     { value: 0 },
      uHideUnexplored: { value: 1 },
      uDimExplored:    { value: 1 },
    },
    side: THREE.DoubleSide,
  });
}
