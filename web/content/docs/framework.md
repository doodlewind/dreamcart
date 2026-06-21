# Framework SDK

The framework is an optional TypeScript layer that sits on top of the
[runtime contract](/docs/runtime-contract/). The contract gives you two raw
globals — `gfx` and `log` — plus a `frame(buttons)` function the host calls ~60
times a second. That is enough to make a game, but every game would then re-write
the same loop, input edge-detection, sprite blitting and text rasterization. The
framework SDK packages those into a small, allocation-conscious library so you can
write game logic instead of plumbing.

It is shipped as source in `framework/src/` and **inlined into your game's
bundle** per platform by `framework/build.ts` (Bun.build). Games author in plain
JavaScript with `// @ts-check` + JSDoc, so you get full editor and CI type-checking
against the TypeScript SDK without a compile step of your own. Everything below
runs unchanged on PSP, Web, 3DS and Android.

```js
// @ts-check
// @title Hello
import { Scene, Colors, start } from '../src/index';
/** @import { Graphics } from '../src/index' */

class HelloScene extends Scene {
  /** @param {Graphics} g */
  draw(g) {
    g.clear(Colors.dark);
    g.textCentered('HELLO DREAMCART', 240, 130, Colors.white, 2);
  }
}

start(() => new HelloScene());
```

