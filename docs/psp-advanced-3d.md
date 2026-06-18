# DreamCart PSP Advanced 3D: Textures, Lighting, Skeletal Animation

> Design + implementation plan for extending DreamCart's `g3d` contract and PSP host
> (`runtime/src/gfx3d.rs`) toward **textured, hardware-lit, hardware-skinned** scenes
> built from real CC0/open glTF assets, plus an experimental PoC of three scenes:
> a **walking person**, a **driving car**, and a **3D outdoor scene**.
>
> Status: research + design. The parent implements from this plan. PSP-first; Web/3DS/Android
> follow additively so the "same `.js` runs everywhere" invariant holds.

---

## 1. Verdict & feasibility

**Yes — all three scenes are feasible on real PSP hardware, with comfortable headroom.** The
PSP GE (Graphics Engine, 166 MHz) does T&L lighting, texturing, **and** skeletal skinning *in
hardware*. Our architecture keeps every byte of scene/animation/physics **logic in portable JS**
(deterministic `math.ts`), ships only *matrices and bone-matrices* per frame, and lets the GE skin
+ light + texture. The 333 MHz MIPS core never touches a vertex.

The single defining hardware fact: **the PSP GE has NO bone-index matrix palette.** A vertex
carries N float weights (N = 1..8); the GE blends the *first N of 8* bone matrices set by
`sceGuBoneMatrix(i, …)`. There are no per-vertex bone indices. Consequence: **one draw call can
skin against at most 8 bones**, so any rig with > 8 joints must be **partitioned at bake time** into
≤ 8-bone submeshes ("bone batches"). This is the dominant design driver and the biggest implementation risk.

### Concrete budgets (grounded in Sony GE specs + real PSP titles)

| Resource | Hardware ceiling | Our per-frame target (30 fps) |
|---|---|---|
| Triangles | ~33 M tris/s peak T&L (~1.1 M/frame theoretical; real games ~35–58 k/frame) | **≤ 12–15 k tris/frame** |
| Draw calls | each `sceGumDrawArray`+matrix has fixed GE cost | **≤ 80–100 draws/frame** |
| Bones / draw | **8** (`sceGuBoneMatrix` index 0..7) — *use ≤ 4 as the safe baseline* | 4–8 per bone batch |
| Weights / vertex | 8 (`WEIGHTS1..8`) | **4** (`WEIGHTS4`) |
| Fill rate | 664 Mpix/s (~22 Mpix/frame @30fps; screen = 130 k px) | overdraw ≤ ~1.5× |
| VRAM (eDRAM) | **2 MB total**, ~1.39 MB already used by 2× PSM8888 framebuffers + PSM4444 z-buffer → **~660 KB free** | textures ≤ 256×256, 16-bit/CLUT, or in main RAM |
| Main RAM | ~24–32 MB (QuickJS worker heap is 2 MB; geometry lives in `qjs_alloc`) | watch non-indexed expansion |

**Real-world anchors** (web-verified): DoA Paradise PSP = 58,523 tris/frame @30fps; Shenmue2 PSP =
46,507; Yakuza PSP = 35,949. MGS Peace Walker characters ≈ 1.5–2 k tris; GoW PSP Kratos ≈ 5 k.
Our three scenes combined sit at **< 15 k tris/frame** — GE skinning is essentially *free* relative
to budget.

### Per-scene verdict

- **Walking person** (skinned): Khronos **Fox** (576 tris, 24 joints → ~3–4 bone batches) or
  three.js **Soldier** (larger rig, multiple skinned primitives). Skinned in HW. → **60 fps achievable.**
- **Car** (rigid): Kenney **Car Kit** body + 4 wheel meshes spun/steered by per-frame model
  matrices in JS. No skinning; exercises the *texture* path. → **60 fps.**
- **Outdoor** (lit + instanced): JS heightmap terrain + a few hundred instanced Kenney **Nature
  Kit** props, 1 directional light + fog. This is the **hardware max-out** scene. → **30 fps target.**

---

## 2. The hardware story (and how to max the 333 MHz machine)

All APIs below are **verified present in `rust-psp/psp/src/sys/gu.rs`** at the cited lines.

### 2.1 Hardware skinning (`sceGuBoneMatrix` + `WEIGHTSn`)

```rust
// rust-psp/psp/src/sys/gu.rs:3361
pub unsafe extern "C" fn sceGuBoneMatrix(index: u32 /* 0..7 */, matrix: &ScePspFMatrix4)
```

