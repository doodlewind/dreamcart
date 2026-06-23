// Deterministic PPSSPPHeadless E2E for the fps3d interior-room near-plane case.
//
// It renders the same scripted input path on PSP and WebGL:
//   0:0,12:0x20  => settle in the default pose, then hold RIGHT in place.
//
// Captured gates:
//   default    frame 8  (the first stable PPSSPP capture frame)
//   turn-right frame 31 (after holding RIGHT long enough to expose the side wall)
import { $ } from 'bun';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const out = `${root}/dist/fps3d-ppsspp`;
const headless = process.env.PPSSPP_HEADLESS || `${homedir()}/ppsspp-src/build/PPSSPPHeadless`;
const dccap = `${homedir()}/.ppsspp/dc_cap`;
const eboot = `${root}/runtime/target/mipsel-sony-psp/debug/EBOOT.PBP`;
const inputScript = process.env.FPS3D_INPUT_SCRIPT || '0:0,12:0x20';
const capStart = 8;
const shots = [
  { name: 'default', frame: 8 },
  { name: 'turn-right', frame: 31 },
];

if (!existsSync(headless)) {
  console.error(`PPSSPPHeadless not found at ${headless}`);
  process.exit(2);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log('# build fps3d bundles + capture EBOOT ...');
await $`bun framework/build.ts`.cwd(root).quiet();
await $`bun web/build-games.ts`.cwd(root).quiet();
await $`bun runtime/build.ts --features capture`
  .cwd(root)
  .env({ ...process.env, PSPJS_GAME: 'fps3d.js', PSPJS_CAPTURE_INPUT: inputScript });

console.log('# PSP capture (PPSSPPHeadless software renderer) ...');
rmSync(dccap, { recursive: true, force: true });
const timeout = Number(process.env.FPS3D_CAPTURE_TIMEOUT || 18);
await $`${headless} --graphics=software --timeout=${timeout} ${eboot}`.cwd('/tmp').env({ ...process.env }).nothrow();

for (const shot of shots) {
  const idx = String(shot.frame - capStart).padStart(4, '0');
  const raw = `${dccap}/f${idx}.raw`;
  if (!existsSync(raw)) throw new Error(`missing PSP capture ${raw}`);
  await $`magick -size 512x272 -depth 8 RGBA:${raw} -alpha off -crop 480x272+0+0 +repage -depth 8 PNG24:${out}/psp.${shot.name}.png`.quiet();
}

console.log('# WebGL reference frames (same input script) ...');
let chromium: any;
try { ({ chromium } = await import('playwright')); }
catch { console.error('playwright not installed — run: bun add -d playwright'); process.exit(2); }
const port = Number(process.env.FPS3D_PORT || 8298);
const server = Bun.spawn(['bun', 'web/serve.ts'], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdout: 'ignore',
  stderr: 'ignore',
});
await new Promise((r) => setTimeout(r, 1600));
try {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-unsafe-swiftshader'] });
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: { width: 480, height: 272 }, deviceScaleFactor: 1 });
    const url = `http://127.0.0.1:${port}/headless.html?game=fps3d.js&frames=${shot.frame}&script=${encodeURIComponent(inputScript)}`;
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    await page.waitForFunction('window.__ready || window.__error', null, { timeout: 25000 });
    const err = await page.evaluate('window.__error');
    if (err) throw new Error('page: ' + err);
    await page.locator('#screen').screenshot({ path: `${out}/web.${shot.name}.png` });
    await page.close();
  }
  await browser.close();
} finally {
  server.kill();
}

console.log('# structural diffs ...');
let failed = false;
for (const shot of shots) {
  const prefix = `${out}/diff.${shot.name}`;
  await $`bun framework/test/bsp-compare/diff.ts ${out}/web.${shot.name}.png ${out}/psp.${shot.name}.png --structural --out ${prefix}`.cwd(root).nothrow().quiet();
  const score = JSON.parse(readFileSync(`${prefix}.score.json`, 'utf8'));
  console.log(`${shot.name}: IoU=${score.IoU} coverageXor=${score.coverageXor} pass=${score.pass}`);
  if (!score.pass) failed = true;
}

console.log(`\nartifacts -> ${out}`);
console.log(`input script -> ${inputScript}`);
process.exit(failed ? 1 : 0);
