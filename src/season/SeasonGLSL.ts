import * as THREE from 'three';
import type { ClimateData } from './ClimateData.js';
import { seasonWarming } from './SeasonCycle.js';

/**
 * Season GLSL: the per-cell climate lookup and the shared snow-coverage math.
 *
 * The lookup rides the `cellIndex` attribute every hex-world geometry already
 * carries for fog of war, so nothing new has to be built per chunk — a climate
 * texture is a second sampler over the same addressing.
 *
 * Shaders read two channels, both written by `SeasonCycle.apply`: **B** = snow
 * depth and **A** = season-adjusted temperature. Snow is stored because it
 * accumulates and melts — it is state. Ice is not stored, because every liquid
 * freezes at its own point (see `LiquidTypeDescriptor.freezePoint`) and one
 * byte cannot answer for all of them; each material derives it from the
 * temperature instead. Both paths stay in step with gameplay because
 * `ClimateData` exposes the identical values to the CPU (see {@link ClimateData}).
 *
 * The temperature channel earns its keep twice: liquids read it against their
 * freeze point, and {@link FOLIAGE_GLSL} reads it to decide how far through the
 * turn each cell's grass and leaves are.
 */

/**
 * Vertex declarations for GLSL1-style shaders (the liquid materials).
 *
 * Include this *after* `FOG_VERT_DECL`, which declares the shared
 * `cellIndex` attribute — the two snippets sample the same one.
 */
export const SEASON_VERT_DECL = /* glsl */`
  uniform sampler2D uClimateData;
  uniform vec2  uClimateSize;
  uniform float uSeasonEnabled;
  uniform float uFreezePoint;
  uniform float uFreezeBand;
  varying float vSnow;
  varying float vIce;
`;

/**
 * Resolves the cell's snow depth and — from this liquid's own freeze point —
 * how far it has frozen.
 *
 * Ice is derived here rather than stored per cell because every liquid freezes
 * at a different temperature: water skins over long before acid does, and lava
 * never does. One shared "is frozen" byte could only ever answer for one of
 * them, so the texture carries the season-adjusted *temperature* and each
 * material reads its own answer out of it.
 */
export const SEASON_VERT_BODY = /* glsl */`
  if (uSeasonEnabled > 0.5) {
    float _cx = mod(cellIndex, uClimateSize.x);
    float _cy = floor(cellIndex / uClimateSize.x);
    vec4 _cd = texture2D(uClimateData, (vec2(_cx, _cy) + 0.5) / uClimateSize);
    vSnow = _cd.b;
    // uFreezePoint < 0 marks a liquid that never freezes.
    vIce = uFreezePoint < 0.0
      ? 0.0
      : smoothstep(uFreezePoint, uFreezePoint - max(uFreezeBand, 1e-4), _cd.a);
  } else {
    vSnow = 0.0;
    vIce  = 0.0;
  }
`;

export const SEASON_FRAG_DECL = /* glsl */`
  varying float vSnow;
  varying float vIce;
`;

/**
 * Shared snow-coverage math. Terrain and scatter both call `snowCoverage` so a
 * tree's cap appears at exactly the same moment as the ground it stands on —
 * duplicating this curve is how those two drift apart by a frame of snowfall.
 *
 * Deliberately *not* included here: the snow color. Terrain samples the pack's
 * snow slice triplanar from its texture array; a stock scatter material has no
 * such array and takes a flat tint. Only the mask is common.
 */
