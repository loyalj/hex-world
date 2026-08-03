import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { CLOUD_GLSL, cloudShadowUniforms } from '../weather/CloudShadows.js';

const vertexShader = /* glsl */`
  #include <common>
  #include <shadowmap_pars_vertex>

  uniform vec3 uLightDir;

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

    // Names the three.js shadow chunk expects (normal-biased shadow lookup).
    // Chunk winding is mixed (DoubleSide + gl_FrontFacing flip at shade time),
    // so raw vertex normals can point INTO the ground; the chunk's normal bias
    // along such a normal buries the lookup below the surface and reads the
    // whole map as shadowed. Flip toward the sun so the bias always lifts the
    // sample to the lit side.
    vec3 shadowBiasNormal = normal;
    if (dot(mat3(modelMatrix) * shadowBiasNormal, uLightDir) < 0.0) shadowBiasNormal = -shadowBiasNormal;
    vec4 worldPosition      = worldPos;
    vec3 transformedNormal  = normalMatrix * shadowBiasNormal;
    #include <shadowmap_vertex>

    if (uFogEnabled > 0.5) {
      vec4 fd0 = texture(uFogData, fogCellUV(cellIndex.x));
      vec4 fd1 = texture(uFogData, fogCellUV(cellIndex.y));
      vec4 fd2 = texture(uFogData, fogCellUV(cellIndex.z));
      float explored = (fd0.b + fd1.b + fd2.b) / 3.0;
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

  // Shadow-map sampling from the host three.js version. getShadowMask() is 1.0
  // whenever shadows are off (renderer.shadowMap disabled or no casting light),
  // so the shader is shadow-ready at zero cost until a SunShadowRig enables it.
  // receiveShadow is normally declared by lights_pars_begin, which the
  // hand-rolled lighting here doesn't include; the renderer sets it per object.
  #include <common>
  #include <packing>
  uniform bool receiveShadow;
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>

  uniform sampler2DArray uTerrainTex;
  uniform float uTexScale;
  uniform vec3  uLightDir;
  uniform vec3  uLightColor;
  uniform vec3  uAmbient;

  // Hex grid overlay (see configureTerrainGrid). uGridFwd/uGridInv hold the
  // layout's axial↔world 2×2 matrices flattened row-major (already scaled by
  // hex size); uGridOrigin is the layout origin.
  uniform float uGridEnabled;
  uniform vec4  uGridFwd;
  uniform vec4  uGridInv;
  uniform vec2  uGridOrigin;
  uniform vec3  uGridColor;
  uniform float uGridOpacity;
  uniform float uGridLineWidth;
  uniform float uGridFadeStart;
  uniform float uGridFadeEnd;

  // Drifting cloud shadows (see configureTerrainClouds). The field is shared
  // with PrecipitationLayer so rain falls under the clouds shading the ground.
  uniform float uCloudsEnabled;
  uniform vec2  uCloudOffset;
  uniform float uCloudScale;
  uniform float uCloudCoverage;
  uniform float uCloudOpacity;

  in vec3  vColor;
  in vec3  vWorldPos;
  in vec3  vNormal;
  in vec3  vTerrainType;
  in float vVisibility;
  in float vExplored;

  out vec4 fragColor;

  ${CLOUD_GLSL}

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

  vec2 gridAxial(vec2 p) {
    p -= uGridOrigin;
    return vec2(dot(uGridInv.xy, p), dot(uGridInv.zw, p));
  }

  vec2 gridWorld(vec2 qr) {
    return vec2(dot(uGridFwd.xy, qr), dot(uGridFwd.zw, qr)) + uGridOrigin;
  }

  // Anti-aliased hex lattice line mask at world-space point p: 1 on a cell
  // border, 0 elsewhere, with an fwidth-wide transition for crispness at any
  // zoom. Lines are centered on the border (half the width in each cell), so
  // adjacent cells compose seamlessly.
  float hexGridLine(vec2 p) {
    vec2 axial = gridAxial(p);

    // Cube-round the fractional axial coordinate to the nearest hex center.
    float x = axial.x, z = axial.y, y = -x - z;
    float rx = floor(x + 0.5), ry = floor(y + 0.5), rz = floor(z + 0.5);
    float dx = abs(rx - x), dy = abs(ry - y), dz = abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dz > dy)       rz = -rx - ry;

    vec2 lp = p - gridWorld(vec2(rx, rz));

    // Distance to the nearest edge: the border is the perpendicular bisector
    // to the six neighbors, so project onto the three neighbor axes and take
    // the apothem minus the farthest projection.
    vec2 e0 = vec2(uGridFwd.x, uGridFwd.z); // axial (1, 0) neighbor offset
    vec2 e1 = vec2(uGridFwd.y, uGridFwd.w); // axial (0, 1)
    vec2 e2 = e0 - e1;                      // axial (1, -1)
    float d = max(abs(dot(lp, normalize(e0))),
              max(abs(dot(lp, normalize(e1))),
                  abs(dot(lp, normalize(e2)))));
    float edgeDist = 0.5 * length(e0) - d;

    float aa = fwidth(edgeDist);
    return 1.0 - smoothstep(0.5 * uGridLineWidth - aa, 0.5 * uGridLineWidth + aa, edgeDist);
  }

  void main() {
    vec4 c = sampleSlot(0, vTerrainType.x)
           + sampleSlot(1, vTerrainType.y)
           + sampleSlot(2, vTerrainType.z);
    // Splat weights normally sum to 1; riverbed vertices carry a boosted
    // weight (ChunkGeometryOptions.riverbedBlend) so the bed material climbs
    // higher up the channel walls — normalize so brightness stays constant.
    c /= max(vColor.x + vColor.y + vColor.z, 1e-4);

    vec3  n     = gl_FrontFacing ? vNormal : -vNormal;
    float diff  = max(dot(n, normalize(uLightDir)), 0.0);
    // Shadows and cloud cover only attenuate the direct sun term — ambient
    // keeps shadowed terrain readable instead of going black.
    float sunVis = getShadowMask();
    if (uCloudsEnabled > 0.5) {
      float cloud = cloudMask(cloudField(vWorldPos.xz, uCloudOffset, uCloudScale), uCloudCoverage);
      sunVis *= 1.0 - cloud * uCloudOpacity;
    }
    vec3  light = uAmbient + uLightColor * diff * sunVis;

    float mv = tNoise(vWorldPos.xz * 0.28) * 0.7 + tNoise(vWorldPos.xz * 0.07) * 0.3;
    c.rgb *= 0.93 + mv * 0.14;

    float cliff = 1.0 - abs(n.y);
    c.rgb *= 1.0 - cliff * 0.125;

    vec3 lit = c.rgb * light;

    if (uGridEnabled > 0.5) {
      // Fade with camera distance so far terrain stays clean, and on
      // near-vertical faces where an XZ lattice would smear down cliff walls.
      float fade  = 1.0 - smoothstep(uGridFadeStart, uGridFadeEnd, distance(vWorldPos, cameraPosition));
      float slope = smoothstep(0.15, 0.4, abs(n.y));
      float g = hexGridLine(vWorldPos.xz) * fade * slope * uGridOpacity;
      lit = mix(lit, uGridColor, g);
    }

    if (vExplored < 0.01) discard;
    fragColor = vec4(lit * vVisibility * vExplored, 1.0);
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
    // Receive the renderer's light state (shadow maps + matrices) into the
    // uniforms cloned from UniformsLib.lights below. The lighting itself stays
    // hand-rolled (uLightDir/uLightColor/uAmbient); only shadows are consumed.
    lights: true,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
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
      // Hex grid overlay — off until configureTerrainGrid supplies the layout.
      uGridEnabled:   { value: 0 },
      uGridFwd:       { value: new THREE.Vector4(1, 0, 0, 1) },
      uGridInv:       { value: new THREE.Vector4(1, 0, 0, 1) },
      uGridOrigin:    { value: new THREE.Vector2(0, 0) },
      uGridColor:     { value: new THREE.Color(0x101018) },
      uGridOpacity:   { value: 0.45 },
      uGridLineWidth: { value: 0.06 },
      uGridFadeStart: { value: 25 },
      uGridFadeEnd:   { value: 70 },
      // Cloud shadows — off until configureTerrainClouds enables them.
      ...cloudShadowUniforms(),
    },
    side: THREE.DoubleSide,
  });
}

/** Appearance and behavior of the shader hex grid overlay. All fields optional — unset fields keep their current value. */
export interface TerrainGridOptions {
  /** Show or hide the grid. Defaults to true when configureTerrainGrid is called. */
  enabled?:   boolean;
  /** Line color. Default a near-black blue-grey. */
  color?:     THREE.ColorRepresentation;
  /** Line opacity 0–1 at full strength (before distance/slope fading). Default 0.45. */
  opacity?:   number;
  /** Line width in world units, centered on the cell border. Default 0.06. */
  lineWidth?: number;
  /** Camera distance at which the grid starts fading out. Default 25. */
  fadeStart?: number;
  /** Camera distance at which the grid is fully faded. Default 70. */
  fadeEnd?:   number;
}

/**
 * Configure the hex grid overlay baked into the terrain shader: uploads the
 * layout's axial↔world transform and applies any appearance options, enabling
 * the grid unless `enabled: false` is passed. Toggling is a uniform flip — no
 * geometry rebuild. Call again anytime to restyle.
 *
 * @example
 * configureTerrainGrid(world.terrainMaterial, world.layout);            // on
 * configureTerrainGrid(mat, layout, { color: 0xffffff, opacity: 0.2 }); // restyle
 * setTerrainGridEnabled(mat, false);                                    // off
 */
export function configureTerrainGrid(
  material: THREE.ShaderMaterial,
  layout: HexLayout,
  opts: TerrainGridOptions = {},
): void {
  const u = material.uniforms;
  if (!u || !('uGridEnabled' in u)) return;
  const o = layout.orientation;
  u.uGridFwd.value.set(
    o.f0 * layout.size, o.f1 * layout.size,
    o.f2 * layout.size, o.f3 * layout.size,
  );
  u.uGridInv.value.set(
    o.b0 / layout.size, o.b1 / layout.size,
    o.b2 / layout.size, o.b3 / layout.size,
  );
  u.uGridOrigin.value.set(layout.originX, layout.originZ);
  if (opts.color     !== undefined) u.uGridColor.value.set(opts.color);
  if (opts.opacity   !== undefined) u.uGridOpacity.value   = opts.opacity;
  if (opts.lineWidth !== undefined) u.uGridLineWidth.value = opts.lineWidth;
  if (opts.fadeStart !== undefined) u.uGridFadeStart.value = opts.fadeStart;
  if (opts.fadeEnd   !== undefined) u.uGridFadeEnd.value   = opts.fadeEnd;
  u.uGridEnabled.value = (opts.enabled ?? true) ? 1 : 0;
}

/** Show or hide the shader hex grid without touching its styling. */
export function setTerrainGridEnabled(material: THREE.ShaderMaterial, enabled: boolean): void {
  const u = material.uniforms;
  if (u && 'uGridEnabled' in u) u.uGridEnabled.value = enabled ? 1 : 0;
}
