import { Bitmap } from './bitmap';
import { Color } from './color';
import { Graphics } from './graphics';
import { SCREEN_H, SCREEN_W } from './host';

// A grid of tile indices. Tiles can be rendered as flat colors or as bitmaps,
// with a camera offset (for scrolling worlds like the village).
export class TileMap {
  data: Uint8Array;
  constructor(
    public cols: number,
    public rows: number,
    public tile: number, // tile size in px
    data?: ArrayLike<number>,
  ) {
    this.data = new Uint8Array(cols * rows);
    if (data) this.data.set(data as any);
  }

  get(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return 0;
    return this.data[cy * this.cols + cx];
  }
  set(cx: number, cy: number, v: number): void {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return;
    this.data[cy * this.cols + cx] = v;
  }

  /** Pixel size of the whole map. */
  pixelW(): number {
    return this.cols * this.tile;
  }
  pixelH(): number {
    return this.rows * this.tile;
  }

  /** Is the tile index at world pixel (px,py) in `solid`? Used for collision. */
  solidAt(px: number, py: number, solid: ReadonlySet<number>): boolean {
    return solid.has(this.get(Math.floor(px / this.tile), Math.floor(py / this.tile)));
  }

  private visibleRange(cam: { x: number; y: number }) {
    const x0 = Math.max(0, Math.floor(cam.x / this.tile));
    const y0 = Math.max(0, Math.floor(cam.y / this.tile));
    const x1 = Math.min(this.cols, Math.ceil((cam.x + SCREEN_W) / this.tile));
    const y1 = Math.min(this.rows, Math.ceil((cam.y + SCREEN_H) / this.tile));
    return { x0, y0, x1, y1 };
  }

  /** Render each tile index as a flat color (colors[index]; 0/undefined skipped). */
  drawColors(g: Graphics, colors: (Color | undefined)[], cam: { x: number; y: number }): void {
    const { x0, y0, x1, y1 } = this.visibleRange(cam);
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const c = colors[this.get(cx, cy)];
        if (c === undefined) continue;
        g.rect(cx * this.tile - cam.x, cy * this.tile - cam.y, this.tile, this.tile, c);
      }
    }
  }

  /** Render each tile index as a bitmap (tiles[index]; undefined skipped). */
  drawSprites(g: Graphics, tiles: (Bitmap | undefined)[], cam: { x: number; y: number }, scale = 1): void {
    const { x0, y0, x1, y1 } = this.visibleRange(cam);
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const t = tiles[this.get(cx, cy)];
        if (!t) continue;
        g.sprite(t, cx * this.tile - cam.x, cy * this.tile - cam.y, { scale });
      }
    }
  }
}
