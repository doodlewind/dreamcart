// @ts-check
// @title Skin 3D
// @order 13
// @controls auto-orbit camera (static pose)
// skin3d.js — the M4 milestone: a single STATIC-POSE hardware-skinned Fox. Proves
// the whole HW-skinning pipeline (weights-first vertex layout, bone-batch
// partitioning, sceGuBoneMatrix 3×4 load) WITHOUT animation: JS freezes the Walk
// clip at one frame, composes the joint hierarchy -> ≤4 bone matrices per batch,
// and the PSP GE skins in hardware. M5 adds AnimationPlayer + locomotion.
//
// Fox: CC-BY-4.0 — model PixelMannen (CC0), rig/anim tomkranis, glTF Asobo/scurest.
import {
  start, Scene, Scene3D, SkinnedMesh, poseFromClip,
  Vec3, Colors, dsin, dcos,
} from '../src/index';
import { FOX } from '../src/assets-fox';

/** @import { UpdateContext, Graphics } from '../src/index' */

class SkinScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  cx = 0;
  cy = 0;
  cz = 0;
  radius = 2;
  t = 0;

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    this.world.camera.setPerspective(55, 480 / 272, 0.05, 100);

    const skin = SkinnedMesh.fromBaked(FOX);
    // Static pose: freeze the Walk clip mid-stride (non-bind -> proves real
    // deformation, not just identity bones).
    skin.player = poseFromClip(FOX.clips.Walk, FOX.jointCount, 6);
    this.world.add({ skinned: skin, scale: new Vec3(FOX.scale, FOX.scale, FOX.scale) });

    // Auto-frame from the combined (scaled) bind AABB.
    const mn = [1e9, 1e9, 1e9];
    const mx = [-1e9, -1e9, -1e9];
    for (const b of FOX.batches) {
      const a = b.mesh.aabb;
      for (let k = 0; k < 3; k++) {
        if (a.min[k] < mn[k]) mn[k] = a.min[k];
        if (a.max[k] > mx[k]) mx[k] = a.max[k];
      }
    }
    const s = FOX.scale;
    this.cx = ((mn[0] + mx[0]) / 2) * s;
    this.cy = ((mn[1] + mx[1]) / 2) * s;
    this.cz = ((mn[2] + mx[2]) / 2) * s;
    this.radius = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * s;

    ctx.engine.scene3d = this.world;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    // Slow orbit so the static pose reads as 3D.
    this.t += ctx.dt * 0.5;
    const d = this.radius * 1.6;
    const center = new Vec3(this.cx, this.cy, this.cz);
    const eye = new Vec3(this.cx + dsin(this.t) * d, this.cy + this.radius * 0.4, this.cz + dcos(this.t) * d);
    this.world.camera.lookAt(eye, center, new Vec3(0, 1, 0));
  }

  /** @param {Graphics} g */
  draw(g) {
    g.text('SKIN 3D (static pose)', 8, 8, Colors.white, 1);
    g.text('Fox (c) tomkranis/Asobo/scurest CC-BY', 8, 256, Colors.cyan, 1);
  }
}

start(() => new SkinScene());
