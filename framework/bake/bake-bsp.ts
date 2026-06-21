// Bakes a GoldSrc / CS 1.6 BSP v30 map (parsed by bsp.ts) into a DreamCart g3d
// scene module (framework/src/assets-bsp-<map>.ts) that the runtime loader bsp3d.js
// draws as static, frustum-culled, textured sub-meshes.
//
// What it does: take models[0] (worldspawn) faces, drop sky/trigger/clip/special
// faces, convert Hammer (Z-up, inches) -> engine (Y-up, metres), fan-triangulate,
// compute real UVs from texinfo, fold a baked directional "sun" (or a face's
// averaged lightmap) into the per-vertex COLOR (so the vertex-colour software oracle
// renders meaningful relief AND the PSP modulates the texture over it), chunk by
// (grid cell, texture) for culling + one bind per texture, and emit sub-meshes whose
// geometry/texture/collision blobs go to the dcpak store (assets.dcstore, see
// docs/dcpak-format.md) referenced by key via dcU8/dcU16 — no base64 in the JS module —
// + a textures[] array + a spawn (info_player_start) + wall collision AABBs.
//
// Run:  bun framework/bake/bake-bsp.ts box        (the committed CC0 fixture)
//       bun framework/bake/bake-bsp.ts c1a0       (fetched at build time; see fetch-bsp.ts)
import { TexMeshBuilder } from '../src/mesh';
import { parseBsp, faceVertexIndices, vertexAt, uvAt, parseWad, resolveWadTextures, type Bsp } from './bsp';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { pack, unpack, rawBytes, DT_U8, DT_U16, type Blob } from './dcpak';

interface MapConf {
  file: string; // path relative to repo root
  name: string;
  title: string; // ASCII HUD title
  attribution: string;
  scale: number; // Hammer units -> metres
  chunks: number;
  maxTextures: number; // cap kept textures (by face area)
  maxTexSize: number; // downsample textures to this power-of-two (frees module budget for geometry)
  ground: number; // RRGGBB
  sky: number;
  committed: boolean; // box: commit the module; c1a0: gitignored (Valve-derivative)
}

const ROOT = new URL('../../', import.meta.url).pathname;
const MAPS: Record<string, MapConf> = {
  box: {
    file: 'framework/test/fixtures/box.bsp',
    name: 'BSP import test room',
    title: 'BSP TEST - BOX ROOM',
    attribution: 'Original CC0 BSP v30 fixture (DreamCart)',
    scale: 0.0254, chunks: 1, maxTextures: 8, maxTexSize: 64,
    ground: 0x3a3d42, sky: 0x10141e, committed: true,
  },
  c1a0: {
    file: 'assets/vendor/bsp/c1a0.bsp',
    name: 'Half-Life c1a0 (Anomalous Materials)',
    title: 'HALF-LIFE - C1A0',
    attribution: 'Map © Valve — fetched at build, not redistributed',
    scale: 0.0254, chunks: 4, maxTextures: 16, maxTexSize: 64,
    ground: 0x4a4a44, sky: 0x20242c, committed: false,
  },
};

// A configured map name, OR any vendored assets/vendor/bsp/<name>.bsp (default config).
function configFor(arg: string | undefined): { active: string; conf: MapConf } {
  if (arg && MAPS[arg]) return { active: arg, conf: MAPS[arg] };
  if (arg && existsSync(ROOT + `assets/vendor/bsp/${arg}.bsp`)) {
    return {
      active: arg,
      conf: {
        file: `assets/vendor/bsp/${arg}.bsp`,
        name: arg, title: arg.toUpperCase().replace(/_/g, ' '),
        attribution: 'Map © its authors — fetched at build, not redistributed',
        scale: 0.0254, chunks: 4, maxTextures: 16, maxTexSize: 64,
        ground: 0x4a4a44, sky: 0x20242c, committed: false,
      },
    };
  }
  return { active: 'box', conf: MAPS.box };
}
const { active: ACTIVE, conf: M } = configFor(process.argv[2]);
// --full: high-fidelity tier for the WEB host (no PSP module budget) — keep ALL textures
// at higher resolution, more chunks, and no auto-decimation. Emits a separate *-full module.
const FULL = process.argv.includes('--full');
if (FULL) { M.maxTextures = 96; M.maxTexSize = 128; M.chunks = Math.max(M.chunks, 6); }
const outDir = ROOT + 'framework/src/';

