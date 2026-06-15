// ============================================================
// TETRIS  (tetris.js)
// Classic Tetris for PSP / QuickJS runtime.
// Controls:
//   LEFT / RIGHT : move piece horizontally (auto-repeat)
//   DOWN         : soft drop (fall faster while held)
//   CROSS (X) or UP : rotate clockwise (edge-detected)
//   START        : restart after GAME OVER
// Build everything from gfx.fillRect. Numbers via pixel font.
// ============================================================

// ---------- Button masks ----------
var BTN_UP=0x10, BTN_RIGHT=0x20, BTN_DOWN=0x40, BTN_LEFT=0x80;
var BTN_CROSS=0x4000, BTN_CIRCLE=0x2000, BTN_TRIANGLE=0x1000, BTN_SQUARE=0x8000;
var BTN_START=0x08, BTN_SELECT=0x01;

// ---------- Pixel font (verbatim helper) ----------
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
function drawText(str, x, y, s, r, g, b){
  str = String(str);
  for(var i=0;i<str.length;i++){ drawGlyph(str[i], Math.floor(x + i*4*s), Math.floor(y), s, r,g,b); }
  return x + str.length*4*s;
}

// ---------- Board geometry ----------
var COLS = 10, ROWS = 20, CELL = 12;
var BOARD_W = COLS * CELL;          // 120
var BOARD_H = ROWS * CELL;          // 240
var BOARD_X = Math.floor((480 - BOARD_W) / 2); // center horizontally -> 180
var BOARD_Y = 16;                   // leave top space
var BORDER = 3;

// ---------- Tetromino definitions ----------
// Each piece is defined as a list of 4 rotation states.
// Each state is an array of [col,row] cell offsets within a small box.
// Rotations are precomputed and verified to rotate clockwise correctly.
// Colors: [r,g,b]
var PIECES = [
  // I  (cyan)
  {
    color:[0,240,240],
    rot:[
      [[0,1],[1,1],[2,1],[3,1]],
      [[2,0],[2,1],[2,2],[2,3]],
      [[0,2],[1,2],[2,2],[3,2]],
      [[1,0],[1,1],[1,2],[1,3]]
    ]
  },
  // O  (yellow) - same every rotation
  {
    color:[240,240,0],
    rot:[
      [[1,0],[2,0],[1,1],[2,1]],
      [[1,0],[2,0],[1,1],[2,1]],
      [[1,0],[2,0],[1,1],[2,1]],
      [[1,0],[2,0],[1,1],[2,1]]
    ]
  },
  // T  (purple)
  {
    color:[170,0,240],
    rot:[
      [[1,0],[0,1],[1,1],[2,1]],
      [[1,0],[1,1],[2,1],[1,2]],
      [[0,1],[1,1],[2,1],[1,2]],
      [[1,0],[0,1],[1,1],[1,2]]
    ]
  },
  // S  (green)
  {
    color:[0,220,0],
    rot:[
      [[1,0],[2,0],[0,1],[1,1]],
      [[1,0],[1,1],[2,1],[2,2]],
      [[1,1],[2,1],[0,2],[1,2]],
      [[0,0],[0,1],[1,1],[1,2]]
    ]
  },
  // Z  (red)
  {
    color:[240,0,0],
    rot:[
      [[0,0],[1,0],[1,1],[2,1]],
      [[2,0],[1,1],[2,1],[1,2]],
      [[0,1],[1,1],[1,2],[2,2]],
      [[1,0],[0,1],[1,1],[0,2]]
    ]
  },
  // J  (blue)
  {
    color:[0,80,240],
    rot:[
      [[0,0],[0,1],[1,1],[2,1]],
      [[1,0],[2,0],[1,1],[1,2]],
      [[0,1],[1,1],[2,1],[2,2]],
      [[1,0],[1,1],[0,2],[1,2]]
    ]
  },
  // L  (orange)
  {
    color:[240,140,0],
    rot:[
      [[2,0],[0,1],[1,1],[2,1]],
      [[1,0],[1,1],[1,2],[2,2]],
      [[0,1],[1,1],[2,1],[0,2]],
      [[0,0],[1,0],[1,1],[1,2]]
    ]
  }
];

