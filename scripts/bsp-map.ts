// One-command build of a GoldSrc / CS 1.6 map into a playable bsp3d EBOOT:
//   fetch the .bsp (+ the WADs it needs) if missing  ->  bake the asset module
//   ->  point framework/games/bsp3d.js at it  ->  bundle  ->  build the PSP EBOOT.
//
//   bun run bsp de_dust2            # fetch + bake + build a playable de_dust2 EBOOT
//   bun run bsp de_dust2 --bake-only   # just produce framework/src/assets-bsp-de-dust2.ts
//   bun run bsp box                # the committed CC0 fixture (no fetch)
//
// Classic CS/HL maps are Valve/CS-copyright: the fetched .bsp/.wad and the baked module
// are gitignored (only the CC0 box.bsp + its module are committed). This command edits
// the bsp3d.js import line locally — restore the committed default afterwards with:
//   git checkout framework/games/bsp3d.js
import { $ } from 'bun';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const bakeOnly = args.includes('--bake-only');
const map = args.find((a) => !a.startsWith('--')) || 'box';
const vendor = root + 'assets/vendor/bsp/';
const safe = map.replace(/[^a-z0-9]/gi, '-').toLowerCase(); // matches bake-bsp's outName stem
const constName = 'BSP_' + map.toUpperCase().replace(/[^A-Z0-9]/g, '_'); // matches bake-bsp's export

// Committed CC0 fixtures under framework/test/fixtures/ (box room, zfight test scene) are
// authored locally by make-*-bsp.ts, never fetched.
const LOCAL_FIXTURES = new Set(['box', 'zfight']);

// 1. fetch the map (+ common CS WADs) if not already vendored. Local CC0 fixtures skip fetch.
if (!LOCAL_FIXTURES.has(map)) {
  if (!existsSync(vendor + map + '.bsp')) {
    console.log(`# fetching ${map}.bsp ...`);
    await $`bun framework/bake/fetch-bsp.ts ${map}`.cwd(root);
  }
  if (/^(de_|cs_)/.test(map)) {
    for (const w of ['halflife.wad', 'cs_dust.wad', 'decals.wad']) {
      if (!existsSync(vendor + w)) { console.log(`# fetching ${w} (textures) ...`); await $`bun framework/bake/fetch-bsp.ts ${w}`.cwd(root); }
    }
  }
}

// 2. bake -> framework/src/assets-bsp-<safe>.ts
console.log(`# baking ${map} ...`);
await $`bun framework/bake/bake-bsp.ts ${map}`.cwd(root);
const modulePath = root + `framework/src/assets-bsp-${safe}.ts`;
if (!existsSync(modulePath)) { console.error(`bake produced no ${modulePath}`); process.exit(1); }

if (bakeOnly) {
  console.log(`\n✅ Baked framework/src/assets-bsp-${safe}.ts (asset only).`);
  console.log(`   To play it: import { ${constName} as BSP } in framework/games/bsp3d.js, then \`bun run bsp ${map}\`.`);
  process.exit(0);
}

// 3. point bsp3d.js at the baked module (LOCAL edit — revert with git checkout to restore box)
const gamePath = root + 'framework/games/bsp3d.js';
const game = readFileSync(gamePath, 'utf8');
const next = game.replace(
  /import \{ BSP_[A-Z0-9_]+ as BSP \} from '\.\.\/src\/assets-bsp-[a-z0-9-]+';/,
  `import { ${constName} as BSP } from '../src/assets-bsp-${safe}';`,
);
if (next === game && !game.includes(`assets-bsp-${safe}'`)) { console.error('could not rewrite the bsp3d.js import line'); process.exit(1); }
writeFileSync(gamePath, next);

// 4. bundle + build the PSP EBOOT
console.log('# bundling + building EBOOT ...');
await $`bun framework/build.ts`.cwd(root);
await $`bun runtime/build.ts`.cwd(root).env({ ...process.env, DREAMCART_GAME: 'bsp3d.js' });

console.log(`\n✅ Built a playable bsp3d EBOOT for "${map}".`);
console.log(`   Launch (PPSSPP):  open -a PPSSPPSDL runtime/target/mipsel-sony-psp/debug/EBOOT.PBP`);
if (map !== 'box') console.log(`   Restore the committed box default:  git checkout framework/games/bsp3d.js`);
