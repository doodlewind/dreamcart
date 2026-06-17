// Hardware-skinning runtime (deterministic — in contract.ts's detFiles guard).
// JS samples the animation, walks the joint hierarchy, and ships ≤8 final 3×4
// bone matrices per bone-batch over the wire; the PSP GE skins in hardware
// (sceGuBoneMatrix + WEIGHTSn). The GE has no bone-index palette, so the mesh was
// partitioned at bake time into batches each ≤ boneLimit joints (see bake-gltf.ts
// / docs/psp-advanced-3d.md). Per frame, for batch b: bone[slot] =
// jointWorld[ jointTable[slot] ] · inverseBind[ jointTable[slot] ].
import { Mat4, Quat, Vec3 } from './math';
import { Mesh, meshFromBaked } from './mesh';
import { Texture } from './material';
import { AnimationPlayer, poseFromClip } from './anim';
import { PSM_8888 } from './g3d';
import type { BakedClip } from './anim';
import type { BakedMesh } from './mesh';
import type { CommandEncoder } from './g3d';

interface BakedBatch {
  jointTable: number[];
  boneCount: number;
  mesh: BakedMesh;
}

/** The shape of a baked skinned character (assets-fox.ts FOX). */
export interface BakedSkin {
  scale: number;
  jointCount: number;
  jointParents: Int8Array;
  inverseBindMatrices: Float32Array; // jointCount*16
  bind: { t: Float32Array; r: Float32Array; s: Float32Array };
  boneLimit: number;
  batches: BakedBatch[];
  clips: Record<string, BakedClip>;
  texture: { width: number; height: number; psm: number; pixels: Uint8Array };
}

/** Joint hierarchy + inverse-bind matrices; turns local TRS into bone matrices. */
export class Skeleton {
  parents: Int8Array;
  inverseBind: Float32Array;
  jointCount: number;
  // scratch world matrices (one length-16 array per joint), reused each frame.
  private world: number[][];

  constructor(parents: Int8Array, inverseBind: Float32Array) {
    this.parents = parents;
    this.inverseBind = inverseBind;
    this.jointCount = parents.length;
    this.world = [];
    for (let i = 0; i < this.jointCount; i++) this.world.push(Mat4.identity());
  }

  /**
   * Compose each joint's local matrix from its sampled TRS, then accumulate world
   * matrices parent-first (joints are stored parent-before-child in glTF, so a
   * single forward pass is valid).
   */
  computeWorld(outT: Float32Array, outR: Float32Array, outS: Float32Array): void {
    for (let i = 0; i < this.jointCount; i++) {
      const local = Mat4.compose(
        new Vec3(outT[i * 3], outT[i * 3 + 1], outT[i * 3 + 2]),
        new Quat(outR[i * 4], outR[i * 4 + 1], outR[i * 4 + 2], outR[i * 4 + 3]),
        new Vec3(outS[i * 3], outS[i * 3 + 1], outS[i * 3 + 2]),
      );
      const p = this.parents[i];
      this.world[i] = p < 0 ? local : Mat4.multiply(this.world[p], local);
    }
  }

  /**
   * Write a batch's bone matrices (3×4 affine, GE order) into `out` for the wire:
   * bone[slot] = world[jointTable[slot]] · inverseBind[jointTable[slot]].
   */
  batchBones(jointTable: number[], boneCount: number, out: Float32Array): void {
    for (let slot = 0; slot < boneCount; slot++) {
      const g = jointTable[slot];
      const m = Mat4.multiply(this.world[g], Mat4.fromArray(this.inverseBind, g * 16));
      Mat4.affine3x4Into(out, slot * 12, m);
    }
  }
}

/**
 * A skinned character: per-batch uploadable meshes + a Skeleton + an optional
 * AnimationPlayer + a shared texture. Scene3D draws it by sampling the player,
 * computing world matrices once, then emitting one OP_DRAW_SKINNED per batch.
 */
export class SkinnedMesh {
  skeleton: Skeleton;
  batches: { mesh: Mesh; jointTable: number[]; boneCount: number; bones: Float32Array }[];
  texture: Texture;
  player: AnimationPlayer;
  scale: number;
  clips: Record<string, BakedClip>;
  jointCount: number;

  private constructor(skin: BakedSkin) {
    this.scale = skin.scale;
    this.clips = skin.clips;
    this.jointCount = skin.jointCount;
    this.skeleton = new Skeleton(skin.jointParents, skin.inverseBindMatrices);
    this.texture = new Texture(skin.texture.pixels, skin.texture.width, skin.texture.height, skin.texture.psm ?? PSM_8888);
    this.batches = skin.batches.map((b) => ({
      mesh: meshFromBaked(b.mesh),
      jointTable: b.jointTable,
      boneCount: b.boneCount,
      bones: new Float32Array(b.boneCount * 12),
    }));
    // Default to the bind pose via the first clip frozen at t=0; play() overrides.
    const first = Object.values(skin.clips)[0];
    this.player = poseFromClip(first, skin.jointCount, 0);
  }

  static fromBaked(skin: BakedSkin): SkinnedMesh {
    return new SkinnedMesh(skin);
  }

  /** Start (or switch to) a clip; returns the player so the game can advance it. */
  play(clip: BakedClip): AnimationPlayer {
    this.player = new AnimationPlayer(clip, this.jointCount);
    return this.player;
  }

  /**
   * Sample the current pose and emit one OP_DRAW_SKINNED per batch. `model` is the
   * character placement (its node world matrix, including the asset scale). Called
   * by Scene3D after it has bound this mesh's texture.
   */
  emit(enc: CommandEncoder, model: number[], tint: number): void {
    this.player.sample();
    this.skeleton.computeWorld(this.player.outT, this.player.outR, this.player.outS);
    for (const b of this.batches) {
      const h = b.mesh.handle();
      if (h < 0) continue;
      this.skeleton.batchBones(b.jointTable, b.boneCount, b.bones);
      enc.drawSkinned(h, model, b.bones, b.boneCount, tint);
    }
  }
}
