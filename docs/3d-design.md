# DreamCart 3D Design

> ## Implementation status (M0–M5 landed)
> - **JS layer (M0) + all three example games — built & test-verified under Bun.**
>   `framework/src/{math,host3d,g3d,mesh,scene3d}.ts`, engine integration,
>   `index.ts` exports; games `framework/games/{cube3d,racing3d,fps3d}.js`;
>   reference rasterizer `framework/test/raster3d.ts`; goldens
>   `framework/test/goldens/{cube3d,racing3d,fps3d}.{rgbz,png,dc3d}`. `bun run test`
>   = **15 passed, 0 failed**, with **zero regression** on the 6 existing 2D games.
>   The cube/racing/FPS each render as correct 3D scenes through the shared software
>   rasterizer (depth-tested, near-plane clipped).
> - **Web host (M1)** — `web/engine.js` WebGL2 `g3d` (stacked HUD canvas). Builds
>   (`node --check` clean); browser visual pass pending.
> - **PSP host (M2)** — `runtime/src/gfx3d.rs` + `main.rs`. **Builds AND runs on
>   PPSSPP** (verified via a memstick debug log: `uploadMesh`→`submit`→
>   `sceGumLoadMatrix`→`sceGumDrawArray` loop every frame, no abort). Bring-up
>   uncovered three pre-existing PSP gaps (all fixed, none 3D-specific):
>   (1) added the `JS_GetArrayBuffer` FFI binding (`quickjs-rs` submodule);
>   (2) **`runtime/src/c_heap.rs`** — newlib had no C heap, so QuickJS's
>   `strtod`/`__dtoa` (reached by parsing any high-precision float literal like
>   `3.141592653589793` or formatting a float) `malloc`'d into nothing and
>   `abort()`'d — this had broken *every* framework game, 2D included, not just 3D;
>   (3) `sceGumLoadMatrix` needs 16-byte-aligned matrices (`lv.q`), so the wire
>   matrix is copied into a `psp::Align16` before loading. Also runs the JS on a
>   2 MB worker thread (the `psp::module!` main thread is only 256 KB).
>   *Pending: visual confirmation of cube orientation on screen (the transpose
>   spike) — needs a human eye.*
> - **3DS host (M3)** — `runtime-3ds/source/{vshader.v.pica,main.c}` + `Makefile`
>   picasso rule. **Builds `dreamcart-3ds.3dsx`.**
> - **Wire-constant parity** is enforced across all three hosts by `contract.ts`.
> - **Remaining (runtime visual spikes):** confirm the cube renders right-side-out
>   on PPSSPP / Azahar / a browser. The PSP and 3DS hosts made **opposite** matrix
>   transpose choices (PSP loads column-major directly; 3DS transposes into
>   `C3D_Mtx`) — at most one needs adjusting; flip the loser per §9.1 once seen on
>   an emulator. Also verify reversed-Z occlusion agreement per §9.2.
>
> Scope: extend DreamCart's isomorphic 2D contract to 3D
> (rotating cube, racing game, single-room FPS) on **PSP / Web / 3DS**, without
> breaking any existing 2D game.
>
> §1–9 are the synthesized design; **§10 records repo-verified corrections** to the
> Web and Build/Test sections and overrides the body where they conflict.

This document is the authoritative plan. It builds on the highest-scoring
proposal (the **minimal retained-mesh `g3d` contract**) and grafts the
verdict-mandated fixes from the other two: a **single batched `submit` per frame**
(one FFI crossing), a **committed software reference rasterizer in CI from day
one**, **deterministic shared trig** so the emitted bytes are bit-identical
across QuickJS and the browser, and **3DS screen-tilt + projection computed in
shared JS** so the golden describes what every host actually draws.

---

## 1. Executive summary & recommendation

DreamCart's 2D model is already "three independent native renderers behind a
tiny data contract" (`gfx.clear` / `gfx.fillRect` in `runtime/src/gfx.rs`,
`runtime-3ds/source/main.c`, `web/engine.js`). The shared game `.js` is pure
logic; each host rasterizes. **3D is a continuation of that exact shape, not a
new architecture.**

**Chosen boundary model: retained meshes + one batched draw-list `submit` per
frame.**

- **Retained meshes.** Geometry (cube, track, room) is uploaded **once** at game
  init via `g3d.uploadMesh(...) -> handle`. The native side **copies** the bytes
  into its own storage and returns a small integer handle. A 333 MHz PSP cannot
  re-stream FPS/track geometry every frame, so static geometry crosses the
  boundary exactly once.
- **One `submit` per frame.** Each frame the shared JS assembles **one
  command/draw-list `ArrayBuffer`** (camera + per-object `{handle, model16,
  tint}` records, plus an optional inline `IMM_TRIS` block for particles/tracers)
  and hands it across in **one** `g3d.submit(...)` FFI call. The leaf native
  operation per record is exactly `loadMatrix(model)` + `drawArray(handle)` —
  which maps **1:1** onto `sceGumLoadMatrix`+`sceGumDrawArray` on PSP,
  `C3D_FVUnifMtx4x4`+`C3D_DrawArrays` on 3DS, and `uniformMatrix4fv`+`drawElements`
  on Web, with **zero reshaping**.

**Why this and not the alternatives** (the three boundaries the proposals
debated):

| Option | Verdict |
|---|---|
| (a) state-only, each engine derives geometry | Rejected: forces gameplay→geometry to be re-implemented 3×, breaking "logic is one shared copy". |
| (b) immediate per-object FFI call (`drawMesh` × N) | Good leaf shape, but N QuickJS→native crossings/frame and an `sceGumLoadMatrix` VFPU re-prime per call. Unbounded by design. |
| **(c)+(d) retained meshes + one batched buffer** | **Chosen.** Same leaf work as (b), but **one** FFI crossing/frame; the buffer doubles as the deterministic test artifact. |

The single buffer is the key graft from Proposals 2/3: it makes per-frame FFI
**O(1)** regardless of object count, and — critically — **the bytes that cross
the boundary are exactly the bytes the golden test and the software reference
rasterizer consume.** Determinism and testability fall out of the boundary
payload itself.

