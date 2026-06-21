// CC0 procedural GoldSrc BSP v30 emitter. Writes the raw 15-lump binary that bsp.ts
// parses and bake-bsp.ts consumes — directly, with NO external compiler. Both the parser
// and the baker walk models[0] faces only and ignore the BSP tree/PVS (bsp.ts:6-9), so a
// hand-emitted file with empty NODES/LEAVES/VISIBILITY/CLIPNODES/MARKSURFACES lumps is fully
// sufficient. Generalized from make-box-bsp.ts: callers add textures + convex polygons (or
// boxes as sugar) and the builder dedupes verts/edges, builds signed surfedges, derives
// PLANES, and emits the same lump layout. Everything emitted here is original — safe to
// commit as CC0 test fixtures (unlike fetched Valve/CS maps).
import { writeFileSync } from 'fs';

const LUMPS = 15;
const HEADER = 4 + LUMPS * 8;
export type V3 = [number, number, number];

/** A procedural embedded texture: a w×h indexed image + a 256-entry RGB palette. */
export interface GenTex {
  name: string;           // <= 15 chars (name[16], NUL-padded)
  w: number;              // power-of-two
  h: number;
  palette: V3[];          // up to 256 RGB entries; rest zero-filled
  pixel: (x: number, y: number) => number; // -> palette index for mip0
}

/** Checker texture (8-texel cells) of palette indices 1/2 over a dark index-0, matching the
 *  committed box fixture's GROUNDTEX look. `colors` = [dark, light, accent]. */
export function checkerTex(name: string, w = 64, h = 64, colors: [V3, V3, V3] = [[40, 40, 50], [168, 172, 180], [74, 104, 150]]): GenTex {
  return { name, w, h, palette: colors, pixel: (x, y) => (((x >> 3) + (y >> 3)) & 1) ? 2 : 1 };
}

function buildMiptex(t: GenTex): Buffer {
  const { w, h } = t;
  const mipBytes = w * h + (w / 2) * (h / 2) + (w / 4) * (h / 4) + (w / 8) * (h / 8);
  const buf = Buffer.alloc(40 + mipBytes + 2 + 256 * 3);
  buf.write(t.name.slice(0, 15), 0, 'ascii'); // name[16], NUL-padded by alloc
  buf.writeUInt32LE(w, 16);
  buf.writeUInt32LE(h, 20);
  const off0 = 40;
  const off1 = off0 + w * h;
  const off2 = off1 + (w / 2) * (h / 2);
  const off3 = off2 + (w / 4) * (h / 4);
  buf.writeUInt32LE(off0, 24);
  buf.writeUInt32LE(off1, 28);
  buf.writeUInt32LE(off2, 32);
  buf.writeUInt32LE(off3, 36);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) buf[off0 + y * w + x] = t.pixel(x, y) & 255;
  // coarser mips left flat (the parser only decodes mip0); palette right after mip3.
  const palCountOff = off3 + (w / 8) * (h / 8);
  buf.writeUInt16LE(256, palCountOff);
  const pal = palCountOff + 2;
  for (let i = 0; i < Math.min(256, t.palette.length); i++) {
    buf[pal + i * 3] = t.palette[i][0] & 255;
    buf[pal + i * 3 + 1] = t.palette[i][1] & 255;
    buf[pal + i * 3 + 2] = t.palette[i][2] & 255;
  }
  return buf;
}

export class BspBuilder {
  private verts: V3[] = [];
  private vKey = new Map<string, number>();
  private edges: [number, number][] = [[0, 0]]; // index 0 = sentinel (matches box.bsp)
  private eKey = new Map<string, number>();
  private surfedges: number[] = [];
  private planes: { n: V3; d: number; type: number }[] = [];
  private texinfos: { s: number[]; t: number[]; tex: number }[] = [];
  private faces: { plane: number; first: number; count: number; ti: number }[] = [];
  private texes: GenTex[] = [];
  private ents: string[] = [];

  addTexture(t: GenTex): number { this.texes.push(t); return this.texes.length - 1; }
  entity(kv: Record<string, string>): void {
    this.ents.push('{\n' + Object.entries(kv).map(([k, v]) => `"${k}" "${v}"`).join('\n') + '\n}\n');
  }

  private vi(p: V3): number {
    const k = `${p[0]},${p[1]},${p[2]}`;
    let i = this.vKey.get(k);
    if (i === undefined) { i = this.verts.length; this.verts.push(p); this.vKey.set(k, i); }
    return i;
  }
  private ei(a: number, b: number): number { // signed surfedge (forward if a<b)
    const fwd = a < b;
    const key = fwd ? `${a}_${b}` : `${b}_${a}`;
    let e = this.eKey.get(key);
    if (e === undefined) { e = this.edges.length; this.edges.push(fwd ? [a, b] : [b, a]); this.eKey.set(key, e); }
    return fwd ? e : -e;
  }

