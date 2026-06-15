#![no_std]
#![no_main]

//! psp-js runtime: boots QuickJS, exposes a tiny native 2D graphics + input API
//! to JavaScript, evaluates the PSPJS_GAME-selected file (see build.rs), then
//! drives its `frame(buttons)` function once per vblank while presenting frames
//! via sceGu.

extern crate alloc;

use core::ffi::c_void;

use libquickjs_sys::*;
use psp::sys::{
    self, CtrlMode, DisplayPixelFormat, GuContextType, GuState, GuSyncBehavior, GuSyncMode,
    SceCtrlData, TexturePixelFormat,
};
use psp::vram_alloc::get_vram_allocator;
use psp::{Align16, BUF_WIDTH, SCREEN_HEIGHT, SCREEN_WIDTH};

mod bridge;
mod gfx;
mod qjs_alloc;

psp::module!("psp_js", 1, 1);

// GE display list buffer (256 KB), 16-byte aligned.
static mut LIST: Align16<[u32; 0x40000]> = Align16([0; 0x40000]);

// The game source, selected at build time by `PSPJS_GAME` (see build.rs) and
// NUL-terminated there for JS_Eval (which wants input[len] == '\0').
static GAME_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/game.js"));

fn psp_main() {
    unsafe { run() }
}

unsafe fn run() {
    psp::enable_home_button();

    init_graphics();

    // ---- Controller ----
    sys::sceCtrlSetSamplingCycle(0);
    sys::sceCtrlSetSamplingMode(CtrlMode::Analog);
    let mut pad = SceCtrlData::default();

    // ---- QuickJS: runtime, context, native API, evaluate the game ----
    // Use the Rust/PSP allocator (newlib malloc has no heap under rust-psp).
    let rt = qjs_alloc::new_runtime();
    let ctx = JS_NewContext(rt);
    let global = JS_GetGlobalObject(ctx);

    gfx::register(ctx, global);
    bridge::register(ctx, global);

    let res = JS_Eval(
        ctx,
        GAME_JS.as_ptr() as *const _,
        GAME_JS.len() - 1, // length excluding the trailing NUL
        b"game.js\0".as_ptr() as *const _,
        JS_EVAL_TYPE_GLOBAL as i32,
    );
    if JS_ValueGetTag(res) == JS_TAG_EXCEPTION {
        bridge::log_exception(ctx);
    }
    JS_FreeValue(ctx, res);

    // Look up globalThis.frame once; keep it alive for the whole loop.
    let frame_fn = JS_GetPropertyStr(ctx, global, b"frame\0".as_ptr() as *const _);

    // ---- Fixed-timestep frame loop (~60Hz via vblank) ----
    loop {
        sys::sceCtrlReadBufferPositive(&mut pad, 1);
        let mask = pad.buttons.bits() as i32;

        // Open this frame's display list; JS gfx.* calls enqueue into it.
        sys::sceGuStart(GuContextType::Direct, &mut LIST as *mut _ as *mut c_void);

        let mut args = [JS_NewInt32(ctx, mask)];
        let r = JS_Call(ctx, frame_fn, global, 1, args.as_mut_ptr());
        if JS_ValueGetTag(r) == JS_TAG_EXCEPTION {
            bridge::log_exception(ctx);
        }
        JS_FreeValue(ctx, r); // free the return value every frame (leak guard)

        // Present.
        sys::sceGuFinish();
        sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
        sys::sceDisplayWaitVblankStart();
        sys::sceGuSwapBuffers();
    }
}

/// Initialize the GU for double-buffered 480x272 PSM8888 rendering.
unsafe fn init_graphics() {
    let mut allocator = get_vram_allocator().unwrap();
    let fbp0 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();
    let fbp1 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();
    let zbp = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm4444)
        .as_mut_ptr_from_zero();

    sys::sceGuInit();
    sys::sceGuStart(GuContextType::Direct, &mut LIST as *mut _ as *mut c_void);
    sys::sceGuDrawBuffer(DisplayPixelFormat::Psm8888, fbp0 as _, BUF_WIDTH as i32);
    sys::sceGuDispBuffer(
        SCREEN_WIDTH as i32,
        SCREEN_HEIGHT as i32,
        fbp1 as _,
        BUF_WIDTH as i32,
    );
    sys::sceGuDepthBuffer(zbp as _, BUF_WIDTH as i32);
    sys::sceGuOffset(2048 - (SCREEN_WIDTH / 2), 2048 - (SCREEN_HEIGHT / 2));
    sys::sceGuViewport(2048, 2048, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
    sys::sceGuScissor(0, 0, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
    sys::sceGuEnable(GuState::ScissorTest);
    sys::sceGuFinish();
    sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
    sys::sceDisplayWaitVblankStart();
    sys::sceGuDisplay(true);
}