**The 2D path is untouched.** `gfx.clear`/`gfx.fillRect` stay as the **HUD/overlay
pass**, drawn *after* the 3D pass with depth disabled. A game that never calls
`g3d.*` renders byte-identically to today; a host that doesn't define `g3d`
simply skips 3D (capability probe `typeof g3d !== 'undefined'`).

---

## 2. The 3D native contract

A single new global object `g3d` sits alongside `gfx`. Every host implements it;
the Node golden harness mocks it. The 2D `gfx.*` and `log()` and
`globalThis.frame(buttons)` are unchanged.

### 2.1 API surface

```ts
// framework/src/host3d.ts — the ambient declaration (mirrors host.ts's RawGfx)
export interface RawG3d {
  /**
   * Upload a mesh ONCE at init. The host COPIES the bytes into its own
   * storage (never retains the QuickJS pointer) and returns a small int handle.
   * `vertices` interleaved per `format`; `indices` is a Uint16Array or null.
   * format bitfield: POS=1 (always, 3×f32) | COLOR=2 (u32 ABGR) |
   *                  NORMAL=4 (3×f32) | UV=8 (2×f32).  v1 ships POS|COLOR.
   */
  uploadMesh(vertices: ArrayBuffer, indices: ArrayBuffer | null, format: number): number;

  /** Release native storage (optional; v1 games may never call it). */
  freeMesh(handle: number): void;

  /**
   * THE per-frame call. One little-endian command/draw-list buffer.
   * The host clears depth, runs the 3D pass (depth ON, reversed-Z, back-face
   * cull), then leaves depth OFF so the subsequent gfx.fillRect HUD draws on top.
   * Called exactly once per frame, BEFORE any gfx.fillRect this frame.
   */
  submit(buffer: ArrayBuffer, byteLength: number): void;
}

declare global {
  // eslint-disable-next-line no-var
  var g3d: RawG3d | undefined; // undefined on 2D-only hosts → 3D path skipped
}
```

That is the **entire** native surface: `uploadMesh`, `freeMesh`, `submit`.
Three methods. No per-triangle calls, no per-object calls.

### 2.2 The `submit` buffer (the cross-host wire format)

One little-endian `ArrayBuffer`, assembled by `framework/src/g3d.ts`'s
`CommandEncoder` into a pre-allocated buffer (default 256 KB, grown if needed).
Layout: an 8-byte header, then a sequence of self-describing records.

```
Header (8 bytes):
  u32  magic        = 0x44433344  ('DC3D')   // catch endianness/version drift
  u16  version      = 1
  u16  recordCount

Record = { u16 opcode; u16 payloadWords (count of u32); payload[...] }

  0x01 SET_CAMERA   payload = viewProj : 16×f32 (column-major, premultiplied
                              proj*view*tilt in shared JS — see §4.4)
  0x02 DRAW         payload = u16 handle, u16 tintABGR_hi? ...
                              actually: u32 handle, u32 tintABGR (0xFFFFFFFF=no tint),
                              then model : 16×f32 (column-major model matrix)
  0x03 IMM_TRIS     payload = u32 vertexCount, u32 format,
                              then interleaved vertex data inline (dynamic geometry:
                              particles / tracers / muzzle flash / debug lines)
```

