import * as THREE from 'three';

export interface SunShadowOptions {
  /** Shadow map resolution (square). Default 2048. */
  mapSize?: number;
  /** Direction pointing from the scene TOWARD the sun (same convention as the terrain material's lightDir). Default (100, 120, 80). */
  direction?: THREE.Vector3;
  /** Sun color. Default 0xfff4d0 (warm). */
  color?: THREE.ColorRepresentation;
  /** Sun intensity. Default 1.4. */
  intensity?: number;
  /**
   * Furthest ground distance from the camera the shadow frustum covers, in
   * world units. Ground beyond this renders unshadowed; smaller values spend
   * the shadow map's texels on less area (crisper shadows). Default 90.
   */
  maxDistance?: number;
  /** Tallest shadow caster above the ground plane (terrain + scatter/units), world units. Default 14. */
  maxHeight?: number;
  /** Extra world units of margin around the fitted footprint. Default 2. */
  padding?: number;
  /** Depth bias passed to the shadow map. Default -0.0002. */
  bias?: number;
  /** World-space normal offset for shadow lookups — the main acne guard on low-poly terrain. Default 0.6. */
  normalBias?: number;
  /** Shadow darkness 0–1 (DirectionalLight.shadow.intensity). Default 1. */
  shadowIntensity?: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_RIGHT = new THREE.Vector3(1, 0, 0);

// NDC corners of the screen, unprojected each update to find the ground footprint.
const NDC_CORNERS: readonly [number, number][] = [[-1, 1], [1, 1], [1, -1], [-1, -1]];

/**
 * A directional sun light with a shadow frustum that re-fits itself to the
 * camera's ground footprint every frame — the counterpart to chunk streaming,
 * where a static world-sized frustum would either waste the whole shadow map
 * on unloaded chunks or miss the view entirely.
 *
 * Per update the visible ground area (frustum corners projected onto the
 * ground plane, clamped to `maxDistance`) is wrapped in a bounding sphere and
 * the ortho shadow camera is fitted to it. The fitted window is snapped to
 * whole shadow-map texels in light space so panning the camera doesn't make
 * shadow edges shimmer.
 *
 * The sun direction is mutable via {@link setDirection} so a day/night cycle
 * can drive it; keep the terrain material's `uLightDir` in sync (HexWorld's
 * `setSunDirection` does both).
 *
 * @example
 * renderer.shadowMap.enabled = true;
 * renderer.shadowMap.type = THREE.PCFSoftShadowMap;
 * const rig = new SunShadowRig().addTo(scene);
 * // per frame, after camera controls update:
 * rig.update(camera);
 */
export class SunShadowRig {
  readonly light: THREE.DirectionalLight;

  private readonly dir: THREE.Vector3;
  private readonly maxDistance: number;
  private readonly maxHeight: number;
  private readonly padding: number;

  // Scratch allocations reused across updates.
  private readonly _near   = new THREE.Vector3();
  private readonly _far    = new THREE.Vector3();
  private readonly _ray    = new THREE.Vector3();
  private readonly _points: THREE.Vector3[] = Array.from({ length: 10 }, () => new THREE.Vector3());
  private readonly _center = new THREE.Vector3();
  private readonly _xAxis  = new THREE.Vector3();
  private readonly _yAxis  = new THREE.Vector3();
  private readonly _camPos = new THREE.Vector3();

  constructor(opts: SunShadowOptions = {}) {
    this.dir = (opts.direction ?? new THREE.Vector3(100, 120, 80)).clone().normalize();
    this.maxDistance = opts.maxDistance ?? 90;
    this.maxHeight   = opts.maxHeight   ?? 14;
    this.padding     = opts.padding     ?? 2;

    const size = opts.mapSize ?? 2048;
    this.light = new THREE.DirectionalLight(opts.color ?? 0xfff4d0, opts.intensity ?? 1.4);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(size, size);
    this.light.shadow.bias       = opts.bias       ?? -0.0002;
    this.light.shadow.normalBias = opts.normalBias ?? 0.6;
    this.light.shadow.intensity  = opts.shadowIntensity ?? 1;
  }

  /** Add the light AND its target to a scene (the target must be in the graph for the light to track it). */
  addTo(parent: THREE.Object3D): this {
    parent.add(this.light, this.light.target);
    return this;
  }

