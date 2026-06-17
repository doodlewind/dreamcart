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
    self, ClearBuffer, GuPrimitive, GuState, LightComponent, LightType, MatrixMode, MipmapLevel,
    ScePspFMatrix4, ScePspFVector3, TextureColorComponent, TextureEffect, TextureFilter,
    TexturePixelFormat, VertexType,
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
//   DC3D_VERSION = 0x0002
//   OP_SET_CAMERA = 0x0001
//   OP_DRAW = 0x0002
//   OP_IMM_TRIS = 0x0003
//   OP_BIND_TEXTURE = 0x0004
//   OP_SET_LIGHTS = 0x0005
//   OP_DRAW_SKINNED = 0x0006
//   OP_SET_FOG = 0x0007
//   FMT_POS = 0x0001
//   FMT_COLOR = 0x0002
//   FMT_NORMAL = 0x0004
//   FMT_UV = 0x0008
//   FMT_WEIGHTS = 0x0010
// ---------------------------------------------------------------------------

const DC3D_MAGIC: u32 = 0x4443_3344; // 'DC3D' little-endian
const DC3D_VERSION: u32 = 0x0002;

const OP_SET_CAMERA: u32 = 0x0001;
const OP_DRAW: u32 = 0x0002;
const OP_IMM_TRIS: u32 = 0x0003;
const OP_BIND_TEXTURE: u32 = 0x0004;
const OP_SET_LIGHTS: u32 = 0x0005;
const OP_DRAW_SKINNED: u32 = 0x0006;
const OP_SET_FOG: u32 = 0x0007;

// Vertex-format bitfield. The GE interleaves components in a FIXED order
// [weights][uv][color][normal][position] regardless of bit value.
const FMT_POS: u32 = 0x0001;
const FMT_COLOR: u32 = 0x0002;
const FMT_NORMAL: u32 = 0x0004;
const FMT_UV: u32 = 0x0008;
const FMT_WEIGHTS: u32 = 0x0010;

/// No-tint sentinel: full white, fully opaque ABGR.
const NO_TINT: u32 = 0xffff_ffff;

/// Background the 3D pass clears the color buffer to — RGB(0x10, 0x14, 0x1e),
/// matching `BG_R/BG_G/BG_B` in raster3d.ts. Packed into PSP ABGR (opaque).
const BG_CLEAR_ABGR: u32 = 0xff00_0000 | (0x1e << 16) | (0x14 << 8) | 0x10;

/// One 16-byte chunk, 16-byte aligned. The GE reads geometry and textures
/// straight from RAM and (like the 2D sprite path in `gfx.rs` and the cube
/// example) needs the buffer 16-byte aligned — a plain `Vec<u8>` only guarantees
/// 1-byte alignment, which makes the GE read garbage. A `Vec<Chunk16>` allocates
/// 16-aligned because the element alignment is 16; we size it to ceil(bytes/16)
/// and copy the (variable-stride) payload in. Per-vertex 4-byte alignment is
/// guaranteed by the bake/encoder keeping every component 4-byte and the stride a
/// multiple of 4.
#[repr(C, align(16))]
#[derive(Copy, Clone)]
struct Chunk16([u8; 16]);

/// Allocate a 16-byte-aligned buffer of `len` bytes and copy `src[..len]` into it.
unsafe fn aligned_copy(src: *const u8, len: usize) -> Vec<Chunk16> {
    let nchunks = (len + 15) / 16;
    let mut v: Vec<Chunk16> = alloc::vec![Chunk16([0u8; 16]); nchunks.max(1)];
    if len > 0 {
        core::ptr::copy_nonoverlapping(src, v.as_mut_ptr() as *mut u8, len);
    }
    v
}

/// Bytes per vertex for a format+weight count. MUST match `vertexStride` in
/// framework/src/g3d.ts (GE order `[weights][uv][color][normal][pos]`).
fn stride_for(format: u32, weight_count: u32) -> usize {
    let mut s = 0usize;
    if format & FMT_WEIGHTS != 0 {
        s += weight_count as usize * 4;
    }
    if format & FMT_UV != 0 {
        s += 8;
    }
    if format & FMT_COLOR != 0 {
        s += 4;
    }
    if format & FMT_NORMAL != 0 {
        s += 12;
    }
    if format & FMT_POS != 0 {
        s += 12;
    }
    s
}