`import { ... } from '../src/index'` is the public surface. A few subsystems are
imported directly from their module instead of the barrel (see
[Direct imports](#direct-imports)).

## The game loop

`Engine` owns the loop, input, RNG, a `Graphics` instance, and a **stack of
scenes**. `start(sceneOrFactory, opts?)` is the convenience entry point: it
constructs an `Engine`, runs the initial scene, and installs `globalThis.frame`
so the host can drive it.

```js
import { start } from '../src/index';
const engine = start(() => new TitleScene(), { seed: 12345 });
```

Each frame, `Engine.tick(mask)` does the same fixed-order work:

1. `input.update(mask)` — latch the new button word and compute edges.
2. `frameCount++`.
3. `scene.updateTree(ctx)` — update the active scene's node tree.
4. If a `scene3d` is set and the host has the [3D](/docs/3d/) `g3d` contract,
   render the 3D pass first (so 2D draws form a HUD on top).
5. `scene.drawTree(g)` — draw the active scene's node tree.

The timestep is fixed: `dt = 1/60` seconds. Every update receives an
`UpdateContext`:

```ts
interface UpdateContext {
  input: Input;   // edge-detecting controller state
  rng: Rng;       // seeded deterministic RNG
  dt: number;     // 1/60
  t: number;      // seconds since start (frameCount / 60)
  frame: number;  // integer frame counter
  engine: Engine; // for push()/pop()/replace() and scene3d
}
```

### Scene stack

The engine keeps scenes on a stack; only the top one updates and draws. This makes
menus, pause screens and level transitions trivial:

```js
ctx.engine.push(new PauseScene());   // overlay, suspends the scene below
ctx.engine.pop();                    // back to the previous scene
ctx.engine.replace(new GameOver());  // pop + push
```

`Scene.onEnter(ctx)` runs when a scene is pushed (use it to (re)initialize state
deterministically); `Scene.onExit()` runs when it is popped.

## Scene / Node tree

`Node` is the unit of the tree. Override `update(ctx)` and `draw(g)`; use `add()`
to nest children and `remove()` to mark a node for removal at the end of the
current update pass. `Scene extends Node` and adds the `onEnter`/`onExit` lifecycle
hooks.

```js
import { Node, Scene } from '../src/index';

class Bullet extends Node {
  update(ctx) {
    this.y -= 4;
    if (this.y < 0) this.remove();   // pruned after this pass
  }
  draw(g) { g.rect(this.x, this.y, 2, 6, 0xffff80); }
}

class GameScene extends Scene {
  onEnter() { this.player = this.add(new Player()); }
  spawnBullet(x, y) { const b = this.add(new Bullet()); b.x = x; b.y = y; }
}
```

`updateTree` runs `update` depth-first then prunes any child whose `dead` flag is
set (`remove()` sets it); `drawTree` skips nodes whose `visible` is `false` or
that are `dead`. Every node carries `x`/`y`, but the framework does **not** apply a
transform hierarchy automatically — children read `this.parent` if they need the
parent's position. This keeps the tree predictable and the draw order exactly the
order you added nodes (which matters for golden tests).

Many small games skip the tree entirely and just override `Scene.update`/`draw`
directly, as the [Snake reference game](#a-complete-example) does.

## Input — edge detection

`Input` turns the per-frame button word into queryable state. Buttons are the same
bitmask on every platform — defined as `Btn` and identical to the PSP's
`CtrlButtons`; the Web and 3DS hosts remap their inputs to these exact bits (see
the [runtime contract](/docs/runtime-contract/)).

```ts
Btn = {
  Select: 0x01, Start: 0x08,
  Up: 0x10, Right: 0x20, Down: 0x40, Left: 0x80,
  LTrigger: 0x100, RTrigger: 0x200,
  Triangle: 0x1000, Circle: 0x2000, Cross: 0x4000, Square: 0x8000,
}
```

The engine calls `input.update(mask)` for you; in a node you just query it:

```js
const i = ctx.input;
i.held(Btn.Cross);     // true while down
i.pressed(Btn.Cross);  // true ONLY on the frame it transitions down (edge)
i.released(Btn.Cross); // true ONLY on the frame it goes up
```

`pressed`/`released` are computed from `cur` vs `prev`, so they fire exactly once
per press — no manual debouncing.

Two helpers turn the D-pad into a direction:

```js
i.dir();   // { x, y } from the D-pad, each in {-1, 0, 1}
i.axis();  // analog stick past its deadzone, else falls back to dir()
```

### Analog stick

The low 16 bits of the word the host passes to `frame()` are the digital bitmask;
a host **may** pack an analog stick into the free high 16 bits as two signed bytes.
The PSP host does this; digital-only hosts leave them zero. `input.analogX` /
`input.analogY` expose the result in `-1..1` (with a 0.12 deadzone). Because
`axis()` falls back to `dir()` when the stick is idle, a game written against
`axis()` behaves identically with or without an analog stick — and digital-only
goldens don't move.

## ActionMap — named, rebindable input

`ActionMap` is a thin, data-driven layer over `Input`. You declare named actions
bound to buttons and/or an analog axis once, then query by name — so rebinding is a
one-line config edit, not a code change. It is allocation-free per frame and the
digital path is byte-identical to querying `Input` directly.

```js
import { ActionMap } from '../src/action';
import { Btn } from '../src/index';

const map = new ActionMap(ctx.input, {
  ACCEL: { buttons: [Btn.Cross] },
  STEER: { axis: 'lx', axisButtons: [Btn.Left, Btn.Right] },
  RESET: { buttons: [Btn.Start] },
});

if (map.pressed('RESET')) reset();
const throttle = map.held('ACCEL') ? 1 : 0;
const steer = map.axis('STEER'); // analog stick, else Left/Right pair, in [-1,1]
```

A binding can list multiple `buttons` (held/pressed are true if **any** is down),
bind an `axis` (`'lx'` → `analogX`, `'ly'` → `analogY`) with an `axisButtons`
digital fallback `[neg, pos]`, and `invert` the resulting axis. The config object is
referenced (not copied), so a settings screen can mutate a binding to rebind live.

## Rng — seeded determinism

`Rng` is a seedable mulberry32 generator. Games use it **instead of `Math.random`**
so behavior is reproducible across platforms — the basis of the golden-test harness.
`ctx.rng` is seeded from `start(..., { seed })` (default `12345`).

```js
ctx.rng.next();          // float [0, 1)
ctx.rng.int(n);          // integer [0, n)
ctx.rng.range(a, b);     // float [a, b)
ctx.rng.pick(arr);       // a random element
ctx.rng.chance(0.25);    // true with probability p
```

## Graphics — rect, sprite, text

`Graphics` is the only drawing surface. It is a thin wrapper over the host
`gfx.fillRect` — everything, including sprites and text, is rasterized to fill-rect
runs. Colors are packed `0xRRGGBB` integers (see [Color](#color-and-font)).

```js
g.clear(0x0f141e);                         // fill the 480x272 screen
g.rect(x, y, w, h, color);                 // filled rect
g.rectOutline(x, y, w, h, color, 2);       // 2px outline
g.sprite(bmp, dx, dy, { scale: 2, flipX: true });
const w = g.text('SCORE', x, y, color, 2); // returns width; supports '\n'
g.textWidth('SCORE', 2);                   // measure without drawing
g.textCentered('PAUSED', 240, 130, color, 2);
```

The screen is **480×272 logical pixels** (`SCREEN_W` / `SCREEN_H`), the PSP's native
resolution, identical on every host.

Two optimizations are transparent to your code. `text()` first tries the host's
native text path (`gfx.drawText`, the font uploaded once via `gfx.uploadFont`); if
that isn't available it batches every glyph pixel-run into one `gfx.fillRects` call;
and if *that* isn't available it falls back to per-run `gfx.fillRect`. You always
call `g.text(...)`; the framework picks the fastest path the host offers.

## Bitmap — palette sprites

A `Bitmap` is a palette-indexed image: `pixels[i]` indexes `palette`, and pixels
equal to `transparent` are skipped when blitted. Build one from ASCII art, or load
one baked by the [asset pipeline](/docs/assets/).

```js
import { bitmapFromRows } from '../src/index';

const heart = bitmapFromRows(
  [
    '.XX.XX.',
    'XXXXXXX',
    '.XXXXX.',
    '..XXX..',
    '...X...',
  ],
  { X: 0xe03030 }, // any char not in the map (default '.') is transparent
);

g.sprite(heart, 10, 10, { scale: 3 });
```

Baked bitmaps store their pixels as a compact string (`packPixels` /
`unpackPixels`); `fromBaked()` reconstitutes one. Keep bitmaps small — every visible
horizontal run of equal pixels becomes one host fill-rect.

## TileMap — grids with a camera

`TileMap` is a grid of tile indices you can render as flat colors or as bitmaps,
with a camera offset for scrolling worlds (the wuxia village game uses it). It only
draws the tiles visible in the camera window.

```js
import { TileMap } from '../src/index';

const map = new TileMap(cols, rows, 16 /* tile px */, data /* optional */);
map.get(cx, cy); map.set(cx, cy, v);
map.pixelW(); map.pixelH();

// collision: is the tile at world pixel (px,py) one of the solid indices?
const solid = new Set([1, 2]);
if (map.solidAt(px, py, solid)) { /* blocked */ }

// render (cam is { x, y } in world pixels):
map.drawColors(g, [undefined, 0x4ca64c, 0x8a5a2a], cam); // index 0 skipped
map.drawSprites(g, [undefined, grassBmp, wallBmp], cam, 1);
```

## DialogueBox — text boxes

`DialogueBox` is a ready-made bottom-of-screen dialogue node. Give it lines and an
optional `onDone`; Cross or Start advances, and it removes itself when finished.

```js
import { DialogueBox } from '../src/index';

scene.add(new DialogueBox(
  ['Welcome, traveller.', 'The road ahead is long.'],
  () => scene.startQuest(),
));
```

Its colors (`fg`, `bg`, `border`) and `scale` are public fields you can tweak.

## CharController — movement, cameras, collision

`CharController` is the shared 3D character core the 3D games used to each reinvent:
heading/speed integration, chase / first-person / freefly cameras, AABB blocking and
hitscan. You give it a `MoveConfig` and a `CamRig`, then feed a per-frame
`InputSample` (usually built from an `ActionMap`). All math is deterministic
(`dsin`/`dcos`), so it pairs with the golden harness. See [3D](/docs/3d/) for the
camera and scene context.

```js
import { CharController, Collide } from '../src/controller'; // direct import

const ctrl = new CharController(
  { speed: 'gated', walkSpeed: 4, runSpeed: 8, backSpeed: 2,
    turnRate: 2.5, fwdSignZ: 1 },           // MoveConfig
  { mode: 'chase', dist: 7, eyeY: 3.2, lookY: 0.9 }, // CamRig
  { x: 0, z: 0, heading: 0 },               // start state
);

// each frame:
ctrl.step({ throttle, steer, pitch: 0, run }, ctx.dt);
Collide.slideAabb(ctrl.s, prevX, prevZ, 0.5, boxes); // block into walls
ctrl.applyCam(scene3d.camera);
```

`Collide` also offers `clampBox` (clamp into bounds), `slideAabb` (revert into
walls) and `rayAabb` (hitscan). The lower-level `kinematicStep`, `newState` and
`camApply` functions are exported too if you want to drive your own state.

## Data-driven scenes

For 3D, a `SceneDescriptor` declares mesh **prototypes** (`box` / `plane` / baked
glTF) plus the **entities** and **instance groups** that place them, and
`buildScene()` turns it into a `Scene3D`. The point is byte-exact parity with the
equivalent hand-written `onEnter`: nodes are added in declaration order and one
`Mesh` is shared per prototype, so the per-frame draw list is identical whether a
game hand-builds its scene or loads it from a descriptor. The
[asset pipeline](/docs/assets/) can bake a descriptor to the `.dcpak` store, and
`loadScene(key)` reads it back on any host.

```js
import { buildScene } from '../src/scene-desc'; // direct import

const { scene, nodes, colliders } = buildScene({
  camera: { fovDeg: 60, aspect: 480 / 272, near: 0.1, far: 200 },
  prototypes: {
    ground: { kind: 'plane', size: [100, 100], color: 0x4ca64c },
    crate: { kind: 'box', size: [1, 1, 1], colors: [0x8a5a2a] },
  },
  entities: [{ proto: 'ground' }],
  instances: [{ proto: 'crate', positions: [[2, 0.5, 2], [-3, 0.5, 1]] }],
  colliders: [{ min: [-50, 0, -50], max: [50, 5, 50] }],
});
engine.scene3d = scene;
```

See the [3D docs](/docs/3d/) for `Scene3D`, meshes, materials, lights and skinning,
and the [assets docs](/docs/assets/) for baking descriptors.

## Color and font

Colors are `0xRRGGBB` integers. `rgb(r,g,b)` packs one, `redOf`/`greenOf`/`blueOf`
unpack, `mix(a,b,t)` blends, and `Colors` is a small named palette
(`Colors.white`, `Colors.green`, `Colors.sky`, …).

The default 8×8 ASCII font is registered automatically by importing the SDK barrel
(a side effect of `src/index`). `getFont()` returns the active font and `setFont(f)`
swaps it; `g.text(...)` takes an optional trailing `font` argument.

## Direct imports

Most of the SDK comes from the `../src/index` barrel. Three 3D-oriented subsystems
are imported **directly from their module** instead, on purpose: a bare star-export
would keep them in every game's bundle (Bun can't drop a star-export reachable from
a 2D game's index import), bloating the PSP EBOOT. The 3D games import them directly:

```js
import { CharController, Collide } from '../src/controller';
import { ActionMap } from '../src/action';
import { loadScene, buildScene } from '../src/scene-desc';
```

For the same reason, baked glTF asset modules are imported directly (e.g.
`import { KENNEY_CAR } from '../src/assets-kenney-car'`) so a 2D game never drags a
3D asset blob into its pack. See [Assets & .dcpak](/docs/assets/).

## A complete example

Snake is the framework's reference game and a golden-test fixture — fully
deterministic (food via the seeded RNG, walls wrap), it exercises the scene
lifecycle, edge-detected input, RNG, and `Graphics`:

```js
// @ts-check
// @title Snake
import { Btn, Colors, Scene, start } from '../src/index';
/** @import { Graphics, UpdateContext } from '../src/index' */

const CELL = 16, COLS = 30, ROWS = 17;

class SnakeScene extends Scene {
  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.snake = [{ x: 10, y: 8 }, { x: 9, y: 8 }, { x: 8, y: 8 }];
    this.dir = { x: 1, y: 0 };
    this.next = { x: 1, y: 0 };
    this.ticks = 0;
    this.score = 0;
    this.placeFood(ctx);
  }

  /** @param {UpdateContext} ctx */
  placeFood(ctx) {
    for (;;) {
      const fx = ctx.rng.int(COLS), fy = ctx.rng.int(ROWS);
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
    let nx = (head.x + this.dir.x + COLS) % COLS;
    let ny = (head.y + this.dir.y + ROWS) % ROWS;
    if (this.snake.slice(0, -1).some((s) => s.x === nx && s.y === ny)) {
      this.onEnter(ctx); // self-collision -> restart
      return;
    }
    this.snake.unshift({ x: nx, y: ny });
    if (nx === this.food.x && ny === this.food.y) { this.score++; this.placeFood(ctx); }
    else this.snake.pop();
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
```

## Where to go next

- [Runtime contract](/docs/runtime-contract/) — the `gfx`/`log`/`frame(buttons)`
  layer the framework is built on, and raw vs framework games.
- [3D](/docs/3d/) — the `g3d` contract, `Scene3D`, meshes, materials, lights,
  skinning and the native scene offload.
- [Assets & .dcpak](/docs/assets/) — baking fonts, sprites, glTF and scenes.
- [API reference](/docs/api/) — module-by-module across `framework/src/`.
```
