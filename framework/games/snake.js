// @ts-check
// Snake rebuilt on the framework — the reference game for golden tests
// (deterministic: walls wrap, food via the seeded rng, no input needed).
import { Btn, Colors, Scene, start } from '../src/index';

/** @import { Graphics, UpdateContext } from '../src/index' */

const CELL = 16;
const COLS = 30; // 30*16 = 480
const ROWS = 17; // 17*16 = 272

/** @typedef {{x:number, y:number}} Cell */

class SnakeScene extends Scene {
  /** @type {Cell[]} */ snake = [];
  /** @type {Cell} */ dir = { x: 1, y: 0 };
  /** @type {Cell} */ next = { x: 1, y: 0 };
  /** @type {Cell} */ food = { x: 0, y: 0 };
  ticks = 0;
  score = 0;

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.snake = [
      { x: 10, y: 8 },
      { x: 9, y: 8 },
      { x: 8, y: 8 },
    ];
    this.dir = { x: 1, y: 0 };
    this.next = { x: 1, y: 0 };
    this.ticks = 0;
    this.score = 0;
    this.placeFood(ctx);
  }

  /** @param {UpdateContext} ctx */
  placeFood(ctx) {
    for (;;) {
      const fx = ctx.rng.int(COLS);
      const fy = ctx.rng.int(ROWS);
      if (!this.snake.some((s) => s.x === fx && s.y === fy)) {
        this.food = { x: fx, y: fy };
        return;
      }
    }
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    const i = ctx.input;
    if (i.pressed(Btn.Up) && this.dir.y === 0) this.next = { x: 0, y: -1 };
    else if (i.pressed(Btn.Down) && this.dir.y === 0) this.next = { x: 0, y: 1 };
    else if (i.pressed(Btn.Left) && this.dir.x === 0) this.next = { x: -1, y: 0 };
    else if (i.pressed(Btn.Right) && this.dir.x === 0) this.next = { x: 1, y: 0 };

    if (++this.ticks < 6) return;
    this.ticks = 0;
    this.dir = this.next;
    const head = this.snake[0];
    let nx = head.x + this.dir.x;
    let ny = head.y + this.dir.y;
    if (nx < 0) nx = COLS - 1;
    else if (nx >= COLS) nx = 0;
    if (ny < 0) ny = ROWS - 1;
    else if (ny >= ROWS) ny = 0;
    // self-collision -> restart
    if (this.snake.slice(0, -1).some((s) => s.x === nx && s.y === ny)) {
      this.onEnter(ctx);
      return;
    }
    this.snake.unshift({ x: nx, y: ny });
    if (nx === this.food.x && ny === this.food.y) {
      this.score++;
      this.placeFood(ctx);
    } else {
      this.snake.pop();
    }
  }

  /** @param {Graphics} g */
  draw(g) {
    g.clear(0x0f141e);
    g.rect(this.food.x * CELL, this.food.y * CELL, CELL - 1, CELL - 1, Colors.red);
    for (let k = 0; k < this.snake.length; k++) {
      const s = this.snake[k];
      g.rect(s.x * CELL, s.y * CELL, CELL - 1, CELL - 1, k === 0 ? 0x78ff78 : Colors.green);
    }
    g.text('SCORE ' + this.score, 6, 4, Colors.white, 2);
  }
}

start(() => new SnakeScene(), { seed: 12345 });
