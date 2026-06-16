// The cross-host 3D wire format + the per-frame command encoder.
//
// One little-endian ArrayBuffer is assembled each frame and handed to
// `g3d.submit` in a single FFI call (O(1) crossings regardless of object count).
// These constants are the source of truth; the Rust (runtime/src/gfx3d.rs) and
// C (runtime-3ds/source/main.c) parsers MUST use identical values, and
// framework/test/contract.ts asserts they never drift.
//
// Buffer layout:
//   Header (8 bytes): u32 magic 'DC3D', u16 version, u16 recordCount
//   Record: u16 opcode; u16 payloadWords (count of u32); payload[payloadWords]
//     OP_SET_CAMERA payload = viewProj : 16 f32 (column-major, proj*view)
//     OP_DRAW       payload = u32 handle, u32 tintABGR, model : 16 f32
//     OP_IMM_TRIS   payload = u32 vertexCount, u32 format, then inline vertices
//
// Every record is a whole number of u32 words, so the header (8B) + record
// headers (4B) keep all f32/matrix payloads 4-byte aligned for typed-array views.
import { hasG3d } from './host3d';
import type { Color } from './color';

export const DC3D_MAGIC = 0x44433344; // 'DC3D' little-endian
export const DC3D_VERSION = 0x0001;

export const OP_SET_CAMERA = 0x0001;
export const OP_DRAW = 0x0002;
export const OP_IMM_TRIS = 0x0003;

// Vertex-format bitfield. v1 ships POS|COLOR; NORMAL/UV reserved for later.
export const FMT_POS = 0x0001; // 3 x f32
export const FMT_COLOR = 0x0002; // u32 ABGR
export const FMT_NORMAL = 0x0004; // 3 x f32
export const FMT_UV = 0x0008; // 2 x f32

/** Bytes per vertex for a format (v1 layout: [color u32][pos 3 f32] = 16). */
export function vertexStride(format: number): number {
  let s = 0;
  if (format & FMT_COLOR) s += 4;
  if (format & FMT_POS) s += 12;
  if (format & FMT_NORMAL) s += 12;
  if (format & FMT_UV) s += 8;
  return s;
}

/** No-tint sentinel: full white, fully opaque ABGR. */
export const NO_TINT = 0xffffffff;

/** Pack an 0xRRGGBB color into the PSP-style ABGR u32 used in vertex/tint data. */
export function colorToABGR(c: Color, a = 255): number {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  return (((a & 255) << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * Builds the per-frame command buffer into a pre-allocated ArrayBuffer and
 * submits it. One instance is reused every frame (reset() rewinds it).
 */
export class CommandEncoder {
  private buf: ArrayBuffer;
  private view: DataView;
  private pos = 8; // past header
  private records = 0;

  constructor(capacityBytes = 256 * 1024) {
    this.buf = new ArrayBuffer(capacityBytes);
    this.view = new DataView(this.buf);
  }

  reset(): void {
    this.pos = 8;
    this.records = 0;
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.byteLength) return;
    let cap = this.buf.byteLength;
    while (cap < this.pos + extra) cap *= 2;
    const next = new ArrayBuffer(cap);
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf);
  }

  private writeMat(m: ArrayLike<number>): void {
    for (let i = 0; i < 16; i++) {
      this.view.setFloat32(this.pos, m[i], true);
      this.pos += 4;
    }
  }

  /** Emit SET_CAMERA with a column-major view*proj (16 numbers). */
  setCamera(viewProj: ArrayLike<number>): void {
    this.ensure(4 + 64);
    this.view.setUint16(this.pos, OP_SET_CAMERA, true);
    this.view.setUint16(this.pos + 2, 16, true);
    this.pos += 4;
    this.writeMat(viewProj);
    this.records++;
  }

  /** Emit a DRAW of a retained mesh handle with a model matrix and tint. */
  draw(handle: number, model: ArrayLike<number>, tintABGR = NO_TINT): void {
    this.ensure(4 + 8 + 64);
    this.view.setUint16(this.pos, OP_DRAW, true);
    this.view.setUint16(this.pos + 2, 18, true); // 2 (handle,tint) + 16 (model)
    this.pos += 4;
    this.view.setUint32(this.pos, handle >>> 0, true);
    this.view.setUint32(this.pos + 4, tintABGR >>> 0, true);
    this.pos += 8;
    this.writeMat(model);
    this.records++;
  }

  /**
   * Emit inline dynamic geometry (particles/tracers). `vertices` is interleaved
   * per `format`; `byteLength` bytes are copied into the buffer.
   */
  immTris(vertices: ArrayBuffer, vertexCount: number, format: number, byteLength: number): void {
    const words = 2 + Math.ceil(byteLength / 4);
    this.ensure(4 + words * 4);
    this.view.setUint16(this.pos, OP_IMM_TRIS, true);
    this.view.setUint16(this.pos + 2, words, true);
    this.pos += 4;
    this.view.setUint32(this.pos, vertexCount >>> 0, true);
    this.view.setUint32(this.pos + 4, format >>> 0, true);
    this.pos += 8;
    new Uint8Array(this.buf, this.pos, byteLength).set(new Uint8Array(vertices, 0, byteLength));
    this.pos += Math.ceil(byteLength / 4) * 4; // keep 4-aligned
    this.records++;
  }

  /** Write the header and submit the buffer to the host (no-op if no g3d). */
  finish(): void {
    this.view.setUint32(0, DC3D_MAGIC, true);
    this.view.setUint16(4, DC3D_VERSION, true);
    this.view.setUint16(6, this.records, true);
    if (hasG3d()) globalThis.g3d!.submit(this.buf, this.pos);
  }
}