// ---------- Game state ----------
var board;          // ROWS x COLS, each cell: null or [r,g,b]
var cur;            // current piece index
var curRot;         // current rotation index 0..3
var curX, curY;     // top-left position of piece box in board cells
var nextPiece;      // next piece index
var score, lines, level;
var gameOver;
var dropTimer;      // frames since last gravity step
var prevButtons;
var flashTimer;     // brief flash on line clear
var blink;          // blink counter for restart prompt

// auto-repeat for horizontal movement
var moveTimer, moveDir;
var DAS = 9;        // initial delay frames before repeat
var ARR = 3;        // repeat interval frames

function randPiece(){ return Math.floor(Math.random() * PIECES.length); }

function reset(){
  board = [];
  for(var y=0; y<ROWS; y++){
    var row = [];
    for(var x=0; x<COLS; x++) row.push(null);
    board.push(row);
  }
  score = 0; lines = 0; level = 0;
  gameOver = false;
  dropTimer = 0;
  flashTimer = 0;
  blink = 0;
  moveTimer = 0; moveDir = 0;
  nextPiece = randPiece();
  spawn();
}

// Returns the cells of a given piece/rotation translated by (ox,oy)
function pieceCells(pi, rot, ox, oy){
  var def = PIECES[pi];
  if(!def) return [];
  var state = def.rot[((rot % 4) + 4) % 4];
  var out = [];
  for(var i=0;i<state.length;i++){
    out.push([state[i][0] + ox, state[i][1] + oy]);
  }
  return out;
}

// Check whether a piece at (pi,rot,ox,oy) is in a valid position.
function valid(pi, rot, ox, oy){
  var cells = pieceCells(pi, rot, ox, oy);
  for(var i=0;i<cells.length;i++){
    var cx = cells[i][0], cy = cells[i][1];
    if(cx < 0 || cx >= COLS) return false;     // out left/right
    if(cy >= ROWS) return false;               // out bottom
    if(cy < 0) continue;                        // above top is allowed
    if(board[cy] && board[cy][cx]) return false; // overlap locked cell
  }
  return true;
}

// Spawn the queued next piece at the top.
function spawn(){
  cur = nextPiece;
  nextPiece = randPiece();
  curRot = 0;
  curX = 3;   // box is 4 wide; center-ish
  curY = 0;
  // If spawn position already collides -> game over.
  if(!valid(cur, curRot, curX, curY)){
    gameOver = true;
  }
}

// Lock current piece into the board.
function lockPiece(){
  var def = PIECES[cur];
  var cells = pieceCells(cur, curRot, curX, curY);
  for(var i=0;i<cells.length;i++){
    var cx = cells[i][0], cy = cells[i][1];
    if(cy >= 0 && cy < ROWS && cx >= 0 && cx < COLS){
      board[cy][cx] = def.color;
    }
  }
  clearLines();
  spawn();
}

// Clear full rows; shift everything above down. Award score.
function clearLines(){
  var cleared = 0;
  for(var y=ROWS-1; y>=0; y--){
    var full = true;
    for(var x=0; x<COLS; x++){
      if(!board[y][x]){ full = false; break; }
    }
    if(full){
      // remove row y, insert empty row at top
      board.splice(y, 1);
      var empty = [];
      for(var x2=0; x2<COLS; x2++) empty.push(null);
      board.unshift(empty);
      cleared++;
      y++; // re-check same index (now holds the row that shifted down)
    }
  }
  if(cleared > 0){
    // Standard-ish scoring, scaled by level+1
    var base = [0, 40, 100, 300, 1200];
    var idx = cleared; if(idx > 4) idx = 4;
    score += base[idx] * (level + 1);
    lines += cleared;
    level = Math.floor(lines / 10);
    flashTimer = 8;
  }
}

// Gravity step interval (frames per drop) based on level.
function gravityInterval(){
  var n = 48 - level * 4;
  if(n < 4) n = 4;
  return n;
}

