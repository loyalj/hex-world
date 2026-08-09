import * as THREE from 'three';

/**
 * Procedural low-poly plant geometry for the scatter system.
 *
 * Every shape here is built with its **base at y = 0**, so a
 * {@link ScatterVariantDescriptor} places it with `yOffset: 0` and a taller
 * variant of the same plant needs no offset bookkeeping — the size argument is
 * the only thing that changes between density tiers.
 *
 * These are the shapes a game can start with, not the shapes it should ship
 * with; swap in GLB models through the scatter asset registry when there is art.
 * What they are really here for is the *seasonal* distinction: a pine and a
 * broadleaf differ in the code that draws them by one call
 * (`attachSeasonalTint`), and these give something for that call to act on.
 *
 * @example
 * const broadleaf = new THREE.MeshLambertMaterial({ vertexColors: true });
 * attachSeasonalTint(broadleaf, { summer: BROADLEAF_CANOPY_COLOR });
 * attachSnow(broadleaf);
 *
 * const def: ScatterDefinition = {
 *   id: 'broadleaf', name: 'Broadleaf Trees', layerIndex: 2,
 *   tiltStrength: 0.06,
 *   tiers: [
 *     [{ geometry: createBroadleafGeometry(1.9), material: broadleaf, yOffset: 0 }],
 *     [{ geometry: createBroadleafGeometry(1.4), material: broadleaf, yOffset: 0 }],
 *     [{ geometry: createBroadleafGeometry(1.0), material: broadleaf, yOffset: 0 }],
 *   ],
 * };
 */

/** Default bark colour of {@link createBroadleafGeometry}'s trunk. */
export const BROADLEAF_TRUNK_COLOR = 0x6b4b30;
/**
 * Default canopy colour of {@link createBroadleafGeometry} — and the value to
 * hand `attachSeasonalTint` as its `summer` reference, since a `vertexColors`
 * material's own `color` is white and would make a useless one.
 */
export const BROADLEAF_CANOPY_COLOR = 0x6f9c3a;
/** Default colour of {@link createBushGeometry}. */
export const BUSH_COLOR = 0x5f8438;

/**
 * Concatenate geometries into one non-indexed buffer, painting each with a flat
 * vertex colour.
 *
 * Written out rather than pulled from `BufferGeometryUtils` to keep the library
 * free of a `three/examples` dependency, and because this only ever has to
 * handle the three attributes a scatter mesh uses.
 */
