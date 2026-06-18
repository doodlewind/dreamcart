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
const OP_DRAW_SKIN_ANIM: u32 = 0x0009;

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

/// Column-major 4×4 multiply r = a·b (m[col*4 + row]).
#[inline]
fn mat_mul4(a: &[f32; 16], b: &[f32; 16]) -> [f32; 16] {
    let mut r = [0f32; 16];
    let mut col = 0;
    while col < 4 {
        let mut row = 0;
        while row < 4 {
            r[col * 4 + row] = a[row] * b[col * 4]
                + a[4 + row] * b[col * 4 + 1]
                + a[8 + row] * b[col * 4 + 2]
                + a[12 + row] * b[col * 4 + 3];
            row += 1;
        }
        col += 1;
    }
    r
}

// ── Native hardware skinning ─────────────────────────────────────────────────
// A retained skinned character: joint hierarchy + inverse-bind matrices + the
// bone-batch tables, uploaded ONCE (uploadSkin). Per frame JS ships only the
// clip phase (OP_DRAW_SKIN_ANIM); the native side samples the clip, walks the
// hierarchy, computes each bone = jointWorld·inverseBind, loads them
// with sceGuBoneMatrix, and draws — moving ~150 Mat4 ops/frame off QuickJS (the
// skinning was ~145 ms/frame in JS). See docs/psp-native-scene.md.
const MAX_JOINTS: usize = 64;
struct SkinBatch {
    mesh: i32,
    bone_count: i32,
    joints: [i32; 8],
}
struct SkinEntry {
    joint_count: usize,
    parents: Vec<i32>,            // joint_count
    inverse_bind: Vec<f32>,      // joint_count × 16
    batches: Vec<SkinBatch>,
}
static mut SKINS: Option<Vec<SkinEntry>> = None;
// Scratch world matrices for the hierarchy pass (single-threaded frame loop).
static mut SKIN_WORLD: [f32; MAX_JOINTS * 16] = [0.0; MAX_JOINTS * 16];
// Scratch per-joint LOCAL matrices, filled by the native clip sampler before the
// hierarchy pass (OP_DRAW_SKIN_ANIM). Distinct from SKIN_WORLD so the sampler and
// the hierarchy accumulation don't alias.
static mut SKIN_LOCAL: [f32; MAX_JOINTS * 16] = [0.0; MAX_JOINTS * 16];

#[inline]
unsafe fn skins() -> &'static mut Vec<SkinEntry> {
    if SKINS.is_none() {
        SKINS = Some(Vec::new());
    }
    SKINS.as_mut().unwrap()
}

// A retained animation clip: a fixed-fps table of per-joint local TRS, uploaded
// once (uploadClip). OP_DRAW_SKIN_ANIM samples it NATIVELY (lerp T/S, nlerp R),
// composes the per-joint local matrices, then walks the shared hierarchy + bone
// + draw logic — moving the per-joint sampler (~12 ms/frame for 24 joints
// of Float32Array math) off the interpreted QuickJS core. JS only tracks which
// clip plays and the clip phase; the mechanical interpolation runs here.
struct ClipEntry {
    joint_count: usize,
    frame_count: usize,
    t: Vec<f32>, // frame_count × joint_count × 3
    r: Vec<f32>, // frame_count × joint_count × 4
    s: Vec<f32>, // frame_count × joint_count × 3
}
static mut CLIPS: Option<Vec<ClipEntry>> = None;

#[inline]
unsafe fn clips() -> &'static mut Vec<ClipEntry> {
    if CLIPS.is_none() {
        CLIPS = Some(Vec::new());
    }
    CLIPS.as_mut().unwrap()
}

// Fast reciprocal square root (two Newton iterations) for nlerp normalization,
// avoiding a libm/intrinsics dependency in this no_std crate. ~1e-4 relative
// error — visually exact for quaternion interpolation. (OP_DRAW_SKIN_ANIM is a
// PSP-only fast path, never compared against the byte-exact JS golden oracle, so
// it need only match visually, not bit-for-bit, with anim.ts's dsqrt path.)
#[inline]
fn rsqrt(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let i = x.to_bits();
    let i = 0x5f37_59df - (i >> 1);
    let mut y = f32::from_bits(i);
    y = y * (1.5 - 0.5 * x * y * y);
    y = y * (1.5 - 0.5 * x * y * y);
    y
}

