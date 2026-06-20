// @ts-check
// @title BSP Compare
// @order 19
// @controls (none — static ground-truth pose)
// bsp-compare.js — a STATIC, deterministic render of a baked BSP map for the
// WebGL-vs-PPSSPP-vs-software ground-truth harness (framework/test/bsp-compare/).
// No input, no animation, no soldier, no FPS HUD, no camera-follow: a single fixed
// camera pose so the frame is byte-stable across runs and (via the shared dsin/dcos
// trig) near-identical across hosts. The only per-host differences left are GPU
// texture filtering / wrap / AA — exactly what the diff harness is meant to surface.
//
// Map via globalThis.__BSP_MAP (default 'box', the committed CC0 fixture). Other maps
// are gitignored (copyrighted) and used for manual checks only.
import {
  start, Scene, Scene3D, Node3D, Material, Texture, meshFromBaked, Vec3, dsin, dcos,
} from '../src/index';
import { BSP_BOX } from '../src/assets-bsp-box';

/** @import { UpdateContext } from '../src/index' */

// Map registry — box is committed; any others are resolved lazily and stay gitignored.
const MAPS = { box: BSP_BOX };
const active = /** @type {any} */ (globalThis).__BSP_MAP || 'box';
const BSP = /** @type {any} */ (MAPS)[active] || BSP_BOX;

class CompareScene extends Scene {
  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    const world = new Scene3D();
    const farFog = Math.max(60, BSP.span * 2.2);
    world.camera.setPerspective(64, 480 / 272, 0.08, farFog * 4);
    world.fog = { color: BSP.skyColor, near: farFog * 0.6, far: farFog };

    // One Material per baked texture; sub-meshes are pre-sorted by texId.
    const mats = BSP.textures.map((/** @type {any} */ t) => new Material({ texture: new Texture(t.pixels, t.width, t.height, t.psm) }));
    for (const m of BSP.meshes()) {
      const node = new Node3D({ mesh: meshFromBaked(m), material: m.texId >= 0 ? mats[m.texId] : undefined, isStatic: true });
      node.bounds = { min: m.aabb.min, max: m.aabb.max };
      world.add(node);
    }

    // Fixed camera at the spawn pose (deterministic via dsin/dcos).
    const sx = BSP.spawn[0], sz = BSP.spawn[1], h = BSP.spawn[2], fy = BSP.floorY;
    const fwdX = dsin(h), fwdZ = dcos(h);
    const dist = Math.min(8.5, Math.max(3.5, BSP.span * 0.9));
    world.camera.lookAt(
      new Vec3(sx - fwdX * dist, fy + 2.4, sz - fwdZ * dist),
      new Vec3(sx + fwdX * 2.0, fy + 1.4, sz + fwdZ * 2.0),
      new Vec3(0, 1, 0),
    );
    ctx.engine.scene3d = world;
  }

  // No update() — the scene is static; every frame emits the identical submit packet.
}

start(() => new CompareScene());
