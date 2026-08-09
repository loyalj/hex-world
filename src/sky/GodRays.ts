import * as THREE from 'three';
// Type-only (erased at compile): DayNightCycle imports this module back for its
// `godRays` target, and SkyDome is only ever read through its public getters.
import type { SkyDome } from './SkyDome.js';
import type { DayNightState } from '../lighting/DayNightCycle.js';

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // A 2×2 plane is already in clip space — the composite never involves a
    // camera, so the dummy one handed to render() never has to be right.
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Radial blur toward the sun. `uOcclusion` holds 1 where the sky is visible and
 * 0 where geometry blocks it, so marching a pixel's samples toward the sun's
 * screen point accumulates exactly the open sky along that line — which is the
 * light that would have scattered into the eye there.
 *
 * The sample count is a `#define` rather than a uniform because GLSL1 requires
 * a constant loop bound; changing it rebuilds the material.
 */
function fragmentShader(samples: number): string {
  return /* glsl */`
  #define SAMPLES ${samples}

  uniform sampler2D uOcclusion;
  uniform vec2  uSunUV;
  uniform vec3  uColor;
  uniform float uDensity;
  uniform float uDecay;
  /** Overall gain, already divided by the decay series so a clear line of
      sight to the sun adds exactly the configured intensity. */
  uniform float uGain;

  varying vec2 vUv;

  void main() {
    vec2 delta = (vUv - uSunUV) * (uDensity / float(SAMPLES));

    // Marching every pixel from the same offset lays the sample points on
    // rings around the sun, which show up as banding in the open sky. A
    // per-pixel jitter of up to one step turns those rings into fine noise,
    // which at this sample count is far less visible than the bands.
    float jitter = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
    vec2 uv = vUv - delta * jitter;

    float decay = 1.0;
    float sum   = 0.0;
    for (int i = 0; i < SAMPLES; i++) {
      uv -= delta;
      sum += texture2D(uOcclusion, uv).r * decay;
      decay *= uDecay;
    }

    // Additive, and deliberately not color-space converted: the frame this
    // lands on has already been tone-mapped and encoded, and so has the sun
    // the dome drew, so the shafts have to be added in that same space.
    gl_FragColor = vec4(uColor * (sum * uGain), 1.0);
  }
`;
}

/** God-ray styling. Unset fields keep their current value. */
export interface GodRaysOptions {
  /**
   * The sky dome the shafts belong to. Two jobs: its mesh is kept out of the
   * occlusion pass (the sky is what the rays are *made of*, not something that
   * blocks them), and its overcast factor gates them, so a storm puts them out
   * along with the sun disc. Without one, feed overcast via
   * {@link GodRays.setOvercast}.
   */
  sky?: SkyDome | null;
  /** Draw the rays. Default true. */
  enabled?: boolean;
  /**
   * Brightness added where the line to the sun is completely open — i.e. the
   * value the shafts reach right at the sun disc, before the daylight and
   * overcast gates. Default 0.55.
   */
  intensity?: number;
  /**
   * How far along the line to the sun a pixel gathers, as a fraction of that
   * whole distance. 1 marches the full span for long shafts; lower values keep
   * the glow tight around the sun. Default 1.
   */
  density?: number;
  /**
   * Per-sample falloff, 0–1. The shafts' length: 0.9 is a short flare, 0.97
   * throws light most of the way across the frame. Default 0.93.
   */
  decay?: number;
  /**
   * Samples marched per pixel. The one real cost knob — 28 is smooth at
   * quarter resolution, 16 is visibly noisier but half the price. Changing it
   * rebuilds the shader. Default 28.
   */
  samples?: number;
  /**
   * Occlusion buffer size as a fraction of the drawing buffer. The mask is
   * blurred along its whole length anyway, so there is nothing to gain from
   * detail here. Default 0.25.
   */
  resolutionScale?: number;
  /**
   * Ray color. Null (the default) follows the sun's own color, so the shafts
   * go orange at dawn along with the light and the horizon.
   */
  color?: THREE.ColorRepresentation | null;
  /**
   * Objects that must not block the light: particles, screen-space overlays,
   * anything drawn without depth. The attached sky's dome is excluded for you.
   */
  exclude?: Iterable<THREE.Object3D>;
}

const _size    = new THREE.Vector2();
const _viewDir = new THREE.Vector3();
const _point   = new THREE.Vector3();
const _clear   = new THREE.Color();