We deliberately keep the opcode set tiny. `SET_CAMERA` appears once per frame;
`DRAW` repeats per visible object; `IMM_TRIS` is the **one** dynamic-geometry
escape hatch grafted from Proposal 2 so the FPS/racing games don't have to fake
particles as static meshes. There is **no** mid-stream depth-toggle opcode (the
fixed-function pipelines don't support it cleanly): depth is ON for the whole 3D
pass and the host turns it OFF once at the end.

The magic+version header lets each native parser fail loudly on drift, and lets
`contract.ts` assert the opcode/format constants are identical across the
JS/Rust/C copies (§5).

### 2.3 Per-frame FFI-call budget

| Phase | Calls/frame |
|---|---|
| init (once, not per frame) | `uploadMesh` × (#distinct meshes) |
| 3D pass | **1** × `g3d.submit` |
| HUD pass | `gfx.fillRect` × (#HUD rects), unchanged from 2D today |

So the 3D rendering cost is **one** QuickJS→native crossing per frame, plus the
existing HUD `fillRect` calls. A racing scene with 40 instanced cones is **40
DRAW records inside one buffer**, not 40 FFI calls. This is the whole point of
the batched boundary.

### 2.4 Pinned conventions (every host must honor these exactly)

These are the silent-garbage footguns; they are pinned **once** and asserted by
the contract test.

- **Matrix storage:** column-major, `m[col*4 + row]`. `v' = M·v` (column
  vectors). 16 contiguous f32. This loads verbatim into `sceGumLoadMatrix`
  (verified: `gum.rs` loads columns from byte offsets 0/16/32/48), into
  `C3D_FVUnifMtx4x4`, and into `gl.uniformMatrix4fv(..., transpose=false)`.
- **World space:** right-handed.
- **Depth:** **reversed-Z**. Clear depth to **0**, depth func **GREATER /
  GreaterOrEqual** (matches `rust-psp/examples/cube`: `sceGuClearDepth(0)` +
  `DepthFunc::GreaterOrEqual`). The shared perspective matrix emits a clip-space
  Z that maps **near→1, far→0** so all three hosts agree on occlusion.
- **Winding / culling:** front face = **clockwise**, cull back faces.
- **Matrices never persist** across frames; the host resets projection/view from
  `SET_CAMERA` every frame.
- **GC discipline:** `uploadMesh` **must copy** the bytes immediately
  (`JS_GetArrayBuffer` returns a GC-movable pointer); the host never retains the
  QuickJS pointer past the call.

---

## 3. Shared JS layer

All new shared code lives under `framework/src/` and is exported from
`framework/src/index.ts`, exactly like the 2D SDK. A game is still authored in
**plain JS** (`// @ts-check` + JSDoc), bundled by `framework/build.ts` (framework
inlined) into `runtime/src/game/<name>.js`, and that single bundle runs on every
host.

### 3.1 New modules

| Module | Responsibility |
|---|---|
| `framework/src/math.ts` | `Vec3`, `Mat4`, `Quat` in **f64**, column-major. `Mat4.perspectiveReversedZ`, `Mat4.lookAt`, `Mat4.multiply`, `Mat4.compose(pos,quat,scale)`, `Quat.fromEuler`, vec3 add/scale/normalize/cross/dot. **Includes deterministic `dsin/dcos/dsqrt`** (see §3.3). |
| `framework/src/host3d.ts` | Ambient `RawG3d` declaration + `g3d` capability probe. |
| `framework/src/mesh.ts` | `MeshBuilder` (`addVertex`/`addTri`) + primitives `Mesh.cube`, `Mesh.box`, `Mesh.plane`. Produces `{ vertices: Float32Array, indices: Uint16Array, format }`. Calls `g3d.uploadMesh` lazily on first use, caches the handle. |
| `framework/src/g3d.ts` | `CommandEncoder` (owns the pre-allocated `submit` buffer + `DataView`): `reset()`, `setCamera(viewProj)`, `draw(handle, model, tint)`, `immTris(verts, format)`, `finish()` (writes `recordCount`, calls `g3d.submit`). |
| `framework/src/scene3d.ts` | `Scene3D` / `Node3D` mirroring the existing `Scene`/`Node` tree. `Node3D` has `{ position, rotation(Quat), scale, mesh?, tint?, children }`. `Camera` (`setPerspective`, `lookAt` → computes `viewProj`). `Scene3D.render(encoder)` walks the tree, multiplies parent·local in JS, emits one `DRAW` per visible node. |

### 3.2 Engine integration

`engine.ts` gains an optional `scene3d` slot and a capability probe. The 3D pass
runs **before** the 2D draw so the HUD lands on top:

```ts
// engine.ts tick(), conceptual addition:
tick(mask: number): void {
  this.input.update(mask);
  this.frameCount++;
  const ctx = this.ctx();
  const sc = this.scene;
  if (sc) {
    sc.updateTree(ctx);
    if (this.scene3d && typeof globalThis.g3d !== 'undefined') {
      this.enc.reset();
      this.scene3d.render(this.enc);   // SET_CAMERA + DRAW records
      this.enc.finish();               // ONE g3d.submit(...)
    }
    sc.drawTree(this.g);               // unchanged 2D HUD via gfx.fillRect
  }
}
```

If `g3d` is undefined (a 2D-only host, e.g. an old build) or the game never sets
`scene3d`, the 3D block is skipped entirely and behavior is byte-identical to
today. **Existing 2D games and the existing 2D goldens never regress.**

### 3.3 Determinism: shared deterministic trig (non-negotiable)

The current 2D framework uses **zero** trig, which is why its byte-exact RGBA
goldens work. 3D introduces `sin`/`cos` for rotation and projection — and
`Math.sin`/`Math.cos` differ in the **last ULP** between QuickJS (PSP/3DS) and
the browser engine (Web). A naive byte-exact matrix golden generated under Bun
would *mismatch* what a real PSP emits, and 1-ULP drift compounds over many
frames of integrated rotation into visible divergence.

Therefore `math.ts` ships **its own** `dsin/dcos/dsqrt` (a fixed-degree
polynomial / integer-friendly reduction, no `Math.sin`) used for **all**
rotation and projection math. Result: `rotation(theta)` yields **bit-identical
f64** on every host. This is the single most important determinism decision in
the design and it is grafted directly from the Proposal 3 verdict (empirically:
`Math.cos(0.1)` already differs between JSC/Bun and V8/Node).

### 3.4 Authoring example — the rotating cube

`framework/games/cube3d.js` (real-ish, plain JS, `// @ts-check`):

```js
// @ts-check
// @title Cube 3D
// @order 10
// @controls START restart
import { start, Scene, Scene3D, Camera, Mesh, Vec3, Quat, rgb } from '../src/index';

/** @import { UpdateContext, Graphics } from '../src/index' */

class CubeScene extends Scene {
  /** @type {Scene3D} */ world;
  /** @type {Camera} */  cam;
  t = 0;

  onEnter(/** @type {UpdateContext} */ ctx) {
    this.world = new Scene3D();

    // 8 verts, 36 indices, per-face vertex colors. Uploaded ONCE here.
    const cube = Mesh.cube(1, [
      rgb(220, 60, 60), rgb(60, 220, 60), rgb(60, 60, 220),
      rgb(220, 220, 60), rgb(220, 60, 220), rgb(60, 220, 220),
    ]);
    this.cubeNode = this.world.add({ mesh: cube });

    this.cam = this.world.camera;
    this.cam.setPerspective(60, 480 / 272, 0.1, 100);
    this.cam.lookAt(new Vec3(0, 0, 4), new Vec3(0, 0, 0), new Vec3(0, 1, 0));

    // Register the 3D scene with the engine so it auto-submits before the HUD.
    ctx.engine.scene3d = this.world;
  }

  update(/** @type {UpdateContext} */ ctx) {
    this.t += ctx.dt;
    // All transform math is shared, deterministic f64 (math.ts).
    this.cubeNode.rotation = Quat.fromEuler(this.t * 0.7, this.t * 1.1, 0);
  }

  draw(/** @type {Graphics} */ g) {
    // 2D HUD overlay — unchanged gfx path, drawn AFTER the 3D pass, depth off.
    g.text('CUBE 3D', 8, 8);
  }
}

start(() => new CubeScene());
```

The game touches only `Scene3D`/`Camera`/`Mesh`/`Quat` and the existing
`Graphics`. It never references a GPU, a matrix layout, or a platform. The
**same** bundle runs on PSP, Web, and 3DS because all math is shared JS and only
flat `Float32Array`s + a handle ever cross the boundary.

---

## 4. Per-platform engine implementation

### 4.1 PSP (`runtime/src/gfx3d.rs`, new)

Zero new native dependencies — `rust-psp`'s submodule already ships the full
`sceGum*` matrix stack (`psp/src/sys/gum.rs`) and a worked depth-tested,
back-face-culled rotating cube (`rust-psp/examples/cube/src/main.rs`) that is
structurally ~90% identical to the current `main.rs`.

**`init_graphics()` (additive 3D state)** — add to the existing setup in
`main.rs`:

```rust
sceGumLoadIdentity();          // prime the VFPU matrix context BEFORE sceGuInit
// ...existing init...
sceGuDepthRange(65535, 0);     // reversed-Z
sceGuDepthFunc(DepthFunc::GreaterOrEqual);
sceGuEnable(GuState::DepthTest);
sceGuFrontFace(FrontFace::Clockwise);
sceGuEnable(GuState::CullFace);
```

The depth buffer is **already allocated** (`main.rs:104-117` calls
`sceGuDepthBuffer` but never enabled DepthTest). The 2D HUD path turns DepthTest
**off** after the 3D pass, so 2D sprites (z=0, `TRANSFORM_2D`) are unaffected.

**`uploadMesh`:** `JS_GetArrayBuffer` to borrow vertex/index bytes → `memcpy`
into a `Vec<u8>`/`Vec<u16>` stored in a handle table
(`Vec<MeshEntry{verts, indices, vtype, count}>`) →
`sceKernelDcacheWritebackRange` the copies once → return index as handle.
**Never** retain the QuickJS pointer. Mesh data lives in main RAM (the
`qjs_alloc` heap), not the 2 MB VRAM (which holds the two framebuffers + depth).

**`submit`:** `JS_GetArrayBuffer` the command buffer, parse records:
- `SET_CAMERA` → `sceGuClearDepth(0)` + `sceGuClear(DEPTH_BUFFER_BIT)`;
  `sceGumMatrixMode(Projection)` + `sceGumLoadMatrix(viewProj)`;
  `sceGumMatrixMode(View)` + `sceGumLoadIdentity()` (JS already premultiplied
  proj·view).
- `DRAW` → `sceGumMatrixMode(Model)` + `sceGumLoadMatrix(model)`; tint via
  `sceGuColor`; `sceGumDrawArray(Triangles, COLOR_8888 | VERTEX_32BITF |
  TRANSFORM_3D | INDEX_16BIT, idxCount, idxPtr, vtxPtr)`.
- `IMM_TRIS` → stage into a scratch buffer, dcache-flush, draw.
- After parsing: `sceGuDisable(DepthTest)` so the HUD pass is depth-off.

**Vertex format v1:** `u32 color + 3×f32 pos`, 16-byte stride, reusing the
existing `pack_abgr` ABGR convention from `gfx.rs`. The GE-mandated interleave
order is `[weights][texcoord][color][normal][position]`; v1 uses only
`[color][position]`. **Spike required:** confirm `ScePspFMatrix4` field order
matches JS column-major (the cube example uses `Translate`/`Rotate`, never
`LoadMatrix`, so this must be verified once on PPSSPP — transpose in JS if
needed).

`gfx3d::register(ctx, global)` is called from `main.rs` alongside
`gfx::register` and `bridge::register`.

### 4.2 3DS (`runtime-3ds/source/main.c` + `source/vshader.v.pica`, new)

The 3DS host is already 90% wired: `main.c` calls `C3D_Init`, `C2D_Init`,
`g_top = C2D_CreateScreenTarget(...)` (which **already allocates a
`GPU_RB_DEPTH16` depth buffer**), and brackets every frame in
`C3D_FrameBegin(C3D_FRAME_SYNCDRAW)` / `C3D_FrameEnd`. `-lcitro3d` is already
linked. We need: a vertex shader, the build wiring, and the 3D pass.

**Vertex shader `source/vshader.v.pica`** (minimal MVP — JS premultiplies, so one
matrix uniform):

```
.fvec projection[4]          ; the JS-computed proj*view*tilt*model... see §4.4
.alias inpos v0
.alias inclr v1
.out outpos position
.out outclr color0
.proc main
  mov r0.xyz, inpos
  mov r0.w,   ones
  dp4 outpos.x, projection[0], r0
  dp4 outpos.y, projection[1], r0
  dp4 outpos.z, projection[2], r0
  dp4 outpos.w, projection[3], r0
  mov outclr, inclr
  end
.end
```

**Makefile** (the stripped-down host Makefile does **not** define `PICAFILES`
yet; the `3ds_rules` picasso→shbin→bin2o recipe is already included, so only the
file-list variables are needed):

```make
PICAFILES := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.v.pica)))
export HFILES     += $(PICAFILES:.v.pica=_shbin.h)
export OFILES_BIN += $(PICAFILES:.v.pica=.shbin.o)
```

**Docker / build.ts:** **no change.** `picasso` already ships in the
`devkitpro/devkitarm:latest` image used by `runtime-3ds/build.ts`.

**`sceneInit()`:** `#include "vshader_shbin.h"`; `DVLB_ParseFile((u32*)vshader_shbin,
vshader_shbin_size)`; `shaderProgramInit` + `shaderProgramSetVsh(&p, &dvlb->DVLE[0])`;
cache `uLoc_projection`; `AttrInfo_AddLoader(0, GPU_FLOAT, 3)` (pos) +
`AttrInfo_AddLoader(1, GPU_UNSIGNED_BYTE, 4)` (color) [or `GPU_FLOAT, 3`];
TexEnv set to `GPU_PRIMARY_COLOR`/`GPU_REPLACE` so vertex color shows with no
texture; allocate two **double-buffered `linearAlloc` VBOs** (avoid GPU/CPU
races under `SYNCDRAW`).

**Coexistence (critical):** `C2D_Prepare()` and every C2D draw rebind
program+attrInfo+bufInfo. So the per-frame order **must** be 3D-first:

1. `g3d.submit`: bind the custom program, `C3D_DepthTest(true, GPU_GREATER,
   GPU_WRITE_ALL)`, clear depth, for each `DRAW` `memcpy` the mesh into a
   `linearAlloc` VBO (or reuse a persistent per-handle VBO), upload the MVP via
   `C3D_FVUnifMtx4x4`, `C3D_DrawArrays(GPU_TRIANGLES, ...)`.
2. End of `submit`: `C2D_Prepare()` + `C2D_SceneBegin(g_top)`, depth off.
3. The unchanged `gfx.fillRect` HUD draws via `C2D_DrawRectSolid` on top.

`uploadMesh` copies JS bytes into a persistent per-handle `linearAlloc` buffer
(GPU DMA needs linear, cache-coherent memory — a raw `JS_GetArrayBuffer` pointer
"works" in citra's unified memory but renders garbage on hardware).

### 4.3 Web (`web/engine.js`)

Free typed arrays + WebGL. Two **stacked canvases**: a WebGL2 canvas underneath
for 3D, the existing Canvas2D canvas on top for the HUD — so the `gfx.fillRect`
path stays **pure Canvas2D and byte-identical** (you cannot mix WebGL and
Canvas2D fillRect in one context).

- `uploadMesh` → `gl.createBuffer` VBO/IBO + a VAO, store `{vao, count, format}`
  indexed by handle.
- One shader program: vertex `gl_Position = u_viewProj * u_model * vec4(pos,1)`;
  fragment `v_color * u_tint`. Winding `gl.frontFace(gl.CW)`, `gl.cullFace(gl.BACK)`.
- **Reversed-Z caveat (see §10.1 C1):** plain WebGL2 clips NDC z to **[-1,1]**, so
  `clearDepth(0)+depthFunc(GREATER)` alone does **not** give reversed-Z. Feature-detect
  **`EXT_clip_control`** → `clipControl(LOWER_LEFT, ZERO_TO_ONE)` for a true [0,1] range
  matching PSP/3DS; if absent, fall back to standard-Z (`clearDepth(1)`, `depthFunc(LESS)`)
  and accept that Web depth bytes are threshold-compared, not byte-matched. `math.ts` must
  expose the clip range as a parameter so the projection matches the active path.
- **Y-handedness invariant (see §10.1 C4):** the logical screen + Canvas2D HUD are Y-down
  while WebGL clip space is Y-up. The Y-flip lives in the **shared projection** (`math.ts`),
  *not* a per-host `frontFace` flip — otherwise Web culls front faces and the cube renders
  inside-out vs PSP. `front face = CW` is only correct after the shared projection fixes Y.
- `submit` → parse the `ArrayBuffer` with a `DataView`, `gl.clear(COLOR|DEPTH)`,
  replay records (`uniformMatrix4fv` for camera/model, `drawElements` per DRAW;
  `IMM_TRIS` via a streaming buffer). Then the Canvas2D HUD draws on the overlay.
- Same column-major matrices from `math.ts` (WebGL is column-major natively,
  `transpose=false`).

- **HUD background ownership forks in 3D mode (see §10.1 R10):** today `gfx.clear`
  paints an opaque background and the canvas CSS background is `#000`. With two stacked
  canvases the WebGL layer must own the clear color (`gl.clearColor`) and the Canvas2D
  HUD must become **transparent** where nothing is drawn — so in a 3D frame the host's
  `gfx.clear` does `ctx.clearRect(0,0,W,H)` instead of an opaque fill. Gate this on
  "did `g3d.submit` run this frame"; 2D-only games keep today's exact behavior.
- **Capability skip, not software fallback (see §10.1 R9):** if `webgl2` is unavailable,
  leave `g3d` undefined so the framework skips the 3D pass. Do **not** ship the test-only
  `raster3d.ts` in the web bundle.

Web is the **reference renderer**: easiest to debug, closest to ground truth,
and the visual target the software rasterizer approximates.

### 4.4 The 3DS screen tilt (decided up front)

The 3DS top screen is scanned rotated 90°. Per the verdicts, we **bake the tilt
into the shared JS projection from day one** (not a native post-multiply). The
camera emits `viewProj = tilt90 · proj · view`, where `tilt90` is a constant
90° rotation applied **only when targeting 3DS**. Concretely: `math.ts` exposes
`Mat4.perspectiveReversedZ(...)` and the host's aspect/tilt is selected via a
tiny build/runtime flag so that **the matrix in the golden is exactly the matrix
the 3DS GPU consumes**. PSP/Web use `tilt = identity`. This keeps the golden
honest for all three hosts and removes a whole class of "renders sideways"
footguns. (If a perf spike shows the tilt must move native for v1, it is gated
behind an explicit flag and documented as a known golden divergence — but the
default is JS.)

---

## 5. Determinism & testing strategy

Pixel-exact goldens across three real GPUs are impossible. The authoritative
golden **moves from the framebuffer to the boundary payload**, which is
deterministic. Three tiers, all runnable headlessly under Bun, plus a smoke tier.

**Tier 1 — Draw-list golden (primary, byte/epsilon-exact).** Extend
`framework/test/golden.ts` with a `g3d` **mock** that records every
`uploadMesh` (vertex+index bytes) and `submit` (the full command buffer). Run
each 3D game's bundle through the existing deterministic seeded + scripted-input
sequence and compare the recorded stream to a committed golden blob
(`framework/test/goldens/<name>.dc3d`, gzipped like the existing `.rgbz`):
- integer/handle/opcode records: **byte-exact**;
- float (matrix) records: with the deterministic `dsin/dcos` (§3.3) these are
  **bit-identical across hosts**, so compared byte-exact; a `~1e-4` epsilon mode
  is retained as a fallback safety net (Proposal 2 graft) but should not be
  needed.
This is the real determinism oracle: it *is* the shared path, so it validates
the entire shared logic + math + packing layer that every host runs.

**Tier 2 — Software reference rasterizer (committed in CI from day one, not
optional).** `framework/test/raster3d.ts`: a tiny pure-JS triangle rasterizer
(vertex transform via the shared `Mat4`, perspective divide, reversed-Z z-buffer,
vertex color, back-face cull) consumes the **same** `submit` buffer and renders
to the existing `W×H×4` RGBA buffer used by `makeGfx`. Then the existing
PNG/`.rgbz` golden machinery runs unchanged — giving a **human-viewable image
golden** that catches the bugs the draw-list golden cannot: CW/CCW winding,
reversed-Z near/far inversion, the 3DS tilt, and `ScePspFMatrix4` transpose.
Each native host is expected to **approximate** this reference (threshold, not
byte-exact). The verdicts were unanimous that this must be **primary and in CI
before any hardware**, not deferred — it is the only CI-enforced visual
correctness.

**Tier 3 — Contract parity.** Extend `framework/test/contract.ts` to assert the
**vertex-format bitfield constants**, the **opcode constants + magic/version**, and
the **depth convention** are identical across the JS/Rust/C copies, reusing the existing
`parsePairs` helper. **Correction (see §10.2):** contract.ts today parses `Btn` out of
`web/engine.js` (name→hex) and `runtime-3ds/source/main.c` (value→`// NAME`) but does
**not** parse any Rust file — so covering `runtime/src/gfx3d.rs` is **net-new** parsing
(e.g. `/const\s+(\w+):\s*u\d+\s*=\s*(0x[0-9a-fA-F]+)/g`), not a small graft. Also add a
no-`Math.sin|cos|sqrt|tan` grep assertion over `g3d.ts`/`math.ts`/`scene3d.ts` so Tier-1
bytes stay deterministic under Bun (the bundle must use only `math.ts` trig).

**Tier 4 — On-device/emulator smoke (non-byte-exact, CI-optional).** A tiny boot
test: PSP builds + boots the cube on PPSSPP without panic; 3DS renders on citra
with an optional screenshot threshold-compare; Web renders without GL errors.
This validates host **wiring** only; the determinism guarantee stays in Tiers 1–2,
entirely in JS, requiring no hardware.

**The existing 2D goldens are untouched** and must keep passing (2D games never
call `g3d`); every milestone re-runs the full 2D suite to prove non-regression.

---

## 6. Asset / build pipeline

**Geometry is procedural first, baked second.** `framework/src/mesh.ts` generates
the cube, ground plane, track segments, and room shell from code (`Mesh.cube`,
`Mesh.plane`, `Mesh.box`) — no asset files needed for any of the three target
games. This keeps the cube a true hello-world and the racing/FPS authorable from
primitives.

For larger authored geometry later, add `framework/bake/bake-mesh.ts` mirroring
the existing `bake-sprites.ts`/`bake-font.ts`: bake interleaved typed-array mesh
data to a TS data module (`framework/src/assets-meshes.ts`), exported from
`index.ts` like `SPRITES`/`FONT8X8`.

**Build/script additions** (`package.json` — all run on Bun, consistent with the
existing scripts):
- `bundle` (`framework/build.ts`) already bundles every `framework/games/*.js`
  with the framework inlined → `runtime/src/game/<name>.js`. The new 3D SDK
  modules are inlined automatically; **no change to `build.ts`** beyond the new
  files existing.
- `test` already runs `contract.ts && golden.ts`; both grow the 3D tiers above.
- New optional `bake` step `bun framework/bake/bake-mesh.ts` (only if/when authored
  meshes are introduced).
- `web` / `psp` / `3ds` build scripts unchanged in shape; the 3DS one now compiles
  `vshader.v.pica` automatically via the Makefile `PICAFILES` lines (§4.2).

The 2D framework coexists fully: the 3D SDK is purely additive exports from
`index.ts`; 2D games import the same `index.ts` and are unaffected.

---

## 7. The three example games

| Game | New capabilities it forces | Approx triangles/frame |
|---|---|---|
| **Cube** (`cube3d.js`) | MVP transform, depth test, reversed-Z, back-face cull, the upload→handle→submit round-trip, 2D-over-3D ordering. The conformance test of the contract. | ~12 |
| **Racing** (`racing3d.js`) | Chase camera (lookAt following state), many objects sharing few retained meshes via per-instance model matrices (proves O(objects) DRAW records in **one** submit), simple deterministic vehicle physics in shared JS, ground/track geometry, HUD speedometer. | ~1–2k |
| **FPS** (`fps3d.js`) | First-person camera driven entirely by shared-JS math, one static room mesh (floor+4 walls+ceiling), AABB collision + hitscan ray/AABB tests **in the logic layer**, `IMM_TRIS` muzzle flash/tracer, crosshair + ammo/health HUD. The hardest case but still only a handful of DRAW records. | ~2–4k |

**Cube** proves the boundary end-to-end with minimal surface: one upload, one
`SET_CAMERA`, one `DRAW`, depth on, HUD on top. If the cube renders right on all
three hosts, the matrix layout, depth convention, winding, and tilt are all
correct.

**Racing** proves the boundary **scales** without adding FFI crossings: dozens of
cones/segments are instances of a few retained meshes, drawn by per-frame model
matrices in a single `submit`. Vehicle physics (position, heading, speed from
the edge-detect `Input`) and seeded obstacle placement live in shared JS, so the
draw-list golden fully validates gameplay.

**FPS** proves "logic is one shared copy" holds for a non-trivial game: the
first-person camera, AABB collision against room bounds, and hitscan are all pure
deterministic JS (golden-testable), the room is mostly-static geometry animated
only by the camera matrix (the 333 MHz-friendly case), `IMM_TRIS` exercises the
dynamic-geometry path, and the full 2D HUD overlays a 3D scene.

The triangle budgets are bounded by **JS-side per-frame work + the single FFI
crossing on the 333 MHz PSP / ~268 MHz 3DS ARM11**, not the GE's 35M-poly/s peak.
Keep level/track geometry static and retained; animate by matrices only.

---

## 8. Phased roadmap

Each milestone is independently verifiable and re-runs the full **2D** suite to
prove non-regression. **Web first** (fastest feedback, free WebGL/typed arrays),
then PSP, then 3DS, then racing, then FPS.

- **M0 — Contract + deterministic math (JS only, no native).**
  Add `math.ts` (Vec3/Mat4/Quat + `dsin/dcos/dsqrt`) with unit tests asserting
  bit-stable matrix bytes. Pin the wire format + conventions (`g3d.ts` constants,
  `host3d.ts`). Add `mesh.ts`, `g3d.ts` CommandEncoder, `scene3d.ts`. Author
  `cube3d.js`. Add the `g3d` recording mock + `raster3d.ts` software rasterizer to
  `golden.ts`; commit the cube's `.dc3d` and PNG goldens. Extend `contract.ts`.
  *Verifiable entirely under Bun with zero hardware.*
  **Risk/spike:** validate `dsin/dcos` are bit-identical under Bun **and** a
  QuickJS build (run the math module under both) — this underpins every later
  golden.

- **M1 — Web host (cube).** Implement `g3d` in `web/engine.js` (WebGL2 + stacked
  HUD canvas). Cube rotates in the browser and visually matches `raster3d`.
  First real-engine render of the shared bundle.
  **Risk:** stacked-canvas compositing; reversed-Z setup. Low.

- **M2 — PSP host (cube).** Add `runtime/src/gfx3d.rs` (handle table,
  `uploadMesh` copy+flush, `submit` parser), enable depth/cull in
  `init_graphics()`, register `g3d` in `main.rs`. Verify cube on PPSSPP then
  hardware.
  **Riskiest item: PSP `TRANSFORM_3D` + `sceGumLoadMatrix` matrix layout.**
  De-risking spike: a throwaway branch that loads a known JS column-major matrix
  via `sceGumLoadMatrix` and renders the cube, comparing against the
  `Translate`/`Rotate` path from `examples/cube` to confirm column-major (no
  transpose) and reversed-Z before wiring the full `submit` parser.

- **M3 — 3DS host (cube).** Add `source/vshader.v.pica` + Makefile `PICAFILES`
  lines; wire DVLB/shaderProgram/AttrInfo/TexEnv + double-buffered `linearAlloc`
  VBOs in `sceneInit`; implement `g3d` in `main.c` with the 3D-first →
  `C2D_Prepare` → HUD ordering. Bake the tilt into the JS projection (§4.4).
  Verify cube on citra then hardware.
  **Riskiest item: picasso shader build wiring + citro3d↔citro2d coexistence.**
  De-risking spike: get the stock immediate-mode picasso example compiling inside
  *this* Makefile (proves `PICAFILES` wiring) before integrating, and confirm a
  hand-coded triangle draws then the HUD renders on top in the same frame (proves
  the `C2D_Prepare` reorder).

- **M4 — Racing game.** Author `racing3d.js` (retained track/car/cone meshes,
  per-instance matrices, chase camera, speedometer HUD). Commit its draw-list +
  software-raster goldens. Verify O(1) FFI on PSP; perf-check the triangle budget
  at 60 Hz on real PSP/3DS.

- **M5 — FPS game.** Author `fps3d.js` (room mesh, first-person camera, JS
  AABB collision + hitscan, `IMM_TRIS` tracer, crosshair/ammo HUD). Commit
  goldens. Perf spike on real **old-3DS** under `C3D_FRAME_SYNCDRAW` to confirm
  60 Hz; if needed, add `NORMAL` + flat lighting as an additive format bit.

- **M6 — Hardening.** Contract parity assertions locked; document the cross-host
  3D contract; `freeMesh`-based level transitions if a game needs them; optional
  textures/normals as additive format bits (each is real 3-host work, added only
  when a game requires it).

---

## 9. Open questions & risks

Resolve each with a quick spike before it blocks a milestone.

1. **`ScePspFMatrix4` layout vs JS column-major** *(M2 blocker).* The cube
   example never calls `sceGumLoadMatrix`. Confirm a flat 16-f32 column-major
   buffer loads without transpose; if not, transpose **in JS** so the golden
   matches what the GE consumes. *Spike: M2 throwaway branch.*

2. **Reversed-Z clip range agreement.** PSP uses `clearDepth(0)` +
   `GreaterOrEqual`; the shared perspective must emit a matching near→1/far→0
   clip Z, and Web (`gl.GREATER`) + 3DS (`GPU_GREATER`) must agree. *Spike:
   render two overlapping quads at known depths on each host; confirm identical
   occlusion.*

3. **3DS tilt in JS vs native** *(decided: JS; verify perf).* Baking `tilt90`
   into the JS projection is the chosen default (§4.4). Verify it costs nothing
   meaningful on the ARM11; only fall back to native (behind a flag) if a perf
   spike demands it. *Spike: M3.*

4. **`dsin/dcos/dsqrt` accuracy vs cost** *(M0 blocker).* The deterministic trig
   must be (a) bit-identical across QuickJS/V8 and (b) cheap enough on 333 MHz.
   *Spike: M0 — run the module under Bun and a QuickJS build, diff outputs, and
   micro-bench on PSP.*

5. **QuickJS Rust-allocator heap budget on PSP.** Retained mesh data lives in the
   `qjs_alloc` heap; the FPS room + props must fit alongside the JS runtime.
   *Spike: measure free heap after boot; bound FPS geometry accordingly.*

6. **`SYNCDRAW` + single-threaded QuickJS at FPS/racing scale** *(M4/M5).* The
   3DS blocks until the GPU finishes; with thousands of triangles + QuickJS this
   may cap 60 Hz on old-3DS. *Spike: perf-bench the racing triangle count on
   hardware before committing the FPS scope; revisit double-buffering if needed.*

7. **`IMM_TRIS` dynamic-geometry cost.** Inline vertices re-cross the boundary and
   need a per-frame dcache flush (PSP) / `linearAlloc` copy (3DS). Fine for a few
   tracer tris; keep it small. *Constraint, not a spike: cap inline vertex count
   per frame and document it.*

8. **VFPU / QuickJS state coexistence on PSP.** `gum.rs` manages a single VFPU
   context; all 3D runs synchronously inside one `frame()` with no preemption, so
   risk is low, but confirm no corruption on hardware over long runs. *Spike: M2
   soak test.*

**Lowest-risk facts already verified** (de-risk the headline): the PSP depth
buffer is allocated but unused and the display list is already open per frame;
the 3DS `g_top` already carries a `GPU_RB_DEPTH16` buffer and frames already run
inside `C3D_FrameBegin`/`End`; `JS_GetArrayBuffer` is present in both QuickJS
forks; `-lcitro3d` and `picasso` are already available. The 3D path is genuinely
**additive** to a contract that is already shaped for it.

---

## 10. Verified addenda (Web + Build/Test deep-dive)

> Two of the original research dimensions (`web-3d`, `assets-build-test`) failed
> mid-run with socket errors, so §4.3 and §5–6 were initially written from
> reasoning rather than verified repo facts. They were re-run grounded in the
> actual files; this section records what changed. Where it contradicts the body,
> **§10 wins.**

### 10.1 Web — verified corrections & concrete shape

Grounded in `web/engine.js`, `web/index.html`, `framework/src/engine.ts`.

- **F1 — Host provides globals; the framework drives rendering (confirmed).**
  `installGlobals` (`engine.js:50`) wires `window.gfx/log` and clears `window.frame`;
  framework games set `globalThis.frame = Engine.tick` (`engine.ts:63`). So the web host
  only needs to add `window.g3d` in `installGlobals`; it never calls `submit` itself. §3.2
  is correct against the real code.
- **F2/C5 — The fixed-timestep accumulator is in the HOST (`engine.js:89-100`), not the
  framework.** It may fire up to 4 catch-up steps per RAF, so `Engine.tick` →
  `scene3d.render` → `g3d.submit` can run **2–4× before one browser paint** (last wins).
  This is correct (every logic frame renders, matching PSP/3DS) but means the GL clear+draw
  must tolerate running multiple times per paint. Do **not** restructure the loop.
- **C1 — Reversed-Z needs `EXT_clip_control`** (folded into §4.3). The unresolved tension:
  true [0,1] reversed-Z keeps Web depth bit-aligned with PSP/3DS, but the extension isn't
  universal (desktop Chrome/FF yes; older mobile/Safari maybe not). Decision: feature-detect
  and prefer true reversed-Z; on absence fall back to standard-Z and treat Web depth as
  threshold-compared (already acceptable — Tier-2 raster is the byte oracle, not the Web GPU).
- **C2 — Handle entry stores `indexCount` + index type**, with a non-indexed `drawArrays`
  fallback when `indices === null`. The body's bare "count" was ambiguous (vertex vs index;
  for `drawElements` it is the **index** count).
- **C4 — Y-flip lives in the shared projection** (folded into §4.3).
- **R1 — Stacked canvases is the right call (confirmed), do NOT rasterize the HUD as GL
  quads:** `gfx.fillRect` must stay literal Canvas2D to keep the existing `.rgbz` goldens
  byte-identical (including the `x|0` truncation at `engine.js:46`); a single element can't
  hold both a `'2d'` and a `'webgl2'` context.
- **R2 — Keep `PSPJS.mount(el)` unchanged:** have `mount` *create* the GL canvas as a
  sibling under the passed HUD canvas (both backing stores 480×272; replicate the CSS box,
  `image-rendering:pixelated`, border-radius so layers register pixel-for-pixel — see C6/§4.3
  background fork).
- **R5/R6/R7 — Concrete WebGL2:** per-handle VAO/VBO/IBO (v1 stride 16: `u32 ABGR @0` +
  `3×f32 pos @4`, matching PSP's `[color][position]` interleave — match the **byte layout the
  encoder emits**, not the format-bitfield order); one GLSL ES 3.00 program with `u_viewProj`,
  `u_model`, `u_tint` (all `uniformMatrix4fv(..., false, m)`); a `DataView` `submit` parse loop
  keyed on the `'DC3D'` magic with `Float32Array(buffer, base, 16)` matrix views (payloadWords
  keeps matrix payloads 4-byte aligned — assert it). `IMM_TRIS` needs a dedicated
  `DYNAMIC_DRAW` VBO+VAO and a `format` check.

### 10.2 Assets / Build / Test — verified corrections

Grounded in `framework/test/golden.ts`, `framework/test/contract.ts`, `framework/build.ts`,
`framework/src/index.ts`, `web/build-games.ts`, `runtime-3ds/gen-game.ts`, `runtime/build.ts`.

- **golden.ts mechanics (verified):** `runGame(file, frames, inputAt?, seedRandom?)` owns a
  per-run `buf = Uint8Array(W*H*4)`; `makeGfx(buf)` returns `{clear, fillRect}` via an inner
  `put(...)` span-filler. The harness sets `globalThis.gfx/log/frame`, `(0,eval)(src)` the
  bundle, then calls `frame(inputAt(f))` for `frames` iterations; goldens are gzipped `.rgbz`
  + a PNG via `encodePNG`, compared with a literal byte loop. `Engine.tick(mask)` is public
  precisely so the harness can drive it.
  - **Tier-1 recorder** is a parallel artifact pipeline, **not a flag flip:** add a `g3d`
    mock recording `uploadMesh`(v+i bytes)+`submit`(buffer) into a byte stream, wire it into
    `runGame` next to `gfx/log`, gzip-compare to `goldens/<name>.dc3d`.
  - **Tier-2 raster3d** must write into the **same `buf` that `runGame` owns** (not `makeGfx`)
    so 3D draws underneath and the HUD `fillRect` lands on top; then the existing
    `encodePNG`/`.rgbz` compare runs unchanged.
- **contract.ts (verified):** generic `parsePairs(text, re)`; web parsed name→hex, `main.c`
  parsed value→`// NAME`. **There is no Rust parsing today** — §5 Tier-3's implied "already
  covers JS/Rust/C" was wrong (corrected in §5). Adding `gfx3d.rs` parity is net-new.
- **build.ts "no change" claim (verified true, but conditional):** `build.ts` globs
  `framework/games/*.js` and Bun-bundles by **import reachability**, so the new SDK modules
  inline automatically **only if `index.ts` re-exports them**. This is load-bearing:
  ```ts
  import './host3d';        // side-effect import (ambient g3d decl), like assets-font
  export * from './math';
  export * from './mesh';
  export * from './g3d';
  export * from './scene3d';
  ```
- **Per-platform embed asymmetry (verified):** Web (`web/build-games.ts`) auto-enumerates
  all `runtime/src/game/*.js` **after `framework/build.ts` runs**, so a new `cube3d.js` needs
  no edit. PSP (`runtime/build.ts`) and 3DS (`gen-game.ts`) embed exactly **one** game
  selected by `PSPJS_GAME=cube3d.js` (default `raw-snake.js`) — a 3D game is not special, but
  it is selected, not auto-discovered.
- **§3.2 snippet is conceptual:** `engine.ts` has no `enc` field or `scene3d` slot today;
  those are real new Engine fields (lazy `CommandEncoder` guarded by
  `typeof globalThis.g3d !== 'undefined'`).
- **Procedural-first confirmed:** `mesh.ts` (`Mesh.cube/box/plane`) covers cube/racing/FPS;
  **no `bake-mesh.ts` is needed** for the three target games. If authored geometry lands
  later, mirror `bake-sprites.ts` → emit `framework/src/assets-meshes.ts` (`export const
  MESHES`) and add one `export { MESHES }` line to `index.ts`.
- **package.json:** `test` (`contract.ts && golden.ts`) needs **no line edit** — the 3D tiers
  grow inside those scripts. Only `bake` changes, and only if/when authored meshes appear.
