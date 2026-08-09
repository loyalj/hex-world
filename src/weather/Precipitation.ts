import * as THREE from 'three';
import { CLOUD_GLSL } from './CloudShadows.js';

export type PrecipitationType = 'rain' | 'snow';

export interface PrecipitationOptions {
  /** 'rain' (falling line streaks) or 'snow' (drifting soft points). Default 'rain'. */
  type?: PrecipitationType;
  /**
   * Maximum particle count at intensity 1. Default: derived from `area` at a
   * constant density (~0.65 drops/unit² rain, ~0.5 flakes/unit² snow), so
   * resizing the volume keeps the same on-screen density.
   */
  count?: number;
  /**
   * Side length of the particle volume in world units. Size it to cover the
   * camera's ground footprint at max zoom — the volume rim (faded) should
   * stay off screen. Default 140 (matches the default camera's 80-distance
   * max zoom on a wide viewport).
   */
  area?: number;
  /** Height of the particle volume in world units. Default 30. */
  height?: number;
  /** Fall speed in world units/sec. Default 26 (rain) / 3.2 (snow). */
  fallSpeed?: number;
  /** Horizontal wind drift in world units/sec. Default (0, 0). */
  wind?: THREE.Vector2;
  /** Particle color. Default 0xc4d4e8 (rain) / 0xffffff (snow). */
  color?: THREE.ColorRepresentation;
  /** Particle opacity at intensity 1. Default 0.5 (rain) / 0.9 (snow). */
  opacity?: number;
  /** Rain streak length in world units (ignored for snow). Default 0.7. */
  streak?: number;
  /** Snow sway amplitude in world units (ignored for rain). Default 1.1. */
  sway?: number;
  /** Snow flake size (perspective-attenuated; ignored for rain). Default 3. */
  size?: number;
  /** Initial intensity 0–1 (see setIntensity). Default 1. */
  intensity?: number;
}

// Shared vertex-shader body. Particles are WORLD-ANCHORED: each particle's
// position is derived from its seed with wrap-around arithmetic relative to
// uCenter, so panning the camera does not move any particle — it only slides
// the finite volume (the rendering budget) across an effectively infinite
// field. A particle leaving the trailing edge of the volume reappears at the
// leading edge, out at the faded rim where the swap is invisible.
function vertexShader(type: PrecipitationType): string {
  const isRain = type === 'rain';
  return /* glsl */`
    uniform float uTime;
    uniform vec3  uCenter;
    uniform float uArea;
    uniform float uHeight;
    uniform float uFallSpeed;
    // The instantaneous wind — used ONLY to aim the rain streak, which is a
    // direction and so is correct to read live.
    uniform vec2  uWind;
    // How far the field has actually blown, integrated on the CPU. Horizontal
    // drift reads this and never \`uWind * uTime\`: with a wind that gusts, the
    // product jumps by (change in wind) × (elapsed time) the instant the wind
    // moves, which after a minute of running teleports the whole field tens of
    // units sideways. Integrating turns the same gust into a nudge.
    uniform vec2  uWindOffset;
    uniform float uOpacity;
    ${isRain ? 'uniform float uStreak;' : 'uniform float uSway;\n    uniform float uSize;'}

    // Cloud gate — same field the terrain's cloud shadows sample, so
    // precipitation falls only under (the denser of) the clouds shading the
    // ground. Disabled -> uniform precipitation everywhere.
    uniform float uCloudGate;
    uniform vec2  uCloudOffset;
    uniform float uCloudScale;
    uniform float uCloudCoverage;

    // Per-cell weather mask: a texture spanning uMaskRect (xy = world min
    // corner, zw = size) whose selected channel scales precipitation 0..1 at
    // that world position. A ClimateData drives this — snow gates on the snow
    // channel, rain on its inverse, so the two never fall on the same hex.
    uniform float uMaskEnabled;
    uniform sampler2D uMask;
    uniform vec4  uMaskRect;
    uniform vec4  uMaskChannel;
    uniform float uMaskInvert;

    attribute float aSeed;
    ${isRain ? 'attribute float aTip;' : ''}

    varying float vAlpha;

    ${CLOUD_GLSL}

    void main() {
      float speed = uFallSpeed * (0.7 + aSeed * 0.6);
      float y = mod(position.y - uTime * speed, uHeight);
      vec2 xz = position.xz + uWindOffset;
      ${isRain ? '' : `
      // Flakes wander instead of falling straight.
      xz += uSway * vec2(sin(uTime * 0.8 + aSeed * 39.0 + y * 0.4),
                         cos(uTime * 0.7 + aSeed * 27.0 + y * 0.33));`}

      // World-anchored wrap into the volume around uCenter.
      vec2 minC  = uCenter.xz - uArea * 0.5;
      vec2 world = mod(xz - minC, uArea) + minC;

      vAlpha = uOpacity;
      // Fade toward the volume rim so the finite budget has no hard edge.
      float rim = length(world - uCenter.xz) / (uArea * 0.5);
      vAlpha *= 1.0 - smoothstep(0.78, 1.0, rim);

      if (uCloudGate > 0.5) {
        vAlpha *= cloudMask(cloudField(world, uCloudOffset, uCloudScale), uCloudCoverage);
      }
      if (uMaskEnabled > 0.5) {
        vec2 muv = (world - uMaskRect.xy) / uMaskRect.zw;
        // uMaskChannel is a one-hot selector, so any channel of the bound
        // texture can drive the gate without a branch per channel.
        float m = dot(texture2D(uMask, clamp(muv, 0.0, 1.0)), uMaskChannel);
        vAlpha *= mix(m, 1.0 - m, uMaskInvert);
      }

      vec3 wp = vec3(world.x, uCenter.y + y, world.y);
      ${isRain ? `
      // Tail vertex stretches along the fall velocity — a real motion streak.
      if (aTip > 0.5) wp += normalize(vec3(uWind.x, -speed, uWind.y)) * uStreak;` : ''}

      vec4 mv = viewMatrix * vec4(wp, 1.0);
      ${isRain ? '' : 'gl_PointSize = uSize * (120.0 / max(-mv.z, 1.0));'}
      gl_Position = projectionMatrix * mv;
    }
  `;
}

