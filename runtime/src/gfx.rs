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

/// Scratch sprite buffer for the batched `fillRects` / `drawText` paths: 2 verts
/// per rect. Both build into this, then issue one `sceGuDrawArray`.
const MAX_RECTS: usize = 4096;
static mut SPRITES: psp::Align16<[Vertex2D; MAX_RECTS * 2]> =
    psp::Align16([Vertex2D { color: 0, x: 0, y: 0, z: 0, _pad: 0 }; MAX_RECTS * 2]);

/// One bitmap glyph: pixel width + up to 8 rows (bit 0 = leftmost pixel).
#[derive(Copy, Clone)]
struct Glyph {
    w: u8,
    rows: [u8; 8],
}
// The active font, uploaded once from JS (gfx.uploadFont) so drawText can
// rasterize glyphs natively instead of looping per pixel-run in interpreted JS.
static mut FONT: Option<[Glyph; 128]> = None;
static mut FONT_HEIGHT: i32 = 8;

/// A large variable-cell bitmap font (the VN Japanese atlas), uploaded once per
/// slot from JS (gfx.vnUploadFont). Glyphs are fixed cellW×cellH 1-bit cells,
/// MSB = leftmost pixel, indexed by glyph id (id 0 reserved BLANK). The atlas
/// can be tens of KB so it lives on the heap, not in a fixed static array.
struct VnFont {
    cell_w: i32,
    cell_h: i32,
    bpr: i32, // bytes per row
    count: i32,
    rows: alloc::vec::Vec<u8>,
}
// Two slots: 0 = base size, 1 = ruby (furigana) size.
static mut VN_FONTS: [Option<VnFont>; 2] = [None, None];

/// Push one screen-clipped sprite rect into `SPRITES` at slot `n`; returns the
/// next slot (unchanged if fully off-screen or the scratch is full).
#[inline]
unsafe fn push_sprite(n: usize, color: u32, x: i32, y: i32, w: i32, h: i32) -> usize {
    if n >= MAX_RECTS {
        return n;
    }
    let x0 = x.max(0).min(SCREEN_WIDTH as i32);
    let y0 = y.max(0).min(SCREEN_HEIGHT as i32);
    let x1 = (x + w).max(0).min(SCREEN_WIDTH as i32);
    let y1 = (y + h).max(0).min(SCREEN_HEIGHT as i32);
    if x1 <= x0 || y1 <= y0 {
        return n;
    }
    let s = &mut SPRITES.0;
    s[n * 2] = Vertex2D { color, x: x0 as i16, y: y0 as i16, z: 0, _pad: 0 };
    s[n * 2 + 1] = Vertex2D { color, x: x1 as i16, y: y1 as i16, z: 0, _pad: 0 };
    n + 1
}

/// Draw the first `n` scratch sprites as one batched sprite draw.
#[inline]
unsafe fn flush_sprites(n: usize) {
    if n == 0 {
        return;
    }
    let s = &SPRITES.0;
    sys::sceKernelDcacheWritebackRange(
        s.as_ptr() as *const c_void,
        (n * 2 * core::mem::size_of::<Vertex2D>()) as u32,
    );
    sys::sceGuDrawArray(
        GuPrimitive::Sprites,
        VertexType::COLOR_8888 | VertexType::VERTEX_16BIT | VertexType::TRANSFORM_2D,
        (n * 2) as i32,
        null(),
        s.as_ptr() as *const c_void,
    );
}

/// `gfx.uploadFont(table: ArrayBuffer, height)` — install the active font once.
/// `table` is 128 glyphs × 9 bytes: 1 width + 8 row bytes (missing codes carry
/// the fallback glyph, filled in JS). Lets drawText rasterize natively.
unsafe extern "C" fn js_gfx_upload_font(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 2 {
        return JS_UNDEFINED;
    }
    let mut len: size_t = 0;
    let p = JS_GetArrayBuffer(ctx, &mut len, *argv.offset(0));
    if p.is_null() || (len as usize) < 128 * 9 {
        return JS_UNDEFINED;
    }
    let mut tbl = [Glyph { w: 0, rows: [0u8; 8] }; 128];
    for code in 0..128 {
        let o = code * 9;
        tbl[code].w = *p.add(o);
        for r in 0..8 {
            tbl[code].rows[r] = *p.add(o + 1 + r);
        }
    }
    FONT = Some(tbl);
    FONT_HEIGHT = arg_i32(ctx, argc, argv, 1).max(1).min(8);
    JS_UNDEFINED
}

