// The raw native contract every platform provides (PSP/Rust, Web/Canvas, 3DS/C,
// and the Node golden-test harness). The framework is built entirely on top of
// these two globals, which is what makes it isomorphic.
export interface RawGfx {
  clear(r: number, g: number, b: number): void;
  fillRect(x: number, y: number, w: number, h: number, r: number, g: number, b: number): void;
  /**
   * Optional batched fill: draw `count` rects in ONE call. `buffer` is `count`×5
   * little-endian i32 `[x, y, w, h, rgb]` (rgb = 0xRRGGBB). The glyph rasterizer
   * uses it so a text string is one FFI crossing + GE draw instead of hundreds.
   * Hosts that don't implement it (graphics.ts falls back to per-rect fillRect).
   */
  fillRects?(buffer: ArrayBuffer, count: number): void;
  /**
   * Optional native text. `uploadFont` installs the active font ONCE (`table` is
   * 128 glyphs × 9 bytes: 1 width + 8 row bytes); `drawText` then rasterizes a
   * string + draws all glyph runs in one call (`rgb` = 0xRRGGBB), returning the
   * width drawn. Moves the per-pixel-run glyph loop off the interpreted core.
   * Hosts without these (graphics.ts falls back to the JS fillRect/fillRects path).
   */
  uploadFont?(table: ArrayBuffer, height: number): void;
  drawText?(str: string, x: number, y: number, rgb: number, scale: number): number;
  /**
   * Optional VN glyph atlas (large variable-cell Japanese font, used by the
   * wa2 visual-novel game). `vnUploadFont` installs one slot ONCE (`rows` is
   * `count` cells × `cellH` rows × `bpr` bytes, each row a 1-bit mask, MSB =
   * leftmost pixel; glyph id 0 is a reserved blank). `vnDrawGlyphs` then draws
   * `count` glyphs in batched native draws — `glyphs` is `count` × 3 LE i32
   * `[glyphId, x, y]`, `rgb` = 0xRRGGBB. Hosts without these simply omit them
   * (the wa2 game feature-detects and shows a fallback notice).
   */
  vnUploadFont?(slot: number, rows: ArrayBuffer, count: number, cellW: number, cellH: number, bpr: number): void;
  vnDrawGlyphs?(slot: number, glyphs: ArrayBuffer, count: number, rgb: number): void;
}

declare global {
  // eslint-disable-next-line no-var
  var gfx: RawGfx;
  // eslint-disable-next-line no-var
  var log: (msg: string) => void;
  // eslint-disable-next-line no-var
  var frame: ((buttons: number) => void) | undefined;
}

export const SCREEN_W = 480;
export const SCREEN_H = 272;

/** Safe log() that works even if the host didn't provide one. */
export function hostLog(msg: string): void {
  try {
    if (typeof globalThis.log === 'function') globalThis.log(msg);
  } catch {
    /* ignore */
  }
}
