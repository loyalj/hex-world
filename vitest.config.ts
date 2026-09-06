import { defineConfig, configDefaults } from 'vitest/config';

// The visual snapshot suite needs a browser and a dev server; it runs on its
// own config (`npm run test:visual`) so the unit suite stays fast and headless.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/visual/**'],
  },
});
