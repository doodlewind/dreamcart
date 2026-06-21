// @ts-check
// @title Walk 3D
// @order 14
// @controls CROSS walk; LEFT/RIGHT turn; SQUARE run; START reset
// walk3d.js — the M5 milestone: a walking, hardware-skinned Fox. Builds on M4's
// skinning core by advancing the AnimationPlayer (nlerp between baked frames) with
// the clip phase tied to locomotion so the feet don't slide. Movement + chase
// camera now run through the shared CharController (framework/src/controller.ts) —
// the same gated-speed + heading integration + chase rig the other 3D games use,
// configured here to reproduce the original framing byte-for-byte.
//
// Fox: CC-BY-4.0 — model PixelMannen (CC0), rig/anim tomkranis, glTF Asobo/scurest.
import {
  start, Scene, Scene3D, Mesh, SkinnedMesh, Fps,
  Vec3, Quat, Colors, rgb, Btn,
} from '../src/index';
import { CharController, Collide } from '../src/controller';
import { ActionMap } from '../src/action';
import { FOX } from '../src/assets-fox';

/** @import { UpdateContext, Graphics, Node3D } from '../src/index' */

class WalkScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {Node3D} */ fox = /** @type {any} */ (null);
  /** @type {SkinnedMesh} */ skin = /** @type {any} */ (null);
  /** @type {CharController} */ ctrl = /** @type {any} */ (null);
  /** @type {ActionMap} */ act = /** @type {any} */ (null);
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
    const foxCx = ((mn[0] + mx[0]) / 2) * s;
    const foxCy = ((mn[1] + mx[1]) / 2) * s;
    const foxCz = ((mn[2] + mx[2]) / 2) * s;
    const foxR = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * s;

    // Gated walk/run + a chase rig framed identically to the old hand-written one:
    // the local AABB centre is the focus (rotated by heading), eye sits foxR*1.6
    // behind at height foxCy+foxR*0.4, look straight at the centre (lookahead 0).
    this.ctrl = new CharController(
      { speed: 'gated', walkSpeed: 2.0, runSpeed: 4.5, turnRate: 1.8, fwdSignZ: 1 },
      {
        mode: 'chase', dist: foxR * 1.6, lookahead: 0,
        eyeY: foxCy + foxR * 0.4, lookY: foxCy,
        focusLocalX: foxCx, focusLocalZ: foxCz,
      },
    );

    this.act = new ActionMap(ctx.input, {
      FORWARD: { buttons: [Btn.Cross, Btn.Square] },
      RUN: { buttons: [Btn.Square] },
      STEER: { axis: 'lx', axisButtons: [Btn.Left, Btn.Right], invert: true },
      RESET: { buttons: [Btn.Start] },
    });
    this.engine = ctx.engine;
    this.reset();
    ctx.engine.scene3d = this.world;
  }

  reset() {
    this.ctrl.s.x = 0;
    this.ctrl.s.z = 0;
    this.ctrl.s.heading = 0;
    this.ctrl.s.speed = 0;
    this.skin.play(FOX.clips.Walk);
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    this.fps.sample();
    const act = this.act;
    if (act.pressed('RESET')) this.reset();

    const run = act.held('RUN');
    const moving = act.held('FORWARD');
    // Forward on Cross/Square (gated speed); turn on Left(+)/Right(-) at 1.8 rad/s.
    this.ctrl.step({
      throttle: moving ? 1 : 0,
      steer: act.axis('STEER'),
      pitch: 0,
      run,
    }, ctx.dt);
    Collide.clampBox(this.ctrl.s, -38, 38, -38, 38);
    const s = this.ctrl.s;

    // Switch clip when the gait changes (Walk <-> Run).
    if (run !== this.running) {
      this.running = run;
      this.skin.play(run ? FOX.clips.Run : FOX.clips.Walk);
    }
    // Advance the clip phase at a rate scaled with speed so the stride matches
    // forward motion (no foot sliding). Walk/Run clips are tuned at 1× for their
    // authored speeds (2.0 / 4.5).
    const playRate = run ? s.speed / 4.5 : s.speed / 2.0;
    this.skin.player.advance(ctx.dt * playRate);

    this.fox.position = new Vec3(s.x, 0, s.z);
    this.fox.rotation = Quat.fromEuler(0, s.heading, 0);
    this.ctrl.applyCam(this.world.camera);
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
