// Generates `box.bsp` — a minimal but REAL GoldSrc BSP version 30: one closed
// rectangular room (8 verts, 6 inward faces) with one embedded, palettized texture
// and an info_player_start at the centre. This is ORIGINAL CC0 work (no Valve
// content), so it is safe to commit as the deterministic fixture for the BSP-import
// E2E tests. It exercises the real 15-lump binary format incl. signed surfedges,
// texinfo UVs, and embedded miptex+palette decoding.
//
// Run: bun framework/test/fixtures/make-box-bsp.ts  ->  writes box.bsp next to it.
import { writeFileSync } from 'fs';

const LUMPS = 15;
const HEADER = 4 + LUMPS * 8; // int32 version + 15×{int32 ofs, int32 len}

// Room extent in Hammer units (Z-up, inches).
const MN = [-128, -128, 0];
const MX = [128, 128, 160];
// 8 corners (x,y,z).
const V: [number, number, number][] = [
  [MN[0], MN[1], MN[2]], [MX[0], MN[1], MN[2]], [MX[0], MX[1], MN[2]], [MN[0], MX[1], MN[2]],
  [MN[0], MN[1], MX[2]], [MX[0], MN[1], MX[2]], [MX[0], MX[1], MX[2]], [MN[0], MX[1], MX[2]],
];
// 6 faces as CCW vertex rings (interior view), each with its plane + dominant axis.
const FACES = [
  { ring: [0, 1, 2, 3], normal: [0, 0, 1], dist: 0, axis: 'z' }, // floor
  { ring: [7, 6, 5, 4], normal: [0, 0, -1], dist: -160, axis: 'z' }, // ceiling
  { ring: [0, 4, 5, 1], normal: [0, 1, 0], dist: -128, axis: 'y' }, // -Y wall
  { ring: [2, 6, 7, 3], normal: [0, -1, 0], dist: -128, axis: 'y' }, // +Y wall
  { ring: [3, 7, 4, 0], normal: [1, 0, 0], dist: -128, axis: 'x' }, // -X wall
  { ring: [1, 5, 6, 2], normal: [-1, 0, 0], dist: -128, axis: 'x' }, // +X wall
];

// --- unique edges (stored min->max) + signed surfedges per face ---
const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
const edgeList: [number, number][] = [[0, 0]]; // index 0 = sentinel
const edgeIndex = new Map<string, number>();
const surfedges: number[] = [];
const faceSurf: { first: number; count: number }[] = [];
for (const f of FACES) {
  const first = surfedges.length;
  const r = f.ring;
  for (let i = 0; i < r.length; i++) {
    const u = r[i];
    const w = r[(i + 1) % r.length];
    const key = edgeKey(u, w);
    let ei = edgeIndex.get(key);
    if (ei === undefined) {
      ei = edgeList.length;
      edgeList.push(u < w ? [u, w] : [w, u]);
      edgeIndex.set(key, ei);
    }
    surfedges.push(u < w ? ei : -ei); // signed: forward if u<w, else reversed
  }
  faceSurf.push({ first, count: r.length });
}

// --- texinfo: planar projection per face's dominant axis (UV in texels/unit, /texW at parse) ---
function texinfoFor(axis: string): { s: number[]; t: number[] } {
  if (axis === 'z') return { s: [1, 0, 0, 0], t: [0, 1, 0, 0] };
  if (axis === 'y') return { s: [1, 0, 0, 0], t: [0, 0, 1, 0] };
  return { s: [0, 1, 0, 0], t: [0, 0, 1, 0] }; // x
}

// --- embedded 64×64 texture: checker of two palette indices, full mip chain + palette ---
const TW = 64, TH = 64;
function buildMiptex(): Buffer {
  const mipBytes = TW * TH + (TW / 2) * (TH / 2) + (TW / 4) * (TH / 4) + (TW / 8) * (TH / 8);
  const buf = Buffer.alloc(40 + mipBytes + 2 + 256 * 3);
  buf.write('GROUNDTEX', 0, 'ascii'); // name[16] (NUL-padded by alloc)
  buf.writeUInt32LE(TW, 16);
  buf.writeUInt32LE(TH, 20);
  const off0 = 40;
  const off1 = off0 + TW * TH;
  const off2 = off1 + (TW / 2) * (TH / 2);
  const off3 = off2 + (TW / 4) * (TH / 4);
  buf.writeUInt32LE(off0, 24);
  buf.writeUInt32LE(off1, 28);
  buf.writeUInt32LE(off2, 32);
  buf.writeUInt32LE(off3, 36);
  // mip0 checker (8-texel cells) of index 1 / 2; coarser mips filled flat (unused by parser).
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      buf[off0 + y * TW + x] = (((x >> 3) + (y >> 3)) & 1) ? 2 : 1;
    }
  }
  // palette right after mip3: u16 count(256) + 256×RGB.
  const palCountOff = off3 + (TW / 8) * (TH / 8);
  buf.writeUInt16LE(256, palCountOff);
  const pal = palCountOff + 2;
  buf[pal + 0 * 3] = 40; buf[pal + 0 * 3 + 1] = 40; buf[pal + 0 * 3 + 2] = 50; // 0 dark
  buf[pal + 1 * 3] = 168; buf[pal + 1 * 3 + 1] = 172; buf[pal + 1 * 3 + 2] = 180; // 1 light stone
  buf[pal + 2 * 3] = 74; buf[pal + 2 * 3 + 1] = 104; buf[pal + 2 * 3 + 2] = 150; // 2 blue
  return buf;
}

// --- assemble lumps (index order) ---
const lumpData: (Buffer | null)[] = new Array(LUMPS).fill(null);

