import * as THREE from 'three';

const DEG2RAD = Math.PI / 180;
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export interface RtsCameraOptions {
  camera: THREE.PerspectiveCamera;
  domElement: HTMLElement;
  initialTarget?: { x: number; z: number };
  initialDistance?: number;
  /** Initial pitch above the horizon in degrees. Default 35. */
  initialPitch?: number;
  /**
   * Initial compass heading in degrees, turning the camera around its target.
   * 0 (the default) puts the camera on the +Z side looking toward −Z; positive
   * values swing it counter-clockwise seen from above.
   */
  initialYaw?: number;
  minPitch?: number;
  maxPitch?: number;
  minDistance?: number;
  maxDistance?: number;
  /** How quickly camera catches up to goal (0–1, higher = snappier). Default 0.12. */
  damping?: number;
  zoomSpeed?: number;
  /** Degrees of pitch change per pixel of vertical middle-drag. Default 0.3. */
  tiltSpeed?: number;
  /** Degrees of yaw change per pixel of horizontal middle-drag. Default 0.3. */
  yawSpeed?: number;
}

type DragMode = 'pan' | 'orbit' | null;

export class RtsCameraController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;

  private minPitch: number;
  private maxPitch: number;
  private yawLocked = false;
  private readonly minDistance: number;
  private readonly maxDistance: number;
  private readonly damping: number;
  private readonly zoomSpeed: number;
  private readonly tiltSpeed: number;
  private readonly yawSpeed: number;

  // Smoothed state
  private readonly target = new THREE.Vector3();
  private distance: number;
  private pitch: number;
  private yaw: number;

  // Goal state
  private readonly targetGoal = new THREE.Vector3();
  private distanceGoal: number;
  private pitchGoal: number;
  private yawGoal: number;

  // Input tracking
  private dragMode: DragMode = null;
  private readonly lastMouse = new THREE.Vector2();

  // Reusable allocations
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndcMouse  = new THREE.Vector2();

  constructor(opts: RtsCameraOptions) {
    this.camera     = opts.camera;
    this.domElement = opts.domElement;

    // Low enough to put the horizon well inside the frame — the sky, a sunset,
    // and the god rays all live above a line a steeper floor cuts off. Below
    // about 4° the camera is effectively at ground level and the terrain in
    // front hides the target it is orbiting.
    this.minPitch    = (opts.minPitch    ?? 6)   * DEG2RAD;
    this.maxPitch    = (opts.maxPitch    ?? 80)  * DEG2RAD;
    this.minDistance = opts.minDistance  ?? 6;
    this.maxDistance = opts.maxDistance  ?? 150;
    this.damping     = opts.damping      ?? 0.12;
    this.zoomSpeed   = opts.zoomSpeed    ?? 0.15;
    this.tiltSpeed   = opts.tiltSpeed    ?? 0.3;
    this.yawSpeed    = opts.yawSpeed     ?? 0.3;

    const initDist  = opts.initialDistance ?? 60;
    const initPitch = (opts.initialPitch   ?? 35) * DEG2RAD;
    const initYaw   = (opts.initialYaw     ?? 0)  * DEG2RAD;

    this.distance     = initDist;
    this.distanceGoal = initDist;
    this.pitch        = initPitch;
    this.pitchGoal    = initPitch;
    this.yaw          = initYaw;
    this.yawGoal      = initYaw;

    const ix = opts.initialTarget?.x ?? 0;
    const iz = opts.initialTarget?.z ?? 0;
    this.target.set(ix, 0, iz);
    this.targetGoal.set(ix, 0, iz);

    this.applyToCamera();
    this.bindEvents();
  }

  // --- Public API ---

  get currentDistance(): number  { return this.distance; }
  get currentPitch(): number     { return this.pitch; }
  get minDist(): number          { return this.minDistance; }
  get maxDist(): number          { return this.maxDistance; }
  get currentPitchDeg(): number  { return this.pitch    / DEG2RAD; }
  get minPitchDeg(): number      { return this.minPitch / DEG2RAD; }
  get maxPitchDeg(): number      { return this.maxPitch / DEG2RAD; }
  /** Current heading in radians; 0 looks toward −Z. Unwrapped — may exceed ±π. */
  get currentYaw(): number       { return this.yaw; }
  /** Current heading in degrees, wrapped to (−180, 180] for display. */
  get currentYawDeg(): number {
    const deg = (this.yaw / DEG2RAD) % 360;
    return deg > 180 ? deg - 360 : deg <= -180 ? deg + 360 : deg;
  }
  /** Whether the camera may be turned around its target. */
  get yawEnabled(): boolean { return !this.yawLocked; }

  /** The ground point the camera looks at (y = 0). Read-only — do not mutate; use snapTo/panTo. */
  get targetPosition(): Readonly<THREE.Vector3> { return this.target; }

  /**
   * Instantly reposition the camera to look at the given world-space XZ position
   * with no animation. Use at startup or after teleporting so the first frame
   * renders at the correct location rather than sliding in from somewhere else.
   */
  snapTo(x: number, z: number): void {
    this.target.set(x, 0, z);
    this.targetGoal.set(x, 0, z);
    this.applyToCamera();
  }

  /**
   * Smoothly pan the camera to look at the given world-space XZ position.
   * The camera will glide there over the next several frames using the
   * existing damping. Call each frame to track a moving target.
   */
  panTo(x: number, z: number): void {
    this.targetGoal.set(x, 0, z);
  }

  /**
   * Smoothly swing the camera around its target to a compass heading in
   * degrees (0 looks toward −Z). Takes the short way round, so turning from
   * 170° to −170° is a 20° swing rather than a 340° one.
   *
   * @example
   * // Face the sunrise, wherever the day/night cycle has put it.
   * const s = world.dayNight.evaluate();
   * controls.rotateTo(Math.atan2(-s.sunDir.x, -s.sunDir.z) * 180 / Math.PI);
   */
  rotateTo(degrees: number): void {
    if (this.yawLocked) return;
    this.rotateGoalTo(degrees * DEG2RAD);
  }

  /** Swing the camera by a relative number of degrees (positive = leftward). */
  rotateBy(degrees: number): void {
    if (this.yawLocked) return;
    this.yawGoal += degrees * DEG2RAD;
  }

  /** Move the yaw goal the short way round to an absolute heading. */
  private rotateGoalTo(radians: number): void {
    const delta = (radians - this.yawGoal) % (Math.PI * 2);
    const short = delta > Math.PI ? delta - Math.PI * 2
      : delta < -Math.PI ? delta + Math.PI * 2 : delta;
    this.yawGoal += short;
  }

  /**
   * Smoothly tilt to a pitch in degrees above the horizon, clamped to the
   * controller's limits — pass `minPitchDeg` for the shallowest view the
   * camera allows, which is the one that puts the horizon on screen.
   */
  tiltTo(degrees: number): void {
    this.pitchGoal = Math.max(this.minPitch, Math.min(this.maxPitch, degrees * DEG2RAD));
  }

  /**
   * Re-set how far the camera may tilt, in degrees above the horizon. The
   * current tilt is pulled inside the new range rather than snapped, so
   * tightening the limits glides the view back instead of cutting to it.
   *
   * This plus {@link RtsCameraController.setYawEnabled} is what a camera-mode
   * switch is made of — the controller supplies the mechanism and leaves the
   * choice of presets to the app, since "how much freedom is too much" is a
   * question about your game, not about the camera.
   *
   * @example
   * // Classic locked-heading RTS view...
   * controls.setPitchLimits(30, 66);
   * controls.setYawEnabled(false);
   * // ...or free look, low enough to see the horizon.
   * controls.setPitchLimits(6, 80);
   * controls.setYawEnabled(true);
   */
  setPitchLimits(minDegrees: number, maxDegrees: number): void {
    const lo = Math.min(minDegrees, maxDegrees) * DEG2RAD;
    const hi = Math.max(minDegrees, maxDegrees) * DEG2RAD;
    this.minPitch = lo;
    this.maxPitch = hi;
    this.pitchGoal = Math.max(lo, Math.min(hi, this.pitchGoal));
  }

  /**
   * Allow or forbid turning the camera around its target. Locking it swings
   * the heading back to `restDegrees` (0 — the +Z placement the camera has
   * always had) and makes the drag gesture, `rotateTo`, and `rotateBy` no-ops
   * until it is unlocked, so a fixed-heading mode can't be nudged out of
   * alignment.
   */
  setYawEnabled(enabled: boolean, restDegrees = 0): void {
    // Aim before locking: rotateGoalTo is the internal one, so it still moves
    // while the public rotate calls are being switched off.
    if (!enabled) this.rotateGoalTo(restDegrees * DEG2RAD);
    this.yawLocked = !enabled;
  }

  update(): void {
    this.target.lerp(this.targetGoal, this.damping);
    this.distance += (this.distanceGoal - this.distance) * this.damping;
    this.pitch    += (this.pitchGoal    - this.pitch)    * this.damping;
    this.yaw      += (this.yawGoal      - this.yaw)      * this.damping;
    this.applyToCamera();
  }

  dispose(): void {
    this.unbindEvents();
  }

  // --- Camera positioning ---

  private applyToCamera(): void {
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    // The ground offset swings around the target with the yaw; at yaw 0 the
    // sin term drops out and this is the plain +Z placement it has always been.
    const ground = cosP * this.distance;
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * ground,
      sinP * this.distance,
      this.target.z + Math.cos(this.yaw) * ground,
    );
    this.camera.lookAt(this.target);
  }

  // --- Ground raycast ---

  private groundHit(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.domElement.getBoundingClientRect();
    this.ndcMouse.set(
      ((clientX - rect.left) / rect.width)  *  2 - 1,
      ((clientY - rect.top)  / rect.height) * -2 + 1,
    );
    this.raycaster.setFromCamera(this.ndcMouse, this.camera);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(GROUND_PLANE, hit) ? hit : null;
  }

  // --- Event handlers ---

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const hit     = this.groundHit(e.clientX, e.clientY);
    const factor  = 1 + (e.deltaY > 0 ? this.zoomSpeed : -this.zoomSpeed);
    const newDist = Math.max(this.minDistance, Math.min(this.maxDistance, this.distanceGoal * factor));

    if (hit) {
      const zoomFraction = (this.distanceGoal - newDist) / this.distanceGoal;
      this.targetGoal.lerp(hit, zoomFraction);
    }
    this.distanceGoal = newDist;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 2) {
      this.dragMode = 'pan';
      this.lastMouse.set(e.clientX, e.clientY);
      e.preventDefault();
    } else if (e.button === 1) {
      this.dragMode = 'orbit';
      this.lastMouse.set(e.clientX, e.clientY);
      e.preventDefault();
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.dragMode) return;

    if (this.dragMode === 'pan') {
      // Raycast both the previous and current mouse positions onto the ground plane.
      // The target moves by exactly the world-space delta — correct speed at any
      // zoom level or pitch, with no speed constants to tune.
      const prev = this.groundHit(this.lastMouse.x, this.lastMouse.y);
      const curr = this.groundHit(e.clientX, e.clientY);
      if (prev && curr) {
        this.targetGoal.x += prev.x - curr.x;
        this.targetGoal.z += prev.z - curr.z;
      }
    } else {
      // One gesture, two axes: drag up/down to tilt, left/right to swing
      // around. Yaw is unclamped — a compass has no ends — while pitch stays
      // inside its limits.
      const dy = e.clientY - this.lastMouse.y;
      const dx = e.clientX - this.lastMouse.x;
      this.pitchGoal = Math.max(
        this.minPitch,
        Math.min(this.maxPitch, this.pitchGoal - dy * this.tiltSpeed * DEG2RAD),
      );
      if (!this.yawLocked) this.yawGoal -= dx * this.yawSpeed * DEG2RAD;
    }

    this.lastMouse.set(e.clientX, e.clientY);
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 1 || e.button === 2) this.dragMode = null;
  };

  private onContextMenu = (e: Event): void => e.preventDefault();

  private bindEvents(): void {
    const el = this.domElement;
    el.addEventListener('wheel',       this.onWheel,     { passive: false });
    el.addEventListener('mousedown',   this.onMouseDown);
    el.addEventListener('mousemove',   this.onMouseMove);
    el.addEventListener('mouseup',     this.onMouseUp);
    el.addEventListener('contextmenu', this.onContextMenu);
  }

  private unbindEvents(): void {
    const el = this.domElement;
    el.removeEventListener('wheel',       this.onWheel);
    el.removeEventListener('mousedown',   this.onMouseDown);
    el.removeEventListener('mousemove',   this.onMouseMove);
    el.removeEventListener('mouseup',     this.onMouseUp);
    el.removeEventListener('contextmenu', this.onContextMenu);
  }
}