export const SNOW_GLSL = /* glsl */`
  uniform vec3  uSnowColor;
  uniform float uSnowSlope;
  uniform float uSnowNoise;

  float snHash(vec2 p) {
    return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453);
  }
  float snNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(snHash(i), snHash(i + vec2(1,0)), f.x),
               mix(snHash(i + vec2(0,1)), snHash(i + vec2(1,1)), f.x), f.y);
  }

  /**
   * snow    — the cell's snow depth, 0–1 (the climate texture's B channel)
   * upness  — the surface normal's y, 1 on flat ground and 0 on a vertical face
   * worldXZ — world position, for breaking up the snowline
   */
  float snowCoverage(float snow, float upness, vec2 worldXZ) {
    if (snow <= 0.0) return 0.0;

    // Steep faces shed their snow, which is what keeps cliffs reading as rock
    // and stops the world going flat white the moment winter lands.
    float slope = mix(1.0, smoothstep(0.1, 0.55, upness), uSnowSlope);

    // Two octaves so the edge frays at both the hillside and the footprint
    // scale — a single frequency reads as a clean contour line either way.
    float n = snNoise(worldXZ * 0.35) * 0.65 + snNoise(worldXZ * 1.3) * 0.35;

    // Bias the threshold by noise rather than the value, so full snow stays
    // fully covered and only the transition band breaks up.
    float edge = (n - 0.5) * uSnowNoise;
    return smoothstep(0.15 + edge, 0.85 + edge, snow * slope);
  }
`;

/**
 * Shared seasonal foliage tint — the other half of what the climate texture is
 * for. Snow is what settles *on* the world; this is what the world's own living
 * surfaces do as the year turns.
 *
 * Terrain and scatter both call `seasonalFoliage`, for the same reason they
 * share `snowCoverage`: a hillside and the trees standing on it have to turn
 * together, and two copies of this curve would drift apart by a week of autumn.
 *
 * ### Why two inputs
 *
 * `temp` is the cell's season-adjusted temperature (the climate texture's **A**
 * channel), and it decides *how far* through the turn a cell is — so cold
 * uplands go gold while the valley below is still green, and the tropics never
 * turn at all. But temperature alone cannot tell spring from autumn: a cell at
 * 0.4 is the same cell whether the year is warming or cooling. `uFoliageWarming`
 * (see `seasonWarming`) supplies that direction, and it is the only part of this
 * that is global rather than per-cell.
 *
 * ### Why a ratio
 *
 * The palette names four absolute colors, but they are applied as a *multiplier*
 * against `uFoliageSummer` — the surface's own as-authored green. That makes
 * high summer exactly a no-op (`summer / summer` = 1) instead of a wash that
 * flattens the material to a uniform color, and it carries every texel's own
 * variation and shading through the turn rather than painting over it.
 *
 * ### Why it knows what a leaf is
 *
 * A tree mesh is usually one material over trunk and canopy, and terrain is one
 * shader over grass, rock and sand. Rather than demand a second material or a
 * per-vertex mask, `foliageMask` reads the surface's own color: the green parts
 * are the living parts. It is measured on the *summer* color, before any tint,
 * so the mask is fixed for the year — an autumn-gold canopy doesn't stop
 * counting as foliage halfway through October. Set `uFoliageSelect` to 0 for a
 * mesh that is foliage all over (a bush) to skip the test entirely.
 */