/**
 * Crepuscular rays: light shafts fanning out from the sun around whatever
 * blocks it — a ridgeline, a forest, a cliff edge.
 *
 * The pass is the cheap classic. The scene is re-rendered at a fraction of the
 * resolution with every material replaced by flat black on a white clear, which
 * costs a depth-only-ish pass and yields a mask of where the sky is visible.
 * Each pixel of a full-screen quad then marches that mask toward the sun's
 * screen position, accumulating open sky with a per-step decay, and the result
 * is added to the frame.
 *
 * Deliberately **not** a composer: the main render never goes through a target,
 * so the renderer's MSAA survives and nothing re-encodes an already-final
 * image. Call {@link GodRays.render} straight after your own
 * `renderer.render(scene, camera)`.
 *
 * It is a sink, not a clock, exactly like {@link SkyDome} — feed it a
 * {@link DayNightState} (directly, or by naming it as a {@link DayNightCycle}
 * target) and it takes the sun from the same source the dome draws it from, so
 * the shafts always start where the sun disc is. Scattered light is what these
 * *are*, so they scale with `daylight` and die out under overcast: no shafts
 * from the moon, none through a solid cloud deck. When the gate closes the
 * whole pass is skipped, so a night frame costs nothing.
 *
 * @example
 * const rays = new GodRays({ sky });
 * // per frame:
 * cycle.applyTo({ sunRig, terrainMaterial, sky, godRays: rays });
 * renderer.render(scene, camera);
 * rays.render(renderer, scene, camera);
 */
export class GodRays {
  readonly material: THREE.ShaderMaterial;

  /** Half-res-ish sky mask: 1 = open sky, 0 = occluded. */
  private target: THREE.WebGLRenderTarget;
  private readonly occluder: THREE.MeshBasicMaterial;
  private readonly quad: THREE.Mesh;
  private readonly quadScene: THREE.Scene;
  private readonly quadCamera = new THREE.Camera();

  private sky: SkyDome | null;
  private _enabled: boolean;
  private intensity: number;
  private samples: number;
  private _resolutionScale: number;
  private tint: THREE.Color | null;

  private readonly excluded: THREE.Object3D[] = [];
  private readonly wasVisible: boolean[] = [];

  /** Sun direction and color, from whatever last drove the cycle. */
  private readonly sunDir   = new THREE.Vector3(0, 1, 0);
  private readonly sunColor = new THREE.Color(0xfff4d0);
  private _daylight = 1;
  private _overcast = 0;

  /** Where the sun lands on screen, in uv — also useful for a lens flare. */
  private readonly _sunUV = new THREE.Vector2(0.5, 0.5);
  private _strength = 0;

  constructor(opts: GodRaysOptions = {}) {
    this.sky              = opts.sky ?? null;
    this._enabled         = opts.enabled ?? true;
    this.intensity        = opts.intensity ?? 0.55;
    this.samples          = Math.max(4, Math.round(opts.samples ?? 28));
    this._resolutionScale = THREE.MathUtils.clamp(opts.resolutionScale ?? 0.25, 0.05, 1);
    this.tint             = opts.color != null ? new THREE.Color(opts.color) : null;

    this.target = new THREE.WebGLRenderTarget(2, 2, {
      // The mask is marched over dozens of samples, so bilinear filtering is
      // doing real work here — it is what turns a quarter-res silhouette back
      // into a soft edge. Clamping matters as much: once the sun is off frame
      // the march runs past the border, and wrapping would fold the far side
      // of the screen into the shafts.
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: true,     // silhouettes need the nearest surface to win
      stencilBuffer: false,
    });

    this.occluder = new THREE.MeshBasicMaterial({
      color: 0x000000,
      fog: false,
      // Nothing about this pass is a look — it is a binary mask, and tone
      // mapping it would only make the "black" depend on the exposure.
      toneMapped: false,
    });

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: fragmentShader(this.samples),
      uniforms: {
        uOcclusion: { value: this.target.texture },
        uSunUV:     { value: this._sunUV },
        uColor:     { value: new THREE.Color(0xfff4d0) },
        uDensity:   { value: opts.density ?? 1 },
        uDecay:     { value: THREE.MathUtils.clamp(opts.decay ?? 0.93, 0, 0.9999) },
        uGain:      { value: 0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);

    if (this.sky) this.excluded.push(this.sky.mesh);
    if (opts.exclude) for (const o of opts.exclude) this.exclude(o);
  }

  /** Whether the rays are drawn at all. */
  get enabled(): boolean { return this._enabled; }

  /** Occlusion buffer size as a fraction of the drawing buffer. */
  get resolutionScale(): number { return this._resolutionScale; }

  /**
   * How strongly the rays read right now, 0–1 — every gate multiplied
   * together. 0 means {@link GodRays.render} skipped the pass entirely.
   * Refreshed by {@link GodRays.update}.
   */
  get strength(): number { return this._strength; }

  /**
   * The sun's position on screen in uv (0–1, y up), the point the shafts fan
   * out from — hand it to a lens flare to put the two in the same place.
   * Reused between calls; may fall outside 0–1 with the sun off frame.
   */
  get sunScreenPosition(): THREE.Vector2 { return this._sunUV; }

  /** Show or hide the rays. */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    // Switched off nothing recomputes the gate, so park it at zero rather than
    // leaving the last frame's value for a HUD to report.
    if (!enabled) this._strength = 0;
  }

