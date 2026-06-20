// @ts-check
// @title RPG Battle 3D
// @order 17
// @controls UP/DOWN choose; CROSS confirm; CIRCLE cancel; START reset
// rpgbattle3d.js — a 2.5D turn-based JRPG duel. A real 3D arena + two skinned KayKit
// Knight instances (hero tinted blue, enemy red) rendered with a fixed 3/4 camera; a
// classic command-menu turn loop with HP/MP, Attack/Skill/Defend/Item, crits, and
// floating damage numbers. Everything is deterministic — fixed timestep, ctx.rng for all
// chance, frame timers for all motion — so it has a byte-stable golden.
//
// Knight model: KayKit "Character Pack: Adventurers" by Kay Lousberg — CC0 (public
// domain). See assets/vendor/CREDITS.md. One model is baked + instanced twice.
import {
  start, Scene, Scene3D, Mesh, TexMeshBuilder, SkinnedMesh, Lighting, DirectionalLight,
  Material, Texture, Vec3, Quat, Colors, rgb, Btn, dsin, HALF_PI, PI,
} from '../src/index';
import { RPG_HERO } from '../src/assets-rpg-hero';
import { VFX_BOOM, VFX_SPARK } from '../src/assets-vfx';

/** @import { UpdateContext, Graphics, Node3D } from '../src/index' */
/** @typedef {{ hp: number, mp: number, atk: number, def: number, spd: number }} Stats */
/** @typedef {{ key: string, power: number, mp: number }} Action */

const CLIP = RPG_HERO.clips;
const PHASE = { INTRO: 'intro', PLAYER: 'player', ENEMY: 'enemy', WINDUP: 'windup', IMPACT: 'impact', RECOVER: 'recover', WIN: 'win', LOSE: 'lose' };
const DUR = { INTRO: 60, ENEMY: 20, WINDUP: 12, RECOVER: 24, END: 90 };
const LUNGE = DUR.WINDUP + 1 + DUR.RECOVER; // frames the attacker is lunged

/** @param {number} v @param {number} a @param {number} b */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** Lerp two 0xRRGGBB colors. @param {number} a @param {number} b @param {number} t */
function mix(a, b, t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((ar + (br - ar) * t) | 0) << 16 | ((ag + (bg - ag) * t) | 0) << 8 | ((ab + (bb - ab) * t) | 0);
}

/** A unit camera-facing quad (XY plane, +Z) with UVs + white verts, for additive VFX. */
function billboardQuad() {
  const b = new TexMeshBuilder({ uv: true, normal: false });
  const w = 0xffffff;
  const a = b.vertex(-0.5, -0.5, 0, w, 0, 1), c = b.vertex(0.5, -0.5, 0, w, 1, 1), d = b.vertex(0.5, 0.5, 0, w, 1, 0), e = b.vertex(-0.5, 0.5, 0, w, 0, 0);
  b.tri(a, c, d); b.tri(a, d, e);
  return b.build();
}

/** A fighter: stats + its skinned model node + the home position it lunges from. */
class Fighter {
  /** @param {string} name @param {Stats} s @param {number} tint @param {number} x @param {number} faceYaw */
  constructor(name, s, tint, x, faceYaw) {
    this.name = name;
    this.maxHp = s.hp; this.hp = s.hp;
    this.maxMp = s.mp; this.mp = s.mp;
    this.atk = s.atk; this.def = s.def; this.spd = s.spd;
    this.potions = 3;
    this.defending = false;
    this.acted = false;
    this.tint = tint;
    this.homeX = x;
    this.faceYaw = faceYaw;
    /** @type {SkinnedMesh} */ this.skin = SkinnedMesh.fromBaked(RPG_HERO);
    this.skin.play(CLIP.Idle);
    /** @type {Node3D} */ this.node = /** @type {any} */ (null);
    this.clip = CLIP.Idle;
    this.dead = false;
  }
  get alive() { return this.hp > 0; }
  /** @param {any} clip */
  play(clip) { if (this.skin.player.clip !== clip) { this.skin.play(clip); this.clip = clip; } }
}

const ACTIONS = [
  { key: 'Attack', power: 1.0, mp: 0 },
  { key: 'Power Strike', power: 1.8, mp: 8 },
  { key: 'Defend', power: 0, mp: 0 },
  { key: 'Potion', power: 0, mp: 0 },
];

class BattleScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {Fighter} */ hero = /** @type {any} */ (null);
  /** @type {Fighter} */ enemy = /** @type {any} */ (null);
  phase = PHASE.INTRO;
  timer = DUR.INTRO;
  cursor = 0;
  /** @type {Fighter[]} */ order = [];
  turnIdx = 0;
  /** @type {Fighter} */ actor = /** @type {any} */ (null);
  /** @type {Fighter} */ target = /** @type {any} */ (null);
  /** @type {Action} */ pending = ACTIONS[0];
  actionFrame = 0;
  shake = 0;
  flash = 0;
  frame = 0;
  msg = '';
  /** @type {any} */ rng = null; // ctx.rng, captured each update
  hitStop = 0; // freeze the turn FSM for a few frames on impact (juice)
  /** @type {any} */ vfxNode = null;
  /** @type {Material} */ vfxMat = /** @type {any} */ (null);
  boomTex = /** @type {Texture[]} */ ([]);
  sparkTex = /** @type {Texture[]} */ ([]);
  vfx = { on: false, t: 0, tex: /** @type {Texture[]} */ ([]), x: 0, y: 1.5, scale: 1 };
  screenFlash = 0;
  /** @type {{x:number,y:number,vy:number,life:number,text:string,color:number}[]} */ dmgNums = [];

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    this.world.camera.setPerspective(56, 480 / 272, 0.08, 120);
    this.world.fog = { color: rgb(20, 24, 34), near: 34, far: 70 };
    const lighting = new Lighting(0x3a3a44);
    lighting.add(new DirectionalLight(new Vec3(-0.4, -1, -0.35), 0xfff0d0));
    this.world.lighting = lighting;

    // Arena: a ground slab + a few static cover blocks for 2.5D depth (all static ->
    // uploaded once + natively culled; only the 2 fighters are per-frame dynamic).
    const floor = rgb(58, 54, 48), floorSide = rgb(40, 37, 33);
    this.world.add({ mesh: Mesh.box(46, 0.5, 30, [floor, floorSide, floorSide, floorSide, floorSide, floorSide]), position: new Vec3(0, -0.25, 0), isStatic: true });
    const stone = rgb(70, 66, 60), stoneDark = rgb(48, 45, 41);
    const sc = [stone, stoneDark, stoneDark, stoneDark, stoneDark, stoneDark];
    for (const [x, z, h] of [[-9, -7, 1.6], [10, -6, 2.2], [-2, -10, 1.2], [6, -11, 1.8], [-13, 3, 1.4], [13, 4, 1.6]]) {
      this.world.add({ mesh: Mesh.box(2.2, h, 2.2, sc), position: new Vec3(x, h / 2, z), isStatic: true });
    }

    // The two fighters (same model, instanced + tinted). Y-up, feet at Y=0.
    this.hero = new Fighter('Knight', { hp: 120, mp: 24, atk: 22, def: 12, spd: 14 }, rgb(120, 150, 230), -4.2, HALF_PI);
    this.enemy = new Fighter('Dark Knight', { hp: 90, mp: 10, atk: 18, def: 9, spd: 11 }, rgb(220, 90, 80), 4.2, -HALF_PI);
    for (const f of [this.hero, this.enemy]) {
      f.node = this.world.add({ skinned: f.skin, position: new Vec3(f.homeX, 0, 0), rotation: Quat.fromEuler(0, f.faceYaw, 0), scale: new Vec3(RPG_HERO.scale, RPG_HERO.scale, RPG_HERO.scale), tint: f.tint });
    }

    // Additive VFX billboard (one reusable quad; texture swapped per frame). Textures
    // upload once. blend:'add' makes the premultiplied frames glow over the scene.
    this.boomTex = VFX_BOOM.frames.map((px) => new Texture(px, VFX_BOOM.w, VFX_BOOM.h));
    this.sparkTex = VFX_SPARK.frames.map((px) => new Texture(px, VFX_SPARK.w, VFX_SPARK.h));
    this.vfxMat = new Material({ blend: 'add' });
    this.vfxNode = this.world.add({ mesh: billboardQuad(), material: this.vfxMat });
    this.vfxNode.visible = false;

    // Fixed 2.5D 3/4 camera framing both fighters.
    this.world.camera.lookAt(new Vec3(0, 5.2, 11), new Vec3(0, 1.6, -1), new Vec3(0, 1, 0));
    ctx.engine.scene3d = this.world;
    this.reset();
  }

  reset() {
    for (const f of [this.hero, this.enemy]) {
      f.hp = f.maxHp; f.mp = f.maxMp; f.potions = 3; f.defending = false; f.acted = false; f.dead = false;
      f.play(CLIP.Idle); f.skin.player.time = 0;
    }
    this.phase = PHASE.INTRO; this.timer = DUR.INTRO; this.cursor = 0;
    this.dmgNums.length = 0; this.shake = 0; this.flash = 0; this.msg = 'A Dark Knight blocks the way!';
  }

  // ───────────────────────── turn flow ─────────────────────────
  startRound() {
    for (const f of [this.hero, this.enemy]) { f.acted = false; f.defending = false; }
    // SPD desc; hero wins ties (deterministic ordering).
    this.order = [this.hero, this.enemy].sort((a, b) => (b.spd - a.spd) || (a === this.hero ? -1 : 1));
    this.turnIdx = 0;
    this.dispatch();
  }

  dispatch() {
    // next living, not-yet-acted fighter in initiative order
    while (this.turnIdx < this.order.length && (this.order[this.turnIdx].acted || !this.order[this.turnIdx].alive)) this.turnIdx++;
    if (this.turnIdx >= this.order.length) { this.startRound(); return; }
    const who = this.order[this.turnIdx];
    if (who === this.hero) { this.phase = PHASE.PLAYER; this.cursor = this.firstEnabledRow(); this.msg = 'Choose an action.'; }
    else { this.phase = PHASE.ENEMY; this.timer = DUR.ENEMY; this.actor = this.enemy; this.target = this.hero; }
  }

  /** @param {Fighter} actor @param {Fighter} target @param {Action} action */
  beginAction(actor, target, action) {
    this.actor = actor; this.target = target; this.pending = action; this.actionFrame = 0;
    actor.defending = false;
    if (action.key === 'Defend') { actor.defending = true; this.msg = actor.name + ' braces!'; this.afterAction(); return; }
    if (action.key === 'Potion') {
      actor.potions--; const heal = Math.min(actor.maxHp, actor.hp + 40) - actor.hp; actor.hp += heal;
      this.addDmgNum(actor, '+' + heal, Colors.green); this.msg = actor.name + ' drinks a Potion.'; this.afterAction(); return;
    }
    actor.mp -= action.mp;
    actor.play(CLIP['1H_Melee_Attack_Chop']); actor.skin.player.time = 0;
    this.msg = actor.name + (action.key === 'Attack' ? ' attacks!' : ' uses ' + action.key + '!');
    this.phase = PHASE.WINDUP; this.timer = DUR.WINDUP;
  }

  resolveImpact() {
    const { dmg, crit } = this.damage(this.actor, this.target, this.pending.power);
    this.target.hp = Math.max(0, this.target.hp - dmg);
    this.addDmgNum(this.target, (crit ? '!' : '') + dmg, crit ? Colors.yellow : Colors.white);
    this.target.play(CLIP.Hit_A); this.target.skin.player.time = 0;
    this.shake = crit ? 11 : 8; this.flash = 1; this.hitStop = crit ? 5 : 3; this.screenFlash = crit ? 3 : 2;
    // additive explosion at the target's chest; spark accent on a crit
    this.vfx = { on: true, t: 0, tex: this.boomTex, x: this.target.homeX, y: 2.0, scale: crit ? 6.0 : 4.8 };
    this.msg = (crit ? 'Critical! ' : '') + dmg + ' damage!';
    this.phase = PHASE.IMPACT; this.timer = 1;
  }

  /** @param {Fighter} a @param {Fighter} t @param {number} power */
  damage(a, t, power) {
    const def = t.defending ? t.def * 2 : t.def;
    const base = Math.max(1, Math.floor(a.atk * power) - def);
    const variance = 0.85 + this.rng.next() * 0.30;          // 1st draw
    let dmg = Math.max(1, Math.floor(base * variance));
    const crit = this.rng.chance(0.125);                     // 2nd draw (always)
    if (crit) dmg = Math.floor(dmg * 1.5);
    return { dmg, crit };
  }

  /** Pick + run the enemy's action (deterministic). */
  enemyAct() {
    let action = ACTIONS[0];
    if (this.enemy.hp < this.enemy.maxHp * 0.30 && this.rng.chance(0.5)) action = ACTIONS[2];      // Defend
    else if (this.enemy.mp >= 8 && this.rng.chance(0.4)) action = ACTIONS[1];                       // Power Strike
    this.beginAction(this.enemy, this.hero, action);
  }

  afterAction() {
    // death check, then next actor / next round
    if (!this.enemy.alive) { this.enemy.play(CLIP.Death_A); this.enemy.dead = true; this.phase = PHASE.WIN; this.timer = DUR.END; this.msg = 'Victory!'; return; }
    if (!this.hero.alive) { this.hero.play(CLIP.Death_A); this.hero.dead = true; this.phase = PHASE.LOSE; this.timer = DUR.END; this.msg = 'Defeat...'; return; }
    if (this.actor) this.actor.acted = true;
    this.turnIdx++;
    this.dispatch();
  }

  // ───────────────────────── menu helpers ─────────────────────────
  /** @param {number} row */
  rowEnabled(row) {
    if (row === 1) return this.hero.mp >= ACTIONS[1].mp;
    if (row === 3) return this.hero.potions > 0;
    return true;
  }
  firstEnabledRow() { for (let r = 0; r < 4; r++) if (this.rowEnabled(r)) return r; return 0; }
  /** @param {number} dir */
  moveCursor(dir) { let r = this.cursor; for (let i = 0; i < 4; i++) { r = (r + dir + 4) % 4; if (this.rowEnabled(r)) { this.cursor = r; return; } } }

  /** @param {Fighter} f @param {string} text @param {number} color */
  addDmgNum(f, text, color) {
    const sx = f === this.hero ? 150 : 350; // approx screen anchor over each fighter
    this.dmgNums.push({ x: sx, y: 120, vy: -0.7, life: DUR.RECOVER, text, color });
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    this.frame++;
    this.rng = ctx.rng;
    const inp = ctx.input;
    if (inp.pressed(Btn.Start)) { this.reset(); return; }

    // advance all skinned poses (Idle loops; one-shots are reset on play)
    for (const f of [this.hero, this.enemy]) f.skin.player.advance(ctx.dt);
    // floating damage numbers
    for (const d of this.dmgNums) { d.y += d.vy; d.life--; }
    this.dmgNums = this.dmgNums.filter((d) => d.life > 0);
    if (this.shake > 0.05) this.shake *= 0.8; else this.shake = 0;
    if (this.flash > 0.02) this.flash *= 0.85; else this.flash = 0;
    this.updateLunge();

    // advance the additive VFX billboard (frame-stepped at ~28 fps, at the target)
    if (this.vfx.on) {
      this.vfx.t += ctx.dt;
      const fr = Math.floor(this.vfx.t * 28);
      if (fr >= this.vfx.tex.length) { this.vfx.on = false; this.vfxNode.visible = false; }
      else { this.vfxNode.visible = true; this.vfxMat.texture = this.vfx.tex[fr]; this.vfxNode.position = new Vec3(this.vfx.x, this.vfx.y, 0.3); this.vfxNode.scale = new Vec3(this.vfx.scale, this.vfx.scale, this.vfx.scale); }
    }
    if (this.screenFlash > 0) this.screenFlash--;
    if (this.hitStop > 0) { this.hitStop--; return; } // freeze the turn FSM during hit-stop

    switch (this.phase) {
      case PHASE.INTRO:
        if (--this.timer <= 0) this.startRound();
        break;
      case PHASE.PLAYER:
        if (inp.pressed(Btn.Up)) this.moveCursor(-1);
        else if (inp.pressed(Btn.Down)) this.moveCursor(1);
        else if (inp.pressed(Btn.Cross)) { if (this.rowEnabled(this.cursor)) this.beginAction(this.hero, this.enemy, ACTIONS[this.cursor]); }
        break;
      case PHASE.ENEMY:
        if (--this.timer <= 0) this.enemyAct();
        break;
      case PHASE.WINDUP:
        if (--this.timer <= 0) this.resolveImpact();
        break;
      case PHASE.IMPACT:
        if (--this.timer <= 0) { this.phase = PHASE.RECOVER; this.timer = DUR.RECOVER; }
        break;
      case PHASE.RECOVER:
        if (--this.timer <= 0) {
          if (this.actor && this.actor.alive && !this.actor.dead) this.actor.play(CLIP.Idle);
          if (this.target && this.target.alive && !this.target.dead) this.target.play(CLIP.Idle);
          this.afterAction();
        }
        break;
      case PHASE.WIN: case PHASE.LOSE:
        if (this.timer > 0) this.timer--; // terminal; hold the banner (golden-stable)
        break;
    }
  }

  // lunge the acting fighter toward its target during WINDUP+IMPACT+RECOVER
  updateLunge() {
    const lunging = this.phase === PHASE.WINDUP || this.phase === PHASE.IMPACT || this.phase === PHASE.RECOVER;
    for (const f of [this.hero, this.enemy]) {
      let dx = 0;
      if (lunging && f === this.actor) { this.actionFrame++; const p = clamp(this.actionFrame / LUNGE, 0, 1); dx = (this.target.homeX > f.homeX ? 1 : -1) * 2.6 * dsin(p * PI); }
      f.node.position = new Vec3(f.homeX + dx, 0, 0);
      // hit-flash tint
      const t = (f === this.target && (this.phase === PHASE.IMPACT || this.phase === PHASE.RECOVER)) ? this.flash : 0;
      f.node.setTint(mix(f.tint, 0xffffff, t * 0.8));
    }
  }

  // ───────────────────────── HUD ─────────────────────────
  /** @param {Graphics} g */
  draw(g) {
    // enemy nameplate + HP (top-right)
    this.bar(g, 300, 18, 168, this.enemy, true);
    // message line
    g.rect(0, 208, 480, 18, Colors.dark); g.text(this.msg, 8, 212, Colors.white, 1);
    // command window (player turn only)
    if (this.phase === PHASE.PLAYER) {
      g.rect(0, 226, 150, 46, Colors.dark); g.rectOutline(0, 226, 150, 46, Colors.white, 1);
      for (let r = 0; r < 4; r++) {
        const on = this.rowEnabled(r); const y = 230 + r * 10;
        if (r === this.cursor) g.text('>', 4, y, Colors.yellow, 1);
        g.text(ACTIONS[r].key + (r === 1 ? ' 8MP' : r === 3 ? ' x' + this.hero.potions : ''), 14, y, on ? Colors.white : Colors.gray, 1);
      }
    }
    // hero status (bottom-right)
    g.rect(150, 226, 330, 46, Colors.dark);
    g.text(this.hero.name, 160, 230, Colors.white, 1);
    this.bar(g, 160, 244, 150, this.hero, false);
    g.rect(160, 258, 140, 6, mix(0x101830, Colors.blue, 0.2));
    g.rect(160, 258, Math.round(140 * this.hero.mp / this.hero.maxMp), 6, Colors.blue);
    g.text('MP ' + this.hero.mp + '/' + this.hero.maxMp, 306, 256, Colors.cyan, 1);
    g.text('Potion x' + this.hero.potions, 388, 230, Colors.white, 1);
    // floating damage numbers
    for (const d of this.dmgNums) g.textCentered(d.text, d.x, d.y, d.color, 1);
    // banners
    if (this.phase === PHASE.WIN) g.textCentered('VICTORY', 240, 90, Colors.yellow, 3);
    if (this.phase === PHASE.LOSE) g.textCentered('DEFEAT', 240, 90, Colors.red, 3);
    // impact screen-edge flash (juice)
    if (this.screenFlash > 0) { const c = Colors.white; g.rect(0, 0, 480, 3, c); g.rect(0, 269, 480, 3, c); g.rect(0, 0, 3, 272, c); g.rect(477, 0, 3, 272, c); }
    g.text('RPG BATTLE 3D', 8, 8, Colors.white, 1);
    g.text('KayKit CC0  +  CC0 VFX', 8, 258, Colors.gray, 1);
  }

  /** Name + HP bar. @param {Graphics} g @param {number} x @param {number} y @param {number} w @param {Fighter} f @param {boolean} named */
  bar(g, x, y, w, f, named) {
    if (named) { g.text(f.name, x, y, Colors.white, 1); y += 10; }
    const frac = f.hp / f.maxHp;
    g.rect(x, y, w, 7, Colors.gray);
    g.rect(x, y, Math.round(w * frac), 7, mix(Colors.red, Colors.green, frac));
    g.text('HP ' + f.hp + '/' + f.maxHp, x + (named ? 0 : w - 78), named ? y + 9 : y - 10, Colors.white, 1);
  }
}

start(() => new BattleScene(), { seed: 7 });
