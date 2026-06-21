# API reference

Module-by-module reference for the DreamCart framework SDK (`framework/src/`).
Every framework game `import`s from the package barrel `framework/src/index.ts`,
which is inlined into the per-platform bundle by `framework/build.ts`. Three
3D-only subsystems — `controller`, `action`, `scene-desc` — are imported
**directly** (not via the barrel) so a 2D game's bundle never drags them in; the
import path is called out in each section below.

This page documents the **public exports** of each module. For the conceptual
model see the [runtime contract](/docs/runtime-contract/) (the `gfx`/`frame`
layer), the [framework guide](/docs/framework/) (the SDK in prose), [3D](/docs/3d/)
(the `g3d` layer) and [assets](/docs/assets/) (`.dcpak` baking).

A minimal framework game is one file:

```js
import { start, Scene, Colors } from '../src/index';

class Title extends Scene {
  update(ctx) {
    if (ctx.input.pressed(0x4000 /* Cross */)) this.t = (this.t || 0) + 1;
  }
  draw(g) {
    g.clear(Colors.dark);
    g.textCentered('HELLO DREAMCART', 240, 120, Colors.white, 2);
  }
}

start(() => new Title());
```

---

## host — the raw native contract

The two globals every platform provides. Everything else is built on top.

| Export | Kind | Description |
| --- | --- | --- |
| `RawGfx` | interface | The 2D drawing surface: `clear(r,g,b)`, `fillRect(x,y,w,h,r,g,b)`, and the optional fast paths `fillRects(buffer, count)` (batched rects) + `uploadFont(table, height)` / `drawText(str, x, y, rgb, scale)` (native text). |
| `SCREEN_W` | `const 480` | Logical screen width (the PSP panel). |
| `SCREEN_H` | `const 272` | Logical screen height. |
| `hostLog(msg)` | function | Safe `log()` wrapper — a no-op on hosts that omit `log`. |

