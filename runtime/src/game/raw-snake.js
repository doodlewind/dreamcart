// @title Snake (raw API)
// @order 10
// @controls D-pad steer; walls wrap; START restart
// Classic Snake, written in JavaScript, running on QuickJS on a Sony PSP.
//
// Host API provided by the Rust runtime (on globalThis):
//   gfx.clear(r, g, b)                       -- clear the screen
//   gfx.fillRect(x, y, w, h, r, g, b)        -- draw a filled rectangle
//   log(msg)                                 -- print to the debug overlay
//
// The Rust host calls frame(buttons) once per vblank (~60 Hz). `buttons` is the
// PSP controller bitmask. We never run our own loop; pacing is the host's job.

var CELL = 20;
var COLS = 24; // 24 * 20 = 480 (full width)
var ROWS = 13; // 13 * 20 = 260
var OFF_Y = 12; // leave a 12px strip at the top for the score bar

// PSP controller button bits (mirror psp::sys::CtrlButtons).
var BTN_UP = 0x10;
var BTN_RIGHT = 0x20;
var BTN_DOWN = 0x40;
var BTN_LEFT = 0x80;
var BTN_START = 0x08;

var MOVE_EVERY = 8; // advance the snake every 8 frames (~7.5 cells/sec)

var snake, dir, nextDir, food, ticks, alive, prevButtons;

function rnd(n) {
  return Math.floor(Math.random() * n);
}

function placeFood() {
  while (true) {
    var fx = rnd(COLS);
    var fy = rnd(ROWS);
    var hit = false;
    for (var i = 0; i < snake.length; i++) {
      if (snake[i].x === fx && snake[i].y === fy) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      food = { x: fx, y: fy };
      return;
    }
  }
}

function reset() {
  snake = [{ x: 5, y: 6 }, { x: 4, y: 6 }, { x: 3, y: 6 }]; // head first
  dir = { x: 1, y: 0 };
  nextDir = { x: 1, y: 0 };
  ticks = 0;
  alive = true;
  prevButtons = 0;
  placeFood();
}

function tryTurn(buttons) {
  // Disallow 180-degree reversals.
  if (buttons & BTN_UP && dir.y === 0) nextDir = { x: 0, y: -1 };
  else if (buttons & BTN_DOWN && dir.y === 0) nextDir = { x: 0, y: 1 };
  else if (buttons & BTN_LEFT && dir.x === 0) nextDir = { x: -1, y: 0 };
  else if (buttons & BTN_RIGHT && dir.x === 0) nextDir = { x: 1, y: 0 };
}

function step() {
  dir = nextDir;
  var head = snake[0];
  var nx = head.x + dir.x;
  var ny = head.y + dir.y;

  // Walls wrap around (the snake reappears on the opposite edge).
  if (nx < 0) nx = COLS - 1;
  else if (nx >= COLS) nx = 0;
  if (ny < 0) ny = ROWS - 1;
  else if (ny >= ROWS) ny = 0;

  // Self collision (the tail cell will move away, so ignore it).
  for (var i = 0; i < snake.length - 1; i++) {
    if (snake[i].x === nx && snake[i].y === ny) {
      alive = false;
      return;
    }
  }

  snake.unshift({ x: nx, y: ny });
  if (nx === food.x && ny === food.y) {
    placeFood(); // eat: keep the tail (grow by one)
  } else {
    snake.pop(); // normal move: drop the tail
  }
}

function drawCell(cx, cy, r, g, b) {
  gfx.fillRect(cx * CELL, OFF_Y + cy * CELL, CELL - 1, CELL - 1, r, g, b);
}

function draw() {
  gfx.clear(15, 20, 30); // dark background
  drawCell(food.x, food.y, 220, 40, 40); // food (red)
  for (var i = 0; i < snake.length; i++) {
    var s = snake[i];
    if (i === 0) drawCell(s.x, s.y, 120, 255, 120); // head (bright green)
    else drawCell(s.x, s.y, 40, 180, 60); // body (green)
  }
  // Score bar: one yellow tick per food eaten.
  var score = snake.length - 3;
  for (var k = 0; k < score && k < COLS; k++) {
    gfx.fillRect(k * CELL, 0, CELL - 2, OFF_Y - 2, 240, 220, 80);
  }
}

reset();
log("snake.js loaded");

// Called by the Rust host once per frame.
function frame(buttons) {
  if (!alive) {
    // Show a red-tinted board; press START to restart.
    if (buttons & BTN_START && !(prevButtons & BTN_START)) {
      reset();
    }
    prevButtons = buttons;
    gfx.clear(40, 10, 10);
    for (var i = 0; i < snake.length; i++) {
      drawCell(snake[i].x, snake[i].y, 120, 60, 60);
    }
    return;
  }

  tryTurn(buttons);
  prevButtons = buttons;

  ticks++;
  if (ticks >= MOVE_EVERY) {
    ticks = 0;
    step();
  }

  draw();
}

globalThis.frame = frame;
