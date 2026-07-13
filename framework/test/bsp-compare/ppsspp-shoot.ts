// Capture a PSP-rendered frame of the static `bsp-compare` scene from PPSSPP and write
// a 480x272 <map>.ppsspp.png — the MISSING producer that closes the BSP ground-truth
// loop (the WebGL/oracle legs already exist; see webgl-shoot.ts / oracle.ts). This is
// what the PSP engine actually draws, so diffing it against <map>.webgl.png surfaces the
// PSP renderer's inaccuracies (texture/wrap/shading) and — with a camera path (M2) —
// camera-motion flicker.
//
// Two capture backends, selected by CAPTURE_BACKEND (default: auto):
//   - headless: PPSSPPHeadless --graphics=software dumps the framebuffer deterministically
//               (CI-able, the mechanism the camera-path harness needs). Requires the
//               source build at $PPSSPP_HEADLESS (default ~/ppsspp-src/build/PPSSPPHeadless).
//   - gui:      drive the installed PPSSPPSDL.app (software 1x via capture.ini), settle,
//               trigger the F12 internal screenshot via osascript, grab the newest PNG.
// 'auto' picks headless if its binary exists, else gui.
//
//   BSP_MAP=box bun framework/test/bsp-compare/ppsspp-shoot.ts
import { $ } from 'bun';
import { existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';

const here = new URL('.', import.meta.url).pathname;
const root = here + '../../../';
const map = process.env.BSP_MAP || 'box';
const out = here + `${map}.ppsspp.png`;
const HOME = homedir();

const APP = process.env.PPSSPP_APP || '/Applications/PPSSPPSDL.app/Contents/MacOS/PPSSPPSDL';
const HEADLESS = process.env.PPSSPP_HEADLESS || `${HOME}/ppsspp-src/build/PPSSPPHeadless`;
const SHOT_DIR = process.env.PPSSPP_SCREENSHOT_DIR || `${HOME}/.config/ppsspp/PSP/SCREENSHOT`;
const EBOOT = process.env.BSP_EBOOT || (root + 'runtime/target/mipsel-sony-psp/debug/EBOOT.PBP');
const INI = here + 'capture.ini';

const backend = (process.env.CAPTURE_BACKEND
  || (existsSync(HEADLESS) ? 'headless' : 'gui')) as 'headless' | 'gui';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Build the compare EBOOT (DREAMCART_GAME=bsp-compare.js) unless told to skip. ---
async function buildEboot() {
  if (process.env.BSP_SKIP_BUILD === '1') { console.log('# (skip EBOOT build)'); return; }
  if (map !== 'box') {
    // bsp-compare.js's MAPS registry only has the committed CC0 box; other (gitignored)
    // maps must be imported+registered there manually first (see ppsspp-capture.md).
    console.warn(`# WARN: map '${map}' is not 'box' — ensure bsp-compare.js imports/registers it before building.`);
  }
  if (!existsSync(root + 'runtime/src/game/bsp-compare.js')) {
    console.log('# bundling games (framework/build.ts) ...');
    await $`bun framework/build.ts`.cwd(root).quiet();
  }
  // Headless capture needs the runtime to emit each frame to the host (sceIoDevctl
  // "emulator:" 0x20), which is behind the `capture` cargo feature.
  const feat = backend === 'headless' ? ['--features', 'capture'] : [];
  console.log(`# building compare EBOOT (cargo psp${feat.length ? ' --features capture' : ''}) ...`);
  await $`bun runtime/build.ts ${feat}`.cwd(root).env({ ...process.env, DREAMCART_GAME: 'bsp-compare.js' });
  if (!existsSync(EBOOT)) throw new Error('EBOOT not produced at ' + EBOOT);
}

function newestPng(dir: string): { path: string; mtimeMs: number } | null {
  if (!existsSync(dir)) return null;
  let best: { path: string; mtimeMs: number } | null = null;
  for (const f of readdirSync(dir)) {
    if (!/\.png$/i.test(f)) continue;
    const p = dir + '/' + f;
    const m = statSync(p).mtimeMs;
    if (!best || m > best.mtimeMs) best = { path: p, mtimeMs: m };
  }
  return best;
}

// Normalize whatever PPSSPP wrote (PNG or BGRA BMP) to an exact 480x272 PNG; diff.ts
// hard-asserts the dimensions.
async function normalizeTo(src: string, dst: string) {
  await $`magick ${src} -resize 480x272! -depth 8 PNG24:${dst}`.quiet();
}

async function captureHeadless() {
  if (!existsSync(HEADLESS)) throw new Error(`PPSSPPHeadless not found at ${HEADLESS} (build it, or use CAPTURE_BACKEND=gui)`);
  // PPSSPPHeadless captures via the guest "emulator:" EMIT_SCREENSHOT devctl (the runtime's
  // `capture` feature emits one per frame). The host compares the emitted frame against
  // --screenshot's expected; with --max-mse=0 every emit "fails" and dumps the ACTUAL frame
  // to __testfailure.bmp in CWD — so it persists even though our static game never exits
  // (we --timeout it). The bmp is 512-stride BGRA, bottom-up.
  const work = '/tmp/bsp-headless-cap';
  const actual = work + '/__testfailure.bmp';
  const expected = work + '/expected.png';
  await $`rm -rf ${work}`.quiet().nothrow();
  await $`mkdir -p ${work}`.quiet();
  await $`magick -size 480x272 xc:black ${expected}`.quiet();
  const timeout = Number(process.env.BSP_HEADLESS_TIMEOUT || 12);
  console.log(`# headless capture: PPSSPPHeadless --graphics=software (timeout ${timeout}s) ...`);
  await $`${HEADLESS} --graphics=software --screenshot=${expected} --max-mse=0 --timeout=${timeout} ${EBOOT}`
    .cwd(work).env({ ...process.env }).nothrow();
  if (!existsSync(actual)) throw new Error(
    'headless emitted no __testfailure.bmp — is the EBOOT built with --features capture? (rebuild via this script, not BSP_SKIP_BUILD)',
  );
  // PPSSPP hand-rolls a minimal BMP header that ImageMagick rejects, so decode the raw
  // pixels ourselves: 54-byte header + 512x272 BGRA. Strip header -> raw, then magick
  // reads it as BGRA. PSP writes no alpha (-alpha off) and the rows are bottom-up (-flip);
  // crop the 512 stride to the visible 480. (Orientation/channels verified: flipped frame
  // matches the WebGL ground truth at meanRGB ~1.2.)
  const raw = work + '/raw.bgra';
  const bytes = new Uint8Array(await Bun.file(actual).arrayBuffer());
  await Bun.write(raw, bytes.subarray(54));
  await $`magick -size 512x272 -depth 8 BGRA:${raw} -alpha off -flip -crop 480x272+0+0 +repage -depth 8 PNG24:${out}`.quiet();
}

async function captureGui() {
  const before = newestPng(SHOT_DIR);
  const baseline = before ? before.mtimeMs : 0;
  const settle = Number(process.env.BSP_SETTLE_MS || 9000);

  console.log(`# launching PPSSPPSDL (software 1x, capture.ini) ...`);
  const proc = Bun.spawn(
    [APP, '--windowed', '--escape-exit', '--graphics=software', `--appendconfig=${INI}`, EBOOT],
    { cwd: root, stdout: 'ignore', stderr: 'ignore' },
  );
  try {
    await sleep(settle); // let it boot + render the static frame (wall-clock; static scene => reproducible)
    // Trigger the internal F12 screenshot (key code 111). Needs PPSSPP frontmost + the
    // controlling terminal granted Accessibility permission.
    for (let attempt = 0; attempt < 3; attempt++) {
      await $`osascript -e 'tell application "System Events" to set frontmost of (every process whose name contains "PPSSPP") to true'`.quiet().nothrow();
      await sleep(400);
      await $`osascript -e 'tell application "System Events" to key code 111'`.quiet().nothrow();
      // poll for a new PNG
      for (let i = 0; i < 12; i++) {
        await sleep(350);
        const now = newestPng(SHOT_DIR);
        if (now && now.mtimeMs > baseline) {
          console.log(`# captured ${now.path}`);
          await normalizeTo(now.path, out);
          return;
        }
      }
      console.log(`# F12 attempt ${attempt + 1} produced no screenshot, retrying ...`);
    }
    throw new Error(
      `no screenshot appeared in ${SHOT_DIR}. Likely Accessibility permission is not granted to this terminal ` +
      `(System Settings → Privacy & Security → Accessibility), or the screenshot hotkey isn't F12. ` +
      `Build PPSSPPHeadless for a permission-free path.`,
    );
  } finally {
    proc.kill();
    await $`osascript -e 'tell application "System Events" to (every process whose name contains "PPSSPP") to keystroke ""'`.quiet().nothrow();
  }
}

await buildEboot();
console.log(`# capture backend: ${backend}`);
if (backend === 'headless') await captureHeadless();
else await captureGui();
console.log(`wrote ${map}.ppsspp.png`);
