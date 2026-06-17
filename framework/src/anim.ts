// Skeletal animation playback (deterministic — in contract.ts's detFiles guard;
// only +,-,*,/, Math.floor and math.ts helpers, no native trig). A baked clip is
// a fixed-fps table of per-joint local TRS; the player loops a time cursor and
// samples two bracketing frames (lerp position/scale, nlerp rotation) into
// preallocated buffers (no per-frame GC). The result feeds Skeleton (skin.ts).
import { Quat } from './math';

/** A clip baked to a fixed fps: frameCount × jointCount TRS, flat arrays. */
export interface BakedClip {
  fps: number;
  frameCount: number;
  t: Float32Array; // frameCount*jointCount*3
  r: Float32Array; // frameCount*jointCount*4
  s: Float32Array; // frameCount*jointCount*3
}

export class AnimationPlayer {
  clip: BakedClip;
  jointCount: number;
  time = 0;
  /** Clip duration in seconds (frame spacing is 1/fps; endpoint is inclusive). */
  readonly duration: number;
  // Sampled local TRS for the current time, per joint (reused every frame).
  readonly outT: Float32Array;
  readonly outR: Float32Array;
  readonly outS: Float32Array;

  constructor(clip: BakedClip, jointCount: number) {
    this.clip = clip;
    this.jointCount = jointCount;
    this.duration = clip.frameCount > 1 ? (clip.frameCount - 1) / clip.fps : 0;
    this.outT = new Float32Array(jointCount * 3);
    this.outR = new Float32Array(jointCount * 4);
    this.outS = new Float32Array(jointCount * 3);
  }

  /** Advance and wrap the time cursor into [0, duration). */
  advance(dt: number): void {
    this.time += dt;
    const d = this.duration;
    if (d > 0) {
      this.time -= Math.floor(this.time / d) * d;
      if (this.time < 0) this.time += d;
    } else {
      this.time = 0;
    }
  }

  /** Jump to an absolute clip time (wrapped). */
  setTime(t: number): void {
    this.time = 0;
    this.advance(t);
  }

  /**
   * Sample the current time into outT/outR/outS. Frames are inclusive of the
   * endpoint (frame[count-1] == the loop point == frame[0] for a cyclic clip),
   * so phase∈[0,1) maps to a fractional frame in [0, count-1) — no wrap seam.
   */
  sample(): void {
    const { frameCount, t, r, s } = this.clip;
    const jc = this.jointCount;
    const phase = this.duration > 0 ? this.time / this.duration : 0;
    const fidx = phase * (frameCount - 1);
    let f0 = Math.floor(fidx);
    if (f0 < 0) f0 = 0;
    if (f0 > frameCount - 2) f0 = Math.max(0, frameCount - 2);
    const f1 = f0 + 1;
    const u = fidx - f0;
    const b0 = f0 * jc;
    const b1 = f1 * jc;
    for (let j = 0; j < jc; j++) {
      const o3a = (b0 + j) * 3;
      const o3b = (b1 + j) * 3;
      const o4a = (b0 + j) * 4;
      const o4b = (b1 + j) * 4;
      // position + scale: component lerp.
      for (let k = 0; k < 3; k++) {
        this.outT[j * 3 + k] = t[o3a + k] + (t[o3b + k] - t[o3a + k]) * u;
        this.outS[j * 3 + k] = s[o3a + k] + (s[o3b + k] - s[o3a + k]) * u;
      }
      // rotation: nlerp (shorter arc) — slerp's acos/sin are banned by the guard.
      const qa = new Quat(r[o4a], r[o4a + 1], r[o4a + 2], r[o4a + 3]);
      const qb = new Quat(r[o4b], r[o4b + 1], r[o4b + 2], r[o4b + 3]);
      const q = Quat.nlerp(qa, qb, u);
      this.outR[j * 4] = q.x;
      this.outR[j * 4 + 1] = q.y;
      this.outR[j * 4 + 2] = q.z;
      this.outR[j * 4 + 3] = q.w;
    }
  }
}

/** A single static joint-pose (no time): the bind pose or one frozen clip frame. */
export function poseFromClip(clip: BakedClip, jointCount: number, frame = 0): AnimationPlayer {
  const p = new AnimationPlayer(clip, jointCount);
  p.setTime(frame / clip.fps);
  return p;
}
