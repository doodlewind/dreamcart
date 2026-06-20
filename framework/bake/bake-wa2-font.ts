// Bakes a Japanese glyph atlas SUBSET — exactly the codepoints used by the WA2
// prologue script (framework/src/wa2-script.ts) — into framework/src/wa2-font.ts.
//
// Two slots: BASE (full size, all chars) and RUBY (small, kana-heavy readings).
// Each glyph is a fixed-cell 1-bit row-bitmask (MSB = leftmost pixel), so the
// native rasterizer (gfx.vnDrawGlyphs) can index a glyph by id and emit its
// pixel runs as one batched sprite draw. glyphId 0 is a reserved BLANK cell.
//
// Outline source: opentype.js + a small scanline rasterizer. Default font is
// Hiragino (a macOS .ttc) for local proving-out — NOTE: Hiragino is Apple/SCREEN
// licensed and NOT redistributable; to ship, set WA2_FONT to a libre OFL font
// (Noto Sans JP / Source Han Sans / BIZ UDGothic, single-face .otf) and re-bake.
// Run: bun framework/bake/bake-wa2-font.ts
import { readFileSync } from "node:fs";
import opentype from "opentype.js";
import { WA2_BASE_CHARS, WA2_RUBY_CHARS } from "../src/wa2-script";

const FONT = process.env.WA2_FONT ?? "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc";
const FACE = Number(process.env.WA2_FONT_FACE ?? 0);
const BASE_PX = Number(process.env.WA2_BASE_PX ?? 18);
const RUBY_PX = Number(process.env.WA2_RUBY_PX ?? 13);
const OUT = new URL("../src/wa2-font.ts", import.meta.url).pathname;

// --- .ttc -> standalone sfnt (opentype.js@2 rejects 'ttcf' collections) ------
function extractSfntFromTtc(ab: ArrayBuffer, index: number): ArrayBuffer {
  const dv = new DataView(ab);
  const numFonts = dv.getUint32(8);
  if (index >= numFonts) throw new Error(`face ${index} >= ${numFonts}`);
  const faceOff = dv.getUint32(12 + index * 4);
  const sfntVersion = dv.getUint32(faceOff);
  const numTables = dv.getUint16(faceOff + 4);
  const tables: { tag: string; off: number; len: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const rec = faceOff + 12 + i * 16;
    const tag = String.fromCharCode(dv.getUint8(rec), dv.getUint8(rec + 1), dv.getUint8(rec + 2), dv.getUint8(rec + 3));
    tables.push({ tag, off: dv.getUint32(rec + 8), len: dv.getUint32(rec + 12) });
  }
  const pad4 = (n: number) => (n + 3) & ~3;
  const headerSize = 12 + 16 * numTables;
  let dataSize = 0;
  for (const t of tables) dataSize += pad4(t.len);
  const out = new Uint8Array(headerSize + dataSize);
  const odv = new DataView(out.buffer);
  let maxPow = 1, exp = 0;
  while (maxPow * 2 <= numTables) { maxPow *= 2; exp++; }
  odv.setUint32(0, sfntVersion);
  odv.setUint16(4, numTables);
  odv.setUint16(6, maxPow * 16);
  odv.setUint16(8, exp);
  odv.setUint16(10, numTables * 16 - maxPow * 16);
  let cur = headerSize;
  const src = new Uint8Array(ab);
  tables.forEach((t, i) => {
    const rec = 12 + i * 16;
    for (let c = 0; c < 4; c++) odv.setUint8(rec + c, t.tag.charCodeAt(c));
    odv.setUint32(rec + 4, 0);
    odv.setUint32(rec + 8, cur);
    odv.setUint32(rec + 12, t.len);
    out.set(src.subarray(t.off, t.off + t.len), cur);
    cur += pad4(t.len);
  });
  return out.buffer;
}

function loadFace(path: string, index: number): opentype.Font {
  const buf = readFileSync(path);
  let ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const tag = String.fromCharCode(...new Uint8Array(ab, 0, 4));
  if (tag === "ttcf") ab = extractSfntFromTtc(ab, index);
  return (opentype as unknown as { parse(b: ArrayBuffer): opentype.Font }).parse(ab);
}

// --- glyph outline -> flattened closed contours at px -----------------------
function glyphContours(font: opentype.Font, ch: string, px: number) {
  const glyph = font.charToGlyph(ch);
  const path = glyph.getPath(0, 0, px); // baseline at y=0, y increases downward
  const contours: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  let cx = 0, cy = 0;
  const N = 8;
  for (const c of path.commands) {
    if (c.type === "M") { if (cur.length) contours.push(cur); cur = [{ x: c.x, y: c.y }]; cx = c.x; cy = c.y; }
    else if (c.type === "L") { cur.push({ x: c.x, y: c.y }); cx = c.x; cy = c.y; }
    else if (c.type === "Q") {
      for (let i = 1; i <= N; i++) { const t = i / N, m = 1 - t; cur.push({ x: m * m * cx + 2 * m * t * c.x1 + t * t * c.x, y: m * m * cy + 2 * m * t * c.y1 + t * t * c.y }); }
      cx = c.x; cy = c.y;
    } else if (c.type === "C") {
      for (let i = 1; i <= N; i++) { const t = i / N, m = 1 - t; cur.push({ x: m * m * m * cx + 3 * m * m * t * c.x1 + 3 * m * t * t * c.x2 + t * t * t * c.x, y: m * m * m * cy + 3 * m * m * t * c.y1 + 3 * m * t * t * c.y2 + t * t * t * c.y }); }
      cx = c.x; cy = c.y;
    } else if (c.type === "Z") { if (cur.length) { contours.push(cur); cur = []; } }
  }
  if (cur.length) contours.push(cur);
  return contours;
}

