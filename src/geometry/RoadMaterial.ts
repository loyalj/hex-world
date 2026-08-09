import * as THREE from 'three';
import { FOG_VERT_DECL, FOG_VERT_BODY, FOG_FRAG_DECL, fogUniforms } from './FogGLSL.js';
import { CLOUD_GLSL, cloudShadowUniforms } from '../weather/CloudShadows.js';
import { ATMOSPHERE_GLSL, atmosphereUniforms } from '../sky/Atmosphere.js';

const vertexShader = /* glsl */`
  #include <common>
  #include <shadowmap_pars_vertex>

  ${FOG_VERT_DECL}
  uniform vec3 uLightDir;
  varying vec2 vUv;
  varying vec2 vWorldXZ;
  varying vec3 vColor;
  varying vec3 vNormal;
  // Baked height-field occlusion from the same bake the terrain uses, so a
  // road running along a cliff base sits in the same shade as the ground
  // beside it. Absent attribute reads 0 = fully open.
  attribute float occlusion;
  varying float vOcclusion;
  void main() {
    vUv = uv;
    vColor = color;
    vNormal = normalize(normal);
    vOcclusion = occlusion;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;

    // Names the three.js shadow chunk expects. Same flip-toward-the-sun trick
    // TerrainMaterial documents: road strips are DoubleSide triangle soup, so
    // a raw normal can point into the ground and the chunk's normal bias would
    // bury the shadow lookup below the surface.
    vec3 shadowBiasNormal = normal;
    if (dot(mat3(modelMatrix) * shadowBiasNormal, uLightDir) < 0.0) shadowBiasNormal = -shadowBiasNormal;
    vec4 worldPosition     = worldPos;
    vec3 transformedNormal = normalMatrix * shadowBiasNormal;
    #include <shadowmap_vertex>

    ${FOG_VERT_BODY}
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  // Shadow-map sampling from the host three.js version, exactly as in
  // TerrainMaterial — getShadowMask() is 1.0 whenever shadows are off, so this
  // costs nothing until a SunShadowRig enables them.
  #include <common>
  #include <packing>
  uniform bool receiveShadow;
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>

  ${FOG_FRAG_DECL}
  varying vec2 vUv;
  varying vec2 vWorldXZ;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying float vOcclusion;

  // Roads are a decal on the terrain, so they run the terrain's lighting model
  // with the same uniform names — a DayNightCycle drives both from one state
  // and the road never reads brighter than the ground it sits on.
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform vec3 uAmbient;

  // Drifting cloud shadows — the SAME field the terrain shader samples (a
  // WeatherSystem keeps offset/coverage in sync), so a cloud passing overhead
  // dims the road and the ground around it together.
  uniform float uCloudsEnabled;
  uniform vec2  uCloudOffset;
  uniform float uCloudScale;
  uniform float uCloudCoverage;
  uniform float uCloudOpacity;

  ${CLOUD_GLSL}
  ${ATMOSPHERE_GLSL}

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

    // Roads lie on the ground, never on an overhang, so the shading normal
    // always points up — flipping is cheaper and steadier than gl_FrontFacing
    // on a decal drawn from both sides.
    vec3  n2    = vNormal.y < 0.0 ? -vNormal : vNormal;
    float diff  = max(dot(n2, normalize(uLightDir)), 0.0);
    // Shadows and cloud cover only attenuate the direct sun term — ambient
    // keeps a shaded road readable instead of going black.
    float sunVis = getShadowMask();
    if (uCloudsEnabled > 0.5) {
      float cover = cloudMask(cloudField(vWorldXZ, uCloudOffset, uCloudScale), uCloudCoverage);
      sunVis *= 1.0 - cover * uCloudOpacity;
    }
    vec3 light = uAmbient * (1.0 - vOcclusion) + uLightColor * diff * sunVis;

    vec3 col = clamp(vColor + variation, 0.0, 1.0) * light * vVisibility;
    gl_FragColor = vec4(applyAtmosphere(col, vWorldXZ), clamp(blend, 0.0, 1.0) * vExplored);
  }
`;

/** Lighting for the road overlay. Match these to the terrain material's so the decal and the ground agree. */
export interface RoadMaterialOptions {
  lightDir?: THREE.Vector3;
  lightColor?: THREE.Color;
  ambient?: THREE.Color;
}

export function createRoadMaterial(opts: RoadMaterialOptions = {}): THREE.ShaderMaterial {
  const lightDir = (opts.lightDir ?? new THREE.Vector3(0.6, 1, 0.5)).clone().normalize();

  return new THREE.ShaderMaterial({
    uniforms: {
      // Receive the renderer's light state (shadow maps + matrices); the
      // lighting itself stays hand-rolled, as in TerrainMaterial.
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
      uLightDir:   { value: lightDir },
      uLightColor: { value: opts.lightColor ?? new THREE.Color(0xffffff) },
      uAmbient:    { value: opts.ambient    ?? new THREE.Color(0x595959) },
      ...cloudShadowUniforms(),
      ...fogUniforms(),
      ...atmosphereUniforms(),
    },
    lights: true,
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
