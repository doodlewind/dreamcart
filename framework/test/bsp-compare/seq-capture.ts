// Camera-PATH ground-truth capture (Milestone 2): drive the bsp3d viewer along a
// deterministic, frame-indexed camera sweep and capture the SAME poses on PSP (one
// PPSSPPHeadless run, dumping each frame to ms0:/dc_cap via the `capture` feature) and on
// WebGL (Chrome). Then diff every pose and assemble contact sheets + videos + a temporal
// meanRGB curve, so camera-motion flicker/jump on PSP shows up as a per-frame spike
// against the WebGL ground truth instead of an anecdote.
//
//   bun run bsp-loop-seq box
//
// Window MUST match runtime/src/main.rs cap_dump_frame: frames [CAP_START, CAP_START+CAP_N).
//
// STATUS: the PSP capture (deterministic per-frame dump -> psp.NNNN.png, contact sheet,
// mp4) is solid — that's the reproduce-the-sweep capability. The per-frame WebGL diff has a
// KNOWN alignment artifact: a contiguous band of poses reports a large meanRGB even though
// capturePose is stateless and both sides intend the same camera. The band MOVES with
// CAP_START, so it's a capture/stepping-timing issue (web side most likely), NOT a pose or
// PSP-render bug. Treat the per-pose meanRGB as provisional until the web stepping is
// hardened; trust the PSP contact sheet / mp4 as the reliable motion artifact for now.
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
const server = Bun.spawn(['bun', 'web/serve.ts'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdout: 'ignore', stderr: 'ignore' });
await new Promise((r) => setTimeout(r, 1600));
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
  server.kill();
}

// --- 4. Per-frame diff (WebGL ref vs PSP) + temporal curve. ---
console.log('# per-frame diff + temporal curve ...');
const series: { frame: number; meanRGB: number; IoU: number }[] = [];
for (const f of frames) {
  const a = `${seq}/web.${pad(f)}.png`, b = `${seq}/psp.${pad(f)}.png`;
  if (!existsSync(a) || !existsSync(b)) continue;
  await $`bun ${here}/diff.ts ${a} ${b} --out ${seq}/diff.${pad(f)}`.cwd(root).nothrow().quiet();
  const s = JSON.parse(readFileSync(`${seq}/diff.${pad(f)}.score.json`, 'utf8'));
  series.push({ frame: f, meanRGB: s.meanRGB, IoU: s.IoU });
}
writeFileSync(`${seq}/series.json`, JSON.stringify(series, null, 2));

// --- 5. Contact sheets + videos. ---
console.log('# contact sheets + videos ...');
await $`magick montage ${seq}/psp.*.png -tile 6x -geometry +2+2 -background black ${seq}/${map}.psp.contact.png`.nothrow().quiet();
await $`magick montage ${seq}/diff.*.heatmap.png -tile 6x -geometry +2+2 -background black ${seq}/${map}.diff.contact.png`.nothrow().quiet();
await $`ffmpeg -y -framerate 8 -start_number ${CAP_START} -i ${seq}/psp.%04d.png -pix_fmt yuv420p ${seq}/${map}.psp.mp4`.nothrow().quiet();
await $`ffmpeg -y -framerate 8 -start_number ${CAP_START} -i ${seq}/web.%04d.png -pix_fmt yuv420p ${seq}/${map}.web.mp4`.nothrow().quiet();

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
console.log(`\nseq -> ${seq}/`);
console.log(`  ${map}.psp.contact.png   ${map}.diff.contact.png`);
console.log(`  ${map}.psp.mp4   ${map}.web.mp4   series.json`);
