// @ts-check
// @title Car 3D
// @order 12
// @controls CROSS accelerate; LEFT/RIGHT steer; START reset
// car3d.js — the M2/M3 milestone: a real baked glTF (Kenney Car Kit, CC0) driving
// on a ground plane past instanced trees/rocks. Proves the TEXTURE path end-to-end
// without skinning: one shared 256² palette (uploadTexture + OP_BIND_TEXTURE) skins
// the body + 4 wheels, which are child Node3Ds spun (roll) and steered (front only)
// by per-frame matrices. Vehicle physics + chase-cam are deterministic JS.
import {
  start, Scene, Scene3D, Node3D, Mesh, Material, Texture, meshFromBaked, mergeMeshes, Fps,
  Mat4, Vec3, Quat, Colors, rgb, Btn,
} from '../src/index';
import { CharController, Collide } from '../src/controller';
import { ActionMap } from '../src/action';
import { KENNEY_CAR } from '../src/assets-kenney-car';
import { NATURE_PROPS } from '../src/assets-kenney-nature';

/** @import { UpdateContext, Graphics, Node3D as N3D } from '../src/index' */


const WHEEL_RADIUS = 0.3; // baked wheel hub sits at y=0.3 -> ~0.3 radius
const MAX_STEER = 0.5; // rad

class CarScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {N3D} */ car = /** @type {any} */ (null);
  /** @type {{ node: N3D, front: boolean }[]} */ wheels = [];
  /** @type {CharController} */ ctrl = /** @type {any} */ (null);
  /** @type {ActionMap} */ act = /** @type {any} */ (null);
  roll = 0;
  steer = 0;
  fps = new Fps();

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    this.world.camera.setPerspective(62, 480 / 272, 0.1, 300);

    // Distance fog: fades the road into the horizon AND is the cull-far plane, so
    // the native scene skips props beyond it (the per-draw GE cost dominates, so
    // fewer draws = more FPS). The road is lined with props for ~520 units; this
    // keeps only the nearby ~handful drawn.
    this.world.fog = { color: rgb(0x9a, 0xb0, 0xc4), near: 45, far: 95 };

    // The ENTIRE static scene — ground, road strip, and all ~32 roadside Kenney
    // props — is baked into ONE mesh and drawn as a single GE call. The per-draw
    // GE cost dominates large scenes, so collapsing the scenery to one draw is the
    // big win (real PSP T&L eats the merged vertex count for free); only the car
    // (body + 4 wheels) stays dynamic. Built once here in JS.
    const id = Quat.identity();
    const s = new Vec3(2, 2, 2);
    const tree = meshFromBaked(NATURE_PROPS.tree);
    const rock = meshFromBaked(NATURE_PROPS.rock);
    const parts = [
      { mesh: Mesh.plane(150, 620, rgb(60, 92, 58)), model: Mat4.identity() },
      { mesh: Mesh.box(9, 0.05, 600, Mesh.solid(rgb(60, 60, 66))), model: Mat4.compose(new Vec3(0, 0.02, -260), id, new Vec3(1, 1, 1)) },
    ];
    for (let i = 0; i < 16; i++) {
      const z = -i * 34 - 12;
      parts.push({ mesh: tree, model: Mat4.compose(new Vec3(-8.5, 0, z), id, s) });
      parts.push({ mesh: i % 2 ? tree : rock, model: Mat4.compose(new Vec3(8.5, 0, z), id, s) });
    }
    this.world.add({ mesh: mergeMeshes(parts), isStatic: true });

    // The baked car: body + 4 wheels share ONE palette texture.
    const t = KENNEY_CAR.texture;
    const carMat = new Material({ texture: new Texture(t.pixels, t.width, t.height, t.psm) });
    this.car = this.world.add({ mesh: meshFromBaked(KENNEY_CAR.body), material: carMat });

    const wheelMesh = meshFromBaked(KENNEY_CAR.wheel);
    for (const off of KENNEY_CAR.wheelOffsets) {
      const node = new Node3D({
        mesh: wheelMesh, material: carMat,
        position: new Vec3(off[0], off[1], off[2]),
      });
      this.car.add(node);
      this.wheels.push({ node, front: off[2] > 0 }); // +z wheels are the front pair
    }

    // Same vehicle physics + chase model as racing3d (shared controller), tuned to
    // car3d's bounds (X ±7.5) and camera height (eyeY 3.4). Wheel roll/steer below
    // stays game-specific, reading ctrl.s.speed / ctrl.s.heading.
    this.ctrl = new CharController(
      { speed: 'continuous', accel: 14, decel: 7, maxSpeed: 26, steerScalesWithSpeed: 0.12, steerSpeedCap: 10, fwdSignZ: -1 },
      { mode: 'chase', dist: 7, lookahead: 6, eyeY: 3.4, lookY: 0.9 },
    );
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
    this.roll = 0;
    this.steer = 0;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    this.fps.sample();
    const act = this.act;
    if (act.pressed('RESET')) this.reset();

    const steerInput = act.axis('STEER');
    this.steer = steerInput * MAX_STEER;
    this.ctrl.step({ throttle: act.held('ACCEL') ? 1 : 0, steer: steerInput, pitch: 0, run: false }, ctx.dt);
    Collide.clampBox(this.ctrl.s, -7.5, 7.5, -1e9, 1e9);
    const s = this.ctrl.s;

    // Wheel roll: arc length / radius. Spin all four; steer the front pair.
    this.roll += (s.speed / WHEEL_RADIUS) * ctx.dt;
    const rollQ = Quat.fromAxisAngle(new Vec3(1, 0, 0), this.roll);
    const steerQ = Quat.fromAxisAngle(new Vec3(0, 1, 0), this.steer);
    for (const w of this.wheels) {
      w.node.rotation = w.front ? steerQ.multiply(rollQ) : rollQ;
    }

    this.car.position = new Vec3(s.x, 0, s.z);
    this.car.rotation = Quat.fromEuler(0, s.heading, 0);
    this.ctrl.applyCam(this.world.camera);
  }

  /** @param {Graphics} g */
  draw(g) {
    const kmh = Math.round(this.ctrl.s.speed * 7.2);
    g.text('CAR 3D', 8, 8, Colors.white, 2);
    if (this.fps.value > 0) g.text(this.fps.value + ' FPS', 410, 8, Colors.yellow, 1);
    g.text(kmh + ' KM/H', 8, 246, Colors.yellow, 2);
    g.rect(8, 234, 160, 6, rgb(40, 40, 40));
    g.rect(8, 234, Math.round((this.ctrl.s.speed / 26) * 160), 6, Colors.green);
  }
}

start(() => new CarScene());