// ---------- Drawing ----------
function drawCell(cx, cy, r, g, b){
  if(cy < 0) return; // don't draw cells above the well
  var px = BOARD_X + cx * CELL;
  var py = BOARD_Y + cy * CELL;
  // body
  gfx.fillRect(px, py, CELL, CELL, r, g, b);
  // simple bevel: lighter top-left edge, darker inset feel
  var lr = Math.min(255, r + 60), lg = Math.min(255, g + 60), lb = Math.min(255, b + 60);
  gfx.fillRect(px, py, CELL, 2, lr, lg, lb);
  gfx.fillRect(px, py, 2, CELL, lr, lg, lb);
  var dr = Math.floor(r * 0.5), dg = Math.floor(g * 0.5), db = Math.floor(b * 0.5);
  gfx.fillRect(px, py + CELL - 2, CELL, 2, dr, dg, db);
  gfx.fillRect(px + CELL - 2, py, 2, CELL, dr, dg, db);
}

function draw(){
  // background
  gfx.clear(15, 15, 25);

  // board border
  gfx.fillRect(BOARD_X - BORDER, BOARD_Y - BORDER,
               BOARD_W + BORDER*2, BOARD_H + BORDER*2, 90, 90, 130);
  // well interior (dark)
  gfx.fillRect(BOARD_X, BOARD_Y, BOARD_W, BOARD_H, 8, 8, 14);

  // faint grid lines for clarity
  for(var gx=1; gx<COLS; gx++){
    gfx.fillRect(BOARD_X + gx*CELL, BOARD_Y, 1, BOARD_H, 20, 20, 32);
  }
  for(var gy=1; gy<ROWS; gy++){
    gfx.fillRect(BOARD_X, BOARD_Y + gy*CELL, BOARD_W, 1, 20, 20, 32);
  }

  // locked cells
  for(var y=0; y<ROWS; y++){
    for(var x=0; x<COLS; x++){
      var c = board[y][x];
      if(c) drawCell(x, y, c[0], c[1], c[2]);
    }
  }

  // active piece (only when not game over)
  if(!gameOver){
    var def = PIECES[cur];
    var cells = pieceCells(cur, curRot, curX, curY);
    for(var i=0;i<cells.length;i++){
      drawCell(cells[i][0], cells[i][1], def.color[0], def.color[1], def.color[2]);
    }
  }

  // line-clear flash overlay (white tint over the well)
  if(flashTimer > 0){
    gfx.fillRect(BOARD_X, BOARD_Y, BOARD_W, BOARD_H, 255, 255, 255);
  }

  // ---------- HUD (left side) ----------
  var hx = 14, hy = 30;
  // SCORE
  drawText("123", -999, -999, 1, 0,0,0); // no-op safety (never visible)
  // score label is numeric only; show value
  drawText(score, hx, hy, 2, 230, 230, 230);
  // level
  drawText(level, hx, hy + 30, 2, 120, 220, 120);
  // lines
  drawText(lines, hx, hy + 60, 2, 220, 200, 120);

  // ---------- Next piece preview (right side) ----------
  var nx = 410, ny = 40;
  // preview box
  gfx.fillRect(nx - 4, ny - 4, CELL*4 + 8, CELL*4 + 8, 90, 90, 130);
  gfx.fillRect(nx, ny, CELL*4, CELL*4, 8, 8, 14);
  var ndef = PIECES[nextPiece];
  if(ndef){
    var nstate = ndef.rot[0];
    for(var k=0;k<nstate.length;k++){
      var ncx = nstate[k][0], ncy = nstate[k][1];
      var ppx = nx + ncx * CELL;
      var ppy = ny + ncy * CELL;
      gfx.fillRect(ppx, ppy, CELL, CELL, ndef.color[0], ndef.color[1], ndef.color[2]);
      var llr=Math.min(255,ndef.color[0]+60), llg=Math.min(255,ndef.color[1]+60), llb=Math.min(255,ndef.color[2]+60);
      gfx.fillRect(ppx, ppy, CELL, 2, llr, llg, llb);
      gfx.fillRect(ppx, ppy, 2, CELL, llr, llg, llb);
    }
  }

  // ---------- Game over overlay ----------
  if(gameOver){
    // red tint over whole screen
    gfx.fillRect(0, 0, 480, 272, 120, 0, 0);
    // re-draw board border + well + locked cells dimly so it stays readable
    gfx.fillRect(BOARD_X - BORDER, BOARD_Y - BORDER,
                 BOARD_W + BORDER*2, BOARD_H + BORDER*2, 60, 30, 40);
    gfx.fillRect(BOARD_X, BOARD_Y, BOARD_W, BOARD_H, 20, 8, 12);
    for(var yy=0; yy<ROWS; yy++){
      for(var xx=0; xx<COLS; xx++){
        var cc = board[yy][xx];
        if(cc){
          var dpx = BOARD_X + xx*CELL, dpy = BOARD_Y + yy*CELL;
          gfx.fillRect(dpx, dpy, CELL, CELL,
            Math.floor(cc[0]*0.6), Math.floor(cc[1]*0.6), Math.floor(cc[2]*0.6));
        }
      }
    }
    // final score, centered-ish
    drawText(score, BOARD_X + 6, BOARD_Y + 100, 3, 255, 255, 255);
    // blinking "press START" prompt = blinking white bar
    if(((blink >> 4) & 1) === 0){
      gfx.fillRect(BOARD_X + 10, BOARD_Y + 150, BOARD_W - 20, 14, 240, 240, 240);
    }
  }
}