/// `gfx.drawText(str, x, y, rgb, scale)` -> width. Rasterizes the string with the
/// uploaded font and draws all glyph runs as ONE batched sprite draw — the whole
/// per-pixel-run loop runs natively instead of in interpreted JS. `rgb` is
/// 0xRRGGBB. Supports '\n'. Codes ≥ 128 (non-ASCII UTF-8 bytes) are skipped.
unsafe extern "C" fn js_gfx_draw_text(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 5 {
        return JS_NewInt32(ctx, 0);
    }
    let font = match FONT.as_ref() {
        Some(f) => f,
        None => return JS_NewInt32(ctx, 0),
    };
    let height = FONT_HEIGHT;
    let mut slen: size_t = 0;
    let sp = JS_ToCStringLen2(ctx, &mut slen, *argv.offset(0), 0);
    if sp.is_null() {
        return JS_NewInt32(ctx, 0);
    }
    let x = arg_i32(ctx, argc, argv, 1);
    let y = arg_i32(ctx, argc, argv, 2);
    let rgb = arg_i32(ctx, argc, argv, 3) as u32;
    let scale = arg_i32(ctx, argc, argv, 4).max(1);
    let color = 0xff00_0000 | ((rgb & 0xff) << 16) | ((rgb >> 8) & 0xff) << 8 | ((rgb >> 16) & 0xff);

    let bytes = core::slice::from_raw_parts(sp as *const u8, slen as usize);
    let mut n = 0usize;
    let mut cx = x;
    let mut cy = y;
    let mut maxw = 0i32;
    for &b in bytes {
        let code = b as usize;
        if code == 10 {
            if cx - x > maxw {
                maxw = cx - x;
            }
            cx = x;
            cy += (height + 1) * scale;
            continue;
        }
        if code >= 128 {
            continue;
        }
        let gl = &font[code];
        for ry in 0..height {
            let bits = gl.rows[ry as usize] as u32;
            if bits == 0 {
                continue;
            }
            let mut col = 0i32;
            while col < gl.w as i32 {
                if bits & (1 << col) != 0 {
                    let mut run = 1i32;
                    while col + run < gl.w as i32 && bits & (1 << (col + run)) != 0 {
                        run += 1;
                    }
                    n = push_sprite(n, color, cx + col * scale, cy + ry * scale, run * scale, scale);
                    col += run;
                } else {
                    col += 1;
                }
            }
        }
        cx += (gl.w as i32 + 1) * scale;
    }
    JS_FreeCString(ctx, sp);
    if cx - x > maxw {
        maxw = cx - x;
    }
    flush_sprites(n);
    JS_NewInt32(ctx, maxw)
}

/// `gfx.vnUploadFont(slot, rows: ArrayBuffer, count, cellW, cellH, bpr)` — install
/// one VN glyph atlas slot. `rows` is `count` cells × `cellH` rows × `bpr` bytes,
/// each row a 1-bit mask (MSB = leftmost pixel). Copied onto the heap so it
/// outlives the JS ArrayBuffer. slot 0 = base, slot 1 = ruby.
unsafe extern "C" fn js_gfx_vn_upload_font(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 6 {
        return JS_UNDEFINED;
    }
    let slot = arg_i32(ctx, argc, argv, 0);
    if slot < 0 || slot > 1 {
        return JS_UNDEFINED;
    }
    let mut len: size_t = 0;
    let p = JS_GetArrayBuffer(ctx, &mut len, *argv.offset(1));
    let count = arg_i32(ctx, argc, argv, 2);
    let cell_w = arg_i32(ctx, argc, argv, 3);
    let cell_h = arg_i32(ctx, argc, argv, 4);
    let bpr = arg_i32(ctx, argc, argv, 5);
    if p.is_null() || count <= 0 || cell_w <= 0 || cell_h <= 0 || bpr <= 0 {
        return JS_UNDEFINED;
    }
    let need = (count * bpr * cell_h) as usize;
    if (len as usize) < need {
        return JS_UNDEFINED;
    }
    let mut v = alloc::vec::Vec::with_capacity(need);
    for i in 0..need {
        v.push(*p.add(i));
    }
    VN_FONTS[slot as usize] = Some(VnFont { cell_w, cell_h, bpr, count, rows: v });
    JS_UNDEFINED
}