if (!existsSync(ROOT + M.file)) {
  console.error(`[${ACTIVE}] missing ${M.file} — run the generator/fetch first`);
  process.exit(1);
}
const raw = readFileSync(ROOT + M.file);
const bsp: Bsp = parseBsp(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
if (bsp.version !== 30) { console.error(`[${ACTIVE}] not BSP v30 (got ${bsp.version})`); process.exit(1); }

// Resolve WAD-referenced textures from any vendored .wad files (classic CS maps keep
// most textures in external WADs). WADs are fetched + gitignored like the maps.
const vendorBsp = ROOT + 'assets/vendor/bsp/';
const wadMaps = existsSync(vendorBsp)
  ? readdirSync(vendorBsp).filter((f) => f.toLowerCase().endsWith('.wad')).map((f) => {
      const w = readFileSync(vendorBsp + f);
      return parseWad(w.buffer.slice(w.byteOffset, w.byteOffset + w.byteLength) as ArrayBuffer);
    })
  : [];
const wadResolved = resolveWadTextures(bsp, wadMaps);
const embeddedCount = bsp.textures.filter((t) => t.pixels).length - wadResolved;
console.log(`[${ACTIVE}] parsed v30: ${bsp.faces.length} faces, ${bsp.textures.length} textures (${embeddedCount} embedded + ${wadResolved} from ${wadMaps.length} WADs, ${bsp.textures.filter((t) => !t.pixels).length} unresolved)`);

const S = M.scale;
// Hammer (Z-up, inches) -> engine (Y-up, metres). UVs use the UNCONVERTED vertex.
const toEngine = (h: [number, number, number]): [number, number, number] => [h[0] * S, h[2] * S, -h[1] * S];

// Drop faces whose texture is a tool/sky texture (no visible surface).
const SKIP_TEX = /^(sky|aaatrigger|trigger|clip|null|origin|hint|skip|nodraw|black|invisible)/i;

// ───────────────────────── pass 1: pick visible faces + texture usage ─────────────────────────
const m0 = bsp.models[0];
interface FaceOut { fi: number; ti: number; tex: number; area: number; }
const visible: FaceOut[] = [];
const texArea = new Map<number, number>(); // miptex index -> total engine area (for the keep cap)
for (let fi = m0.firstface; fi < m0.firstface + m0.numfaces; fi++) {
  const f = bsp.faces[fi];
  // Drop sky/no-lightmap brush faces (TEX_SPECIAL) — they show the sky, which the
  // runtime's camera-following skybox renders. (de_dust2's ~1356 dropped faces are all
  // the "sky" texture; the runtime covers those openings, so they are NOT holes.)
  if (bsp.isSpecial(f)) continue;
  const ti = bsp.texinfos[f.texinfo];
  if (!ti) continue;
  const t = bsp.textures[ti.miptex];
  if (!t || (t.name && SKIP_TEX.test(t.name))) continue;
  if (f.numedges < 3) continue;
  const ring = faceVertexIndices(bsp, f);
  // area (engine units) for the texture-keep ranking + degenerate skip
  const vs = ring.map((vi) => toEngine(vertexAt(bsp, vi)));
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i], b = vs[(i + 1) % vs.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const area = Math.hypot(nx, ny, nz) * 0.5;
  if (area < 0.05) continue; // degenerate
  texArea.set(ti.miptex, (texArea.get(ti.miptex) || 0) + area);
  visible.push({ fi, ti: f.texinfo, tex: ti.miptex, area });
}

// Keep the top-N textures by area; faces using a dropped texture fall back to the
// most-used kept one (so geometry survives without blowing the texture RAM budget).
const ranked = [...texArea.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
const keep = ranked.slice(0, M.maxTextures);
const texIdOf = new Map<number, number>();
keep.forEach((mip, i) => texIdOf.set(mip, i));
const fallback = keep.length ? keep[0] : 0;

// ───────────────────────── process kept textures (decode -> pow2 <=256) ─────────────────────────
function nearestPow2(n: number, cap: number): number { let p = 1; while (p * 2 <= n && p < cap) p *= 2; return Math.max(16, p); }
function resizeRGBA(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, (y * sh / dh) | 0);
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, (x * sw / dw) | 0);
      const so = (sy * sw + sx) * 4, dO = (y * dw + x) * 4;
      out[dO] = src[so]; out[dO + 1] = src[so + 1]; out[dO + 2] = src[so + 2]; out[dO + 3] = src[so + 3];
    }
  }
  return out;
}
interface TexOut { width: number; height: number; pixels: Uint8Array; tint: number; }
const texturesOut: TexOut[] = [];
for (const mip of keep) {
  const t = bsp.textures[mip];
  const w = nearestPow2(t.width || 16, M.maxTexSize), h = nearestPow2(t.height || 16, M.maxTexSize);
  const px = t.pixels ? resizeRGBA(t.pixels, t.width, t.height, w, h) : new Uint8Array(w * h * 4).fill(180);
  // average tint (modulated by the baked shade into per-vertex COLOR)
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < w * h; i++) { r += px[i * 4]; g += px[i * 4 + 1]; b += px[i * 4 + 2]; }
  const n = w * h;
  texturesOut.push({ width: w, height: h, pixels: px, tint: ((r / n) & 255) << 16 | ((g / n) & 255) << 8 | ((b / n) & 255) });
}

