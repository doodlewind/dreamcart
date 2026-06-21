// Controller buttons — identical bitmask on every platform (PSP CtrlButtons;
// the Web and 3DS hosts remap their inputs to these exact bits).
export const Btn = {
  Select: 0x01,
  Start: 0x08,
  Up: 0x10,
  Right: 0x20,
  Down: 0x40,
  Left: 0x80,
  LTrigger: 0x100, // PSP_CTRL_LTRIGGER
  RTrigger: 0x200, // PSP_CTRL_RTRIGGER
  Triangle: 0x1000,
  Circle: 0x2000,
  Cross: 0x4000,
  Square: 0x8000,
} as const;

export type Button = (typeof Btn)[keyof typeof Btn];

/** Radial-ish deadzone for a single analog axis (|v| < 0.12 -> 0). */
function deadzone(v: number): number {
  return v > -0.12 && v < 0.12 ? 0 : v;
}

/** Edge-detecting input state, updated once per frame by the engine. */
export class Input {
  cur = 0;
  prev = 0;
  /** Analog stick, -1..1, 0 on hosts that don't provide it. See update(). */
  analogX = 0;
  analogY = 0;

  /**
   * Update from the per-frame word the host passes to frame(). The low 16 bits
   * are the digital Btn bitmask (max Btn.Square=0x8000); a host MAY pack the
   * analog stick into the free high 16 bits as two signed bytes
   * (x = bits 16..23, y = bits 24..31, each lx-128 clamped to [-127,127]). The
   * PSP host (runtime/src/main.rs) does this; digital-only hosts leave them 0, so
   * cur/analog are byte-identical to the old behavior and goldens don't move.
   */
  update(packed: number): void {
    this.prev = this.cur;
    this.cur = packed & 0xffff;
    // Arithmetic shifts sign-extend the packed bytes; /127 -> ~[-1,1].
    this.analogX = deadzone(((packed << 8) >> 24) / 127);
    this.analogY = deadzone((packed >> 24) / 127);
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

  /**
   * Unified steering input: the analog stick past its deadzone, else the D-pad.
   * Digital-only hosts (analog 0) fall straight back to dir(), so a game written
   * against axis() behaves identically with or without an analog stick.
   */
  axis(): { x: number; y: number } {
    return this.analogX !== 0 || this.analogY !== 0
      ? { x: this.analogX, y: this.analogY }
      : this.dir();
  }
}
