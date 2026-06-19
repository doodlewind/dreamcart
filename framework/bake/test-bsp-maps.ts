// Systematic import test over a BATCH of real GoldSrc/CS maps. Scans every
// assets/vendor/bsp/*.bsp (fetched via fetch-bsp.ts; gitignored, Valve/CS-copyright),
// parses + WAD-resolves + bakes each, and asserts the importer handles it: a valid
// BSP v30, real geometry, a usable spawn, and a bake that stays under the PSP budget.
// Prints a results matrix. NOT a committed CI test (the maps are copyrighted) — run it
// locally after `bun framework/bake/fetch-bsp.ts <names...>`.
//
// Run: bun framework/bake/test-bsp-maps.ts
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { parseBsp, parseWad, resolveWadTextures } from './bsp';

const ROOT = new URL('../../', import.meta.url).pathname;
const vendor = ROOT + 'assets/vendor/bsp/';
const BUDGET = 1.18 * 1024 * 1024;

if (!existsSync(vendor)) { console.log('no assets/vendor/bsp/ — run fetch-bsp.ts first'); process.exit(0); }
const bsps = readdirSync(vendor).filter((f) => f.toLowerCase().endsWith('.bsp')).sort();
if (!bsps.length) { console.log('no .bsp files vendored — run fetch-bsp.ts first'); process.exit(0); }

const wads = readdirSync(vendor).filter((f) => f.toLowerCase().endsWith('.wad')).map((f) => {
  const w = readFileSync(vendor + f);
  return parseWad(w.buffer.slice(w.byteOffset, w.byteOffset + w.byteLength) as ArrayBuffer);
});
console.log(`Importing ${bsps.length} map(s) with ${wads.length} WAD(s):\n`);

let pass = 0, fail = 0;
const rows: string[] = [];
for (const file of bsps) {
  const name = file.replace(/\.bsp$/i, '');
  let ok = true;
  const note: string[] = [];
  try {
    const raw = readFileSync(vendor + file);
    const bsp = parseBsp(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
    const resolved = resolveWadTextures(bsp, wads);
    const faces = bsp.faces.length, verts = bsp.vertices.length / 3;
    const textured = bsp.textures.filter((t) => t.pixels).length;
    const spawn = bsp.entities.some((e) => e.classname === 'info_player_start' || /^info_player/.test(e.classname || ''));

    const baked = spawnSync('bun', ['framework/bake/bake-bsp.ts', name], { cwd: ROOT, encoding: 'utf8' });
    const modulePath = ROOT + `framework/src/assets-bsp-${name.replace(/[^a-z0-9]/g, '-')}.ts`;
    const moduleSize = existsSync(modulePath) ? statSync(modulePath).size : 0;
    const bakeOk = baked.status === 0 && moduleSize > 0 && moduleSize <= BUDGET;
    const stats = (baked.stdout || '').match(/(\d+) sub-meshes, (\d+) verts, (\d+) tris[\s\S]*?minArea=([\d.]+)/);

    ok = bsp.version === 30 && faces > 0 && verts > 0 && spawn && bakeOk;
    note.push(
      `v${bsp.version}`, `${faces}f`, `${verts}v`,
      `tex ${textured}/${bsp.textures.length}(+${resolved}wad)`,
      `spawn=${spawn ? 'Y' : 'N'}`,
      bakeOk ? `bake ${(moduleSize / 1024 / 1024).toFixed(2)}MB` : `bake FAIL`,
      stats ? `${stats[3]}tris minArea=${stats[4]}` : '',
    );
    if (!bakeOk && baked.stderr) note.push('| ' + baked.stderr.trim().split('\n').pop());
  } catch (e) { ok = false; note.push('EXC: ' + ((e as Error).message || e)); }

  const line = `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(20)} ${note.join(' ')}`;
  console.log(line);
  rows.push(line);
  ok ? pass++ : fail++;
}

console.log(`\nbsp-maps: ${pass} passed, ${fail} failed (${bsps.length} maps)`);
process.exit(fail ? 1 : 0);
