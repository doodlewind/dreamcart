// @ts-check
// @title Flappy
// @order 3
// @controls CROSS / UP to flap; START restart
// flappy.js — a Flappy-Bird clone for the DreamCart framework.
// Bird stays at a fixed x with gravity; CROSS/Up flaps. Pipes scroll left;
// passing a pipe scores. Hitting a pipe / ground / ceiling ends the game.
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

// --- Tunables -------------------------------------------------------------
const GROUND_H = 28; // height of the ground strip at the bottom
const BIRD_X = 110; // fixed horizontal position of the bird
const BIRD_SCALE = 3;
const BIRD_SIZE = 6 * BIRD_SCALE; // bird sprite is 6x6 -> 18px
const GRAVITY = 0.45; // downward acceleration per frame
const FLAP_V = -6.2; // upward velocity applied on a flap
const PIPE_W = 46; // pipe width
const PIPE_GAP = 84; // vertical gap between top & bottom pipe
const PIPE_SPEED = 2.2; // world scroll speed (pixels/frame)
const PIPE_SPACING = 150; // horizontal distance between pipe pairs
const PIPE_COUNT = 4; // number of recycled pipe pairs

/** @typedef {{x:number, gapY:number, scored:boolean}} Pipe */

class GameScene extends Scene {
  birdY = 0;
  vel = 0;
  /** @type {Pipe[]} */
  pipes = [];
  score = 0;
  best = 0;
  over = false;
  flapAnim = 0; // frames remaining of "wing up" pose

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.lastRng = ctx.rng; // stash before reset(), which calls randGapY()
    this.reset();
  }

  reset() {
    this.birdY = SCREEN_H / 2 - BIRD_SIZE / 2;
    this.vel = 0;
    this.score = 0;
    this.over = false;
    this.flapAnim = 0;
    this.pipes = [];
    // Lay out the initial pipes spaced out to the right of the screen.
    for (let i = 0; i < PIPE_COUNT; i++) {
      this.pipes.push({
        x: SCREEN_W + 60 + i * PIPE_SPACING,
        gapY: this.randGapY(),
        scored: false,
      });
    }
  }

  // Random vertical position for the top of the gap, kept fully on-screen.
  randGapY() {
    const minY = 30;
    const maxY = SCREEN_H - GROUND_H - PIPE_GAP - 30;
    return Math.floor(this.lastRng.range(minY, maxY));
  }

  // Stash the rng so randGapY (called outside update) stays deterministic.
  /** @type {UpdateContext['rng']} */
  lastRng = /** @type {any} */ (null);

  /** @param {UpdateContext} ctx */
  update(ctx) {
    this.lastRng = ctx.rng;

    if (this.over) {
      // Game over: wait for Start to restart.
      if (ctx.input.pressed(Btn.Start)) this.reset();
      return;
    }

    // Flap on CROSS or Up.
    if (ctx.input.pressed(Btn.Cross) || ctx.input.pressed(Btn.Up)) {
      this.vel = FLAP_V;
      this.flapAnim = 8;
    }
    if (this.flapAnim > 0) this.flapAnim--;

    // Physics: integrate gravity.
    this.vel += GRAVITY;
    this.birdY += this.vel;

    // Ceiling / ground collisions.
    if (this.birdY < 0) {
      this.birdY = 0;
      this.vel = 0;
    }
    const floorY = SCREEN_H - GROUND_H - BIRD_SIZE;
    if (this.birdY >= floorY) {
      this.birdY = floorY;
      this.die();
      return;
    }

    // Move pipes; recycle and score.
    for (const p of this.pipes) {
      p.x -= PIPE_SPEED;

      // Scoring: when the bird fully passes the right edge of a pipe.
      if (!p.scored && p.x + PIPE_W < BIRD_X) {
        p.scored = true;
        this.score++;
        if (this.score > this.best) this.best = this.score;
      }

      // Recycle off-screen pipes to the far right of the rightmost pipe.
      if (p.x + PIPE_W < 0) {
        let maxX = 0;
        for (const q of this.pipes) if (q.x > maxX) maxX = q.x;
        p.x = maxX + PIPE_SPACING;
        p.gapY = this.randGapY();
        p.scored = false;
      }

      // Collision with this pipe pair.
      if (this.collides(p)) {
        this.die();
        return;
      }
    }
  }

  // Axis-aligned overlap of the bird box with the pipe's two rects.
  /** @param {Pipe} p */
  collides(p) {
    const bl = BIRD_X;
    const br = BIRD_X + BIRD_SIZE;
    const bt = this.birdY;
    const bb = this.birdY + BIRD_SIZE;
    const inX = br > p.x && bl < p.x + PIPE_W;
    if (!inX) return false;
    const hitTop = bt < p.gapY;
    const hitBottom = bb > p.gapY + PIPE_GAP;
    return hitTop || hitBottom;
  }

  die() {
    this.over = true;
  }

  /** @param {Graphics} g */
  draw(g) {
    // Sky background.
    g.clear(Colors.sky);

    // A few static clouds for depth (purely decorative).
    const cloud = rgb(245, 250, 255);
    g.rect(60, 40, 50, 14, cloud);
    g.rect(80, 32, 26, 12, cloud);
    g.rect(330, 70, 60, 16, cloud);
    g.rect(355, 60, 28, 12, cloud);

    // Pipes (green rects with a darker outline lip).
    const pipeCol = Colors.green;
    const pipeDark = rgb(20, 110, 30);
    const lipH = 12;
    for (const p of this.pipes) {
      const gapBottom = p.gapY + PIPE_GAP;
      // Top pipe.
      g.rect(p.x, 0, PIPE_W, p.gapY, pipeCol);
      g.rect(p.x - 3, p.gapY - lipH, PIPE_W + 6, lipH, pipeDark);
      // Bottom pipe.
      const botTop = gapBottom;
      const botH = SCREEN_H - GROUND_H - botTop;
      g.rect(p.x, botTop, PIPE_W, botH, pipeCol);
      g.rect(p.x - 3, botTop, PIPE_W + 6, lipH, pipeDark);
    }

    // Ground strip.
    const groundY = SCREEN_H - GROUND_H;
    g.rect(0, groundY, SCREEN_W, GROUND_H, Colors.grass);
    g.rect(0, groundY, SCREEN_W, 4, rgb(60, 140, 50));
    g.rect(0, groundY + 4, SCREEN_W, 3, Colors.brown);

    // Bird — wings "up" pose by nudging it when flapping.
    const by = this.birdY - (this.flapAnim > 0 ? 2 : 0);
    g.sprite(SPRITES.bird, BIRD_X, by, { scale: BIRD_SCALE });

    // HUD: big score near the top.
    g.text(String(this.score), 16, 12, Colors.white, 3);
    g.text('BEST ' + this.best, 16, 44, rgb(255, 240, 180), 2);

    // Game-over overlay.
    if (this.over) {
      const cx = SCREEN_W / 2;
      g.rect(cx - 130, 80, 260, 100, rgb(0, 0, 0));
      g.rectOutline(cx - 130, 80, 260, 100, Colors.white, 2);
      g.textCentered('GAME OVER', cx, 96, Colors.red, 3);
      g.textCentered('SCORE ' + this.score, cx, 128, Colors.white, 2);
      // Blink "PRESS START" roughly twice a second.
      if (Math.floor(this.blinkT / 20) % 2 === 0) {
        g.textCentered('PRESS START', cx, 152, Colors.yellow, 2);
      }
      this.blinkT++;
    } else {
      this.blinkT = 0;
    }
  }

  blinkT = 0;
}

// Root scene is the game itself; restart is handled in-scene.
start(() => new GameScene(), { seed: 7 });
