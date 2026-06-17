//! Native 2D graphics primitives exposed to JavaScript as the `gfx.*` object.
//!
//! The frame's display list is opened/closed by Rust (see `main.rs`). These
//! functions only *enqueue* GE commands into the already-open list — they must
//! never call sceGuStart/Finish/Sync/SwapBuffers.

use core::ffi::c_void;
use core::ptr::null;

use libquickjs_sys::*;
use psp::sys::{self, ClearBuffer, GuPrimitive, VertexType};
use psp::{SCREEN_HEIGHT, SCREEN_WIDTH};

/// A 2D sprite vertex. The PSP GU expects components in a fixed order
/// (color before position) for `COLOR_8888 | VERTEX_16BIT | TRANSFORM_2D`:
/// a u32 color followed by 16-bit x/y/z, padded to a 12-byte stride.
#[repr(C)]
#[derive(Copy, Clone)]
struct Vertex2D {
    color: u32, // 0xAABBGGRR
    x: i16,
    y: i16,
    z: i16,
    _pad: i16,
}

/// Pack human-ordered (r, g, b) into the PSP's ABGR u32 (alpha forced opaque).
#[inline]
fn pack_abgr(r: i32, g: i32, b: i32) -> u32 {
    0xff00_0000
        | (((b as u32) & 0xff) << 16)
        | (((g as u32) & 0xff) << 8)
        | ((r as u32) & 0xff)
}

