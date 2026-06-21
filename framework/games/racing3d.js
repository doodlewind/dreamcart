// @ts-check
// @title Racing 3D
// @order 11
// @controls CROSS accelerate; LEFT/RIGHT steer; START reset
// racing3d.js — a chase-cam racer. Proves the 3D contract SCALES: dozens of cones
// are instances of a SINGLE retained mesh (one upload) drawn by per-frame model
// matrices in ONE submit. Vehicle physics + camera are pure deterministic JS.
import {
  start, Scene, Scene3D, Mesh, Vec3, Quat, Colors, rgb, Btn, CharController, Collide,
} from '../src/index';

/** @import { UpdateContext, Graphics, Node3D } from '../src/index' */

/** @param {number} c @returns {number[]} */
const solid = (c) => [c, c, c, c, c, c];

const CONE_SPACING = 14;
const CONE_COUNT = 22;
const LANE = 5;

class RacingScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {Node3D} */ car = /** @type {any} */ (null);
  /** @type {CharController} */ ctrl = /** @type {any} */ (null);

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    this.world.camera.setPerspective(62, 480 / 272, 0.1, 300);

    // Ground + a darker road strip slightly above it (avoids z-fighting).
    this.world.add({ mesh: Mesh.plane(600, 600, rgb(46, 78, 46)), position: new Vec3(0, 0, 0) });
    this.world.add({
      mesh: Mesh.box(10, 0.05, 600, solid(rgb(54, 54, 60))),
      position: new Vec3(0, 0.02, -260),
    });

    // ONE cone mesh, uploaded once, drawn at many positions (the scaling proof).
    const cone = Mesh.box(0.7, 1.4, 0.7, solid(rgb(230, 120, 40)));
    for (let i = 0; i < CONE_COUNT; i++) {
      const z = -i * CONE_SPACING - 8;
      this.world.add({ mesh: cone, position: new Vec3(-LANE, 0.7, z) });
      this.world.add({ mesh: cone, position: new Vec3(LANE, 0.7, z) });
    }

    // The car (a single box) chased by the camera.
    this.car = this.world.add({ mesh: Mesh.box(1.3, 0.7, 2.4, solid(rgb(210, 50, 50))) });

    // Vehicle physics + chase cam now run through the shared controller: continuous
    // accel (14) / decel (7) up to 26, bicycle steering authority (×speed, capped 10,
    // 0.12), forward = -Z. Chase rig at fixed eyeY 3.2 / lookY 0.9, dist 7, lookahead 6.
    this.ctrl = new CharController(
      { speed: 'continuous', accel: 14, decel: 7, maxSpeed: 26, steerScalesWithSpeed: 0.12, steerSpeedCap: 10, fwdSignZ: -1 },
      { mode: 'chase', dist: 7, lookahead: 6, eyeY: 3.2, lookY: 0.9 },
    );
    ctx.engine.scene3d = this.world;
  }

  reset() {
    const s = this.ctrl.s;
    s.x = 0; s.z = 0; s.heading = 0; s.speed = 0;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    const inp = ctx.input;
    if (inp.pressed(Btn.Start)) this.reset();

    this.ctrl.step({ throttle: inp.held(Btn.Cross) ? 1 : 0, steer: inp.axis().x, pitch: 0, run: false }, ctx.dt);
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
