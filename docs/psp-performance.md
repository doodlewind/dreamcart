# PSP performance: how we took the 3D scenes from single-digit to 60 FPS

This is the field guide to making the DreamCart PSP runtime fast. It is written
from the actual debugging session that took the advanced-3D demos from 2–6 FPS to
30–60 FPS, including the wrong turns — because the wrong turns are the lesson.

## TL;DR — the ranked wins

| # | Fix | Effect | Scope |
|---|---|---|---|
| 1 | **O(1) arena allocator** (was O(free-holes)) | car3d 15→60, outdoor 30→60 | EVERY game |
| 2 | **Retained native scene** (cull + draw in Rust) | outdoor 4→20, car3d 2→7 | static/mixed scenes |
| 3 | **Native skinning** (bone math in Rust) | Fox 6→20 | skinned characters |
| 4 | **Allocation-free hot math** (inline quat→matrix) | Fox 20→30 | skinning sample/compose |
| 5 | **Native text** (`gfx.drawText`) | HUD-heavy 15→30 | all 2D text |
| 6 | **`mergeMeshes`** (one draw for static scenery) | car3d draws 35→6 | instanced scenery |
| 7 | **Native animation sampler** (lerp/nlerp in Rust) | Fox **30→60** | animated skinned characters |

The allocator (#1) is the headline: it silently capped *every* game and masked
everything else. Find it first.

## The first rule: profile, never guess

PPSSPP on this hardware (**Apple M3 Max, 16 cores, Vulkan, MIPS JIT**) runs
commercial 50k-tri PSP games at hundreds of percent. So if a trivial 6-draw scene
runs at 15 FPS, that is **a real bug in the guest**, not "host load," not "the
emulator." Saying "host load" once cost a round of trust and a day of motion — do
not do it. Two corollaries:

- **The emulator's CPU is fast** (JIT → ARM64 on a 4 GHz P-core, ~10× a real 333 MHz
  PSP). So guest CPU cost that's painful on PPSSPP is *catastrophic* on real
  hardware. Conversely, a GE/fill cost that hurts on PPSSPP may be fine on the real
  GE. Don't conflate the two.
- **PPSSPP's absolute FPS is noisy** (host scheduling), but the *deltas* and the
  *deterministic draw count* are trustworthy. Trust those, not a single number.

### The on-device profiler

You cannot `log()` a profile — the 3D pass clears the framebuffer and erases the
debug overlay. So measure with `now()` (a host binding returning
`sceKernelGetSystemTimeWide` µs) and render the result as 2D HUD text:

```js
// engine.ts tick(): accumulate µs per phase, average over 60 frames into engine.prof
const ta = now(); sc.updateTree(ctx);
const tb = now(); this.scene3d?.render(enc);
const tc = now(); sc.drawTree(g);
const td = now(); // prof = [tb-ta, tc-tb, td-tc]
```

A game then draws `engine.prof`. This `upd / r3d / r2d` split is what localized
every bottleneck below. (See the `psp-emulator-debug` skill for driving PPSSPP and
reading the HUD via screenshots.)

## #1 — The allocator was O(free-holes), and QuickJS thrashes it

**Symptom.** car3d: `upd=25.6ms / r3d=33.6ms` for a few dozen `Mat4`/`Quat` ops.
That's **~1 ms per matrix operation** — impossible as compute, so it's allocation.

**Cause.** `runtime/src/arena.rs` was added to fix a crash (rust-psp allocates one
*kernel object* per allocation and QuickJS exhausts the kernel's object cap — see
`psp-memory-constraints`). The first arena used `linked_list_allocator`, whose
`allocate_first_fit`/`deallocate` are **O(number of free holes)**. QuickJS makes
thousands of small alloc/free per frame (every array, object, temporary, string),
and on a fragmented heap each one walks a long free list → ~1 ms each.

**Proof.** Swap in a bump allocator (O(1), leaks): car3d 15 → **60 FPS**, every
phase 5–8× faster. That isolates the allocator beyond doubt.

**Fix.** A **segregated power-of-two size-class free list** (`arena.rs`): `alloc`/
`free` pop/push a per-class list (O(1)), carving a fresh block from a bump pointer
when a class is empty; blocks recycle within their class, so a steady per-frame
workload stops growing the bump and runs entirely from the free lists. No external
crate. car3d 15→60, outdoor 30→60.

**Lesson.** When you must add an allocator under QuickJS, its per-op complexity is
load-bearing. O(n) anything in the allocator is death by a thousand frames.

## #2–#4 — Move the mechanical per-element math to native

The refined boundary for "logic in JS, render in native": **per-node frustum cull,
world-matrix composition, draw-command encoding, glyph rasterization, and bone math
are rendering *plumbing*, not game logic.** They are mechanical loops over elements
— exactly what the interpreted QuickJS core (still ~1000× slower than V8 even under
the JIT) is worst at, and exactly what Rust does for free. JS keeps only the macro
logic: where is the camera, what moved, what time is the clip at.

- **Retained native scene** (`docs/psp-native-scene.md`, `gfx3d.rs`
  `sceneAdd`/`sceneRender`): upload an all-static (or mixed: static + per-frame
  rigid-dynamic) scene once; per frame JS sends only the camera (+ a handful of
  dynamic matrices) and native frustum-culls + draws the list.
- **Native skinning** (`gfx3d.rs` `uploadSkin` + `OP_DRAW_SKIN`): retain the joint
  hierarchy + inverse-bind matrices + bone-batch tables; per frame JS ships only
  the per-joint *local* matrices and native walks the hierarchy → world →
  `bone = world·inverseBind` → `sceGuBoneMatrix` → draw. Fox skinning 145ms → 32ms.
