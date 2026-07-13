#![no_std]
#![no_main]
#![allow(static_mut_refs)]

//! DreamCart runtime: boots QuickJS, exposes a tiny native 2D graphics + input API
//! to JavaScript, evaluates the DREAMCART_GAME-selected file (see build.rs), then
//! drives its `frame(buttons)` function once per vblank while presenting frames
//! via sceGu.

extern crate alloc;

use core::ffi::c_void;

use libquickjs_sys::*;
use psp::sys::{
    self, CtrlMode, DepthFunc, DisplayPixelFormat, FrontFaceDirection, GuContextType, GuState,
    GuSyncBehavior, GuSyncMode, SceCtrlData, ShadingModel, TexturePixelFormat, ThreadAttributes,
};
#[cfg(feature = "capture")]
use psp::sys::{DisplaySetBufSync, IoOpenFlags};
use psp::vram_alloc::get_vram_allocator;
use psp::{Align16, BUF_WIDTH, SCREEN_HEIGHT, SCREEN_WIDTH};

mod arena;
mod audio;
mod bridge;
mod c_heap;
mod gfx;
mod gfx3d;
mod qjs_alloc;

psp::module!("dreamcart_runtime", 1, 1);

// GE display list buffer (256 KB), 16-byte aligned.
static mut LIST: Align16<[u32; 0x40000]> = Align16([0; 0x40000]);

// The game source, selected at build time by `DREAMCART_GAME` (see build.rs) and
// NUL-terminated there for JS_Eval (which wants input[len] == '\0').
static GAME_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/game.js"));
// The game's binary asset pack (see docs/dcpak-format.md), embedded by build.rs.
// Empty for games with no baked assets (and raw demos). Exposed to JS as the
// global ArrayBuffer `__dcpak` (zero-copy over this static slice) before eval, so
// the baked asset modules read their typed-array blobs from it instead of
// base64-decoding megabyte string literals at boot.
static GAME_DCPAK: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/game.dcpak"));
static DREAMCART_TRACE: &str = env!("DREAMCART_TRACE");
#[cfg(feature = "capture")]
static DREAMCART_CAPTURE_INPUT: &str = env!("DREAMCART_CAPTURE_INPUT");

// The libquickjs-sys wrapper (src/lib.rs) re-exports JS_GetArrayBuffer but not
// JS_NewArrayBuffer, which the linked QuickJS C library does provide (quickjs.h).
// Declare it here so we can wrap the static GAME_DCPAK rodata into an ArrayBuffer
// zero-copy: free_func = None means QuickJS never frees it (it is .rodata, not
// heap), and the JS reader only slices read-only copies out of it.
extern "C" {
    fn JS_NewArrayBuffer(
        ctx: *mut JSContext,
        buf: *mut u8,
        len: usize,
        free_func: Option<unsafe extern "C" fn(*mut JSRuntime, *mut c_void, *mut c_void)>,
        opaque: *mut c_void,
        is_shared: i32,
    ) -> JSValue;
}

fn psp_main() {
    unsafe { boot() }
}