  /** Restyle at runtime. Unset fields keep their current value. */
  configure(opts: GodRaysOptions): void {
    if (opts.sky !== undefined) this.attachSky(opts.sky);
    if (opts.enabled !== undefined) this._enabled = opts.enabled;
    if (opts.intensity !== undefined) this.intensity = Math.max(opts.intensity, 0);
    if (opts.density !== undefined) this.material.uniforms.uDensity.value = opts.density;
    if (opts.decay !== undefined) {
      this.material.uniforms.uDecay.value = THREE.MathUtils.clamp(opts.decay, 0, 0.9999);
    }
    if (opts.resolutionScale !== undefined) {
      this._resolutionScale = THREE.MathUtils.clamp(opts.resolutionScale, 0.05, 1);
    }
    if (opts.color !== undefined) {
      this.tint = opts.color === null ? null : new THREE.Color(opts.color);
    }
    if (opts.exclude) for (const o of opts.exclude) this.exclude(o);
    if (opts.samples !== undefined) {
      const n = Math.max(4, Math.round(opts.samples));
      if (n !== this.samples) {
        this.samples = n;
        this.material.fragmentShader = fragmentShader(n);
        this.material.needsUpdate = true;
      }
    }
  }

  /**
   * Swap (or drop, with null) the dome the rays belong to — the overcast gate
   * and the mesh kept out of the occlusion pass move with it.
   */
  attachSky(sky: SkyDome | null): void {
    if (this.sky) this.include(this.sky.mesh);
    this.sky = sky;
    if (sky) this.exclude(sky.mesh);
  }

  /** Stop an object from blocking the light (particles, overlays, your own sky). */
  exclude(object: THREE.Object3D): void {
    if (!this.excluded.includes(object)) this.excluded.push(object);
  }

  /** Let an excluded object block the light again. */
  include(object: THREE.Object3D): void {
    const i = this.excluded.indexOf(object);
    if (i >= 0) this.excluded.splice(i, 1);
  }

  /**
   * Point the rays by hand — the standalone path for scenes without a
   * day/night cycle. `dirTowardSun` is the same vector the sky dome's sun is
   * drawn along, so the shafts start at the disc.
   */
  setSun(dirTowardSun: THREE.Vector3, color?: THREE.Color, daylight = 1): void {
    this.sunDir.copy(dirTowardSun).normalize();
    if (color) this.sunColor.copy(color);
    this._daylight = THREE.MathUtils.clamp(daylight, 0, 1);
  }

  /**
   * Adopt one moment of a {@link DayNightCycle}. Named as the cycle's
   * `godRays` target this is called for you every frame.
   *
   * It takes `sunDir`, never `lightDir`: the moon is the active light after
   * dark and pointing the shafts at it would fan them from the wrong side of
   * the sky. Below the horizon the sun's own height closes the gate instead.
   */
  setDayNight(state: DayNightState): void {
    this.sunDir.copy(state.sunDir).normalize();
    this.sunColor.copy(state.lightColor);
    this._daylight = state.daylight;
  }

  /**
   * How overcast the sky reads, 0–1 — a {@link WeatherSystem}'s `overcast`,
   * making this an overcast target like the dome. With a dome attached its
   * value wins, since the weather already drives it there.
   */
  setOvercast(overcast: number): void {
    this._overcast = THREE.MathUtils.clamp(overcast, 0, 1);
  }

