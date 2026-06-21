// E2E Stage 2 — BAKE. Imports the committed assets-bsp-box.ts (baked from box.bsp)
// and asserts the emitted scene is sound and in budget: decodable BakedMeshes, valid
// indices/stride, a MEANINGFUL per-vertex COLOR (non-black + non-uniform — the link
// to a meaningful render golden, since the software oracle shades by COLOR), sane
// AABBs/spawn/textures, and that re-running the baker reproduces the committed module
// byte-for-byte (determinism + drift guard).
// Run: bun framework/test/bsp-bake.test.ts
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { vertexStride, FMT_POS, FMT_COLOR, FMT_NORMAL, FMT_UV } from '../src/g3d';
// Expose the committed dcpak store as __dcpak before the baked box module evals (it now
// pulls its blobs from the pack by key); dynamic import since static imports hoist.
const _store = readFileSync(new URL('../src/assets.dcstore', import.meta.url));
(globalThis as any).__dcpak = _store.buffer.slice(_store.byteOffset, _store.byteOffset + _store.byteLength);
const { BSP_BOX: BSP } = await import('../src/assets-bsp-box');

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

const FMT = FMT_UV | FMT_COLOR | FMT_NORMAL | FMT_POS; // 0x0f
const STRIDE = vertexStride(FMT); // 36
const COLOR_OFF = 8; // GE order [uv 8][color 4][normal 12][pos 12]

const meshes = BSP.meshes();
ok(meshes.length >= 1, 'at least one sub-mesh');
ok(BSP.textures.length >= 1, 'at least one texture');

let totalV = 0, totalT = 0;
const colors = new Set<number>();
let anyNonBlack = false;
for (const m of meshes) {
  ok(m.format === FMT, `mesh format is ${FMT} (got ${m.format})`);
  ok(m.weightCount === 0, 'no bone weights');
  ok(m.stride === STRIDE, `stride is ${STRIDE} (got ${m.stride})`);
  ok(m.vertexCount > 0 && m.triCount > 0, 'mesh has geometry');
  ok(m.vertices.length === STRIDE * m.vertexCount, 'vertex bytes == stride*count');
  ok(m.indices.length === m.triCount * 3 && m.indices.length % 3 === 0, 'indices == triCount*3');
  let inRange = true;
  for (let i = 0; i < m.indices.length; i++) if (m.indices[i] >= m.vertexCount) inRange = false;
  ok(inRange, 'all indices in range');
  ok(m.texId >= 0 && m.texId < BSP.textures.length, 'texId indexes textures[]');
  // AABB sane + contains the actual vertices
  ok(m.aabb.min[0] <= m.aabb.max[0] && m.aabb.min[1] <= m.aabb.max[1] && m.aabb.min[2] <= m.aabb.max[2], 'aabb min<=max');
  const dv = new DataView(m.vertices.buffer, m.vertices.byteOffset, m.vertices.byteLength);
  let within = true;
  for (let i = 0; i < m.vertexCount; i++) {
    const o = i * STRIDE;
    const col = dv.getUint32(o + COLOR_OFF, true) & 0xffffff; // ABGR low 24 bits (b,g,r) — fine for uniqueness
    colors.add(col);
    if (col !== 0) anyNonBlack = true;
    const px = dv.getFloat32(o + 24, true), py = dv.getFloat32(o + 28, true), pz = dv.getFloat32(o + 32, true);
    if (px < m.aabb.min[0] - 1e-3 || px > m.aabb.max[0] + 1e-3 || py < m.aabb.min[1] - 1e-3 || py > m.aabb.max[1] + 1e-3 || pz < m.aabb.min[2] - 1e-3 || pz > m.aabb.max[2] + 1e-3) within = false;
    if (Math.abs(px) > 4096 || Math.abs(py) > 4096 || Math.abs(pz) > 4096) within = false;
  }
  ok(within, 'vertices inside their AABB + within the 4096 m budget box');
  totalV += m.vertexCount; totalT += m.triCount;
}
// The load-bearing link to a meaningful render: COLOR must be populated (not black)
// and varied (the baked directional shade differs per face orientation).
ok(anyNonBlack, 'per-vertex COLOR is not all black');
ok(colors.size >= 2, `per-vertex COLOR is not uniform (distinct colors: ${colors.size})`);

// budget ceilings (box is tiny but tess:1.0 subdivides its large faces for PSP guard-band
// safety; this still guards a future map regen from exploding).
ok(totalV <= 8000 && totalT <= 3000, `box geometry within fixture budget (${totalV}v/${totalT}t)`);

// spawn + module surface
ok(Array.isArray(BSP.spawn) && BSP.spawn.length === 3 && BSP.spawn.every(Number.isFinite), 'spawn is a finite [x,z,heading]');
ok(Math.abs(BSP.spawn[0]) <= BSP.span && Math.abs(BSP.spawn[1]) <= BSP.span, 'spawn within the map span');
ok(typeof BSP.attribution === 'string' && BSP.attribution.length > 0, 'has attribution');
ok(BSP.solidAABBs.byteLength % 16 === 0, 'solidAABBs is a flat [4]f32 list');
ok(BSP.textures.every((t) => t.pixels.length === t.width * t.height * 4 && (t.width & (t.width - 1)) === 0), 'textures are pow2 with full RGBA');

// determinism / drift: re-run the baker and assert the committed module is unchanged.
const here = new URL('.', import.meta.url).pathname;
const modulePath = here + '../src/assets-bsp-box.ts';
const before = readFileSync(modulePath, 'utf8');
const r = spawnSync('bun', ['framework/bake/bake-bsp.ts', 'box'], { cwd: here + '../../', encoding: 'utf8' });
ok(r.status === 0, 'baker re-runs cleanly');
const after = readFileSync(modulePath, 'utf8');
ok(before === after, 'committed assets-bsp-box.ts == a fresh bake (deterministic, no drift)');

console.log(`\nbsp-bake: ${pass} passed, ${fail} failed  (${meshes.length} meshes, ${totalV}v/${totalT}t)`);
process.exit(fail ? 1 : 0);
