// @ts-check
// @title Racing 3D
// @order 11
// @controls CROSS accelerate; LEFT/RIGHT steer; START reset
// racing3d.js — a chase-cam racer. Proves the 3D contract SCALES: dozens of cones
// are instances of a SINGLE retained mesh (one upload) drawn by per-frame model
// matrices in ONE submit. Vehicle physics + camera are pure deterministic JS.
import {
  start, Scene, Scene3D, Mesh, Vec3, Quat, Colors, rgb, Btn, dsin, dcos,
} from '../src/index';

/** @import { UpdateContext, Graphics, Node3D } from '../src/index' */

/** @param {number} c @returns {number[]} */
const solid = (c) => [c, c, c, c, c, c];
/** @param {number} v @param {number} a @param {number} b @returns {number} */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const CONE_SPACING = 14;
const CONE_COUNT = 22;
const LANE = 5;

class RacingScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {Node3D} */ car = /** @type {any} */ (null);
  x = 0;
  z = 0;
  heading = 0;
  speed = 0;

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

    this.reset();
    ctx.engine.scene3d = this.world;
  }

  reset() {
    this.x = 0;
    this.z = 0;
    this.heading = 0;
    this.speed = 0;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    const inp = ctx.input;
    if (inp.pressed(Btn.Start)) this.reset();

    if (inp.held(Btn.Cross)) this.speed += 14 * ctx.dt;
    else this.speed -= 7 * ctx.dt;
    this.speed = clamp(this.speed, 0, 26);

    // Steering authority scales with speed (can't turn while stopped).
    const steer = inp.dir().x;
    this.heading += steer * Math.min(this.speed, 10) * 0.12 * ctx.dt;

    const fwdX = dsin(this.heading);
    const fwdZ = -dcos(this.heading);
    this.x += fwdX * this.speed * ctx.dt;
    this.z += fwdZ * this.speed * ctx.dt;
    this.x = clamp(this.x, -8, 8); // stay near the road

    this.car.position = new Vec3(this.x, 0.4, this.z);
    this.car.rotation = Quat.fromEuler(0, this.heading, 0);

    // Chase camera: behind + above the car, looking ahead of it.
    const eye = new Vec3(this.x - fwdX * 7, 3.2, this.z - fwdZ * 7);
    const look = new Vec3(this.x + fwdX * 6, 0.9, this.z + fwdZ * 6);
    this.world.camera.lookAt(eye, look, new Vec3(0, 1, 0));
  }

  /** @param {Graphics} g */
  draw(g) {
    const kmh = Math.round(this.speed * 7.2);
    g.text('RACING 3D', 8, 8, Colors.white, 2);
    g.text(kmh + ' KM/H', 8, 246, Colors.yellow, 2);
    // simple speed bar
    g.rect(8, 234, 160, 6, rgb(40, 40, 40));
    g.rect(8, 234, Math.round((this.speed / 26) * 160), 6, Colors.green);
  }
}

start(() => new RacingScene());
