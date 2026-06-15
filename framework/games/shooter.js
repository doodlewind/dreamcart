// @ts-check
// shooter.js — a vertical space shooter.
// Move with LEFT/RIGHT (and UP/DOWN within a band near the bottom), CROSS fires.
// Shoot descending slimes for score; an enemy reaching the bottom (or hitting
// you) costs a life. 3 lives, then game over -> press START to restart.
// Deterministic: all randomness via ctx.rng, all timing via counters.
import {
  start, Scene, Btn, Colors, rgb,
  SCREEN_W, SCREEN_H, SPRITES,
} from '../src/index';

/** @import { UpdateContext, Graphics } from '../src/index' */

// Sprites are 16x16 art drawn at scale 3 => 48px on screen.
const SHIP = 48;
const ENEMY = 48;
const PLAY_TOP = SCREEN_H - 90; // top of the band the ship may move within

/** @typedef {{x:number, y:number}} Bullet */
/** @typedef {{x:number, y:number, vx:number}} Enemy */
/** @typedef {{x:number, y:number, speed:number, size:number}} Star */

class ShooterScene extends Scene {
  shipX = 0;
  shipY = 0;
  /** @type {Bullet[]} */ bullets = [];
  /** @type {Enemy[]} */ enemies = [];
  /** @type {Star[]} */ stars = [];
  cooldown = 0;     // frames until next shot allowed
  spawnTimer = 0;   // frames until next enemy spawn
  spawnEvery = 60;  // current spawn interval (speeds up with score)
  score = 0;
  lives = 3;
  over = false;
  frames = 0; // local frame counter, drives the blinking prompt

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.shipX = (SCREEN_W - SHIP) / 2;
    this.shipY = SCREEN_H - SHIP - 8;
    this.bullets = [];
    this.enemies = [];
    this.cooldown = 0;
    this.spawnTimer = 0;
    this.spawnEvery = 60;
    this.score = 0;
    this.lives = 3;
    this.over = false;
    this.frames = 0;
    // Build a scrolling starfield using the seeded rng.
    this.stars = [];
    for (let i = 0; i < 60; i++) {
      this.stars.push({
        x: ctx.rng.int(SCREEN_W),
        y: ctx.rng.int(SCREEN_H),
        speed: ctx.rng.range(0.6, 2.4),
        size: ctx.rng.chance(0.25) ? 2 : 1,
      });
    }
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    const i = ctx.input;
    this.frames++;

    // Always scroll the starfield (looks alive even on game over).
    for (const s of this.stars) {
      s.y += s.speed;
      if (s.y >= SCREEN_H) {
        s.y = 0;
        s.x = ctx.rng.int(SCREEN_W);
      }
    }

    if (this.over) {
      if (i.pressed(Btn.Start)) this.onEnter(ctx);
      return;
    }

    // --- Move ship, clamped to screen / band ---
    const d = i.dir();
    const speed = 4;
    this.shipX += d.x * speed;
    this.shipY += d.y * speed;
    this.shipX = clamp(this.shipX, 0, SCREEN_W - SHIP);
    this.shipY = clamp(this.shipY, PLAY_TOP, SCREEN_H - SHIP - 4);

    // --- Fire (rate-limited) ---
    if (this.cooldown > 0) this.cooldown--;
    if (i.held(Btn.Cross) && this.cooldown === 0) {
      this.bullets.push({ x: this.shipX + SHIP / 2 - 1, y: this.shipY });
      this.cooldown = 8;
    }

    // --- Advance bullets upward; cull off-screen ---
    for (const b of this.bullets) b.y -= 8;
    this.bullets = this.bullets.filter((b) => b.y > -8);

    // --- Spawn enemies over time; speed up as score rises ---
    this.spawnEvery = Math.max(22, 60 - Math.floor(this.score / 5) * 3);
    if (++this.spawnTimer >= this.spawnEvery) {
      this.spawnTimer = 0;
      this.enemies.push({
        x: ctx.rng.int(SCREEN_W - ENEMY),
        y: -ENEMY,
        vx: ctx.rng.chance(0.5) ? ctx.rng.range(-1.6, 1.6) : 0, // some drift
      });
    }

