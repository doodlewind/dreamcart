//! Misc native bindings exposed to JS: `log()` plus an exception printer used
//! by the Rust host when eval/calls throw.

use libquickjs_sys::*;

/// Render a QuickJS C-string to the PSP debug text overlay (writes into VRAM).
unsafe fn print_jsstr(ctx: *mut JSContext, val: JSValue, prefix: &str) {
    let mut len: size_t = 0;
    let ptr = JS_ToCStringLen2(ctx, &mut len, val, 0);
    if ptr.is_null() {
        return;
    }
    let bytes = core::slice::from_raw_parts(ptr as *const u8, len as usize);
    if let Ok(s) = core::str::from_utf8(bytes) {
        psp::dprintln!("{}{}", prefix, s);
    }
    JS_FreeCString(ctx, ptr);
}

/// `log(msg)` — print a string to the debug overlay (diagnostics only).
unsafe extern "C" fn js_log(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc >= 1 {
        print_jsstr(ctx, *argv, "");
    }
    JS_UNDEFINED
}

/// `now()` — wall-clock microseconds (PSP system time) as a double. Lets games
/// measure real frame time / FPS (the engine's `dt` is a FIXED timestep, not the
/// actual elapsed time). Other hosts expose the same name (Web: performance.now()
/// in ms — games that use it for FPS divide accordingly per host if needed).
unsafe extern "C" fn js_now(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    let us = psp::sys::sceKernelGetSystemTimeWide() as f64;
    JS_NewFloat64(ctx, us)
}

/// Install `log` + `now` onto the JS global object.
pub unsafe fn register(ctx: *mut JSContext, global: JSValue) {
    let f_log = JS_NewCFunction2(
        ctx,
        Some(js_log),
        b"log\0".as_ptr() as *const _,
        1,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, global, b"log\0".as_ptr() as *const _, f_log);

    let f_now = JS_NewCFunction2(
        ctx,
        Some(js_now),
        b"now\0".as_ptr() as *const _,
        0,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, global, b"now\0".as_ptr() as *const _, f_now);
}

/// Fetch and print the pending JS exception (call after a TAG_EXCEPTION result).
pub unsafe fn log_exception(ctx: *mut JSContext) {
    let exc = JS_GetException(ctx);
    print_jsstr(ctx, exc, "JS error: ");
    JS_FreeValue(ctx, exc);
}