// ---------- Per-frame update ----------
function frame(buttons){
  blink++;
  if(flashTimer > 0) flashTimer--;

  if(gameOver){
    // wait for START (edge) to restart
    if((buttons & BTN_START) && !(prevButtons & BTN_START)){
      reset();
    }
    draw();
    prevButtons = buttons;
    return;
  }

  // ---- Horizontal movement with auto-repeat ----
  var left = (buttons & BTN_LEFT) ? true : false;
  var right = (buttons & BTN_RIGHT) ? true : false;
  var dir = 0;
  if(left && !right) dir = -1;
  else if(right && !left) dir = 1;

  if(dir !== 0){
    if(dir !== moveDir){
      // new direction press -> move immediately, start DAS
      moveDir = dir;
      moveTimer = 0;
      if(valid(cur, curRot, curX + dir, curY)) curX += dir;
      moveTimer = DAS; // count down toward repeat
    } else {
      moveTimer--;
      if(moveTimer <= 0){
        if(valid(cur, curRot, curX + dir, curY)) curX += dir;
        moveTimer = ARR;
      }
    }
  } else {
    moveDir = 0;
    moveTimer = 0;
  }

  // ---- Rotate clockwise (edge-detected): CROSS or UP ----
  var rotPressed = ((buttons & BTN_CROSS) && !(prevButtons & BTN_CROSS)) ||
                   ((buttons & BTN_UP)    && !(prevButtons & BTN_UP));
  if(rotPressed){
    var nr = (curRot + 1) % 4;
    // try simple wall kicks: 0, right, left, two-right, two-left
    var kicks = [0, 1, -1, 2, -2];
    for(var ki=0; ki<kicks.length; ki++){
      if(valid(cur, nr, curX + kicks[ki], curY)){
        curRot = nr;
        curX += kicks[ki];
        break;
      }
    }
  }

  // ---- Gravity / soft drop ----
  var softDrop = (buttons & BTN_DOWN) ? true : false;
  dropTimer++;
  var interval = softDrop ? 2 : gravityInterval();
  if(dropTimer >= interval){
    dropTimer = 0;
    if(valid(cur, curRot, curX, curY + 1)){
      curY += 1;
      if(softDrop) score += 1; // tiny reward for soft drop
    } else {
      lockPiece(); // lock, clear lines, spawn next (may set gameOver)
    }
  }

  draw();
  prevButtons = buttons;
}

// ---------- Init once, before frame is exposed ----------
prevButtons = 0;
reset();
log("Tetris ready");

globalThis.frame = frame;
