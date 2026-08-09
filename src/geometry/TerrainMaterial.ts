import * as THREE from 'three';
import type { HexLayout } from '../math/HexLayout.js';
import { CLOUD_GLSL, cloudShadowUniforms } from '../weather/CloudShadows.js';
import { ATMOSPHERE_GLSL, atmosphereUniforms } from '../sky/Atmosphere.js';
import { SNOW_GLSL, FOLIAGE_GLSL, seasonUniforms, snowAppearanceUniforms, foliageUniforms } from '../season/SeasonGLSL.js';

const vertexShader = /* glsl */`
  #include <common>
  #include <shadowmap_pars_vertex>

  uniform vec3 uLightDir;

  in vec3  terrainType;
  in vec3  cellIndex;
  // Baked height-field occlusion (HexChunkCore). Geometry built without the
  // attribute reads 0 here, which is exactly "fully open" — so the older
  // à-la-carte chunk arrays keep rendering unchanged.
  in float occlusion;

  uniform sampler2D uFogData;
  uniform vec2      uFogDataSize;
  uniform float     uFogEnabled;
  uniform float     uHideUnexplored;
  uniform float     uDimExplored;

  // Per-cell climate (see SeasonGLSL) — B channel is snow depth, A is the
  // season-adjusted temperature the foliage tint turns on. Sampled per vertex
  // from the same three cellIndex lookups the fog uses, so the snowline and the
  // autumn line interpolate across the triangle instead of coming out
  // hex-shaped.
  uniform sampler2D uClimateData;
  uniform vec2      uClimateSize;
  uniform float     uSeasonEnabled;

  out vec3  vColor;
  out vec3  vWorldPos;
  out vec3  vNormal;
  out vec3  vTerrainType;
  out float vVisibility;
  out float vExplored;
  out float vSnow;
  out float vTemp;
  out float vOcclusion;

  vec2 cellUV(float ci, vec2 size) {
    float x = mod(ci, size.x);
    float y = floor(ci / size.x);
    return (vec2(x, y) + 0.5) / size;
  }

  vec2 fogCellUV(float ci) {
    return cellUV(ci, uFogDataSize);
  }

  void main() {
    vColor       = color;
    vTerrainType = terrainType;
    vOcclusion   = occlusion;

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

    if (uSeasonEnabled > 0.5) {
      vec4 c0 = texture(uClimateData, cellUV(cellIndex.x, uClimateSize));
      vec4 c1 = texture(uClimateData, cellUV(cellIndex.y, uClimateSize));
      vec4 c2 = texture(uClimateData, cellUV(cellIndex.z, uClimateSize));
      vSnow = (c0.b + c1.b + c2.b) / 3.0;
      vTemp = (c0.a + c1.a + c2.a) / 3.0;
    } else {
      vSnow = 0.0;
      vTemp = 1.0;   // "warm" — grass stays summer green while seasons are off
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
  // Triplanar blend exponent. Higher is sharper: a vertical wall takes its
  // side projection almost purely, at the cost of a tighter, more visible
  // transition across the terrace faces in between. Default 8.
  uniform float uTriplanarSharpness;
  uniform vec3  uLightDir;
  uniform vec3  uLightColor;
  uniform vec3  uAmbient;

  // Cliff strata (see configureCliffStrata). Bedding planes banded along world
  // height, showing only where the ground is steep enough to be bare rock.
  uniform float uStrataEnabled;
  uniform float uStrataStrength;
  uniform float uStrataScale;
  uniform float uStrataContrast;
  uniform float uStrataSeam;
  uniform float uStrataWarp;
  uniform float uStrataTilt;
  uniform vec3  uStrataTint;
  uniform float uStrataSlope;
  uniform float uStrataRockOnly;

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

  // Seasonal snow (see configureSeason). uSnowTerrain is the texture-array
  // layer holding the pack's snow surface, so winter ground keeps the same
  // grain as the rest of the terrain instead of reading as flat white paint;
  // -1 falls back to uSnowColor alone.
  uniform float uSeasonEnabled;
  uniform float uSnowTerrain;

  in vec3  vColor;
  in float vOcclusion;
  in vec3  vWorldPos;
  in vec3  vNormal;
  in vec3  vTerrainType;
  in float vVisibility;
  in float vExplored;
  in float vSnow;
  in float vTemp;

  out vec4 fragColor;

  ${CLOUD_GLSL}
  ${ATMOSPHERE_GLSL}
  ${SNOW_GLSL}
  ${FOLIAGE_GLSL}

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
    vec3 blend = pow(abs(vNormal), vec3(uTriplanarSharpness));
    blend /= dot(blend, vec3(1.0));

    vec4 xSample = texture(uTerrainTex, vec3(vWorldPos.yz * uTexScale, typeIdx));
    vec4 ySample = texture(uTerrainTex, vec3(vWorldPos.xz * uTexScale, typeIdx));
    vec4 zSample = texture(uTerrainTex, vec3(vWorldPos.xy * uTexScale, typeIdx));

    return xSample * blend.x + ySample * blend.y + zSample * blend.z;
  }

  vec4 sampleSlot(int slot, float typeIdx) {
    return sampleTriplanar(typeIdx) * vColor[slot];
  }

  /**
   * Sedimentary bedding on bare rock.
   *
   * Triplanar projection already stops a cliff face taking the flat ground's
   * XZ-projected texture, so the wall reads as rock grain rather than as smear
   * — but grain alone has no *structure*, and structure is what makes a carved
   * gorge read as depth instead of as a dark wall. Beds do that: they are
   * horizontal, so they pick out every terrace and overhang, and they are
   * continuous across cells, so a canyon carved through six hexes reads as one
   * cut through one rock rather than as six adjacent walls.
   *
   * base   — resolved surface color, before lighting
   * upness — the shaded normal's y, 1 on flat ground and 0 on a vertical face
   */
  vec3 cliffStrata(vec3 base, float upness, vec3 worldPos) {
    // The band coordinate and its screen derivative come FIRST, before any
    // branch. fwidth is undefined under non-uniform control flow, and the
    // early-outs below diverge along exactly the two edges where this effect
    // fades — the cliff silhouette and the grass line — so a derivative taken
    // after them would be garbage precisely where it shows.

    // Height, but not *level* height. A dip tilts the whole sequence along one
    // regional direction and a low-frequency warp folds it, so the beds read as
    // rock that was laid down and then bent — dead-flat bands across a whole
    // map look like a decal, and the eye catches it immediately once two
    // unrelated cliffs share a stripe at the same altitude.
    float h = worldPos.y
            + dot(worldPos.xz, vec2(0.83, 0.55)) * uStrataTilt
            + (tNoise(worldPos.xz * 0.06) - 0.5) * 2.0 * uStrataWarp;

    // Bending the band coordinate before it is quantized varies bed thickness
    // without breaking continuity. The two amplitudes are chosen to keep the
    // derivative positive (min ≈ 0.41) — a fold here would make floor() run
    // backwards and put a mirrored bed in the middle of the sequence.
    float b = h * uStrataScale;
    b += sin(b * 1.7) * 0.22 + sin(b * 0.63) * 0.35;
    float px = fwidth(b);

    // Steep faces only. Bedding is what's visible where soil and cover have
    // fallen away, which on this terrain is exactly the cliff walls and the
    // carved channel sides — flat ground shows its surface, not its section.
    float face = 1.0 - smoothstep(0.0, max(uStrataSlope, 1e-4), upness);
    if (face <= 0.0) return base;

    // Banding a grass bank would read as painted stripes. Measured the same
    // relative way FOLIAGE_GLSL measures green so it survives a dark texture
    // and a bright one alike, but kept local rather than calling foliageMask:
    // that one is switched off by uFoliageSelect for a mesh that is foliage all
    // over, and strata must not follow it into thinking rock is a leaf.
    float green = (base.g - max(base.r, base.b)) / max(base.g, 1e-4);
    float rock  = mix(1.0, 1.0 - smoothstep(0.02, 0.20, green), uStrataRockOnly);
    if (rock <= 0.0) return base;

    // Below roughly a pixel per bed the pattern is no longer bedding, it is
    // noise — fade it out with the derivative rather than let a distant cliff
    // crawl as the camera moves.
    float detail = 1.0 - smoothstep(0.35, 1.0, px);
    if (detail <= 0.0) return base;

    float idx   = floor(b);
    float phase = b - idx;

    // Two decorrelated draws per bed: how pale it is, and how warm. One hash
    // driving both would tie every pale bed to the same color and the sequence
    // would come out as a single gradient repeated.
    float pale   = tHash(vec2(idx, 11.3));
    float warmth = tHash(vec2(idx, 47.9));

    // A bedding plane reads from two things at once: neighbouring beds differ
    // in value and color, and the joint between them is a thin dark line where
    // shadow and damp collect. The beds do the geology; the seam does the
    // drawing, and it is the seam the eye actually counts.
    vec3 bed = base * (1.0 + (pale - 0.5) * 2.0 * uStrataContrast);
    bed = mix(bed, bed * uStrataTint, warmth);

    // Seam width tracks the derivative, so it stays a hairline up close and
    // widens into a soft gradient at distance instead of aliasing to a moiré.
    float seamW = max(px * 1.2, 0.03);
    bed *= 1.0 - uStrataSeam * (1.0 - smoothstep(0.0, seamW, min(phase, 1.0 - phase)));

    return mix(base, bed, clamp(uStrataStrength * face * detail * rock, 0.0, 1.0));
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
    // Baked occlusion attenuates only ambient, the same split shadows use:
    // a lit cliff face keeps its full sun term and darkens where the sky is
    // blocked, and the effect reaches full strength exactly where it should
    // — in shade, where ambient is all the light there is.
    vec3  light = uAmbient * (1.0 - vOcclusion) + uLightColor * diff * sunVis;

    float mv = tNoise(vWorldPos.xz * 0.28) * 0.7 + tNoise(vWorldPos.xz * 0.07) * 0.3;
    c.rgb *= 0.93 + mv * 0.14;

    float cliff = 1.0 - abs(n.y);
    c.rgb *= 1.0 - cliff * 0.125;

    // Bedding goes on the rock before anything is laid over the rock: the turn
    // reads the color to find what is living, and snow lies on the bands rather
    // than being banded itself.
    if (uStrataEnabled > 0.5) {
      c.rgb = cliffStrata(c.rgb, abs(n.y), vWorldPos);
    }

    // The turn goes on before the snow — grass is gold under a first frost, not
    // frost under gold. Which of the three splat slots counts as grass is not
    // asked here: seasonalFoliage measures it off the resolved color, so a hex
    // half grass and half rock turns exactly the grass half. Seed 0 — the
    // per-plant hue scatter that keeps a wood from reading as one decal would
    // only mottle ground cover, which turns as one field.
    if (uSeasonEnabled > 0.5) {
      c.rgb = seasonalFoliage(c.rgb, vTemp, 0.0);
    }

    // Snow goes on before lighting so it shades and shadows like real ground.
    if (uSeasonEnabled > 0.5) {
      float snow = snowCoverage(vSnow, n.y, vWorldPos.xz);
      if (snow > 0.0) {
        vec3 snowRgb = uSnowTerrain >= 0.0
          ? sampleTriplanar(uSnowTerrain).rgb * uSnowColor
          : uSnowColor;
        c.rgb = mix(c.rgb, snowRgb, snow);
      }
    }

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
    // Haze goes on last: it sits between the eye and the surface, so it hazes
    // the fog-of-war dimming too rather than being dimmed by it.
    fragColor = vec4(applyAtmosphere(lit * vVisibility * vExplored, vWorldPos.xz), 1.0);
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
  /**
   * Triplanar blend exponent — how hard the shader commits to one projection
   * axis. Default 8: a vertical wall takes its side projection almost purely.
   * Lower values widen the cross-fade, which softens the transition across
   * terrace faces at the cost of a little blur on them. Clamped to a minimum
   * of 1 — an exponent of 0 would make `pow(0, 0)` on an axis-aligned face,
   * which is undefined and shows up as NaN pixels.
   */
  triplanarSharpness?: number;
  /**
   * Cliff strata styling, applied at construction. Equivalent to calling
   * {@link configureCliffStrata} afterwards; here so a `.hexpack` can ship the
   * bedding that matches its rock.
   */
  strata?: CliffStrataOptions;
}

export function createTerrainMaterial(
  terrainTex: THREE.DataArrayTexture,
  opts: TerrainMaterialOptions = {},
): THREE.ShaderMaterial {
  const lightDir = (opts.lightDir ?? new THREE.Vector3(0.6, 1, 0.5)).clone().normalize();

  const material = new THREE.ShaderMaterial({
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
      uTriplanarSharpness: { value: Math.max(1, opts.triplanarSharpness ?? 8) },
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
      // Distance haze — off until a SkyDome (or configureAtmosphere) enables it.
      ...atmosphereUniforms(),
      // Seasonal snow and foliage — off until configureSeason supplies a
      // ClimateData. The foliage reference green defaults to the built-in
      // grassland color; HexWorld re-resolves it from the active pack.
      ...seasonUniforms(),
      ...snowAppearanceUniforms(),
      // Ground cover keeps its own palette, because it does not do what a
      // canopy does: grass goes straw and then dun, where a wood goes gold and
      // then bare. Sharing the plant palette turns a whole hillside rust, which
      // reads as the map being recolored rather than as a season. Overridable
      // per world — see HexWorldSeasonOptions.terrainFoliage.
      ...foliageUniforms({ summer: 0x86b888, autumn: 0xbba360, bare: 0x9a8f74 }),
      uSnowTerrain: { value: -1 },
      // Cliff strata — on by default, unlike the grid and the seasons. It is
      // not a mode the scene opts into but a property of rock, and it needs no
      // data the material doesn't already have; a pack turns it off by passing
      // `strata: { enabled: false }` rather than by never enabling it.
      ...cliffStrataUniforms(),
    },
    side: THREE.DoubleSide,
  });

  if (opts.strata) configureCliffStrata(material, opts.strata);
  return material;
}

/** Builds the cliff-strata uniform set, at the defaults documented on {@link CliffStrataOptions}. */
function cliffStrataUniforms(): Record<string, THREE.IUniform> {
  return {
    uStrataEnabled:  { value: 1 },
    uStrataStrength: { value: 1 },
    // Elevation steps are ELEVATION_SCALE (0.5) world units tall, so ~3 beds
    // per unit puts six of them on a four-step cliff — enough to count, few
    // enough that each one still has a face.
    uStrataScale:    { value: 3 },
    uStrataContrast: { value: 0.14 },
    uStrataSeam:     { value: 0.22 },
    uStrataWarp:     { value: 0.08 },
    uStrataTilt:     { value: 0.03 },
    // Kept very close to white on purpose. Like every other THREE.Color uniform
    // in this shader it arrives linearized, while the shader itself works in the
    // texture's own sRGB-ish space — so a tint that looks mild as a hex code
    // lands noticeably stronger on the rock than it reads.
    uStrataTint:     { value: new THREE.Color(0xfffaf0) },
    uStrataSlope:    { value: 0.65 },
    uStrataRockOnly: { value: 1 },
  };
}

/**
 * Appearance of the cliff strata drawn by the terrain shader. All fields
 * optional — unset fields keep their current value.
 */
export interface CliffStrataOptions {
  /** Show or hide the bedding. Defaults to true when {@link configureCliffStrata} is called; on out of the box. */
  enabled?: boolean;
  /** Overall amount, 0 (no bedding) to 1 (the full pattern). Default 1 — tune {@link contrast} and {@link seam} for the look, this for the dose. */
  strength?: number;
  /** Beds per world unit. Higher is finer layering. Default 3, i.e. one bed per two-thirds of an elevation step. */
  scale?: number;
  /** How far neighbouring beds differ in value, 0–1. Default 0.14. */
  contrast?: number;
  /** Strength of the thin dark line at each bedding plane, 0–1. Default 0.22 — this is the part the eye actually counts. */
  seam?: number;
  /** How far the sequence folds away from level, in world units. 0 is dead-flat banding. Default 0.08. */
  warp?: number;
  /** Regional dip: world units of rise per unit travelled along the dip direction. Default 0.03. */
  tilt?: number;
  /** Colour the paler beds lean toward, as a multiplier. Default a warm off-white. */
  tint?: THREE.ColorRepresentation;
  /** Surface upness (normal y) at which bedding has faded out completely. Default 0.65 — walls and steep channel sides, not hillsides. */
  slope?: number;
  /** 1 leaves living green surfaces unbanded, 0 bands everything steep. Default 1. */
  rockOnly?: number;
}

/**
 * Style the cliff strata baked into the terrain shader, enabling it unless
 * `enabled: false` is passed. Every field is a uniform flip — no geometry
 * rebuild, safe to call per frame. A material without the uniforms (a custom
 * one, an older pack's) is skipped.
 *
 * @example
 * configureCliffStrata(world.terrainMaterial, { scale: 5, seam: 0.3 }); // finer, sharper beds
 * configureCliffStrata(mat, { warp: 0, tilt: 0 });                      // dead-level layers
 * setCliffStrataEnabled(mat, false);
 */
export function configureCliffStrata(
  material: THREE.ShaderMaterial,
  opts: CliffStrataOptions = {},
): void {
  const u = material.uniforms;
  if (!u || !('uStrataEnabled' in u)) return;
  if (opts.strength !== undefined) u.uStrataStrength.value = opts.strength;
  if (opts.scale    !== undefined) u.uStrataScale.value    = opts.scale;
  if (opts.contrast !== undefined) u.uStrataContrast.value = opts.contrast;
  if (opts.seam     !== undefined) u.uStrataSeam.value     = opts.seam;
  if (opts.warp     !== undefined) u.uStrataWarp.value     = opts.warp;
  if (opts.tilt     !== undefined) u.uStrataTilt.value     = opts.tilt;
  if (opts.tint     !== undefined) (u.uStrataTint.value as THREE.Color).set(opts.tint);
  if (opts.slope    !== undefined) u.uStrataSlope.value    = opts.slope;
  if (opts.rockOnly !== undefined) u.uStrataRockOnly.value = opts.rockOnly;
  u.uStrataEnabled.value = (opts.enabled ?? true) ? 1 : 0;
}

/** Show or hide the cliff strata without touching its styling. */
export function setCliffStrataEnabled(material: THREE.ShaderMaterial, enabled: boolean): void {
  const u = material.uniforms;
  if (u && 'uStrataEnabled' in u) u.uStrataEnabled.value = enabled ? 1 : 0;
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
