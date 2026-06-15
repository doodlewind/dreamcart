// @ts-check
// @title Wuxia Village
// @order 0
// @controls D-pad to move, CROSS to interact
// A small Jin-Yong-flavoured wuxia story game: you wake in your room, walk out
// the door into the village, and roam — talking to villagers and the elder,
// opening a chest. Shows scene transitions, a scrolling tilemap + camera, AABB
// collision, and the framework DialogueBox. (Dialogue is ASCII/English since the
// baked font is ASCII; the structure supports a baked CJK glyph set later.)
import {
  Btn,
  Colors,
  DialogueBox,
  SCREEN_H,
  SCREEN_W,
  SPRITES,
  Scene,
  TileMap,
  rgb,
  start,
} from '../src/index';

/** @import { UpdateContext, Graphics } from '../src/index' */

const TILE = 16;
const HERO_W = 12;
const HERO_H = 14;
const SPEED = 2;

/** @typedef {{x:number, y:number, w:number, h:number}} Rect */

/**
 * @param {number} ax
 * @param {number} ay
 * @param {number} aw
 * @param {number} ah
 * @param {Rect} b
 * @returns {boolean}
 */
function aabb(ax, ay, aw, ah, b) {
  return ax < b.x + b.w && ax + aw > b.x && ay < b.y + b.h && ay + ah > b.y;
}

// Shared hero state carried between scenes.
class Hero {
  x = 0;
  y = 0;
  facing = 1; // 1 right, -1 left
  /**
   * @param {Graphics} g
   * @param {{ x: number; y: number }} cam
   * @returns {void}
   */
  draw(g, cam) {
    g.sprite(SPRITES.hero, this.x - cam.x - 2, this.y - cam.y - 6, { scale: 2, flipX: this.facing < 0 });
  }
}

// Base scene with axis-separated AABB movement against a solid predicate.
class WorldScene extends Scene {
  /** @type {Hero} */
  hero;
  cam = { x: 0, y: 0 };
  /** @type {DialogueBox | null} */
  talking = null;
  worldW = SCREEN_W;
  worldH = SCREEN_H;

  /** @param {Hero} hero */
  constructor(hero) {
    super();
    this.hero = hero;
  }

  /**
   * @param {number} px
   * @param {number} py
   * @returns {boolean}
   */
  solid(px, py) {
    throw new Error('abstract');
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {boolean}
   */
  blocked(x, y) {
    return (
      this.solid(x, y) ||
      this.solid(x + HERO_W - 1, y) ||
      this.solid(x, y + HERO_H - 1) ||
      this.solid(x + HERO_W - 1, y + HERO_H - 1)
    );
  }

  /**
   * @param {number} dx
   * @param {number} dy
   * @returns {void}
   */
  moveHero(dx, dy) {
    const h = this.hero;
    if (dx !== 0 && !this.blocked(h.x + dx, h.y)) h.x += dx;
    if (dy !== 0 && !this.blocked(h.x, h.y + dy)) h.y += dy;
    if (dx < 0) h.facing = -1;
    else if (dx > 0) h.facing = 1;
  }

  /** @returns {void} */
  updateCamera() {
    this.cam.x = Math.max(0, Math.min(this.worldW - SCREEN_W, this.hero.x - SCREEN_W / 2));
    this.cam.y = Math.max(0, Math.min(this.worldH - SCREEN_H, this.hero.y - SCREEN_H / 2));
  }

  /**
   * @param {string[]} lines
   * @returns {void}
   */
  say(lines) {
    if (this.talking) return;
    const box = new DialogueBox(lines, () => {
      this.talking = null;
    });
    this.talking = box;
    this.add(box);
  }
}

// --- The room (interior) ---
class RoomScene extends WorldScene {
  // 18x12 tiles of room, centered. wall border + a door at the bottom.
  cols = 18;
  rows = 11;
  ox = 0;
  oy = 0;

  /** @param {UpdateContext} _ctx */
  onEnter(_ctx) {
    this.worldW = SCREEN_W;
    this.worldH = SCREEN_H;
    this.ox = Math.floor((SCREEN_W - this.cols * TILE) / 2);
    this.oy = Math.floor((SCREEN_H - this.rows * TILE) / 2);
    this.hero.x = this.ox + this.cols * TILE - 60;
    this.hero.y = this.oy + 40;
  }

  /** @returns {Rect} */
  doorRect() {
    // door in the bottom wall, centered
    return { x: this.ox + Math.floor(this.cols / 2) * TILE - TILE, y: this.oy + (this.rows - 1) * TILE, w: TILE * 2, h: TILE };
  }

