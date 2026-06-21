// Orchestrates the local BSP ground-truth comparison for a map (default 'box'):
// build the bundles -> render the software oracle (structure) -> render the WebGL
// ground truth (Chrome) -> structural diff (WebGL vs oracle). The textured
// WebGL-vs-PPSSPP gate is MANUAL (emulator); see ppsspp-capture.md.
//
// Requires Google Chrome + `bun add -d playwright`. Local tool (not CI; the committed
// CI gate is the deterministic bsp-compare render golden in golden.ts).
//   bun framework/test/bsp-compare/run.ts [map]
import { $ } from 'bun';

const map = process.argv[2] || process.env.BSP_MAP || 'box';
const root = new URL('../../../', import.meta.url).pathname;
const dir = 'framework/test/bsp-compare';
const env = { ...process.env, BSP_MAP: map };

console.log(`# building bundles ...`);
await $`bun framework/build.ts`.cwd(root).quiet();
await $`bun web/build-games.ts`.cwd(root).quiet();

console.log(`# rendering software oracle (structure) ...`);
await $`bun ${dir}/oracle.ts`.cwd(root).env(env);
console.log(`# rendering WebGL ground truth (Chrome headless) ...`);
await $`bun ${dir}/webgl-shoot.ts`.cwd(root).env(env);

console.log(`# structural diff: WebGL vs oracle (geometry coverage) ...`);
await $`bun ${dir}/diff.ts ${dir}/${map}.webgl.png ${dir}/${map}.oracle.png --structural --out ${dir}/${map}.struct`.cwd(root).nothrow();

// Textured HOST gate: capture what the PSP engine actually renders (PPSSPP) and diff it
// against the WebGL ground truth. This closes the loop. Opt out with BSP_HOST=0 (e.g. on
// a machine with no emulator); a capture failure degrades to the manual hint, the WebGL/
// oracle legs above still succeed.
if (process.env.BSP_HOST !== '0') {
  console.log(`\n# capturing PPSSPP frame (backend=${process.env.CAPTURE_BACKEND || 'auto'}) ...`);
  const cap = await $`bun ${dir}/ppsspp-shoot.ts`.cwd(root).env(env).nothrow();
  if (cap.exitCode === 0) {
    console.log(`# host gate: WebGL vs PPSSPP (textured) ...`);
    await $`bun ${dir}/diff.ts ${dir}/${map}.webgl.png ${dir}/${map}.ppsspp.png --out ${dir}/${map}.host`.cwd(root).nothrow();
    console.log(`\nhost gate -> ${dir}/${map}.host.{score.json,heatmap.png,sidebyside.png}`);
  } else {
    console.log(`\n! PPSSPP capture unavailable (exit ${cap.exitCode}). Capture manually per ${dir}/ppsspp-capture.md, then:`);
    console.log(`  bun ${dir}/diff.ts ${dir}/${map}.webgl.png ${dir}/${map}.ppsspp.png --out ${dir}/${map}.host`);
  }
}

console.log(`\nWebGL ground truth -> ${dir}/${map}.webgl.png`);
