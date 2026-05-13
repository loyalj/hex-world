/** Returns a mulberry32 PRNG seeded with the given value. Each call returns a float in [0, 1). */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 0x100000000;
  };
}