  /**
   * @param {number} px
   * @param {number} py
   * @returns {boolean}
   */
  solid(px, py) {
    const cx = Math.floor((px - this.ox) / TILE);
    const cy = Math.floor((py - this.oy) / TILE);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return true;
    // border walls are solid, except the door gap on the bottom row
    const onBorder = cx === 0 || cy === 0 || cx === this.cols - 1 || cy === this.rows - 1;
    if (!onBorder) return false;
    const d = this.doorRect();
    if (cy === this.rows - 1 && px >= d.x && px < d.x + d.w) return false; // door gap
    return true;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    if (this.talking) return;
    const dir = ctx.input.dir();
    this.moveHero(dir.x * SPEED, dir.y * SPEED);
    // step into the doorway -> go outside
    const d = this.doorRect();
    if (aabb(this.hero.x, this.hero.y, HERO_W, HERO_H, d) && this.hero.y + HERO_H > d.y + 4) {
      ctx.engine.replace(new VillageScene(this.hero));
    }
  }

  /** @param {Graphics} g */
  draw(g) {
    g.clear(0x1a1410);
    // floor + walls
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const onBorder = cx === 0 || cy === 0 || cx === this.cols - 1 || cy === this.rows - 1;
        g.sprite(onBorder ? SPRITES.house : SPRITES.floor, this.ox + cx * TILE, this.oy + cy * TILE);
      }
    }
    // door
    const d = this.doorRect();
    g.rect(d.x, d.y, d.w, d.h, 0x5a3a18);
    g.rect(d.x + 2, d.y + 2, d.w - 4, d.h - 2, rgb(120, 80, 40));
    // a bed (decoration)
    g.rect(this.ox + 24, this.oy + 24, 36, 22, 0x884444);
    g.rect(this.ox + 24, this.oy + 24, 12, 22, 0xeeeeee);
    this.hero.draw(g, this.cam);
    g.text('YOUR ROOM - walk out the door (v)', 8, 6, Colors.white, 1);
    super.draw(g);
  }
}

/** @typedef {{x:number, y:number, sprite:'villager'|'elder', lines:string[]}} Npc */

/** @typedef {{kind:'npc'|'chest'|'home', data:any}} Interactable */

// --- The village (exterior) ---
class VillageScene extends WorldScene {
  cols = 40;
  rows = 26;
  /** @type {TileMap} */
  ground = /** @type {any} */ (null);
  /** @type {Rect[]} */
  solids = [];
  /** @type {Npc[]} */
  npcs = [];
  /** @type {Rect} */
  homeDoor = /** @type {any} */ (null);
  /** @type {{ x: number; y: number; opened: boolean } | null} */
  chest = null;

