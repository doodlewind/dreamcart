// Camera-PATH 3-leg cross-comparison: drive the bsp3d viewer along a deterministic,
// frame-indexed camera MOVEMENT sweep and render the SAME poses three ways —
//   PSP    : the real PSP engine via one PPSSPPHeadless run (ms0:/dc_cap `capture` feature)
//   WebGL  : Chrome WebGL2 ground truth (textured)
//   oracle : raster3d CPU software renderer, in-process (deterministic, no GPU)
// then diff every pose two ways: TEXTURED (PSP vs WebGL, meanRGB) and STRUCTURAL (PSP vs
// software oracle, IoU/coverage). The two diffs SEPARATE concerns: a structural drop = a
// real motion-geometry/cull bug (PSP renderNative/f32 cull vs the oracle's scene3d.emit/f64
// cull); a texture-only divergence (geometry IoU fine, meanRGB high) = cosmetic shading/wrap.
//
//   bun run bsp-loop-seq <map>     # the sweep+compare (no bake)
//   bun run bsp-iterate  <map>     # bake THEN sweep+compare (the iteration loop)
//
// Window MUST match runtime/src/main.rs cap_dump_frame: frames [CAP_START, CAP_START+CAP_N).
//
// Findings to date: de_dust2's pose band (8-15,31) is TEXTURE-only (structural IoU=1.0 every
// pose — geometry is perfect), so it's shading/wrap, NOT a geometry bug. box shows a real
// structural drop (skybox bleeding through walls in the tiny first-person room) — a small-map
// camera-following-skybox/ground depth artifact, not a general renderer bug.
import { $ } from 'bun';
import { existsSync, readdirSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const here = new URL('.', import.meta.url).pathname;
const root = here + '../../../';
const map = process.argv[2] || process.env.BSP_MAP || 'box';
const CAP_START = 8, CAP_N = 24; // keep in sync with cap_dump_frame in main.rs
const PORT = Number(process.env.BSP_PORT || 8198);
const HOME = homedir();
const HEADLESS = process.env.PPSSPP_HEADLESS || `${HOME}/ppsspp-src/build/PPSSPPHeadless`;
const DCCAP = `${HOME}/.ppsspp/dc_cap`;
const EBOOT = root + 'runtime/target/mipsel-sony-psp/debug/EBOOT.PBP';
const seq = here + `seq/${map}`;
const pad = (n: number) => String(n).padStart(4, '0');
const frames = Array.from({ length: CAP_N }, (_, i) => CAP_START + i);
// Software-oracle leg (raster3d): in-process CPU render of the SAME bsp3d capture poses, for
// a STRUCTURAL (geometry/coverage) PSP-vs-software comparison along the motion path. The PSP
// culls in Rust/f32 (renderNative); the oracle culls in JS/f64 (scene3d.emit) — so a
// per-pose structural divergence here is exactly the camera-motion geometry/cull bug.
const RASTER_W = 480, RASTER_H = 272;
const oracleBundle = root + 'runtime/src/game/bsp3d.js';
const oraclePak = root + 'runtime/src/game/bsp3d.dcpak';

if (!existsSync(HEADLESS)) { console.error(`PPSSPPHeadless not found at ${HEADLESS}`); process.exit(2); }
rmSync(seq, { recursive: true, force: true });
mkdirSync(seq, { recursive: true });

// --- 1. Build the bsp3d capture EBOOT (frame-indexed path, soldier hidden, no HUD). ---
// Non-box maps: temporarily point bsp3d.js's single map import at the (gitignored) baked
// module so BOTH the WebGL bundle and the PSP EBOOT render that map; revert after building
// (the built artifacts keep the map; the source tree stays clean).
const bsp3dPath = root + 'framework/games/bsp3d.js';
const origBsp3d = await Bun.file(bsp3dPath).text();
let restored = false;
const restoreBsp3d = async () => { if (!restored) { await Bun.write(bsp3dPath, origBsp3d); restored = true; } };
try {
  if (map !== 'box') {
    const sym = 'BSP_' + map.toUpperCase();                  // de_dust2 -> BSP_DE_DUST2
    const mod = '../src/assets-bsp-' + map.replace(/_/g, '-'); // -> assets-bsp-de-dust2
    const injected = origBsp3d.replace(
      "import { BSP_BOX as BSP } from '../src/assets-bsp-box';",
      `import { ${sym} as BSP } from '${mod}';`,
    );
    if (injected === origBsp3d) throw new Error('could not inject map import into bsp3d.js');
    await Bun.write(bsp3dPath, injected);
  }
  console.log(`# bundling + building bsp3d capture EBOOT (${map}) ...`);
  await $`bun framework/build.ts`.cwd(root).quiet();
  await $`bun web/build-games.ts`.cwd(root).quiet();
  await $`bun runtime/build.ts --features capture`.cwd(root).env({ ...process.env, PSPJS_GAME: 'bsp3d.js' });
} finally {
  await restoreBsp3d();
}

// --- 2. PSP capture: one headless run dumps frames [CAP_START, CAP_START+CAP_N). ---
console.log('# PSP capture (PPSSPPHeadless --graphics=software) ...');
rmSync(DCCAP, { recursive: true, force: true });
const TIMEOUT = map === 'box' ? 28 : 55; // big maps boot slower (larger QuickJS module)
await $`${HEADLESS} --graphics=software --timeout=${TIMEOUT} ${EBOOT}`.cwd('/tmp').env({ ...process.env }).nothrow();
const raws = readdirSync(DCCAP).filter((f) => /^f\d+\.raw$/.test(f)).sort();
if (raws.length < CAP_N) console.warn(`# WARN: only ${raws.length}/${CAP_N} PSP frames captured`);
for (const r of raws) {
  const f = CAP_START + parseInt(r.slice(1), 10); // f0007 -> idx 7 -> frame CAP_START+7
  // Raw is 512-stride RGBA, top-down, no alpha. Crop the stride to the visible 480.
  await $`magick -size 512x272 -depth 8 RGBA:${DCCAP}/${r} -alpha off -crop 480x272+0+0 +repage -depth 8 PNG24:${seq}/psp.${pad(f)}.png`.quiet();
}

// --- 3. WebGL per-frame: load headless.html with cap=1 & frames=F so capturePose(F) is the
// shot pose. Spawn the reference server once, reuse one Chrome, loop the poses. ---
console.log('# WebGL ground-truth frames (Chrome) ...');
let chromium: any;
try { ({ chromium } = await import('playwright')); }
catch { console.error('playwright not installed — run: bun add -d playwright'); process.exit(2); }
const { startRefServer } = await import('./ref-server.ts');
const server = startRefServer(PORT);
try {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-unsafe-swiftshader'] });
  // One page load PER pose (?pose=N pins a static camera, the page settles, then we shoot) —
  // bulletproof vs live stepping, which raced the engine's rAF and misrendered a band of
  // poses. Same reliable path as the static M1 capture.
  for (const f of frames) {
    const page = await browser.newPage({ viewport: { width: 480, height: 272 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${PORT}/headless.html?map=${map}&game=bsp3d.js&cap=1&hold=0&frames=8&pose=${f}`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForFunction('window.__ready || window.__error', null, { timeout: 25000 });
    const err = await page.evaluate('window.__error');
    if (err) throw new Error('page: ' + err);
    await page.locator('#screen').screenshot({ path: `${seq}/web.${pad(f)}.png` });
    await page.close();
  }
  await browser.close();
} finally {
  server.stop(true);
}

// --- 3.5. Software oracle per-pose: raster3d (CPU) renders the SAME bsp3d capture poses
// in-process (no GPU, no emulator, no rAF -> deterministic). Pose pinned by __capFrameOverride;
// raster3d.submit() self-clears the framebuffer, so each settled frame is the captured one. ---
console.log('# software oracle frames (raster3d, in-process) ...');
{
  const { Raster3D } = await import('../raster3d');
  const UPNG = (await import('upng-js')).default;
  const bundle = await Bun.file(oracleBundle).text();
  const pak = existsSync(oraclePak) ? await Bun.file(oraclePak).arrayBuffer() : undefined;
  const g = globalThis as any;
  for (const f of frames) {
    const buf = new Uint8Array(RASTER_W * RASTER_H * 4);
    const raster = new Raster3D(buf, RASTER_W, RASTER_H);
    g.__BSP_MAP = map;
    g.__BSP_CAPTURE = 1;          // before eval: read at module top + onEnter (hide soldier, FP cam, no HUD)
    g.__capFrameOverride = f;     // pin THIS pose; capturePose reads it live (camYaw = spawn[2] + f*0.06)
    g.__dcpak = pak;
    g.gfx = { clear() {}, fillRect() {}, fillRects() {}, text() {}, vnDrawGlyphs() {} };
    g.g3d = raster;               // Raster3D => JS emit()/f64 cull path (the structural reference)
    g.log = () => {};
    g.now = () => f * 16.7;       // deterministic clock for measureFps()
    g.frame = undefined;
    (0, eval)(bundle);            // start(() => new BspScene()) sets globalThis.frame
    const fr = g.frame;
    if (typeof fr !== 'function') throw new Error('oracle: bsp3d did not define frame (wrong bundle?)');
    for (let s = 0; s < 4; s++) fr(0); // settle lazy mesh upload; pose is frame-index-pinned -> stable
    const png = UPNG.encode([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)], RASTER_W, RASTER_H, 0);
    writeFileSync(`${seq}/oracle.${pad(f)}.png`, Buffer.from(png as ArrayBuffer));
  }
  for (const k of ['__BSP_CAPTURE', '__capFrameOverride', 'g3d', 'frame']) delete g[k];
}

// --- 4. Per-frame diff: textured (WebGL ref vs PSP) + STRUCTURAL (oracle ref vs PSP). ---
console.log('# per-frame diff (textured + structural) + temporal curves ...');
const series: { frame: number; meanRGB: number; IoU: number; structIoU: number; structXor: number }[] = [];
for (const f of frames) {
  const web = `${seq}/web.${pad(f)}.png`, psp = `${seq}/psp.${pad(f)}.png`, ora = `${seq}/oracle.${pad(f)}.png`;
  let meanRGB = 0, IoU = 1, structIoU = 1, structXor = 0;
  if (existsSync(web) && existsSync(psp)) {
    await $`bun ${here}/diff.ts ${web} ${psp} --out ${seq}/diff.${pad(f)}`.cwd(root).nothrow().quiet();
    const s = JSON.parse(readFileSync(`${seq}/diff.${pad(f)}.score.json`, 'utf8'));
    meanRGB = s.meanRGB; IoU = s.IoU;
  }
  if (existsSync(ora) && existsSync(psp)) {
    // oracle = reference, psp = under test; --structural gates on IoU only (oracle has no textures).
    await $`bun ${here}/diff.ts ${ora} ${psp} --structural --out ${seq}/struct.${pad(f)}`.cwd(root).nothrow().quiet();
    const s = JSON.parse(readFileSync(`${seq}/struct.${pad(f)}.score.json`, 'utf8'));
    structIoU = s.IoU; structXor = s.coverageXor;
  }
  series.push({ frame: f, meanRGB, IoU, structIoU, structXor });
}
writeFileSync(`${seq}/series.json`, JSON.stringify(series, null, 2));

// --- 5. Contact sheets + videos. ---
console.log('# contact sheets + videos ...');
await $`magick montage ${seq}/psp.*.png -tile 6x -geometry +2+2 -background black ${seq}/${map}.psp.contact.png`.nothrow().quiet();
await $`magick montage ${seq}/diff.*.heatmap.png -tile 6x -geometry +2+2 -background black ${seq}/${map}.diff.contact.png`.nothrow().quiet();
await $`ffmpeg -y -framerate 8 -start_number ${CAP_START} -i ${seq}/psp.%04d.png -pix_fmt yuv420p ${seq}/${map}.psp.mp4`.nothrow().quiet();
await $`ffmpeg -y -framerate 8 -start_number ${CAP_START} -i ${seq}/web.%04d.png -pix_fmt yuv420p ${seq}/${map}.web.mp4`.nothrow().quiet();
// Software-oracle leg sheets: the CPU render sweep + the PSP-vs-oracle structural heatmaps.
await $`magick montage ${seq}/oracle.*.png -tile 6x -geometry +2+2 -background black ${seq}/${map}.oracle.contact.png`.nothrow().quiet();
await $`magick montage ${seq}/struct.*.heatmap.png -tile 6x -geometry +2+2 -background black ${seq}/${map}.struct.contact.png`.nothrow().quiet();
await $`ffmpeg -y -framerate 8 -start_number ${CAP_START} -i ${seq}/oracle.%04d.png -pix_fmt yuv420p ${seq}/${map}.oracle.mp4`.nothrow().quiet();

// --- 6. Report: temporal meanRGB sparkline + flicker spikes (>3x median). ---
const vals = series.map((s) => s.meanRGB);
const sorted = [...vals].sort((x, y) => x - y);
const median = sorted.length ? sorted[sorted.length >> 1] : 0;
const spark = '▁▂▃▄▅▆▇█';
const max = Math.max(1, ...vals);
const line = vals.map((v) => spark[Math.min(7, Math.floor((v / max) * 7))]).join('');
const spikes = series.filter((s) => s.meanRGB > Math.max(8, median * 3));
console.log(`\nPSP-vs-WebGL meanRGB per pose (frames ${CAP_START}..${CAP_START + CAP_N - 1}):`);
console.log(`  ${line}   median=${median.toFixed(2)} max=${max.toFixed(2)}`);
console.log(`  flicker/divergence spikes (>3x median or >8): ${spikes.length ? spikes.map((s) => `${s.frame}(${s.meanRGB})`).join(', ') : 'none'}`);

// Structural PSP-vs-software(oracle) curve: 1-IoU per pose. A spike = the PSP gained/lost a
// face vs the deterministic software render = a real motion-geometry/cull divergence.
const sgap = series.map((s) => 1 - s.structIoU);
const smax = Math.max(0.0001, ...sgap);
const sline = sgap.map((v) => spark[Math.min(7, Math.floor((v / smax) * 7))]).join('');
const worstStruct = series.length ? Math.min(...series.map((s) => s.structIoU)) : 1;
console.log(`\nPSP-vs-software(oracle) structural 1-IoU per pose (deterministic CPU reference):`);
console.log(`  ${sline}   worst IoU=${worstStruct.toFixed(4)}`);
// The software-oracle structural IoU matches the WebGL structural IoU pose-for-pose (same
// engine/camera) — so it's a DETERMINISTIC, no-GPU geometry reference, not a noisy one. Two
// signals: (1) the BASELINE median = the standing PSP-vs-software coverage gap (if well below
// 1, PSP systematically renders different surface — e.g. skybox/ground depth, near geometry);
// (2) ACUTE drops below that baseline = the camera-motion geometry/cull spikes to chase.
const sIoUs = series.map((s) => s.structIoU);
const medStruct = sIoUs.length ? [...sIoUs].sort((a, b) => a - b)[sIoUs.length >> 1] : 1;
const acute = series.filter((s) => s.structIoU < Math.min(0.5, medStruct - 0.2));
const texOnly = series.filter((s) => s.structIoU >= 0.9 && s.meanRGB > 8);
console.log(`  baseline structural IoU median=${medStruct.toFixed(2)} ${medStruct < 0.95 ? '(standing PSP-vs-software coverage gap — investigate skybox/ground depth or near geometry)' : '(PSP geometry tracks the software render)'}`);
console.log(`  ACUTE geometry divergence (PSP drops most surface that the software/WebGL render): ${acute.length ? acute.map((s) => `${s.frame}(IoU=${s.structIoU.toFixed(2)})`).join(', ') : 'none'}`);
console.log(`  texture-only divergence (geometry OK, shading/wrap differs): ${texOnly.length ? texOnly.map((s) => `${s.frame}(meanRGB=${s.meanRGB})`).join(', ') : 'none'}`);

console.log(`\nseq -> ${seq}/`);
console.log(`  ${map}.psp.contact.png   ${map}.diff.contact.png   ${map}.oracle.contact.png   ${map}.struct.contact.png`);
console.log(`  ${map}.psp.mp4   ${map}.web.mp4   ${map}.oracle.mp4   series.json`);

// Restore the committed (box) game bundle: §1 reverts bsp3d.js SOURCE but its built bundle
// (runtime/src/game/bsp3d.js, gitignored) is left on this map, which would fail the box
// golden test. Rebuild from the restored source so the tree's generated state is consistent.
if (map !== 'box') {
  console.log('# restoring committed (box) game bundle ...');
  await $`bun framework/build.ts`.cwd(root).quiet().nothrow();
}