function mergeColored(parts: { geometry: THREE.BufferGeometry; color: THREE.Color }[]): THREE.BufferGeometry {
  // Flattening the index is what lets three separate primitives share one
  // buffer without their triangles referring into each other's vertices.
  // PolyhedronGeometry arrives non-indexed already, so only real conversions
  // produce a clone this function owns and has to release.
  const flat = parts.map(p => {
    const geometry = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry;
    return { geometry, color: p.color, owned: geometry !== p.geometry };
  });
  const total = flat.reduce((n, p) => n + p.geometry.getAttribute('position').count, 0);

  const position = new Float32Array(total * 3);
  const color    = new Float32Array(total * 3);

  let at = 0;
  for (const { geometry, color: c } of flat) {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    position.set(pos.array as Float32Array, at * 3);
    for (let i = 0; i < pos.count; i++) {
      color[(at + i) * 3]     = c.r;
      color[(at + i) * 3 + 1] = c.g;
      color[(at + i) * 3 + 2] = c.b;
    }
    at += pos.count;
  }
  for (const f of flat) if (f.owned) f.geometry.dispose();

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('color',    new THREE.BufferAttribute(color, 3));
  // Recomputed rather than copied: the parts are non-uniformly scaled, which
  // leaves their authored normals wrong. On a non-indexed buffer this comes out
  // per-face, which is the faceted look these shapes want anyway.
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

/** Lift a geometry so its lowest vertex sits at y = 0. */
function seatOnGround(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  geometry.translate(0, -geometry.boundingBox!.min.y, 0);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Scale a geometry to an exact overall height, then seat it.
 *
 * Worth the two bounding-box passes at build time because it makes `height`
 * mean what it says: an icosahedron's topmost *vertex* sits at 0.85 of its
 * radius, not at the radius, so a crown composed by hand always comes out short
 * of its arithmetic by some figure nobody should have to know.
 */
function fitHeight(geometry: THREE.BufferGeometry, height: number): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const bb   = geometry.boundingBox!;
  const span = bb.max.y - bb.min.y;
  if (span > 0) geometry.scale(height / span, height / span, height / span);
  return seatOnGround(geometry);
}

/** Shape options shared by the plant builders. */
export interface ScatterShapeOptions {
  /** Canopy/foliage colour, written into the vertex colours. */
  foliageColor?: THREE.ColorRepresentation;
  /** Trunk colour, where the shape has one. */
  trunkColor?: THREE.ColorRepresentation;
}

/**
 * A broadleaf tree: a bare trunk under a rounded canopy, merged into one
 * geometry with vertex colours so a single instanced draw covers both.
 *
 * The split matters to more than the silhouette. `attachSeasonalTint` finds the
 * canopy by its colour and leaves the trunk alone (see `FOLIAGE_GLSL`), and
 * `attachSnow` weights its cap by how far each face turns skyward, so winter
 * lands on the crown and not the bark. Both fall out of the geometry — neither
 * needs a second material or a per-vertex mask.
 *
 * Give the material `vertexColors: true`, and pass
 * {@link BROADLEAF_CANOPY_COLOR} (or your own `foliageColor`) as the tint's
 * `summer` reference.
 *
 * @param height Overall height in world units, base to crown.
 */
export function createBroadleafGeometry(height = 1.8, opts: ScatterShapeOptions = {}): THREE.BufferGeometry {
  const canopyR = height * 0.34;
  const trunkH  = height - canopyR * 1.55;

  const trunk = new THREE.CylinderGeometry(height * 0.045, height * 0.075, trunkH, 5);
  trunk.translate(0, trunkH / 2, 0);

  // Two offset spheres rather than one: a single ball reads as a lollipop at
  // any distance, where an asymmetric crown still reads as a tree.
  const crown = new THREE.IcosahedronGeometry(canopyR, 0);
  crown.scale(1, 0.85, 1);
  crown.translate(0, trunkH + canopyR * 0.7, 0);

  const lobe = new THREE.IcosahedronGeometry(canopyR * 0.62, 0);
  // Kept just under the crown's own top so `height` stays the honest one.
  lobe.translate(canopyR * 0.42, trunkH + canopyR * 0.9, -canopyR * 0.2);

  const geometry = mergeColored([
    { geometry: trunk, color: new THREE.Color(opts.trunkColor  ?? BROADLEAF_TRUNK_COLOR) },
    { geometry: crown, color: new THREE.Color(opts.foliageColor ?? BROADLEAF_CANOPY_COLOR) },
    { geometry: lobe,  color: new THREE.Color(opts.foliageColor ?? BROADLEAF_CANOPY_COLOR) },
  ]);
  trunk.dispose(); crown.dispose(); lobe.dispose();
  return fitHeight(geometry, height);
}

/**
 * A low scrub bush: three squashed lobes, foliage all the way down.
 *
 * Vertex-coloured like {@link createBroadleafGeometry} so the two share a
 * material shape, though a bush has no bark to protect — `select: 0` on its
 * tint is the honest setting, and skips the green test entirely.
 *
 * @param size Overall width in world units (height is about 60% of it).
 */
export function createBushGeometry(size = 0.7, opts: ScatterShapeOptions = {}): THREE.BufferGeometry {
  const color = new THREE.Color(opts.foliageColor ?? BUSH_COLOR);
  const r     = size * 0.34;

  const lobes = [
    { s: 1.0,  x: 0,          z: 0,          y: r * 0.75 },
    { s: 0.72, x:  r * 0.72,  z:  r * 0.30,  y: r * 0.52 },
    { s: 0.66, x: -r * 0.58,  z: -r * 0.55,  y: r * 0.48 },
  ].map(l => {
    const g = new THREE.IcosahedronGeometry(r * l.s, 0);
    g.scale(1, 0.62, 1);
    g.translate(l.x, l.y, l.z);
    return { geometry: g, color };
  });

  const geometry = mergeColored(lobes);
  for (const l of lobes) l.geometry.dispose();
  return seatOnGround(geometry);
}

/**
 * A conifer: a plain cone, the shape the scatter system has always drawn.
 *
 * Here so a pine and a broadleaf can be built side by side from the same
 * module. Single-coloured, so it takes a plain material and its own `color` —
 * and, pointedly, no seasonal tint.
 *
 * @param height Overall height in world units, base to tip.
 */
export function createPineGeometry(height = 2.0, radialSegments = 7): THREE.BufferGeometry {
  return fitHeight(new THREE.ConeGeometry(height * 0.21, height, radialSegments), height);
}