  /** Current normalized direction pointing toward the sun. */
  get direction(): THREE.Vector3 { return this.dir; }

  /** Point the sun. `dirTowardSun` points from the scene toward the sun (day/night hook). */
  setDirection(dirTowardSun: THREE.Vector3): void {
    this.dir.copy(dirTowardSun).normalize();
  }

  /** Toggle shadow casting. Materials recompile automatically on change. */
  setEnabled(enabled: boolean): void {
    this.light.castShadow = enabled;
  }

  get enabled(): boolean { return this.light.castShadow; }

  /**
   * Re-fit the shadow frustum to the camera's view of the ground plane.
   * Call once per frame after camera controls update, before rendering.
   */
  update(camera: THREE.Camera): void {
    if (!this.light.castShadow) return;

    camera.getWorldPosition(this._camPos);

    // 1. Ground footprint: each screen corner ray intersected with y=0,
    //    clamped to maxDistance so shallow pitches don't blow up the frustum.
    //    Each footprint point is doubled at maxHeight so the fitted sphere
    //    covers casters above the ground too.
    let n = 0;
    for (const [nx, ny] of NDC_CORNERS) {
      this._near.set(nx, ny, -1).unproject(camera);
      this._far .set(nx, ny,  1).unproject(camera);
      this._ray.subVectors(this._far, this._near);
      const len  = this._ray.length();
      const tMax = len > 1e-6 ? this.maxDistance / len : 0;
      let t = this._ray.y < -1e-6 ? -this._near.y / this._ray.y : tMax;
      t = Math.min(Math.max(t, 0), tMax);
      const p = this._points[n++].copy(this._near).addScaledVector(this._ray, t);
      p.y = Math.min(Math.max(p.y, 0), this.maxHeight);
      this._points[n++].copy(p).setY(this.maxHeight);
    }
    // The camera's own ground projection keeps nearby terrain covered even
    // when all four corners land far away (top-down views).
    this._points[n++].set(this._camPos.x, 0, this._camPos.z);
    this._points[n++].set(this._camPos.x, this.maxHeight, this._camPos.z);

    // 2. Bounding sphere of the footprint points.
    this._center.set(0, 0, 0);
    for (let i = 0; i < n; i++) this._center.add(this._points[i]);
    this._center.divideScalar(n);
    let radius = 0;
    for (let i = 0; i < n; i++) {
      radius = Math.max(radius, this._center.distanceTo(this._points[i]));
    }
    radius += this.padding;

    // 3. Snap the window center to whole shadow-map texels in light space.
    //    The basis below mirrors Matrix4.lookAt(eye, target, UP) — the same
    //    frame the shadow camera derives — so snapping here holds on screen.
    const zAxis = this.dir;
    this._xAxis.crossVectors(UP, zAxis);
    if (this._xAxis.lengthSq() < 1e-6) this._xAxis.copy(FALLBACK_RIGHT);
    this._xAxis.normalize();
    this._yAxis.crossVectors(zAxis, this._xAxis);

    const texel = (2 * radius) / this.light.shadow.mapSize.x;
    const sx = Math.round(this._center.dot(this._xAxis) / texel) * texel;
    const sy = Math.round(this._center.dot(this._yAxis) / texel) * texel;
    const sz = this._center.dot(zAxis);
    this._center.set(0, 0, 0)
      .addScaledVector(this._xAxis, sx)
      .addScaledVector(this._yAxis, sy)
      .addScaledVector(zAxis, sz);

    // 4. Position the light up-sun of the fitted sphere. The extra maxHeight
    //    of near/far slack admits off-footprint casters that lean into view
    //    along the light direction (a mountain just outside the screen edge).
    const backoff = radius + this.maxHeight + 1;
    this.light.position.copy(this._center).addScaledVector(this.dir, backoff);
    this.light.target.position.copy(this._center);

    const cam = this.light.shadow.camera;
    cam.left   = -radius;
    cam.right  =  radius;
    cam.bottom = -radius;
    cam.top    =  radius;
    cam.near   = 0.5;
    cam.far    = backoff + radius + this.maxHeight;
    cam.updateProjectionMatrix();
  }

  /** Free the shadow map texture. */
  dispose(): void {
    this.light.dispose();
  }
}
