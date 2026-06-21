// @ts-check
// @title Controller 3D
// @order 16
// @controls SELECT cycle mode; CROSS go/boost/fire; LEFT/RIGHT or stick steer; SQUARE run; UP/DOWN move/pitch; START reset
// controller3d.js — the shared-controller showcase. ONE KinematicState drives FOUR
// movement styles (car / walk / fly / fps) over the same ground + boxes; only the
// MoveConfig + CamRig swap, the kinematicStep/camApply calls are identical. Proves
// the framework/src/controller.ts core that the other 3D games were each
// reinventing. The PSP analog stick steers continuously (axis()); on a digital
// host axis() falls back to the d-pad, so it runs unchanged everywhere.
//
// Fox: CC-BY-4.0 — model PixelMannen (CC0), rig/anim tomkranis, glTF Asobo/scurest.
import {
  start, Scene, Scene3D, Mesh, SkinnedMesh, Fps,
  Vec3, Quat, Colors, rgb, Btn,
} from '../src/index';
import { CharController, Collide } from '../src/controller';
import { FOX } from '../src/assets-fox';

/** @import { UpdateContext, Graphics, Node3D } from '../src/index' */

// Fixed box field — scenery for car/walk/fly and hitscan targets for fps.
const BOXES = [
  { x: 6, z: -8, c: rgb(200, 80, 80) },
  { x: -7, z: -5, c: rgb(80, 160, 200) },
  { x: 10, z: 6, c: rgb(220, 180, 70) },
  { x: -9, z: 9, c: rgb(120, 200, 120) },
  { x: 0, z: -14, c: rgb(200, 120, 200) },
  { x: -3, z: 4, c: rgb(180, 180, 180) },
];
const BOX_H = 2;

