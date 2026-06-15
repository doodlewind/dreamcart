// @ts-check
// @title Dodge
// @order 4
// @controls D-pad to dodge; START restart
// dodge.js — arena survival / dodge game.
// Move the hero with the d-pad. Dodge red hazards (slimes) flying across the
// arena; survive as long as you can. Grab yellow coins for bonus score.
// Game over freezes the field; press Start to restart.
import {
  start,
  Scene,
  Btn,
  Colors,
  rgb,
  SCREEN_W,
  SCREEN_H,
  SPRITES,
} from '../src/index';

/** @import { UpdateContext, Graphics } from '../src/index' */

// Hero sprite is 8x10 px; drawn at scale 2 => 16x20 on screen.
const HERO_W = 16;
const HERO_H = 20;
const HERO_SPEED = 2.4;

// A flying hazard (rendered as a slime sprite over a red glow).
/** @typedef {{x:number, y:number, vx:number, vy:number, r:number}} Hazard */

// A collectible coin.
/** @typedef {{x:number, y:number, r:number}} Coin */

// A short-lived particle for death/collect bursts.
/** @typedef {{x:number, y:number, vx:number, vy:number, life:number, color:number}} Particle */

class RootScene extends Scene {
  px = 0;
  py = 0;
  /** @type {Hazard[]} */ hazards = [];
  /** @type {Coin[]} */ coins = [];
  /** @type {Particle[]} */ particles = [];
  bonus = 0; // bonus score from coins (in "frames" units)
  startFrame = 0; // frame the current run began
  deathFrame = -1; // frame of death, -1 while alive
  over = false;

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.reset(ctx);
  }

  /** @param {UpdateContext} ctx */
  reset(ctx) {
    this.px = (SCREEN_W - HERO_W) / 2;
    this.py = (SCREEN_H - HERO_H) / 2;
    this.hazards = [];
    this.coins = [];
    this.particles = [];
    this.bonus = 0;
    this.over = false;
    this.deathFrame = -1;
    this.startFrame = ctx.frame;
  }

  // Survival time in seconds plus coin bonus.
  /** @param {UpdateContext} ctx */
  score(ctx) {
    const aliveFrames = (this.over ? this.deathFrame : ctx.frame) - this.startFrame;
    return (aliveFrames + this.bonus) / 60;
  }

  // Spawn one hazard from a random edge aimed roughly inward.
  /** @param {UpdateContext} ctx */
  spawnHazard(ctx) {
    const speed = ctx.rng.range(1.4, 3.2);
    const edge = ctx.rng.int(4);
    /** @type {Hazard} */
    const h = { x: 0, y: 0, vx: 0, vy: 0, r: 7 };
    if (edge === 0) {
      // top
      h.x = ctx.rng.range(0, SCREEN_W);
      h.y = -10;
      h.vx = ctx.rng.range(-1, 1);
      h.vy = speed;
    } else if (edge === 1) {
      // bottom
      h.x = ctx.rng.range(0, SCREEN_W);
      h.y = SCREEN_H + 10;
      h.vx = ctx.rng.range(-1, 1);
      h.vy = -speed;
    } else if (edge === 2) {
      // left
      h.x = -10;
      h.y = ctx.rng.range(0, SCREEN_H);
      h.vx = speed;
      h.vy = ctx.rng.range(-1, 1);
    } else {
      // right
      h.x = SCREEN_W + 10;
      h.y = ctx.rng.range(0, SCREEN_H);
      h.vx = -speed;
      h.vy = ctx.rng.range(-1, 1);
    }
    this.hazards.push(h);
  }

  // Burst of small rect particles at (x,y).
  /**
   * @param {UpdateContext} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} color
   * @param {number} n
   */
  burst(ctx, x, y, color, n) {
    for (let i = 0; i < n; i++) {
      this.particles.push({
        x,
        y,
        vx: ctx.rng.range(-3, 3),
        vy: ctx.rng.range(-3, 3),
        life: ctx.rng.range(18, 34),
        color,
      });
    }
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    // Always advance particles so the death burst animates.
    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.08;
      p.life -= 1;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    if (this.over) {
      if (ctx.input.pressed(Btn.Start)) this.reset(ctx);
      return;
    }

    // Player movement (clamped to screen).
    const d = ctx.input.dir();
    this.px += d.x * HERO_SPEED;
    this.py += d.y * HERO_SPEED;
    if (this.px < 0) this.px = 0;
    if (this.py < 0) this.py = 0;
    if (this.px > SCREEN_W - HERO_W) this.px = SCREEN_W - HERO_W;
    if (this.py > SCREEN_H - HERO_H) this.py = SCREEN_H - HERO_H;

    const elapsed = ctx.frame - this.startFrame;

    // Spawn rate ramps up over time: interval shrinks from ~45 to ~10 frames.
    const interval = Math.max(10, 45 - Math.floor(elapsed / 240) * 5);
    if (elapsed > 0 && elapsed % interval === 0) this.spawnHazard(ctx);

    // Occasionally spawn a coin (capped count).
    if (this.coins.length < 3 && ctx.rng.chance(0.012)) {
      this.coins.push({
        x: ctx.rng.range(20, SCREEN_W - 20),
        y: ctx.rng.range(20, SCREEN_H - 20),
        r: 6,
      });
    }

    // Move hazards; drop those fully off-screen.
    for (const h of this.hazards) {
      h.x += h.vx;
      h.y += h.vy;
    }
    this.hazards = this.hazards.filter(
      (h) => h.x > -20 && h.x < SCREEN_W + 20 && h.y > -20 && h.y < SCREEN_H + 20,
    );

    // Player center for collision tests.
    const cx = this.px + HERO_W / 2;
    const cy = this.py + HERO_H / 2;
    const pr = 8; // forgiving player radius

    // Coin collection.
    /** @type {Coin[]} */
    const kept = [];
    for (const c of this.coins) {
      const dx = c.x - cx;
      const dy = c.y - cy;
      if (dx * dx + dy * dy <= (c.r + pr) * (c.r + pr)) {
        this.bonus += 120; // worth 2 seconds
        this.burst(ctx, c.x, c.y, Colors.yellow, 10);
      } else {
        kept.push(c);
      }
    }
    this.coins = kept;

    // Hazard collision => death.
    for (const h of this.hazards) {
      const dx = h.x - cx;
      const dy = h.y - cy;
      if (dx * dx + dy * dy <= (h.r + pr) * (h.r + pr)) {
        this.over = true;
        this.deathFrame = ctx.frame;
        this.burst(ctx, cx, cy, Colors.red, 24);
        this.burst(ctx, cx, cy, Colors.orange, 12);
        break;
      }
    }
  }

  /** @param {Graphics} g */
  draw(g) {
    // Background: dark arena with a subtle border.
    g.clear(rgb(18, 18, 28));
    g.rectOutline(2, 2, SCREEN_W - 4, SCREEN_H - 4, rgb(60, 60, 90), 2);

    // Coins (yellow with a soft glow).
    for (const c of this.coins) {
      g.rect(c.x - c.r - 1, c.y - c.r - 1, (c.r + 1) * 2, (c.r + 1) * 2, rgb(80, 70, 20));
      g.rect(c.x - c.r, c.y - c.r, c.r * 2, c.r * 2, Colors.yellow);
      g.rect(c.x - 2, c.y - 2, 4, 4, Colors.white);
    }

    // Hazards: red glow under a slime sprite (slime is 6x5 => scale 2 = 12x10).
    for (const h of this.hazards) {
      g.rect(h.x - 8, h.y - 8, 16, 16, rgb(120, 20, 20));
      g.sprite(SPRITES.slime, h.x - 6, h.y - 5, { scale: 2 });
    }

    // Player (hidden once dead so the death burst reads clearly).
    if (!this.over) g.sprite(SPRITES.hero, this.px, this.py, { scale: 2 });

    // Particles.
    for (const p of this.particles) {
      const s = p.life > 12 ? 3 : 2;
      g.rect(p.x, p.y, s, s, p.color);
    }

    // HUD: big score, top-left.
    const sc = this.lastScore;
    g.text('TIME', 8, 8, Colors.gray, 1);
    g.text(sc.toFixed(1), 8, 18, Colors.white, 3);

    // Game-over overlay.
    if (this.over) {
      g.rect(0, SCREEN_H / 2 - 46, SCREEN_W, 92, rgb(0, 0, 0));
      g.textCentered('GAME OVER', SCREEN_W / 2, SCREEN_H / 2 - 38, Colors.red, 3);
      g.textCentered('SCORE ' + sc.toFixed(1), SCREEN_W / 2, SCREEN_H / 2 - 6, Colors.white, 2);
      // Blink the prompt using the death frame as a clock.
      if (Math.floor((this.blinkClock) / 24) % 2 === 0) {
        g.textCentered('PRESS START', SCREEN_W / 2, SCREEN_H / 2 + 24, Colors.yellow, 2);
      }
    }
  }

  // Score/blink values are computed in update via these helpers so draw stays
  // pure; we cache them each update.
  lastScore = 0;
  blinkClock = 0;

  /** @param {UpdateContext} ctx */
  updateTree(ctx) {
    super.updateTree(ctx);
    this.lastScore = this.score(ctx);
    this.blinkClock = ctx.frame;
  }
}

start(() => new RootScene(), { seed: 1337 });
