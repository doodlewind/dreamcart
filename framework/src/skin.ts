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

  // Native-skin state: handle into the host's retained skin table (-2 = untried,
  // -1 = unavailable/failed -> use the JS fallback).
  private skinHandle = -2;
  // Native-sampler state: each clip uploaded once -> its host clip handle (cached
  // here; -1 caches an upload failure so we fall back to the JS sampler for it).
  private clipHandles = new Map<BakedClip, number>();

  /**
   * Sample the current pose and draw the character. On a host with BOTH
   * `uploadSkin` and `uploadClip`, the clip sampling + hierarchy + bone math +
   * draws all run NATIVELY (JS ships only the clip phase); otherwise it falls
   * back to computing bones in JS and emitting one OP_DRAW_SKINNED per batch.
   * `model` is the character placement (node world matrix incl. the asset scale).
   */
  emit(enc: CommandEncoder, model: number[], tint: number): void {
    const g = globalThis.g3d;
    // Fully-native path (PSP): retain the skeleton + clip once, then per frame
    // ship only the clip phase — native samples, composes, skins and draws.
    // Needs BOTH uploadSkin (skeleton retain) and uploadClip (native sampler).
    if (g && g.uploadSkin && g.uploadClip) {
      if (this.skinHandle === -2) this.skinHandle = this.uploadNativeSkin(g);
      if (this.skinHandle >= 0) {
        const ch = this.clipHandleFor(g, this.player.clip);
        if (ch >= 0) {
          const d = this.player.duration;
          const phase = d > 0 ? this.player.time / d : 0;
          enc.drawSkinAnim(this.skinHandle, ch, model, phase, tint);
          return;
        }
      }
    }
    // JS fallback: compute world + bones here, one OP_DRAW_SKINNED per batch.
    this.player.sample();
    this.skeleton.computeWorld(this.player.outT, this.player.outR, this.player.outS);
    for (const b of this.batches) {
      const h = b.mesh.handle();
      if (h < 0) continue;
      this.skeleton.batchBones(b.jointTable, b.boneCount, b.bones);
      enc.drawSkinned(h, model, b.bones, b.boneCount, tint);
    }
  }

  // Upload the skeleton + bone-batch tables to the native skin once; returns the
  // host skin handle (-1 if a mesh upload failed). Buffer layout mirrors
  // gfx3d.rs js_g3d_upload_skin / host3d.ts uploadSkin.
  private uploadNativeSkin(g: NonNullable<typeof globalThis.g3d>): number {
    const jc = this.jointCount;
    const parents = this.skeleton.parents;
    const ibm = this.skeleton.inverseBind;
    const nb = this.batches.length;
    // size = jointCount + jc*parents + jc*16 ibm + batchCount + nb*(2 + 8)
    const ints = 1 + jc + jc * 16 + 1 + nb * 10;
    const buf = new ArrayBuffer(ints * 4);
    const dv = new DataView(buf);
    let o = 0;
    dv.setUint32(o, jc, true); o += 4;
    for (let i = 0; i < jc; i++) { dv.setInt32(o, parents[i], true); o += 4; }
    for (let i = 0; i < jc * 16; i++) { dv.setFloat32(o, ibm[i], true); o += 4; }
    dv.setUint32(o, nb, true); o += 4;
    for (const b of this.batches) {
      const h = b.mesh.handle();
      if (h < 0) return -1;
      dv.setInt32(o, h, true); o += 4;
      dv.setInt32(o, b.boneCount, true); o += 4;
      for (let k = 0; k < 8; k++) { dv.setInt32(o, k < b.jointTable.length ? b.jointTable[k] : 0, true); o += 4; }
    }
    return g.uploadSkin!(buf);
  }

  // Return the host clip handle for `clip`, uploading (and caching) it on first
  // use. A cached -1 (upload failed / too large) means "use the JS sampler".
  private clipHandleFor(g: NonNullable<typeof globalThis.g3d>, clip: BakedClip): number {
    let ch = this.clipHandles.get(clip);
    if (ch === undefined) {
      ch = this.uploadClip(g, clip);
      this.clipHandles.set(clip, ch);
    }
    return ch;
  }

  // Upload one baked clip's flat T/R/S frame tables to the native sampler once.
  // Buffer layout mirrors gfx3d.rs js_g3d_upload_clip / host3d.ts uploadClip:
  // u32 jointCount, u32 frameCount, then frameCount×jointCount×{3 T, 4 R, 3 S} f32.
  private uploadClip(g: NonNullable<typeof globalThis.g3d>, clip: BakedClip): number {
    const jc = this.jointCount;
    const fc = clip.frameCount;
    const nt = fc * jc * 3;
    const nr = fc * jc * 4;
    const ns = fc * jc * 3;
    const buf = new ArrayBuffer((2 + nt + nr + ns) * 4);
    const dv = new DataView(buf);
    let o = 0;
    dv.setUint32(o, jc, true); o += 4;
    dv.setUint32(o, fc, true); o += 4;
    for (let i = 0; i < nt; i++) { dv.setFloat32(o, clip.t[i], true); o += 4; }
    for (let i = 0; i < nr; i++) { dv.setFloat32(o, clip.r[i], true); o += 4; }
    for (let i = 0; i < ns; i++) { dv.setFloat32(o, clip.s[i], true); o += 4; }
    return g.uploadClip!(buf);
  }
}