// scanline even-odd fill, ssxss supersample -> coverage [0..1]
function rasterize(contours: { x: number; y: number }[][], W: number, H: number, oy: number, ss = 3): Float32Array {
  const cov = new Float32Array(W * H);
  const sw = W * ss, sh = H * ss;
  const hit = new Uint8Array(sw * sh);
  for (let sy = 0; sy < sh; sy++) {
    const py = (sy + 0.5) / ss + oy;
    const xs: number[] = [];
    for (const poly of contours)
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if (a.y === b.y) continue;
        if ((py >= a.y && py < b.y) || (py >= b.y && py < a.y)) { const t = (py - a.y) / (b.y - a.y); xs.push(a.x + t * (b.x - a.x)); }
      }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const lo = Math.max(0, Math.ceil(xs[k] * ss - 0.5));
      const hi = Math.min(sw - 1, Math.floor(xs[k + 1] * ss - 0.5));
      for (let x = lo; x <= hi; x++) hit[sy * sw + x] = 1;
    }
  }
  const inv = 1 / (ss * ss);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let dy = 0; dy < ss; dy++) for (let dx = 0; dx < ss; dx++) s += hit[(y * ss + dy) * sw + (x * ss + dx)];
      cov[y * W + x] = s * inv;
    }
  return cov;
}

interface Slot {
  cellW: number;
  cellH: number;
  bpr: number;
  ascent: number;
  blob: Uint8Array;
  codes: string;
}

function bakeSlot(font: opentype.Font, chars: string, px: number): Slot {
  const upm = font.unitsPerEm;
  const ascent = (font.ascender / upm) * px;
  const descent = (font.descender / upm) * px; // negative
  const cellW = px; // full-width CJK advance == 1em == px
  const cellH = Math.ceil(ascent - descent);
  const bpr = (cellW + 7) >> 3;
  const stride = bpr * cellH;
  const list = [...chars];
  const blob = new Uint8Array((list.length + 1) * stride); // cell 0 = blank
  list.forEach((ch, k) => {
    const cov = rasterize(glyphContours(font, ch, px), cellW, cellH, -ascent, 3);
    const base = (k + 1) * stride;
    for (let y = 0; y < cellH; y++)
      for (let x = 0; x < cellW; x++)
        if (cov[y * cellW + x] >= 0.5) blob[base + y * bpr + (x >> 3)] |= 0x80 >> (x & 7);
  });
  return { cellW, cellH, bpr, ascent: Math.round(ascent), blob, codes: chars };
}

function preview(slot: Slot, ch: string): string {
  const id = [...slot.codes].indexOf(ch) + 1;
  if (id <= 0) return `(${ch} not in slot)`;
  const { cellW, cellH, bpr } = slot;
  const base = id * bpr * cellH;
  let s = "";
  for (let y = 0; y < cellH; y++) {
    let l = "";
    for (let x = 0; x < cellW; x++) l += slot.blob[base + y * bpr + (x >> 3)] & (0x80 >> (x & 7)) ? "#" : ".";
    s += l + "\n";
  }
  return s;
}

// --- Drive -----------------------------------------------------------------
const font = loadFace(FONT, FACE);
console.log(`bake-wa2-font: ${FONT} (face ${FACE}), upm=${font.unitsPerEm}`);

const base = bakeSlot(font, WA2_BASE_CHARS, BASE_PX);
const ruby = bakeSlot(font, WA2_RUBY_CHARS, RUBY_PX);

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const slotLit = (s: Slot) =>
  `{ cellW: ${s.cellW}, cellH: ${s.cellH}, bpr: ${s.bpr}, ascent: ${s.ascent}, count: ${[...s.codes].length + 1}, codes: ${JSON.stringify(s.codes)}, b64: ${JSON.stringify(b64(s.blob))} }`;

const out = `// AUTO-GENERATED by framework/bake/bake-wa2-font.ts — do not edit by hand.
// Japanese glyph atlas subset for the WA2 prologue. Two slots (base + ruby).
// Each slot: fixed cellW×cellH 1-bit cells (MSB=left), \`count\` cells incl. a
// reserved BLANK cell 0; \`codes\`[k] maps to glyph id k+1. \`b64\` is the packed
// cell blob (count×bpr×cellH bytes). Decode with unb64() and upload via
// gfx.vnUploadFont(slot, rows, count, cellW, cellH, bpr).
export interface Wa2FontSlot { cellW: number; cellH: number; bpr: number; ascent: number; count: number; codes: string; b64: string }
export const WA2_FONT: { base: Wa2FontSlot; ruby: Wa2FontSlot } = {
  base: ${slotLit(base)},
  ruby: ${slotLit(ruby)},
};
`;
await Bun.write(OUT, out);

console.log(`  base: ${[...base.codes].length} glyphs ${base.cellW}x${base.cellH} (${base.bpr}B/row), blob ${base.blob.length}B`);
console.log(`  ruby: ${[...ruby.codes].length} glyphs ${ruby.cellW}x${ruby.cellH} (${ruby.bpr}B/row), blob ${ruby.blob.length}B`);
console.log(`  module bytes: ${out.length}`);
console.log("\n雪 @base:\n" + preview(base, "雪"));
console.log("あ @base:\n" + preview(base, "あ"));
console.log("こ @ruby:\n" + preview(ruby, "こ"));
