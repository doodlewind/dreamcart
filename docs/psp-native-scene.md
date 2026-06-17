# Retained native scene (PSP) — moving the per-node math off QuickJS

## Why

On the PSP, the per-frame bottleneck for a large 3D scene is **not the GE** — it's the
**JavaScript scene-graph walk on the interpreted QuickJS core** (≈1 ms *per node*:
world-matrix compose/multiply, frustum cull, draw-command encode). QuickJS-on-emulated-MIPS
is ~1000–3000× slower than V8, so even mechanical math over ~100 nodes dominates the frame.

Profiling `outdoor3d` (126 nodes) on PPSSPP:

| Path | FPS |
|---|---|
| Object scene-graph walk (per-node JS objects) | 4 |
| Flat typed-array fast path (still JS) | 7 |
| + matrix memcpy + fewer nodes (56) | 10 |
| **Retained native scene (cull + draw in Rust)** | **15** (full HUD) / **30** (minimal HUD) |

The refined boundary: per-node **frustum culling + world-matrix composition + draw
encoding are rendering plumbing, not game logic** — they belong in native code. The game
logic ("where is the camera, what moved this frame") stays in JS and is tiny.

## Design

A retained scene lives on the native side (`runtime/src/gfx3d.rs`). JS uploads it ONCE,
then per frame sends only the camera; native culls + draws the whole list.

Contract (optional methods on `g3d`, see `framework/src/host3d.ts`):

```
g3d.sceneClear()                                   // start a rebuild
g3d.sceneAdd(handle, tex, tint, geom)              // geom = 22 f32: 16 model + 3 aabbMin + 3 aabbMax
g3d.sceneSetEnv(env | null)                        // lights + fog, packed
g3d.sceneRender(camera) -> drawnCount              // 20 f32: 16 viewProj + 3 eye + 1 cullFar
```

`Scene3D.render` (`framework/src/scene3d.ts`) takes the native path **only when every
drawable node is static AND the host implements `sceneRender`** (`hasNativeScene()`):
it flattens the scene once (`buildFlat` → typed arrays), uploads it via
`sceneClear`/`sceneAdd`/`sceneSetEnv`, then each frame packs the camera and calls
`sceneRender`. `sceneRender` returns the visible count so JS can still report culling.

Dynamic objects (car wheels, the Fox) keep the per-frame `submit` command-buffer path.
Mixed scenes (some dynamic) also use `submit` (the flat fast path).

## Cross-host + golden

`sceneRender` is **optional**. The golden harness (`raster3d.ts`) and Web/3DS do NOT
implement it → `Scene3D` falls back to the per-frame command-buffer path, so the
byte-exact `.dc3d` and pixel goldens are **unchanged** and still validate the cull/draw
logic (the JS flat path is the oracle). The native cull mirrors the JS
`aabbCulled`/`makeFrustum` math exactly (4 side planes positive-vertex test + far-distance
cutoff); equivalence is checked on-device (same visible set / image as the golden).

## Remaining floor: HUD text

With the scene math native, the next per-frame floor is **`g.text` glyph rasterization**:
it emits one fill-run per glyph pixel-row-run in a JS loop (hundreds of iterations/frame).
Batched drawing (`gfx.fillRects`) collapsed the FFI crossings, but the *loop itself* is the
cost. Dropping the verbose HUD took `outdoor3d` 15 → 30 FPS. The same remedy applies —
move glyph rasterization native (a baked font table + `gfx.drawText`) — and is the next
lever if HUD-heavy scenes need 60 FPS.
