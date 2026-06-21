// One-command BSP iteration loop: (re)bake a map, then run the 3-leg camera-MOVEMENT
// cross-comparison — PSP (PPSSPPHeadless), WebGL ground truth (Chrome), and the raster3d
// CPU software oracle — diffing every pose textured (PSP vs WebGL) AND structurally
// (PSP vs software). Re-run after any bake/renderer/capturePose tweak and read the
// divergence summary; the structural curve isolates real motion-geometry/cull bugs.
//
//   bun run bsp-iterate box        # the committed CC0 fixture (no fetch)
//   bun run bsp-iterate de_dust2   # fetch+bake locally (gitignored), then compare
//
// Bake is --bake-only (fetch + produce the asset module/blobs); seq-capture does the
// repoint + EBOOT build + capture, and reverts framework/games/bsp3d.js when done.
import { $ } from 'bun';

const root = new URL('..', import.meta.url).pathname;
const map = process.argv[2] || process.env.BSP_MAP || 'box';

console.log(`# [bsp-iterate] bake ${map} (fetch + bake only) ...`);
await $`bun scripts/bsp-map.ts ${map} --bake-only`.cwd(root);

console.log(`# [bsp-iterate] 3-leg movement capture + compare ${map} (PSP | WebGL | software oracle) ...`);
await $`bun framework/test/bsp-compare/seq-capture.ts ${map}`.cwd(root);

console.log(`\n✅ bsp-iterate ${map} done -> framework/test/bsp-compare/seq/${map}/`);
