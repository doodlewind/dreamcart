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
   */
  uploadMesh(vertices: ArrayBuffer, indices: ArrayBuffer | null, format: number): number;
  /** Release native storage (optional; many games never call it). */
  freeMesh(handle: number): void;
  /**
   * THE per-frame call. One little-endian command/draw-list buffer. The host
   * clears depth, runs the 3D pass (depth ON, reversed-Z, NO cull on any host —
   * occlusion is depth-only), then leaves depth OFF so the subsequent
   * gfx.fillRect HUD draws on top. Called once per frame, BEFORE any fillRect.
   */
  submit(buffer: ArrayBuffer, byteLength: number): void;
}

declare global {
  // eslint-disable-next-line no-var
  var g3d: RawG3d | undefined;
}

/** True when the host provides the 3D contract. */
export function hasG3d(): boolean {
  return typeof globalThis.g3d !== 'undefined' && globalThis.g3d !== null;
}
