//! Native 2D graphics primitives exposed to JavaScript as the `gfx.*` object.
//!
//! The frame's display list is opened/closed by Rust (see `main.rs`). These
//! functions only *enqueue* GE commands into the already-open list — they must
//! never call sceGuStart/Finish/Sync/SwapBuffers.

use core::ffi::c_void;
use core::ptr::null;

use libquickjs_sys::*;
use psp::sys::{self, ClearBuffer, GuPrimitive, VertexType};

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
    sys::sceGuClearDepth(0);
    sys::sceGuClear(ClearBuffer::COLOR_BUFFER_BIT | ClearBuffer::DEPTH_BUFFER_BIT);
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

    // A PSP "sprite" is two vertices: top-left and bottom-right corners.
    let verts: psp::Align16<[Vertex2D; 2]> = psp::Align16([
        Vertex2D { color, x: x as i16, y: y as i16, z: 0, _pad: 0 },
        Vertex2D { color, x: (x + w) as i16, y: (y + h) as i16, z: 0, _pad: 0 },
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

    // JS_SetPropertyStr consumes ownership of `gfx`.
    JS_SetPropertyStr(ctx, global, b"gfx\0".as_ptr() as *const _, gfx);
}