- **Native text** (`gfx.uploadFont` + `gfx.drawText`): the glyph rasterization loop
  (one fill-run per pixel-row-run, hundreds of iterations/frame) moves to Rust as
  one batched sprite draw.

All three are **optional host capabilities**: `raster3d` (the golden oracle), Web,
and 3DS don't implement them, so `Scene3D`/`SkinnedMesh`/`graphics.text` fall back
to the JS command-buffer path. The byte-exact `.dc3d` and pixel goldens stay the
cross-host oracle and are **unchanged** — the native path must produce the same
image (verify on device). Add the constant to the contract `NAMES` + every wired
host's decl, as always.

## #4b — When math must stay in JS, make it allocation-free

After the allocator fix, the *remaining* JS skinning cost was that the math API
allocates: `Mat4.compose` builds ~4 objects per joint, `Quat.nlerp` two quats + a
result. For a per-frame, per-joint hot loop, inline it — write the quaternion→matrix
and the nlerp **straight into a reused typed array, zero object allocations**. Keep
the inlined arithmetic byte-identical (same f64 ops, same order) so the JS-fallback
golden still passes. Fox 32ms → 16ms (20 → 30 FPS).

## #7 — When allocation-free *still* isn't enough, move the loop itself native

Even after #4b made the sampler zero-allocation, walk3d/skin3d capped at **30 FPS**.
The `engine.prof` HUD said `r3d = 16.4 ms` — the whole frame budget. So I split
`r3d` one level finer (temporary `now()` calls around the emit vs the native
`submit`, and around `sample()`+`composeLocals()` vs the `drawSkin` encode):

```
r3d 16418   emit 15587   submit 298      <- native submit is basically free
            sample 12136   drawSkin 504   <- the sampler is the entire wall
```

**12 ms is the per-joint sampler** — `player.sample()` (lerp T/S + nlerp R) plus
`composeLocals()` (quat→matrix) for **24 joints**. That's ~505 µs *per joint* for
~60 float ops. It isn't arithmetic cost; it's QuickJS's per-access overhead on
`Float32Array` reads/writes, ~1400 of them per frame, interpreted on a 333 MHz core.
**There is no JS-side fix** — the math is already inlined and allocation-free; the
cost is the interpreter touching typed arrays at all.

So move the loop itself. `g3d.uploadClip(buffer)` retains a baked clip (the flat
T/R/S frame tables) once; the new `OP_DRAW_SKIN_ANIM` record ships only the **clip
phase** (one float). Native samples the two bracketing frames (lerp/nlerp), composes
the per-joint local matrices, then runs the **same** hierarchy → bone → draw as
`OP_DRAW_SKIN`. Per frame, QuickJS now does essentially nothing for the character:
no sampler, no 24×16 matrix upload — just `enc.drawSkinAnim(skin, clip, model,
phase, tint)`. Result: `r3d 16.4 → 4.5 ms`, **30 → 60 FPS** on both walk3d and skin3d.

**The boundary, refined again.** Is sampling a clip "animation logic" (JS) or
"plumbing" (native)? Split it where the *decision* is: **which** clip plays, the
phase/time, blend choices, locomotion-tied playback rate — that stays in JS
(`SkinnedMesh.play`, `AnimationPlayer.advance`, the game's `update`). The mechanical
interpolation *between two baked frames given a phase* is plumbing, exactly like the
bone math in #3 — it moves native. JS still owns every animation *decision*; native
just does the per-element number-crunching the interpreter is too slow for.

One subtlety: native has no `libm`, and nlerp needs a normalize. Rather than pull in
a dependency or an intrinsic, the sampler uses a self-contained fast reciprocal
sqrt (two Newton iterations, ~1e-4 error). `OP_DRAW_SKIN_ANIM` is a PSP-only fast
path — it never faces the byte-exact golden oracle (raster3d/Web/3DS have no
`uploadClip`, so they fall back to the JS sampler + `OP_DRAW_SKIN`/`OP_DRAW_SKINNED`)
— so it need only match *visually*, not bit-for-bit, with `anim.ts`. Verify on device.

## #6 — Fewer, bigger draws beat many small ones

The per-draw GE cost dominates once the JS is cheap. `mergeMeshes(parts)` bakes many
meshes (each at a world transform) into ONE static POS|COLOR mesh — real PSP T&L
eats the merged vertex count for free, and one `sceGumDrawArray` replaces dozens.
car3d's entire static scene (ground + road + ~32 props) became one draw (35 → 6
draws/frame). Distance fog as a cull-far plane also trims far instances.

Note the **resolution** caveat: `InternalResolution` in `ppsspp.ini` upscales
rendering (2× = 4× fill). Test at `1` (native 480×272) for the real-hardware fill
cost — but here 1× == 2×, confirming car3d was *not* fill-bound (it was draws +,
underneath everything, the allocator).

## Checklist for the next slow scene

1. **Profile** with the `engine.prof` HUD. Localize to `upd` / `r3d` / `r2d`.
2. If a phase is huge for trivial work → **suspect allocation**. Bump-allocator test
   confirms it in one build.
3. Mechanical per-element loops (cull, transform, encode, rasterize, skin) →
   **move native** (optional capability + JS fallback + unchanged golden).
4. Hot JS that must stay → **allocation-free** (reuse typed arrays, inline the math).
5. Many draws → **merge** static geometry; **cull** (frustum + fog-far).
6. Re-measure deltas + draw count; absolute PPSSPP FPS is noisy. Verify on hardware.