    // --- Advance enemies; drift sideways and bounce off edges ---
    const fall = 1.4 + this.score * 0.01;
    for (const e of this.enemies) {
      e.y += fall;
      e.x += e.vx;
      if (e.x < 0) { e.x = 0; e.vx = -e.vx; }
      else if (e.x > SCREEN_W - ENEMY) { e.x = SCREEN_W - ENEMY; e.vx = -e.vx; }
    }

    // --- Bullet vs enemy collisions ---
    for (let ei = this.enemies.length - 1; ei >= 0; ei--) {
      const e = this.enemies[ei];
      let hit = false;
      for (let bi = this.bullets.length - 1; bi >= 0; bi--) {
        const b = this.bullets[bi];
        if (b.x >= e.x && b.x <= e.x + ENEMY && b.y >= e.y && b.y <= e.y + ENEMY) {
          this.bullets.splice(bi, 1);
          hit = true;
          break;
        }
      }
      if (hit) {
        this.enemies.splice(ei, 1);
        this.score++;
        continue;
      }
      // Enemy reached the bottom, or collided with the ship -> lose a life.
      const reachedBottom = e.y + ENEMY >= SCREEN_H;
      const hitShip = aabb(e.x, e.y, ENEMY, ENEMY, this.shipX, this.shipY, SHIP, SHIP);
      if (reachedBottom || hitShip) {
        this.enemies.splice(ei, 1);
        this.lives--;
        if (this.lives <= 0) {
          this.lives = 0;
          this.over = true;
        }
      }
    }
  }

  /** @param {Graphics} g */
  draw(g) {
    g.clear(rgb(6, 8, 20)); // deep space

    // Starfield (brighter for nearer/larger stars).
    for (const s of this.stars) {
      const c = s.size === 2 ? Colors.white : rgb(150, 160, 200);
      g.rect(s.x, s.y, s.size, s.size, c);
    }

    // Bullets.
    for (const b of this.bullets) g.rect(b.x, b.y, 2, 8, Colors.yellow);

    // Enemies.
    for (const e of this.enemies) g.sprite(SPRITES.slime, e.x, e.y, { scale: 3 });

    // Player ship (hidden on game over for a cleaner overlay).
    if (!this.over) g.sprite(SPRITES.ship, this.shipX, this.shipY, { scale: 3 });

    // HUD.
    g.text('SCORE ' + this.score, 6, 6, Colors.white, 2);
    g.text('LIVES ' + this.lives, SCREEN_W - 110, 6, Colors.cyan, 2);

    if (this.over) {
      // Dim the scene with a dark band behind the text, then blink the prompt.
      const by = SCREEN_H / 2 - 36;
      g.rect(0, by, SCREEN_W, 90, rgb(8, 6, 14));
      g.textCentered('GAME OVER', SCREEN_W / 2, SCREEN_H / 2 - 24, Colors.red, 3);
      g.textCentered('SCORE ' + this.score, SCREEN_W / 2, SCREEN_H / 2 + 8, Colors.white, 2);
      // Blink every ~30 frames using the deterministic frame counter.
      if (Math.floor(this.frames / 30) % 2 === 0) {
        g.textCentered('PRESS START', SCREEN_W / 2, SCREEN_H / 2 + 36, Colors.yellow, 2);
      }
    }
  }
}

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Axis-aligned bounding-box overlap test.
/**
 * @param {number} ax
 * @param {number} ay
 * @param {number} aw
 * @param {number} ah
 * @param {number} bx
 * @param {number} by
 * @param {number} bw
 * @param {number} bh
 * @returns {boolean}
 */
function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

start(() => new ShooterScene(), { seed: 12345 });