export const FOLIAGE_GLSL = /* glsl */`
  uniform vec3  uFoliageSummer;
  uniform vec3  uFoliageSpring;
  uniform vec3  uFoliageAutumn;
  uniform vec3  uFoliageBare;
  uniform float uFoliageGreenTemp;
  uniform float uFoliageBareTemp;
  uniform float uFoliageStrength;
  uniform float uFoliageSelect;
  uniform float uFoliageVariance;
  uniform float uFoliageWarming;
  uniform vec3  uBlossomColor;
  uniform vec3  uBlossomAlt;
  uniform float uBlossomShare;
  uniform float uBlossomStrength;

  /** 1 where a surface is living green, 0 where it is bark, rock or sand. */
  float foliageMask(vec3 base) {
    // Relative, not absolute: how far green leads the other two channels as a
    // fraction of itself, so the test survives a dark texture, a bright one, and
    // the gap between a linear-space stock material and the terrain shader's
    // own working space.
    float green = (base.g - max(base.r, base.b)) / max(base.g, 1e-4);
    return mix(1.0, smoothstep(0.02, 0.20, green), uFoliageSelect);
  }

  /** The bloom an individual plant carries, somewhere between the two colors. */
  vec3 blossomHue(float seed) {
    // A second hash off the same seed, so the tree that flowers pink is not
    // also the tree that turns reddest in autumn — one seed, uncorrelated uses.
    return mix(uBlossomColor, uBlossomAlt, smoothstep(0.3, 0.7, fract(seed * 91.3187)));
  }

  /** How thickly petals cover this plant right now, 0–1. */
  float blossomFall(float stage, float seed) {
    if (uBlossomStrength <= 0.0) return 0.0;

    // Spring only. Autumn passes through the identical temperatures, so
    // uFoliageWarming is the entire reason flowers don't open in October.
    float spring = smoothstep(0.55, 0.95, uFoliageWarming);

    // A bump through the middle of the turn: blossom comes to a half-bare tree
    // and is gone by the time it's in full leaf. Because it rides the turn and
    // not the calendar, the bloom climbs the map — valleys flower while the
    // hills above are still bare, exactly as the snowline retreats.
    float window = smoothstep(0.1, 0.42, stage) * (1.0 - smoothstep(0.5, 0.8, stage));

    // A tree either blooms or it doesn't; a wood half-flowering everywhere
    // reads as a color wash rather than as individual trees in bloom.
    float blooms = fract(seed * 43.7585) < uBlossomShare ? 1.0 : 0.0;

    return spring * window * blooms * uBlossomStrength;
  }

  /**
   * base — the surface's summer color, as authored
   * temp — season-adjusted temperature, 0–1 (climate texture's A channel)
   * seed — a stable per-instance/per-cell 0–1 hash, for hue variation
   */
  vec3 seasonalFoliage(vec3 base, float temp, float seed) {
    // 0 = full summer, 1 = bare. Runs "backwards" (high edge first) so falling
    // temperature drives the turn.
    float stage = 1.0 - smoothstep(uFoliageBareTemp, uFoliageGreenTemp, temp);
    if (stage <= 0.0) return base;

    float mask = foliageMask(base);
    if (mask <= 0.0) return base;  // bark, rock, sand — nothing to turn

    // A wood where every tree turns the same gold reads as a single decal, so
    // push a share of them redder and darker by a per-instance hash. Applied to
    // the autumn color alone rather than to the blended mid — folded in later it
    // would muddy spring green and drag a pink blossom brown.
    vec3 autumn = mix(uFoliageAutumn, uFoliageAutumn * vec3(1.18, 0.76, 0.62), seed * uFoliageVariance);
    vec3 mid    = mix(autumn, uFoliageSpring, uFoliageWarming);

    vec3 target = stage < 0.5
      ? mix(uFoliageSummer, mid, stage * 2.0)
      : mix(mid, uFoliageBare, stage * 2.0 - 1.0);

    // Clamped because a palette color with a near-black channel would otherwise
    // divide its way to a blowout.
    vec3 ratio  = clamp(target / max(uFoliageSummer, vec3(1e-3)), vec3(0.0), vec3(8.0));
    vec3 turned = base * mix(vec3(1.0), ratio, uFoliageStrength * mask);

    // Blossom goes on as a layer over the canopy rather than as another stop in
    // the palette, because petals are a different thing from a leaf: they cover
    // the tree, they don't recolor it. It also happens to be the only way green
    // reaches pink or blue — those are a hue swing the ratio can't make without
    // running past its clamp.
    return mix(turned, blossomHue(seed), blossomFall(stage, seed) * mask);
  }
`;

// Shared 1×1 texture used when seasons are off (the sampler must still bind).
let _dummyClimateTex: THREE.DataTexture | null = null;
function dummyClimateTexture(): THREE.DataTexture {
  if (!_dummyClimateTex) {
    _dummyClimateTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    _dummyClimateTex.needsUpdate = true;
  }
  return _dummyClimateTex;
}

/** Builds the climate-lookup uniform set matching {@link SEASON_VERT_DECL}. */
export function seasonUniforms(): Record<string, THREE.IUniform> {
  return {
    uClimateData:   { value: dummyClimateTexture() },
    uClimateSize:   { value: new THREE.Vector2(1, 1) },
    uSeasonEnabled: { value: 0 },
  };
}

/**
 * Builds the freeze uniforms for a liquid material. `freezePoint` is the
 * season-adjusted temperature at or below which this liquid turns solid, on
 * the same 0–1 scale the temperature field uses; `undefined` means it never
 * freezes, which is what lava and acid want.
 */
