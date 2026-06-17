// The optional native 3D contract, sitting alongside the 2D `gfx` (see host.ts).
// Every platform that supports 3D installs a global `g3d`; 2D-only hosts leave it
// undefined and the framework simply skips the 3D pass. The whole surface is three
// methods — geometry is uploaded once (retained, returns a handle), and exactly one
// batched command buffer crosses the boundary per frame (see g3d.ts for the format).
export interface RawG3d {
  /**
   * Upload a mesh ONCE. The host COPIES the bytes (never retains the QuickJS
   * pointer) and returns a small int handle. `vertices` is interleaved per
   * `format`; `indices` is a Uint16Array buffer or null for non-indexed. A host
   * MAY draw indexed or expand to a flat non-indexed buffer (the PSP does the
   * latter for VFPU 16-byte alignment) — the resulting image must be identical.
   * `weightCount` is the number of f32 bone weights per vertex when the format
   * has FMT_WEIGHTS (skinned meshes); 0 otherwise. It is needed to compute the
   * vertex stride and the GE WEIGHTSn vertex-type bits.
   */
  uploadMesh(
    vertices: ArrayBuffer,
    indices: ArrayBuffer | null,
    format: number,
    weightCount?: number,
  ): number;
  /**
   * Upload a texture ONCE (retained, returns a small int handle), mirroring
   * uploadMesh. `pixels` is tightly-packed image data in pixel format `psm`
   * (one of the PSM_* values in g3d.ts); `w`/`h` must be powers of two ≤ 512.
   * The host COPIES the bytes (16-byte aligned for the GE) and never retains the
   * QuickJS pointer. Optional: 2D-only or texture-less hosts may omit it.
   */
  uploadTexture?(pixels: ArrayBuffer, w: number, h: number, psm: number): number;
  /** Release native storage (optional; many games never call it). */
  freeMesh(handle: number): void;
  /**
   * THE per-frame call. One little-endian command/draw-list buffer. The host
   * clears depth, runs the 3D pass (depth ON, reversed-Z, NO cull on any host —
   * occlusion is depth-only), then leaves depth OFF so the subsequent
   * gfx.fillRect HUD draws on top. Called once per frame, BEFORE any fillRect.
   */
  submit(buffer: ArrayBuffer, byteLength: number): void;

  // ── Optional retained native scene ──────────────────────────────────────────
  // For ALL-STATIC scenes (terrain, scenery), a host MAY accept the scene once and
  // do the per-frame frustum cull + draw natively, so JS only sends the camera —
  // moving the per-node math off the interpreted core (a big PSP win). Hosts that
  // omit these fall back to the per-frame `submit` path (identical pixels). All four
  // must be present together.
  /** Drop all retained static instances + env (start a rebuild). */
  sceneClear?(): void;
  /**
   * Append one static instance. `geom` is 22 f32: 16 model (column-major) + 3
   * aabbMin + 3 aabbMax (world space). `tex` is a texture handle or -1.
   */
  sceneAdd?(handle: number, tex: number, tint: number, geom: ArrayBuffer): void;
  /**
   * Set scene lighting + fog. `env` layout: u32 lightCount, u32 ambientABGR,
   * count×{u32 colorABGR, 3 f32 dir}, u32 fogColorABGR (0xffffffff = no fog),
   * f32 near, f32 far. Pass null to clear.
   */
  sceneSetEnv?(env: ArrayBuffer | null): void;
  /**
   * THE per-frame retained-scene call. `camera` is 20 f32: 16 viewProj
   * (column-major) + 3 eye + 1 cull-far. Clears, culls + draws every instance.
   * Returns the number of instances actually drawn (visible after culling).
   */
  sceneRender?(camera: ArrayBuffer): number;
}

declare global {
  // eslint-disable-next-line no-var
  var g3d: RawG3d | undefined;
}

/** True when the host provides the 3D contract. */
export function hasG3d(): boolean {
  return typeof globalThis.g3d !== 'undefined' && globalThis.g3d !== null;
}

/** True when the host implements the optional retained native scene API. */
export function hasNativeScene(): boolean {
  return hasG3d() && typeof globalThis.g3d!.sceneRender === 'function';
}