/// `WEIGHTSn` vertex-type bits for n bone weights (the GE blends the first n of
/// the 8 bone matrices). 0 selects none.
fn weights_bits(n: u32) -> i32 {
    match n {
        1 => VertexType::WEIGHTS1.bits(),
        2 => VertexType::WEIGHTS2.bits(),
        3 => VertexType::WEIGHTS3.bits(),
        4 => VertexType::WEIGHTS4.bits(),
        5 => VertexType::WEIGHTS5.bits(),
        6 => VertexType::WEIGHTS6.bits(),
        7 => VertexType::WEIGHTS7.bits(),
        8 => VertexType::WEIGHTS8.bits(),
        _ => 0,
    }
}

/// The GE `VertexType` for a mesh, built ONCE at upload from its format. Always
/// `VERTEX_32BITF | TRANSFORM_3D`; COLOR/NORMAL/TEXTURE/WEIGHT bits are added per
/// the format. The component *order* the GE reads is fixed regardless of bits.
fn vtype_for(format: u32, weight_count: u32) -> VertexType {
    let mut bits = VertexType::VERTEX_32BITF.bits() | VertexType::TRANSFORM_3D.bits();
    if format & FMT_COLOR != 0 {
        bits |= VertexType::COLOR_8888.bits();
    }
    if format & FMT_NORMAL != 0 {
        bits |= VertexType::NORMAL_32BITF.bits();
    }
    if format & FMT_UV != 0 {
        bits |= VertexType::TEXTURE_32BITF.bits();
    }
    if format & FMT_WEIGHTS != 0 {
        bits |= VertexType::WEIGHT_32BITF.bits() | weights_bits(weight_count);
    }
    VertexType::from_bits_truncate(bits)
}

/// Map the wire PSM value to the GE texture pixel format (see g3d.ts PSM_*).
fn psm_for(psm: u32) -> TexturePixelFormat {
    match psm {
        0 => TexturePixelFormat::Psm5650,
        1 => TexturePixelFormat::Psm5551,
        2 => TexturePixelFormat::Psm4444,
        5 => TexturePixelFormat::PsmT8,
        _ => TexturePixelFormat::Psm8888,
    }
}

/// A retained mesh: an owned, 16-byte-aligned, NON-indexed, variable-stride vertex
/// buffer in main RAM (the qjs_alloc heap), dcache-flushed once at upload. Indexed
/// input is expanded to a flat vertex list here so the draw path is non-indexed.
struct MeshEntry {
    bytes: Vec<Chunk16>,
    /// Number of vertices to draw (3 per triangle).
    count: i32,
    /// Precomputed GE vertex type (color/normal/uv/weight bits per the format).
    /// The GE derives the per-vertex stride from these bits, so we don't store it.
    vtype: VertexType,
}

/// A retained texture: 16-byte-aligned pixel bytes + the GE sampler params.
struct TextureEntry {
    pixels: Vec<Chunk16>,
    w: i32,
    h: i32,
    /// Texture buffer width in texels (row stride); equals `w` for our uploads.
    tbw: i32,
    psm: u32,
}

/// The handle tables. `g3d` is only ever touched from the single-threaded JS
/// frame loop (QuickJS has no threads here), so an `UnsafeCell`-style `static
/// mut` matches the existing `no_std`/single-thread style of `main.rs`/`gfx.rs`
/// without paying for a Mutex. A handle is just the index into the Vec.
static mut MESHES: Option<Vec<MeshEntry>> = None;
static mut TEXTURES: Option<Vec<TextureEntry>> = None;

// ── Retained native scene ────────────────────────────────────────────────────
// A list of static draw instances uploaded ONCE from JS (sceneAdd). Per frame JS
// calls sceneRender(camera) and the native side frustum-culls + draws the whole
// list — moving the per-node cull/matrix/encode math off the interpreted QuickJS
// core (where it costs ~1ms/node) to native (~free). See docs/psp-native-scene.md.
struct SceneInstance {
    handle: i32,
    tex: i32, // texture handle or -1
    tint: u32,
    model: [f32; 16],   // world matrix, column-major
    amin: [f32; 3],     // world-space AABB
    amax: [f32; 3],
}
struct SceneLight {
    color: u32,
    dir: [f32; 3],
}
struct SceneEnv {
    ambient: u32,
    lights: Vec<SceneLight>, // ≤4
    fog: Option<(u32, f32, f32)>, // color, near, far
}
static mut SCENE: Option<Vec<SceneInstance>> = None;
static mut SCENE_ENV: Option<SceneEnv> = None;

