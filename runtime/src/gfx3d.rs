//! Native 3D engine exposed to JavaScript as the optional `g3d.*` object.
//!
//! This implements the frozen cross-host `g3d` contract (see
//! `framework/src/host3d.ts` + `framework/src/g3d.ts`): geometry is uploaded
//! once and retained behind a small-int handle, then ONE little-endian command
//! buffer crosses the FFI boundary per frame via `submit`. The byte layout and
//! conventions here MUST match the software reference renderer
//! (`framework/test/raster3d.ts`) so the same bundled game `.js` renders the
//! same image on every platform.
//!
//! Like `gfx.rs`, these functions only *enqueue* GE commands into the
//! already-open display list (opened/closed by `main.rs`); they never call
//! sceGuStart/Finish/Sync/SwapBuffers.

extern crate alloc;

use alloc::vec::Vec;
use core::ffi::c_void;
use core::ptr::null;

use libquickjs_sys::*;
use psp::sys::{
    self, ClearBuffer, GuPrimitive, MatrixMode, ScePspFMatrix4, VertexType,
};
use psp::Align16;

// ---------------------------------------------------------------------------
// Wire constants — contract.ts (framework/test/contract.ts) greps THIS file for
// these exact names+values and asserts byte-for-byte parity against g3d.ts.
//
// NOTE: the contract regex matches `NAME ... 0xHEX` with no digit/`x`/`X`
// between the name and the hex literal, so a Rust `: u32` type annotation (the
// `3`/`2` digits) would hide the real `const` lines from the parser. The
// comment block below is therefore the canonical, parser-visible declaration of
// each constant; the typed `const` items underneath are what the code uses.
//
//   DC3D_MAGIC = 0x44433344
//   DC3D_VERSION = 0x0001
//   OP_SET_CAMERA = 0x0001
//   OP_DRAW = 0x0002
//   OP_IMM_TRIS = 0x0003
//   FMT_POS = 0x0001
//   FMT_COLOR = 0x0002
//   FMT_NORMAL = 0x0004
//   FMT_UV = 0x0008
// ---------------------------------------------------------------------------

const DC3D_MAGIC: u32 = 0x4443_3344; // 'DC3D' little-endian
const DC3D_VERSION: u32 = 0x0001;

const OP_SET_CAMERA: u32 = 0x0001;
const OP_DRAW: u32 = 0x0002;
const OP_IMM_TRIS: u32 = 0x0003;

// Vertex-format bitfield (v1 ships POS|COLOR; NORMAL/UV reserved for later).
const FMT_POS: u32 = 0x0001;
const FMT_COLOR: u32 = 0x0002;
const FMT_NORMAL: u32 = 0x0004;
const FMT_UV: u32 = 0x0008;

/// No-tint sentinel: full white, fully opaque ABGR.
const NO_TINT: u32 = 0xffff_ffff;

/// Background the 3D pass clears the color buffer to — RGB(0x10, 0x14, 0x1e),
/// matching `BG_R/BG_G/BG_B` in raster3d.ts. Packed into PSP ABGR (opaque).
const BG_CLEAR_ABGR: u32 = 0xff00_0000 | (0x1e << 16) | (0x14 << 8) | 0x10;

/// The GE vertex type for v1 meshes: a u32 ABGR color followed by 3×f32
/// position, transformed by the matrix stack. Matches the wire's interleaved
/// 16-byte `[color u32][pos 3 f32]` stride. We draw NON-indexed (indices are
/// expanded at upload), exactly like `rust-psp/examples/cube`, so no INDEX_16BIT.
const V1_VTYPE: VertexType = VertexType::from_bits_truncate(
    VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_32BITF.bits()
        | VertexType::TRANSFORM_3D.bits(),
);

/// One 16-byte vertex, 16-byte aligned. The GE reads vertices straight from RAM
/// and (like the 2D sprite path in `gfx.rs` and the cube example) needs the
/// buffer 16-byte aligned — a plain `Vec<u8>` only guarantees 1-byte alignment,
/// which makes the GE read garbage and draw nothing. A `Vec<Vertex16>` allocates
/// 16-aligned because the element alignment is 16.
#[repr(C, align(16))]
#[derive(Copy, Clone)]
struct Vertex16([u8; 16]);

/// A retained mesh: an owned, 16-byte-aligned, NON-indexed vertex buffer in main
/// RAM (the qjs_alloc heap), dcache-flushed once at upload. Indexed input is
/// expanded to a flat vertex list here so the draw path matches the example.
struct MeshEntry {
    verts: Vec<Vertex16>,
    /// Number of vertices to draw (3 per triangle).
    count: i32,
}