// ───────────────────────── chunk grid (centred at the map's XZ centre) ─────────────────────────
let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, minY = Infinity;
for (const fo of visible) {
  const ring = faceVertexIndices(bsp, bsp.faces[fo.fi]);
  for (const vi of ring) { const e = toEngine(vertexAt(bsp, vi)); if (e[0] < minX) minX = e[0]; if (e[0] > maxX) maxX = e[0]; if (e[2] < minZ) minZ = e[2]; if (e[2] > maxZ) maxZ = e[2]; if (e[1] < minY) minY = e[1]; }
}
const cX = (minX + maxX) / 2, cZ = (minZ + maxZ) / 2;
const span = Math.max(maxX - minX, maxZ - minZ) / 2 + 2;
const NC = M.chunks * M.chunks;
const NT = texturesOut.length || 1;
const slot = (ci: number, tx: number) => ci * NT + tx;
function chunkIndex(x: number, z: number): number {
  const cell = (span * 2) / M.chunks;
  let cx = Math.floor((x - cX + span) / cell), cz = Math.floor((z - cZ + span) / cell);
  cx = Math.max(0, Math.min(M.chunks - 1, cx)); cz = Math.max(0, Math.min(M.chunks - 1, cz));
  return cz * M.chunks + cx;
}

const LIGHT = (() => { const d = [-0.4, -1, -0.3]; const l = Math.hypot(d[0], d[1], d[2]); return [-d[0] / l, -d[1] / l, -d[2] / l]; })();
const floorY = minY; // engine-Y of the lowest worldspawn vertex (the floor)