#[inline]
unsafe fn meshes() -> &'static mut Vec<MeshEntry> {
    if MESHES.is_none() {
        MESHES = Some(Vec::new());
    }
    MESHES.as_mut().unwrap()
}

#[inline]
unsafe fn textures() -> &'static mut Vec<TextureEntry> {
    if TEXTURES.is_none() {
        TEXTURES = Some(Vec::new());
    }
    TEXTURES.as_mut().unwrap()
}

#[inline]
unsafe fn scene() -> &'static mut Vec<SceneInstance> {
    if SCENE.is_none() {
        SCENE = Some(Vec::new());
    }
    SCENE.as_mut().unwrap()
}

/// Program the GE sampler for texture `th` (or disable texturing if `th` is the
/// 0xffffffff unbind sentinel / out of range). Shared by the per-frame submit
/// path (OP_BIND_TEXTURE) and the retained-scene render.
unsafe fn apply_texture(tex_table: &[TextureEntry], th: u32) {
    if th == 0xffff_ffff {
        sys::sceGuDisable(GuState::Texture2D);
    } else if (th as usize) < tex_table.len() {
        let t = &tex_table[th as usize];
        sys::sceGuEnable(GuState::Texture2D);
        sys::sceGuTexMode(psm_for(t.psm), 0, 0, 0);
        sys::sceGuTexImage(MipmapLevel::None, t.w, t.h, t.tbw, t.pixels.as_ptr() as *const c_void);
        sys::sceGuTexFunc(TextureEffect::Modulate, TextureColorComponent::Rgba);
        sys::sceGuTexFilter(TextureFilter::Linear, TextureFilter::Linear);
        sys::sceGuTexScale(1.0, 1.0);
        sys::sceGuTexOffset(0.0, 0.0);
    }
}

