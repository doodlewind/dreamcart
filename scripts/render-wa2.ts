// Headless render of the wa2 VN bundle to PNGs for visual verification.
// Mirrors framework/test/golden.ts's gfx mock (incl. vnUploadFont/vnDrawGlyphs),
// drives input to step title -> chapter card -> dialogue, and dumps frames.
// Run: bun scripts/render-wa2.ts
import { readFileSync, writeFileSync } from "node:fs";
import UPNG from "upng-js";

const W = 480, H = 272;
const bundle = readFileSync(new URL("../runtime/src/game/wa2.js", import.meta.url).pathname, "utf8");

const buf = new Uint8Array(W * H * 4);
const put = (x: number, y: number, w: number, h: number, r: number, g: number, b: number) => {
  x |= 0; y |= 0; w |= 0; h |= 0;
  const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(W, x + w), y1 = Math.min(H, y + h);
  for (let yy = y0; yy < y1; yy++) { let o = (yy * W + x0) * 4; for (let xx = x0; xx < x1; xx++) { buf[o++] = r; buf[o++] = g; buf[o++] = b; buf[o++] = 255; } }
};
type Vn = { rows: Uint8Array; count: number; cellW: number; cellH: number; bpr: number };
const vn: (Vn | null)[] = [null, null];
const gfx = {
  clear: (r: number, g: number, b: number) => put(0, 0, W, H, r, g, b),
  fillRect: (x: number, y: number, w: number, h: number, r: number, g: number, b: number) => put(x, y, w, h, r, g, b),
  fillRects: (ab: ArrayBuffer, count: number) => { const v = new Int32Array(ab); for (let i = 0; i < count; i++) { const o = i * 5, c = v[o + 4] >>> 0; put(v[o], v[o + 1], v[o + 2], v[o + 3], (c >> 16) & 255, (c >> 8) & 255, c & 255); } },
  // (no drawText/uploadFont -> graphics.ts uses the fillRects fallback for the
  //  8x8 ASCII UI font, so latin UI renders here too, like on web)
  vnUploadFont: (slot: number, rows: ArrayBuffer, count: number, cellW: number, cellH: number, bpr: number) => { if (slot >= 0 && slot <= 1) vn[slot] = { rows: new Uint8Array(rows), count, cellW, cellH, bpr }; },
  vnDrawGlyphs: (slot: number, glyphs: ArrayBuffer, count: number, rgb: number) => {
    const f = vn[slot]; if (!f) return;
    const v = new Int32Array(glyphs), r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255, stride = f.bpr * f.cellH;
    for (let i = 0; i < count; i++) {
      const id = v[i * 3]; if (id <= 0 || id >= f.count) continue;
      const gx = v[i * 3 + 1], gy = v[i * 3 + 2], cell = id * stride;
      for (let ry = 0; ry < f.cellH; ry++) { const row = cell + ry * f.bpr; let col = 0; while (col < f.cellW) { if (f.rows[row + (col >> 3)] & (0x80 >> (col & 7))) { let run = 1; while (col + run < f.cellW && f.rows[row + ((col + run) >> 3)] & (0x80 >> ((col + run) & 7))) run++; put(gx + col, gy + ry, run, 1, r, g, b); col += run; } else col++; } }
    }
  },
};
const g: any = globalThis;
g.gfx = gfx; g.log = () => {};
new Function(bundle)();
const frame: (m: number) => void = g.frame;

const START = 0x08, CROSS = 0x4000;
const dump = (name: string) => writeFileSync(`/tmp/${name}.png`, Buffer.from(UPNG.encode([buf.buffer.slice(0)], W, H, 0)));

// title
for (let i = 0; i < 3; i++) frame(0);
dump("wa2_title");
// title -> chapter card
frame(START); frame(0); frame(0);
dump("wa2_card");
// card -> dialogue, then reveal everything fast (hold Square=0x8000)
frame(CROSS); frame(0);
for (let i = 0; i < 200; i++) frame(0x8000);
dump("wa2_line1");
// advance to scene 1001 line 2 ("…<空港|ここ>に着いた…") to verify furigana
frame(CROSS); frame(0); for (let i = 0; i < 80; i++) frame(0x8000);
frame(CROSS); frame(0); for (let i = 0; i < 200; i++) frame(0x8000);
dump("wa2_ruby");
// advance a few lines to reach a narration / a line with furigana
for (let step = 0; step < 4; step++) { frame(CROSS); frame(0); for (let i = 0; i < 120; i++) frame(0x8000); }
dump("wa2_line5");
console.log("wrote /tmp/wa2_title.png wa2_card.png wa2_line1.png wa2_line5.png");