`gfx`, `log` and `frame` are ambient globals declared here. The host calls
`globalThis.frame(buttons)` ~60×/sec; `buttons` is the controller bitmask (see
[`input`](#input--buttons-amp-edge-detection)).

---

## color — packed RGB colors

Colors are packed `0xRRGGBB` integers (the type alias `Color`).

| Export | Signature | Description |
| --- | --- | --- |
| `Color` | `type = number` | A packed `0xRRGGBB` color. |
| `rgb` | `(r, g, b) => Color` | Pack three 0–255 channels. |
| `redOf` / `greenOf` / `blueOf` | `(c) => number` | Unpack a channel. |
| `mix` | `(a, b, t) => Color` | Linear blend `a→b` by `t ∈ [0,1]`. |
| `Colors` | object | Named palette: `black white gray dark red green blue yellow orange cyan magenta brown sky grass`. |

```js
import { rgb, mix, Colors } from '../src/index';
const dusk = mix(Colors.sky, Colors.orange, 0.5);
const custom = rgb(40, 200, 120);
```

---

## input — buttons & edge detection

| Export | Kind | Description |
| --- | --- | --- |
| `Btn` | object | The controller bitmask, identical on every platform: `Select 0x01`, `Start 0x08`, `Up 0x10`, `Right 0x20`, `Down 0x40`, `Left 0x80`, `LTrigger 0x100`, `RTrigger 0x200`, `Triangle 0x1000`, `Circle 0x2000`, `Cross 0x4000`, `Square 0x8000`. |
| `Button` | type | Union of the `Btn` values. |
| `Input` | class | Edge-detecting input state, updated once per frame by the engine. |

`Input` members:

- `cur` / `prev` — this/last frame's digital bitmask (low 16 bits).
- `analogX` / `analogY` — analog stick in `-1..1` (`0` on digital-only hosts), deadzoned at `|v| < 0.12`.
- `update(packed)` — fold the host's per-frame word in (low 16 = buttons; high 16 = optional packed analog bytes).
- `held(b)` / `pressed(b)` / `released(b)` — state / rising edge / falling edge for a button bit.
- `dir()` — D-pad as `{x, y}` (held).
- `axis()` — unified steering: the analog stick past its deadzone, else `dir()`. Digital-only hosts behave exactly like `dir()`.

```js
update(ctx) {
  if (ctx.input.pressed(Btn.Start)) this.paused = !this.paused;
  const { x, y } = ctx.input.axis();   // analog or D-pad
}
```

---

## rng — deterministic random

`Rng` is a seedable mulberry32 generator. Use it instead of `Math.random` so
golden tests reproduce across platforms.

| Method | Description |
| --- | --- |
| `new Rng(seed = 1)` | Construct with a 32-bit seed. |
| `next()` | float in `[0, 1)`. |
| `int(n)` | integer in `[0, n)`. |
| `range(a, b)` | float in `[a, b)`. |
| `pick(arr)` | a random element. |
| `chance(p)` | `true` with probability `p`. |

The engine owns one `Rng` (seeded from `EngineOpts.seed`, default `12345`),
exposed as `ctx.rng`.

---

## engine — the game loop, scene stack & update context

| Export | Kind | Description |
| --- | --- | --- |
| `Engine` | class | Owns the loop, `input`, `rng`, `g` (Graphics) and a scene stack. |
| `UpdateContext` | interface | Passed to every `update()`: `{ input, rng, dt, t, frame, engine }` (`dt` is the fixed `1/60` timestep, `t` seconds, `frame` count). |
| `EngineOpts` | interface | `{ seed?: number }`. |
| `start(scene, opts?)` | function | Convenience entry point — builds an `Engine`, runs `scene` (or `scene()`), returns the engine. |

`Engine` members:

- `input`, `rng`, `g`, `frameCount`.
- `scene` (getter) — the top of the stack.
- `scene3d?` — optional [`Scene3D`](#scene3d--the-3d-scene-graph); when set (and the host has `g3d`) it renders **before** the 2D tree, so 2D draws form a HUD over the 3D pass.
- `push(s)` / `pop()` / `replace(s)` — scene-stack control (firing `onEnter`/`onExit`).
- `run(initial)` — install `globalThis.frame`.
- `tick(mask)` — advance one frame (public so the golden-test harness can drive it directly).
- `prof` — `[updateTree, 3D render, 2D draw]` average µs/frame, smoothed over ~1 s; populated only on hosts exposing `now()` (PSP).

```js
const engine = start(() => new TitleScene(), { seed: 7 });
// later, from a scene's update():
ctx.engine.push(new PauseScene());
```

---

## scene — the node tree

| Export | Kind | Description |
| --- | --- | --- |
| `Node` | class | A node in the scene tree. |
| `Scene` | class | A top-level scene (a `Node` the engine stacks). |

`Node` members: `x`, `y`, `visible`, `dead`, `children`, `parent`;
`add(child)` (returns the child), `remove()` (mark dead — pruned at the end of the
update pass), and the overridables `update(ctx)` / `draw(g)`. `updateTree` /
`drawTree` recurse (used internally by the engine).

`Scene` adds `onEnter(ctx)` / `onExit()` lifecycle hooks.

```js
class Bullet extends Node {
  update(ctx) { this.y -= 4; if (this.y < 0) this.remove(); }
  draw(g) { g.rect(this.x, this.y, 2, 6, 0xffffff); }
}
```

---

## graphics — the 2D drawing API

`Graphics` is a thin wrapper over `gfx.fillRect` — the only drawing surface.
Sprites and text rasterize down to fill-rect runs (with native fast paths when the
host provides them).

| Method | Description |
| --- | --- |
| `clear(c)` | Clear to a color. |
| `rect(x, y, w, h, c)` | Filled rectangle. |
| `rectOutline(x, y, w, h, c, t = 1)` | Outline of thickness `t`. |
| `sprite(bmp, dx, dy, opts?)` | Blit a [`Bitmap`](#bitmap--palette-sprites); `opts` = `{ scale?, flipX? }`. |
| `text(str, x, y, c, scale = 1, font?)` | Draw text (handles `\n`); returns the width drawn. |
| `textWidth(str, scale = 1, font?)` | Measure a string. |
| `textCentered(str, cx, y, c, scale = 1, font?)` | Draw horizontally centered on `cx`. |

`SpriteOpts` = `{ scale?: number; flipX?: boolean }`.

---

## bitmap — palette sprites

| Export | Kind | Description |
| --- | --- | --- |
| `Bitmap` | interface | `{ w, h, palette: Color[], pixels: Uint8Array, transparent }` — palette-indexed; pixels equal to `transparent` are skipped on blit. |
| `bitmapFromRows(rows, map, transparentChar = '.')` | function | Build from ASCII-art rows, mapping chars to colors. |
| `packPixels(pixels)` / `unpackPixels(s)` | function | Compact string codec for baked pixel data. |
| `BakedBitmap` | interface | A serialized bitmap (`data` is `packPixels` output). |
| `fromBaked(b)` | function | Inflate a `BakedBitmap` into a `Bitmap`. |

```js
const heart = bitmapFromRows(
  ['.X.X.', 'XXXXX', '.XXX.', '..X..'],
  { X: 0xe03030 },
);
```

---

## font — bitmap fonts

| Export | Kind | Description |
| --- | --- | --- |
| `Glyph` | interface | `{ w, rows: number[] }` — each row is a column bitmask, bit `1<<col` set ⇒ pixel. |
| `Font` | interface | `{ height, glyphs: Record<number, Glyph>, fallback: Glyph }`. |
| `setFont(f)` | function | Install the active font (the baked default font registers itself via `index.ts`). |
| `getFont()` | function | The active font (throws if none set). |
| `glyphOf(font, code)` | function | A glyph by char code (falls back to `font.fallback`). |
| `FONT8X8` | const | The default 8×8 ASCII font (re-exported from `assets-font`). |

`Graphics.text` defaults its `font` argument to `getFont()`, so most games never
touch this module directly.

---

## tilemap — scrolling tile grids

`TileMap` is a grid of tile indices, rendered as flat colors or bitmaps with a
camera offset.

| Member | Description |
| --- | --- |
| `new TileMap(cols, rows, tile, data?)` | `tile` = tile size in px; optional initial data. |
| `get(cx, cy)` / `set(cx, cy, v)` | Cell access (out-of-bounds reads `0`). |
| `pixelW()` / `pixelH()` | Pixel size of the whole map. |
| `solidAt(px, py, solid)` | Is the tile at a world pixel in the `solid` set? (collision). |
| `drawColors(g, colors, cam)` | Render each index as `colors[index]` (`undefined` skipped). |
| `drawSprites(g, tiles, cam, scale = 1)` | Render each index as `tiles[index]` (a `Bitmap`). |

`cam` is any `{ x, y }`; only the visible range is drawn.

---

## dialogue — the dialogue box

`DialogueBox extends Node` — a bottom-of-screen text box. Advances on
`Btn.Cross`/`Btn.Start`, calls `onDone()` and removes itself when the lines run
out.

```js
this.add(new DialogueBox(
  ['Welcome, traveler.', 'Press Cross to continue.'],
  () => this.startQuest(),
));
```

Tunable fields: `scale`, `fg`, `bg`, `border`.

---

## fps — wall-clock FPS counter

`Fps` measures **real** frame time (the engine's `dt` is fixed, so it can't).
Call `fps.sample()` once per frame; read `fps.value` (smoothed over ~1 s). Uses
the host `now()` (µs on PSP); stays `0` on hosts without it. Render it with
`g.text` to read FPS in a screenshot.

---

## math — deterministic 3D math

All math is f64 using only `+ - * /` and `Math.round/abs/sqrt` — **never** the
engine trig builtins — so results are **bit-identical** across QuickJS (PSP/3DS)
and the browser. Matrices are **column-major**, the world is **right-handed**, and
projection is **reversed-Z**.

| Export | Description |
| --- | --- |
| `PI`, `TWO_PI`, `HALF_PI`, `DEG2RAD` | Constants. |
| `dsin(x)` / `dcos(x)` | Deterministic sine / cosine (range-reduced Taylor). |
| `dsqrt(x)` | Deterministic sqrt (IEEE sqrt is exact). |
| `datan2(y, x)` | Deterministic `atan2` in `(-π, π]`. |
| `Vec3` | 3-vector: `set add sub scale dot cross length normalize`, static `Vec3.lerp`. |
| `Quat` | Unit quaternion: `Quat.identity/fromEuler/fromAxisAngle`, `multiply`, static `Quat.nlerp`. |
| `Mat4` | Column-major 4×4 helpers (a plain object, not a class) — see below. |

`Mat4` (length-16 `number[]`, `m[col*4 + row]`):

- `identity()`, `multiply(a, b)` (`a*b`), `fromQuat(q)`, `compose(pos, quat, scale)`.
- `perspectiveReversedZ(fovDeg, aspect, near, far, zeroToOne = true)` — `zeroToOne` true for PSP/3DS/WebGL-with-`EXT_clip_control`, false for the WebGL fallback.
- `lookAt(eye, center, up)`.
- `toF32(m)` (the wire type), `fromArray(a, off)`, `affine3x4Into(out, off, m)` (the GE 3×4 bone-matrix slice).

```js
const cam = new Camera();
cam.setPerspective(60, SCREEN_W / SCREEN_H, 0.1, 100);
cam.lookAt(new Vec3(0, 4, 8), new Vec3(0, 0, 0), new Vec3(0, 1, 0));
```

---

## g3d — the 3D wire format & command encoder

The cross-host 3D contract. One little-endian command buffer is built per frame
and handed to `g3d.submit` in a single FFI call. See [3D](/docs/3d/) for the
conventions (depth, winding, color).

**Constants** — `DC3D_MAGIC`, `DC3D_VERSION`; opcodes `OP_SET_CAMERA`, `OP_DRAW`,
`OP_IMM_TRIS`, `OP_BIND_TEXTURE`, `OP_SET_LIGHTS`, `OP_DRAW_SKINNED`, `OP_SET_FOG`,
`OP_DRAW_SKIN_ANIM`; vertex-format bits `FMT_POS`, `FMT_COLOR`, `FMT_NORMAL`,
`FMT_UV`, `FMT_WEIGHTS`; texture formats `PSM_5650`, `PSM_5551`, `PSM_4444`,
`PSM_8888`; sentinels `NO_TINT`, `UNBIND_TEXTURE`.

**Functions** — `vertexStride(format, weightCount = 0)`, `colorToABGR(c, a = 255)`
(pack `0xRRGGBB` → PSP-style ABGR u32).

**`CommandEncoder`** — built once and reused (`reset()` rewinds it):

| Method | Emits |
| --- | --- |
| `setCamera(viewProj)` | `OP_SET_CAMERA` (16-float column-major `proj*view`). |
| `draw(handle, model, tintABGR?)` | `OP_DRAW` of a retained mesh. |
| `drawAt(handle, m, off, tintABGR?)` | Like `draw`, reading the model matrix from a `Float32Array` at `off` (zero-alloc). |
| `bindTexture(texHandle)` | `OP_BIND_TEXTURE` (`UNBIND_TEXTURE` disables). |
| `setLights(ambient, lights)` | `OP_SET_LIGHTS` (ambient + ≤4 directional `{dir, color}`). |
| `setFog(colorABGR, near, far)` | `OP_SET_FOG` (color `0xffffffff` disables). |
| `drawSkinned(handle, model, bones, boneCount, tintABGR?)` | `OP_DRAW_SKINNED` (JS-computed ≤8 bone matrices). |
| `drawSkinAnim(skinHandle, clipHandle, model, phase, tintABGR?)` | `OP_DRAW_SKIN_ANIM` (native sampler; ships only the clip phase). |
| `immTris(vertices, vertexCount, format, byteLength)` | `OP_IMM_TRIS` (inline geometry; reserved). |
| `finish()` | Write the header + `g3d.submit` (no-op without a 3D host). |
| `packet()` | Seal the buffer and return `{ buffer, byteLength, records }` without submitting. |

Most games never touch the encoder directly — [`Scene3D`](#scene3d--the-3d-scene-graph)
drives it. The host side of this contract is in
[`host3d`](#host3d--the-optional-native-3d-host).

---

## host3d — the optional native 3D host

The ambient `g3d` global (declared here) and capability probes.

| Export | Description |
| --- | --- |
| `RawG3d` (interface) | The native 3D contract: `uploadMesh`, optional `uploadTexture`/`uploadSkin`/`uploadClip`, `freeMesh`, the per-frame `submit`, and the optional retained-scene quartet `sceneClear`/`sceneAdd`/`sceneSetEnv`/`sceneRender`. |
| `hasG3d()` | `true` when the host provides the 3D contract. |
| `hasNativeScene()` | `true` when the host implements the retained native scene (`sceneRender`). |

A 2D-only host leaves `g3d` undefined and the framework simply skips the 3D pass.

---

## mesh — geometry

| Export | Kind | Description |
| --- | --- | --- |
| `MeshBuilder` | class | Accumulate `vertex(x,y,z,color)` + `tri(a,b,c)`/`quad(a,b,c,d)`, then `build()` a v1 `POS|COLOR` `Mesh`. |
| `TexMeshBuilder` | class | Same, but vertices carry optional UV (`FMT_UV`) + normal (`FMT_NORMAL`); `new TexMeshBuilder({ uv, normal })`. |
| `Mesh` | class | Holds interleaved vertex bytes + a `Uint16` index buffer + format; uploads lazily on first `handle()`. |
| `BakedMesh` | interface | A glTF-baked mesh: format/stride/counts + interleaved bytes + indices + AABB. |
| `meshFromBaked(b)` | function | Wrap a `BakedMesh` into an uploadable `Mesh`. |
| `mergeMeshes(parts)` | function | Bake many `{ mesh, model }` into ONE static `POS|COLOR` mesh (one GE draw for a scenery clump; UV/normal dropped). |

`Mesh` primitives (static): `Mesh.solid(c)` (6 face colors), `Mesh.cube(size, faceColors)`,
`Mesh.box(w, h, d, faceColors)`, `Mesh.texturedCube(size, tint?)`,
`Mesh.plane(w, d, color)`. `handle()` uploads on first call (returns `-1` with no
3D host); `vertexCount` getter.

```js
const ground = Mesh.plane(40, 40, Colors.grass);
const crate = Mesh.cube(2, Mesh.solid(Colors.brown));
```

---

## material — textures & materials

| Export | Kind | Description |
| --- | --- | --- |
| `Texture` | class | Pixel bytes in a `PSM_*` format; uploads lazily on first `handle()` (returns `-1` if the host has no texturing). Statics: `Texture.solid(w, h, color, a?)`, `Texture.checker(w, h, c0, c1, cells?)`. |
| `Material` | class | `new Material({ texture?, baseColor? })` — an optional texture modulated by a base vertex color (default white). A `Node3D` references one so `Scene3D` binds the texture before drawing. |

---

## light — hardware lighting

The GE does T&L in hardware: up to 4 directional lights + a global ambient,
applied per-vertex via the mesh's `FMT_NORMAL`.

| Export | Description |
| --- | --- |
| `DirectionalLight` | `new DirectionalLight(dir: Vec3, color = 0xffffff)` — direction is normalized on construction; `colorABGR()`. |
| `Lighting` | `new Lighting(ambient = 0x202020)` — `add(light)`, `ambientABGR()`, `encoded()` (≤4 lights). Assign to `Scene3D.lighting`. |

```js
const lit = new Lighting(0x303040);
lit.add(new DirectionalLight(new Vec3(-1, -2, -1), 0xfff0d0));
scene.lighting = lit;
```

---

## anim — skeletal animation playback

| Export | Kind | Description |
| --- | --- | --- |
| `BakedClip` | interface | A clip baked to a fixed fps: `{ fps, frameCount, t, r, s }` (flat `Float32Array` TRS tables). |
| `AnimationPlayer` | class | Loops a time cursor and samples two bracketing frames (lerp T/S, nlerp R) into preallocated `outT`/`outR`/`outS` (no per-frame GC). |
| `poseFromClip(clip, jointCount, frame = 0)` | function | A frozen single-frame pose (e.g. the bind pose). |

`AnimationPlayer`: `new AnimationPlayer(clip, jointCount)`, `time`, `duration`,
`advance(dt)`, `setTime(t)`, `sample()`.

---

## skin — hardware skinning

JS samples the animation, walks the joint hierarchy and ships ≤8 final 3×4 bone
matrices per bone-batch; the GE skins in hardware. On a host with `uploadSkin` +
`uploadClip` the whole pipeline runs natively (JS ships only the clip phase).

| Export | Kind | Description |
| --- | --- | --- |
| `BakedSkin` | interface | A baked skinned character: scale, joint hierarchy, inverse-bind matrices, bind pose, bone-batch tables, clips and texture. |
| `Skeleton` | class | `computeWorld(outT,outR,outS)` (parent-first), `batchBones(jointTable, boneCount, out)`. |
| `SkinnedMesh` | class | `SkinnedMesh.fromBaked(skin)`, `play(clip)` (returns the player), `emit(enc, model, tint)`. Set on `Node3D.skinned`. |

```js
import { FOX } from '../src/assets-fox';        // baked asset, imported directly
const fox = SkinnedMesh.fromBaked(FOX);
const p = fox.play(FOX.clips.Run);
scene.add({ skinned: fox, position: new Vec3(0, 0, 0) });
// per frame:
p.advance(ctx.dt);
```

---

## scene3d — the 3D scene graph

Mirrors the 2D Scene/Node tree. Build a `Scene3D` of `Node3D`s + a `Camera`,
assign it to `engine.scene3d`, and the engine emits the per-frame draw list.

| Export | Kind | Description |
| --- | --- | --- |
| `Camera` | class | `setPerspective(fovDeg, aspect, near, far)`, `lookAt(eye, center, up)`; fields `proj`/`view`/`viewProj`/`eye`/`zeroToOne`. |
| `Node3D` | class | A drawable node — see below. |
| `Node3DOpts` | interface | Constructor options: `mesh`, `material`, `skinned`, `position`, `rotation`, `scale`, `tint`, `isStatic`, `matrix`. |
| `AABB` | interface | `{ min: [x,y,z], max: [x,y,z] }` local-space bounds for culling. |
| `Scene3D` | class | The scene + camera + optional lighting/fog; drives the encoder. |

`Node3D`: `position`/`rotation`/`scale`, optional `mesh`/`material`/`skinned`,
optional `bounds` (enables frustum + distance culling), `tint`, `visible`,
`isStatic` (cache world matrix + bounds — a big PSP win for scenery), `matrix`
(precomputed local matrix override); `add(child)`, `setTint(c)`, `localMatrix()`.

`Scene3D`: `root`, `camera`, optional `lighting`, optional
`fog = { color, near, far }`, diagnostic `culledCount`;
`add(nodeOrOpts)`, `invalidateStatic()` (rebuild after changing static nodes),
`render(enc)` (called by the engine). An all-static scene on a host with the
retained native scene API is uploaded once and culled+drawn in native code (JS
only sends the camera).

```js
const scene = new Scene3D();
scene.camera.setPerspective(60, SCREEN_W / SCREEN_H, 0.1, 100);
scene.add({ mesh: Mesh.plane(40, 40, Colors.grass), isStatic: true });
scene.add({ mesh: crate, position: new Vec3(0, 1, 0), isStatic: true });
ctx.engine.scene3d = scene;
```

---

## dcpak — the `.dcpak` asset reader

Isomorphic reader for the binary asset container (see [assets](/docs/assets/)).
The host exposes the per-game pack as the global `ArrayBuffer __dcpak` before the
bundle runs; baked `assets-*.ts` modules pull their blobs by key.

| Export | Returns | Description |
| --- | --- | --- |
| `dcU8(key)` | `Uint8Array` | Raw blob bytes (a fresh copy; throws on a missing key). |
| `dcI8(key)` | `Int8Array` | e.g. joint parents. |
| `dcU16(key)` | `Uint16Array` | e.g. triangle index buffers. |
| `dcF32(key)` | `Float32Array` | e.g. matrices, bind pose, animation tracks. |

Accessors return a typed array over a fresh copy, so `arr.buffer` is exactly that
blob (matching the old `unb64('...').buffer` semantics `meshFromBaked` relies on).

Also re-exported from the barrel: `unb64(s)` (the portable base64 decoder used by
older baked modules), and the baked defaults `FONT8X8` and `SPRITES`.

---

## controller — character controller & camera rig

> Imported directly: `import { CharController, Collide } from '../src/controller'`
> (3D-only; not re-exported from the barrel).

The reusable kinematics/camera/collision core the 3D games share.

| Export | Kind | Description |
| --- | --- | --- |
| `KinematicState` | interface | `{ x, y, z, heading, pitch, speed, fwdX, fwdZ }`. |
| `newState(x?, y?, z?, heading?)` | function | A fresh state. |
| `MoveConfig` | interface | Movement tuning: `speed` mode (`continuous`/`gated`), `accel`/`decel`/`maxSpeed`, `walkSpeed`/`runSpeed`/`backSpeed`, `alwaysForward`, `turnRate`, `steerScalesWithSpeed`/`steerSpeedCap`, `pitchRate`, `fwdSignZ`. |
| `kinematicStep(s, throttle, steer, pitch, run, cfg, dt)` | function | Advance one fixed step (heading → forward → position). |
| `Box` | interface | `{ minX, maxX, minZ, maxZ }`. |
| `Collide` | object | `clamp`, `clampBox`, `slideAabb` (wall sliding), `rayAabb` (hitscan). |
| `CamMode` / `CamRig` | type / interface | `'chase' \| 'fps' \| 'freefly'` + rig params (`dist`, `lookahead`, `eyeY`, `lookY`, `eyeHeight`, …). |
| `camApply(cam, rig, s, eye, center)` | function | Position a `Camera` for a rig + state. |
| `InputSample` | interface | `{ throttle, steer, pitch, run }`. |
| `CharController` | class | Bundles state + config + rig with camera scratch vectors: `step(sample, dt)`, `applyCam(cam)`. |

```js
import { CharController } from '../src/controller';
const ctrl = new CharController(
  { speed: 'gated', walkSpeed: 2.4, runSpeed: 4.8, turnRate: 3, fwdSignZ: 1 },
  { mode: 'chase', dist: 7, eyeY: 3.2, lookY: 0.9 },
  { x: 0, z: 0 },
);
ctrl.step({ throttle: map.axis('MOVE'), steer: map.axis('STEER'), pitch: 0, run: map.held('RUN') }, ctx.dt);
ctrl.applyCam(scene.camera);
```

---

## action — the action map

> Imported directly: `import { ActionMap } from '../src/action'` (3D-only; not in
> the barrel).

A data-driven layer over `Input`: declare NAMED actions bound to buttons and/or an
analog axis, then query by name. Allocation-free per frame; rebinding is a config
edit.

| Export | Kind | Description |
| --- | --- | --- |
| `Binding` | interface | `{ buttons?, axis?: 'lx' \| 'ly', axisButtons?: [neg, pos], invert? }`. |
| `ActionConfig` | type | `Record<string, Binding>`. |
| `ActionMap` | class | `new ActionMap(input, cfg)`; `held(name)`, `pressed(name)`, `axis(name)` (analog past deadzone else the digital pair), `vec(xa, ya)`. |

```js
import { ActionMap } from '../src/action';
import { Btn } from '../src/index';
const map = new ActionMap(ctx.input, {
  ACCEL: { buttons: [Btn.Cross] },
  STEER: { axis: 'lx', axisButtons: [Btn.Left, Btn.Right] },
  RESET: { buttons: [Btn.Start] },
});
if (map.pressed('RESET')) reset();
```

---

## scene-desc — data-driven 3D scenes

> Imported directly: `import { buildScene, loadScene } from '../src/scene-desc'`
> (3D-only; not in the barrel).

Declare mesh PROTOTYPES + ENTITIES + INSTANCE GROUPS as data; `buildScene()` turns
it into a `Scene3D`, adding nodes in declaration order so the draw list is
byte-identical to the equivalent hand-written `onEnter`.

| Export | Kind | Description |
| --- | --- | --- |
| `MeshProto` | type | `{ kind: 'box', size, colors } \| { kind: 'plane', size, color } \| { kind: 'baked', key }`. |
| `EntityDesc` | interface | One placed node: `proto` or inline `box`, `position`/`rotation`/`scale` or `matrix`, `bounds`, `tint`, `isStatic`, `id`. |
| `InstanceGroup` | interface | Many placements of one prototype: `proto`, `positions[]`, `tint`, `isStatic`, `merge`, `id`. |
| `AABBDesc` | interface | `{ min, max }`. |
| `SceneDescriptor` | interface | `{ camera?, fog?, prototypes, entities?, instances?, colliders? }`. |
| `BuiltScene` | interface | `{ scene, nodes, colliders }` (`nodes` keyed by `id`). |
| `buildScene(d)` | function | Build a `Scene3D` from an in-memory descriptor (byte-exact for any transform). |
| `loadScene(key)` | function | Reconstruct + build a scene baked under `key` (byte-exact for translation-only scenes; see source for the rotation/scale caveat). |
| `registerBaked(key, make)` | function | Register a resolver for a `baked` prototype so only games that use it pay for the asset module. |

```js
import { buildScene } from '../src/scene-desc';
const { scene, nodes } = buildScene({
  camera: { fovDeg: 60, aspect: SCREEN_W / SCREEN_H, near: 0.1, far: 200 },
  prototypes: {
    cone: { kind: 'box', size: [0.5, 1, 0.5], colors: Mesh.solid(Colors.orange) },
    ground: { kind: 'plane', size: [400, 400], color: Colors.grass },
  },
  entities: [{ proto: 'ground', isStatic: true, id: 'floor' }],
  instances: [{ proto: 'cone', positions: [[0, 0, 0], [4, 0, 0], [8, 0, 0]] }],
});
```

---

## See also

- [Runtime contract](/docs/runtime-contract/) — the raw `gfx`/`log`/`frame` layer and the button bitmask.
- [Framework SDK](/docs/framework/) — the same modules in narrative form.
- [3D](/docs/3d/) — the `g3d` contract, scene offload and glTF skinning in depth.
- [Assets & .dcpak](/docs/assets/) — how baked blobs reach `dcpak` accessors.
