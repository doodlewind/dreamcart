// Deterministic PPSSPPHeadless E2E for tatical3d's first-frame arena surfaces.
//
// Captured gate:
//   default frame 8 (the first stable PPSSPP capture frame) compared against WebGL.
import { $ } from 'bun';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const out = `${root}/dist/tatical3d-ppsspp`;
const headless = process.env.PPSSPP_HEADLESS || `${homedir()}/ppsspp-src/build/PPSSPPHeadless`;
const dccap = `${homedir()}/.ppsspp/dc_cap`;
const eboot = `${root}/runtime/target/mipsel-sony-psp/debug/EBOOT.PBP`;
const frame = Number(process.env.TATICAL3D_FRAME || 8);
const capStart = 8;

if (!existsSync(headless)) {
  console.error(`PPSSPPHeadless not found at ${headless}`);
  process.exit(2);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log('# build tatical3d bundles + capture EBOOT ...');
await $`bun framework/build.ts`.cwd(root).quiet();
await $`bun web/build-games.ts`.cwd(root).quiet();
await $`bun runtime/build.ts --features capture`
  .cwd(root)
  .env({ ...process.env, DREAMCART_GAME: 'tatical3d.js' });

console.log('# PSP capture (PPSSPPHeadless software renderer) ...');
rmSync(dccap, { recursive: true, force: true });
const timeout = Number(process.env.TATICAL3D_CAPTURE_TIMEOUT || 24);
await $`${headless} --graphics=software --timeout=${timeout} ${eboot}`.cwd('/tmp').env({ ...process.env }).nothrow();

const idx = String(frame - capStart).padStart(4, '0');
const raw = `${dccap}/f${idx}.raw`;
if (!existsSync(raw)) throw new Error(`missing PSP capture ${raw}`);
await $`magick -size 512x272 -depth 8 RGBA:${raw} -alpha off -crop 480x272+0+0 +repage -depth 8 PNG24:${out}/psp.default.png`.quiet();

console.log('# WebGL reference frame ...');
let chromium: any;
try { ({ chromium } = await import('playwright')); }
catch { console.error('playwright not installed — run: bun add -d playwright'); process.exit(2); }
const port = Number(process.env.TATICAL3D_PORT || 8299);
const { startRefServer } = await import('./bsp-compare/ref-server.ts');
const server = startRefServer(port);
try {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 480, height: 272 }, deviceScaleFactor: 1 });
  const url = `http://127.0.0.1:${port}/headless.html?game=tatical3d.js&frames=${frame}`;
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction('window.__ready || window.__error', null, { timeout: 25000 });
  const err = await page.evaluate('window.__error');
  if (err) throw new Error('page: ' + err);
  await page.locator('#screen').screenshot({ path: `${out}/web.default.png` });
  await page.close();
  await browser.close();
} finally {
  server.stop(true);
}

console.log('# structural diff ...');
const prefix = `${out}/diff.default`;
await $`bun framework/test/bsp-compare/diff.ts ${out}/web.default.png ${out}/psp.default.png --structural --out ${prefix}`.cwd(root).nothrow().quiet();
const score = JSON.parse(readFileSync(`${prefix}.score.json`, 'utf8'));
console.log(`default: IoU=${score.IoU} coverageXor=${score.coverageXor} pass=${score.pass}`);

console.log(`\nartifacts -> ${out}`);
process.exit(score.pass ? 0 : 1);