#[inline]
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[inline]
fn compose_trs(
    tx: f32,
    ty: f32,
    tz: f32,
    qx: f32,
    qy: f32,
    qz: f32,
    qw: f32,
    sx: f32,
    sy: f32,
    sz: f32,
) -> [f32; 16] {
    let xx = qx * qx;
    let yy = qy * qy;
    let zz = qz * qz;
    let xy = qx * qy;
    let xz = qx * qz;
    let yz = qy * qz;
    let wx = qw * qx;
    let wy = qw * qy;
    let wz = qw * qz;
    [
        (1.0 - 2.0 * (yy + zz)) * sx,
        2.0 * (xy + wz) * sx,
        2.0 * (xz - wy) * sx,
        0.0,
        2.0 * (xy - wz) * sy,
        (1.0 - 2.0 * (xx + zz)) * sy,
        2.0 * (yz + wx) * sy,
        0.0,
        2.0 * (xz + wy) * sz,
        2.0 * (yz - wx) * sz,
        (1.0 - 2.0 * (xx + yy)) * sz,
        0.0,
        tx,
        ty,
        tz,
        1.0,
    ]
}

/// Shared OP_DRAW_SKIN_ANIM implementation for both `submit()` and the retained
/// scene post-pass. Keep clip sampling, hierarchy accumulation, bone setup, and
/// batch drawing in one place so the two render paths cannot drift.
unsafe fn draw_skin_anim_native(
    mesh_table: &[MeshEntry],
    skin_table: &[SkinEntry],
    clip_table: &[ClipEntry],
    sh: i32,
    ch: i32,
    tint: u32,
    phase: f32,
    model: &Align16<ScePspFMatrix4>,
) {
    if sh < 0 || (sh as usize) >= skin_table.len() {
        return;
    }
    if ch < 0 || (ch as usize) >= clip_table.len() {
        return;
    }
    let skin = &skin_table[sh as usize];
    let clip = &clip_table[ch as usize];
    let jc = skin.joint_count;
    if jc == 0 || jc > MAX_JOINTS || clip.joint_count != jc || clip.frame_count == 0 {
        return;
    }

    // Inclusive endpoint mapping means phase=1 lands on the last frame; normal
    // playback sends [0,1), but clamping keeps malformed packets from
    // extrapolating past the baked frame table.
    let fc = clip.frame_count;
    let p = if phase.is_nan() { 0.0 } else { phase.max(0.0).min(1.0) };
    let fidx = if fc > 1 { p * (fc as f32 - 1.0) } else { 0.0 };
    let mut f0 = fidx as i32;
    let max_f0 = if fc >= 2 { (fc - 2) as i32 } else { 0 };
    if f0 < 0 {
        f0 = 0;
    }
    if f0 > max_f0 {
        f0 = max_f0;
    }
    let f1 = if fc >= 2 { f0 + 1 } else { 0 };
    let u = fidx - f0 as f32;
    let b0 = f0 as usize * jc;
    let b1 = f1 as usize * jc;

    let mut i = 0usize;
    while i < jc {
        let o3a = (b0 + i) * 3;
        let o3b = (b1 + i) * 3;
        let o4a = (b0 + i) * 4;
        let o4b = (b1 + i) * 4;
        let tx = lerp(clip.t[o3a], clip.t[o3b], u);
        let ty = lerp(clip.t[o3a + 1], clip.t[o3b + 1], u);
        let tz = lerp(clip.t[o3a + 2], clip.t[o3b + 2], u);
        let sx = lerp(clip.s[o3a], clip.s[o3b], u);
        let sy = lerp(clip.s[o3a + 1], clip.s[o3b + 1], u);
        let sz = lerp(clip.s[o3a + 2], clip.s[o3b + 2], u);

        let ax = clip.r[o4a];
        let ay = clip.r[o4a + 1];
        let az = clip.r[o4a + 2];
        let aw = clip.r[o4a + 3];
        let mut bx = clip.r[o4b];
        let mut by = clip.r[o4b + 1];
        let mut bz = clip.r[o4b + 2];
        let mut bw = clip.r[o4b + 3];
        if ax * bx + ay * by + az * bz + aw * bw < 0.0 {
            bx = -bx;
            by = -by;
            bz = -bz;
            bw = -bw;
        }
        let mut qx = lerp(ax, bx, u);
        let mut qy = lerp(ay, by, u);
        let mut qz = lerp(az, bz, u);
        let mut qw = lerp(aw, bw, u);
        let inv_len = rsqrt(qx * qx + qy * qy + qz * qz + qw * qw);
        qx *= inv_len;
        qy *= inv_len;
        qz *= inv_len;
        qw *= inv_len;

        let local = compose_trs(tx, ty, tz, qx, qy, qz, qw, sx, sy, sz);
        core::ptr::copy_nonoverlapping(
            local.as_ptr(),
            SKIN_LOCAL.as_mut_ptr().add(i * 16),
            16,
        );
        i += 1;
    }

    i = 0;
    while i < jc {
        let mut local = [0f32; 16];
        local.copy_from_slice(&SKIN_LOCAL[i * 16..i * 16 + 16]);
        let parent = skin.parents[i];
        let world = if parent >= 0 && (parent as usize) < jc {
            let p = parent as usize;
            let mut pw = [0f32; 16];
            pw.copy_from_slice(&SKIN_WORLD[p * 16..p * 16 + 16]);
            mat_mul4(&pw, &local)
        } else {
            local
        };
        core::ptr::copy_nonoverlapping(
            world.as_ptr(),
            SKIN_WORLD.as_mut_ptr().add(i * 16),
            16,
        );
        i += 1;
    }

    sys::sceGumMatrixMode(MatrixMode::Model);
    sys::sceGumLoadMatrix(&model.0);
    sys::sceGuColor(if tint == NO_TINT { 0xffff_ffff } else { tint });

    for b in skin.batches.iter() {
        if b.mesh < 0 || (b.mesh as usize) >= mesh_table.len() {
            continue;
        }
        let mesh = &mesh_table[b.mesh as usize];
        if mesh.count == 0 {
            continue;
        }
        let mut slot = 0i32;
        while slot < b.bone_count && slot < 8 {
            let g = b.joints[slot as usize];
            if g >= 0 && (g as usize) < jc {
                let g = g as usize;
                let mut wm = [0f32; 16];
                wm.copy_from_slice(&SKIN_WORLD[g * 16..g * 16 + 16]);
                let mut ib = [0f32; 16];
                ib.copy_from_slice(&skin.inverse_bind[g * 16..g * 16 + 16]);
                let bm = align_mat(&mat_mul4(&wm, &ib));
                sys::sceGuBoneMatrix(slot as u32, &bm.0);
            }
            slot += 1;
        }
        sys::sceGumDrawArray(
            GuPrimitive::Triangles,
            mesh.vtype,
            mesh.count,
            null(),
            mesh.bytes.as_ptr() as *const c_void,
        );
    }
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


/// `g3d.uploadSkin(buffer)` -> int handle. Retain a skinned character once:
/// joint hierarchy + inverse-bind matrices + bone-batch tables. Buffer layout:
/// u32 jointCount, jointCount×i32 parents, jointCount×16 f32 inverseBind,
/// u32 batchCount, batchCount×{ i32 meshHandle, i32 boneCount, 8×i32 jointTable }.
/// Per frame OP_DRAW_SKIN_ANIM then ships only the clip phase.
unsafe extern "C" fn js_g3d_upload_skin(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewInt32(ctx, -1);
    }
    let mut len: size_t = 0;
    let p = JS_GetArrayBuffer(ctx, &mut len, *argv.offset(0));
    if p.is_null() {
        return JS_NewInt32(ctx, -1);
    }
    let mut o = 0usize;
    let joint_count = read_u32(p, o) as usize;
    o += 4;
    if joint_count == 0 || joint_count > MAX_JOINTS {
        return JS_NewInt32(ctx, -1);
    }
    let mut parents = Vec::with_capacity(joint_count);
    for _ in 0..joint_count {
        parents.push(read_u32(p, o) as i32);
        o += 4;
    }
    let mut inverse_bind = Vec::with_capacity(joint_count * 16);
    for _ in 0..joint_count * 16 {
        inverse_bind.push(read_f32(p, o));
        o += 4;
    }
    let batch_count = read_u32(p, o) as usize;
    o += 4;
    let mut batches = Vec::with_capacity(batch_count);
    for _ in 0..batch_count {
        let mesh = read_u32(p, o) as i32;
        o += 4;
        let bone_count = read_u32(p, o) as i32;
        o += 4;
        let mut joints = [0i32; 8];
        for j in 0..8 {
            joints[j] = read_u32(p, o) as i32;
            o += 4;
        }
        batches.push(SkinBatch { mesh, bone_count, joints });
    }
    let table = skins();
    let handle = table.len() as i32;
    table.push(SkinEntry { joint_count, parents, inverse_bind, batches });
    JS_NewInt32(ctx, handle)
}

