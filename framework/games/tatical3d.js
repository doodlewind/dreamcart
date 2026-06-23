// @ts-check
// @title Tactical 3D
// @order 16
// @controls UP/CROSS walk; SQUARE run; LEFT/RIGHT turn; DOWN back; START reset
// tatical3d.js — a compact tactical walking demo: static arena map, cover,
// simple collision, and a skinned soldier character on the native PSP skin path.
import {
  start, Scene, Node3D, SkinnedMesh,
  Vec3, Quat, Colors, Btn, HALF_PI, Fps,
} from '../src/index';
import { CharController, Collide } from '../src/controller';
import { ActionMap } from '../src/action';
import { loadScene } from '../src/scene-desc';
import { THREE_SOLDIER } from '../src/assets-three-soldier';

/** @import { UpdateContext, Graphics, Scene3D } from '../src/index' */

class TacticalScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {SkinnedMesh} */ soldier = /** @type {any} */ (null);
  /** @type {Node3D} */ actor = /** @type {any} */ (null);
  /** @type {{ minX: number, maxX: number, minZ: number, maxZ: number }[]} */
  blockers = [];
  /** @type {CharController} */ ctrl = /** @type {any} */ (null);
  /** @type {ActionMap} */ act = /** @type {any} */ (null);
  fps = new Fps();

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    // Static arena (floor, walls, cover, crates, metal/target boxes + camera + fog)
    // from the baked descriptor (framework/scenes/tatical3d.scene.ts). buildScene
    // preserves the old buildArena() placement order, while the floor/walls use
    // PSP-safe subdivision in the descriptor. The full literal key keeps build.ts
    // from tree-shaking the blobs.
    const built = loadScene('tatical3d');
    this.world = built.scene;
    // Harvest the arena's solid AABBs (the old buildArena() blockers, in order) into
    // the flat {minX,maxX,minZ,maxZ} form slideAabb expects (y is unused for the 2D
    // floor-plan slide).
    this.blockers = built.colliders.map((c) => ({
      minX: c.min[0], maxX: c.max[0], minZ: c.min[2], maxZ: c.max[2],
    }));

    // Gated walk/run/back (3.0/6.4/-2.2) + 2.15 turn, forward +Z; chase rig at
    // eyeY 3.4 / lookY 1.35, dist 7.2, lookahead 2.4. AABB slide vs blockers (r .38)
    // + arena clamp ±17.4 below replace the bespoke blocked()/moveTo().
    this.ctrl = new CharController(
      { speed: 'gated', walkSpeed: 3.0, runSpeed: 6.4, backSpeed: 2.2, turnRate: 2.15, fwdSignZ: 1 },
      { mode: 'chase', dist: 7.2, lookahead: 2.4, eyeY: 3.4, lookY: 1.35 },
      { x: -11.5, z: 12.0, heading: -0.22 },
    );
    // Named actions (data-driven input). Digital path is byte-identical to the old
    // raw-Btn reads: STEER's invert + [Left,Right] pair yields Left=+1/Right=-1 (the
    // arena's turn convention); analog steers the same way on a host that has a stick.
    this.act = new ActionMap(ctx.input, {
      FORWARD: { buttons: [Btn.Up, Btn.Cross] },
      BACK: { buttons: [Btn.Down] },
      RUN: { buttons: [Btn.Square] },
      STEER: { axis: 'lx', axisButtons: [Btn.Left, Btn.Right], invert: true },
      RESET: { buttons: [Btn.Start] },
    });

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

  reset() {
    const s = this.ctrl.s;
    s.x = -11.5; s.z = 12.0; s.heading = -0.22; s.speed = 0;
    this.soldier.play(THREE_SOLDIER.clips.Walk);
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    this.fps.sample();
    const act = this.act;
    if (act.pressed('RESET')) this.reset();

    const forward = act.held('FORWARD');
    const back = act.held('BACK');
    const run = act.held('RUN');
    // Capture the pre-step position so slideAabb can revert into a blocker (it is
    // the moveTo "old"); then step, clamp the target to the arena, slide. This is
    // the exact clamp-then-X-then-Z order the bespoke moveTo() used.
    const px = this.ctrl.s.x, pz = this.ctrl.s.z;
    this.ctrl.step({
      throttle: forward ? 1 : back ? -1 : 0,
      steer: act.axis('STEER'),
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
    if (this.fps.value > 0) g.text(this.fps.value + ' FPS', 410, 8, Colors.yellow, 1);
    g.text('Soldier.glb MIT', 8, 258, Colors.gray, 1);
  }
}

start(() => new TacticalScene());
