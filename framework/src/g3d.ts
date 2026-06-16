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
//
// ── CROSS-HOST CONVENTIONS (the single source of truth; a new host must honor
//    all three exactly, and the software reference rasterizer framework/test/
//    raster3d.ts is the oracle that pins them) ────────────────────────────────
//
// 1. DEPTH / CLIP. Matrices are column-major (m[col*4+row]); the camera matrix is
//    proj*view (see scene3d.ts). The projection is REVERSED-Z: NDC z near->1,
//    far->0 (clip z in [0,w] when zeroToOne, else [-1,1] reversed). Every host
//    clears depth to the FAR value and keeps the GREATER (nearer) fragment.
//    Per-host realizations of that one convention (do NOT unify — each is a
//    correct native mapping):
//      Web  — EXT_clip_control ZERO_TO_ONE; clearDepth 0; depthFunc GREATER.
//      PSP  — sceGuDepthRange(0, 65535); clearDepth 0; DepthFunc GreaterOrEqual.
//      3DS  — negate the mvp z-row into the PICA200's [-w,0] clip range +
//             C3D_DepthMap(true,-1,0); clear depth 0; GPU_GEQUAL.
//
// 2. Y / WINDING / CULL. NDC is Y-up; the flip to the Y-down framebuffer is each
//    renderer's VIEWPORT job (raster3d.toScreen and the host viewports) — it is
//    NOT baked into the shared projection. Back-face culling is DISABLED on every
//    host (occlusion is depth-only); meshes are wound CCW-outward but that is not
//    load-bearing while culling is off.
//
// 3. COLOR. FMT_COLOR is u32 ABGR with 0..255 channels. Each host normalizes to
//    [0,1] itself: Web via the vertexAttribPointer normalize flag, PSP via the
//    GE's COLOR_8888, 3DS by dividing by 255 in the PICA vertex shader (the PICA
//    does NOT auto-normalize unsigned-byte attributes — this bit once as a
//    white-clamp bug).
import { hasG3d } from './host3d';
import type { Color } from './color';

export const DC3D_MAGIC = 0x44433344; // 'DC3D' little-endian
export const DC3D_VERSION = 0x0002;

export const OP_SET_CAMERA = 0x0001;
export const OP_DRAW = 0x0002;
export const OP_IMM_TRIS = 0x0003;
// v2 (advanced 3D): texture/light state + skinned draw. All additive + length-
// prefixed, so v1-only hosts skip them. See docs/psp-advanced-3d.md.
export const OP_BIND_TEXTURE = 0x0004; // payload: u32 texHandle (0xffffffff = unbind)
export const OP_SET_LIGHTS = 0x0005; // payload: u32 count, u32 ambientABGR, count×{u32 colorABGR, 3 f32 dir}
export const OP_DRAW_SKINNED = 0x0006; // OP_DRAW + u32 boneCount, then boneCount×12 f32 (3×4 bone matrices)

// Vertex-format bitfield. v1 ships POS|COLOR; v2 adds NORMAL/UV/WEIGHTS.
// IMPORTANT: bytes are ALWAYS interleaved in the PSP GE's mandated component
// order [weights][uv][color][normal][position] (each 4-byte aligned), regardless
// of bit value — the bake + encoder + host all agree on GE order. (v1's
// [color][pos] is a legal subset.)
export const FMT_POS = 0x0001; // 3 x f32
export const FMT_COLOR = 0x0002; // u32 ABGR
export const FMT_NORMAL = 0x0004; // 3 x f32
export const FMT_UV = 0x0008; // 2 x f32 (texcoord)
export const FMT_WEIGHTS = 0x0010; // bone weights; count carried per-mesh (weightCount), not in the bit

/**
 * Bytes per vertex for a format. `weightCount` is the number of f32 bone weights
 * when FMT_WEIGHTS is set (0 otherwise). Order-independent (sums present fields).
 */
export function vertexStride(format: number, weightCount = 0): number {
  let s = 0;
  if (format & FMT_WEIGHTS) s += weightCount * 4;
  if (format & FMT_UV) s += 8;
  if (format & FMT_COLOR) s += 4;
  if (format & FMT_NORMAL) s += 12;
  if (format & FMT_POS) s += 12;
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

  /** Emit SET_CAMERA with a column-major proj*view matrix (16 numbers). */
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
   *
   * RESERVED / unexercised in v1: no shipped game calls this yet, and the
   * software reference rasterizer (raster3d.ts) does NOT render OP_IMM_TRIS — so
   * a game that starts emitting it would produce an unvalidated golden until
   * raster3d gains an immTris path. Wire both together when first used.
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
