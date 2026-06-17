// Materials + textures for the 3D layer. A Texture wraps baked/procedural pixel
// data and lazily uploads itself to the host on first use (mirroring Mesh.handle),
// caching the returned handle. A Material pairs an optional Texture with a base
// color; a Node3D references one so Scene3D knows what to bind before its draw.
//
// Determinism note: this file is in contract.ts's `detFiles` no-trig guard — it
// must use only +,-,*,/ and math.ts helpers (dsin/dcos), no native trig.
import { PSM_8888 } from './g3d';
import { hasG3d } from './host3d';
import type { Color } from './color';

/** A GPU texture: pixel bytes in a PSM_* format, uploaded once and retained. */
export class Texture {
  pixels: Uint8Array;
  w: number;
  h: number;
  psm: number;
  private _handle = -1;

  constructor(pixels: Uint8Array, w: number, h: number, psm: number = PSM_8888) {
    this.pixels = pixels;
    this.w = w;
    this.h = h;
    this.psm = psm;
  }

  /**
   * Upload to the host on first call; returns -1 when there is no 3D host or the
   * host does not implement texturing (uploadTexture is optional in the contract).
   */
  handle(): number {
    if (this._handle < 0 && hasG3d() && globalThis.g3d!.uploadTexture) {
      this._handle = globalThis.g3d!.uploadTexture(
        this.pixels.buffer as ArrayBuffer,
        this.w,
        this.h,
        this.psm,
      );
    }
    return this._handle;
  }

  /** Build a flat W×H solid-color RGBA8888 texture (handy for tests/fallbacks). */
  static solid(w: number, h: number, color: Color, a = 255): Texture {
    const px = new Uint8Array(w * h * 4);
    const r = (color >> 16) & 255;
    const g = (color >> 8) & 255;
    const b = color & 255;
    for (let i = 0; i < w * h; i++) {
      px[i * 4] = r;
      px[i * 4 + 1] = g;
      px[i * 4 + 2] = b;
      px[i * 4 + 3] = a;
    }
    return new Texture(px, w, h, PSM_8888);
  }

  /**
   * Procedural W×H RGBA8888 checker, two colors. Deterministic; useful as the M1
   * texture-path test pattern before the glTF bake (M2) lands real palettes.
   */
  static checker(w: number, h: number, c0: Color, c1: Color, cells = 8): Texture {
    const px = new Uint8Array(w * h * 4);
    const cw = w / cells;
    const ch = h / cells;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const on = (((x / cw) | 0) + ((y / ch) | 0)) & 1;
        const c = on ? c1 : c0;
        const o = (y * w + x) * 4;
        px[o] = (c >> 16) & 255;
        px[o + 1] = (c >> 8) & 255;
        px[o + 2] = c & 255;
        px[o + 3] = 255;
      }
    }
    return new Texture(px, w, h, PSM_8888);
  }
}

/** A surface material: an optional texture, modulated by a base vertex color. */
export class Material {
  texture?: Texture;
  baseColor: Color;

  constructor(opts: { texture?: Texture; baseColor?: Color } = {}) {
    this.texture = opts.texture;
    this.baseColor = opts.baseColor ?? 0xffffff;
  }
}
