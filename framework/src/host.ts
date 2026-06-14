// The raw native contract every platform provides (PSP/Rust, Web/Canvas, 3DS/C,
// and the Node golden-test harness). The framework is built entirely on top of
// these two globals, which is what makes it isomorphic.
export interface RawGfx {
  clear(r: number, g: number, b: number): void;
  fillRect(x: number, y: number, w: number, h: number, r: number, g: number, b: number): void;
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
