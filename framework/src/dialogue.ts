import { Color, Colors } from './color';
import type { UpdateContext } from './engine';
import { Graphics } from './graphics';
import { SCREEN_H, SCREEN_W } from './host';
import { Btn } from './input';
import { Node } from './scene';

// A bottom-of-screen dialogue box. Press Cross/Start to advance lines; calls
// onDone() and removes itself when finished. Used by the story/village game.
export class DialogueBox extends Node {
  idx = 0;
  done = false;
  private blink = 0;
  scale = 2;
  fg: Color = Colors.white;
  bg: Color = 0x101830;
  border: Color = 0x6677aa;

  constructor(
    public lines: string[],
    public onDone?: () => void,
  ) {
    super();
  }

  update(ctx: UpdateContext): void {
    this.blink++;
    if (ctx.input.pressed(Btn.Cross) || ctx.input.pressed(Btn.Start)) {
      this.idx++;
      if (this.idx >= this.lines.length) {
        this.done = true;
        this.remove();
        if (this.onDone) this.onDone();
      }
    }
  }

  draw(g: Graphics): void {
    if (this.done) return;
    const h = 66;
    const y = SCREEN_H - h - 6;
    const x = 8;
    const w = SCREEN_W - 16;
    g.rect(x, y, w, h, this.bg);
    g.rectOutline(x, y, w, h, this.border, 2);
    g.text(this.lines[this.idx] || '', x + 10, y + 12, this.fg, this.scale);
    // blinking "more" triangle
    if ((this.blink >> 4) & 1) {
      const tx = x + w - 18;
      const ty = y + h - 16;
      g.rect(tx, ty, 8, 2, this.fg);
      g.rect(tx + 1, ty + 2, 6, 2, this.fg);
      g.rect(tx + 2, ty + 4, 4, 2, this.fg);
      g.rect(tx + 3, ty + 6, 2, 2, this.fg);
    }
  }
}
