// Headless WebGL2 screenshot of the static bsp-compare scene, via real Chrome
// (Playwright channel:'chrome' — uses system Google Chrome, no browser download). It
// starts the web reference server (this worktree's engine.js + bundles + headless.html)
// on a dedicated free port, drives Chrome, and writes a 480x272 <map>.webgl.png — the
// GROUND-TRUTH render the diff harness compares PPSSPP against.
//
// Requires: Google Chrome installed + `bun add -d playwright`. Local tool (not CI).
// Run:  BSP_MAP=box bun framework/test/bsp-compare/webgl-shoot.ts
import { existsSync } from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const root = here + '../../../';
const map = process.env.BSP_MAP || 'box';
const PORT = Number(process.env.BSP_PORT || 8199);

let chromium: any;
try { ({ chromium } = await import('playwright')); }
catch { console.error('playwright not installed — run: bun add -d playwright'); process.exit(2); }

if (!existsSync(root + 'web/games.generated.js')) { console.error('build the web bundles first: bun framework/build.ts && bun web/build-games.ts'); process.exit(2); }

// Start the reference server (Bun.serve over web/) on a free port.
const server = Bun.spawn(['bun', 'web/serve.ts'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdout: 'ignore', stderr: 'ignore' });
await new Promise((r) => setTimeout(r, 1600));

try {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 480, height: 272 }, deviceScaleFactor: 1 });
  const errs: string[] = [];
  page.on('pageerror', (e: Error) => errs.push(String(e.message || e)));
  await page.goto(`http://127.0.0.1:${PORT}/headless.html?map=${map}`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction('window.__ready || window.__error', null, { timeout: 25000 });
  const pageErr = await page.evaluate('window.__error');
  if (pageErr) throw new Error('page: ' + pageErr);
  const out = here + `${map}.webgl.png`;
  await page.locator('#screen').screenshot({ path: out });
  await browser.close();
  console.log(`wrote ${map}.webgl.png${errs.length ? '  (pageerrors: ' + errs.join('; ') + ')' : ''}`);
} finally {
  server.kill();
}
