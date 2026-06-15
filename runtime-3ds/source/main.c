// psp-js 3DS host: boots QuickJS, exposes the same gfx/log/frame(buttons) API
// the PSP and Web builds provide, and runs the exact same game .js file.
//
// The game's 480x272 logical screen is uniform-scaled to fit the 3DS top
// screen (400x240) and vertically centered. Logs go to the bottom screen.
#include <3ds.h>
#include <citro2d.h>
#include <citro3d.h>
#include <stdio.h>

#include "quickjs.h"
#include "game_js.h"   // generated: GAME_JS[] and GAME_JS_LEN

#define LOGIC_W 480.0f
#define LOGIC_H 272.0f

static C3D_RenderTarget *g_top;
static float g_scale, g_offy;

// QuickJS (this fork) calls debug_log() unconditionally during init; provide it.
void debug_log(const char *msg, int a) { (void)a; printf("[qjs] %s\n", msg); }

static inline u32 col(int r, int g, int b) {
    return C2D_Color32((u8)(r & 255), (u8)(g & 255), (u8)(b & 255), 0xFF);
}

// gfx.clear(r,g,b)
static JSValue js_gfx_clear(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t r = 0, g = 0, b = 0;
    if (argc >= 3) {
        JS_ToInt32(ctx, &r, argv[0]);
        JS_ToInt32(ctx, &g, argv[1]);
        JS_ToInt32(ctx, &b, argv[2]);
    }
    C2D_TargetClear(g_top, col(r, g, b));
    C2D_SceneBegin(g_top);
    return JS_UNDEFINED;
}

// gfx.fillRect(x,y,w,h,r,g,b)
static JSValue js_gfx_fillRect(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 7) return JS_UNDEFINED;
    int x, y, w, h, r, g, b;
    JS_ToInt32(ctx, &x, argv[0]);
    JS_ToInt32(ctx, &y, argv[1]);
    JS_ToInt32(ctx, &w, argv[2]);
    JS_ToInt32(ctx, &h, argv[3]);
    JS_ToInt32(ctx, &r, argv[4]);
    JS_ToInt32(ctx, &g, argv[5]);
    JS_ToInt32(ctx, &b, argv[6]);
    C2D_DrawRectSolid(x * g_scale, y * g_scale + g_offy, 0.0f,
                      w * g_scale, h * g_scale, col(r, g, b));
    return JS_UNDEFINED;
}

// log(msg) -> bottom-screen console
static JSValue js_log(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc >= 1) {
        const char *s = JS_ToCString(ctx, argv[0]);
        if (s) { printf("%s\n", s); JS_FreeCString(ctx, s); }
    }
    return JS_UNDEFINED;
}

static void dump_exception(JSContext *ctx) {
    JSValue e = JS_GetException(ctx);
    const char *s = JS_ToCString(ctx, e);
    if (s) { printf("JS error: %s\n", s); JS_FreeCString(ctx, s); }
    JS_FreeValue(ctx, e);
}

int main(int argc, char **argv) {
    gfxInitDefault();
    consoleInit(GFX_BOTTOM, NULL);   // log output on the bottom screen
    C3D_Init(C3D_DEFAULT_CMDBUF_SIZE);
    C2D_Init(C2D_DEFAULT_MAX_OBJECTS);
    C2D_Prepare();
    g_top = C2D_CreateScreenTarget(GFX_TOP, GFX_LEFT);

    // Uniform-scale the 480x272 logical screen to fit 400x240, centered.
    g_scale = 400.0f / LOGIC_W;                 // ~0.833
    g_offy = (240.0f - LOGIC_H * g_scale) / 2.0f;

    printf("psp-js (3DS) booting QuickJS...\n");
    printf("START+SELECT to quit.\n");

    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);
    JSValue global = JS_GetGlobalObject(ctx);

    JSValue gfx = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, gfx, "clear", JS_NewCFunction(ctx, js_gfx_clear, "clear", 3));
    JS_SetPropertyStr(ctx, gfx, "fillRect", JS_NewCFunction(ctx, js_gfx_fillRect, "fillRect", 7));
    JS_SetPropertyStr(ctx, global, "gfx", gfx);
    JS_SetPropertyStr(ctx, global, "log", JS_NewCFunction(ctx, js_log, "log", 1));

    JSValue res = JS_Eval(ctx, (const char *)GAME_JS, GAME_JS_LEN, "game.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(res)) dump_exception(ctx);
    JS_FreeValue(ctx, res);

    JSValue frame = JS_GetPropertyStr(ctx, global, "frame");
    int have_frame = JS_IsFunction(ctx, frame);
    if (!have_frame) printf("WARN: game defined no global frame()\n");

    while (aptMainLoop()) {
        hidScanInput();
        u32 k = hidKeysHeld();
        if ((k & KEY_START) && (k & KEY_SELECT)) break;

        // Map 3DS keys to the canonical button bitmask (framework/src/input.ts Btn;
        // the // NAME tags are checked against it by framework/test/contract.ts).
        int mask = 0;
        if (k & KEY_UP)     mask |= 0x10;    // UP
        if (k & KEY_RIGHT)  mask |= 0x20;    // RIGHT
        if (k & KEY_DOWN)   mask |= 0x40;    // DOWN
        if (k & KEY_LEFT)   mask |= 0x80;    // LEFT
        if (k & KEY_A)      mask |= 0x4000;  // CROSS
        if (k & KEY_B)      mask |= 0x2000;  // CIRCLE
        if (k & KEY_X)      mask |= 0x8000;  // SQUARE
        if (k & KEY_Y)      mask |= 0x1000;  // TRIANGLE
        if (k & KEY_START)  mask |= 0x08;    // START
        if (k & KEY_SELECT) mask |= 0x01;    // SELECT

        C3D_FrameBegin(C3D_FRAME_SYNCDRAW);
        C2D_SceneBegin(g_top);
        if (have_frame) {
            JSValue arg = JS_NewInt32(ctx, mask);
            JSValue ret = JS_Call(ctx, frame, global, 1, &arg);
            if (JS_IsException(ret)) dump_exception(ctx);
            JS_FreeValue(ctx, ret);
            JS_FreeValue(ctx, arg);
        }
        C3D_FrameEnd(0);
    }

    JS_FreeValue(ctx, frame);
    JS_FreeValue(ctx, global);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    C2D_Fini();
    C3D_Fini();
    gfxExit();
    return 0;
}
