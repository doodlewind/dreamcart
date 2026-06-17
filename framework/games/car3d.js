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
  start, Scene, Scene3D, Node3D, Mesh, Material, Texture, meshFromBaked, Fps,
  Vec3, Quat, Colors, rgb, Btn, dsin, dcos,
} from '../src/index';
import { KENNEY_CAR } from '../src/assets-kenney-car';
import { NATURE_PROPS } from '../src/assets-kenney-nature';

/** @import { UpdateContext, Graphics, Node3D as N3D } from '../src/index' */

/** @param {number} c @returns {number[]} */
const solid = (c) => [c, c, c, c, c, c];
/** @param {number} v @param {number} a @param {number} b @returns {number} */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const WHEEL_RADIUS = 0.3; // baked wheel hub sits at y=0.3 -> ~0.3 radius
const MAX_STEER = 0.5; // rad

class CarScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {N3D} */ car = /** @type {any} */ (null);
  /** @type {{ node: N3D, front: boolean }[]} */ wheels = [];
  x = 0;
  z = 0;
  heading = 0;
  speed = 0;
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

    // Ground + a darker road strip just above it (avoids z-fighting). Static:
    // only the car moves, so the scenery is uploaded to the native scene once and
    // never re-walked in JS (see docs/psp-native-scene.md).
    this.world.add({ mesh: Mesh.plane(150, 620, rgb(60, 92, 58)), isStatic: true });
    this.world.add({
      mesh: Mesh.box(9, 0.05, 600, solid(rgb(60, 60, 66))),
      position: new Vec3(0, 0.02, -260),
      isStatic: true,
    });

    // Instanced Kenney nature props (one upload each) lining the road. Each gets
    // its local AABB so the native scene frustum-culls the ones behind / far from
    // the car — keeping the GE draw count (the per-draw cost dominates) low.
    const tree = meshFromBaked(NATURE_PROPS.tree);
    const rock = meshFromBaked(NATURE_PROPS.rock);
    const treeAabb = NATURE_PROPS.tree.aabb;
    const rockAabb = NATURE_PROPS.rock.aabb;
    for (let i = 0; i < 16; i++) {
      const z = -i * 34 - 12;
      const l = this.world.add({ mesh: tree, position: new Vec3(-8.5, 0, z), scale: new Vec3(2, 2, 2), isStatic: true });
      l.bounds = treeAabb;
      const useTree = i % 2 === 1;
      const r = this.world.add({ mesh: useTree ? tree : rock, position: new Vec3(8.5, 0, z), scale: new Vec3(2, 2, 2), isStatic: true });
      r.bounds = useTree ? treeAabb : rockAabb;
    }

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

    this.reset();
    ctx.engine.scene3d = this.world;
  }

  reset() {
    this.x = 0;
    this.z = 0;
    this.heading = 0;
    this.speed = 0;
    this.roll = 0;
    this.steer = 0;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    this.fps.sample();
    const inp = ctx.input;
    if (inp.pressed(Btn.Start)) this.reset();

    if (inp.held(Btn.Cross)) this.speed += 14 * ctx.dt;
    else this.speed -= 7 * ctx.dt;
    this.speed = clamp(this.speed, 0, 26);

    // Steering authority scales with speed (bicycle model, as in racing3d).
    const steerInput = inp.dir().x;
    this.steer = steerInput * MAX_STEER;
    this.heading += steerInput * Math.min(this.speed, 10) * 0.12 * ctx.dt;

    const fwdX = dsin(this.heading);
    const fwdZ = -dcos(this.heading);
    this.x += fwdX * this.speed * ctx.dt;
    this.z += fwdZ * this.speed * ctx.dt;
    this.x = clamp(this.x, -7.5, 7.5);

    // Wheel roll: arc length / radius. Spin all four; steer the front pair.
    this.roll += (this.speed / WHEEL_RADIUS) * ctx.dt;
    const rollQ = Quat.fromAxisAngle(new Vec3(1, 0, 0), this.roll);
    const steerQ = Quat.fromAxisAngle(new Vec3(0, 1, 0), this.steer);
    for (const w of this.wheels) {
      w.node.rotation = w.front ? steerQ.multiply(rollQ) : rollQ;
    }

    this.car.position = new Vec3(this.x, 0, this.z);
    this.car.rotation = Quat.fromEuler(0, this.heading, 0);

    // Chase camera: behind + above, looking ahead of the car.
    const eye = new Vec3(this.x - fwdX * 7, 3.4, this.z - fwdZ * 7);
    const look = new Vec3(this.x + fwdX * 6, 0.9, this.z + fwdZ * 6);
    this.world.camera.lookAt(eye, look, new Vec3(0, 1, 0));
  }

  /** @param {Graphics} g */
  draw(g) {
    const kmh = Math.round(this.speed * 7.2);
    g.text('CAR 3D', 8, 8, Colors.white, 2);
    if (this.fps.value > 0) g.text(this.fps.value + ' FPS', 410, 8, Colors.yellow, 1);
    g.text(kmh + ' KM/H', 8, 246, Colors.yellow, 2);
    g.rect(8, 234, 160, 6, rgb(40, 40, 40));
    g.rect(8, 234, Math.round((this.speed / 26) * 160), 6, Colors.green);
  }
}

start(() => new CarScene());
