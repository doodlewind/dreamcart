// @title Platformer (raw API)
// @order 15
// @controls LEFT/RIGHT run, CROSS jump, START restart
// platformer.js - a simple single-screen mini-Mario platformer for PSP / QuickJS
// Controls: LEFT/RIGHT = run, CROSS (X) = jump (only when on ground/platform),
//           START = restart after game over.
// Goal: collect yellow coins (each gives points). Avoid red enemies. Don't fall off the bottom.
// All graphics are filled rectangles. Numbers use the pixel-font helper.

// ---------- input button masks ----------
var BTN_UP = 0x10, BTN_RIGHT = 0x20, BTN_DOWN = 0x40, BTN_LEFT = 0x80;
var BTN_CROSS = 0x4000, BTN_CIRCLE = 0x2000, BTN_TRIANGLE = 0x1000, BTN_SQUARE = 0x8000;
var BTN_START = 0x08, BTN_SELECT = 0x01;

// ---------- screen ----------
var SCREEN_W = 480, SCREEN_H = 272;

// ---------- pixel font helper (verbatim) ----------
var GLYPHS = {
  '0':[7,5,5,5,7],'1':[2,6,2,2,7],'2':[7,1,7,4,7],'3':[7,1,7,1,7],'4':[5,5,7,1,1],
  '5':[7,4,7,1,7],'6':[7,4,7,5,7],'7':[7,1,2,2,2],'8':[7,5,7,5,7],'9':[7,5,7,1,7],
  ' ':[0,0,0,0,0],'-':[0,0,7,0,0],':':[0,2,0,2,0]
};
function drawGlyph(ch, x, y, s, r, g, b){
  var rows = GLYPHS[ch]; if(!rows) return;
  for(var ry=0; ry<5; ry++){ var bits=rows[ry];
    for(var cx=0; cx<3; cx++){ if(bits & (4>>cx)) gfx.fillRect(x+cx*s, y+ry*s, s, s, r,g,b); } }
}
// draws a string left-to-right; each char cell is 4*s wide, 5*s tall. Only digits, space, dash, colon exist.
function drawText(str, x, y, s, r, g, b){
  str = String(str);
  for(var i=0;i<str.length;i++){ drawGlyph(str[i], Math.floor(x + i*4*s), Math.floor(y), s, r,g,b); }
  return x + str.length*4*s;
}

// ---------- tuning constants ----------
var GRAVITY = 0.6;        // px/frame^2
var JUMP_VEL = -10;       // initial jump velocity (negative = up)
var MOVE_SPEED = 2.6;     // horizontal run speed px/frame
var MAX_FALL = 9;         // terminal velocity cap (prevents tunneling)

// ---------- player ----------
var PLAYER_W = 14, PLAYER_H = 18;
var START_X = 30, START_Y = 200;

var player = {
  x: START_X, y: START_Y,
  vx: 0, vy: 0,
  onGround: false
};

// ---------- platforms (solid rectangles). The first is the floor. ----------
// x, y, w, h
var platforms = [
  { x: 0,   y: 252, w: 480, h: 20 },   // floor
  { x: 60,  y: 210, w: 90,  h: 12 },
  { x: 200, y: 180, w: 100, h: 12 },
  { x: 360, y: 150, w: 90,  h: 12 },
  { x: 120, y: 120, w: 90,  h: 12 },
  { x: 280, y: 90,  w: 100, h: 12 },
  { x: 30,  y: 70,  w: 70,  h: 12 }
];

// ---------- coin ----------
var COIN_SIZE = 10;
var coin = { x: 0, y: 0 };

// ---------- enemies (patrol on a platform) ----------
var ENEMY_W = 14, ENEMY_H = 14;
// Each enemy references a platform index it patrols on.
var enemies = [
  { platIdx: 2, x: 0, y: 0, vx: 1.2, dir: 1 },
  { platIdx: 5, x: 0, y: 0, vx: 1.4, dir: 1 }
];

// ---------- game state ----------
var score = 0;
var lives = 3;
var gameOver = false;
var frameCount = 0;
var prevButtons = 0;
var hitCooldown = 0; // frames of invulnerability after a hit

// ---------- helpers ----------

