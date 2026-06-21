// E2E Stage 1 — PARSE. Parses the committed box.bsp fixture through bsp.ts and
// asserts the GoldSrc BSP v30 structure is sound: valid lump directory, real
// geometry (faces reconstruct from signed surfedges into non-degenerate convex
// rings), finite UVs, a decoded embedded texture, and a single in-bounds spawn.
// Run: bun framework/test/bsp-parse.test.ts
import { readFileSync } from 'node:fs';
import { parseBsp, faceVertexIndices, vertexAt, uvAt } from '../bake/bsp';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); }
};

const here = new URL('.', import.meta.url).pathname;
const raw = readFileSync(here + 'fixtures/box.bsp');
const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
const bsp = parseBsp(ab);

// --- header / lump directory ---
ok(bsp.version === 30, `version is 30 (got ${bsp.version})`);
ok(bsp.lumps.length === 15, '15 lumps');
const HEADER = 4 + 15 * 8;
for (let i = 0; i < 15; i++) {
  const l = bsp.lumps[i];
  ok(l.offset >= HEADER && l.length >= 0 && l.offset + l.length <= raw.length, `lump ${i} in bounds`);
}
// fixed-size lumps: length divides the element size cleanly.
const ENTRY: Record<number, number> = { 1: 20, 3: 12, 6: 40, 7: 20, 12: 4, 13: 4, 14: 64 };
for (const [id, sz] of Object.entries(ENTRY)) {
  ok(bsp.lumps[+id].length % sz === 0, `lump ${id} length multiple of ${sz}`);
}

// --- counts ---
ok(bsp.vertices.length / 3 >= 4, 'has vertices');
ok(bsp.faces.length > 0, 'has faces');
ok(bsp.planes.length > 0, 'has planes');
ok(bsp.edges.length / 2 >= 1, 'has edges');
ok(bsp.surfedges.length > 0, 'has surfedges');
ok(bsp.texinfos.length > 0, 'has texinfos');
ok(bsp.models.length >= 1, 'has worldspawn model');

// --- texture decoded ---
const tex = bsp.textures.find((t) => t.embedded && t.pixels);
ok(!!tex, 'an embedded texture decoded');
if (tex) {
  ok(tex.pixels!.length === tex.width * tex.height * 4, 'texture RGBA size matches w*h');
  let sum = 0;
  for (let i = 0; i < tex.pixels!.length; i += 4) sum += tex.pixels![i] + tex.pixels![i + 1] + tex.pixels![i + 2];
  ok(sum > 0, 'texture is not all black');
}

// --- spawn: exactly one info_player_start, finite origin inside the world AABB ---
const spawns = bsp.entities.filter((e) => e.classname === 'info_player_start');
ok(spawns.length === 1, `exactly one info_player_start (got ${spawns.length})`);
if (spawns.length === 1) {
  const o = spawns[0].origin.split(/\s+/).map(Number);
  ok(o.length === 3 && o.every(Number.isFinite), 'spawn origin is a finite 3-vec');
  const m = bsp.models[0];
  const inside = o[0] >= m.mins[0] && o[0] <= m.maxs[0] && o[1] >= m.mins[1] && o[1] <= m.maxs[1] && o[2] >= m.mins[2] && o[2] <= m.maxs[2];
  ok(inside, 'spawn is inside the world AABB');
}

// --- every worldspawn face reconstructs into a non-degenerate convex ring with finite UVs ---
const m0 = bsp.models[0];
let facesChecked = 0;
for (let fi = m0.firstface; fi < m0.firstface + m0.numfaces; fi++) {
  const f = bsp.faces[fi];
  const ring = faceVertexIndices(bsp, f);
  ok(ring.length === f.numedges && ring.length >= 3, `face ${fi}: ring length == numedges >= 3`);
  ok(ring.every((vi) => vi >= 0 && vi * 3 < bsp.vertices.length), `face ${fi}: vertex indices in range`);
  const vs = ring.map((vi) => vertexAt(bsp, vi));
  // consecutive vertices distinct
  let distinct = true;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i], b = vs[(i + 1) % vs.length];
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) distinct = false;
  }
  ok(distinct, `face ${fi}: consecutive vertices distinct`);
  // Newell normal magnitude > epsilon (non-degenerate planar polygon)
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i], b = vs[(i + 1) % vs.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  ok(Math.hypot(nx, ny, nz) > 1e-6, `face ${fi}: non-degenerate (Newell normal)`);
  // finite UVs
  const ti = bsp.texinfos[f.texinfo];
  const t = bsp.textures[ti.miptex];
  let uvFinite = true;
  for (const vi of ring) {
    const uv = uvAt(ti, vertexAt(bsp, vi), t?.width || 16, t?.height || 16);
    if (!Number.isFinite(uv[0]) || !Number.isFinite(uv[1])) uvFinite = false;
  }
  ok(uvFinite, `face ${fi}: finite UVs`);
  facesChecked++;
}
ok(facesChecked === m0.numfaces, 'checked all worldspawn faces');

// --- determinism: parse twice, identical structure ---
const bsp2 = parseBsp(ab);
ok(JSON.stringify(bsp.faces) === JSON.stringify(bsp2.faces) &&
   bsp.vertices.length === bsp2.vertices.length &&
   bsp.entities.length === bsp2.entities.length, 'parse is deterministic');

console.log(`\nbsp-parse: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