export function freezeUniforms(freezePoint?: number, freezeBand = 0.06): Record<string, THREE.IUniform> {
  return {
    uFreezePoint: { value: freezePoint ?? -1 },
    uFreezeBand:  { value: freezeBand },
  };
}

/** Builds the appearance uniform set matching {@link SNOW_GLSL}. */
export function snowAppearanceUniforms(): Record<string, THREE.IUniform> {
  return {
    uSnowColor: { value: new THREE.Color(0xffffff) },
    uSnowSlope: { value: 1 },
    uSnowNoise: { value: 0.5 },
  };
}

/**
 * Builds the appearance uniform set matching {@link FOLIAGE_GLSL}.
 *
 * `summer` is the reference the whole palette is applied *relative to* — pass
 * the surface's own as-authored green (a scatter material's `color`, the pack's
 * grassland color) and midsummer comes out untouched. See {@link FOLIAGE_GLSL}.
 *
 * The rest of `opts` seeds the palette, for a surface whose defaults should
 * differ from a plant's: the terrain shader turns straw rather than rust,
 * because ground cover does not do what a canopy does.
 */
export function foliageUniforms(opts: FoliageTintOptions = {}): Record<string, THREE.IUniform> {
  return {
    uFoliageSummer:    { value: new THREE.Color(opts.summer     ?? 0x5e8c2a) },
    uFoliageSpring:    { value: new THREE.Color(opts.spring     ?? 0x93c33c) },
    uFoliageAutumn:    { value: new THREE.Color(opts.autumn     ?? 0xc4801e) },
    uFoliageBare:      { value: new THREE.Color(opts.bare       ?? 0x6d5a44) },
    // Above uFoliageGreenTemp foliage is fully green; below uFoliageBareTemp it
    // is fully bare. Both sit above SeasonOptions.snowThreshold (0.22) on
    // purpose — leaves turn and drop before the first snow lies on them.
    uFoliageGreenTemp: { value: opts.greenTemp ?? 0.5 },
    uFoliageBareTemp:  { value: opts.bareTemp  ?? 0.26 },
    uFoliageStrength:  { value: opts.strength  ?? 1 },
    uFoliageSelect:    { value: opts.select    ?? 1 },
    uFoliageVariance:  { value: opts.variance  ?? 0.5 },
    uFoliageWarming:   { value: 0.5 },
    // Both ends of the petal range keep some red in them. A pure blue blossom
    // sits too close in value to pale rock and hazy distance, and reads as
    // stone rather than as flowers — lilac stays cool without that.
    uBlossomColor:     { value: new THREE.Color(opts.blossom    ?? 0xf2a8c8) },
    uBlossomAlt:       { value: new THREE.Color(opts.blossomAlt ?? 0xb9a8e8) },
    uBlossomShare:     { value: opts.blossomShare ?? 0.5 },
    // Blossom is off here and switched on by attachSeasonalTint: that call
    // means "this is a deciduous plant", where the terrain shader shares these
    // uniforms and must not flower.
    uBlossomStrength:  { value: opts.blossomStrength ?? 0 },
  };
}

/**
 * Default petal coverage `attachSeasonalTint` switches on.
 *
 * Short of 1 on purpose: some canopy showing through is what makes a bloom read
 * as petals *on* a tree rather than as a repainted tree, and it keeps a wood in
 * flower from going flat.
 */
export const DEFAULT_BLOSSOM_STRENGTH = 0.7;

// ---------------------------------------------------------------------------
// Stock-material patching (shared by attachSnow and attachSeasonalTint)
// ---------------------------------------------------------------------------

/** Marks a shader whose climate lookup has already been injected. */
const SEASON_LOOKUP_MARK = '// hex-world season lookup';

/**
 * Marks the point in a stock material's fragment shader where seasonal effects
 * go, immediately after `<color_fragment>`.
 *
 * It exists so the two effects compose in a fixed order however they were
 * attached: the tint inserts *before* the slot and snow *after* it, which is
 * the only order that makes sense — snow lies on top of autumn leaves, it does
 * not turn gold with them.
 */
export const SEASON_COLOR_SLOT = '// hex-world season color slot';

