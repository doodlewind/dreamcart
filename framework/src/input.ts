// Controller buttons — identical bitmask on every platform (PSP CtrlButtons;
// the Web and 3DS hosts remap their inputs to these exact bits).
export const Btn = {
  Select: 0x01,
  Start: 0x08,
  Up: 0x10,
  Right: 0x20,
  Down: 0x40,
  Left: 0x80,
  Triangle: 0x1000,
  Circle: 0x2000,
  Cross: 0x4000,
  Square: 0x8000,
} as const;

export type Button = (typeof Btn)[keyof typeof Btn];

/** Edge-detecting input state, updated once per frame by the engine. */
export class Input {
  cur = 0;
  prev = 0;

  update(mask: number): void {
    this.prev = this.cur;
    this.cur = mask | 0;
  }

  held(b: number): boolean {
    return (this.cur & b) !== 0;
  }
  /** True only on the frame the button transitions to down. */
  pressed(b: number): boolean {
    return (this.cur & b) !== 0 && (this.prev & b) === 0;
  }
  released(b: number): boolean {
    return (this.cur & b) === 0 && (this.prev & b) !== 0;
  }

  /** D-pad as a unit-ish vector (held). */
  dir(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.held(Btn.Left)) x -= 1;
    if (this.held(Btn.Right)) x += 1;
    if (this.held(Btn.Up)) y -= 1;
    if (this.held(Btn.Down)) y += 1;
    return { x, y };
  }
}
