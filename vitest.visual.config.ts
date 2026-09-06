import { defineConfig } from 'vitest/config';

// Visual snapshot suite: `npm run test:visual`. Serial, long timeouts — each
// scene builds a world in headless Chromium under software GL.
export default defineConfig({
  test: {
    include: ['tests/visual/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