/// The `psp::module!` macro starts the main thread with only a 256 KB stack.
/// QuickJS compiling the ~35 KB framework bundles recurses deeper than that and
/// overflows the stack (-> abort). Run all the real work on a worker thread with
/// a large (2 MB) stack instead. Raw demos fit in 256 KB but this is harmless.
unsafe fn boot() {
    trace("psp_main: creating worker thread");
    let id = sys::sceKernelCreateThread(
        b"dreamcart_main\0".as_ptr(),
        worker_main,
        32,                // priority
        2 * 1024 * 1024,   // 2 MB stack
        // sceGum* emits VFPU instructions; real PSP/Vita needs the thread flag.
        ThreadAttributes::USER | ThreadAttributes::VFPU,
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
    DREAMCART_TRACE == "1"
}

unsafe fn trace(msg: &str) {
    if trace_enabled() {
        psp::dprintln!("[dreamcart trace] {}", msg);
    }
}

unsafe fn trace_i32(label: &str, value: i32) {
    if trace_enabled() {
        psp::dprintln!("[dreamcart trace] {}: {}", label, value);
    }
}

unsafe fn trace_u32(label: &str, value: u32) {
    if trace_enabled() {
        psp::dprintln!("[dreamcart trace] {}: 0x{:08x}", label, value);
    }
}

unsafe fn trace_usize(label: &str, value: usize) {
    if trace_enabled() {
        psp::dprintln!("[dreamcart trace] {}: {}", label, value);
    }
}

unsafe fn trace_halt(msg: &str) -> ! {
    psp::dprintln!("[dreamcart halt] {}", msg);
    psp::dprintln!("HOME exits. Last stage stays on screen.");
    loop {
        sys::sceDisplayWaitVblankStart();
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

    // ---- Audio thread ----
    // CRITICAL ORDERING: start the dedicated audio synth thread BEFORE
    // qjs_alloc::new_runtime(). arena.rs grabs most of the kernel partition on the
    // first JS allocation; the audio thread's 64 KB stack must be carved out first,
    // and the audio thread NEVER touches the single-threaded arena allocator (see
    // runtime/src/audio.rs top comment). It idles (mixes silence) until the first
    // snd.submit, so 2D games that never use sound pay only one low-prio slice/granule.
    trace("run: starting audio thread");
    let aid = audio::start_audio_thread();
    trace_i32("audio thread id", aid);

    // ---- QuickJS: runtime, context, native API, evaluate the game ----
    // Use the Rust/PSP allocator (newlib malloc has no heap under rust-psp).
    trace_usize("run: free mem before JS", sys::sceKernelTotalFreeMemSize());
    trace("run: JS_NewRuntime begin");
    let rt = qjs_alloc::new_runtime();
    if rt.is_null() {
        trace_halt("JS_NewRuntime returned null");
    }
    trace("run: JS_NewRuntime ok");
    let ctx = JS_NewContext(rt);
    if ctx.is_null() {
        trace_halt("JS_NewContext returned null");
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
    trace("run: register audio");
    audio::register(ctx, global);

    // Capture builds tell the game to run its deterministic, input-free camera path
    // (frame-indexed `capturePose`), so PPSSPPHeadless can dump a reproducible sequence.
    #[cfg(feature = "capture")]
    JS_SetPropertyStr(
        ctx,
        global,
        b"__BSP_CAPTURE\0".as_ptr() as *const _,
        JS_NewInt32(ctx, 1),
    );

    // Expose the embedded asset pack as globalThis.__dcpak BEFORE eval (the baked
    // asset modules read it at module-eval time). Zero-copy: the ArrayBuffer views
    // the static GAME_DCPAK rodata directly (free_func = None — never freed); the
    // JS reader (framework/src/dcpak.ts) only slices read-only copies out of it.
    // INVARIANT: __dcpak is immutable. Unlike the copy-based Web/3DS hosts, this
    // buffer aliases .rodata, so a JS write through it (e.g. `new Uint8Array(
    // globalThis.__dcpak)[0] = x`) would fault/corrupt on real hardware. First-party
    // baked modules never write it; do not expose __dcpak as a writable surface.
    if !GAME_DCPAK.is_empty() {
        trace_usize("run: dcpak bytes", GAME_DCPAK.len());
        let ab = JS_NewArrayBuffer(
            ctx,
            GAME_DCPAK.as_ptr() as *mut u8,
            GAME_DCPAK.len() as _,
            None,
            core::ptr::null_mut(),
            0,
        );
        JS_SetPropertyStr(ctx, global, b"__dcpak\0".as_ptr() as *const _, ab);
    }

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
            trace_halt("JS_Eval threw an exception");
        }
    }
    JS_FreeValue(ctx, res);
    trace("run: JS_Eval ok");

    // Look up globalThis.frame once; keep it alive for the whole loop.
    let frame_fn = JS_GetPropertyStr(ctx, global, b"frame\0".as_ptr() as *const _);
    if JS_IsUndefined(frame_fn) {
        if trace_enabled() {
            trace_halt("globalThis.frame is undefined");
        }
    }
    trace("run: frame lookup ok");

    // ---- Fixed-timestep frame loop (~60Hz via vblank) ----
    let mut frame_count: u32 = 0;
    loop {
        sys::sceCtrlReadBufferPositive(&mut pad, 1);
        // Buttons live in the low 16 bits (max Btn.Square=0x8000); pack the analog
        // stick into the free high 16 bits as two signed bytes (x=16..23, y=24..31,
        // each lx/ly-128 clamped to [-127,127]). The JS reader (framework/src/
        // input.ts Input.update) sign-extends and /127s them; digital-only hosts
        // leave the high bits 0 so axis() falls back to the d-pad and goldens hold.
        let bx = (pad.lx as i32 - 128).clamp(-127, 127);
        let by = (pad.ly as i32 - 128).clamp(-127, 127);
        let mask = (pad.buttons.bits() as i32 & 0xffff) | ((bx & 0xff) << 16) | ((by & 0xff) << 24);
        #[cfg(feature = "capture")]
        let mask = capture_input_mask(frame_count, mask);
        if trace_enabled() && frame_count < 4 {
            trace_u32("frame buttons", pad.buttons.bits());
        }

        // Capture builds drive the game's frame-indexed camera path by the SAME counter
        // that names the dumped frame, so PSP pose N == file fN == the WebGL override N. The
        // JS engine's own ctx.frame is a separate counter we must NOT depend on for this.
        #[cfg(feature = "capture")]
        JS_SetPropertyStr(
            ctx,
            global,
            b"__capFrameOverride\0".as_ptr() as *const _,
            JS_NewInt32(ctx, frame_count as i32),
        );

        // Open this frame's display list; JS gfx.* calls enqueue into it.
        sys::sceGuStart(GuContextType::Direct, &mut LIST as *mut _ as *mut c_void);

        let mut args = [JS_NewInt32(ctx, mask)];
        let r = JS_Call(ctx, frame_fn, global, 1, args.as_mut_ptr());
        if JS_ValueGetTag(r) == JS_TAG_EXCEPTION {
            bridge::log_exception(ctx);
            if trace_enabled() {
                trace_halt("frame(buttons) threw an exception");
            }
        }
        JS_FreeValue(ctx, r); // free the return value every frame (leak guard)

        // Present.
        sys::sceGuFinish();
        sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
        sys::sceDisplayWaitVblankStart();
        sys::sceGuSwapBuffers();

        // Capture build only. Two reproducible-capture paths for the ground-truth loop,
        // both no-ops everywhere but PPSSPPHeadless:
        //   (1) single static frame (M1): emit the display framebuffer to the host via the
        //       "emulator:" EMIT_SCREENSHOT=0x20 devctl -> __testfailure.bmp.
        //   (2) camera-path sequence (M2): dump each frame in the capture window to a raw
        //       file on the memstick (ms0:/dc_cap/fNNNN.raw) so a whole motion path can be
        //       captured in one run and diffed frame-by-frame to surface flicker/jump.
        // Settle a few frames first so boot / first-upload transients aren't captured.
        #[cfg(feature = "capture")]
        {
            if frame_count >= 4 {
                sys::sceIoDevctl(
                    b"emulator:\0".as_ptr(),
                    0x20,
                    core::ptr::null_mut(),
                    0,
                    core::ptr::null_mut(),
                    0,
                );
            }
            cap_dump_frame(frame_count);
        }

        frame_count = frame_count.wrapping_add(1);
    }
}

#[cfg(feature = "capture")]
fn parse_capture_u32(s: &[u8], mut i: usize, end: usize) -> Option<u32> {
    while i < end && (s[i] == b' ' || s[i] == b'\t') {
        i += 1;
    }
    if i >= end {
        return None;
    }
    let hex = i + 1 < end && s[i] == b'0' && (s[i + 1] == b'x' || s[i + 1] == b'X');
    if hex {
        i += 2;
    }
    let mut out = 0u32;
    let mut any = false;
    while i < end {
        let c = s[i];
        let d = if c >= b'0' && c <= b'9' {
            c - b'0'
        } else if hex && c >= b'a' && c <= b'f' {
            c - b'a' + 10
        } else if hex && c >= b'A' && c <= b'F' {
            c - b'A' + 10
        } else if c == b' ' || c == b'\t' {
            break;
        } else {
            return None;
        };
        out = out.saturating_mul(if hex { 16 } else { 10 }).saturating_add(d as u32);
        any = true;
        i += 1;
    }
    if any { Some(out) } else { None }
}

/// Build-time scripted input for deterministic PPSSPPHeadless captures.
///
/// Format: `frame:mask,frame:mask` where mask may be decimal or hex. The active
/// mask is the last threshold at or before `frame_count`, so
/// `0:0,12:0x20` means settle in the default pose, then hold RIGHT from frame 12.
#[cfg(feature = "capture")]
fn capture_input_mask(frame_count: u32, fallback: i32) -> i32 {
    let s = DREAMCART_CAPTURE_INPUT.as_bytes();
    if s.is_empty() {
        return fallback;
    }
    let mut i = 0usize;
    let mut best_frame: Option<u32> = None;
    let mut best_mask = fallback as u32;
    while i < s.len() {
        while i < s.len() && (s[i] == b',' || s[i] == b';' || s[i] == b' ' || s[i] == b'\t') {
            i += 1;
        }
        let frame_start = i;
        while i < s.len() && s[i] != b':' && s[i] != b',' && s[i] != b';' {
            i += 1;
        }
        if i >= s.len() || s[i] != b':' {
            break;
        }
        let frame_end = i;
        i += 1;
        let mask_start = i;
        while i < s.len() && s[i] != b',' && s[i] != b';' {
            i += 1;
        }
        let mask_end = i;
        if let (Some(frame), Some(mask)) = (
            parse_capture_u32(s, frame_start, frame_end),
            parse_capture_u32(s, mask_start, mask_end),
        ) {
            if frame <= frame_count && best_frame.map_or(true, |best| frame >= best) {
                best_frame = Some(frame);
                best_mask = mask;
            }
        }
    }
    best_mask as i32
}

/// Dump the just-presented display framebuffer to `ms0:/dc_cap/fNNNN.raw` (512-stride
/// RGBA, as the GE wrote it) for the frames in the capture window. One headless run thus
/// yields a deterministic image-per-pose sequence of the game's frame-indexed camera path.
#[cfg(feature = "capture")]
unsafe fn cap_dump_frame(frame_count: u32) {
    const CAP_START: u32 = 8; // skip boot / first-upload transients
    const CAP_N: u32 = 24; // frames captured along the path
    if frame_count < CAP_START || frame_count >= CAP_START + CAP_N {
        return;
    }
    let idx = frame_count - CAP_START;
    if idx == 0 {
        sys::sceIoMkdir(b"ms0:/dc_cap\0".as_ptr(), 0o777);
    }
    // "ms0:/dc_cap/fNNNN.raw\0" with the 4 digits (offsets 13..=16) patched from idx.
    let mut name: [u8; 22] = *b"ms0:/dc_cap/f0000.raw\0";
    let mut v = idx;
    let mut i = 16usize;
    loop {
        name[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if i == 13 {
            break;
        }
        i -= 1;
    }
    // Resolve the current display buffer and read it straight from VRAM (uncached mirror,
    // so we see the GE's fresh output rather than a stale cache line).
    let mut top: *mut c_void = core::ptr::null_mut();
    let mut bw: usize = 0;
    let mut fmt = DisplayPixelFormat::Psm8888;
    sys::sceDisplayGetFrameBuf(&mut top, &mut bw, &mut fmt, DisplaySetBufSync::Immediate);
    let mut addr = top as u32;
    if addr < 0x0400_0000 {
        addr += 0x0400_0000;
    }
    addr |= 0x4000_0000;
    let fd = sys::sceIoOpen(
        name.as_ptr(),
        IoOpenFlags::CREAT | IoOpenFlags::WR_ONLY | IoOpenFlags::TRUNC,
        0o777,
    );
    if fd.0 >= 0 {
        sys::sceIoWrite(fd, addr as *const c_void, 512 * 272 * 4);
        sys::sceIoClose(fd);
    }
}

/// Initialize the GU for double-buffered 480x272 PSM8888 rendering.
unsafe fn init_graphics() {
    trace("init_graphics: get_vram_allocator");
    let allocator = match get_vram_allocator() {
        Ok(allocator) => allocator,
        Err(_) => trace_halt("get_vram_allocator failed"),
    };
    trace("init_graphics: alloc fbp0");
    let fbp0 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();
    trace("init_graphics: alloc fbp1");
    let fbp1 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();
    trace("init_graphics: alloc zbp");
    let zbp = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm4444)
        .as_mut_ptr_from_zero();

    // Prime the VFPU matrix context (used by sceGum*) BEFORE sceGuInit, so the
    // 3D pass's sceGumLoadMatrix/sceGumMatrixMode calls (in gfx3d.rs) operate on
    // an initialized stack. Harmless for 2D-only games, which never touch gum.
    trace("init_graphics: sceGumLoadIdentity");
    sys::sceGumLoadIdentity();

    trace("init_graphics: sceGuInit");
    sys::sceGuInit();
    trace("init_graphics: sceGuStart");
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
    trace("init_graphics: display on");
}
