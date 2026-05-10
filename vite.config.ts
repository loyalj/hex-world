import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
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
