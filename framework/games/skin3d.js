// @ts-check
// @title Skin 3D
// @order 13
// @controls CROSS cycle animation (Survey/Walk/Run); LEFT/RIGHT rotate view
// skin3d.js — hardware-skinned Fox showcase: the GE skins in hardware
// (sceGuBoneMatrix + WEIGHTSn over the bone-batch-partitioned mesh) while JS only
// samples the clip. Plays the baked animations in place with an orbiting camera;
// CROSS cycles Survey/Walk/Run, LEFT/RIGHT spin the view. (walk3d adds locomotion.)
//
// Fox: CC-BY-4.0 — model PixelMannen (CC0), rig/anim tomkranis, glTF Asobo/scurest.
import {
  start, Scene, Scene3D, SkinnedMesh, Fps,
  Vec3, Colors, Btn, dsin, dcos,
} from '../src/index';
import { FOX } from '../src/assets-fox';
import { SoundBank } from '../src/audio';
import { voiceTable } from '../src/assets-audio';

/** @import { UpdateContext, Graphics } from '../src/index' */

const CLIPS = ['Survey', 'Walk', 'Run'];

class SkinScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {SkinnedMesh} */ skin = /** @type {any} */ (null);
  cx = 0;
  cy = 0;
  cz = 0;
  radius = 2;
  t = 0;
  clipIdx = 0;
  fps = new Fps();
  /** @type {SoundBank} */ snd = /** @type {any} */ (null);

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    this.world.camera.setPerspective(55, 480 / 272, 0.05, 100);

    this.skin = SkinnedMesh.fromBaked(FOX);
    this.skin.play(FOX.clips[CLIPS[0]]); // Survey (idle look-around)
    this.world.add({ skinned: this.skin, scale: new Vec3(FOX.scale, FOX.scale, FOX.scale) });

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

    // Shared footstep glue (deterministic, no HUD -> golden pixels unchanged).
    this.snd = new SoundBank({ steps: { voice: 'footstep' } });
    if (typeof snd !== 'undefined' && snd) snd.defineVoices(voiceTable());
    this.snd.bindSteps(this.skin);
    ctx.engine.audio = this.snd;

    ctx.engine.scene3d = this.world;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    this.fps.sample();
    const inp = ctx.input;

    // CROSS cycles the animation clip.
    if (inp.pressed(Btn.Cross)) {
      this.clipIdx = (this.clipIdx + 1) % CLIPS.length;
      this.skin.play(FOX.clips[CLIPS[this.clipIdx]]);
    }
    // Play the animation (loops on its own).
    this.skin.player.advance(ctx.dt);

    // Camera: LEFT/RIGHT spin manually, otherwise slowly auto-orbit.
    if (inp.held(Btn.Left)) this.t += ctx.dt * 1.6;
    else if (inp.held(Btn.Right)) this.t -= ctx.dt * 1.6;
    else this.t += ctx.dt * 0.4;

    const d = this.radius * 1.6;
    const center = new Vec3(this.cx, this.cy, this.cz);
    const eye = new Vec3(this.cx + dsin(this.t) * d, this.cy + this.radius * 0.4, this.cz + dcos(this.t) * d);
    this.world.camera.lookAt(eye, center, new Vec3(0, 1, 0));
  }

  /** @param {Graphics} g */
  draw(g) {
    g.text('SKIN 3D', 8, 8, Colors.white, 2);
    if (this.fps.value > 0) g.text(this.fps.value + ' FPS', 410, 8, Colors.yellow, 1);
    g.text('X: ' + CLIPS[this.clipIdx] + '   (X cycle anim, L/R rotate)', 8, 248, Colors.cyan, 1);
    g.text('Fox (c) tomkranis/Asobo/scurest CC-BY', 8, 260, Colors.gray, 1);
  }
}

start(() => new SkinScene());