/// Copy 16 f32 (column-major) into a VFPU-aligned ScePspFMatrix4 for sceGumLoadMatrix.
#[inline]
unsafe fn align_mat(m: &[f32; 16]) -> Align16<ScePspFMatrix4> {
    let mut a = Align16(ScePspFMatrix4 {
        x: sys::ScePspFVector4 { x: 0.0, y: 0.0, z: 0.0, w: 0.0 },
        y: sys::ScePspFVector4 { x: 0.0, y: 0.0, z: 0.0, w: 0.0 },
        z: sys::ScePspFVector4 { x: 0.0, y: 0.0, z: 0.0, w: 0.0 },
        w: sys::ScePspFVector4 { x: 0.0, y: 0.0, z: 0.0, w: 0.0 },
    });
    core::ptr::copy_nonoverlapping(
        m.as_ptr() as *const u8,
        &mut a.0 as *mut ScePspFMatrix4 as *mut u8,
        64,
    );
    a
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

    // --- Borrow the source vertex bytes (interleaved at `stride`). ---
    let mut vlen: size_t = 0;
    let vptr = JS_GetArrayBuffer(ctx, &mut vlen, *argv.offset(0));
    if vptr.is_null() || vlen == 0 {
        return JS_NewInt32(ctx, -1);
    }

    let format = arg_i32(ctx, argc, argv, 2) as u32;
    // POS is required; COLOR/UV/NORMAL are optional (v1's POS|COLOR is a subset).
    // Reject a POS-less format loudly via a -1 handle so the game fails fast
    // rather than rendering garbage (matches raster3d.ts).
    if (format & FMT_POS) == 0 {
        return JS_NewInt32(ctx, -1);
    }
    // weightCount (the 4th arg) is only meaningful for skinned meshes (FMT_WEIGHTS,
    // M4+); 0 for the static textured/lit meshes here.
    let weight_count = arg_i32(ctx, argc, argv, 3) as u32;
    let stride = stride_for(format, weight_count);
    if stride == 0 {
        return JS_NewInt32(ctx, -1);
    }
    // Silence "unused" on constants not consumed in this function while keeping
    // them defined for the contract parity check (DC3D_VERSION is in the header).
    let _ = DC3D_VERSION;

    let src_vert_count = vlen as usize / stride;

    // Build the list of source vertex indices to draw (expand the index buffer if
    // present), then copy those (variable-stride) vertices into one 16-aligned,
    // NON-indexed buffer — the proven cube-example draw path.
    let mut src_idx: Vec<usize> = Vec::new();
    let indices_arg = *argv.offset(1);
    if !JS_IsNull(indices_arg) && !JS_IsUndefined(indices_arg) {
        let mut ilen: size_t = 0;
        let iptr = JS_GetArrayBuffer(ctx, &mut ilen, indices_arg);
        if !iptr.is_null() && ilen >= 2 {
            let n = ilen as usize / 2;
            src_idx.reserve(n);
            for i in 0..n {
                // wire indices are little-endian u16.
                let idx = (*iptr.add(i * 2) as usize) | ((*iptr.add(i * 2 + 1) as usize) << 8);
                if idx < src_vert_count {
                    src_idx.push(idx);
                }
            }
        }
    } else {
        src_idx.reserve(src_vert_count);
        for i in 0..src_vert_count {
            src_idx.push(i);
        }
    }
    if src_idx.is_empty() {
        return JS_NewInt32(ctx, -1);
    }

    let count = src_idx.len();
    let total = count * stride;
    let nchunks = ((total + 15) / 16).max(1);
    let mut bytes: Vec<Chunk16> = alloc::vec![Chunk16([0u8; 16]); nchunks];
    let dst = bytes.as_mut_ptr() as *mut u8;
    for (k, &si) in src_idx.iter().enumerate() {
        core::ptr::copy_nonoverlapping(vptr.add(si * stride), dst.add(k * stride), stride);
    }

    // The GE reads geometry from RAM, not the CPU cache — flush the copy once.
    sys::sceKernelDcacheWritebackRange(bytes.as_ptr() as *const c_void, (bytes.len() * 16) as u32);

    let table = meshes();
    let handle = table.len() as i32;
    table.push(MeshEntry {
        bytes,
        count: count as i32,
        vtype: vtype_for(format, weight_count),
    });
    JS_NewInt32(ctx, handle)
}

