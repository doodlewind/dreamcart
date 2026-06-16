# DreamCart — Android dual-screen runtime

A native Android app that turns a **dual-screen Android handheld** (3DS-style:
two physical internal displays, *not* a folding phone) into a DreamCart console:

- **Top screen** (default display) runs the JS games, unchanged, via the *exact*
  isomorphic engine the Web build uses ([`web/engine.js`](../web/engine.js)) inside
  a full-screen `WebView`. Same tiny native contract (`gfx.clear`, `gfx.fillRect`,
  `log`, `frame(buttons)`) as PSP / Web / 3DS — **including the optional `g3d` 3D
  contract**: the WebView is hardware-accelerated, so the engine's WebGL2 layer
  renders the `cube3d` / `racing3d` / `fps3d` games (a 3D canvas stacked under the
  Canvas2D HUD; `engine.js` mirrors the top screen's letterbox size onto it). No
  Android-side code is needed — the same `web/engine.js` does 3D here too.
- **Bottom screen** (the device's second internal display) is a native Android
  `Presentation` — the game **library** (tap a title to switch). No WebView, no
  virtual gamepad: the console's **physical** D-pad / ABXY buttons play the game
  on the top screen. The Presentation window is non-focusable so it can never
  capture the physical keys (they always reach the game, never navigate the menu).

Both screens share the Activity lifecycle: backgrounding the app (swipe-up home)
dismisses the bottom screen too, and returning restores it.

Verified end-to-end on an **AYN Thor** (two internal displays: `0` top 1080×1920,
`4` bottom 1240×1080, both touch).

## Architecture

```
 ┌─────────── display 0 (top) ───────────┐   ┌──────── display 4 (bottom) ────────┐
 │ MainActivity                          │   │ BottomPresentation                 │
 │  WebView → assets/index.html          │   │  game library (tap to switch)      │
 │   engine.js + games.generated.js      │   │  now-playing + hint + log          │
 │   window.DreamCart.play/press         │   │  (non-focusable: no key capture)   │
 └───────────────┬───────────────────────┘   └──────────────┬─────────────────────┘
                 │  evaluateJavascript()  ▲                   │ Runtime.play / .press
                 ▼                        │ @JavascriptInterface
            ┌──────────────────────  Runtime (singleton)  ──────────────────────┐
            │ games[], current, button bits, marshals JS⇄native on the main loop │
            └────────────────────────────────────────────────────────────────────┘
```

- `Runtime` is the hub. The bottom UI calls `Runtime.play(file)` / `Runtime.press(bit,down)`;
  these become JS run in the WebView. The JS shell reports its library / current
  game / logs back through `WebBridge` (`@JavascriptInterface`), which updates
  `Runtime` and notifies the Presentation on the main thread.
- **Input.** The console's physical buttons play the game, intercepted in
  `MainActivity.dispatchKeyEvent` (face/START/SELECT as `KEYCODE_BUTTON_*`) and
  `dispatchGenericMotionEvent` (this device's D-pad arrives as a **hat axis**,
  `AXIS_HAT_X/Y`, not key events). **L1/R1** flip through the library (the
  DreamCart contract has no L/R, so games never read them). Games can also be
  switched by tapping the bottom library or via a debug broadcast. All paths
  funnel through `Runtime.press` / `Runtime.play`.
- Button bits are the canonical DreamCart bitmask (`Runtime.Btn`), identical to
  `web/engine.js` `BTN` and `framework/src/input.ts`.

## Build & run

```sh
bun android/sync-assets.ts          # copy engine.js + build games.generated.js into assets
cd android
./gradlew :app:assembleDebug        # APK -> app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n games.dreamcart/.MainActivity
```

Or from the repo root: `bun run android` (sync + assemble) and
`bun run android:install` (install + launch).

The asset sync reuses whatever games are in `runtime/src/game/`. Run
`bun run bake && bun framework/build.ts` first to include the framework games
(raw games need no build).

## Switching games (the bottom screen)

Tap a title in the bottom-screen library, or press **L1/R1** on the console.
For tests, **debug builds** also register a broadcast hook (not present in
release):

```sh
adb shell am broadcast -a games.dreamcart.PLAY --es game raw-tetris.js
adb shell am broadcast -a games.dreamcart.PLAY --ei index 3
adb shell am broadcast -a games.dreamcart.PLAY --es nav next   # or prev
```

## Testing on secure-display hardware

The Thor reports both internal panels as secure displays in hardware (not an app
flag — the app never sets `FLAG_SECURE`), so `adb shell screencap` returns blank
frames. Debug builds therefore expose a headless verification path:

- A 1 Hz canvas **fingerprint** (`FP nz=<non-black px> sum=<checksum>`) logged
  under tag `DreamCart` — non-zero & changing proves the top screen is rendering
  and animating the current game. (Enabled only when `BuildConfig.DEBUG`.)
- Each game button's screen-coordinates are logged (`GAMEBTN … tap=x,y`) so e2e
  tests can drive real touches with `adb shell input -d 4 tap <x> <y>`.

```sh
adb logcat -s DreamCart        # watch boot, game switches, input, fingerprints
```

## Notes / future work

- The top screen runs the engine in a WebView (the established, tested "Web"
  target). A QuickJS-via-NDK host (peer to the PSP/3DS native runtimes) is a
  natural next step but unnecessary for correctness — the same JS games run here
  unchanged today.
- If a device reports the *bottom* panel as the default display, swap which
  display gets the WebView vs the Presentation in `MainActivity.showBottomScreen()`.