  /**
   * Recompute everything the composite reads — the sun's screen position, the
   * ray color, the gain — and return the resulting {@link GodRays.strength}.
   * {@link GodRays.render} calls this itself; reach for it directly only to
   * drive something else off the same numbers.
   */
  update(camera: THREE.Camera): number {
    if (this.sky) this._overcast = this.sky.overcast;

    // The same two lines three's own render() opens with. Redundant on the
    // documented call site, but it costs one invert and it is what lets this
    // be called *before* the frame — driving a lens flare off
    // sunScreenPosition shouldn't lag the camera by a frame.
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    // Below the horizon the world itself is in the way, so the shafts switch
    // off at the same height the dome's disc does. They come *back* faster
    // than it, though: `daylight` below is already a ramp over sun height, and
    // repeating the dome's would square it — which would dim the rays to
    // nothing across dawn and dusk, the hours they most belong to.
    const above = THREE.MathUtils.smoothstep(this.sunDir.y, -0.05, 0.02);
    const clear = 1 - this._overcast * 0.92;

    // Behind the camera the projection mirrors, so the shafts would fan out of
    // a phantom sun on the wrong side. Fade out through the view plane.
    _viewDir.copy(this.sunDir).transformDirection(camera.matrixWorldInverse);
    const behind = THREE.MathUtils.smoothstep(-_viewDir.z, 0, 0.15);

    // For a perspective camera the projected direction is the same point at
    // any distance, so the exact scale is arbitrary; far/2 also keeps an
    // orthographic camera roughly honest.
    const reach = ((camera as THREE.PerspectiveCamera).far || 1000) * 0.5;
    _point.copy(this.sunDir).multiplyScalar(reach).add(camera.position).project(camera);
    if (behind > 0) this._sunUV.set(_point.x * 0.5 + 0.5, _point.y * 0.5 + 0.5);

    // Shafts still stream into frame from a sun well outside it, and a pitched
    // RTS camera looks *down* — the sun spends most of the day above the top
    // edge, so a fade that stopped at the viewport would mean a feature nobody
    // ever sees. Carrying it out to ~3× the frame is also cheap in artifacts:
    // the march runs from the pixel toward the sun and `decay` weights it the
    // same way, so the off-frame tail that clamps to the border is the part
    // that counts least.
    const offscreen = Math.max(Math.abs(_point.x), Math.abs(_point.y));
    const framed = behind > 0 ? 1 - THREE.MathUtils.smoothstep(offscreen, 1.1, 3.2) : 0;

    this._strength = this._daylight * above * clear * behind * framed;

    const decay = this.material.uniforms.uDecay.value as number;
    // Σ decay^i over the marched samples: dividing it out is what makes
    // `intensity` mean "brightness added at the sun" instead of a number whose
    // meaning shifts every time decay or the sample count is touched.
    const series = decay >= 1 ? this.samples : (1 - Math.pow(decay, this.samples)) / (1 - decay);
    this.material.uniforms.uGain.value = (this._strength * this.intensity) / series;
    (this.material.uniforms.uColor.value as THREE.Color).copy(this.tint ?? this.sunColor);

    return this._strength;
  }

  /**
   * Draw the rays over the frame. Call **after** `renderer.render(scene,
   * camera)` with the same three arguments — the pass reads the scene again
   * for its occlusion mask and adds to the image already on the canvas.
   *
   * A no-op while the gate is shut (night, heavy overcast, sun behind you), so
   * there is nothing to switch off outside daylight.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this._enabled) return;
    const strength = this.update(camera);
    if (strength <= 1e-4 || this.intensity <= 0) return;

    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevShadow    = renderer.shadowMap.autoUpdate;
    const prevOverride  = scene.overrideMaterial;
    const prevBackground = scene.background;
    const prevAlpha     = renderer.getClearAlpha();
    renderer.getClearColor(_clear);

    for (let i = 0; i < this.excluded.length; i++) {
      this.wasVisible[i] = this.excluded[i].visible;
      this.excluded[i].visible = false;
    }

    // The main pass has already drawn this frame's shadow maps; letting these
    // two extra renders redo them would double the scene's shadow cost.
    renderer.shadowMap.autoUpdate = false;

    // Nothing here may clear implicitly: the composite draws onto a finished
    // frame, and the mask's own wipe is issued by hand rather than through
    // autoClearColor/Depth, which the consumer may have turned off.
    renderer.autoClear = false;

    // Occlusion mask: white sky, black everything else. The background is
    // cleared away rather than drawn, so a scene.background color can't be
    // mistaken for geometry — or for sky, if it happens to be dark.
    this.resize(renderer); // before binding — a resize drops the target's buffers
    renderer.setRenderTarget(this.target);
    scene.overrideMaterial = this.occluder;
    scene.background = null;
    renderer.setClearColor(0xffffff, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
    renderer.setClearColor(_clear, prevAlpha);

    // Composite onto the frame that is already there.
    renderer.setRenderTarget(prevTarget);
    renderer.render(this.quadScene, this.quadCamera);

    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadow;
    for (let i = 0; i < this.excluded.length; i++) this.excluded[i].visible = this.wasVisible[i];
  }

  /** Match the occlusion buffer to the canvas, in drawing-buffer pixels. */
  private resize(renderer: THREE.WebGLRenderer): void {
    renderer.getDrawingBufferSize(_size);
    const w = Math.max(2, Math.round(_size.x * this._resolutionScale));
    const h = Math.max(2, Math.round(_size.y * this._resolutionScale));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
  }

  /** Free the occlusion buffer, the quad, and the override material. */
  dispose(): void {
    this.target.dispose();
    this.quad.geometry.dispose();
    this.material.dispose();
    this.occluder.dispose();
    this.excluded.length = 0;
  }
}