/** A three.js shader object as `onBeforeCompile` hands it over. */
interface ShaderSource { vertexShader: string; fragmentShader: string }

/**
 * Inject the per-cell climate lookup into a stock material, once per shader
 * however many seasonal effects are attached to it — a second copy would
 * redeclare `cellIndex` and fail to compile.
 *
 * Publishes five varyings for the effects to read:
 * `vSeasonSnow` (depth), `vSeasonTemp` (season-adjusted temperature),
 * `vSeasonSeed` (a stable per-instance hash), `vSeasonUp` (how far the surface
 * faces the sky, in *world* space so it doesn't swing with the camera), and
 * `vSeasonWorldXZ`.
 *
 * Requires a per-instance (or per-vertex) `cellIndex` attribute —
 * `buildScatterMeshes` attaches one to every scatter mesh. Without it every
 * instance reads cell 0.
 */
export function injectSeasonLookup(shader: ShaderSource): void {
  if (shader.vertexShader.includes(SEASON_LOOKUP_MARK)) return;

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', /* glsl */`#include <common>
  ${SEASON_LOOKUP_MARK}
  attribute float cellIndex;
  uniform sampler2D uClimateData;
  uniform vec2  uClimateSize;
  uniform float uSeasonEnabled;
  varying float vSeasonSnow;
  varying float vSeasonTemp;
  varying float vSeasonSeed;
  varying float vSeasonUp;
  varying vec2  vSeasonWorldXZ;`)
    // objectNormal exists from here on; take the normal before three bends it
    // into view space, so the "faces the sky" test stays a world-space one.
    .replace('#include <beginnormal_vertex>', /* glsl */`#include <beginnormal_vertex>
  {
    vec3 seasonN = objectNormal;
    #ifdef USE_INSTANCING
      seasonN = mat3(instanceMatrix) * seasonN;
    #endif
    vSeasonUp = normalize(mat3(modelMatrix) * seasonN).y;
  }`)
    .replace('#include <project_vertex>', /* glsl */`#include <project_vertex>
  {
    // Rebuilt from transformed rather than three's worldPosition, which only
    // exists under certain defines.
    vec4 seasonWorld = vec4(transformed, 1.0);
    #ifdef USE_BATCHING
      seasonWorld = batchingMatrix * seasonWorld;
    #endif
    #ifdef USE_INSTANCING
      seasonWorld = instanceMatrix * seasonWorld;
    #endif
    vSeasonWorldXZ = (modelMatrix * seasonWorld).xz;

    // Seeded from the instance ORIGIN, not the vertex — one hash for the whole
    // model, so a tree takes a single autumn color rather than a gradient.
    vec3 seasonOrigin = modelMatrix[3].xyz;
    #ifdef USE_INSTANCING
      seasonOrigin += mat3(modelMatrix) * instanceMatrix[3].xyz;
    #endif
    vSeasonSeed = fract(sin(dot(seasonOrigin.xz, vec2(127.1, 311.7))) * 43758.5453);

    if (uSeasonEnabled > 0.5) {
      float sx = mod(cellIndex, uClimateSize.x);
      float sy = floor(cellIndex / uClimateSize.x);
      vec4 cd  = texture2D(uClimateData, (vec2(sx, sy) + 0.5) / uClimateSize);
      vSeasonSnow = cd.b;
      vSeasonTemp = cd.a;
    } else {
      vSeasonSnow = 0.0;
      vSeasonTemp = 1.0;   // "warm" — foliage stays summer green while off
    }
  }`);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', /* glsl */`#include <common>
  ${SEASON_LOOKUP_MARK}
  uniform float uSeasonEnabled;
  varying float vSeasonSnow;
  varying float vSeasonTemp;
  varying float vSeasonSeed;
  varying float vSeasonUp;
  varying vec2  vSeasonWorldXZ;`);
}

/** Ensure {@link SEASON_COLOR_SLOT} is present, so effects can sort themselves around it. */
export function ensureSeasonColorSlot(fragmentShader: string): string {
  return fragmentShader.includes(SEASON_COLOR_SLOT)
    ? fragmentShader
    : fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\n  ${SEASON_COLOR_SLOT}`);
}