// spawn from info_player_start (independent of decimation)
const spawnEnt = bsp.entities.find((e) => e.classname === 'info_player_start') || bsp.entities.find((e) => /^info_player/.test(e.classname || ''));
let spawn: [number, number, number] = [0, 0, 0];
let spawnY = floorY; // engine-Y of the spawn entity origin (the player's floor reference)
if (spawnEnt && spawnEnt.origin) {
  const o = spawnEnt.origin.split(/\s+/).map(Number);
  const e = toEngine([o[0], o[1], o[2]]);
  spawn = [e[0] - cX, e[2] - cZ, (spawnEnt.angle ? parseFloat(spawnEnt.angle) : 0) * Math.PI / 180];
  spawnY = e[1];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const outName = `assets-bsp-${ACTIVE.replace(/[^a-z0-9]/g, '-')}${FULL ? '-full' : ''}`;
const constName = 'BSP_' + ACTIVE.toUpperCase().replace(/[^A-Z0-9]/g, '_') + (FULL ? '_FULL' : '');
// dcpak key namespace for THIS module's blobs (unique per map + tier): the baked module
// references its geometry/texture/collision blobs by key (dcU8/dcU16) instead of base64.
const K = `bsp-${ACTIVE.replace(/[^a-z0-9]/g, '-')}${FULL ? '-full' : ''}`;
interface MeshOut { texId: number; vertexCount: number; triCount: number; vKey: string; iKey: string; aabb: { min: number[]; max: number[] }; }

// ───────────────────────── emit geometry (fan-triangulate, baked shade COLOR) ─────────────────────────
// Skip faces with engine area < `minArea`; the caller raises minArea until the module
// fits the PSP-boot budget (auto-decimation). Returns the module text + stats.
function emit(minArea: number) {
  // dcpak blobs for THIS decimation pass (emit is called repeatedly; only the final
  // pass's store is flushed, so build it fresh here to avoid stale/duplicate keys).
  const store: Blob[] = [];
  const addBlob = (key: string, dtype: number, arr: ArrayBufferView): string => {
    store.push({ key, dtype, data: rawBytes(arr).slice() }); // copy: builder buffers are reused
    return key;
  };
  const builders: TexMeshBuilder[] = [];
  for (let i = 0; i < NC * NT; i++) builders.push(new TexMeshBuilder({ uv: true, normal: true }));
  const bounds = builders.map(() => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
  const solidAABBs: number[] = [];
  const floorSpans: number[] = []; // [minX, minZ, maxX, maxZ, y] × N — near-horizontal faces for floor-height tracking

  for (const fo of visible) {
    if (fo.area < minArea) continue;
    const f = bsp.faces[fo.fi];
    const ti = bsp.texinfos[fo.ti];
    const texId = texIdOf.has(fo.tex) ? texIdOf.get(fo.tex)! : (texIdOf.get(fallback) ?? 0);
    const tex = texturesOut[texId];
    const ring = faceVertexIndices(bsp, f);
    const hv = ring.map((vi) => vertexAt(bsp, vi)); // Hammer (for UVs)
    const ev = hv.map(toEngine);
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < ev.length; i++) { const a = ev[i], b = ev[(i + 1) % ev.length]; nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]); }
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    let shade: number;
    if (f.lightofs >= 0 && f.lightofs + 3 <= bsp.lighting.length) {
      shade = 0.55 + 0.95 * (bsp.lighting[f.lightofs] + bsp.lighting[f.lightofs + 1] + bsp.lighting[f.lightofs + 2]) / (3 * 255);
    } else {
      shade = 0.68 + 0.5 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    }
    shade = Math.min(1.35, shade);
    const color = ((Math.min(255, ((tex.tint >> 16) & 255) * shade) | 0) << 16)
      | ((Math.min(255, ((tex.tint >> 8) & 255) * shade) | 0) << 8)
      | (Math.min(255, (tex.tint & 255) * shade) | 0);

    const s = slot(chunkIndex(ev[0][0], ev[0][2]), texId);
    const b = builders[s], bd = bounds[s];
    const idx: number[] = [];
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      const x = e[0] - cX, y = e[1], z = e[2] - cZ;
      if (x < bd.min[0]) bd.min[0] = x; if (y < bd.min[1]) bd.min[1] = y; if (z < bd.min[2]) bd.min[2] = z;
      if (x > bd.max[0]) bd.max[0] = x; if (y > bd.max[1]) bd.max[1] = y; if (z > bd.max[2]) bd.max[2] = z;
      const uv = uvAt(ti, hv[i], tex.width, tex.height);
      idx.push(b.vertex(x, y, z, color, uv[0], uv[1], nx, ny, nz));
    }
    for (let i = 1; i + 1 < idx.length; i++) b.tri(idx[0], idx[i], idx[i + 1]);

    if (Math.abs(ny) < 0.35) {
      let aMinX = Infinity, aMinZ = Infinity, aMaxX = -Infinity, aMaxZ = -Infinity, lo = Infinity, hi = -Infinity;
      for (const e of ev) { const x = e[0] - cX, z = e[2] - cZ; if (x < aMinX) aMinX = x; if (x > aMaxX) aMaxX = x; if (z < aMinZ) aMinZ = z; if (z > aMaxZ) aMaxZ = z; if (e[1] < lo) lo = e[1]; if (e[1] > hi) hi = e[1]; }
      if (hi - lo > 0.6 && solidAABBs.length < 4 * 600) solidAABBs.push(aMinX, aMinZ, aMaxX, aMaxZ);
    } else if (Math.abs(ny) > 0.5) {
      // Near-horizontal face -> a floor-height span (sign-agnostic; the runtime picks the
      // highest span at/below the player's head, so ceilings + lower levels are excluded).
      let fMinX = Infinity, fMinZ = Infinity, fMaxX = -Infinity, fMaxZ = -Infinity, sumY = 0;
      for (const e of ev) { const x = e[0] - cX, z = e[2] - cZ; if (x < fMinX) fMinX = x; if (x > fMaxX) fMaxX = x; if (z < fMinZ) fMinZ = z; if (z > fMaxZ) fMaxZ = z; sumY += e[1]; }
      if (floorSpans.length < 5 * 4000) floorSpans.push(fMinX, fMinZ, fMaxX, fMaxZ, sumY / ev.length);
    }
  }

  const meshesOut: MeshOut[] = [];
  let totalV = 0, totalT = 0, fmt = 0x000f, stride = 36;
  for (let ci = 0; ci < NC; ci++) {
    for (let tx = 0; tx < NT; tx++) {
      const s = slot(ci, tx);
      const mesh = builders[s].build();
      const vc = mesh.vertexCount;
      if (vc === 0) continue;
      if (vc > 65535) throw new Error(`chunk ${ci} tex ${tx} has ${vc} verts (>65535) — raise chunks`);
      fmt = mesh.format; stride = mesh.vertices.byteLength / vc;
      meshesOut.push({
        texId: tx, vertexCount: vc, triCount: mesh.indices.length / 3,
        // key by chunk×tex slot `s` (stable, independent of the later texId sort).
        vKey: addBlob(`${K}:m${s}.vertices`, DT_U8, new Uint8Array(mesh.vertices)),
        iKey: addBlob(`${K}:m${s}.indices`, DT_U16, mesh.indices),
        aabb: bounds[s],
      });
      totalV += vc; totalT += mesh.indices.length / 3;
    }
  }
  meshesOut.sort((a, b) => a.texId - b.texId);

  const meshLiteral = meshesOut.map((c) =>
    `  { texId: ${c.texId}, vertexCount: ${c.vertexCount}, triCount: ${c.triCount},\n` +
    `    aabb: { min: [${c.aabb.min.map(round).join(', ')}], max: [${c.aabb.max.map(round).join(', ')}] },\n` +
    `    vertices: dcU8('${c.vKey}'),\n    indices: dcU16('${c.iKey}') },`).join('\n');
  const texLiteral = texturesOut.map((t, j) =>
    `  { width: ${t.width}, height: ${t.height}, psm: 3, pixels: dcU8('${addBlob(`${K}:tex${j}`, DT_U8, t.pixels)}') },`).join('\n');
  const aabbF32 = new Float32Array(solidAABBs);
  const floorF32 = new Float32Array(floorSpans);
  // solidAABBs/floorSpans stay byte-views (bsp3d.js wraps them as Float32Array over .buffer),
  // so emit as dcU8 — byte-identical to the old unb64() form, no consumer change.
  const aabbKey = addBlob(`${K}:solidAABBs`, DT_U8, new Uint8Array(aabbF32.buffer));
  const floorKey = addBlob(`${K}:floorSpans`, DT_U8, new Uint8Array(floorF32.buffer));

  const ts = `// AUTO-GENERATED by framework/bake/bake-bsp.ts — DO NOT EDIT.
// Imported from a GoldSrc BSP v30 map: ${M.name}
// ${M.attribution}
//
// ${meshesOut.length} sub-meshes · ${totalV} verts · ${totalT} tris · ${texturesOut.length} textures (minArea ${round(minArea)} m²).
// Format ${fmt} (UV|COLOR|NORMAL|POS), stride ${stride}. texId indexes textures[];
// per-vertex COLOR carries a baked directional/lightmap shade (the GE modulates the
// texture over it; the vertex-colour software oracle uses it directly).
// Binary blobs (geometry, textures, collision) live in the .dcpak pack (see
// docs/dcpak-format.md); dcU8/dcU16 pull them as typed arrays by key — no base64.
import { dcU8, dcU16 } from './dcpak';
import type { BakedMesh } from './mesh';

export interface BspMesh extends BakedMesh { texId: number; }
interface RawMesh { texId: number; vertexCount: number; triCount: number; aabb: { min: number[]; max: number[] }; vertices: Uint8Array; indices: Uint16Array; }

const FORMAT = ${fmt};
const STRIDE = ${stride};
const RAW_MESHES: RawMesh[] = [
${meshLiteral}
];

function decode(c: RawMesh): BspMesh {
  return { texId: c.texId, format: FORMAT, stride: STRIDE, vertexCount: c.vertexCount, weightCount: 0,
    vertices: c.vertices, indices: c.indices, triCount: c.triCount,
    aabb: { min: [c.aabb.min[0], c.aabb.min[1], c.aabb.min[2]], max: [c.aabb.max[0], c.aabb.max[1], c.aabb.max[2]] } };
}

export const ${constName} = {
  name: ${JSON.stringify(M.name)},
  title: ${JSON.stringify(M.title)},
  attribution: ${JSON.stringify(M.attribution)},
  /** [x, z, heading] (XZ centred on the map) + floorY (engine-Y the player stands on). */
  spawn: [${round(spawn[0])}, ${round(spawn[1])}, ${round(spawn[2])}] as [number, number, number],
  floorY: ${round(floorY)},
  spawnY: ${round(spawnY)},
  span: ${round(span)},
  groundColor: 0x${M.ground.toString(16).padStart(6, '0')},
  skyColor: 0x${M.sky.toString(16).padStart(6, '0')},
  /** Wall collision rectangles [minX, minZ, maxX, maxZ] × N (XZ centred). */
  solidAABBs: dcU8('${aabbKey}'),
  /** Floor-height spans [minX, minZ, maxX, maxZ, y] × N (XZ centred) for stand-on-floor tracking. */
  floorSpans: dcU8('${floorKey}'),
  /** Per-miptex textures (PSM_8888, REPEAT); meshes index this by texId. */
  textures: [
${texLiteral}
  ],
  meshes(): BspMesh[] { return RAW_MESHES.map(decode); },
};
`;
  const bytes = store.reduce((n, b) => n + b.data.byteLength, 0);
  return { ts, store, bytes, meshesOut, totalV, totalT, walls: solidAABBs.length / 4, floors: floorSpans.length / 5 };
}

