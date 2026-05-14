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
  minPitch?: number;
  maxPitch?: number;
  minDistance?: number;
  maxDistance?: number;
  /** How quickly camera catches up to goal (0–1, higher = snappier). Default 0.12. */
  damping?: number;
  zoomSpeed?: number;
  /** Degrees of pitch change per pixel of middle-drag. Default 0.3. */
  tiltSpeed?: number;
}

type DragMode = 'pan' | 'tilt' | null;

export class RtsCameraController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;

  private readonly minPitch: number;
  private readonly maxPitch: number;
  private readonly minDistance: number;
  private readonly maxDistance: number;
  private readonly damping: number;
  private readonly zoomSpeed: number;
  private readonly tiltSpeed: number;

  // Smoothed state
  private readonly target = new THREE.Vector3();
  private distance: number;
  private pitch: number;

  // Goal state
  private readonly targetGoal = new THREE.Vector3();
  private distanceGoal: number;
  private pitchGoal: number;

  // Input tracking
  private dragMode: DragMode = null;
  private readonly lastMouse = new THREE.Vector2();

  // Reusable allocations
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndcMouse  = new THREE.Vector2();

  constructor(opts: RtsCameraOptions) {
    this.camera     = opts.camera;
    this.domElement = opts.domElement;

    this.minPitch    = (opts.minPitch    ?? 15)  * DEG2RAD;
    this.maxPitch    = (opts.maxPitch    ?? 80)  * DEG2RAD;
    this.minDistance = opts.minDistance  ?? 6;
    this.maxDistance = opts.maxDistance  ?? 150;
    this.damping     = opts.damping      ?? 0.12;
    this.zoomSpeed   = opts.zoomSpeed    ?? 0.15;
    this.tiltSpeed   = opts.tiltSpeed    ?? 0.3;

    const initDist  = opts.initialDistance ?? 60;
    const initPitch = (opts.initialPitch   ?? 35) * DEG2RAD;

    this.distance     = initDist;
    this.distanceGoal = initDist;
    this.pitch        = initPitch;
    this.pitchGoal    = initPitch;

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

  update(): void {
    this.target.lerp(this.targetGoal, this.damping);
    this.distance += (this.distanceGoal - this.distance) * this.damping;
    this.pitch    += (this.pitchGoal    - this.pitch)    * this.damping;
    this.applyToCamera();
  }

  dispose(): void {
    this.unbindEvents();
  }

  // --- Camera positioning ---

  private applyToCamera(): void {
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x,
      sinP * this.distance,
      this.target.z + cosP * this.distance,
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
      this.dragMode = 'tilt';
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
      const dy = e.clientY - this.lastMouse.y;
      this.pitchGoal = Math.max(
        this.minPitch,
        Math.min(this.maxPitch, this.pitchGoal - dy * this.tiltSpeed * DEG2RAD),
      );
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