/**
 * The climate-lookup uniforms for a stock material, created on first use and
 * shared by every seasonal effect attached to it.
 *
 * Shared by *identity*, not by value: snow and the foliage tint hand three.js
 * the same `uSeasonEnabled` object, so `configureSeason` writing it once reaches
 * both. Two independently-built sets would collide in `shader.uniforms` and one
 * of them would end up bound to nothing.
 */
export function seasonBindingUniforms(material: THREE.Material): Record<string, THREE.IUniform> {
  let set = material.userData.hexWorldSeason as Record<string, THREE.IUniform> | undefined;
  if (!set) {
    set = seasonUniforms();
    material.userData.hexWorldSeason = set;
  }
  return set;
}

/** How snow reads on a surface. All fields optional — unset fields keep their current value. */
export interface SnowAppearanceOptions {
  /** Show or hide snow. Defaults to true when {@link configureSeason} is called. */
  enabled?: boolean;
  /** Tint multiplied over the snow color. Default white (the pack's snow texture as authored). */
  color?: THREE.ColorRepresentation;
  /**
   * How strongly slope sheds snow: 1 leaves cliff faces bare, 0 buries
   * everything regardless of angle. Default 1.
   */
  slope?: number;
  /** How much noise frays the snowline. 0 is a clean contour. Default 0.5. */
  noise?: number;
  /**
   * Texture-array layer holding the snow surface, for materials that sample the
   * terrain atlas. -1 falls back to a flat {@link SnowAppearanceOptions.color}.
   * `ChunkManager` resolves this from the pack's `snow` terrain automatically.
   */
  snowTerrain?: number;
}

/**
 * How foliage turns through the year. All fields optional — unset fields keep
 * their current value. See {@link FOLIAGE_GLSL} for what each one does to the
 * math.
 */
export interface FoliageTintOptions {
  /**
   * The surface's own as-authored green — the reference the whole palette is
   * applied relative to, so high summer is exactly a no-op.
   * {@link attachSeasonalTint} defaults it to the material's `color`;
   * `HexWorld` resolves the terrain's from the pack (see
   * {@link resolveFoliageColor}).
   */
  summer?: THREE.ColorRepresentation;
  /** Colour of new growth, seen on the way *up* from bare. Default a fresh yellow-green. */
  spring?: THREE.ColorRepresentation;
  /** Colour of the turn, seen on the way *down* to bare. Default a burnt gold. */
  autumn?: THREE.ColorRepresentation;
  /** Winter's dormant colour, at and below {@link bareTemp}. Default a grey-brown. */
  bare?: THREE.ColorRepresentation;
  /** Season-adjusted temperature at or above which foliage is fully green. Default 0.5. */
  greenTemp?: number;
  /** …and at or below which it is fully bare. Default 0.26 — above the snowline, so leaves turn before snow lies. */
  bareTemp?: number;
  /** Overall strength, 0 (no tint) to 1 (the full palette). Default 1. */
  strength?: number;
  /**
   * How strictly the tint is confined to the green parts of the surface: 1
   * leaves bark, rock and sand alone, 0 tints everything evenly. Default 1;
   * use 0 on a mesh that is foliage all over.
   */
  select?: number;
  /** How far individual plants stray from the shared autumn colour, 0–1. Default 0.5. */
  variance?: number;

  /**
   * Petal colour of a plant in bloom. Individual plants land somewhere between
   * this and {@link blossomAlt}, so one wood carries a range. Default a soft
   * pink.
   */
  blossom?: THREE.ColorRepresentation;
  /** The other end of the blossom range. Default a pale blue. */
  blossomAlt?: THREE.ColorRepresentation;
  /** Fraction of plants that flower at all, 0–1. Default 0.5. */
  blossomShare?: number;
  /**
   * How thickly petals cover a flowering plant at the peak of the bloom, 0
   * (never flowers) to 1 (petals only). {@link attachSeasonalTint} switches
   * this on at 0.85; it is 0 everywhere else, which is what keeps the terrain
   * from flowering.
   */
  blossomStrength?: number;
}