class ControllerDemo extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {Node3D} */ fox = /** @type {any} */ (null);
  /** @type {SkinnedMesh} */ skin = /** @type {any} */ (null);
  /** @type {CharController} */ ctrl = /** @type {any} */ (null);
  modeIdx = 0;
  running = false;
  hitText = '';
  fps = new Fps();
  /** @type {any} */ engine = null;
  foxCx = 0; foxCy = 0; foxCz = 0; foxR = 1;

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    this.world.camera.setPerspective(60, 480 / 272, 0.05, 120);
    this.world.add({ mesh: Mesh.plane(120, 120, rgb(54, 70, 58)) });

    // Static box field — scenery + fps hitscan targets (positions in BOXES).
    for (const b of BOXES) {
      this.world.add({
        mesh: Mesh.box(2, BOX_H, 2, [b.c, b.c, b.c, b.c, b.c, b.c]),
        position: new Vec3(b.x, BOX_H / 2, b.z),
      });
    }

    this.skin = SkinnedMesh.fromBaked(FOX);
    this.skin.play(FOX.clips.Walk);
    this.fox = this.world.add({ skinned: this.skin, scale: new Vec3(FOX.scale, FOX.scale, FOX.scale) });

    // Fox bind AABB (× scale) for the walk chase framing (matches walk3d/skin3d).
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const bt of FOX.batches) {
      const a = bt.mesh.aabb;
      for (let k = 0; k < 3; k++) { if (a.min[k] < mn[k]) mn[k] = a.min[k]; if (a.max[k] > mx[k]) mx[k] = a.max[k]; }
    }
    const s = FOX.scale;
    this.foxCx = ((mn[0] + mx[0]) / 2) * s;
    this.foxCy = ((mn[1] + mx[1]) / 2) * s;
    this.foxCz = ((mn[2] + mx[2]) / 2) * s;
    this.foxR = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * s;

    this.ctrl = new CharController(this.modeCfg(0), this.modeRig(0));
    this.engine = ctx.engine;
    this.applyMode(0);
    ctx.engine.scene3d = this.world;
  }

  modeName() { return ['CAR', 'WALK', 'FLY', 'FPS'][this.modeIdx]; }

  /** @param {number} i @returns {import('../src/controller').MoveConfig} */
  modeCfg(i) {
    if (i === 0) return { speed: 'continuous', accel: 8, decel: 12, maxSpeed: 13, steerScalesWithSpeed: 0.12, steerSpeedCap: 10, fwdSignZ: -1 };
    if (i === 1) return { speed: 'gated', walkSpeed: 2.0, runSpeed: 4.5, turnRate: 1.8, fwdSignZ: 1 };
    if (i === 2) return { alwaysForward: 7, turnRate: 1.5, pitchRate: 0.8, fwdSignZ: 1 };
    return { speed: 'gated', walkSpeed: 3, runSpeed: 6, backSpeed: 3, turnRate: 2.2, fwdSignZ: -1 }; // fps
  }
  /** @param {number} i @returns {import('../src/controller').CamRig} */
  modeRig(i) {
    if (i === 0) return { mode: 'chase', dist: 8, lookahead: 6, eyeY: 3.4, lookY: 1.0 };
    if (i === 1) return { mode: 'chase', dist: this.foxR * 1.6, lookahead: 0, eyeY: this.foxCy + this.foxR * 0.4, lookY: this.foxCy, focusLocalX: this.foxCx, focusLocalZ: this.foxCz };
    if (i === 2) return { mode: 'freefly' };
    return { mode: 'fps', eyeHeight: 1.6 };
  }

  /** @param {number} i */
  applyMode(i) {
    this.modeIdx = i;
    this.ctrl.cfg = this.modeCfg(i);
    this.ctrl.rig = this.modeRig(i);
    const s = this.ctrl.s;
    s.x = 0; s.z = 0; s.heading = 0; s.pitch = 0; s.speed = 0;
    s.y = i === 2 ? 4 : 0; // fly looks from altitude; others ground-relative
    this.running = false;
    this.hitText = '';
    this.skin.play(FOX.clips.Walk);
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    this.fps.sample();
    const inp = ctx.input;
    if (inp.pressed(Btn.Start)) this.applyMode(this.modeIdx);
    if (inp.pressed(Btn.Select)) this.applyMode((this.modeIdx + 1) % 4);

    const ax = inp.axis();
    const run = inp.held(Btn.Square);
    let sample;
    if (this.modeIdx === 0) { // CAR
      sample = { throttle: inp.held(Btn.Cross) || inp.held(Btn.Up) ? 1 : inp.held(Btn.Down) ? -1 : 0, steer: ax.x, pitch: 0, run };
    } else if (this.modeIdx === 1) { // WALK
      const moving = inp.held(Btn.Cross) || inp.held(Btn.Square);
      sample = { throttle: moving ? 1 : 0, steer: ax.x, pitch: 0, run };
    } else if (this.modeIdx === 2) { // FLY
      sample = { throttle: inp.held(Btn.Cross) ? 1 : 0, steer: ax.x, pitch: -ax.y, run };
    } else { // FPS
      sample = { throttle: inp.held(Btn.Up) ? 1 : inp.held(Btn.Down) ? -1 : 0, steer: ax.x, pitch: 0, run };
    }
    this.ctrl.step(sample, ctx.dt);
    Collide.clampBox(this.ctrl.s, -56, 56, -56, 56);
    const s = this.ctrl.s;

    // Avatar: visible (on the ground) for car/walk; hidden for fly/fps (first-person).
    if (this.modeIdx === 0 || this.modeIdx === 1) {
      this.fox.position = new Vec3(s.x, 0, s.z);
      this.fox.rotation = Quat.fromEuler(0, s.heading, 0);
      if (this.modeIdx === 1) {
        if (run !== this.running) { this.running = run; this.skin.play(run ? FOX.clips.Run : FOX.clips.Walk); }
        const playRate = run ? s.speed / 4.5 : s.speed / 2.0;
        this.skin.player.advance(ctx.dt * playRate);
      }
    } else {
      this.fox.position = new Vec3(0, -100, 0); // park off-screen
    }

    // FPS hitscan on CROSS: nearest box along the look ray gets bumped up.
    if (this.modeIdx === 3 && inp.pressed(Btn.Cross)) {
      let best = -1, bestT = Infinity;
      for (let i = 0; i < BOXES.length; i++) {
        const b = BOXES[i];
        const t = Collide.rayAabb(s.x, 1.6, s.z, s.fwdX, 0, s.fwdZ, b.x, BOX_H / 2, b.z, 1, BOX_H / 2, 1);
        if (t > 0 && t < bestT) { bestT = t; best = i; }
      }
      this.hitText = best >= 0 ? 'HIT box ' + best + ' @' + bestT.toFixed(1) : 'miss';
    }

    this.ctrl.applyCam(this.world.camera);
  }

  /** @param {Graphics} g */
  draw(g) {
    g.text('CONTROLLER 3D', 8, 8, Colors.white, 2);
    g.text(this.modeName(), 8, 30, Colors.yellow, 2);
    if (this.fps.value > 0) g.text(this.fps.value + ' FPS', 410, 8, Colors.yellow, 1);
    g.text('hdg ' + this.ctrl.s.heading.toFixed(2) + '  spd ' + this.ctrl.s.speed.toFixed(2), 110, 36, Colors.cyan, 1);
    if (this.engine) {
      const p = this.engine.prof;
      g.text('upd ' + p[0] + ' us', 8, 52, Colors.cyan, 1);
    }
    if (this.modeIdx === 3) {
      // crosshair + last hitscan result
      g.rect(238, 134, 4, 4, Colors.white);
      if (this.hitText) g.text(this.hitText, 8, 70, Colors.green, 1);
    }
    g.text('SELECT MODE  X GO/FIRE  L/R STEER  [] RUN', 8, 246, Colors.cyan, 1);
    g.text('Fox (c) tomkranis/Asobo/scurest CC-BY', 8, 258, Colors.gray, 1);
  }
}

start(() => new ControllerDemo());
