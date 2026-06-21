# The Runtime Contract

DreamCart is **isomorphic**: the *same* game `.js` file runs unchanged on the Sony
PSP, the Web, the Nintendo 3DS, and the dual-screen Android handheld. There is no
per-platform game code. That guarantee rests on one deliberately tiny agreement
between the game and its host — the **runtime contract**.

A host (the native program embedding [QuickJS](https://bellard.org/quickjs/))
promises to expose a handful of globals and to call your game once per frame. Your
game promises to define a single `frame(buttons)` function and to draw using only
those globals. That is the entire contract. Everything else — the
[framework SDK](framework), the [3D layer](3d), [asset baking](assets) — is built
*on top of* it, in shared JavaScript.

## The two globals + one callback

A host installs exactly three things on `globalThis`:

```js
// Provided by the host (Rust on PSP, Canvas on Web, libctru on 3DS):
gfx.clear(r, g, b);                    // clear the whole screen to a color
gfx.fillRect(x, y, w, h, r, g, b);     // draw one filled rectangle
log(msg);                              // print a string to the debug overlay

// Provided by YOUR game — the host calls it once per frame (~60 Hz):
function frame(buttons) { /* update + draw here */ }
```

Colors are three separate channels, each `0..255`. Coordinates and sizes are in
**logical screen pixels**: the screen is **480 × 272** (the PSP's panel) on every
platform — other hosts scale that logical surface to fit their display, so a game
never has to know the physical resolution.

The host owns the loop and the timing. Your `frame` is invoked from the host's
vblank/`requestAnimationFrame` driver; you never run your own `while (true)` or
`setInterval`. Pacing, double-buffering, and frame submission are the host's job.
On the PSP, for example, the Rust host opens the GE display list, calls
`frame(buttons)`, then finishes / syncs / swaps the buffers.

### A complete raw game

Because the contract is so small, a real game fits in a few lines. This bouncing
square is a full, valid DreamCart game — it runs as-is on PSP, Web, and 3DS:

```js
// @title Bouncer
// @controls D-pad nudge; START reset
var BTN_UP = 0x10, BTN_RIGHT = 0x20, BTN_DOWN = 0x40, BTN_LEFT = 0x80;
var BTN_START = 0x08;

var x = 100, y = 100, vx = 2, vy = 1.4, S = 24;

function frame(buttons) {
  // --- update ---
  if (buttons & BTN_START) { x = 100; y = 100; }
  if (buttons & BTN_LEFT) vx -= 0.2;
  if (buttons & BTN_RIGHT) vx += 0.2;
  if (buttons & BTN_UP) vy -= 0.2;
  if (buttons & BTN_DOWN) vy += 0.2;

  x += vx; y += vy;
  if (x < 0 || x + S > 480) vx = -vx;     // 480 = screen width
  if (y < 0 || y + S > 272) vy = -vy;     // 272 = screen height

  // --- draw ---
  gfx.clear(16, 20, 30);                  // dark blue background
  gfx.fillRect(x, y, S, S, 80, 220, 120); // green square
}
```

That is the whole API surface a game is *required* to use. `gfx.fillRect` is the
only drawing primitive — sprites, tiles, and even text in the framework are all
rasterized down to runs of `fillRect` calls.

## The button bitmask

`frame(buttons)` receives a single integer. Its low 16 bits are a fixed
**controller bitmask**, identical on every platform — the Web and 3DS hosts remap
their physical inputs (keyboard, touch, the 3DS pad) onto these exact bits, and the
PSP passes them straight through from `sceCtrl`:

```js
const BTN = {
  SELECT:   0x01,
  START:    0x08,
  UP:       0x10,
  RIGHT:    0x20,
  DOWN:     0x40,
  LEFT:     0x80,
  LTRIGGER: 0x100,
  RTRIGGER: 0x200,
  TRIANGLE: 0x1000,
  CIRCLE:   0x2000,
  CROSS:    0x4000,
  SQUARE:   0x8000,
};

// A button is held this frame iff its bit is set:
if (buttons & BTN.CROSS) jump();
```

These values mirror the PSP's `CtrlButtons`. They are not an implementation detail
you may ignore: a contract test
([`framework/test/contract.ts`](https://github.com/doodlewind/dreamcart/blob/main/framework/test/contract.ts))
asserts that the Web host, the 3DS host, the framework SDK's `Btn` table, and every
raw demo's `BTN_*` constants all agree, so they can never silently drift apart.

A `buttons` word is a snapshot: holding a button keeps its bit set every frame.
**Edge detection** (was this the frame a button went down?) is the game's job — you
remember the previous frame's mask and compare. The framework's
[`Input`](framework#input) does this for you with `pressed()` / `released()`.

### Optional analog stick

The high 16 bits of the word may carry an analog stick: the host MAY pack the X
axis into bits 16–23 and the Y axis into bits 24–31, each as a signed byte
(`lx - 128`, clamped to `[-127, 127]`). The PSP host fills these in; digital-only
hosts leave them zero, so a game that only reads the low 16 bits behaves identically
everywhere. The framework's `Input.axis()` reads the stick past a deadzone and
falls back to the D-pad when it is absent — so the same game plays correctly with or
without an analog nub.

## `log()` and `now()`

`log(msg)` prints a string to the host's debug overlay (the dprintln overlay on
PSP, the console in the Web [Playground](/play/), the bottom screen on 3DS). It is
for diagnostics only — never a drawing primitive.

Hosts also expose `now()`, returning a high-resolution timestamp (PSP system
microseconds; `performance.now()` milliseconds on Web). The framework's fixed
timestep `dt` is *not* wall-clock time, so a game that wants a true FPS / frame-time
reading uses `now()`. It is the only other ambient global, and it is optional —
games that don't measure timing never touch it.

## Optional fast paths (same contract, batched)

The contract has a few *optional* members a host may also provide; a game (or the
framework) feature-detects them and falls back to plain `fillRect` when absent, so
the program stays byte-identical across hosts:

- **`gfx.fillRects(buffer, count)`** — draw many rectangles in one call. `buffer`
  is `count × 5` little-endian `i32` quads `[x, y, w, h, rgb]` (where `rgb` is
  `0xRRGGBB`). One FFI crossing instead of hundreds — the framework's text and
  sprite blitters use it.
- **`gfx.uploadFont(table, height)`** / **`gfx.drawText(str, x, y, rgb, scale)`** —
  native text. `uploadFont` installs the active 128-glyph font once; `drawText`
  then rasterizes and draws a whole string in one native call, moving the
  per-pixel glyph loop off the interpreted core.

A separate **optional `g3d` contract** adds hardware-accelerated 3D the same way —
upload meshes once, submit one batched draw-list per frame — backed by `sceGu`/
`sceGum` on PSP, WebGL2 on Web, and citro3d on 3DS. See [3D](3d) for that layer.

## Raw games vs. framework games

There are two ways to write against the contract, and they are a naming
convention — not two engines:

- **Raw games** (`raw-*.js`, in
  [`runtime/src/game/`](https://github.com/doodlewind/dreamcart/tree/main/runtime/src/game))
  use *only* the bare contract above: `gfx.clear`, `gfx.fillRect`, `log`, and a
  hand-written `frame(buttons)` loop. The Bouncer above is one. They have zero
  dependencies and exist to exercise the low-level API directly. In the Playground
  their source stays editable — edit and re-run.

- **Framework games** are authored against the [framework SDK](framework)
  ([`framework/src/`](https://github.com/doodlewind/dreamcart/tree/main/framework/src)),
  a small isomorphic layer that supplies a scene/entity tree, edge-detecting
  `Input`, a seeded `Rng`, a `Graphics` wrapper, palette `Bitmap`s with a baked
  8×8 font, `TileMap`, `DialogueBox`, and the 3D stack. The SDK is **TypeScript**;
  games are still authored in **plain JavaScript** with `// @ts-check` + JSDoc for
  full editor/CI type-checking. Each game is bundled with the framework inlined, so
  the PSP/Web/3DS builds embed identical code.

Crucially, the framework does not change the contract — it *consumes* it. Under the
hood, the engine's `start()` is what installs `globalThis.frame`; everything the SDK
draws still bottoms out in `gfx.fillRect`:

```js
// @ts-check
import { start, Scene, Graphics, Input, Btn, Colors } from '../src/index';

class RootScene extends Scene {
  /** @param {{ input: Input, dt: number }} ctx */
  update(ctx) {
    if (ctx.input.pressed(Btn.Cross)) { /* edge-detected jump */ }
  }
  /** @param {Graphics} g */
  draw(g) {
    g.clear(Colors.dark);
    g.rect(100, 100, 24, 24, Colors.green);
  }
}

start(() => new RootScene()); // installs frame(buttons); host drives it ~60 Hz
```

## Why this guarantees write-once, run-everywhere

Because the contract is the *only* thing a game can depend on, "porting" a game is
not a thing that exists — porting a *host* is. Each platform implements the same
three primitives once:

| Platform | Host | 2D primitive backed by |
|----------|------|------------------------|
| PSP | Rust (rust-psp) + QuickJS | `sceGu` / `sceGum` |
| Web | Canvas + `requestAnimationFrame` | Canvas2D / WebGL2 |
| 3DS | C (libctru) + QuickJS | citro2d / citro3d |
| Android | Kotlin + WebView (the Web engine) | Canvas2D / WebGL2 |

The shared JavaScript bundle never branches on platform. This is also what makes
the [golden tests](framework) possible: the same bundle runs headlessly under Bun
against a mock `gfx` that records into an RGBA framebuffer, which is byte-compared to
a committed PNG — a visual regression on *one* platform is a visual regression on
*all* of them, caught in CI.

See [Platforms & builds](platforms) for how each host is built, [Framework SDK](framework)
for the layer above the contract, and [3D](3d) for the optional `g3d` extension.
