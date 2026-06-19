#![no_std]
#![no_main]
#![allow(static_mut_refs)]

//! psp-js runtime: boots QuickJS, exposes a tiny native 2D graphics + input API
//! to JavaScript, evaluates the PSPJS_GAME-selected file (see build.rs), then
//! drives its `frame(buttons)` function once per vblank while presenting frames
//! via sceGu.

extern crate alloc;

use core::ffi::c_void;

use libquickjs_sys::*;
use psp::sys::{
    self, ClearBuffer, CtrlMode, DepthFunc, DisplayPixelFormat, FrontFaceDirection, GuContextType,
    GuState, GuSyncBehavior, GuSyncMode, SceCtrlData, ShadingModel, TexturePixelFormat,
    ThreadAttributes,
};
use psp::vram_alloc::get_vram_allocator;
use psp::{Align16, BUF_WIDTH, SCREEN_HEIGHT, SCREEN_WIDTH};

mod arena;
mod bridge;
mod c_heap;
mod gfx;
mod gfx3d;
mod qjs_alloc;

psp::module!("psp_js", 1, 1);

// GE display list buffer (256 KB), 16-byte aligned.
static mut LIST: Align16<[u32; 0x40000]> = Align16([0; 0x40000]);

// The game source, selected at build time by `PSPJS_GAME` (see build.rs) and
// NUL-terminated there for JS_Eval (which wants input[len] == '\0').
static GAME_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/game.js"));
static PSPJS_GAME: &str = env!("PSPJS_GAME");
static PSPJS_DIAG_MODE: &str = env!("PSPJS_DIAG_MODE");

fn psp_main() {
    unsafe {
        if PSPJS_DIAG_MODE == "boot" {
            run_boot_diag();
        } else {
            boot();
        }
    }
}

/// The `psp::module!` macro starts the main thread with only a 256 KB stack.
/// QuickJS compiling the ~35 KB framework bundles recurses deeper than that and
/// overflows the stack (-> abort). Run all the real work on a worker thread with
/// a large (2 MB) stack instead. Raw demos fit in 256 KB but this is harmless.
unsafe fn boot() {
    trace("psp_main: creating worker thread");
    let id = sys::sceKernelCreateThread(
        b"pspjs_main\0".as_ptr(),
        worker_main,
        32,                // priority
        2 * 1024 * 1024,   // 2 MB stack
        ThreadAttributes::USER,
        core::ptr::null_mut(),
    );
    if id.0 >= 0 {
        trace_i32("worker thread id", id.0);
        sys::sceKernelStartThread(id, 0, core::ptr::null_mut());
        sys::sceKernelWaitThreadEnd(id, core::ptr::null_mut());
    } else {
        trace_i32("sceKernelCreateThread failed", id.0);
        run(); // fallback: small-stack inline (raw demos still work)
    }
}

unsafe extern "C" fn worker_main(_argc: usize, _argv: *mut c_void) -> i32 {
    trace("worker_main: entered");
    run();
    0
}

#[inline]
fn trace_enabled() -> bool {
    PSPJS_DIAG_MODE == "trace"
}

unsafe fn trace(msg: &str) {
    if trace_enabled() {
        psp::dprintln!("[pspjs trace] {}", msg);
    }
}

unsafe fn trace_i32(label: &str, value: i32) {
    if trace_enabled() {
        psp::dprintln!("[pspjs trace] {}: {}", label, value);
    }
}

unsafe fn trace_u32(label: &str, value: u32) {
    if trace_enabled() {
        psp::dprintln!("[pspjs trace] {}: 0x{:08x}", label, value);
    }
}

unsafe fn trace_usize(label: &str, value: usize) {
    if trace_enabled() {
        psp::dprintln!("[pspjs trace] {}: {}", label, value);
    }
}

unsafe fn diag_halt(msg: &str) -> ! {
    psp::dprintln!("[pspjs halt] {}", msg);
    psp::dprintln!("HOME exits. Last stage stays on screen.");
    loop {
        sys::sceDisplayWaitVblankStart();
    }
}

#[inline]
fn pack_abgr(r: u32, g: u32, b: u32) -> u32 {
    0xff00_0000 | (b << 16) | (g << 8) | r
}