// Auto-decimate: raise the min-face-area threshold until the module fits the budget.
// The --full web tier has no budget (web has no PSP main-RAM/module limit) -> no decimation.
// Budget on the dcpak BLOB bytes (the .ts module is now tiny — just keys — so the pack
// is what occupies the EBOOT rodata / PSP RAM, replacing the old base64-source budget).
const BUDGET = FULL ? Infinity : 1.18 * 1024 * 1024;
let minArea = 0.1;
let out = emit(minArea);
let tries = 0;
while (out.bytes > BUDGET && tries < 16) {
  minArea *= 1.6; tries++;
  out = emit(minArea);
  console.log(`  decimate: minArea=${round(minArea)} m² -> ${(out.bytes / 1024 / 1024).toFixed(2)} MB pack`);
}
if (out.bytes > BUDGET) throw new Error(`could not fit ${ACTIVE} under ${(BUDGET / 1024 / 1024).toFixed(2)} MB pack (try more chunks / fewer textures)`);

writeFileSync(outDir + outName + '.ts', out.ts);

// Flush this map's blobs into the dcpak store. CC0 box -> the COMMITTED master store
// (assets.dcstore, alongside the gltf blobs); copyrighted maps -> a gitignored private
// store, so copyrighted bytes are structurally never committed. build.ts merges both
// stores before subsetting per game. Drop this namespace's prior blobs first (re-bake).
const storeName = M.committed ? 'assets.dcstore' : 'assets-private.dcstore';
const storePath = outDir + storeName;
const prior: Blob[] = existsSync(storePath)
  ? unpack(new Uint8Array(readFileSync(storePath))).filter((b) => !b.key.startsWith(`${K}:`))
  : [];
const merged = pack([...prior, ...out.store]);
writeFileSync(storePath, merged);

console.log(`[${ACTIVE}] wrote framework/src/${outName}.ts  (${(out.ts.length / 1024).toFixed(1)} KB module + ${(out.bytes / 1024).toFixed(1)} KB pack, ${out.meshesOut.length} sub-meshes, ${out.totalV} verts, ${out.totalT} tris, ${texturesOut.length} tex)`);
console.log(`  -> merged ${out.store.length} blob(s) into framework/src/${storeName} (${(merged.length / 1024).toFixed(1)} KB total)`);
console.log(`  spawn=[${round(spawn[0])}, ${round(spawn[1])}] floorY=${round(floorY)} span=${round(span)} walls=${out.walls} floors=${out.floors} minArea=${round(minArea)} m²${M.committed ? '' : '  (NOT committed — gitignore)'}`);
