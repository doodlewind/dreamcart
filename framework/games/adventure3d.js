// @ts-check
// @title Tactical 3D
// @order 16
// @controls UP/CROSS walk; SQUARE run; LEFT/RIGHT turn; DOWN back; START reset
// adventure3d.js — a compact tactical walking demo: static arena map, cover,
// simple collision, and a skinned soldier character on the native PSP skin path.
import {
  start, Scene, Scene3D, Node3D, Mesh, SkinnedMesh,
  Vec3, Quat, Colors, rgb, Btn, HALF_PI, CharController, Collide,
} from '../src/index';
import { THREE_SOLDIER } from '../src/assets-three-soldier';

/** @import { UpdateContext, Graphics } from '../src/index' */

const WALL = [rgb(104, 109, 111), rgb(82, 87, 90), rgb(138, 142, 140), rgb(55, 58, 60), rgb(92, 96, 98), rgb(72, 76, 78)];
const FLOOR = [rgb(74, 74, 70), rgb(64, 64, 61), rgb(94, 91, 82), rgb(48, 48, 46), rgb(78, 76, 70), rgb(58, 58, 55)];
const CRATE = [rgb(132, 98, 55), rgb(98, 70, 42), rgb(155, 121, 72), rgb(82, 57, 36), rgb(120, 86, 48), rgb(94, 65, 39)];
const METAL = [rgb(86, 100, 112), rgb(63, 75, 86), rgb(118, 130, 138), rgb(43, 49, 54), rgb(76, 88, 98), rgb(56, 65, 72)];
const TARGET = [rgb(168, 62, 45), rgb(114, 45, 38), rgb(205, 96, 60), rgb(70, 32, 29), rgb(148, 55, 44), rgb(96, 38, 34)];

class TacticalScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {SkinnedMesh} */ soldier = /** @type {any} */ (null);
  /** @type {Node3D} */ actor = /** @type {any} */ (null);
  /** @type {{ minX: number, maxX: number, minZ: number, maxZ: number }[]} */
  blockers = [];
  /** @type {CharController} */ ctrl = /** @type {any} */ (null);
  fps = 0;
  _lastNow = 0;
  _accUs = 0;
  _frames = 0;

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    this.world.camera.setPerspective(62, 480 / 272, 0.08, 92);

    this.world.fog = { color: rgb(27, 31, 34), near: 34, far: 62 };

    this.buildArena();

    // Gated walk/run/back (3.0/6.4/-2.2) + 2.15 turn, forward +Z; chase rig at
    // eyeY 3.4 / lookY 1.35, dist 7.2, lookahead 2.4. AABB slide vs blockers (r .38)
    // + arena clamp ±17.4 below replace the bespoke blocked()/moveTo().
    this.ctrl = new CharController(
      { speed: 'gated', walkSpeed: 3.0, runSpeed: 6.4, backSpeed: 2.2, turnRate: 2.15, fwdSignZ: 1 },
      { mode: 'chase', dist: 7.2, lookahead: 2.4, eyeY: 3.4, lookY: 1.35 },
      { x: -11.5, z: 12.0, heading: -0.22 },
    );

    this.soldier = SkinnedMesh.fromBaked(THREE_SOLDIER);
    this.soldier.play(THREE_SOLDIER.clips.Walk);
    this.actor = this.world.add({
      position: new Vec3(this.ctrl.s.x, 0, this.ctrl.s.z),
      rotation: Quat.fromEuler(0, this.ctrl.s.heading, 0),
    });
    this.actor.add(new Node3D({
      skinned: this.soldier,
      rotation: Quat.fromEuler(-HALF_PI, 0, 0),
      scale: new Vec3(THREE_SOLDIER.scale, THREE_SOLDIER.scale, THREE_SOLDIER.scale),
    }));

    this.reset();
    ctx.engine.scene3d = this.world;
  }

  buildArena() {
    this.addBox(0, -0.08, 0, 38, 0.16, 38, FLOOR, false);
    this.addBox(0, 1.55, -18.6, 38.8, 3.1, 0.85, WALL);
    this.addBox(0, 1.55, 18.6, 38.8, 3.1, 0.85, WALL);
    this.addBox(-18.6, 1.55, 0, 0.85, 3.1, 38.8, WALL);
    this.addBox(18.6, 1.55, 0, 0.85, 3.1, 38.8, WALL);

    this.addBox(-10.8, 1.25, -5.8, 14.8, 2.5, 0.7, WALL);
    this.addBox(9.8, 1.25, -5.8, 12.8, 2.5, 0.7, WALL);
    this.addBox(-6.2, 1.25, 7.0, 0.7, 2.5, 16.0, WALL);
    this.addBox(7.2, 1.25, 5.8, 0.7, 2.5, 13.6, WALL);
    this.addBox(0.5, 1.25, 7.8, 6.7, 2.5, 0.7, WALL);
    this.addBox(-12.5, 1.25, 3.2, 5.0, 2.5, 0.7, WALL);
    this.addBox(13.4, 1.25, -0.8, 0.7, 2.5, 8.6, WALL);

    this.addCrates(-2.4, 0.55, 1.1, 0.15, 3);
    this.addCrates(11.8, 0.55, 10.4, -0.45, 3);
    this.addCrates(-13.6, 0.55, -12.0, 0.65, 2);
    this.addBox(2.7, 0.75, -12.4, 3.4, 1.5, 1.2, METAL);
    this.addBox(5.8, 0.55, -12.1, 1.2, 1.1, 1.2, TARGET);
    this.addBox(14.2, 0.75, 4.8, 1.5, 1.5, 3.5, METAL);
    this.addBox(-9.8, 0.35, 13.4, 4.2, 0.7, 1.2, TARGET);
  }

  /**
   * @param {number} x @param {number} y @param {number} z
   * @param {number} w @param {number} h @param {number} d
   * @param {number[]} colors
   * @param {boolean} solid
   */
  addBox(x, y, z, w, h, d, colors, solid = true) {
    const node = new Node3D({
      mesh: Mesh.box(w, h, d, colors),
      position: new Vec3(x, y, z),
      isStatic: true,
    });
    node.bounds = { min: [-w / 2, -h / 2, -d / 2], max: [w / 2, h / 2, d / 2] };
    this.world.add(node);
    if (solid) {
      this.blockers.push({
        minX: x - w / 2,
        maxX: x + w / 2,
        minZ: z - d / 2,
        maxZ: z + d / 2,
      });
    }
  }

  /** @param {number} x @param {number} y @param {number} z @param {number} yaw @param {number} count */
  addCrates(x, y, z, yaw, count) {
    for (let i = 0; i < count; i++) {
      const sx = x + (i % 2) * 1.15;
      const sz = z + ((i / 2) | 0) * 1.05;
      const node = new Node3D({
        mesh: Mesh.box(1.05, 1.1, 1.05, CRATE),
        position: new Vec3(sx, y + (i === 2 ? 0.55 : 0), sz),
        rotation: Quat.fromEuler(0, yaw + i * 0.2, 0),
        isStatic: true,
      });
      node.bounds = { min: [-0.75, -0.65, -0.75], max: [0.75, 0.65, 0.75] };
      this.world.add(node);
      this.blockers.push({ minX: sx - 0.7, maxX: sx + 0.7, minZ: sz - 0.7, maxZ: sz + 0.7 });
    }
  }

  reset() {
    const s = this.ctrl.s;
    s.x = -11.5; s.z = 12.0; s.heading = -0.22; s.speed = 0;
    this.soldier.play(THREE_SOLDIER.clips.Walk);
  }

  measureFps() {
    const host = /** @type {any} */ (globalThis);
    if (typeof host.now !== 'function') return;
    const t = host.now();
    if (this._lastNow) {
      this._accUs += t - this._lastNow;
      this._frames++;
      if (this._accUs >= 1e6) {
        this.fps = Math.round((this._frames * 1e6) / this._accUs);
        this._accUs = 0;
        this._frames = 0;
      }
    }
    this._lastNow = t;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    this.measureFps();
    const inp = ctx.input;
    if (inp.pressed(Btn.Start)) this.reset();

    const forward = inp.held(Btn.Up) || inp.held(Btn.Cross);
    const back = inp.held(Btn.Down);
    const run = inp.held(Btn.Square);
    // Capture the pre-step position so slideAabb can revert into a blocker (it is
    // the moveTo "old"); then step, clamp the target to the arena, slide. This is
    // the exact clamp-then-X-then-Z order the bespoke moveTo() used.
    const px = this.ctrl.s.x, pz = this.ctrl.s.z;
    this.ctrl.step({
      throttle: forward ? 1 : back ? -1 : 0,
      steer: (inp.held(Btn.Left) ? 1 : 0) - (inp.held(Btn.Right) ? 1 : 0),
      pitch: 0,
      run,
    }, ctx.dt);
    Collide.clampBox(this.ctrl.s, -17.4, 17.4, -17.4, 17.4);
    Collide.slideAabb(this.ctrl.s, px, pz, 0.38, this.blockers);
    const s = this.ctrl.s;

    // Clip + phase advance stay game-specific (Idle anim advances at 1×; Walk/Run
    // at a fixed 1.0/1.4 model, not a speed ratio).
    const clip = s.speed === 0 ? THREE_SOLDIER.clips.Idle : run ? THREE_SOLDIER.clips.Run : THREE_SOLDIER.clips.Walk;
    if (this.soldier.player.clip !== clip) this.soldier.play(clip);
    this.soldier.player.advance(s.speed !== 0 ? ctx.dt * (run ? 1.4 : 1.0) : ctx.dt);

    this.actor.position = new Vec3(s.x, 0, s.z);
    this.actor.rotation = Quat.fromEuler(0, s.heading, 0);
    this.ctrl.applyCam(this.world.camera);
  }

  /** @param {Graphics} g */
  draw(g) {
    const total = this.world.root.children.length;
    const drawn = total - this.world.culledCount;
    g.text('TACTICAL 3D', 8, 8, Colors.white, 1);
    g.text('arena ' + drawn + '/' + total, 8, 246, Colors.cyan, 1);
    if (this.fps > 0) g.text(this.fps + ' FPS', 410, 8, Colors.yellow, 1);
    g.text('Soldier.glb MIT', 8, 258, Colors.gray, 1);
  }
}

start(() => new TacticalScene());