/// Read the i-th JS argument as an i32 (0 if absent / not convertible).
#[inline]
unsafe fn arg_i32(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> i32 {
    if (i as i32) >= argc {
        return 0;
    }
    let mut out: i32 = 0;
    JS_ToInt32(ctx, &mut out, *argv.offset(i));
    out
}

/// `gfx.clear(r, g, b)` — clear the framebuffer to a solid color.
///
/// The cross-host contract (see the Web/3DS hosts) defines `clear` as "fill the
/// screen with this color" — nothing more. Depth is intentionally NOT cleared:
/// the GU never enables `DepthTest` (see `init_graphics` in main.rs), so the
/// depth buffer is unused and clearing it would be both wasteful and a behavior
/// the other platforms don't share.
unsafe extern "C" fn js_gfx_clear(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let r = arg_i32(ctx, argc, argv, 0);
    let g = arg_i32(ctx, argc, argv, 1);
    let b = arg_i32(ctx, argc, argv, 2);
    sys::sceGuClearColor(pack_abgr(r, g, b));
    sys::sceGuClear(ClearBuffer::COLOR_BUFFER_BIT);
    JS_UNDEFINED
}

/// `gfx.fillRect(x, y, w, h, r, g, b)` — draw a filled rectangle.
unsafe extern "C" fn js_gfx_fill_rect(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 7 {
        return JS_UNDEFINED;
    }
    let x = arg_i32(ctx, argc, argv, 0);
    let y = arg_i32(ctx, argc, argv, 1);
    let w = arg_i32(ctx, argc, argv, 2);
    let h = arg_i32(ctx, argc, argv, 3);
    let color = pack_abgr(
        arg_i32(ctx, argc, argv, 4),
        arg_i32(ctx, argc, argv, 5),
        arg_i32(ctx, argc, argv, 6),
    );

    // Clip the rect to the logical screen. The GU's scissor test already discards
    // off-screen fragments, but the 16-bit vertex components would *wrap* for
    // coordinates outside i16 range; clamping here keeps behavior identical to
    // the Web canvas and the golden render mock (both clamp to the screen).
    let x0 = x.max(0).min(SCREEN_WIDTH as i32);
    let y0 = y.max(0).min(SCREEN_HEIGHT as i32);
    let x1 = (x + w).max(0).min(SCREEN_WIDTH as i32);
    let y1 = (y + h).max(0).min(SCREEN_HEIGHT as i32);
    if x1 <= x0 || y1 <= y0 {
        return JS_UNDEFINED; // fully off-screen / empty
    }

    // A PSP "sprite" is two vertices: top-left and bottom-right corners.
    let verts: psp::Align16<[Vertex2D; 2]> = psp::Align16([
        Vertex2D { color, x: x0 as i16, y: y0 as i16, z: 0, _pad: 0 },
        Vertex2D { color, x: x1 as i16, y: y1 as i16, z: 0, _pad: 0 },
    ]);

    // The GE reads vertices from RAM, not the CPU cache — flush this buffer.
    sys::sceKernelDcacheWritebackRange(
        &verts as *const _ as *const c_void,
        core::mem::size_of::<[Vertex2D; 2]>() as u32,
    );

    sys::sceGuDrawArray(
        GuPrimitive::Sprites,
        VertexType::COLOR_8888 | VertexType::VERTEX_16BIT | VertexType::TRANSFORM_2D,
        2,
        null(),
        &verts as *const _ as *const c_void,
    );
    JS_UNDEFINED
}

/// Read a little-endian i32 from a JS ArrayBuffer at byte offset `o`.
#[inline]
unsafe fn rd_i32(p: *const u8, o: usize) -> i32 {
    (*p.add(o) as i32)
        | ((*p.add(o + 1) as i32) << 8)
        | ((*p.add(o + 2) as i32) << 16)
        | ((*p.add(o + 3) as i32) << 24)
}

/// Scratch sprite buffer for the batched `fillRects` path: 2 verts per rect.
const MAX_RECTS: usize = 4096;
static mut SPRITES: psp::Align16<[Vertex2D; MAX_RECTS * 2]> =
    psp::Align16([Vertex2D { color: 0, x: 0, y: 0, z: 0, _pad: 0 }; MAX_RECTS * 2]);

/// `gfx.fillRects(buffer: ArrayBuffer, count)` — draw many filled rects in ONE
/// GE draw call. `buffer` is `count` × 5 little-endian i32: `[x, y, w, h, rgb]`
/// (rgb = 0xRRGGBB). This is the batched fast path for text (the glyph rasterizer
/// emits hundreds of tiny rects/frame); doing them as one `sceGuDrawArray` of
/// sprite pairs collapses hundreds of FFI crossings + GE draws into one.
unsafe extern "C" fn js_gfx_fill_rects(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 2 {
        return JS_UNDEFINED;
    }
    let mut len: size_t = 0;
    let buf = JS_GetArrayBuffer(ctx, &mut len, *argv.offset(0));
    if buf.is_null() {
        return JS_UNDEFINED;
    }
    let want = arg_i32(ctx, argc, argv, 1).max(0) as usize;
    let count = want.min((len as usize) / 20).min(MAX_RECTS); // 5 i32 = 20 bytes/rect

    let scratch = &mut SPRITES.0;
    let mut n = 0usize; // rects actually emitted (after clipping)
    for i in 0..count {
        let o = i * 20;
        let x = rd_i32(buf, o);
        let y = rd_i32(buf, o + 4);
        let w = rd_i32(buf, o + 8);
        let h = rd_i32(buf, o + 12);
        let rgb = rd_i32(buf, o + 16) as u32;
        let color = 0xff00_0000
            | ((rgb & 0xff) << 16)
            | ((rgb >> 8) & 0xff) << 8
            | ((rgb >> 16) & 0xff);
        // Clip to the logical screen (same as fillRect — avoid i16 wrap).
        let x0 = x.max(0).min(SCREEN_WIDTH as i32);
        let y0 = y.max(0).min(SCREEN_HEIGHT as i32);
        let x1 = (x + w).max(0).min(SCREEN_WIDTH as i32);
        let y1 = (y + h).max(0).min(SCREEN_HEIGHT as i32);
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        scratch[n * 2] = Vertex2D { color, x: x0 as i16, y: y0 as i16, z: 0, _pad: 0 };
        scratch[n * 2 + 1] = Vertex2D { color, x: x1 as i16, y: y1 as i16, z: 0, _pad: 0 };
        n += 1;
    }
    if n == 0 {
        return JS_UNDEFINED;
    }
    sys::sceKernelDcacheWritebackRange(
        scratch.as_ptr() as *const c_void,
        (n * 2 * core::mem::size_of::<Vertex2D>()) as u32,
    );
    sys::sceGuDrawArray(
        GuPrimitive::Sprites,
        VertexType::COLOR_8888 | VertexType::VERTEX_16BIT | VertexType::TRANSFORM_2D,
        (n * 2) as i32,
        null(),
        scratch.as_ptr() as *const c_void,
    );
    JS_UNDEFINED
}

/// Install the `gfx` object (with `clear` and `fillRect`) onto the JS global.
pub unsafe fn register(ctx: *mut JSContext, global: JSValue) {
    let gfx = JS_NewObject(ctx);

    let f_clear = JS_NewCFunction2(
        ctx,
        Some(js_gfx_clear),
        b"clear\0".as_ptr() as *const _,
        3,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, gfx, b"clear\0".as_ptr() as *const _, f_clear);

    let f_fill = JS_NewCFunction2(
        ctx,
        Some(js_gfx_fill_rect),
        b"fillRect\0".as_ptr() as *const _,
        7,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, gfx, b"fillRect\0".as_ptr() as *const _, f_fill);

    let f_fills = JS_NewCFunction2(
        ctx,
        Some(js_gfx_fill_rects),
        b"fillRects\0".as_ptr() as *const _,
        2,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, gfx, b"fillRects\0".as_ptr() as *const _, f_fills);

    // JS_SetPropertyStr consumes ownership of `gfx`.
    JS_SetPropertyStr(ctx, global, b"gfx\0".as_ptr() as *const _, gfx);
}
