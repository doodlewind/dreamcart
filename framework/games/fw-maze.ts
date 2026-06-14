// fw-maze.ts — a grid maze pellet-muncher.
// Move the hero with the d-pad through a maze, eat every pellet to win.
// One slow slime wanders and resets the hero to start on touch.
import {
  start, Scene, UpdateContext, Graphics, Btn, Colors, rgb, mix,
  SCREEN_W, SCREEN_H, SPRITES, TileMap,
} from '../src/index';

// Maze grid: tile=16 -> 30 cols x 17 rows fills 480x272.
const TILE = 16;
const COLS = 30;
const ROWS = 17;
const WALL = 1; // tile index used for solid walls
const SOLID = new Set([WALL]);

// Colors used by TileMap.drawColors (index 0 = empty -> undefined = skipped).
const TILE_COLORS = [undefined, rgb(30, 40, 120)];

// Cardinal directions for digging the maze.
const DIRS = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

// A grid actor that steps one tile at a time, animating between tiles.
interface Actor {
  cx: number; cy: number;     // grid cell
  px: number; py: number;     // pixel pos (top-left of tile)
  dx: number; dy: number;     // current step direction (cells)
  moving: boolean;
}

function makeActor(cx: number, cy: number): Actor {
  return { cx, cy, px: cx * TILE, py: cy * TILE, dx: 0, dy: 0, moving: false };
}

class RootScene extends Scene {
  map!: TileMap;
  pellets!: Uint8Array;     // 1 = pellet present at cell
  pelletsLeft = 0;
  hero!: Actor;
  slime!: Actor;
  slimeTick = 0;
  score = 0;
  state: 'play' | 'win' = 'play';
  rng!: { int(n: number): number; pick<T>(a: readonly T[]): T; chance(p: number): boolean };

  override onEnter(ctx: UpdateContext): void {
    this.reset(ctx);
  }

