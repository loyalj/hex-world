import type * as THREE from 'three';

export interface FeatureCollection {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** World-units to lift the mesh so its base sits at ground level. */
  yOffset: number;
}

/** [densityTier 0–2][variant index within that tier] */
export type ScatterLayerConfig = FeatureCollection[][];
