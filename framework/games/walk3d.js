// @ts-check
// @title Walk 3D
// @order 14
// @controls CROSS walk; LEFT/RIGHT turn; SQUARE run; START reset
// walk3d.js — the M5 milestone: a walking, hardware-skinned Fox. Builds on M4's
// skinning core by advancing the AnimationPlayer (nlerp between baked frames) with
// the clip phase tied to locomotion so the feet don't slide. Heading/speed/camera
// are deterministic JS; the PSP GE skins + textures in hardware.
//
// Fox: CC-BY-4.0 — model PixelMannen (CC0), rig/anim tomkranis, glTF Asobo/scurest.
import {
  start, Scene, Scene3D, Mesh, SkinnedMesh, Fps,
  Vec3, Quat, Colors, rgb, Btn, dsin, dcos,
} from '../src/index';
import { FOX } from '../src/assets-fox';

/** @import { UpdateContext, Graphics, Node3D } from '../src/index' */

/** @param {number} v @param {number} a @param {number} b @returns {number} */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

class WalkScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {Node3D} */ fox = /** @type {any} */ (null);
  /** @type {SkinnedMesh} */ skin = /** @type {any} */ (null);
  x = 0;
  z = 0;
  heading = 0;
  running = false;
  fps = new Fps();
  /** @type {any} */ engine = null;

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    this.world.camera.setPerspective(58, 480 / 272, 0.05, 100);

    // A ground plane so the fox is grounded, not floating in the void.
    this.world.add({ mesh: Mesh.plane(80, 80, rgb(64, 96, 60)) });

    this.skin = SkinnedMesh.fromBaked(FOX);
    this.skin.play(FOX.clips.Walk);
    this.fox = this.world.add({
      skinned: this.skin,
      scale: new Vec3(FOX.scale, FOX.scale, FOX.scale),
    });

    this.engine = ctx.engine;
    this.reset();
    ctx.engine.scene3d = this.world;
  }

  reset() {
    this.x = 0;
    this.z = 0;
    this.heading = 0;
    this.skin.play(FOX.clips.Walk);
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    this.fps.sample();
    const inp = ctx.input;
    if (inp.pressed(Btn.Start)) this.reset();

    if (inp.held(Btn.Left)) this.heading += 1.8 * ctx.dt;
    if (inp.held(Btn.Right)) this.heading -= 1.8 * ctx.dt;

    const moving = inp.held(Btn.Cross) || inp.held(Btn.Square);
    const run = inp.held(Btn.Square);
    // Switch clip when the gait changes (Walk <-> Run).
    if (run !== this.running) {
      this.running = run;
      this.skin.play(run ? FOX.clips.Run : FOX.clips.Walk);
    }
    const speed = moving ? (run ? 4.5 : 2.0) : 0;

    // Advance the clip phase only while moving, at a rate scaled with speed so
    // the stride matches forward motion (no foot sliding). The Walk/Run clips are
    // tuned at ~1× playback for their authored speeds.
    const playRate = run ? speed / 4.5 : speed / 2.0;
    this.skin.player.advance(ctx.dt * playRate);

    // Fox local forward is +Z; rotate by heading about Y and move along it.
    const fwdX = dsin(this.heading);
    const fwdZ = dcos(this.heading);
    this.x += fwdX * speed * ctx.dt;
    this.z += fwdZ * speed * ctx.dt;
    this.x = clamp(this.x, -38, 38);
    this.z = clamp(this.z, -38, 38);

    this.fox.position = new Vec3(this.x, 0, this.z);
    this.fox.rotation = Quat.fromEuler(0, this.heading, 0);

    // Chase camera: behind + above, looking just ahead of the fox.
    const eye = new Vec3(this.x - fwdX * 3.2, 1.7, this.z - fwdZ * 3.2);
    const look = new Vec3(this.x + fwdX * 1.5, 0.5, this.z + fwdZ * 1.5);
    this.world.camera.lookAt(eye, look, new Vec3(0, 1, 0));
  }

  /** @param {Graphics} g */
  draw(g) {
    g.text('WALK 3D', 8, 8, Colors.white, 2);
    if (this.fps.value > 0 && this.engine) {
      g.text(this.fps.value + ' FPS', 410, 8, Colors.yellow, 1);
      const p = this.engine.prof;
      g.text('upd ' + p[0] + ' r3d ' + p[1] + ' r2d ' + p[2] + ' us', 8, 30, Colors.cyan, 1);
    }
    g.text('X WALK  []' + ' RUN  L/R TURN', 8, 246, Colors.cyan, 1);
    g.text('Fox (c) tomkranis/Asobo/scurest CC-BY', 8, 258, Colors.gray, 1);
  }
}

start(() => new WalkScene());
