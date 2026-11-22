// Headless browser smoke test: boots the dev server, opens the game in Chromium,
// runs per-stage scenarios, fails on console errors, and writes screenshots to .smoke/.
// Usage: node scripts/smoke.mjs [scenario ...]   (default: all)
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scenarios } from './scenarios.mjs';

const outDir = fileURLToPath(new URL('../.smoke/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const wanted = process.argv.slice(2);
const list = wanted.length ? scenarios.filter((s) => wanted.includes(s.name)) : scenarios;

const server = await createServer({ server: { port: 5199, strictPort: false }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

let failed = 0;
for (const sc of list) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  const t0 = Date.now();
  try {
    await page.goto(url);
    await page.waitForFunction(() => !!window.game, null, { timeout: 30000 });
    if (!sc.menu) {
      await page.evaluate(() => window.__play('sandbox'));
      await page.waitForTimeout(300);
    }
    const shot = async (name) => page.screenshot({ path: `${outDir}${sc.name}-${name}.png` });
    const result = await sc.run(page, shot);
    if (errors.length) throw new Error('console errors:\n' + errors.join('\n'));
    console.log(`✓ ${sc.name} (${Date.now() - t0} ms)${result ? ' — ' + result : ''}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${sc.name}: ${e.message}`);
    try {
      await page.screenshot({ path: `${outDir}${sc.name}-FAIL.png` });
    } catch {}
  }
  await page.close();
}

await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