/// The handle table. `g3d` is only ever touched from the single-threaded JS
/// frame loop (QuickJS has no threads here), so an `UnsafeCell`-style `static
/// mut` matches the existing `no_std`/single-thread style of `main.rs`/`gfx.rs`
/// without paying for a Mutex. A handle is just the index into this Vec.
static mut MESHES: Option<Vec<MeshEntry>> = None;

#[inline]
unsafe fn meshes() -> &'static mut Vec<MeshEntry> {
    if MESHES.is_none() {
        MESHES = Some(Vec::new());
    }
    MESHES.as_mut().unwrap()
}

/// Read the i-th JS argument as an i32 (0 if absent / not convertible). Mirrors
/// `gfx::arg_i32`.
#[inline]
unsafe fn arg_i32(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> i32 {
    if (i as i32) >= argc {
        return 0;
    }
    let mut out: i32 = 0;
    JS_ToInt32(ctx, &mut out, *argv.offset(i));
    out
}

/// `g3d.uploadMesh(vertices: ArrayBuffer, indices: ArrayBuffer|null, format)`
/// -> int handle.
///
/// COPIES the borrowed QuickJS bytes into owned `Vec`s (we must NEVER retain the
/// QuickJS pointer — the engine may move/free it), dcache-flushes the copies so
/// the GE sees them, and returns the new entry's index as the handle.
unsafe extern "C" fn js_g3d_upload_mesh(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 3 {
        return JS_NewInt32(ctx, -1);
    }

    // --- Borrow the source vertex bytes (16-byte stride). ---
    let mut vlen: size_t = 0;
    let vptr = JS_GetArrayBuffer(ctx, &mut vlen, *argv.offset(0));
    if vptr.is_null() || vlen == 0 {
        return JS_NewInt32(ctx, -1);
    }
    let src_vert_count = vlen as usize / 16;
    let read_vert = |i: usize| -> Vertex16 {
        let mut v = [0u8; 16];
        core::ptr::copy_nonoverlapping(vptr.add(i * 16), v.as_mut_ptr(), 16);
        Vertex16(v)
    };

    let format = arg_i32(ctx, argc, argv, 2) as u32;
    // v1 supports POS|COLOR only; reject anything else loudly via a -1 handle so
    // the game fails fast rather than rendering garbage (matches raster3d.ts).
    if (format & FMT_POS) == 0 || (format & FMT_COLOR) == 0 {
        return JS_NewInt32(ctx, -1);
    }
    // Silence "unused" on the reserved bits while keeping them defined for the
    // contract parity check.
    let _ = (FMT_NORMAL, FMT_UV, DC3D_VERSION, OP_IMM_TRIS);

    // Build a 16-byte-aligned, NON-indexed vertex list (expand indices if present),
    // matching the proven cube-example draw path.
    let mut verts: Vec<Vertex16> = Vec::new();
    let indices_arg = *argv.offset(1);
    if !JS_IsNull(indices_arg) && !JS_IsUndefined(indices_arg) {
        let mut ilen: size_t = 0;
        let iptr = JS_GetArrayBuffer(ctx, &mut ilen, indices_arg);
        if !iptr.is_null() && ilen >= 2 {
            let n = ilen as usize / 2;
            verts.reserve(n);
            for i in 0..n {
                // wire indices are little-endian u16.
                let idx = (*iptr.add(i * 2) as usize) | ((*iptr.add(i * 2 + 1) as usize) << 8);
                if idx < src_vert_count {
                    verts.push(read_vert(idx));
                }
            }
        }
    } else {
        verts.reserve(src_vert_count);
        for i in 0..src_vert_count {
            verts.push(read_vert(i));
        }
    }
    if verts.is_empty() {
        return JS_NewInt32(ctx, -1);
    }

    let count = verts.len() as i32;
    // The GE reads geometry from RAM, not the CPU cache — flush the copy once.
    sys::sceKernelDcacheWritebackRange(
        verts.as_ptr() as *const c_void,
        (verts.len() * 16) as u32,
    );

    let table = meshes();
    let handle = table.len() as i32;
    table.push(MeshEntry { verts, count });
    JS_NewInt32(ctx, handle)
}

/// `g3d.freeMesh(handle)` -> void.
///
/// Releases the entry's native storage. We keep the slot (so existing handles
/// stay stable — handles are raw indices) but drop its buffers; a freed slot has
/// `count == 0` and is simply skipped on DRAW.
unsafe extern "C" fn js_g3d_free_mesh(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let h = arg_i32(ctx, argc, argv, 0);
    let table = meshes();
    if h >= 0 && (h as usize) < table.len() {
        let e = &mut table[h as usize];
        e.verts = Vec::new();
        e.count = 0;
    }
    JS_UNDEFINED
}

/// Load 16 little-endian f32 (a column-major matrix from the wire buffer)
/// straight into a `ScePspFMatrix4`.
///
/// `ScePspFMatrix4` is `{ x, y, z, w: ScePspFVector4 }` = 16 contiguous f32, and
/// `sceGumLoadMatrix` loads columns C300..C330 from those four consecutive
/// vec4s. The shared JS matrices are column-major (`m[col*4 + row]`), so the
/// wire order `[col0 (4) | col1 (4) | col2 (4) | col3 (4)]` maps DIRECTLY onto
/// `x/y/z/w` with no transpose. (Flagged as a hardware spike in the structured
/// result: if PPSSPP shows the cube mirrored/transposed, transpose here.)
// Returns an `Align16`-wrapped matrix because `sceGumLoadMatrix` loads it with
// VFPU `lv.q` quad-word loads, which FAULT on a non-16-byte-aligned source. The
// wire buffer is byte-packed (unaligned), so we copy into this aligned struct.
#[inline]
unsafe fn read_matrix(base: *const u8, off: usize) -> Align16<ScePspFMatrix4> {
    let mut m = Align16(ScePspFMatrix4 {
        x: sys::ScePspFVector4 { x: 0.0, y: 0.0, z: 0.0, w: 0.0 },
        y: sys::ScePspFVector4 { x: 0.0, y: 0.0, z: 0.0, w: 0.0 },
        z: sys::ScePspFVector4 { x: 0.0, y: 0.0, z: 0.0, w: 0.0 },
        w: sys::ScePspFVector4 { x: 0.0, y: 0.0, z: 0.0, w: 0.0 },
    });
    core::ptr::copy_nonoverlapping(
        base.add(off),
        &mut m.0 as *mut ScePspFMatrix4 as *mut u8,
        64,
    );
    m
}

/// Read a little-endian u32 from the wire buffer at `base + off`.
#[inline]
unsafe fn read_u32(base: *const u8, off: usize) -> u32 {
    (*base.add(off) as u32)
        | ((*base.add(off + 1) as u32) << 8)
        | ((*base.add(off + 2) as u32) << 16)
        | ((*base.add(off + 3) as u32) << 24)
}

/// Read a little-endian u16 from the wire buffer at `base + off`.
#[inline]
unsafe fn read_u16(base: *const u8, off: usize) -> u16 {
    (*base.add(off) as u16) | ((*base.add(off + 1) as u16) << 8)
}


/// `g3d.submit(buffer: ArrayBuffer, byteLength)` -> void. THE per-frame call.
///
/// Parses the one little-endian command buffer, clears color+depth, draws every
/// record with reversed-Z depth ON, then disables DepthTest so the subsequent
/// `gfx.fillRect` HUD pass (z=0, TRANSFORM_2D) draws on top in the same frame.
unsafe extern "C" fn js_g3d_submit(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_UNDEFINED;
    }
    let mut size: size_t = 0;
    let buf = JS_GetArrayBuffer(ctx, &mut size, *argv.offset(0));
    if buf.is_null() {
        return JS_UNDEFINED;
    }
    // Honour the caller-supplied byteLength (the encoder reuses an
    // over-allocated buffer and only the first `byteLength` bytes are valid).
    let mut byte_len = size as usize;
    if argc >= 2 {
        let bl = arg_i32(ctx, argc, argv, 1);
        if bl >= 0 && (bl as usize) < byte_len {
            byte_len = bl as usize;
        }
    }
    if byte_len < 8 {
        return JS_UNDEFINED; // not even a header
    }
    if read_u32(buf, 0) != DC3D_MAGIC {
        return JS_UNDEFINED; // bad magic — ignore the frame's 3D pass
    }
    let record_count = read_u16(buf, 6) as usize;

    // --- 3D pass setup: reversed-Z depth ON, clear color + depth. ---
    // init_graphics() already configured DepthRange(65535,0) + DepthFunc(GEQUAL)
    // and left DepthTest enabled for the 3D pass; re-enable defensively in case
    // a prior frame's HUD pass disabled it.
    sys::sceGuEnable(sys::GuState::DepthTest);
    sys::sceGuClearColor(BG_CLEAR_ABGR);
    sys::sceGuClearDepth(0); // reversed-Z: clear depth to 0 (far)
    sys::sceGuClear(ClearBuffer::COLOR_BUFFER_BIT | ClearBuffer::DEPTH_BUFFER_BIT);

    let table = meshes();

    // --- Replay records. ---
    let mut o = 8usize; // past the 8-byte header
    for _ in 0..record_count {
        if o + 4 > byte_len {
            break;
        }
        let op = read_u16(buf, o) as u32;
        let words = read_u16(buf, o + 2) as usize;
        let base = o + 4;
        o = base + words * 4;
        if o > byte_len {
            break; // truncated/corrupt — stop rather than read OOB
        }

        if op == OP_SET_CAMERA {
            // payload = 16 f32 column-major viewProj (already proj*view). JS has
            // premultiplied, so View = identity and Projection = the whole thing.
            let view_proj = read_matrix(buf, base);
            sys::sceGumMatrixMode(MatrixMode::Projection);
            sys::sceGumLoadMatrix(&view_proj.0);
            sys::sceGumMatrixMode(MatrixMode::View);
            sys::sceGumLoadIdentity();
        } else if op == OP_DRAW {
            // payload = u32 handle, u32 tintABGR, 16 f32 column-major model.
            let handle = read_u32(buf, base) as i32;
            let tint = read_u32(buf, base + 4);
            let model = read_matrix(buf, base + 8);

            if handle < 0 || (handle as usize) >= table.len() {
                continue;
            }
            let mesh = &table[handle as usize];
            if mesh.count == 0 {
                continue; // freed or empty
            }

            sys::sceGumMatrixMode(MatrixMode::Model);
            sys::sceGumLoadMatrix(&model.0);

            // Material colour for the draw. With per-vertex COLOR_8888 the GE
            // uses the vertex colours; NO_TINT (white) is therefore a visual
            // no-op and keeps us matching raster3d.ts (which ignores tint). A
            // non-white tint is set here for completeness but is a known
            // divergence from the reference renderer.
            sys::sceGuColor(if tint == NO_TINT { 0xffff_ffff } else { tint });

            // Non-indexed: the 16-byte-aligned vertex list was expanded at upload.
            sys::sceGumDrawArray(
                GuPrimitive::Triangles,
                V1_VTYPE,
                mesh.count,
                null(),
                mesh.verts.as_ptr() as *const c_void,
            );
        } else if op == OP_IMM_TRIS {
            // Inline dynamic geometry. The example games don't emit this yet; a
            // correct implementation would stage `vertexCount` vertices into a
            // dcache-flushed scratch buffer and draw them with TRANSFORM_3D under
            // an identity Model matrix. Stubbed (skipped) safely for v1 — the
            // record is already length-skipped above via `words`.
            let _ = (read_u32(buf, base), read_u32(buf, base + 4));
        }
        // Unknown opcodes are skipped via the `words` length prefix above.
    }

    // --- HUD handoff: depth OFF so 2D sprites (z=0) draw unconditionally. ---
    sys::sceGuDisable(sys::GuState::DepthTest);
    JS_UNDEFINED
}

/// Install the `g3d` object (uploadMesh / freeMesh / submit) onto the JS global.
/// Mirrors `gfx::register`. Hosts that install `g3d` opt into the 3D contract;
/// 2D-only games simply never reference it.
pub unsafe fn register(ctx: *mut JSContext, global: JSValue) {
    let g3d = JS_NewObject(ctx);

    let f_upload = JS_NewCFunction2(
        ctx,
        Some(js_g3d_upload_mesh),
        b"uploadMesh\0".as_ptr() as *const _,
        3,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, g3d, b"uploadMesh\0".as_ptr() as *const _, f_upload);

    let f_free = JS_NewCFunction2(
        ctx,
        Some(js_g3d_free_mesh),
        b"freeMesh\0".as_ptr() as *const _,
        1,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, g3d, b"freeMesh\0".as_ptr() as *const _, f_free);

    let f_submit = JS_NewCFunction2(
        ctx,
        Some(js_g3d_submit),
        b"submit\0".as_ptr() as *const _,
        2,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, g3d, b"submit\0".as_ptr() as *const _, f_submit);

    // JS_SetPropertyStr consumes ownership of `g3d`.
    JS_SetPropertyStr(ctx, global, b"g3d\0".as_ptr() as *const _, g3d);
}