function fragmentShader(type: PrecipitationType): string {
  return type === 'rain'
    ? /* glsl */`
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        if (vAlpha < 0.004) discard;
        gl_FragColor = vec4(uColor, vAlpha);
      }
    `
    : /* glsl */`
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = vAlpha * smoothstep(1.0, 0.55, d);
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `;
}

/**
 * A camera-following volume of GPU-animated rain streaks or snowflakes.
 *
 * The volume (an `area` × `height` × `area` box) is repositioned to the
 * camera target each frame, but the particles inside are world-anchored (see
 * the vertex-shader note), so panning never drags precipitation along — drops
 * fall over the same hexes regardless of the camera. All motion (fall, wind,
 * snow sway, streaks) runs in the vertex shader from a single time uniform;
 * per-frame CPU cost is two uniform writes.
 *
 * Pair with the terrain's cloud shadows through {@link setCloudGate} (a
 * WeatherSystem does this automatically) so rain only falls under the denser
 * clouds, and lighter clouds are just clouds.
 *
 * @example
 * const rain = new PrecipitationLayer({ type: 'rain' }).addTo(scene);
 * // per frame:
 * rain.update(dt, controls.targetPosition);
 */
export class PrecipitationLayer {
  readonly type: PrecipitationType;
  /** The drawable — LineSegments for rain, Points for snow. Already added by addTo. */
  readonly object: THREE.LineSegments | THREE.Points;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly count: number;
  private readonly vertsPerParticle: number;
  private readonly baseOpacity: number;
  private elapsed = 0;
  private _intensity: number;