/// `g3d.uploadTexture(pixels: ArrayBuffer, w, h, psm)` -> int handle.
///
/// COPIES the borrowed QuickJS pixel bytes into an owned, 16-byte-aligned `Vec`
/// (the GE samples from RAM and requires 16-byte texture alignment), dcache-
/// flushes once, and stores `{ptr,w,h,tbw,psm}` in the TEXTURES table. Validates
/// power-of-two dims ≤ 512 (the GE hardware limit).
unsafe extern "C" fn js_g3d_upload_texture(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 4 {
        return JS_NewInt32(ctx, -1);
    }
    let mut plen: size_t = 0;
    let pptr = JS_GetArrayBuffer(ctx, &mut plen, *argv.offset(0));
    if pptr.is_null() || plen == 0 {
        return JS_NewInt32(ctx, -1);
    }
    let w = arg_i32(ctx, argc, argv, 1);
    let h = arg_i32(ctx, argc, argv, 2);
    let psm = arg_i32(ctx, argc, argv, 3) as u32;
    // power-of-two and 1..=512 (GE hardware limits).
    let pow2 = |n: i32| n > 0 && (n & (n - 1)) == 0;
    if !pow2(w) || !pow2(h) || w > 512 || h > 512 {
        return JS_NewInt32(ctx, -1);
    }

    let pixels = aligned_copy(pptr, plen as usize);
    sys::sceKernelDcacheWritebackRange(pixels.as_ptr() as *const c_void, (pixels.len() * 16) as u32);

    let table = textures();
    let handle = table.len() as i32;
    table.push(TextureEntry {
        pixels,
        w,
        h,
        tbw: w,
        psm,
    });
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
        e.bytes = Vec::new();
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
/// `x/y/z/w` with NO transpose (verified on PPSSPP). (Note: the 3DS host DOES
/// transpose into its row-major `C3D_Mtx` — opposite choice, both correct for
/// each GPU's dot-product convention.)
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

/// Read a little-endian f32 from the wire buffer at `base + off`.
#[inline]
unsafe fn read_f32(base: *const u8, off: usize) -> f32 {
    f32::from_bits(read_u32(base, off))
}

/// Read a 12-float (3×4 affine) bone matrix from the wire into a ScePspFMatrix4.
/// Wire order is col0.xyz, col1.xyz, col2.xyz, col3.xyz; `sceGuBoneMatrix` reads
/// `.x/.y/.z` of each of the 4 columns (the homogeneous w-row is dropped — exact
/// for affine joint transforms), so we place each column's xyz and zero its w.
#[inline]
unsafe fn read_bone_matrix(base: *const u8, off: usize) -> ScePspFMatrix4 {
    let f = |i: usize| read_f32(base, off + i * 4);
    ScePspFMatrix4 {
        x: sys::ScePspFVector4 { x: f(0), y: f(1), z: f(2), w: 0.0 },
        y: sys::ScePspFVector4 { x: f(3), y: f(4), z: f(5), w: 0.0 },
        z: sys::ScePspFVector4 { x: f(6), y: f(7), z: f(8), w: 0.0 },
        w: sys::ScePspFVector4 { x: f(9), y: f(10), z: f(11), w: 0.0 },
    }
}

/// `GuState::Light0 + i` for light slot `i` (0..3).
#[inline]
fn light_state(i: u32) -> GuState {
    match i {
        0 => GuState::Light0,
        1 => GuState::Light1,
        2 => GuState::Light2,
        _ => GuState::Light3,
    }
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
    // init_graphics() configured DepthRange(0,65535) + DepthFunc(GEQUAL) for the
    // reversed-Z convention; re-enable DepthTest defensively (a prior frame's HUD
    // pass disabled it).
    sys::sceGuEnable(sys::GuState::DepthTest);
    sys::sceGuClearColor(BG_CLEAR_ABGR);
    sys::sceGuClearDepth(0); // reversed-Z: clear depth to 0 (far)
    sys::sceGuClear(ClearBuffer::COLOR_BUFFER_BIT | ClearBuffer::DEPTH_BUFFER_BIT);

    let table = meshes();
    let tex_table = textures();

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

            // Non-indexed: the 16-byte-aligned vertex list was expanded at upload;
            // its precomputed VertexType carries the color/uv/normal bits.
            sys::sceGumDrawArray(
                GuPrimitive::Triangles,
                mesh.vtype,
                mesh.count,
                null(),
                mesh.bytes.as_ptr() as *const c_void,
            );
        } else if op == OP_BIND_TEXTURE {
            // payload = u32 texHandle (0xffffffff = unbind). Texture state is
            // sticky on the GE, so this just programs the sampler; subsequent
            // OP_DRAWs use it until the next bind/unbind.
            apply_texture(tex_table, read_u32(buf, base));
        } else if op == OP_SET_LIGHTS {
            // payload = u32 count, u32 ambientABGR, count×{u32 colorABGR, 3 f32 dir}.
            let count = read_u32(buf, base);
            let ambient = read_u32(buf, base + 4);
            sys::sceGuAmbient(ambient);
            // Vertex COLOR_8888 acts as the ambient+diffuse material so per-vertex
            // colour still tints the lit result (× any bound texture).
            sys::sceGuColorMaterial(LightComponent::AMBIENT | LightComponent::DIFFUSE);
            let mut i = 0u32;
            while i < count && i < 4 {
                let lo = base + 8 + (i as usize) * 16;
                let color = read_u32(buf, lo);
                let dir = ScePspFVector3 {
                    x: read_f32(buf, lo + 4),
                    y: read_f32(buf, lo + 8),
                    z: read_f32(buf, lo + 12),
                };
                sys::sceGuLight(i as i32, LightType::Directional, LightComponent::DIFFUSE, &dir);
                sys::sceGuLightColor(i as i32, LightComponent::DIFFUSE, color);
                sys::sceGuEnable(light_state(i));
                i += 1;
            }
            sys::sceGuEnable(GuState::Lighting);
        } else if op == OP_SET_FOG {
            // payload = u32 colorABGR, f32 near, f32 far (0xffffffff = disable).
            let color = read_u32(buf, base);
            if color == 0xffff_ffff {
                sys::sceGuDisable(GuState::Fog);
            } else {
                let near = read_f32(buf, base + 4);
                let far = read_f32(buf, base + 8);
                sys::sceGuFog(near, far, color);
                sys::sceGuEnable(GuState::Fog);
            }
        } else if op == OP_DRAW_SKINNED {
            // payload = u32 handle, u32 tintABGR, u32 boneCount, 16 f32 model,
            // boneCount×12 f32 (3×4 affine bone matrices). The GE blends the first
            // boneCount bone matrices per-vertex by the mesh's WEIGHTSn, then
            // applies Model·View·Proj — so bones are character-local
            // (jointWorld·inverseBind) and Model places the character.
            let handle = read_u32(buf, base) as i32;
            let tint = read_u32(buf, base + 4);
            let bone_count = read_u32(buf, base + 8);
            let model = read_matrix(buf, base + 12);

            if handle < 0 || (handle as usize) >= table.len() {
                continue;
            }
            let mesh = &table[handle as usize];
            if mesh.count == 0 {
                continue;
            }

            sys::sceGumMatrixMode(MatrixMode::Model);
            sys::sceGumLoadMatrix(&model.0);
            sys::sceGuColor(if tint == NO_TINT { 0xffff_ffff } else { tint });

            // Bone matrices follow the 16-float (64-byte) model in the payload.
            let bones_base = base + 12 + 64;
            let mut i = 0u32;
            while i < bone_count && i < 8 {
                let bm = read_bone_matrix(buf, bones_base + (i as usize) * 48);
                sys::sceGuBoneMatrix(i, &bm);
                i += 1;
            }

            sys::sceGumDrawArray(
                GuPrimitive::Triangles,
                mesh.vtype, // carries WEIGHT_32BITF | WEIGHTSn
                mesh.count,
                null(),
                mesh.bytes.as_ptr() as *const c_void,
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

    // --- HUD handoff: depth OFF so 2D sprites (z=0) draw unconditionally, and
    // texturing/lighting OFF so the 2D pass (untextured, unlit TRANSFORM_2D
    // sprites) is unaffected and the next frame starts from a clean state. ---
    sys::sceGuDisable(sys::GuState::DepthTest);
    sys::sceGuDisable(GuState::Texture2D);
    sys::sceGuDisable(GuState::Lighting);
    sys::sceGuDisable(GuState::Fog);
    JS_UNDEFINED
}

// ── Retained native scene FFI ────────────────────────────────────────────────

/// `g3d.sceneClear()` — drop all retained static instances + env (rebuild start).
unsafe extern "C" fn js_g3d_scene_clear(
    _ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    SCENE = Some(Vec::new());
    SCENE_ENV = None;
    JS_UNDEFINED
}

/// `g3d.sceneAdd(handle, tex, tint, geom: ArrayBuffer)` — append one static draw
/// instance. `geom` is 22 f32: 16 model (column-major) + 3 aabbMin + 3 aabbMax.
unsafe extern "C" fn js_g3d_scene_add(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 4 {
        return JS_UNDEFINED;
    }
    let handle = arg_i32(ctx, argc, argv, 0);
    let tex = arg_i32(ctx, argc, argv, 1);
    let tint = arg_i32(ctx, argc, argv, 2) as u32;
    let mut len: size_t = 0;
    let p = JS_GetArrayBuffer(ctx, &mut len, *argv.offset(3));
    if p.is_null() || (len as usize) < 22 * 4 {
        return JS_UNDEFINED;
    }
    let mut model = [0f32; 16];
    for i in 0..16 {
        model[i] = read_f32(p, i * 4);
    }
    let amin = [read_f32(p, 64), read_f32(p, 68), read_f32(p, 72)];
    let amax = [read_f32(p, 76), read_f32(p, 80), read_f32(p, 84)];
    scene().push(SceneInstance { handle, tex, tint, model, amin, amax });
    JS_UNDEFINED
}

/// `g3d.sceneSetEnv(env: ArrayBuffer|null)` — set lighting + fog for the scene.
/// Layout: u32 lightCount, u32 ambientABGR, count×{u32 colorABGR, 3 f32 dir},
/// then u32 fogColorABGR (0xffffffff = no fog), f32 near, f32 far.
unsafe extern "C" fn js_g3d_scene_set_env(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_UNDEFINED;
    }
    let arg = *argv.offset(0);
    if JS_IsNull(arg) || JS_IsUndefined(arg) {
        SCENE_ENV = None;
        return JS_UNDEFINED;
    }
    let mut len: size_t = 0;
    let p = JS_GetArrayBuffer(ctx, &mut len, arg);
    if p.is_null() {
        SCENE_ENV = None;
        return JS_UNDEFINED;
    }
    let count = read_u32(p, 0).min(4);
    let ambient = read_u32(p, 4);
    let mut lights = Vec::new();
    let mut o = 8usize;
    for _ in 0..count {
        let color = read_u32(p, o);
        let dir = [read_f32(p, o + 4), read_f32(p, o + 8), read_f32(p, o + 12)];
        lights.push(SceneLight { color, dir });
        o += 16;
    }
    let fog_color = read_u32(p, o);
    let fog = if fog_color == 0xffff_ffff {
        None
    } else {
        Some((fog_color, read_f32(p, o + 4), read_f32(p, o + 8)))
    };
    SCENE_ENV = Some(SceneEnv { ambient, lights, fog });
    JS_UNDEFINED
}

/// `g3d.sceneRender(camera: ArrayBuffer)` — THE per-frame retained-scene call.
/// `camera` is 20 f32: 16 viewProj (column-major) + 3 eye + 1 cull-far. Clears,
/// sets the camera + env, frustum-culls every retained instance NATIVELY, and
/// draws the visible ones. Replaces the JS command-buffer build+submit for an
/// all-static scene, so JS per-frame work is just packing the camera.
unsafe extern "C" fn js_g3d_scene_render(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_UNDEFINED;
    }
    let mut len: size_t = 0;
    let p = JS_GetArrayBuffer(ctx, &mut len, *argv.offset(0));
    if p.is_null() || (len as usize) < 20 * 4 {
        return JS_UNDEFINED;
    }
    let mut vp = [0f32; 16];
    for i in 0..16 {
        vp[i] = read_f32(p, i * 4);
    }
    let ex = read_f32(p, 64);
    let ey = read_f32(p, 68);
    let ez = read_f32(p, 72);
    let far2 = read_f32(p, 76) * read_f32(p, 76);

    // Frustum side planes (Gribb-Hartmann) from the column-major viewProj:
    // rows r_i = [m[i], m[4+i], m[8+i], m[12+i]]; left=r3+r0, right=r3-r0, etc.
    let r0 = [vp[0], vp[4], vp[8], vp[12]];
    let r1 = [vp[1], vp[5], vp[9], vp[13]];
    let r3 = [vp[3], vp[7], vp[11], vp[15]];
    let planes = [
        [r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]],
        [r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]],
        [r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]],
        [r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]],
    ];

    // 3D pass setup (mirrors submit).
    sys::sceGuEnable(GuState::DepthTest);
    sys::sceGuClearColor(BG_CLEAR_ABGR);
    sys::sceGuClearDepth(0);
    sys::sceGuClear(ClearBuffer::COLOR_BUFFER_BIT | ClearBuffer::DEPTH_BUFFER_BIT);
    let vpm = align_mat(&vp);
    sys::sceGumMatrixMode(MatrixMode::Projection);
    sys::sceGumLoadMatrix(&vpm.0);
    sys::sceGumMatrixMode(MatrixMode::View);
    sys::sceGumLoadIdentity();

    if let Some(env) = SCENE_ENV.as_ref() {
        if !env.lights.is_empty() {
            sys::sceGuAmbient(env.ambient);
            sys::sceGuColorMaterial(LightComponent::AMBIENT | LightComponent::DIFFUSE);
            let mut i = 0usize;
            for l in env.lights.iter().take(4) {
                let dir = ScePspFVector3 { x: l.dir[0], y: l.dir[1], z: l.dir[2] };
                sys::sceGuLight(i as i32, LightType::Directional, LightComponent::DIFFUSE, &dir);
                sys::sceGuLightColor(i as i32, LightComponent::DIFFUSE, l.color);
                sys::sceGuEnable(light_state(i as u32));
                i += 1;
            }
            sys::sceGuEnable(GuState::Lighting);
        }
        if let Some((fc, fnear, ffar)) = env.fog {
            sys::sceGuFog(fnear, ffar, fc);
            sys::sceGuEnable(GuState::Fog);
        }
    }

    let table = meshes();
    let tex_table = textures();
    let insts = scene();
    let mut bound_tex: i32 = -1; // matches the JS flat path (frame starts unbound)
    let mut drawn: i32 = 0;
    for inst in insts.iter() {
        // Frustum cull: 4 side planes (positive-vertex test) + far-distance cutoff.
        let mut culled = false;
        for pl in planes.iter() {
            let px = if pl[0] >= 0.0 { inst.amax[0] } else { inst.amin[0] };
            let py = if pl[1] >= 0.0 { inst.amax[1] } else { inst.amin[1] };
            let pz = if pl[2] >= 0.0 { inst.amax[2] } else { inst.amin[2] };
            if pl[0] * px + pl[1] * py + pl[2] * pz + pl[3] < 0.0 {
                culled = true;
                break;
            }
        }
        if !culled {
            let cx = (inst.amin[0] + inst.amax[0]) * 0.5 - ex;
            let cy = (inst.amin[1] + inst.amax[1]) * 0.5 - ey;
            let cz = (inst.amin[2] + inst.amax[2]) * 0.5 - ez;
            if cx * cx + cy * cy + cz * cz > far2 {
                culled = true;
            }
        }
        if culled {
            continue;
        }
        if inst.handle < 0 || (inst.handle as usize) >= table.len() {
            continue;
        }
        let mesh = &table[inst.handle as usize];
        if mesh.count == 0 {
            continue;
        }
        if inst.tex != bound_tex {
            apply_texture(tex_table, if inst.tex < 0 { 0xffff_ffff } else { inst.tex as u32 });
            bound_tex = inst.tex;
        }
        let mm = align_mat(&inst.model);
        sys::sceGumMatrixMode(MatrixMode::Model);
        sys::sceGumLoadMatrix(&mm.0);
        sys::sceGuColor(if inst.tint == NO_TINT { 0xffff_ffff } else { inst.tint });
        sys::sceGumDrawArray(
            GuPrimitive::Triangles,
            mesh.vtype,
            mesh.count,
            null(),
            mesh.bytes.as_ptr() as *const c_void,
        );
        drawn += 1;
    }

    // HUD handoff (same as submit).
    sys::sceGuDisable(GuState::DepthTest);
    sys::sceGuDisable(GuState::Texture2D);
    sys::sceGuDisable(GuState::Lighting);
    sys::sceGuDisable(GuState::Fog);
    JS_NewInt32(ctx, drawn) // visible count, so JS can report culling
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

    let f_upload_tex = JS_NewCFunction2(
        ctx,
        Some(js_g3d_upload_texture),
        b"uploadTexture\0".as_ptr() as *const _,
        4,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, g3d, b"uploadTexture\0".as_ptr() as *const _, f_upload_tex);

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

    // Retained native scene: sceneClear / sceneAdd / sceneSetEnv / sceneRender.
    let f_sclear = JS_NewCFunction2(ctx, Some(js_g3d_scene_clear), b"sceneClear\0".as_ptr() as *const _, 0, JS_CFUNC_generic, 0);
    JS_SetPropertyStr(ctx, g3d, b"sceneClear\0".as_ptr() as *const _, f_sclear);
    let f_sadd = JS_NewCFunction2(ctx, Some(js_g3d_scene_add), b"sceneAdd\0".as_ptr() as *const _, 4, JS_CFUNC_generic, 0);
    JS_SetPropertyStr(ctx, g3d, b"sceneAdd\0".as_ptr() as *const _, f_sadd);
    let f_senv = JS_NewCFunction2(ctx, Some(js_g3d_scene_set_env), b"sceneSetEnv\0".as_ptr() as *const _, 1, JS_CFUNC_generic, 0);
    JS_SetPropertyStr(ctx, g3d, b"sceneSetEnv\0".as_ptr() as *const _, f_senv);
    let f_srender = JS_NewCFunction2(ctx, Some(js_g3d_scene_render), b"sceneRender\0".as_ptr() as *const _, 1, JS_CFUNC_generic, 0);
    JS_SetPropertyStr(ctx, g3d, b"sceneRender\0".as_ptr() as *const _, f_srender);

    // JS_SetPropertyStr consumes ownership of `g3d`.
    JS_SetPropertyStr(ctx, global, b"g3d\0".as_ptr() as *const _, g3d);
}