/// `g3d.uploadClip(buffer)` -> int handle. Retain one baked animation clip so the
/// native side can sample it (OP_DRAW_SKIN_ANIM) instead of QuickJS. Buffer layout:
/// u32 jointCount, u32 frameCount, then frameCount×jointCount×3 f32 T,
/// frameCount×jointCount×4 f32 R, frameCount×jointCount×3 f32 S (the BakedClip's
/// flat t/r/s arrays concatenated). Mirrors skin.ts uploadClip / host3d.ts.
unsafe extern "C" fn js_g3d_upload_clip(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewInt32(ctx, -1);
    }
    let mut len: size_t = 0;
    let p = JS_GetArrayBuffer(ctx, &mut len, *argv.offset(0));
    if p.is_null() {
        return JS_NewInt32(ctx, -1);
    }
    let mut o = 0usize;
    let joint_count = read_u32(p, o) as usize;
    o += 4;
    let frame_count = read_u32(p, o) as usize;
    o += 4;
    if joint_count == 0 || joint_count > MAX_JOINTS || frame_count == 0 {
        return JS_NewInt32(ctx, -1);
    }
    let nt = frame_count * joint_count * 3;
    let nr = frame_count * joint_count * 4;
    let ns = frame_count * joint_count * 3;
    // Reject a short/corrupt buffer rather than reading out of bounds.
    if (len as usize) < (2 + nt + nr + ns) * 4 {
        return JS_NewInt32(ctx, -1);
    }
    let mut t = Vec::with_capacity(nt);
    for _ in 0..nt {
        t.push(read_f32(p, o));
        o += 4;
    }
    let mut r = Vec::with_capacity(nr);
    for _ in 0..nr {
        r.push(read_f32(p, o));
        o += 4;
    }
    let mut s = Vec::with_capacity(ns);
    for _ in 0..ns {
        s.push(read_f32(p, o));
        o += 4;
    }
    let table = clips();
    let handle = table.len() as i32;
    table.push(ClipEntry { joint_count, frame_count, t, r, s });
    JS_NewInt32(ctx, handle)
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
    let skin_table = skins();
    let clip_table = clips();

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
        } else if op == OP_DRAW_SKIN_ANIM {
            let sh = read_u32(buf, base) as i32;
            let ch = read_u32(buf, base + 4) as i32;
            let tint = read_u32(buf, base + 8);
            let phase = read_f32(buf, base + 12);
            let model = read_matrix(buf, base + 16);
            draw_skin_anim_native(table, skin_table, clip_table, sh, ch, tint, phase, &model);
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
    let skin_table = skins();
    let clip_table = clips();
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

    // Per-frame RIGID DYNAMIC instances (e.g. a car body + spun/steered wheels):
    // (argv[1] buffer, argv[2] count), each 76 bytes = i32 handle, i32 tex, u32
    // tint, 16 f32 model. Drawn without culling (few + always near the camera), so
    // JS only walks the small dynamic subtree each frame, not the static scenery.
    if argc >= 3 {
        let mut dlen: size_t = 0;
        let dp = JS_GetArrayBuffer(ctx, &mut dlen, *argv.offset(1));
        if !dp.is_null() {
            let dcount = (arg_i32(ctx, argc, argv, 2).max(0) as usize).min((dlen as usize) / 76);
            for di in 0..dcount {
                let o = di * 76;
                let handle = read_u32(dp, o) as i32;
                let tex = read_u32(dp, o + 4) as i32;
                let tint = read_u32(dp, o + 8);
                if handle < 0 || (handle as usize) >= table.len() {
                    continue;
                }
                let mesh = &table[handle as usize];
                if mesh.count == 0 {
                    continue;
                }
                if tex != bound_tex {
                    apply_texture(tex_table, if tex < 0 { 0xffff_ffff } else { tex as u32 });
                    bound_tex = tex;
                }
                let mut model = [0f32; 16];
                for k in 0..16 {
                    model[k] = read_f32(dp, o + 12 + k * 4);
                }
                let mm = align_mat(&model);
                sys::sceGumMatrixMode(MatrixMode::Model);
                sys::sceGumLoadMatrix(&mm.0);
                sys::sceGuColor(if tint == NO_TINT { 0xffff_ffff } else { tint });
                sys::sceGumDrawArray(
                    GuPrimitive::Triangles,
                    mesh.vtype,
                    mesh.count,
                    null(),
                    mesh.bytes.as_ptr() as *const c_void,
                );
                drawn += 1;
            }
        }
    }

    // Optional post-pass command buffer. This lets a retained static scene share
    // one clear/depth pass with dynamic skinned characters: JS builds a small
    // DC3D packet containing OP_BIND_TEXTURE + OP_DRAW_SKIN_ANIM/OP_DRAW_SKINNED
    // records, and native sceneRender replays it after static + rigid dynamics.
    // Post draws are intentionally not included in `drawn`; the return value is
    // still the retained/static + rigid dynamic instance count used for culling
    // diagnostics.
    if argc >= 5 {
        let mut plen: size_t = 0;
        let post = JS_GetArrayBuffer(ctx, &mut plen, *argv.offset(3));
        if !post.is_null() {
            let mut post_len = plen as usize;
            let bl = arg_i32(ctx, argc, argv, 4);
            if bl >= 0 && (bl as usize) < post_len {
                post_len = bl as usize;
            }
            if post_len >= 8 && read_u32(post, 0) == DC3D_MAGIC {
                let record_count = read_u16(post, 6) as usize;
                let mut o = 8usize;
                for _ in 0..record_count {
                    if o + 4 > post_len {
                        break;
                    }
                    let op = read_u16(post, o) as u32;
                    let words = read_u16(post, o + 2) as usize;
                    let base = o + 4;
                    o = base + words * 4;
                    if o > post_len {
                        break;
                    }

                    if op == OP_BIND_TEXTURE {
                        let th = read_u32(post, base);
                        apply_texture(tex_table, th);
                    } else if op == OP_DRAW_SKINNED {
                        let handle = read_u32(post, base) as i32;
                        let tint = read_u32(post, base + 4);
                        let bone_count = read_u32(post, base + 8);
                        let model = read_matrix(post, base + 12);

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

                        let bones_base = base + 12 + 64;
                        let mut i = 0u32;
                        while i < bone_count && i < 8 {
                            let bm = read_bone_matrix(post, bones_base + (i as usize) * 48);
                            sys::sceGuBoneMatrix(i, &bm);
                            i += 1;
                        }

                        sys::sceGumDrawArray(
                            GuPrimitive::Triangles,
                            mesh.vtype,
                            mesh.count,
                            null(),
                            mesh.bytes.as_ptr() as *const c_void,
                        );
                    } else if op == OP_DRAW_SKIN_ANIM {
                        let sh = read_u32(post, base) as i32;
                        let ch = read_u32(post, base + 4) as i32;
                        let tint = read_u32(post, base + 8);
                        let phase = read_f32(post, base + 12);
                        let model = read_matrix(post, base + 16);
                        draw_skin_anim_native(table, skin_table, clip_table, sh, ch, tint, phase, &model);
                    }
                }
            }
        }
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

    let f_upload_skin = JS_NewCFunction2(
        ctx,
        Some(js_g3d_upload_skin),
        b"uploadSkin\0".as_ptr() as *const _,
        1,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, g3d, b"uploadSkin\0".as_ptr() as *const _, f_upload_skin);

    let f_upload_clip = JS_NewCFunction2(
        ctx,
        Some(js_g3d_upload_clip),
        b"uploadClip\0".as_ptr() as *const _,
        1,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, g3d, b"uploadClip\0".as_ptr() as *const _, f_upload_clip);

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