/// Real-device smoke test: show text before GU, then switch to a color-cycling
/// GU loop. If a Vita/PSP freezes, the last visible line identifies the phase.
unsafe fn run_boot_diag() -> ! {
    psp::enable_home_button();

    psp::dprintln!("DreamCart PSP boot diag");
    psp::dprintln!("game: {}", PSPJS_GAME);
    psp::dprintln!("devkit: 0x{:08x}", sys::sceKernelDevkitVersion());
    psp::dprintln!(
        "free mem: {} / max block: {}",
        sys::sceKernelTotalFreeMemSize(),
        sys::sceKernelMaxFreeMemSize()
    );
    psp::dprintln!("edram: {:p}", sys::sceGeEdramGetAddr());

    sys::sceCtrlSetSamplingCycle(0);
    sys::sceCtrlSetSamplingMode(CtrlMode::Analog);
    let mut pad = SceCtrlData::default();
    for tick in 0..180 {
        sys::sceCtrlReadBufferPositive(&mut pad, 1);
        if tick % 30 == 0 {
            psp::dprintln!(
                "text phase {:03}: buttons=0x{:08x} lx={} ly={}",
                tick,
                pad.buttons.bits(),
                pad.lx,
                pad.ly
            );
        }
        sys::sceDisplayWaitVblankStart();
    }

    psp::dprintln!("starting GU phase");
    psp::dprintln!("expect cycling solid colors next");
    for _ in 0..90 {
        sys::sceDisplayWaitVblankStart();
    }

    init_graphics();

    let mut frame: u32 = 0;
    loop {
        sys::sceCtrlReadBufferPositive(&mut pad, 1);
        let buttons = pad.buttons.bits();
        let r = ((frame * 3) & 0xff) ^ (buttons & 0xff);
        let g = ((frame * 5) & 0xff) ^ ((buttons >> 8) & 0xff);
        let b = ((frame * 7) & 0xff) ^ ((buttons >> 16) & 0xff);

        sys::sceGuStart(GuContextType::Direct, &mut LIST as *mut _ as *mut c_void);
        sys::sceGuClearColor(pack_abgr(r, g, b));
        sys::sceGuClear(ClearBuffer::COLOR_BUFFER_BIT);
        sys::sceGuFinish();
        sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
        sys::sceDisplayWaitVblankStart();
        sys::sceGuSwapBuffers();
        frame = frame.wrapping_add(1);
    }
}

unsafe fn run() {
    trace("run: enabling HOME callback");
    psp::enable_home_button();

    trace("run: init_graphics begin");
    init_graphics();
    trace("run: init_graphics ok");

    // ---- Controller ----
    sys::sceCtrlSetSamplingCycle(0);
    sys::sceCtrlSetSamplingMode(CtrlMode::Analog);
    let mut pad = SceCtrlData::default();
    trace("run: controller ok");

    // ---- QuickJS: runtime, context, native API, evaluate the game ----
    // Use the Rust/PSP allocator (newlib malloc has no heap under rust-psp).
    trace_usize("run: free mem before JS", sys::sceKernelTotalFreeMemSize());
    trace("run: JS_NewRuntime begin");
    let rt = qjs_alloc::new_runtime();
    if rt.is_null() {
        diag_halt("JS_NewRuntime returned null");
    }
    trace("run: JS_NewRuntime ok");
    let ctx = JS_NewContext(rt);
    if ctx.is_null() {
        diag_halt("JS_NewContext returned null");
    }
    trace("run: JS_NewContext ok");
    let global = JS_GetGlobalObject(ctx);
    trace("run: global object ok");

    trace("run: register gfx");
    gfx::register(ctx, global);
    trace("run: register gfx3d");
    gfx3d::register(ctx, global);
    trace("run: register bridge");
    bridge::register(ctx, global);

    trace("run: JS_Eval begin");
    let res = JS_Eval(
        ctx,
        GAME_JS.as_ptr() as *const _,
        GAME_JS.len() - 1, // length excluding the trailing NUL
        b"game.js\0".as_ptr() as *const _,
        JS_EVAL_TYPE_GLOBAL as i32,
    );
    if JS_ValueGetTag(res) == JS_TAG_EXCEPTION {
        bridge::log_exception(ctx);
        if trace_enabled() {
            diag_halt("JS_Eval threw an exception");
        }
    }
    JS_FreeValue(ctx, res);
    trace("run: JS_Eval ok");

    // Look up globalThis.frame once; keep it alive for the whole loop.
    let frame_fn = JS_GetPropertyStr(ctx, global, b"frame\0".as_ptr() as *const _);
    if JS_IsUndefined(frame_fn) {
        if trace_enabled() {
            diag_halt("globalThis.frame is undefined");
        }
    }
    trace("run: frame lookup ok");

    // ---- Fixed-timestep frame loop (~60Hz via vblank) ----
    let mut frame_count: u32 = 0;
    loop {
        sys::sceCtrlReadBufferPositive(&mut pad, 1);
        let mask = pad.buttons.bits() as i32;
        if trace_enabled() && frame_count < 4 {
            trace_u32("frame buttons", pad.buttons.bits());
        }

        // Open this frame's display list; JS gfx.* calls enqueue into it.
        sys::sceGuStart(GuContextType::Direct, &mut LIST as *mut _ as *mut c_void);

        let mut args = [JS_NewInt32(ctx, mask)];
        let r = JS_Call(ctx, frame_fn, global, 1, args.as_mut_ptr());
        if JS_ValueGetTag(r) == JS_TAG_EXCEPTION {
            bridge::log_exception(ctx);
            if trace_enabled() {
                diag_halt("frame(buttons) threw an exception");
            }
        }
        JS_FreeValue(ctx, r); // free the return value every frame (leak guard)

        // Present.
        sys::sceGuFinish();
        sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
        sys::sceDisplayWaitVblankStart();
        sys::sceGuSwapBuffers();
        frame_count = frame_count.wrapping_add(1);
    }
}