- Sends `GeCommand::BoneMatrixNumber = index*12`, then **12 floats** (the 3×4 affine part: each
  column's `.x/.y/.z`; the homogeneous w-row is **dropped**). Bones are affine-only — exactly right
  for joints, no per-bone projection.
- VertexType bits (`gu.rs:119–139`): `WEIGHT_8BIT=1<<9`, `WEIGHT_16BIT=2<<9`, `WEIGHT_32BITF=3<<9`;
  `WEIGHTS1..WEIGHTS8` via `num_weights(n) = ((n-1)&7)<<14`.
- GE math: `finalPos = ( Σ_{i<N} weight_i · BoneMatrix_i ) · Model · View · Proj`. **No bone
  index** — weight slot `i` is hardwired to bone matrix `i`.
- **There is no `sceGumBoneMatrix`** in `gum.rs` (grep-confirmed). The host calls the low-level
  `sys::sceGuBoneMatrix` directly with **final** matrices `jointWorld · inverseBind` computed in JS.
  Because bone matrices are a *separate GE register* (not on the gum stack), for skinned draws set
  Model = identity (or the mesh root) so the multiply order above holds.
- **Caveat:** the ps2dev forum documents a mode where *only the first 4 of 8 matrices are used*. The
  first PoC ships **≤ 4 weights/bones per submesh** and validates 5–8 on PPSSPP before relying on them.

**Strategy — SHARED-JS-BONE-MATRICES (chosen):** JS samples the glTF clip → composes local TRS →
walks the joint hierarchy → multiplies by `inverseBindMatrices` → ships ≤ 8 final 3×4 matrices per
bone batch over the wire. The GE skins in hardware. *Rejected:* CPU-skinning vertices in QuickJS
(per-vertex Mat4·Vec3 on a 333 MHz interpreted core is the bottleneck) and native-Rust skinning
(would put animation logic in Rust, violating the JS-logic/native-render rule).

### 2.2 Hardware lighting (T&L)

`sceGuLight(light, LightType, LightComponent, &pos)` (`gu.rs:2196`), `sceGuLightColor`
(`:2245`), `sceGuLightAtt` (`:2229`), `sceGuLightMode` (`:2273`), `sceGuAmbient` (`:2495`),
`sceGuMaterial` (`:2543`). Up to **4 lights**. `LightType::Directional=0` reuses the position vec
as a **direction**; color is `0xBBGGRR` (alpha masked). **Requires vertex NORMALs** (`FMT_NORMAL`).
Enable `GuState::Lighting` + `GuState::Light0..3`. The GE skins the normal by the same bone
matrices, so lighting composes with skinning for free.

### 2.3 Texturing

`sceGuTexImage(mip, w, h, tbw, ptr)` (`gu.rs:2865`), `sceGuTexMode(psm, maxmips, a2, swizzle)`
(`:2977`), `sceGuTexFunc(effect, cc)` (`:2814`), `sceGuTexFilter(min, mag)` (`:2792`),
`sceGuTexWrap/Scale/Offset`. `TexturePixelFormat` (`:172`): `Psm5650=0, Psm5551=1, Psm4444=2,
Psm8888=3`, indexed `PsmT4/T8`, `PsmDxt1/3/5`. **HW limits:** width/height power-of-two, 1..512;
pixel data 16-byte aligned; `tbw` block-aligned (Psm8888 multiple of 4). `TextureEffect::Modulate=0`
(texture × vertex color — the default for lit/colored) vs `Replace=3`. Working reference:
`rust-psp/examples/cube/src/main.rs:161–172` uses `{u,v,x,y,z}` (UV before pos — confirms GE order).

**VRAM math:** a 256×256 PSM8888 = 256 KB; two of those exhaust the ~660 KB free VRAM. So **prefer
16-bit (PSM5650/5551 = 128 KB @256²) or DXT1 (32 KB @256²) or PsmT8 (CLUT)**, or keep textures in
main RAM (the GE can texture from a system-memory pointer).

### 2.4 Maxing the hardware — the levers

1. **Retained geometry.** Upload every static mesh **once** (`uploadMesh`); never re-upload. Animate
   *only* via per-frame model/bone matrices in `submit()`. (The repo's `racing3d.js` already proves
   one-upload-many-draws instancing.)
2. **Bone-matrices-only animation.** The per-char payload is ≤ 8×12 floats = 384 B/batch — flushing
   it each frame is negligible.
3. **Fog** (`sceGuFog(near, far, color)`, `gu.rs:1185`) to hide the far clip plane and cut overdraw
   on the outdoor scene; clear color = sky color.
4. **Frustum culling + LOD in JS** (new `Scene3D` feature) to keep draws under budget.
5. **16-bit / CLUT / DXT textures**, ≤ 256², mipmapped with `sceGuTexFilter(LinearMipmapLinear, …)`
   to cut distant fill.
6. **Reversed-Z early-out** is already on (`DepthFunc GEQUAL`); rough front-to-back ordering helps.
7. **dcache flush once** at upload (`sceKernelDcacheWritebackRange`, already done for meshes); the
   GE reads RAM, not cache.

---

## 3. `g3d` contract extensions (additive, PSP-first)

All changes are **purely additive** and gated so v1 cube/racing/fps goldens stay byte-identical.
The hard invariant: **the GE reads interleaved vertex components in a FIXED order** —
`[weights][uv][color][normal][position]`, each 4-byte aligned — *regardless of wire bit order*.
v1's `[color u32][pos 3 f32]` is already a legal subset (color before position). The encoder/bake
**must emit bytes in GE order**, not declaration order.

### 3.1 New constants (add to `framework/src/g3d.ts`)

```ts
export const DC3D_VERSION = 0x0002;          // bump from 0x0001

export const OP_BIND_TEXTURE = 0x0004;       // state: bind/unbind current texture
export const OP_SET_LIGHTS   = 0x0005;        // state: ambient + up to 4 directional lights
export const OP_DRAW_SKINNED = 0x0006;        // draw + per-draw bone matrices

export const FMT_WEIGHTS = 0x0010;            // vertex carries bone weights (count is explicit, see below)
// FMT_NORMAL = 0x0004 and FMT_UV = 0x0008 already exist (were reserved) — now used.
```

`vertexStride()` gains the two already-summed branches plus a weight term; keep it **order-independent**
(it already is). Weight count is **not** a single bit — carry `weightCount` explicitly per mesh
(see upload) so `FMT_WEIGHTS` stays one clean bit.

> **Lockstep requirement (CI-enforced):** every constant above MUST be appended to the `NAMES` array
> in `framework/test/contract.ts:109` **and** mirrored as a `NAME = 0xHEX` line in the
> **comment block** of `runtime/src/gfx3d.rs` (the regex can't read a typed `const X: u32 = …`, so
> the comment block is canonical). Stage host additions atomically or the parity test fails the build.

### 3.2 Wire records

```
OP_BIND_TEXTURE  payload = u32 texHandle      (0xffffffff = unbind)
OP_SET_LIGHTS    payload = u32 lightCount, u32 ambientABGR,
                           then lightCount × { u32 colorABGR, 3×f32 dir }
OP_DRAW_SKINNED  payload = u32 handle, u32 tintABGR, u32 boneCount (≤8),
                           16×f32 model (column-major),
                           then boneCount × 12×f32 (3×4 affine bone matrices, GE order:
                           col0.xyz, col1.xyz, col2.xyz, col3.xyz)
```

Keep `OP_DRAW` (18-word) **unchanged** — rigid meshes (car body, wheels, terrain, props) use it as
today. Texture binding is a **state record**, not a per-DRAW field, so `OP_DRAW`'s layout is stable.

### 3.3 New host FFI: `g3d.uploadTexture`

```
g3d.uploadTexture(pixels: ArrayBuffer, w, h, psm) -> int texHandle
```

Mirrors `js_g3d_upload_mesh`: copy bytes into a **16-byte-aligned** `Vec`, dcache-flush once, store
`{ ptr, w, h, tbw, psm }` in a `TEXTURES` table (a `static mut`, same single-thread style as
`MESHES`). Validate power-of-two, w,h ≤ 512.

### 3.4 `CommandEncoder` methods (`g3d.ts`)

```ts
bindTexture(texHandle: number): void               // OP_BIND_TEXTURE
setLights(ambient: number, lights: {dir:[number,number,number], color:number}[]): void
drawSkinned(handle: number, model: ArrayLike<number>, bones: Float32Array[] /* len≤8, each 12 */, tint: number): void
```

### 3.5 `gfx3d.rs` host additions

- **`MeshEntry` gains `format: u32`, `weight_count: u8`, `stride: usize`.** Build the per-mesh
  `VertexType` **once at upload**:
  `COLOR_8888?` | `TEXTURE_32BITF?` | `NORMAL_32BITF?` | `(WEIGHT_32BITF | WEIGHTSn)?` |
  `VERTEX_32BITF | TRANSFORM_3D`. Replace the fixed `Vertex16` with a stride-aware aligned byte
  buffer (keep the 16-byte *buffer* alignment via an aligned alloc; the GE needs each vertex 4-byte
  aligned, so pad stride to 4).
- **Relax the upload guard** (`gfx3d.rs:154–156`) from "exactly POS|COLOR" to "POS required;
  COLOR/UV/NORMAL/WEIGHTS optional".
- **`OP_BIND_TEXTURE`** → `sceGuEnable(Texture2D)` + `sceGuTexMode(psm,0,0,0)` +
  `sceGuTexImage(None,w,h,tbw,ptr)` + `sceGuTexFunc(Modulate, Rgba)` +
  `sceGuTexFilter(Linear, Linear)`; unbind → `sceGuDisable(Texture2D)`.
- **`OP_SET_LIGHTS`** → `sceGuAmbient(ambient & 0xffffff)`; for each light: enable `Light0+i`,
  `sceGuLight(i, Directional, DIFFUSE, &dir)`, `sceGuLightColor(i, DIFFUSE, color)`; then
  `sceGuEnable(Lighting)`. Disable `Lighting` again at the HUD handoff (next to the existing
  `DepthTest` disable at the end of `submit`).
- **`OP_DRAW_SKINNED`** → set Model = `model`, loop `i in 0..boneCount`:
  `sys::sceGuBoneMatrix(i, &align16(bone_i))` (pack the 12 floats into a `ScePspFMatrix4`; the
  call reads only `.x/.y/.z` of each column), then `sceGumDrawArray` with the mesh's stored
  WEIGHTS-enabled `VertexType`.

### 3.6 Forward compatibility

All new records are length-prefixed (`words`), so unimplemented hosts **skip** them (gfx3d.rs
already does). Web (`web/engine.js`, WebGL2) maps `FMT_UV`→sampler, `FMT_NORMAL`→lambert,
`OP_DRAW_SKINNED`→a uniform array of ≤ 8 `mat4` bones in the vertex shader (Web *has* a palette, but
uses the same slot-i convention to match PSP). 3DS (citro3d) and Android follow. **The software
oracle `framework/test/raster3d.ts` must gain matching paths before any new golden is trusted.**

---

## 4. Asset pipeline (glTF → PSP bake)

Mirrors the existing `framework/bake/*.ts` pattern (read a vendored source → emit a TS data module
of typed arrays into `framework/src/`, e.g. `assets-fox.ts`).

### 4.1 Tooling (verified working in Bun)

- **Parser: `@gltf-transform/core@4.4.0`** — installs with 2 deps, no native build; reads `.gltf`
  (external `.bin`) and `.glb`, decodes accessors/base64 automatically. Verified API:
  `io.read(path) → Document`; `root.listMeshes()[0].listPrimitives()[0].getAttribute('POSITION'|
  'NORMAL'|'TEXCOORD_0'|'JOINTS_0'|'WEIGHTS_0')`; `accessor.getElement(i, [])`, `.getCount()`,
  `.getComponentType()` (5126=f32, 5123=u16, 5121=u8); `root.listSkins()[0].listJoints()` +
  `.getInverseBindMatrices()`; `anim.listChannels()[i].getTargetPath()/.getTargetNode()/.getSampler()`.
  **Do not hand-roll a `.glb` reader.**
- **PNG decode: `upng-js@2.1.0`** (pure JS) — `UPNG.decode(buf)` → `{width,height}`,
  `UPNG.toRGBA8(img)[0]` → RGBA bytes. Verified to decode the Fox texture.

Add both to `devDependencies`; add bake invocations to the `bake` script in `package.json`.

### 4.2 Bake steps (`framework/bake/bake-gltf.ts`)

1. **Parse** mesh attributes; **expand non-indexed** (matches the host's draw path) per triangle.
2. **Bone-batch partition** (the key technique): partition triangles into groups each touching ≤ 8
   (ideally ≤ 4) unique joints; remap each group's `JOINTS_0` to local bone slots 0..k-1; emit one
   vertex buffer + a `jointTable` (local→global joint) per batch. Fox(24)→~3–4 batches;
   larger rigs split into more batches. *Partition by triangle, not vertex* (a tri whose verts span > 8 joints must be
   assigned to one batch pulling in those joints).
3. **Vertex interleave in GE order** `[weights][uv][color][normal][pos]`, padded to 4. PoC skinned
   vertex: `WEIGHTS4 (f32) + UV (f32×2) + COLOR (u32) + NORMAL? + POS (f32×3)`. Lean
   skinned+textured = `4×4(w) + 8(uv) + 12(pos) = 36 B`; consider `WEIGHT_8BIT` later (4 B weights).
4. **Texture convert**: decode PNG → RGBA → **box-downsample to ≤ 256²** (the Fox PNG is 1024² — too
   big as-is) → pack to chosen PSM (start PSM8888 for simplicity, then 5551/5650 to save VRAM) →
   emit `Uint8Array`. Apply a uniform model scale where needed (Fox positions are ~2..35 units →
   scale ~0.03).
5. **Animation resample**: resample every clip to a **fixed fps** (24 or 30) so runtime is array
   lookup + lerp, not per-channel binary search. Emit per clip: `{ name, fps, frameCount,
   trs: Float32Array[joint][frame] }`. (Fox Walk = 0.708 s ≈ 18 frames already.)
6. **Emit** `framework/src/assets-<name>.ts`: `{ batches: [{vertices, format, weightCount,
   jointTable}], jointHierarchy: parentIndex[], inverseBindMatrices: Float32Array,
   clips, texture: {w,h,psm,pixels} }`, with a **header comment naming the asset + license + URL**
   (like `bake-font.ts` records dhepper/font8x8). Re-export from `index.ts`.

### 4.3 The specific assets

| Scene | Asset | License | URL | Counts |
|---|---|---|---|---|
| **Person (primary)** | Khronos **Fox** | **CC-BY-4.0** (PixelMannen + tomkranis + Asobo/scurest — **attribution required**) | `KhronosGroup/glTF-Sample-Assets` `Models/Fox` | 576 tris, 1728 verts, **24 joints**, 3 clips (Survey/Walk/Run), JOINTS_0 u16×4, WEIGHTS_0 f32×4, **no NORMAL**, 1024² PNG |
| **Person (tactical demo)** | three.js **Soldier** | **MIT** | `three.js/examples/models/gltf/Soldier.glb` | 11376 tris after bake, **49 joints**, Idle/Walk/Run/TPose clips, split across multiple skinned primitives |
| **Car** | Kenney **Car Kit** (sedan + 8 wheels) | **CC0 1.0** (no attribution) | `kenney.nl/assets/car-kit` | low-poly, ~600 tris body / ~200 tris/wheel, **one shared palette texture** |
| **Outdoor props** | Kenney **Nature Kit** (trees/rocks/plants) | **CC0 1.0** | `kenney.nl/assets/nature-kit` | 330+ low-poly, shared palette texture |

Backups: Quaternius "Animated Human" / Universal Animation Library (CC0, `quaternius.itch.io`),
Khronos RiggedFigure/RiggedSimple, Quaternius "Stylized Nature MegaKit" (CC0). **License compliance:
Fox is CC-BY (not CC0)** — preserve the credits string in an in-repo `CREDITS` file and ideally an
on-screen "about" credit. Prefer CC0 (Kenney/Quaternius) elsewhere to avoid attribution obligations.

> Decision: **start the skinned PoC on the Fox** (lowest poly, 3 clips), shipped **unlit**
> (vertex-color white + texture) since it has no normals. For richer humanoid demos, use
> the MIT Soldier asset and keep character lighting unlit unless normals are baked.

---

## 5. Shared JS SDK + authoring

New deterministic modules in `framework/src/`. **Add `anim`, `skin`, `material`, `light` to the
`detFiles` array in `contract.ts:94`** so the no-trig guard covers them. They use only
`+,-,*,/, Math.round/abs/sqrt` and `dsin/dcos/datan2` from `math.ts`.

### 5.1 `math.ts` additions

`math.ts` has `Mat4.multiply/compose/lookAt`, `Quat.fromEuler/fromAxisAngle/multiply`, but **no
`Mat4.invert` and no `Quat.slerp`**. We don't need invert (glTF ships `inverseBindMatrices`
precomputed). For animation, **use `nlerp`, not `slerp`** — `slerp` needs `acos`/`sin` (banned by the
TRIG guard). Add:

```ts
Vec3.lerp(a, b, t)                                   // a + (b-a)*t
Quat.nlerp(a, b, t)                                  // dot-sign flip for short arc, then normalize(lerp)
Mat4.fromArray(a: ArrayLike<number>, off=0)          // load a baked 16-float matrix
Mat4.mul3x4Into(out: Float32Array, off, m)           // extract the 12-float affine slice for the wire
```

nlerp is deterministic and visually fine for **dense** keyframes — the bake resamples clips to ≥ 24 fps
so nlerp error is negligible (the documented mitigation for the no-slerp constraint).

### 5.2 `anim.ts`

```ts
class AnimationClip { fps; frameCount; trs: Float32Array; jointCount; } // baked, [joint][frame] TRS
class AnimationPlayer {
  time = 0;
  advance(dt) { this.time += dt; }                        // caller loops: time % (frameCount/fps)
  sample(clip): Float32Array /* localTRS per joint */ {   // floor frame + nlerp/lerp to next
    // f = frac(time*fps); lerp pos/scale, Quat.nlerp rot; write into a PREALLOCATED buffer (no GC)
  }
}
```

### 5.3 `skin.ts`

```ts
class Skeleton {
  parents: Int32Array;                 // joint hierarchy (parent index, -1 = root)
  inverseBind: Float32Array;           // jointCount × 16
  computeBoneMatrices(localTRS, outWorld): void { /* parent-first: world[i] = world[parent]*local[i] */ }
}
class SkinnedMesh {
  batches: { handle, jointTable: Int32Array, weightCount }[];   // per bone batch
  skeleton: Skeleton; player: AnimationPlayer; clip; modelMatrix;
  // each frame: player.sample → skeleton.computeBoneMatrices → for each batch,
  //   bone_b = world[ jointTable[b] ] * inverseBind[ jointTable[b] ]   (≤8 of them)
  //   enc.drawSkinned(batch.handle, modelMatrix, bones3x4[], tint)
}
```

`Scene3D.emit()` detects a `SkinnedMesh` node and calls `enc.drawSkinned(...)` per batch (one
`OP_DRAW_SKINNED` each). The batched single-submit invariant (`engine.ts:82–87`) is preserved — **no
engine change needed.**

### 5.4 `material.ts` / `light.ts`

```ts
class Texture { w; h; psm; pixels: Uint8Array; handle(): number; /* lazy g3d.uploadTexture */ }
class Material { texture?: Texture; baseColor; }      // a UV/normal-bearing Mesh references one
class DirectionalLight { dir: Vec3; color; }          // Scene3D.lights: { ambient, lights[] }
```

`Scene3D.render` emits one `OP_SET_LIGHTS` (if any lights) and an `OP_BIND_TEXTURE` before each
textured draw (track current binding to avoid redundant binds).

### 5.5 Authoring — the walking-person game (`framework/games/walk3d.js`)

Plain `// @ts-check` JS, same shape as `cube3d.js`/`racing3d.js` (a `class extends Scene`):

```js
// @ts-check
import { start, Scene, Scene3D, SkinnedMesh, AnimationClip, Skeleton, Texture,
         Vec3, Quat, Btn } from '../src/index.js';
import FOX from '../src/assets-fox.js';

class Walk extends Scene {
  onEnter(ctx) {
    this.world = new Scene3D();
    const skin = SkinnedMesh.fromBaked(FOX);          // builds batches + skeleton + texture
    this.player = skin.play(FOX.clips.Walk);          // AnimationPlayer
    this.node = this.world.add({ mesh: skin, position: new Vec3(0, 0, 0) });
    this.heading = 0;
    ctx.engine.scene3d = this.world;
  }
  update(ctx) {
    const dt = ctx.dt;                                 // fixed 1/60
    if (ctx.input.held(Btn.LEFT))  this.heading += 90 * dt;
    if (ctx.input.held(Btn.RIGHT)) this.heading -= 90 * dt;
    const speed = ctx.input.held(Btn.CROSS) ? 2.2 : 0; // walk only when moving
    // advance the clip phase by the SAME rate as forward motion so feet don't slide
    this.player.advance(dt * (speed > 0 ? 1 : 0));
    this.node.position.x += dsin(this.heading) * speed * dt; // dsin from math.ts
    this.node.position.z += dcos(this.heading) * speed * dt;
    this.node.rotation = Quat.fromEuler(0, this.heading, 0);
    // chase camera in JS
    const eye = new Vec3(this.node.position.x - dsin(this.heading)*4,
                         2.5, this.node.position.z - dcos(this.heading)*4);
    this.world.camera.lookAt(eye, this.node.position, new Vec3(0,1,0));
  }
  draw(g) { g.text(4, 4, 'WALK  hold X to move, L/R turn'); } // 2D HUD only
}
start(new Walk());
```

All scene/animation/camera **logic is JS**; the GE skins. `SkinnedMesh.fromBaked` lazily uploads each
batch's vertex buffer (`g3d.uploadMesh`) and the texture (`g3d.uploadTexture`) on first frame.

---

## 6. The three scenes

### 6.1 Walking person — *proves HW skinning end-to-end*

- **Asset:** Fox (576 tris, 24 joints → ~3–4 bone batches; unlit + textured), with Soldier as
  the higher-detail humanoid demo asset.
- **Animated:** bone matrices only (Walk clip sampled in JS). **Static:** the mesh geometry (retained).
- **Camera:** JS chase-cam. **Logic:** heading from d-pad, forward speed tied to clip phase (no foot
  sliding), `(time % duration)` loop.
- **Budget:** ~576–4700 tris, 3–4 skinned draws, 1× 256² texture. **60 fps.**
- **Proves:** the weights-first vertex layout, `sceGuBoneMatrix` loading, bone-batch partitioning,
  and the whole JS-samples → GE-skins pipeline.

### 6.2 Car driving — *proves the texture path without skinning*

- **Asset:** Kenney Car Kit sedan body + 4 wheel meshes (CC0), one shared palette texture ≤ 256².
- **Animated:** model matrices — body pose from physics; wheels = child `Node3D`s spun by
  `Quat.fromAxisAngle(X, distance/radius)`, front wheels also steer about Y. **Static:** all geometry
  + road strip + instanced roadside props.
- **Camera:** JS chase-cam. **Logic:** reuse `racing3d.js` deterministic bicycle physics (x/z/heading
  /speed via `dsin/dcos`), extend with wheel roll.
- **Budget:** ~5–6 k tris, ~25–30 draws, 2–3 small textures. **60 fps.**
- **Proves:** `uploadTexture` + `OP_BIND_TEXTURE` + `FMT_UV`, parented transform animation, instancing.

### 6.3 Outdoor scene — *the hardware max-out*

- **Asset:** JS heightmap terrain (`MeshBuilder` grid, height via `dsin/dcos` noise) split into
  ~6×6 chunks for culling + 1× 256² ground texture; scatter ~40–80 instanced Kenney Nature Kit
  trees/rocks (CC0) from ~4 meshes (one upload, many model matrices).
- **Animated:** camera only (slow orbit/free-fly). **Static:** everything else.
- **Lit:** 1 directional sun (`FMT_NORMAL` + `sceGuLight`) + ambient. **Fog** (`sceGuFog`) to bound
  draw distance + overdraw; clear = sky color.
- **Camera:** JS free-fly. **Logic:** frustum-cull chunks + props (new `Scene3D` culling), distance LOD.
- **Budget:** ~10–12 k tris, ~60–90 draws after culling, ≤ ~1 MB textures resident. **30 fps.**
- **Proves:** HW lighting + normals, fog, frustum culling/LOD, and that the combined scene stays in
  the GE budget.

---

## 7. Determinism & testing

The byte-exact `.dc3d` draw-list golden is the **primary** correctness gate and needs **zero
rasterizer work** — the engine shares the same JS across hosts, so emitted bone-matrix/texture/draw
bytes are identical. Strategy (the minimal testable approach):

1. **`.dc3d` byte golden (primary):** `golden.ts` already records `uploadMesh` + every `submit` byte
   when `raster.used`. Skinned/textured scenes are validated by this *for free* — it captures the
   emitted bone matrices, model matrices, light records, and texture binds. This is deterministic
   because nlerp/lerp/`dsin`/`dcos` are bit-identical across QuickJS and the browser.
2. **Pixel golden (secondary, optional):** do **not** teach `raster3d.ts` HW skinning. Instead give
   `SkinnedMesh` a JS `bakePosed(poses) → Mesh` that **pre-skins** to a plain POS|COLOR mesh
   `raster3d` already renders; the harness snapshots a few fixed frames for a human-viewable image.
   Only add a UV/normal/nearest-sample path to `raster3d.ts` if textured pixel-accuracy is later
   required.
3. **Contract parity:** append every new constant to `contract.ts` `NAMES` **and** the `gfx3d.rs`
   comment block; add the four new SDK files to `detFiles`. Verify v1 cube/racing/fps goldens are
   **byte-identical** (no regression) before adding new ones.
4. **Per-scene specs:** add `walk3d`/`car3d`/`outdoor3d` to `golden.ts` SPECS with scripted input +
   frame counts (like `cube3d`/`racing3d`), locking determinism from day one.
5. **On-device:** run each milestone in **PPSSPP** (and real hardware where possible) to confirm the
   weights-first layout renders, > 4 bones behavior, the dropped 4th-column harmlessness, and
   texture/light correctness.

---

## 8. Phased roadmap (M0..M6)

Each milestone is independently verifiable on PPSSPP/hardware. Start with the **smallest end-to-end
slice**; skinning is sequenced **last** because it is the riskiest.

| M | Deliverable | Verify on PSP | Riskiest item + de-risking spike |
|---|---|---|---|
| **M0** | **Contract scaffolding.** Add `DC3D_VERSION=0x0002`, `FMT_WEIGHTS`, the 3 opcodes (constants only) to `g3d.ts` + `gfx3d.rs` comment block + `contract.ts` NAMES; add SDK files to `detFiles`. No behavior change. | v1 goldens **byte-identical**; contract test PASS. | *None* — pure parity. De-risks CI lockstep before any code. |
| **M1** | **Textured + lit STATIC mesh.** `uploadTexture` + `OP_BIND_TEXTURE` + `FMT_UV`; then `OP_SET_LIGHTS` + `FMT_NORMAL`. Stride-aware `MeshEntry`; relax upload guard. Bake one Kenney mesh (CC0) with its palette texture. | A textured, lit cube/prop renders in PPSSPP; `.dc3d` golden captured. | **GE vertex order** — spike: hand-build one `[uv][color][normal][pos]` mesh and confirm it renders before wiring the bake. |
| **M2** | **Bake pipeline.** `bake-gltf.ts` with `@gltf-transform/core` + `upng-js`; emit `assets-fox.ts`/`assets-kenney-*.ts`; texture downsample + PSM pack; clip resample. | Baked Kenney car body renders textured. | **glTF→bake fidelity** — spike: round-trip one mesh, diff vertex/UV/index counts vs `@gltf-transform` ground truth (already verified Fox = 576 tris). |
| **M3** | **Car scene (`car3d.js`).** Rigid body + 4 spun/steered wheels + road + instanced props; chase-cam; `racing3d` physics. | 60 fps; `.dc3d` + pixel goldens. | Texture VRAM budget — keep ≤ 256², 16-bit; monitor free VRAM. |
| **M4** | **HW skinning core.** `OP_DRAW_SKINNED` + `sceGuBoneMatrix` path + `WEIGHTS4|WEIGHT_32BITF` vtype; `skin.ts`/`anim.ts`; bake Fox with **bone-batch partitioning (≤4 bones/batch)**. | A **single static-pose** skinned Fox renders correctly in PPSSPP. | **PSP HW skinning vertex layout + bone-matrix loading** (the #1 risk). Spike: one ≤4-bone batch, one frame, verify weights-first layout + 3×4 bone load + dropped-w-column before adding animation. |
| **M5** | **Walking person (`walk3d.js`).** `AnimationPlayer` + nlerp; clip phase tied to motion; chase-cam. Try 5–8 bones/batch on PPSSPP. | Fox walks at 30→60 fps; goldens. | The "first-4-of-8 matrices" caveat — validate 5–8 bones on PPSSPP; fall back to ≤4 if flaky. |
| **M6** | **Outdoor scene (`outdoor3d.js`).** Heightmap terrain + chunked frustum culling/LOD in `Scene3D` + instanced Nature Kit + directional light + fog. | ≥ 30 fps stable; max-out validated. | Combined tri/fill budget — use fog + culling + LOD; profile draws ≤ 100, tris ≤ 12 k. |

Web/3DS/Android host parity work runs **in parallel** behind each milestone (records are skippable,
so PSP can lead). The `.dc3d` golden gates cross-host correctness regardless of which hosts render.

---

## 9. Open questions & risks

**Hard risks (ranked):**

1. **No bone palette → bake-time partitioning is mandatory.** Any rig > 8 joints (Fox 24,
   Soldier 49) MUST be split into ≤ 8-bone batches with locally-remapped weights, or the GE draws
   garbage. This is non-trivial bake logic and the single biggest schedule risk. *Mitigation:* the
   M4 spike validates one ≤ 4-bone batch first; partition **by triangle**.
2. **GE vertex order vs wire bit order.** Interleaving in FMT-bit order instead of GE order
   (`[weights][uv][color][normal][pos]`) yields silent visual corruption (the GE reads raw RAM, no
   error). *Mitigation:* loud invariant doc in `g3d.ts`; bake + host co-designed; M1 spike.
3. **`sceGuBoneMatrix` is 3×4 (12 floats), w-row dropped.** Reusing the full 4×4 `read_matrix`
   naively would silently truncate a non-affine row. glTF joints are affine so it's fine, but the
   host must use the 3×4 slice and the bake must never bake projection into a bone.
4. **VRAM is ~70% full** (~1.39 MB of 2 MB). A couple of 256² PSM8888 textures overflow. *Mitigation:*
   16-bit/CLUT/DXT or main-RAM textures; consider PSM5650 framebuffers (`main.rs:128–134`) if more
   texture VRAM is needed.
5. **Non-indexed expansion inflates RAM** (~3–6× verts × larger stride). A 5 k-tri skinned mesh ≈
   15 k verts × 40 B ≈ 600 KB. *Mitigation:* watch the qjs heap; consider adding a true
   `INDEX_16BIT` indexed draw path (rust-psp supports it) for the larger scenes.
6. **Determinism guard coverage.** Any `Math.sin/cos/pow/exp` (e.g. an easing curve, `slerp`, or a
   `hypot` normalize) sneaking into the new SDK files breaks the cross-host `.dc3d` golden. The four
   files MUST be in `detFiles`; use only `dsin/dcos` + nlerp.
7. **Lit + textured + vertex-colored material composition** (`sceGuTexFunc Modulate` × diffuse ×
   `sceGuColorMaterial`) is finicky and may drift from `raster3d.ts`. *Mitigation:* pin the material
   model early; keep the pixel golden secondary (the `.dc3d` byte golden is the real gate).

**Open questions (resolve on-device):**

- Does the GE reliably use **5–8 bone matrices** in our draw mode, or only the first 4? (PPSSPP +
  hardware check in M5.) Baseline ≤ 4 until confirmed.
- Is `WEIGHT_8BIT` (4 B weights, smaller vertices) worth the precision loss for these clips, vs
  `WEIGHT_32BITF`? (Try after M5 lands with 32-bit.)
- Should terrain switch to **indexed** draws to cut RAM, or stay chunked + non-indexed?
- For lit characters, should normals be computed at bake time, or should character demos stay unlit?
- 60 fps for the combined 3-scene stress test under skinning+lighting+texturing may be fill-rate
  bound — treat 30 fps as primary, 60 fps as the max-out experiment.
