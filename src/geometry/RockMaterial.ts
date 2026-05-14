import * as THREE from 'three';

/**
 * Lambert material for scatter rocks with per-instance shape variation.
 *
 * Each instance is non-uniformly scaled in the vertex shader using a hash
 * seeded from its world position (extracted from instanceMatrix). This gives
 * every rock a unique squashed/stretched silhouette with zero CPU overhead
 * and no extra buffer attributes.
 *
 * flatShading: true means the fragment shader derives normals from screen-space
 * position derivatives, so lighting is always correct for the deformed geometry
 * without needing a separate normal-correction pass.
 */
export function createRockMaterial(color = 0x888880): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color, flatShading: true });

  mat.onBeforeCompile = (shader) => {
    // Inject scale helper before void main() — seeded from instance world position
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      `vec3 _rockScale(mat4 im) {
  vec3  p = vec3(im[3]);
  float s = fract(sin(dot(p.xz, vec2(127.1, 311.7))) * 43758.5453);
  return vec3(
    0.72 + fract(s * 13.7) * 0.56,   // x  0.72 – 1.28
    0.52 + fract(s * 19.3) * 0.48,   // y  0.52 – 1.00  (rocks are flatter than wide)
    0.72 + fract(s * 27.1) * 0.56    // z  0.72 – 1.28
  );
}
void main() {`,
    );

    // Deform vertex positions before instanceMatrix is applied in project_vertex
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
#ifdef USE_INSTANCING
  transformed *= _rockScale(instanceMatrix);
#endif`,
    );
  };

  return mat;
}
