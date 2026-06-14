// Colors are packed 0xRRGGBB integers. The host fillRect takes separate r,g,b.
export type Color = number;

export const rgb = (r: number, g: number, b: number): Color =>
  (((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0;

export const redOf = (c: Color): number => (c >> 16) & 255;
export const greenOf = (c: Color): number => (c >> 8) & 255;
export const blueOf = (c: Color): number => c & 255;

/** Linear blend a->b by t in [0,1]. */
export const mix = (a: Color, b: Color, t: number): Color =>
  rgb(
    redOf(a) + (redOf(b) - redOf(a)) * t,
    greenOf(a) + (greenOf(b) - greenOf(a)) * t,
    blueOf(a) + (blueOf(b) - blueOf(a)) * t,
  );

// A small named palette for convenience.
export const Colors = {
  black: 0x000000,
  white: 0xffffff,
  gray: 0x808080,
  dark: 0x10141e,
  red: 0xe03030,
  green: 0x40b840,
  blue: 0x3050e0,
  yellow: 0xf0c850,
  orange: 0xf08020,
  cyan: 0x40c8e0,
  magenta: 0xd040c0,
  brown: 0x8a5a2a,
  sky: 0x6088c0,
  grass: 0x4ca64c,
} as const;