/** Everything {@link configureSeason} can style in one call. */
export interface SeasonAppearanceOptions extends SnowAppearanceOptions {
  /** Foliage tint styling, for materials carrying {@link attachSeasonalTint} or the terrain shader. */
  foliage?: FoliageTintOptions;
}

/**
 * Point a material at a {@link ClimateData} and style its snow, enabling the
 * effect unless `enabled: false` is passed. Safe on any material — one that
 * doesn't declare the uniforms is skipped, so a custom material opts out simply
 * by not having them.
 *
 * Pass `null` for the climate to detach without disturbing the styling.
 *
 * @example
 * configureSeason(world.terrainMaterial, climate);
 * configureSeason(mat, climate, { noise: 0.2, slope: 0.6 });
 * setSeasonEnabled(mat, false);
 */
export function configureSeason(
  material: THREE.Material,
  climate: ClimateData | null,
  opts: SeasonAppearanceOptions = {},
): void {
  const sets = seasonUniformSets(material);
  if (sets.length === 0) return;

  for (const u of sets) {
    if (climate) {
      u.uClimateData.value = climate.texture;
      (u.uClimateSize.value as THREE.Vector2).set(climate.width, climate.height);
    } else {
      u.uClimateData.value = dummyClimateTexture();
      (u.uClimateSize.value as THREE.Vector2).set(1, 1);
    }
  }

  styleSnow(material, opts);
  if (opts.foliage) styleFoliage(material, opts.foliage);
  const enabled = climate && (opts.enabled ?? true) ? 1 : 0;
  for (const u of sets) u.uSeasonEnabled.value = enabled;
}

/**
 * Restyle snow without touching which {@link ClimateData} the material is bound
 * to — the safe call when you only want to change how winter *looks*.
 * {@link configureSeason} calls this after binding.
 */
export function styleSnow(material: THREE.Material, opts: SnowAppearanceOptions = {}): void {
  for (const u of seasonUniformSets(material)) {
    if (opts.color !== undefined && u.uSnowColor) (u.uSnowColor.value as THREE.Color).set(opts.color);
    if (opts.slope !== undefined && u.uSnowSlope) u.uSnowSlope.value = opts.slope;
    if (opts.noise !== undefined && u.uSnowNoise) u.uSnowNoise.value = opts.noise;
    if (opts.snowTerrain !== undefined && u.uSnowTerrain) u.uSnowTerrain.value = opts.snowTerrain;
    if (opts.enabled !== undefined && u.uSeasonEnabled) u.uSeasonEnabled.value = opts.enabled ? 1 : 0;
  }
}

/**
 * Restyle the seasonal foliage tint. Safe on any material — one without the
 * uniforms (a pine that got {@link attachSnow} but no tint, the road) is
 * skipped, which is how a conifer opts out of turning: it simply never receives
 * this patch.
 *
 * @example
 * // Warmer, more varied autumn on the broadleaf material.
 * styleFoliage(broadleafMat, { autumn: 0xd2601a, variance: 0.7 });
 * // A bush is foliage all over — skip the green test.
 * styleFoliage(bushMat, { select: 0 });
 */
export function styleFoliage(material: THREE.Material, opts: FoliageTintOptions = {}): void {
  for (const u of seasonUniformSets(material)) {
    if (!u.uFoliageSummer) continue;
    if (opts.summer    !== undefined) (u.uFoliageSummer.value as THREE.Color).set(opts.summer);
    if (opts.spring    !== undefined) (u.uFoliageSpring.value as THREE.Color).set(opts.spring);
    if (opts.autumn    !== undefined) (u.uFoliageAutumn.value as THREE.Color).set(opts.autumn);
    if (opts.bare      !== undefined) (u.uFoliageBare.value   as THREE.Color).set(opts.bare);
    if (opts.greenTemp !== undefined) u.uFoliageGreenTemp.value = opts.greenTemp;
    if (opts.bareTemp  !== undefined) u.uFoliageBareTemp.value  = opts.bareTemp;
    if (opts.strength  !== undefined) u.uFoliageStrength.value  = opts.strength;
    if (opts.select    !== undefined) u.uFoliageSelect.value    = opts.select;
    if (opts.variance  !== undefined) u.uFoliageVariance.value  = opts.variance;
    if (opts.blossom         !== undefined) (u.uBlossomColor.value as THREE.Color).set(opts.blossom);
    if (opts.blossomAlt      !== undefined) (u.uBlossomAlt.value   as THREE.Color).set(opts.blossomAlt);
    if (opts.blossomShare    !== undefined) u.uBlossomShare.value    = opts.blossomShare;
    if (opts.blossomStrength !== undefined) u.uBlossomStrength.value = opts.blossomStrength;
  }
}

