export interface HexHash {
  a: number; b: number; c: number; d: number; e: number;
}

const GRID_SIZE  = 256;
const GRID_SCALE = 0.25;

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class HexHashGrid {
  private readonly data: Float32Array;

  constructor(seed: number) {
    this.data = new Float32Array(GRID_SIZE * GRID_SIZE * 5);
    const rand = mulberry32(seed);
    for (let i = 0; i < this.data.length; i++) {
      this.data[i] = rand() * 0.999;
    }
  }

  sample(worldX: number, worldZ: number): HexHash {
    let x = Math.floor(worldX * GRID_SCALE) % GRID_SIZE;
    let z = Math.floor(worldZ * GRID_SCALE) % GRID_SIZE;
    if (x < 0) x += GRID_SIZE;
    if (z < 0) z += GRID_SIZE;
    const i = (z * GRID_SIZE + x) * 5;
    return {
      a: this.data[i],
      b: this.data[i + 1],
      c: this.data[i + 2],
      d: this.data[i + 3],
      e: this.data[i + 4],
    };
  }
}
