import { Bitmap } from './bitmap';
import { Color, blueOf, greenOf, redOf } from './color';
import { Font, getFont, glyphOf } from './font';

export interface SpriteOpts {
  scale?: number;
  flipX?: boolean;
}

// Thin wrapper over the host fillRect — the only drawing surface. Everything
// (sprites, text) is rasterized to fillRect runs here.
export class Graphics {
  clear(c: Color): void {
    gfx.clear(redOf(c), greenOf(c), blueOf(c));
  }

  rect(x: number, y: number, w: number, h: number, c: Color): void {
    if (w <= 0 || h <= 0) return;
    gfx.fillRect(x | 0, y | 0, w | 0, h | 0, redOf(c), greenOf(c), blueOf(c));
  }

  rectOutline(x: number, y: number, w: number, h: number, c: Color, t = 1): void {
    this.rect(x, y, w, t, c);
    this.rect(x, y + h - t, w, t, c);
    this.rect(x, y, t, h, c);
    this.rect(x + w - t, y, t, h, c);
  }

  /** Blit a palette bitmap, grouping equal horizontal pixel runs into fillRects. */
  sprite(bmp: Bitmap, dx: number, dy: number, opts: SpriteOpts = {}): void {
    const s = opts.scale ?? 1;
    const flip = opts.flipX ?? false;
    dx |= 0;
    dy |= 0;
    for (let y = 0; y < bmp.h; y++) {
      let x = 0;
      while (x < bmp.w) {
        const idx = bmp.pixels[y * bmp.w + x];
        if (idx === bmp.transparent) {
          x++;
          continue;
        }
        let run = 1;
        while (x + run < bmp.w && bmp.pixels[y * bmp.w + x + run] === idx) run++;
        const col = bmp.palette[idx];
        const sx = flip ? bmp.w - x - run : x;
        gfx.fillRect(dx + sx * s, dy + y * s, run * s, s, redOf(col), greenOf(col), blueOf(col));
        x += run;
      }
    }
  }

  /** Draw text; supports '\n'. Returns the width drawn (single-line width). */
  text(str: string, x: number, y: number, c: Color, scale = 1, font: Font = getFont()): number {
    const r = redOf(c);
    const g = greenOf(c);
    const b = blueOf(c);
    let cx = x | 0;
    let cy = y | 0;
    let maxw = 0;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code === 10) {
        maxw = Math.max(maxw, cx - x);
        cx = x | 0;
        cy += (font.height + 1) * scale;
        continue;
      }
      const gl = glyphOf(font, code);
      for (let ry = 0; ry < font.height; ry++) {
        const bits = gl.rows[ry] || 0;
        if (!bits) continue;
        let col = 0;
        while (col < gl.w) {
          if (bits & (1 << col)) {
            let run = 1;
            while (col + run < gl.w && bits & (1 << (col + run))) run++;
            gfx.fillRect(cx + col * scale, cy + ry * scale, run * scale, scale, r, g, b);
            col += run;
          } else {
            col++;
          }
        }
      }
      cx += (gl.w + 1) * scale;
    }
    return Math.max(maxw, cx - x);
  }

  textWidth(str: string, scale = 1, font: Font = getFont()): number {
    let w = 0;
    let line = 0;
    for (let i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) === 10) {
        w = Math.max(w, line);
        line = 0;
        continue;
      }
      line += (glyphOf(font, str.charCodeAt(i)).w + 1) * scale;
    }
    return Math.max(w, line);
  }

  textCentered(str: string, cx: number, y: number, c: Color, scale = 1, font: Font = getFont()): void {
    this.text(str, cx - this.textWidth(str, scale, font) / 2, y, c, scale, font);
  }
}
