import { Color } from './color';

// A palette-indexed bitmap. `pixels[i]` is an index into `palette`; pixels equal
// to `transparent` are skipped when blitted. Kept tiny because every visible
// pixel run becomes a host fillRect call.
export interface Bitmap {
  w: number;
  h: number;
  palette: Color[];
  pixels: Uint8Array;
  transparent: number; // palette index treated as transparent
}

/**
 * Build a bitmap from ASCII-art rows. Each char maps to a color via `map`;
 * any char not in `map` (default the space) is transparent.
 *   bitmapFromRows([".XX.", "X..X"], { X: 0xffffff })
 */
export function bitmapFromRows(
  rows: string[],
  map: Record<string, Color>,
  transparentChar = '.',
): Bitmap {
  const h = rows.length;
  const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const palette: Color[] = [0]; // index 0 = transparent slot
  const idxOf = new Map<Color, number>();
  const transparent = 0;
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < w; x++) {
      const ch = x < row.length ? row[x] : transparentChar;
      if (ch === transparentChar || !(ch in map)) {
        pixels[y * w + x] = transparent;
        continue;
      }
      const col = map[ch];
      let pi = idxOf.get(col);
      if (pi === undefined) {
        pi = palette.length;
        palette.push(col);
        idxOf.set(col, pi);
      }
      pixels[y * w + x] = pi;
    }
  }
  return { w, h, palette, pixels, transparent };
}

// Compact codec for baked assets: pixels become a string (one char per pixel,
// charCode = index + 32), so generated data stays small and diff-friendly.
export function packPixels(pixels: Uint8Array): string {
  let s = '';
  for (let i = 0; i < pixels.length; i++) s += String.fromCharCode(pixels[i] + 32);
  return s;
}
export function unpackPixels(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) - 32;
  return out;
}

export interface BakedBitmap {
  w: number;
  h: number;
  palette: Color[];
  transparent: number;
  data: string; // packPixels output
}
export function fromBaked(b: BakedBitmap): Bitmap {
  return { w: b.w, h: b.h, palette: b.palette, transparent: b.transparent, pixels: unpackPixels(b.data) };
}