// L0 ENTITIES
const ents =
  '{\n"classname" "worldspawn"\n"wad" ""\n}\n' +
  '{\n"classname" "info_player_start"\n"origin" "0 0 40"\n"angle" "90"\n}\n';
lumpData[0] = Buffer.from(ents + '\0', 'ascii');

// L1 PLANES (20 B)
{
  const b = Buffer.alloc(FACES.length * 20);
  FACES.forEach((f, i) => {
    const o = i * 20;
    b.writeFloatLE(f.normal[0], o); b.writeFloatLE(f.normal[1], o + 4); b.writeFloatLE(f.normal[2], o + 8);
    b.writeFloatLE(f.dist, o + 12);
    b.writeInt32LE(f.normal[2] !== 0 ? 2 : f.normal[1] !== 0 ? 1 : 0, o + 16); // type (axis)
  });
  lumpData[1] = b;
}

// L2 TEXTURES
{
  const mip = buildMiptex();
  const b = Buffer.alloc(4 + 4 + mip.length);
  b.writeUInt32LE(1, 0); // nummiptex
  b.writeInt32LE(8, 4); // dataoffset[0] relative to lump start (4 + 1*4)
  mip.copy(b, 8);
  lumpData[2] = b;
}

// L3 VERTEXES (12 B)
{
  const b = Buffer.alloc(V.length * 12);
  V.forEach((v, i) => { b.writeFloatLE(v[0], i * 12); b.writeFloatLE(v[1], i * 12 + 4); b.writeFloatLE(v[2], i * 12 + 8); });
  lumpData[3] = b;
}

lumpData[4] = Buffer.alloc(0); // VISIBILITY
lumpData[5] = Buffer.alloc(0); // NODES

// L6 TEXINFO (40 B)
{
  const b = Buffer.alloc(FACES.length * 40);
  FACES.forEach((f, i) => {
    const ti = texinfoFor(f.axis);
    const o = i * 40;
    for (let k = 0; k < 4; k++) b.writeFloatLE(ti.s[k], o + k * 4);
    for (let k = 0; k < 4; k++) b.writeFloatLE(ti.t[k], o + 16 + k * 4);
    b.writeUInt32LE(0, o + 32); // miptex 0
    b.writeUInt32LE(0, o + 36); // flags
  });
  lumpData[6] = b;
}

// L7 FACES (20 B)
{
  const b = Buffer.alloc(FACES.length * 20);
  FACES.forEach((f, i) => {
    const o = i * 20;
    b.writeUInt16LE(i, o); // plane
    b.writeUInt16LE(0, o + 2); // side
    b.writeInt32LE(faceSurf[i].first, o + 4);
    b.writeUInt16LE(faceSurf[i].count, o + 8);
    b.writeUInt16LE(i, o + 10); // texinfo (per-face)
    b.writeUInt8(0, o + 12); b.writeUInt8(255, o + 13); b.writeUInt8(255, o + 14); b.writeUInt8(255, o + 15); // styles
    b.writeInt32LE(-1, o + 16); // lightofs: none (flat/directional shade at bake)
  });
  lumpData[7] = b;
}

lumpData[8] = Buffer.alloc(0); // LIGHTING
lumpData[9] = Buffer.alloc(0); // CLIPNODES
lumpData[10] = Buffer.alloc(0); // LEAVES
lumpData[11] = Buffer.alloc(0); // MARKSURFACES

// L12 EDGES (4 B)
{
  const b = Buffer.alloc(edgeList.length * 4);
  edgeList.forEach((e, i) => { b.writeUInt16LE(e[0], i * 4); b.writeUInt16LE(e[1], i * 4 + 2); });
  lumpData[12] = b;
}

// L13 SURFEDGES (4 B, signed)
{
  const b = Buffer.alloc(surfedges.length * 4);
  surfedges.forEach((s, i) => b.writeInt32LE(s, i * 4));
  lumpData[13] = b;
}

// L14 MODELS (64 B) — models[0] = worldspawn covering all 6 faces
{
  const b = Buffer.alloc(64);
  for (let k = 0; k < 3; k++) b.writeFloatLE(MN[k], k * 4);
  for (let k = 0; k < 3; k++) b.writeFloatLE(MX[k], 12 + k * 4);
  for (let k = 0; k < 3; k++) b.writeFloatLE(0, 24 + k * 4); // origin
  for (let k = 0; k < 4; k++) b.writeInt32LE(k === 0 ? 0 : -1, 36 + k * 4); // headnode
  b.writeInt32LE(0, 52); // visleafs
  b.writeInt32LE(0, 56); // firstface
  b.writeInt32LE(FACES.length, 60); // numfaces
  lumpData[14] = b;
}

// --- write header + lumps ---
let cursor = HEADER;
const dir: { ofs: number; len: number }[] = [];
const parts: Buffer[] = [];
for (let i = 0; i < LUMPS; i++) {
  const d = lumpData[i]!;
  dir.push({ ofs: cursor, len: d.length });
  parts.push(d);
  cursor += d.length;
  // 4-byte align the next lump (keeps int reads aligned; lengths are exact).
  const pad = (4 - (cursor % 4)) % 4;
  if (pad) { parts.push(Buffer.alloc(pad)); cursor += pad; }
}
const header = Buffer.alloc(HEADER);
header.writeInt32LE(30, 0); // version
dir.forEach((e, i) => { header.writeInt32LE(e.ofs, 4 + i * 8); header.writeInt32LE(e.len, 8 + i * 8); });

const out = Buffer.concat([header, ...parts]);
const path = new URL('box.bsp', import.meta.url).pathname;
writeFileSync(path, out);
console.log(`wrote ${path} (${out.length} bytes, v30, ${FACES.length} faces, ${V.length} verts, 1 embedded tex)`);