// AABB overlap test
function overlap(ax, ay, aw, ah, bx, by, bw, bh){
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// place coin on a random platform's top surface
function placeCoin(){
  // pick any platform except the floor (index 0) most of the time, but floor is allowed
  var idx = 1 + Math.floor(Math.random() * (platforms.length - 1));
  if (idx < 0 || idx >= platforms.length) idx = 0;
  var p = platforms[idx];
  var range = p.w - COIN_SIZE;
  if (range < 0) range = 0;
  coin.x = Math.floor(p.x + Math.random() * range);
  coin.y = Math.floor(p.y - COIN_SIZE - 2);
}

// initialize an enemy's position based on the platform it patrols
function initEnemy(e){
  var p = platforms[e.platIdx];
  if (!p) { p = platforms[0]; e.platIdx = 0; }
  e.x = p.x + 4;
  e.y = p.y - ENEMY_H;
  e.dir = 1;
}

// reset the player to start (used on enemy touch or falling off)
function resetPlayer(){
  player.x = START_X;
  player.y = START_Y;
  player.vx = 0;
  player.vy = 0;
  player.onGround = false;
}

// full game reset
function reset(){
  score = 0;
  lives = 3;
  gameOver = false;
  hitCooldown = 0;
  resetPlayer();
  for (var i = 0; i < enemies.length; i++) initEnemy(enemies[i]);
  placeCoin();
}

// ---------- physics update ----------
function updatePlayer(buttons){
  // horizontal input
  player.vx = 0;
  if (buttons & BTN_LEFT)  player.vx = -MOVE_SPEED;
  if (buttons & BTN_RIGHT) player.vx =  MOVE_SPEED;

  // jump (edge-detected) only when standing on something
  var jumpPressed = (buttons & BTN_CROSS) && !(prevButtons & BTN_CROSS);
  if (jumpPressed && player.onGround){
    player.vy = JUMP_VEL;
    player.onGround = false;
  }

  // gravity
  player.vy += GRAVITY;
  if (player.vy > MAX_FALL) player.vy = MAX_FALL;
  if (player.vy < -MAX_FALL * 2) player.vy = -MAX_FALL * 2;

  // ----- horizontal movement + collision (resolved separately) -----
  player.x += player.vx;
  // keep inside screen horizontally
  if (player.x < 0) player.x = 0;
  if (player.x + PLAYER_W > SCREEN_W) player.x = SCREEN_W - PLAYER_W;

  for (var i = 0; i < platforms.length; i++){
    var p = platforms[i];
    if (overlap(player.x, player.y, PLAYER_W, PLAYER_H, p.x, p.y, p.w, p.h)){
      if (player.vx > 0){
        player.x = p.x - PLAYER_W; // hit left side of platform
      } else if (player.vx < 0){
        player.x = p.x + p.w;      // hit right side of platform
      }
    }
  }

  // ----- vertical movement + collision (resolved separately) -----
  player.onGround = false;
  player.y += player.vy;

  for (var j = 0; j < platforms.length; j++){
    var q = platforms[j];
    if (overlap(player.x, player.y, PLAYER_W, PLAYER_H, q.x, q.y, q.w, q.h)){
      if (player.vy > 0){
        // falling: land on top
        player.y = q.y - PLAYER_H;
        player.vy = 0;
        player.onGround = true;
      } else if (player.vy < 0){
        // moving up: bonk head
        player.y = q.y + q.h;
        player.vy = 0;
      }
    }
  }

  // fell below the screen -> lose a life and reset
  if (player.y > SCREEN_H){
    loseLife();
  }
}

// update enemy patrol
function updateEnemies(){
  for (var i = 0; i < enemies.length; i++){
    var e = enemies[i];
    var p = platforms[e.platIdx];
    if (!p) continue;
    e.x += e.vx * e.dir;
    // reverse at platform edges
    if (e.x < p.x){
      e.x = p.x;
      e.dir = 1;
    } else if (e.x + ENEMY_W > p.x + p.w){
      e.x = p.x + p.w - ENEMY_W;
      e.dir = -1;
    }
    e.y = p.y - ENEMY_H; // keep sitting on the platform
  }
}

// handle losing a life
function loseLife(){
  lives--;
  if (lives <= 0){
    lives = 0;
    gameOver = true;
  }
  resetPlayer();
  hitCooldown = 45; // brief invulnerability window after respawn
}

// check coin pickup and enemy collisions
function checkInteractions(){
  // coin
  if (overlap(player.x, player.y, PLAYER_W, PLAYER_H, coin.x, coin.y, COIN_SIZE, COIN_SIZE)){
    score += 10;
    placeCoin();
  }

  // enemies
  if (hitCooldown <= 0){
    for (var i = 0; i < enemies.length; i++){
      var e = enemies[i];
      if (overlap(player.x, player.y, PLAYER_W, PLAYER_H, e.x, e.y, ENEMY_W, ENEMY_H)){
        loseLife();
        break;
      }
    }
  }
}

// ---------- drawing ----------
function drawScene(){
  // sky background (dark blue-ish so rectangles pop)
  gfx.clear(30, 40, 70);

  // platforms: floor is green-topped brown, others brown with green top
  for (var i = 0; i < platforms.length; i++){
    var p = platforms[i];
    // brown body
    gfx.fillRect(Math.floor(p.x), Math.floor(p.y), Math.floor(p.w), Math.floor(p.h), 120, 72, 30);
    // green top strip
    gfx.fillRect(Math.floor(p.x), Math.floor(p.y), Math.floor(p.w), 4, 70, 170, 60);
  }

  // coin (yellow), with a slight blink for visibility
  if ((frameCount >> 3) % 8 !== 7){
    gfx.fillRect(Math.floor(coin.x), Math.floor(coin.y), COIN_SIZE, COIN_SIZE, 250, 215, 40);
    // inner highlight
    gfx.fillRect(Math.floor(coin.x) + 3, Math.floor(coin.y) + 2, 3, 4, 255, 245, 160);
  }

  // enemies (red)
  for (var k = 0; k < enemies.length; k++){
    var e = enemies[k];
    gfx.fillRect(Math.floor(e.x), Math.floor(e.y), ENEMY_W, ENEMY_H, 220, 50, 50);
    // dark eyes to make them obvious
    gfx.fillRect(Math.floor(e.x) + 2, Math.floor(e.y) + 3, 3, 3, 30, 0, 0);
    gfx.fillRect(Math.floor(e.x) + ENEMY_W - 5, Math.floor(e.y) + 3, 3, 3, 30, 0, 0);
  }

  // player (cyan), flicker while invulnerable
  var drawPlayer = true;
  if (hitCooldown > 0 && (frameCount >> 2) % 2 === 0) drawPlayer = false;
  if (drawPlayer){
    gfx.fillRect(Math.floor(player.x), Math.floor(player.y), PLAYER_W, PLAYER_H, 60, 200, 230);
    // simple "face" detail
    gfx.fillRect(Math.floor(player.x) + 3, Math.floor(player.y) + 4, 8, 5, 20, 60, 90);
  }

  // HUD: score (top-left) and lives (top-right) as numbers
  drawText(score, 8, 8, 3, 255, 255, 255);
  // lives shown as a number on the right
  drawText(lives, SCREEN_W - 4 * 4 * 3 - 8, 8, 3, 255, 200, 60);

  // game over overlay: red tint + blinking restart prompt rectangle
  if (gameOver){
    // red tint via many thin bars (we only have fillRect; draw a translucent-looking grid)
    // Simulate a tint by drawing a sparse red checker so the scene stays visible.
    for (var ty = 0; ty < SCREEN_H; ty += 4){
      gfx.fillRect(0, ty, SCREEN_W, 2, 160, 20, 20);
    }
    // blinking "press START" prompt: a white rectangle that blinks
    if ((frameCount >> 4) % 2 === 0){
      gfx.fillRect(SCREEN_W / 2 - 60, SCREEN_H / 2 - 10, 120, 20, 240, 240, 240);
      gfx.fillRect(SCREEN_W / 2 - 56, SCREEN_H / 2 - 6, 112, 12, 160, 20, 20);
    }
    // show final score centered below
    drawText(score, SCREEN_W / 2 - 24, SCREEN_H / 2 + 24, 3, 255, 255, 255);
  }
}

// ---------- main frame ----------
function frame(buttons){
  // guard buttons
  if (typeof buttons !== "number") buttons = 0;

  frameCount++;
  if (hitCooldown > 0) hitCooldown--;

  if (!gameOver){
    updatePlayer(buttons);
    updateEnemies();
    checkInteractions();
  } else {
    // wait for START (edge-detected) to restart
    if ((buttons & BTN_START) && !(prevButtons & BTN_START)){
      reset();
    }
  }

  drawScene();

  prevButtons = buttons;
}

// ---------- init once, before frame is wired ----------
log("platformer.js starting");
reset();

globalThis.frame = frame;
