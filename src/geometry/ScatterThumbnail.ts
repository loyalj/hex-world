import * as THREE from 'three';
import type { ScatterAsset } from './ScatterTypes.js';

export interface ScatterThumbnailOptions {
  /** Square size in pixels. Default 96. */
  size?: number;
  /** Renderer to draw with. One is created and kept for the module when omitted. */
  renderer?: THREE.WebGLRenderer;
  /** Background colour, or `null` for transparent. Default null. */
  background?: number | null;
  /** Camera swing around the subject, degrees. Default 30. */
  angle?: number;
  /** Camera tilt above horizontal, degrees. Default 22. */
  elevation?: number;
}

let sharedRenderer: THREE.WebGLRenderer | null = null;

function rendererFor(opts: ScatterThumbnailOptions): THREE.WebGLRenderer {
  if (opts.renderer) return opts.renderer;
  if (!sharedRenderer) {
    sharedRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  }
  return sharedRenderer;
}

/**
 * Draw one instance of a scatter asset into a fresh canvas, framed to its
 * bounding sphere under a plain sky-and-sun light. For palette swatches and
 * a builder's live preview — the same rule as `drawMapImage`: the caller
 * owns the canvas that comes back, and a shared renderer does the work.
 *
 * The asset's material is drawn as-is. Attached effects (wind, seasons,
 * haze) sit at their idle uniforms, so a swayed plant is shown upright and
 * a seasonal one in summer.
 */
export function renderScatterThumbnail(asset: ScatterAsset, opts: ScatterThumbnailOptions = {}): HTMLCanvasElement {
  const size     = opts.size ?? 96;
  const renderer = rendererFor(opts);
  renderer.setSize(size, size, false);
  renderer.setClearColor(opts.background ?? 0x000000, opts.background == null ? 0 : 1);

  const scene = new THREE.Scene();
  const mesh  = new THREE.Mesh(asset.geometry, asset.material);
  scene.add(mesh);
  scene.add(new THREE.HemisphereLight(0xd0e0ff, 0x6b5a45, 0.9));
  const sun = new THREE.DirectionalLight(0xfff4d0, 1.1);
  sun.position.set(2, 3, 1.5);
  scene.add(sun);

  asset.geometry.computeBoundingSphere();
  const sphere = asset.geometry.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 1);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
  const dist   = sphere.radius / Math.sin((camera.fov / 2) * Math.PI / 180) * 1.05;
  const yaw    = (opts.angle ?? 30) * Math.PI / 180;
  const pitch  = (opts.elevation ?? 22) * Math.PI / 180;
  camera.position.set(
    sphere.center.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    sphere.center.y + Math.sin(pitch) * dist,
    sphere.center.z + Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  camera.lookAt(sphere.center);
  renderer.render(scene, camera);

  const out = document.createElement('canvas');
  out.width = size; out.height = size;
  out.getContext('2d')!.drawImage(renderer.domElement, 0, 0, size, size);
  return out;
}

/** Release the module's shared renderer (tests, hot reload). */
export function disposeScatterThumbnailRenderer(): void {
  sharedRenderer?.dispose();
  sharedRenderer = null;
}