  // Generate a fresh maze + pellets and place actors.
  reset(ctx: UpdateContext): void {
    this.rng = ctx.rng;
    this.map = new TileMap(COLS, ROWS, TILE);
    // Fill everything solid, then carve passages on odd cells (recursive backtracker).
    this.map.data.fill(WALL);
    const carve = (cx: number, cy: number) => {
      this.map.set(cx, cy, 0);
      // Shuffle directions deterministically.
      const order = [0, 1, 2, 3];
      for (let i = order.length - 1; i > 0; i--) {
        const j = ctx.rng.int(i + 1);
        const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
      }
      for (const di of order) {
        const d = DIRS[di];
        const nx = cx + d.x * 2;
        const ny = cy + d.y * 2;
        if (nx > 0 && ny > 0 && nx < COLS - 1 && ny < ROWS - 1 && this.map.get(nx, ny) === WALL) {
          this.map.set(cx + d.x, cy + d.y, 0); // knock down wall between
          carve(nx, ny);
        }
      }
    };
    carve(1, 1);

    // Pellets in every open cell.
    this.pellets = new Uint8Array(COLS * ROWS);
    this.pelletsLeft = 0;
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (this.map.get(cx, cy) === 0) {
          this.pellets[cy * COLS + cx] = 1;
          this.pelletsLeft++;
        }
      }
    }

    this.hero = makeActor(1, 1);
    this.eatAt(1, 1); // clear pellet under start

    // Place slime on an open cell far from the hero (bottom-right area).
    let sx = COLS - 2, sy = ROWS - 2;
    while (this.map.get(sx, sy) === WALL && sx > 1) sx--;
    this.slime = makeActor(sx, sy);
    this.slimeTick = 0;
    this.score = 0;
    this.state = 'play';
  }

  eatAt(cx: number, cy: number): void {
    const i = cy * COLS + cx;
    if (i >= 0 && i < this.pellets.length && this.pellets[i]) {
      this.pellets[i] = 0;
      this.pelletsLeft--;
      this.score += 10;
      if (this.pelletsLeft <= 0) this.state = 'win';
    }
  }

  open(cx: number, cy: number): boolean {
    return this.map.get(cx, cy) !== WALL;
  }

  // Smoothly advance an actor toward its target cell; returns true when arrived.
  stepActor(a: Actor, speed: number): boolean {
    const tx = a.cx * TILE;
    const ty = a.cy * TILE;
    if (a.px < tx) a.px = Math.min(tx, a.px + speed);
    else if (a.px > tx) a.px = Math.max(tx, a.px - speed);
    if (a.py < ty) a.py = Math.min(ty, a.py + speed);
    else if (a.py > ty) a.py = Math.max(ty, a.py - speed);
    return a.px === tx && a.py === ty;
  }

  override update(ctx: UpdateContext): void {
    if (this.state === 'win') {
      if (ctx.input.pressed(Btn.Start)) this.reset(ctx);
      return;
    }

    // Hero movement: accept new direction only when aligned on a cell.
    if (!this.hero.moving) {
      const d = ctx.input.dir();
      if (d.x !== 0 || d.y !== 0) {
        // Prefer horizontal when both pressed for predictability.
        const ndx = d.x !== 0 ? Math.sign(d.x) : 0;
        const ndy = d.x !== 0 ? 0 : Math.sign(d.y);
        if (this.open(this.hero.cx + ndx, this.hero.cy + ndy)) {
          this.hero.cx += ndx;
          this.hero.cy += ndy;
          this.hero.dx = ndx;
          this.hero.dy = ndy;
          this.hero.moving = true;
        }
      }
    }
    if (this.hero.moving && this.stepActor(this.hero, 2)) {
      this.hero.moving = false;
      this.eatAt(this.hero.cx, this.hero.cy);
    }

    // Slime: pick a new direction at intersections, move slowly.
    this.slimeTick++;
    if (!this.slime.moving) {
      const choices: { x: number; y: number }[] = [];
      for (const dd of DIRS) {
        if (this.open(this.slime.cx + dd.x, this.slime.cy + dd.y)) choices.push(dd);
      }
      // Avoid reversing unless it's the only option.
      const fwd = choices.filter((c) => !(c.x === -this.slime.dx && c.y === -this.slime.dy));
      const pool = fwd.length > 0 ? fwd : choices;
      if (pool.length > 0) {
        const dd = this.rng.pick(pool);
        this.slime.cx += dd.x;
        this.slime.cy += dd.y;
        this.slime.dx = dd.x;
        this.slime.dy = dd.y;
        this.slime.moving = true;
      }
    }
    if (this.slime.moving && this.stepActor(this.slime, 1)) {
      this.slime.moving = false;
    }

    // Collision: if close enough, reset hero to start (keep pellets/score).
    const hdx = this.hero.px - this.slime.px;
    const hdy = this.hero.py - this.slime.py;
    if (hdx * hdx + hdy * hdy < (TILE * 0.6) * (TILE * 0.6)) {
      this.hero.cx = 1; this.hero.cy = 1;
      this.hero.px = TILE; this.hero.py = TILE;
      this.hero.dx = 0; this.hero.dy = 0; this.hero.moving = false;
    }
  }

  override draw(g: Graphics): void {
    g.clear(rgb(8, 8, 24));
    const cam = { x: 0, y: 0 };
    // Walls.
    this.map.drawColors(g, TILE_COLORS, cam);

    // Pellets as small dots in open cells.
    const dot = mix(Colors.yellow, Colors.white, 0.3);
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (this.pellets[cy * COLS + cx]) {
          g.rect(cx * TILE + TILE / 2 - 2, cy * TILE + TILE / 2 - 2, 4, 4, dot);
        }
      }
    }

    // Slime then hero (hero on top).
    g.sprite(SPRITES.slime, this.slime.px, this.slime.py, { scale: 1 });
    g.sprite(SPRITES.hero, this.hero.px, this.hero.py, { scale: 1 });

    // HUD.
    g.text('SCORE ' + this.score, 6, 4, Colors.white, 2);
    g.text('LEFT ' + this.pelletsLeft, SCREEN_W - 120, 4, Colors.cyan, 2);

    if (this.state === 'win') {
      g.rect(0, SCREEN_H / 2 - 26, SCREEN_W, 52, rgb(0, 0, 0));
      g.textCentered('YOU WIN!', SCREEN_W / 2, SCREEN_H / 2 - 16, Colors.green, 3);
      g.textCentered('PRESS START', SCREEN_W / 2, SCREEN_H / 2 + 8, Colors.white, 2);
    }
  }
}

start(() => new RootScene(), { seed: 12345 });
