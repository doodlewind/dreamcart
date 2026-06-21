// GoldSrc / Half-Life / Counter-Strike 1.6 BSP **version 30** parser. Pure (no I/O)
// so tests can import it directly; bake-bsp.ts turns its output into a DreamCart
// g3d scene module. Little-endian throughout; floats are IEEE-754 f32.
//
// A BSP v30 file is: int32 version (==30) + 15 lump directory entries
// {int32 fileofs; int32 filelen}, then the lump data. We only decode the lumps a
// renderer needs (vertices, edges, surfedges, faces, texinfo, planes, models,
// textures, lighting, entities); NODES/LEAVES/VISIBILITY/CLIPNODES/MARKSURFACES are
// left untouched (we draw models[0]'s faces directly, no BSP-tree/PVS traversal).
//
// Reference: Valve Developer Community "BSP file format (Half-Life)".

export const LUMP = {
  ENTITIES: 0, PLANES: 1, TEXTURES: 2, VERTEXES: 3, VISIBILITY: 4, NODES: 5,
  TEXINFO: 6, FACES: 7, LIGHTING: 8, CLIPNODES: 9, LEAVES: 10, MARKSURFACES: 11,
  EDGES: 12, SURFEDGES: 13, MODELS: 14,
} as const;

const TEX_SPECIAL = 1; // texinfo.flags bit: sky/trigger/scroll — no lightmap, skip in render

export interface BspLump { offset: number; length: number }
export interface BspPlane { normal: [number, number, number]; dist: number; type: number }
export interface BspFace {
  plane: number; side: number; firstedge: number; numedges: number;
  texinfo: number; styles: number[]; lightofs: number;
}
export interface BspTexinfo {
  s: [number, number, number, number]; t: [number, number, number, number];
  miptex: number; flags: number;
}
export interface BspModel {
  mins: [number, number, number]; maxs: [number, number, number];
  origin: [number, number, number]; headnode: number[]; visleafs: number;
  firstface: number; numfaces: number;
}
export interface BspTexture {
  name: string; width: number; height: number;
  embedded: boolean; masked: boolean;
  /** Decoded mip0 RGBA8888 (width*height*4) when embedded; null for WAD-referenced. */
  pixels: Uint8Array | null;
}

export interface Bsp {
  version: number;
  lumps: BspLump[];
  vertices: Float32Array; // x,y,z triples (Hammer units, Z-up)
  edges: Uint16Array; // v0,v1 pairs
  surfedges: Int32Array; // signed: <0 means use the edge reversed
  faces: BspFace[];
  texinfos: BspTexinfo[];
  planes: BspPlane[];
  models: BspModel[];
  textures: BspTexture[];
  lighting: Uint8Array; // raw RGB888 lightmap data; index with face.lightofs
  entities: Record<string, string>[];
  isSpecial(face: BspFace): boolean;
}

/** Decode one embedded miptex's mip0 into RGBA8888. `masked` => palette index 255 is transparent. */
function decodeMiptex(
  view: DataView, base: number, w: number, h: number, off0: number, off3: number, masked: boolean,
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  // Palette sits after the 4 mip levels: at off3 + (w/8)*(h/8), a u16 count then 256*RGB.
  const palOff = base + off3 + (w >> 3) * (h >> 3) + 2;
  const px = base + off0;
  for (let i = 0; i < w * h; i++) {
    const idx = view.getUint8(px + i);
    const o = i * 4;
    if (masked && idx === 255) {
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; // transparent (zero RGB avoids fringe)
    } else {
      const p = palOff + idx * 3;
      out[o] = view.getUint8(p);
      out[o + 1] = view.getUint8(p + 1);
      out[o + 2] = view.getUint8(p + 2);
      out[o + 3] = 255;
    }
  }
  return out;
}