/// Initialize the GU for double-buffered 480x272 PSM8888 rendering.
unsafe fn init_graphics() {
    let allocator = get_vram_allocator().unwrap();
    let fbp0 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();
    let fbp1 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();
    let zbp = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm4444)
        .as_mut_ptr_from_zero();

    // Prime the VFPU matrix context (used by sceGum*) BEFORE sceGuInit, so the
    // 3D pass's sceGumLoadMatrix/sceGumMatrixMode calls (in gfx3d.rs) operate on
    // an initialized stack. Harmless for 2D-only games, which never touch gum.
    sys::sceGumLoadIdentity();

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

    // ---- 3D pass state ----
    // DepthTest starts DISABLED so 2D-only games (which never call g3d.submit)
    // behave exactly as before; gfx3d::submit ENABLES it for the 3D records each
    // frame, then DISABLES it again so the 2D HUD (gfx.fillRect, z=0, TRANSFORM_2D)
    // draws on top. CullFace stays DISABLED on all hosts (occlusion is depth-only,
    // matching raster3d.ts). The depth buffer is already bound (sceGuDepthBuffer).
    //
    // Reversed-Z depth. The shared projection emits NDC z near->1, far->0, so we
    // map with a STANDARD range (NDC 1 -> window 65535 = near, NDC 0 -> 0 = far),
    // clear to 0 (far) and keep the GREATER fragment — near wins. (The example
    // uses DepthRange(65535,0) because it uses a *standard* projection; pairing
    // that with reversed-Z double-inverts and renders the cube inside-out.)
    sys::sceGuDepthRange(0, 65535);
    sys::sceGuDepthFunc(DepthFunc::GreaterOrEqual);
    sys::sceGuDisable(GuState::DepthTest);

    // 3D render state required for TRANSFORM_3D geometry to rasterize (mirrors
    // rust-psp/examples/cube). CLIP_PLANES is the load-bearing one — without it
    // the GE rejects transformed triangles and nothing draws. Smooth shading lets
    // per-vertex COLOR_8888 gouraud-interpolate; texture stays OFF so vertex color
    // shows directly. CullFace is left OFF to match the software reference.
    sys::sceGuShadeModel(ShadingModel::Smooth);
    sys::sceGuFrontFace(FrontFaceDirection::Clockwise);
    sys::sceGuDisable(GuState::Texture2D);
    sys::sceGuEnable(GuState::ClipPlanes);

    sys::sceGuFinish();
    sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
    sys::sceDisplayWaitVblankStart();
    sys::sceGuDisplay(true);
}
