// Regression for the CC0 procedural BSP generator (framework/test/fixtures/bsp-gen.ts +
// make-zfight-bsp.ts): the committed zfight.bsp must (a) parse as valid GoldSrc v30 through
// the real bsp.ts, and (b) be byte-identical to what the generator re-emits — so the
// committed fixture and the generator can never silently drift.
//   bun framework/test/bsp-gen.test.ts
import { parseBsp } from '../bake/bsp';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

const here = new URL('.', import.meta.url).pathname;
const root = here + '../../';
const bspPath = here + 'fixtures/zfight.bsp';
const committed = readFileSync(bspPath);

const bsp = parseBsp(committed.buffer.slice(committed.byteOffset, committed.byteOffset + committed.byteLength) as ArrayBuffer);
ok(bsp.version === 30, `zfight.bsp is v30 (got ${bsp.version})`);
ok(bsp.faces.length === 31, `31 faces (got ${bsp.faces.length})`);
ok(bsp.vertices.length / 3 === 44, `44 verts (got ${bsp.vertices.length / 3})`);
ok(bsp.textures.length === 3 && bsp.textures.every((t) => !!t.pixels), '3 textures, all decoded');
ok(bsp.textures.map((t) => t.name).join(',') === 'ZFWALL,ZFPROP,ZFSLAB', 'texture names ZFWALL,ZFPROP,ZFSLAB');
ok(!!bsp.entities.find((e) => e.classname === 'info_player_start'), 'has info_player_start');
ok(bsp.models[0].numfaces === bsp.faces.length, 'models[0] covers all faces');

// Deterministic generator: regenerating must reproduce the committed bytes exactly.
const r = spawnSync('bun', ['framework/test/fixtures/make-zfight-bsp.ts'], { cwd: root });
ok(r.status === 0, 'make-zfight-bsp.ts runs cleanly');
const regen = readFileSync(bspPath);
ok(Buffer.compare(committed, regen) === 0, 'regenerated zfight.bsp is byte-identical (generator is deterministic)');

console.log(`bsp-gen: ${pass} passed, ${fail} failed  (${bsp.faces.length} faces, ${bsp.textures.length} tex)`);
process.exit(fail ? 1 : 0);
