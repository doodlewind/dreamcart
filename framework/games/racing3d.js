// @ts-check
// @title Racing 3D
// @order 11
// @controls CROSS accelerate; LEFT/RIGHT steer; START reset
// racing3d.js — a chase-cam racer. Proves the 3D contract SCALES: dozens of cones
// are instances of a SINGLE retained mesh (one upload) drawn by per-frame model
// matrices in ONE submit. Vehicle physics + camera are pure deterministic JS.
// The static scenery (ground, road, the 44 cones + camera) is now DATA-DRIVEN:
// loadScene('racing3d') rebuilds it from the baked descriptor (framework/scenes/
// racing3d.scene.ts) in the exact same add order, so the .dc3d draw list is
// byte-identical to the old hand-written onEnter.
import {
  start, Scene, Mesh, Vec3, Quat, Colors, rgb, Btn,
} from '../src/index';
import { ActionMap } from '../src/action';
import { CharController, Collide } from '../src/controller';
import { loadScene } from '../src/scene-desc';

/** @import { UpdateContext, Graphics, Node3D, Scene3D } from '../src/index' */


class RacingScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {Node3D} */ car = /** @type {any} */ (null);
  /** @type {CharController} */ ctrl = /** @type {any} */ (null);
  /** @type {ActionMap} */ act = /** @type {any} */ (null);

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    // Static scenery (ground, road, 44 cones + camera) from the baked descriptor.
    // buildScene adds them in the same order the old inline code did. The full
    // literal key keeps framework/build.ts from tree-shaking the scene blobs out.
    this.world = loadScene('racing3d').scene;

    // The car (a single box) chased by the camera — added AFTER the scene so the
    // add order stays ground, road, cones..., car, and so we keep its live node
    // reference to drive it each frame.
    this.car = this.world.add({ mesh: Mesh.box(1.3, 0.7, 2.4, Mesh.solid(rgb(210, 50, 50))) });

    // Vehicle physics + chase cam now run through the shared controller: continuous
    // accel (14) / decel (7) up to 26, bicycle steering authority (×speed, capped 10,
    // 0.12), forward = -Z. Chase rig at fixed eyeY 3.2 / lookY 0.9, dist 7, lookahead 6.
    this.ctrl = new CharController(
      { speed: 'continuous', accel: 14, decel: 7, maxSpeed: 26, steerScalesWithSpeed: 0.12, steerSpeedCap: 10, fwdSignZ: -1 },
      { mode: 'chase', dist: 7, lookahead: 6, eyeY: 3.2, lookY: 0.9 },
    );

    // Named actions, declared once. The digital path is byte-identical to the
    // old held(Cross)/axis().x/pressed(Start): STEER with no analog input falls
    // back to its Left/Right pair, and on a host WITH an analog stick the same
    // STEER action now reaches steering for free. Rebinding is data-only —
    // e.g. to move RESET from START to SELECT, change just this line:
    //   RESET: { buttons: [Btn.Select] },   // <- one-line, zero-code rebind
    this.act = new ActionMap(ctx.input, {
      ACCEL: { buttons: [Btn.Cross] },
      STEER: { axis: 'lx', axisButtons: [Btn.Left, Btn.Right] },
      RESET: { buttons: [Btn.Start] },
    });
    ctx.engine.scene3d = this.world;
  }

  reset() {
    const s = this.ctrl.s;
    s.x = 0; s.z = 0; s.heading = 0; s.speed = 0;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    const act = this.act;
    if (act.pressed('RESET')) this.reset();

    this.ctrl.step({ throttle: act.held('ACCEL') ? 1 : 0, steer: act.axis('STEER'), pitch: 0, run: false }, ctx.dt);
    Collide.clampBox(this.ctrl.s, -8, 8, -1e9, 1e9); // stay near the road (X only)
    const s = this.ctrl.s;

    this.car.position = new Vec3(s.x, 0.4, s.z);
    this.car.rotation = Quat.fromEuler(0, s.heading, 0);
    this.ctrl.applyCam(this.world.camera);
  }

  /** @param {Graphics} g */
  draw(g) {
    const speed = this.ctrl.s.speed;
    const kmh = Math.round(speed * 7.2);
    g.text('RACING 3D', 8, 8, Colors.white, 2);
    g.text(kmh + ' KM/H', 8, 246, Colors.yellow, 2);
    // simple speed bar
    g.rect(8, 234, 160, 6, rgb(40, 40, 40));
    g.rect(8, 234, Math.round((speed / 26) * 160), 6, Colors.green);
  }
}

start(() => new RacingScene());
