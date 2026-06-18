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
  foxCx = 0; // fox AABB centre (× scale, local space), for framing
  foxCy = 0.5;
  foxCz = 0;
  foxR = 1.5; // fox bounding radius (× scale)

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

    // Auto-frame from the combined (scaled) bind AABB, exactly like skin3d, so
    // the chase camera frames the whole fox the same way.
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
    this.foxCx = ((mn[0] + mx[0]) / 2) * s;
    this.foxCy = ((mn[1] + mx[1]) / 2) * s;
    this.foxCz = ((mn[2] + mx[2]) / 2) * s;
    this.foxR = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * s;

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

    // Chase camera framed exactly like skin3d: look AT the fox's AABB centre
    // from a fixed angle behind it, at the same distance (radius*1.6) and height
    // (centre + radius*0.4) ratios skin3d's orbit uses. (skin3d orbits a still
    // fox; here the same framing simply tracks the fox from behind as it walks.)
    // The local AABB centre is rotated by heading so it tracks turns correctly.
    const ccx = this.x + this.foxCx * fwdZ + this.foxCz * fwdX;
    const ccz = this.z - this.foxCx * fwdX + this.foxCz * fwdZ;
    const ccy = this.foxCy;
    const d = this.foxR * 1.6;
    const eye = new Vec3(ccx - fwdX * d, ccy + this.foxR * 0.4, ccz - fwdZ * d);
    this.world.camera.lookAt(eye, new Vec3(ccx, ccy, ccz), new Vec3(0, 1, 0));
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
