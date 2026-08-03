import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  // The chunk worker (src/geometry/chunk.worker.ts) is referenced via
  // `new Worker(new URL(...), import.meta.url)`; ES format is required for
  // worker chunks inside an ESM library build (the default iife conflicts
  // with code-splitting).
  worker: {
    format: 'es',
  },
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'HexWorld',
      fileName: 'hex-world',
      formats: ['es'],
    },
    rollupOptions: {
      external: ['three'],
    },
  },
});