/// `gfx.vnDrawGlyphs(slot, glyphs: ArrayBuffer, count, rgb)` — draw `count` glyphs
/// from a VN atlas slot in batched sprite draws. `glyphs` is `count` × 3 LE i32
/// `[glyphId, x, y]`; `rgb` = 0xRRGGBB. Each glyph's 1-bit cell is rasterized to
/// run-length rects natively (the heavy per-pixel loop stays off the JS core);
/// the scratch is flushed and reused when it fills, so glyph count is unbounded.
unsafe extern "C" fn js_gfx_vn_draw_glyphs(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 4 {
        return JS_UNDEFINED;
    }
    let slot = arg_i32(ctx, argc, argv, 0);
    if slot < 0 || slot > 1 {
        return JS_UNDEFINED;
    }
    let font = match VN_FONTS[slot as usize].as_ref() {
        Some(f) => f,
        None => return JS_UNDEFINED,
    };
    let mut len: size_t = 0;
    let buf = JS_GetArrayBuffer(ctx, &mut len, *argv.offset(1));
    if buf.is_null() {
        return JS_UNDEFINED;
    }
    let want = arg_i32(ctx, argc, argv, 2).max(0) as usize;
    let count = want.min((len as usize) / 12); // 3 i32 = 12 bytes/glyph
    let rgb = arg_i32(ctx, argc, argv, 3) as u32;
    let color =
        0xff00_0000 | ((rgb & 0xff) << 16) | (((rgb >> 8) & 0xff) << 8) | ((rgb >> 16) & 0xff);

    let cw = font.cell_w;
    let ch = font.cell_h;
    let bpr = font.bpr;
    let stride = (bpr * ch) as usize;
    let rows = font.rows.as_slice();
    let mut n = 0usize;
    for i in 0..count {
        let o = i * 12;
        let id = rd_i32(buf, o);
        if id <= 0 || id >= font.count {
            continue; // 0 = blank / out of range
        }
        let gx = rd_i32(buf, o + 4);
        let gy = rd_i32(buf, o + 8);
        let cell = id as usize * stride;
        for ry in 0..ch {
            let row = cell + (ry * bpr) as usize;
            let mut col = 0i32;
            while col < cw {
                if rows[row + (col >> 3) as usize] & (0x80 >> (col & 7)) != 0 {
                    let mut run = 1i32;
                    while col + run < cw
                        && rows[row + ((col + run) >> 3) as usize] & (0x80 >> ((col + run) & 7)) != 0
                    {
                        run += 1;
                    }
                    n = push_sprite(n, color, gx + col, gy + ry, run, 1);
                    if n >= MAX_RECTS {
                        flush_sprites(n);
                        n = 0;
                    }
                    col += run;
                } else {
                    col += 1;
                }
            }
        }
    }
    flush_sprites(n);
    JS_UNDEFINED
}

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

    let f_upfont = JS_NewCFunction2(ctx, Some(js_gfx_upload_font), b"uploadFont\0".as_ptr() as *const _, 2, JS_CFUNC_generic, 0);
    JS_SetPropertyStr(ctx, gfx, b"uploadFont\0".as_ptr() as *const _, f_upfont);
    let f_text = JS_NewCFunction2(ctx, Some(js_gfx_draw_text), b"drawText\0".as_ptr() as *const _, 5, JS_CFUNC_generic, 0);
    JS_SetPropertyStr(ctx, gfx, b"drawText\0".as_ptr() as *const _, f_text);

    let f_vnup = JS_NewCFunction2(ctx, Some(js_gfx_vn_upload_font), b"vnUploadFont\0".as_ptr() as *const _, 6, JS_CFUNC_generic, 0);
    JS_SetPropertyStr(ctx, gfx, b"vnUploadFont\0".as_ptr() as *const _, f_vnup);
    let f_vndraw = JS_NewCFunction2(ctx, Some(js_gfx_vn_draw_glyphs), b"vnDrawGlyphs\0".as_ptr() as *const _, 4, JS_CFUNC_generic, 0);
    JS_SetPropertyStr(ctx, gfx, b"vnDrawGlyphs\0".as_ptr() as *const _, f_vndraw);

    // JS_SetPropertyStr consumes ownership of `gfx`.
    JS_SetPropertyStr(ctx, global, b"gfx\0".as_ptr() as *const _, gfx);
}