  constructor(opts: PrecipitationOptions = {}) {
    this.type = opts.type ?? 'rain';
    const isRain = this.type === 'rain';

    const area = opts.area ?? 140;
    // Default count follows the volume so density stays constant; capped so a
    // huge custom area asks for an explicit count instead of silently
    // allocating millions of vertices.
    const defaultCount = Math.min(60000, Math.round(area * area * (isRain ? 0.65 : 0.5)));
    this.count = Math.max(1, Math.floor(opts.count ?? defaultCount));
    this.vertsPerParticle = isRain ? 2 : 1;
    const height    = opts.height    ?? 30;
    const fallSpeed = opts.fallSpeed ?? (isRain ? 26 : 3.2);
    this.baseOpacity = opts.opacity  ?? (isRain ? 0.5 : 0.9);

    const verts = this.count * this.vertsPerParticle;
    const positions = new Float32Array(verts * 3);
    const seeds     = new Float32Array(verts);
    const tips      = isRain ? new Float32Array(verts) : null;

    for (let i = 0; i < this.count; i++) {
      const x = Math.random() * area;
      const y = Math.random() * height;
      const z = Math.random() * area;
      const seed = Math.random();
      for (let v = 0; v < this.vertsPerParticle; v++) {
        const j = i * this.vertsPerParticle + v;
        positions[j * 3]     = x;
        positions[j * 3 + 1] = y;
        positions[j * 3 + 2] = z;
        seeds[j] = seed;
        if (tips) tips[j] = v; // head 0, tail 1
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('aSeed',    new THREE.BufferAttribute(seeds, 1));
    if (tips) this.geometry.setAttribute('aTip', new THREE.BufferAttribute(tips, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:      { value: 0 },
        uCenter:    { value: new THREE.Vector3() },
        uArea:      { value: area },
        uHeight:    { value: height },
        uFallSpeed: { value: fallSpeed },
        uWind:      { value: (opts.wind ?? new THREE.Vector2(0, 0)).clone() },
        uWindOffset: { value: new THREE.Vector2() },
        uColor:     { value: new THREE.Color(opts.color ?? (isRain ? 0xc4d4e8 : 0xffffff)) },
        uOpacity:   { value: this.baseOpacity },
        ...(isRain
          ? { uStreak: { value: opts.streak ?? 0.7 } }
          : { uSway:   { value: opts.sway   ?? 1.1 },
              uSize:   { value: opts.size   ?? 3 } }),
        uCloudGate:     { value: 0 },
        uCloudOffset:   { value: new THREE.Vector2() },
        uCloudScale:    { value: 48 },
        uCloudCoverage: { value: 0.5 },
        uMaskEnabled:   { value: 0 },
        uMask:          { value: null },
        uMaskRect:      { value: new THREE.Vector4(0, 0, 1, 1) },
        uMaskChannel:   { value: new THREE.Vector4(1, 0, 0, 0) },
        uMaskInvert:    { value: 0 },
      },
      vertexShader:   vertexShader(this.type),
      fragmentShader: fragmentShader(this.type),
      transparent: true,
      depthWrite:  false,
    });

    this.object = isRain
      ? new THREE.LineSegments(this.geometry, this.material)
      : new THREE.Points(this.geometry, this.material);
    // The shader outputs world-space positions directly (the object never
    // moves), so three's frustum test against the static local bounds is
    // meaningless — disable it.
    this.object.frustumCulled = false;
    this.object.renderOrder = 10; // over terrain, liquids, and overlays

    this._intensity = 1;
    this.setIntensity(opts.intensity ?? 1);
  }

  /** Add the layer to a scene (or any parent). */
  addTo(parent: THREE.Object3D): this {
    parent.add(this.object);
    return this;
  }

  /** Current intensity 0–1. */
  get intensity(): number { return this._intensity; }

  /**
   * Fade precipitation: scales how many particles are drawn (drawRange — no
   * reallocation) and their opacity, so weather can ramp smoothly from
   * drizzle to downpour.
   */
  setIntensity(intensity: number): void {
    this._intensity = THREE.MathUtils.clamp(intensity, 0, 1);
    const particles = Math.floor(this.count * this._intensity);
    this.geometry.setDrawRange(0, particles * this.vertsPerParticle);
    this.material.uniforms.uOpacity.value = this.baseOpacity * (0.55 + 0.45 * this._intensity);
    this.object.visible = particles > 0;
  }

  /**
   * Set the horizontal wind drift (world units/sec). Streak direction follows.
   *
   * Safe to call every frame with a gusting wind: the drift it feeds is
   * integrated in {@link update}, so a change of wind bends the fall from where
   * it had got to rather than displacing the whole field.
   */
  setWind(wind: THREE.Vector2): void {
    (this.material.uniforms.uWind.value as THREE.Vector2).copy(wind);
  }

  /**
   * Link (or unlink) precipitation to a cloud field: only where the field
   * exceeds the coverage threshold does precipitation fall. Pass the SAME
   * offset/scale the terrain cloud shadows use, and a coverage at or below
   * the shadows' coverage — the difference is the "clouds that are just
   * clouds" margin.
   */
  setCloudGate(gate: { enabled: boolean; offset?: THREE.Vector2; scale?: number; coverage?: number }): void {
    const u = this.material.uniforms;
    u.uCloudGate.value = gate.enabled ? 1 : 0;
    if (gate.offset)                u.uCloudOffset.value.copy(gate.offset);
    if (gate.scale !== undefined)   u.uCloudScale.value = Math.max(gate.scale, 1e-3);
    if (gate.coverage !== undefined) u.uCloudCoverage.value = THREE.MathUtils.clamp(gate.coverage, 0, 1);
  }

  /** Keep the cloud gate's drift in sync (called per frame by WeatherSystem). */
  setCloudOffset(offset: THREE.Vector2): void {
    (this.material.uniforms.uCloudOffset.value as THREE.Vector2).copy(offset);
  }

  /**
   * Per-cell weather mask: a texture whose selected channel scales
   * precipitation at each world position. `rect` is the world-space span of
   * the texture (min corner + size). Pass null to clear.
   *
   * The seasons layer drives this with a `ClimateData` texture: snow gates on
   * the snow channel (`'b'`) and rain on the same channel inverted, so
   * precipitation falls as snow exactly where snow is lying and as rain
   * everywhere else, with no band where both or neither appear.
   *
   * @example
   * snow.setMask(climate.texture, worldRect, { channel: 'b' });
   * rain.setMask(climate.texture, worldRect, { channel: 'b', invert: true });
   */
  setMask(
    texture: THREE.Texture | null,
    rect?: { x: number; z: number; width: number; depth: number },
    opts: { channel?: 'r' | 'g' | 'b' | 'a'; invert?: boolean } = {},
  ): void {
    const u = this.material.uniforms;
    u.uMask.value = texture;
    u.uMaskEnabled.value = texture ? 1 : 0;
    if (texture && rect) u.uMaskRect.value.set(rect.x, rect.z, rect.width, rect.depth);
    if (opts.channel !== undefined) {
      const c = opts.channel;
      (u.uMaskChannel.value as THREE.Vector4).set(
        c === 'r' ? 1 : 0, c === 'g' ? 1 : 0, c === 'b' ? 1 : 0, c === 'a' ? 1 : 0,
      );
    }
    if (opts.invert !== undefined) u.uMaskInvert.value = opts.invert ? 1 : 0;
  }

  /**
   * Advance the animation and recenter the volume — call once per frame with
   * the camera's ground target (e.g. RtsCameraController.targetPosition).
   */
  update(dt: number, center: { x: number; y?: number; z: number }): void {
    // Wrapped like ChunkManager's clock so the float32 uniform keeps
    // sub-frame precision in long sessions (one pop per ~4.5 h).
    this.elapsed = (this.elapsed + dt) % 16384;
    const u = this.material.uniforms;
    u.uTime.value = this.elapsed;
    // Integrate the drift rather than letting the shader recompute it — see
    // uWindOffset. Wrapped to the volume period, because the shader wraps the
    // field into uArea anyway: a modulo here is invisible on screen and keeps
    // the offset from growing until float32 loses sub-unit precision.
    const area = u.uArea.value as number;
    const off  = u.uWindOffset.value as THREE.Vector2;
    off.addScaledVector(u.uWind.value as THREE.Vector2, dt);
    off.set(off.x % area, off.y % area);
    (u.uCenter.value as THREE.Vector3).set(center.x, center.y ?? 0, center.z);
  }

  /** Remove from the scene graph and free GPU resources. */
  dispose(): void {
    this.object.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