function readName(view: DataView, off: number): string {
  let s = '';
  for (let i = 0; i < 16; i++) {
    const c = view.getUint8(off + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Parse the ASCII entities lump into an array of flat key/value blocks. */
function parseEntities(view: DataView, off: number, len: number): Record<string, string>[] {
  let text = '';
  for (let i = 0; i < len; i++) {
    const c = view.getUint8(off + i);
    if (c === 0) break;
    text += String.fromCharCode(c);
  }
  const blocks: Record<string, string>[] = [];
  const re = /\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const ent: Record<string, string> = {};
    const kv = /"([^"]*)"\s*"([^"]*)"/g;
    let p: RegExpExecArray | null;
    while ((p = kv.exec(m[1])) !== null) ent[p[1]] = p[2];
    blocks.push(ent);
  }
  return blocks;
}

export function parseBsp(buffer: ArrayBuffer): Bsp {
  const view = new DataView(buffer);
  const version = view.getInt32(0, true);
  const lumps: BspLump[] = [];
  for (let i = 0; i < 15; i++) {
    lumps.push({ offset: view.getInt32(4 + i * 8, true), length: view.getInt32(8 + i * 8, true) });
  }

  const lump = (id: number) => lumps[id];

  // VERTEXES (12 B): 3 f32
  const vL = lump(LUMP.VERTEXES);
  const vertices = new Float32Array(vL.length / 12 * 3);
  for (let i = 0; i < vertices.length; i++) vertices[i] = view.getFloat32(vL.offset + i * 4, true);

  // EDGES (4 B): 2 u16
  const eL = lump(LUMP.EDGES);
  const edges = new Uint16Array(eL.length / 2);
  for (let i = 0; i < edges.length; i++) edges[i] = view.getUint16(eL.offset + i * 2, true);

  // SURFEDGES (4 B): signed i32
  const sL = lump(LUMP.SURFEDGES);
  const surfedges = new Int32Array(sL.length / 4);
  for (let i = 0; i < surfedges.length; i++) surfedges[i] = view.getInt32(sL.offset + i * 4, true);

  // FACES (20 B)
  const fL = lump(LUMP.FACES);
  const faces: BspFace[] = [];
  for (let o = fL.offset; o < fL.offset + fL.length; o += 20) {
    faces.push({
      plane: view.getUint16(o, true),
      side: view.getUint16(o + 2, true),
      firstedge: view.getInt32(o + 4, true),
      numedges: view.getUint16(o + 8, true),
      texinfo: view.getUint16(o + 10, true),
      styles: [view.getUint8(o + 12), view.getUint8(o + 13), view.getUint8(o + 14), view.getUint8(o + 15)],
      lightofs: view.getInt32(o + 16, true),
    });
  }

  // TEXINFO (40 B)
  const tiL = lump(LUMP.TEXINFO);
  const texinfos: BspTexinfo[] = [];
  for (let o = tiL.offset; o < tiL.offset + tiL.length; o += 40) {
    texinfos.push({
      s: [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true), view.getFloat32(o + 12, true)],
      t: [view.getFloat32(o + 16, true), view.getFloat32(o + 20, true), view.getFloat32(o + 24, true), view.getFloat32(o + 28, true)],
      miptex: view.getUint32(o + 32, true),
      flags: view.getUint32(o + 36, true),
    });
  }

  // PLANES (20 B)
  const pL = lump(LUMP.PLANES);
  const planes: BspPlane[] = [];
  for (let o = pL.offset; o < pL.offset + pL.length; o += 20) {
    planes.push({
      normal: [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)],
      dist: view.getFloat32(o + 12, true),
      type: view.getInt32(o + 16, true),
    });
  }

  // MODELS (64 B)
  const mL = lump(LUMP.MODELS);
  const models: BspModel[] = [];
  for (let o = mL.offset; o < mL.offset + mL.length; o += 64) {
    models.push({
      mins: [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)],
      maxs: [view.getFloat32(o + 12, true), view.getFloat32(o + 16, true), view.getFloat32(o + 20, true)],
      origin: [view.getFloat32(o + 24, true), view.getFloat32(o + 28, true), view.getFloat32(o + 32, true)],
      headnode: [view.getInt32(o + 36, true), view.getInt32(o + 40, true), view.getInt32(o + 44, true), view.getInt32(o + 48, true)],
      visleafs: view.getInt32(o + 52, true),
      firstface: view.getInt32(o + 56, true),
      numfaces: view.getInt32(o + 60, true),
    });
  }

  // TEXTURES: u32 nummiptex, i32 dataoffset[] (relative to lump start), then MIPTEX entries.
  const txL = lump(LUMP.TEXTURES);
  const textures: BspTexture[] = [];
  if (txL.length >= 4) {
    const nummiptex = view.getUint32(txL.offset, true);
    for (let i = 0; i < nummiptex; i++) {
      const rel = view.getInt32(txL.offset + 4 + i * 4, true);
      if (rel < 0) { textures.push({ name: '', width: 0, height: 0, embedded: false, masked: false, pixels: null }); continue; }
      const base = txL.offset + rel;
      const name = readName(view, base);
      const width = view.getUint32(base + 16, true);
      const height = view.getUint32(base + 20, true);
      const off0 = view.getUint32(base + 24, true);
      const off3 = view.getUint32(base + 36, true);
      const masked = name.charCodeAt(0) === 123; // '{'
      const embedded = off0 !== 0 && width > 0 && height > 0;
      const pixels = embedded ? decodeMiptex(view, base, width, height, off0, off3, masked) : null;
      textures.push({ name, width, height, embedded, masked, pixels });
    }
  }

  // LIGHTING (raw RGB888)
  const lgL = lump(LUMP.LIGHTING);
  const lighting = new Uint8Array(buffer, lgL.offset, lgL.length);

  const entities = parseEntities(view, lump(LUMP.ENTITIES).offset, lump(LUMP.ENTITIES).length);

  return {
    version, lumps, vertices, edges, surfedges, faces, texinfos, planes, models,
    textures, lighting, entities,
    isSpecial(face: BspFace): boolean {
      const ti = texinfos[face.texinfo];
      return ti ? (ti.flags & TEX_SPECIAL) !== 0 : false;
    },
  };
}

