// @ts-check
// @title Room FPS 3D
// @order 12
// @controls UP/DOWN move; LEFT/RIGHT turn; CROSS shoot; START reset
// fps3d.js — a single-room first-person shooter. The first-person camera, AABB
// wall collision, and hitscan ray/AABB tests are ALL pure deterministic JS (the
// "logic is one shared copy" proof); the room is one static mesh animated only by
// the camera matrix. The crosshair + ammo/score are a 2D HUD over the 3D pass.
import {
  start, Scene, Scene3D, Mesh, Vec3, Colors, rgb, Btn,
} from '../src/index';
import { CharController, Collide } from '../src/controller';
import { ActionMap } from '../src/action';

/** @import { UpdateContext, Graphics, Node3D } from '../src/index' */

const HALF = 9; // movable half-extent inside the 10-half room (0.5 player radius + margin)

const TARGET_POS = [
  new Vec3(-6, 1, -6), new Vec3(6, 1, -6),
  new Vec3(-6, 1, 6), new Vec3(6, 1, 6), new Vec3(0, 1.5, -8),
];

class FpsScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {{ node: Node3D, c: Vec3, alive: boolean }[]} */ targets = [];
  /** @type {CharController} */ ctrl = /** @type {any} */ (null);
  /** @type {ActionMap} */ act = /** @type {any} */ (null);
  ammo = 0;
  score = 0;

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    this.world.camera.setPerspective(70, 480 / 272, 0.1, 100);

    // The room: a box viewed from inside (no culling, so the inner faces show).
    // faces: +X,-X,+Y(ceiling),-Y(floor),+Z,-Z.
    const room = Mesh.box(20, 6, 20, [
      rgb(70, 90, 130), rgb(70, 90, 130),
      rgb(120, 130, 150), rgb(40, 44, 54),
      rgb(80, 100, 140), rgb(80, 100, 140),
    ]);
    this.world.add({ mesh: room, position: new Vec3(0, 3, 0) });

    // Shootable targets (a shared cube mesh).
    const tgt = Mesh.box(1, 1, 1, Mesh.solid(rgb(230, 210, 70)));
    this.targets = TARGET_POS.map((c) => ({
      node: this.world.add({ mesh: tgt, position: c }),
      c,
      alive: true,
    }));

    // Turret-style controller: yaw turn (1.6), gated forward/back (4), forward = -Z,
    // first-person camera at eye height 1.6. AABB room clamp + ray hitscan use Collide.
    this.ctrl = new CharController(
      { speed: 'gated', walkSpeed: 4, backSpeed: 4, turnRate: 1.6, fwdSignZ: -1 },
      { mode: 'fps', eyeHeight: 1.6 },
    );
    // Per-axis actions: TURN reads lx (else Left/Right), MOVE reads ly (else
    // Up/Down). On the digital golden path this is exactly the old inp.axis().x /
    // -inp.axis().y; on an analog host each axis falls back independently (vs
    // Input.axis()'s whole-vector suppression) — an analog-only nuance.
    this.act = new ActionMap(ctx.input, {
      TURN: { axis: 'lx', axisButtons: [Btn.Left, Btn.Right] },
      MOVE: { axis: 'ly', axisButtons: [Btn.Up, Btn.Down] },
      FIRE: { buttons: [Btn.Cross] },
      RESET: { buttons: [Btn.Start] },
    });
    this.reset();
    ctx.engine.scene3d = this.world;
  }

  reset() {
    const s = this.ctrl.s;
    s.x = 0; s.z = 0; s.heading = 0; s.speed = 0;
    this.ammo = 12;
    this.score = 0;
    for (const t of this.targets) {
      t.alive = true;
      t.node.visible = true;
    }
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    const act = this.act;
    if (act.pressed('RESET')) this.reset();

    // TURN (Left/Right) + MOVE (Up=forward) along the facing direction.
    this.ctrl.step({ throttle: -act.axis('MOVE'), steer: act.axis('TURN'), pitch: 0, run: false }, ctx.dt);
    Collide.clampBox(this.ctrl.s, -HALF, HALF, -HALF, HALF);
    const s = this.ctrl.s;
    this.ctrl.applyCam(this.world.camera);

    // Hitscan: ray from the eye along the facing direction; kill nearest target.
    if (act.pressed('FIRE') && this.ammo > 0) {
      this.ammo--;
      let bestT = Infinity;
      let best = null;
      for (const t of this.targets) {
        if (!t.alive) continue;
        const hit = Collide.rayAabb(s.x, 1.6, s.z, s.fwdX, 0, s.fwdZ, t.c.x, t.c.y, t.c.z, 0.6, 0.6, 0.6);
        if (hit > 0 && hit < bestT) { bestT = hit; best = t; }
      }
      if (best) {
        best.alive = false;
        best.node.visible = false;
        this.score++;
      }
    }
  }

  /** @param {Graphics} g */
  draw(g) {
    // Crosshair at screen center.
    const cx = 240;
    const cy = 136;
    g.rect(cx - 6, cy - 1, 12, 2, Colors.white);
    g.rect(cx - 1, cy - 6, 2, 12, Colors.white);

    g.text('ROOM FPS', 8, 8, Colors.white, 2);
    g.text('AMMO ' + this.ammo, 8, 246, Colors.cyan, 2);
    g.text('HITS ' + this.score, 360, 246, Colors.yellow, 2);
  }
}

start(() => new FpsScene());
