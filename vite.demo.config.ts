import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: '/hex-world/',
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
  },
});
