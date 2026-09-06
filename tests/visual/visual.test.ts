/**
 * Visual regression: render each scene in `scenes.ts` in headless Chromium
 * (SwiftShader — software GL, so the pixels do not depend on the GPU) and
 * compare against the committed golden in `__snapshots__/`.
 *
 *   npm run test:visual           compare
 *   npm run test:visual:update    re-bake the goldens (review the diff!)
 *
 * On a mismatch the actual frame and a diff image land beside the golden as
 * `<scene>.actual.png` / `<scene>.diff.png` (git-ignored). The tolerance is
 * deliberately loose enough to absorb sub-pixel rasterization drift between
 * SwiftShader builds and tight enough to catch a torn seam, a missing deck,
 * or a liquid that stopped rendering — the kind of regression that survived
 * every unit test the skirt work had.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const WIDTH  = 640;
const HEIGHT = 400;
const DIR    = resolve(process.cwd(), 'tests/visual/__snapshots__');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
/** Per-channel colour distance (0–1) below which two pixels count as the same. */
const PIXEL_THRESHOLD = 0.12;
/** Fraction of the frame allowed to differ before the scene fails. */
const MAX_DIFF_RATIO = 0.004;

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let baseUrl: string;
let sceneNames: string[] = [];

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'silent',
    server: { port: 5199, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  baseUrl = server.resolvedUrls!.local[0];

  browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  page.on('pageerror', e => { throw e; });
  await page.goto(`${baseUrl}tests/visual/index.html`);
  await page.waitForFunction(() => typeof window.renderScene === 'function');
  sceneNames = await page.evaluate(() => window.sceneNames);
  mkdirSync(DIR, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

function readPng(path: string): PNG {
  return PNG.sync.read(readFileSync(path));
}

describe('visual snapshots', () => {
  // The scene list comes from the page, so a static list here would drift;
  // one test iterates and reports per scene instead.
  it('every scene matches its golden', async () => {
    expect(sceneNames.length).toBeGreaterThan(0);
    const failures: string[] = [];

    for (const name of sceneNames) {
      await page.evaluate(n => window.renderScene(n), name);
      const actual = PNG.sync.read(await page.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } }));
      const golden = resolve(DIR, `${name}.png`);
      const actualPath = resolve(DIR, `${name}.actual.png`);
      const diffPath   = resolve(DIR, `${name}.diff.png`);

      if (UPDATE || !existsSync(golden)) {
        writeFileSync(golden, PNG.sync.write(actual));
        for (const p of [actualPath, diffPath]) if (existsSync(p)) unlinkSync(p);
        continue;
      }

      const expected = readPng(golden);
      expect(expected.width).toBe(actual.width);
      expect(expected.height).toBe(actual.height);
      const diff = new PNG({ width: WIDTH, height: HEIGHT });
      const differing = pixelmatch(expected.data, actual.data, diff.data, WIDTH, HEIGHT, { threshold: PIXEL_THRESHOLD });
      const ratio = differing / (WIDTH * HEIGHT);
      if (ratio > MAX_DIFF_RATIO) {
        writeFileSync(actualPath, PNG.sync.write(actual));
        writeFileSync(diffPath, PNG.sync.write(diff));
        failures.push(`${name}: ${(ratio * 100).toFixed(2)}% of pixels differ (limit ${MAX_DIFF_RATIO * 100}%) — see ${diffPath}`);
      } else {
        for (const p of [actualPath, diffPath]) if (existsSync(p)) unlinkSync(p);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  }, 180_000);

  // Not a snapshot — the demo seeds itself randomly — but the one check that
  // catches a demo page that throws on load: its own module wiring, a key
  // handler referencing a renamed subsystem, a scatter definition missing a
  // material. Anything logged as an error fails it.
  it('the demo page boots without errors', async () => {
    const demo = await browser.newPage({ viewport: { width: 960, height: 600 } });
    const errors: string[] = [];
    demo.on('pageerror', e => errors.push(String(e)));
    demo.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await demo.goto(`${baseUrl}index.html`);
    // A cold Vite server discovers `three` on this first import and may
    // reload the page once it has pre-bundled it, so wait for the canvas the
    // demo appends rather than a fixed delay, then give it a few frames under
    // software GL (terrain atlas, first chunks) before judging.
    await demo.waitForSelector('canvas', { timeout: 60_000 });
    await demo.waitForTimeout(4000);
    await demo.close();
    expect(errors).toEqual([]);
  }, 90_000);
});