  /** @param {Hero} hero */
  constructor(hero) {
    super(hero);
  }

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.worldW = this.cols * TILE;
    this.worldH = this.rows * TILE;
    this.ground = new TileMap(this.cols, this.rows, TILE);
    // grass everywhere, a horizontal + vertical dirt path, a pond of water
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        let t = 0; // grass
        if (cy === 13 || cy === 14) t = 1; // main path
        if (cx === 18 || cx === 19) t = 1; // crossing path
        if (cx >= 30 && cx <= 35 && cy >= 4 && cy <= 8) t = 2; // pond (water)
        this.ground.set(cx, cy, t);
      }
    }
    // home house near the path; its door leads back to the room
    const hx = 17 * TILE;
    const hy = 8 * TILE;
    this.solids.push({ x: hx, y: hy, w: SPRITES.house.w * 3, h: SPRITES.house.h * 3 });
    this.homeDoor = { x: hx + SPRITES.house.w * 3 * 0.4, y: hy + SPRITES.house.h * 3 - 8, w: 24, h: 12 };
    // a few trees (solid)
    /** @type {[number, number][]} */
    const treeCells = [
      [6, 6],
      [10, 18],
      [26, 16],
      [33, 18],
      [8, 21],
      [22, 5],
    ];
    for (const [cx, cy] of treeCells) {
      this.solids.push({ x: cx * TILE, y: cy * TILE, w: SPRITES.tree.w * 2, h: SPRITES.tree.h * 2 });
    }
    // NPCs with wuxia-flavoured lines
    this.npcs = [
      {
        x: 22 * TILE,
        y: 12 * TILE,
        sprite: 'villager',
        lines: ['Villager: Greetings, young hero!', 'Villager: The roads have been', 'restless since the Beggar Clan', 'passed through last moon.'],
      },
      {
        x: 14 * TILE,
        y: 17 * TILE,
        sprite: 'elder',
        lines: ['Elder: You have your father\'s eyes.', 'Elder: Master the Eighteen', 'Dragon-Subduing Palms, and the', 'jianghu will speak your name.'],
      },
      {
        x: 30 * TILE,
        y: 19 * TILE,
        sprite: 'villager',
        lines: ['Villager: Careful by the pond -', 'they say a swordsman drowned', 'his sorrows there long ago.'],
      },
    ];
    this.chest = { x: 24 * TILE, y: 20 * TILE, opened: false };

    // spawn: just below the home door when coming from the house
    this.hero.x = this.homeDoor.x;
    this.hero.y = this.homeDoor.y + 16;
    this.updateCamera();
  }

  /**
   * @param {number} px
   * @param {number} py
   * @returns {boolean}
   */
  solid(px, py) {
    if (px < 0 || py < 0 || px >= this.worldW || py >= this.worldH) return true;
    if (this.ground.solidAt(px, py, new Set([2]))) return true; // water
    for (const r of this.solids) if (aabb(px, py, 1, 1, r)) return true;
    return false;
  }

  /** @returns {Interactable | null} */
  nearestInteractable() {
    const hx = this.hero.x + HERO_W / 2;
    const hy = this.hero.y + HERO_H / 2;
    /** @param {number} x @param {number} y @param {number} r */
    const near = (x, y, r = 26) => Math.abs(hx - x) < r && Math.abs(hy - y) < r;
    for (const n of this.npcs) if (near(n.x + 8, n.y + 8)) return { kind: 'npc', data: n };
    if (this.chest && !this.chest.opened && near(this.chest.x + 8, this.chest.y + 8)) return { kind: 'chest', data: this.chest };
    if (near(this.homeDoor.x + this.homeDoor.w / 2, this.homeDoor.y, 22)) return { kind: 'home', data: null };
    return null;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    if (this.talking) return;
    const dir = ctx.input.dir();
    this.moveHero(dir.x * SPEED, dir.y * SPEED);
    this.updateCamera();
    if (ctx.input.pressed(Btn.Cross)) {
      const it = this.nearestInteractable();
      if (it?.kind === 'npc') this.say(/** @type {Npc} */ (it.data).lines);
      else if (it?.kind === 'chest') {
        /** @type {{ opened: boolean }} */ (it.data).opened = true;
        this.say(['You found a tattered manual:', '"Nine Yin Manual, vol. I".']);
      } else if (it?.kind === 'home') {
        ctx.engine.replace(new RoomScene(this.hero));
      }
    }
  }

  /** @param {Graphics} g */
  draw(g) {
    g.clear(Colors.grass);
    this.ground.drawSprites(g, [SPRITES.grass, SPRITES.path, SPRITES.water], this.cam);
    // house
    const home = this.solids[0];
    g.sprite(SPRITES.house, home.x - this.cam.x, home.y - this.cam.y, { scale: 3 });
    g.rect(this.homeDoor.x - this.cam.x, this.homeDoor.y - this.cam.y, this.homeDoor.w, this.homeDoor.h, 0x3a2412);
    // trees
    for (let i = 1; i < this.solids.length; i++) {
      const t = this.solids[i];
      g.sprite(SPRITES.tree, t.x - this.cam.x, t.y - this.cam.y, { scale: 2 });
    }
    // chest
    if (this.chest) {
      g.sprite(this.chest.opened ? SPRITES.floor : SPRITES.chest, this.chest.x - this.cam.x, this.chest.y - this.cam.y, { scale: 2 });
    }
    // npcs
    for (const n of this.npcs) {
      g.sprite(n.sprite === 'elder' ? SPRITES.elder : SPRITES.villager, n.x - this.cam.x, n.y - this.cam.y, { scale: 2 });
    }
    this.hero.draw(g, this.cam);
    // prompt
    const it = this.nearestInteractable();
    if (it && !this.talking) {
      const label = it.kind === 'home' ? 'Enter house (x)' : it.kind === 'chest' ? 'Open (x)' : 'Talk (x)';
      g.text(label, this.hero.x - this.cam.x - 6, this.hero.y - this.cam.y - 12, Colors.yellow, 1);
    }
    g.rect(0, 0, SCREEN_W, 14, 0x000000);
    g.text('SONG VILLAGE - roam with the d-pad, x to interact', 6, 4, Colors.white, 1);
    super.draw(g);
  }
}

start(() => new RoomScene(new Hero()), { seed: 7 });
