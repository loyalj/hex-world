import * as THREE from 'three';

const vertexShader = /* glsl */`
  in vec3 terrainType;

  out vec3 vColor;
  out vec3 vWorldPos;
  out vec3 vNormal;
  out vec3 vTerrainType;

  void main() {
    vColor       = color;
    vTerrainType = terrainType;

    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos     = worldPos.xyz;
    vNormal       = normalize(normal);

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

  in vec3 vColor;
  in vec3 vWorldPos;
  in vec3 vNormal;
  in vec3 vTerrainType;

  out vec4 fragColor;

  vec4 sampleSlot(int slot, float typeIdx) {
    vec2 uv = vWorldPos.xz * uTexScale;
    return texture(uTerrainTex, vec3(uv, typeIdx)) * vColor[slot];
  }

  void main() {
    // Three-way splat blend using vertex color channels as weights.
    vec4 c = sampleSlot(0, vTerrainType.x)
           + sampleSlot(1, vTerrainType.y)
           + sampleSlot(2, vTerrainType.z);

    vec3  n     = gl_FrontFacing ? vNormal : -vNormal;
    float diff  = max(dot(n, normalize(uLightDir)), 0.0);
    vec3  light = uAmbient + uLightColor * diff;

    fragColor = vec4(c.rgb * light, 1.0);
  }
`;

export interface TerrainMaterialOptions {
  /** World-space UV scale (smaller = larger texture tiles). Default 0.02. */
  texScale?: number;
  /** Directional light direction (world space). Default (0.6, 1, 0.5) normalised. */
  lightDir?: THREE.Vector3;
  /** Directional light color. Default white. */
  lightColor?: THREE.Color;
  /** Ambient light color. Default (0.35, 0.35, 0.35). */
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
      uTerrainTex: { value: terrainTex },
      uTexScale:   { value: opts.texScale    ?? 0.2 },
      uLightDir:   { value: lightDir },
      uLightColor: { value: opts.lightColor  ?? new THREE.Color(0xffffff) },
      uAmbient:    { value: opts.ambient     ?? new THREE.Color(0x595959) },
    },
    side: THREE.DoubleSide,
  });
}
