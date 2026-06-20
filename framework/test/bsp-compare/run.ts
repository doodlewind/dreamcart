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

console.log(`\nWebGL ground truth -> ${dir}/${map}.webgl.png`);
console.log(`For the textured host gate, capture PPSSPP per ${dir}/ppsspp-capture.md, then:`);
console.log(`  bun ${dir}/diff.ts ${dir}/${map}.webgl.png ${dir}/${map}.ppsspp.png --out ${dir}/${map}.host`);
