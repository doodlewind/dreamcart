// Bitmap font: each glyph is `height` row-bitmasks; bit (1<<col) set => pixel,
// column 0 is the leftmost. This matches the classic font8x8 encoding the baker
// imports. A minimal fallback font lives in assets-font.ts (generated/overwritten
// by `bun run bake`) so the framework always builds.
export interface Glyph {
  w: number;
  rows: number[]; // length === Font.height
}
export interface Font {
  height: number;
  glyphs: Record<number, Glyph>;
  fallback: Glyph;
}

let current: Font | null = null;

export function setFont(f: Font): void {
  current = f;
}
export function getFont(): Font {
  if (!current) throw new Error('no font set — import the assets or call setFont()');
  return current;
}
export function glyphOf(font: Font, code: number): Glyph {
  return font.glyphs[code] || font.fallback;
}