/**
 * Tell a material which way the year is going, so it can decide whether a
 * half-turned leaf is spring green or autumn gold. Cheap enough to call every
 * frame; a no-op on a material with no foliage tint.
 *
 * `HexWorld` does this for you whenever the season advances or is scrubbed.
 * Drive it yourself with `seasons.phase` if you are wiring materials by hand.
 *
 * @example
 * seasons.advance(dt);
 * for (const mat of myFoliageMaterials) setSeasonPhase(mat, seasons.phase);
 */
export function setSeasonPhase(material: THREE.Material, phase: number): void {
  const warming = seasonWarming(phase);
  for (const u of seasonUniformSets(material)) {
    if (u.uFoliageWarming) u.uFoliageWarming.value = warming;
  }
}

/**
 * The color the foliage palette is applied *relative to* for a terrain set:
 * whichever active terrain has id `grassland`, falling back to the greenest
 * definition, and to a mid green if the pack has no green at all.
 *
 * The same auto-resolution {@link resolveSnowTerrain} does, and for the same
 * reason — a pack restyles the seasons by shipping its own terrain rather than
 * by configuring the renderer.
 */
export function resolveFoliageColor(
  definitions: ReadonlyArray<{ id: string; color: THREE.Color }>,
): THREE.Color {
  const named = definitions.find(d => d.id === 'grassland');
  if (named) return named.color;
  let best: THREE.Color | null = null;
  let bestGreen = 0;
  for (const d of definitions) {
    const green = d.color.g - Math.max(d.color.r, d.color.b);
    if (green > bestGreen) { bestGreen = green; best = d.color; }
  }
  return best ?? new THREE.Color(0x86b888);
}

/**
 * The texture-array layer to draw snow from: whichever active terrain has id
 * `snow`, or -1 if the pack has none (in which case snow falls back to a flat
 * tint). The same auto-resolution `riverbed` gets, so a custom pack restyles
 * winter by shipping its own `snow` terrain.
 *
 * Takes a structural type rather than `TerrainDefinition` to keep the season
 * module free of a dependency back on `geometry`.
 */
export function resolveSnowTerrain(definitions: ReadonlyArray<{ id: string; index: number }>): number {
  return definitions.find(d => d.id === 'snow')?.index ?? -1;
}

/** Show or hide seasonal snow, ice and foliage tint on a material without touching its styling. */
export function setSeasonEnabled(material: THREE.Material, enabled: boolean): void {
  for (const u of seasonUniformSets(material)) u.uSeasonEnabled.value = enabled ? 1 : 0;
}

/**
 * Every uniform set on a material that seasons write to: a ShaderMaterial's own
 * `uniforms`, plus whatever `attachSnow` and `attachSeasonalTint` parked in
 * `userData` (the way `attachAtmosphere` does, because a stock material has no
 * `uniforms` of its own).
 *
 * The `userData` sets alias the shared binding uniforms
 * ({@link seasonBindingUniforms}), so writing `uSeasonEnabled` through each of
 * them in turn is redundant rather than contradictory.
 */
function seasonUniformSets(material: THREE.Material): Record<string, THREE.IUniform>[] {
  const sets: Record<string, THREE.IUniform>[] = [];
  const own = (material as THREE.ShaderMaterial).uniforms;
  if (own && 'uSeasonEnabled' in own) sets.push(own);
  for (const key of ['hexWorldSeason', 'hexWorldSnow', 'hexWorldFoliage']) {
    const set = material.userData?.[key] as Record<string, THREE.IUniform> | undefined;
    if (set && 'uSeasonEnabled' in set) sets.push(set);
  }
  return sets;
}