/**
 * Parse a WAD3 texture archive (halflife.wad, cstrike de_*.wad …) into a
 * name→texture map (lower-cased names). Classic CS maps reference most of their
 * textures from WADs instead of embedding them; `resolveWadTextures` below fills a
 * parsed BSP's WAD-referenced (pixels===null) textures from these.
 *
 * WAD3: char magic[4]='WAD3', i32 numEntries, i32 dirOffset; dir entry (32 B):
 * i32 offset, i32 diskSize, i32 size, u8 type (0x43=miptex), u8 compression,
 * u8 pad[2], char name[16]. A miptex entry holds the same MIPTEX layout as embedded.
 */
export function parseWad(buffer: ArrayBuffer): Map<string, BspTexture> {
  const view = new DataView(buffer);
  const out = new Map<string, BspTexture>();
  if (buffer.byteLength < 12) return out;
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'WAD3') return out;
  const numEntries = view.getInt32(4, true);
  const dirOffset = view.getInt32(8, true);
  for (let i = 0; i < numEntries; i++) {
    const e = dirOffset + i * 32;
    if (e + 32 > buffer.byteLength) break;
    const offset = view.getInt32(e, true);
    const type = view.getUint8(e + 12);
    const compression = view.getUint8(e + 13);
    const name = readName(view, e + 16).toLowerCase();
    if (type !== 0x43 || compression !== 0 || offset <= 0 || offset + 40 > buffer.byteLength) continue; // miptex, uncompressed
    const width = view.getUint32(offset + 16, true);
    const height = view.getUint32(offset + 20, true);
    const off0 = view.getUint32(offset + 24, true);
    const off3 = view.getUint32(offset + 36, true);
    if (!width || !height || !off0) continue;
    const masked = name.charCodeAt(0) === 123; // '{'
    out.set(name, { name, width, height, embedded: true, masked, pixels: decodeMiptex(view, offset, width, height, off0, off3, masked) });
  }
  return out;
}

/**
 * Fill a parsed BSP's WAD-referenced textures (pixels===null) from one or more
 * parsed WADs (later WADs win on name clash, like the engine's wad search order).
 * Returns how many were resolved.
 */
export function resolveWadTextures(bsp: Bsp, wads: Map<string, BspTexture>[]): number {
  let resolved = 0;
  for (const t of bsp.textures) {
    if (t.pixels || !t.name) continue;
    const key = t.name.toLowerCase();
    for (let i = wads.length - 1; i >= 0; i--) {
      const w = wads[i].get(key);
      if (w && w.pixels) { t.width = w.width; t.height = w.height; t.embedded = true; t.masked = w.masked; t.pixels = w.pixels; resolved++; break; }
    }
  }
  return resolved;
}

/** WAD names a map asks for (worldspawn "wad" key: ';'-separated paths). */
export function wadNames(bsp: Bsp): string[] {
  const ws = bsp.entities.find((e) => e.classname === 'worldspawn');
  if (!ws || !ws.wad) return [];
  return ws.wad.split(';').map((p) => (p.split(/[\\/]/).pop() || '').toLowerCase()).filter((n) => n.endsWith('.wad'));
}

/**
 * Ordered vertex indices of a face's polygon, walking its surfedges (signed):
 * se>=0 → EDGES[se].v0, se<0 → EDGES[-se].v1. The result is a convex CCW ring.
 */
export function faceVertexIndices(bsp: Bsp, face: BspFace): number[] {
  const out: number[] = [];
  for (let i = 0; i < face.numedges; i++) {
    const se = bsp.surfedges[face.firstedge + i];
    out.push(se >= 0 ? bsp.edges[se * 2] : bsp.edges[-se * 2 + 1]);
  }
  return out;
}

/** Hammer-space (Z-up, unconverted) position of vertex `vi` — UVs must use THIS. */
export function vertexAt(bsp: Bsp, vi: number): [number, number, number] {
  return [bsp.vertices[vi * 3], bsp.vertices[vi * 3 + 1], bsp.vertices[vi * 3 + 2]];
}

/** Planar UV for a Hammer-space vertex via its texinfo + the texture's size. */
export function uvAt(ti: BspTexinfo, v: [number, number, number], texW: number, texH: number): [number, number] {
  const u = (v[0] * ti.s[0] + v[1] * ti.s[1] + v[2] * ti.s[2] + ti.s[3]) / (texW || 16);
  const w = (v[0] * ti.t[0] + v[1] * ti.t[1] + v[2] * ti.t[2] + ti.t[3]) / (texH || 16);
  return [u, w];
}