  /** One convex polygon, CCW as seen from the side `normal` points toward. `axis` picks the
   *  planar UV projection (dominant axis); `scale` = texels/unit. */
  quad(ring: V3[], normal: V3, tex: number, axis: 'x' | 'y' | 'z', scale = 1): void {
    const idx = ring.map((p) => this.vi(p));
    const first = this.surfedges.length;
    for (let i = 0; i < idx.length; i++) this.surfedges.push(this.ei(idx[i], idx[(i + 1) % idx.length]));
    const p0 = ring[0];
    const d = normal[0] * p0[0] + normal[1] * p0[1] + normal[2] * p0[2];
    const type = normal[2] !== 0 ? 2 : normal[1] !== 0 ? 1 : 0;
    const plane = this.planes.length;
    this.planes.push({ n: normal, d, type });
    const proj = axis === 'z' ? { s: [scale, 0, 0, 0], t: [0, scale, 0, 0] }
      : axis === 'y' ? { s: [scale, 0, 0, 0], t: [0, 0, scale, 0] }
        : { s: [0, scale, 0, 0], t: [0, 0, scale, 0] };
    const ti = this.texinfos.length;
    this.texinfos.push({ ...proj, tex });
    this.faces.push({ plane, first, count: ring.length, ti });
  }

  /** Convex polygon with normal + projection axis auto-computed from its CCW winding (for
   *  slanted/arbitrary faces). The normal faces the side the winding is CCW as seen from. */
  polygon(ring: V3[], tex: number, scale = 1): void {
    const a = ring[0], b = ring[1], c = ring[2];
    const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const m = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / m, n[1] / m, n[2] / m];
    const ax: 'x' | 'y' | 'z' = (Math.abs(n[2]) >= Math.abs(n[0]) && Math.abs(n[2]) >= Math.abs(n[1])) ? 'z'
      : (Math.abs(n[1]) >= Math.abs(n[0])) ? 'y' : 'x';
    this.quad(ring, n, tex, ax, scale);
  }

  /** Axis-aligned box. `inward` => a closed room (normals point in, like box.bsp); otherwise
   *  a solid prop with outward-facing normals. */
  box(mn: V3, mx: V3, tex: number, inward = false, scale = 1): void {
    const c: V3[] = [
      [mn[0], mn[1], mn[2]], [mx[0], mn[1], mn[2]], [mx[0], mx[1], mn[2]], [mn[0], mx[1], mn[2]],
      [mn[0], mn[1], mx[2]], [mx[0], mn[1], mx[2]], [mx[0], mx[1], mx[2]], [mn[0], mx[1], mx[2]],
    ];
    const s = inward ? -1 : 1;
    const face = (r: number[], n: V3, ax: 'x' | 'y' | 'z') => {
      const ring = r.map((i) => c[i]);
      const nn: V3 = [n[0] * s, n[1] * s, n[2] * s];
      // when inward, reverse winding so CCW still matches the inward normal.
      this.quad(s < 0 ? [...ring].reverse() : ring, nn, tex, ax, scale);
    };
    face([0, 1, 2, 3], [0, 0, -1], 'z'); face([4, 5, 6, 7], [0, 0, 1], 'z'); // bottom / top
    face([0, 1, 5, 4], [0, -1, 0], 'y'); face([3, 2, 6, 7], [0, 1, 0], 'y'); // -Y / +Y
    face([0, 3, 7, 4], [-1, 0, 0], 'x'); face([1, 2, 6, 5], [1, 0, 0], 'x'); // -X / +X
  }

  /** Assemble + write the v30 .bsp. Returns the byte length. */
  write(path: string): number {
    const lumpData: (Buffer | null)[] = new Array(LUMPS).fill(null);

    // L0 ENTITIES
    lumpData[0] = Buffer.from(this.ents.join('') + '\0', 'ascii');

    // L1 PLANES (20 B)
    {
      const b = Buffer.alloc(this.planes.length * 20);
      this.planes.forEach((p, i) => {
        const o = i * 20;
        b.writeFloatLE(p.n[0], o); b.writeFloatLE(p.n[1], o + 4); b.writeFloatLE(p.n[2], o + 8);
        b.writeFloatLE(p.d, o + 12);
        b.writeInt32LE(p.type, o + 16);
      });
      lumpData[1] = b;
    }

    // L2 TEXTURES: u32 nummiptex + i32 offsets[] (relative to lump start) + miptex blocks.
    {
      const mips = this.texes.map(buildMiptex);
      const n = mips.length;
      const dirBytes = 4 + n * 4;
      const b = Buffer.alloc(dirBytes + mips.reduce((s, m) => s + m.length, 0));
      b.writeUInt32LE(n, 0);
      let ofs = dirBytes;
      mips.forEach((m, i) => { b.writeInt32LE(ofs, 4 + i * 4); m.copy(b, ofs); ofs += m.length; });
      lumpData[2] = b;
    }

    // L3 VERTEXES (12 B)
    {
      const b = Buffer.alloc(this.verts.length * 12);
      this.verts.forEach((v, i) => { b.writeFloatLE(v[0], i * 12); b.writeFloatLE(v[1], i * 12 + 4); b.writeFloatLE(v[2], i * 12 + 8); });
      lumpData[3] = b;
    }

    lumpData[4] = Buffer.alloc(0); // VISIBILITY
    lumpData[5] = Buffer.alloc(0); // NODES

    // L6 TEXINFO (40 B)
    {
      const b = Buffer.alloc(this.texinfos.length * 40);
      this.texinfos.forEach((ti, i) => {
        const o = i * 40;
        for (let k = 0; k < 4; k++) b.writeFloatLE(ti.s[k], o + k * 4);
        for (let k = 0; k < 4; k++) b.writeFloatLE(ti.t[k], o + 16 + k * 4);
        b.writeUInt32LE(ti.tex, o + 32);
        b.writeUInt32LE(0, o + 36); // flags
      });
      lumpData[6] = b;
    }

    // L7 FACES (20 B)
    {
      const b = Buffer.alloc(this.faces.length * 20);
      this.faces.forEach((f, i) => {
        const o = i * 20;
        b.writeUInt16LE(f.plane, o);
        b.writeUInt16LE(0, o + 2); // side
        b.writeInt32LE(f.first, o + 4);
        b.writeUInt16LE(f.count, o + 8);
        b.writeUInt16LE(f.ti, o + 10);
        b.writeUInt8(0, o + 12); b.writeUInt8(255, o + 13); b.writeUInt8(255, o + 14); b.writeUInt8(255, o + 15); // styles
        b.writeInt32LE(-1, o + 16); // lightofs: none (directional shade at bake)
      });
      lumpData[7] = b;
    }

    lumpData[8] = Buffer.alloc(0); // LIGHTING
    lumpData[9] = Buffer.alloc(0); // CLIPNODES
    lumpData[10] = Buffer.alloc(0); // LEAVES
    lumpData[11] = Buffer.alloc(0); // MARKSURFACES

    // L12 EDGES (4 B)
    {
      const b = Buffer.alloc(this.edges.length * 4);
      this.edges.forEach((e, i) => { b.writeUInt16LE(e[0], i * 4); b.writeUInt16LE(e[1], i * 4 + 2); });
      lumpData[12] = b;
    }

    // L13 SURFEDGES (4 B, signed)
    {
      const b = Buffer.alloc(this.surfedges.length * 4);
      this.surfedges.forEach((s, i) => b.writeInt32LE(s, i * 4));
      lumpData[13] = b;
    }

    // L14 MODELS (64 B) — models[0] = worldspawn covering ALL faces.
    {
      const mn: V3 = [Infinity, Infinity, Infinity], mx: V3 = [-Infinity, -Infinity, -Infinity];
      for (const v of this.verts) for (let k = 0; k < 3; k++) { if (v[k] < mn[k]) mn[k] = v[k]; if (v[k] > mx[k]) mx[k] = v[k]; }
      const b = Buffer.alloc(64);
      for (let k = 0; k < 3; k++) b.writeFloatLE(mn[k], k * 4);
      for (let k = 0; k < 3; k++) b.writeFloatLE(mx[k], 12 + k * 4);
      for (let k = 0; k < 3; k++) b.writeFloatLE(0, 24 + k * 4); // origin
      for (let k = 0; k < 4; k++) b.writeInt32LE(k === 0 ? 0 : -1, 36 + k * 4); // headnode
      b.writeInt32LE(0, 52); // visleafs
      b.writeInt32LE(0, 56); // firstface
      b.writeInt32LE(this.faces.length, 60); // numfaces
      lumpData[14] = b;
    }

    // header + 4-byte-aligned lumps
    let cursor = HEADER;
    const dir: { ofs: number; len: number }[] = [];
    const parts: Buffer[] = [];
    for (let i = 0; i < LUMPS; i++) {
      const d = lumpData[i]!;
      dir.push({ ofs: cursor, len: d.length });
      parts.push(d);
      cursor += d.length;
      const padN = (4 - (cursor % 4)) % 4;
      if (padN) { parts.push(Buffer.alloc(padN)); cursor += padN; }
    }
    const header = Buffer.alloc(HEADER);
    header.writeInt32LE(30, 0);
    dir.forEach((e, i) => { header.writeInt32LE(e.ofs, 4 + i * 8); header.writeInt32LE(e.len, 8 + i * 8); });
    const out = Buffer.concat([header, ...parts]);
    writeFileSync(path, out);
    return out.length;
  }

  stats() { return { verts: this.verts.length, faces: this.faces.length, textures: this.texes.length }; }
}
