// @title 2048 (raw API)
// @order 12
// @controls D-pad slide; START restart
// 2048 for PSP (QuickJS runtime)
// Controls: D-Pad = slide tiles (UP/DOWN/LEFT/RIGHT). START = restart after game over.
// Merge equal adjacent tiles once per move; reach 2048 to win (continue allowed).

// ---- Pixel font helper (verbatim) ----
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

// ---- Input masks ----
var BTN_UP=0x10, BTN_RIGHT=0x20, BTN_DOWN=0x40, BTN_LEFT=0x80, BTN_START=0x08;

// ---- Board geometry ----
var SIZE = 4;
var TILE = 56;        // tile size in px
var GAP = 6;          // gap between tiles
// Total board pixel size: 4 tiles + 5 gaps (gap also on the outer edges)
var BOARD = SIZE*TILE + (SIZE+1)*GAP;   // = 4*56 + 5*6 = 254
var BOARD_X = Math.floor((480 - BOARD)/2);   // centered horizontally
var BOARD_Y = 272 - BOARD - 6;               // pinned near bottom, room for score on top

// ---- Game state ----
var grid;          // 2D array [row][col]
var score;
var gameOver;
var prevButtons = 0;

// Cell value -> background color [r,g,b]
function tileColor(v){
  switch(v){
    case 2:    return [238,228,218];
    case 4:    return [237,224,200];
    case 8:    return [242,177,121];
    case 16:   return [245,149,99];
    case 32:   return [246,124,95];
    case 64:   return [246,94,59];
    case 128:  return [237,207,114];
    case 256:  return [237,204,97];
    case 512:  return [237,200,80];
    case 1024: return [237,197,63];
    case 2048: return [237,194,46];
    default:   return [60,58,80]; // >2048 fallback (deep purple)
  }
}
// Choose dark text on light (small) tiles, light text on dark (big) tiles.
function textColor(v){
  if(v <= 4) return [119,110,101]; // dark text
  return [249,246,242];            // light text
}

function newGrid(){
  var g = [];
  for(var r=0;r<SIZE;r++){ g[r]=[]; for(var c=0;c<SIZE;c++) g[r][c]=0; }
  return g;
}

function emptyCells(){
  var cells=[];
  for(var r=0;r<SIZE;r++) for(var c=0;c<SIZE;c++) if(grid[r][c]===0) cells.push([r,c]);
  return cells;
}

function spawnTile(){
  var cells = emptyCells();
  if(cells.length===0) return;
  var idx = Math.floor(Math.random()*cells.length);
  if(idx>=cells.length) idx=cells.length-1; // guard
  var cell = cells[idx];
  grid[cell[0]][cell[1]] = (Math.random()<0.9) ? 2 : 4;
}

function reset(){
  grid = newGrid();
  score = 0;
  gameOver = false;
  spawnTile();
  spawnTile();
}

// Compact + merge a line toward index 0. Returns {line, gained}.
function slideLine(line){
  var arr=[];
  for(var i=0;i<line.length;i++) if(line[i]!==0) arr.push(line[i]);
  var gained=0; var out=[];
  for(var i=0;i<arr.length;i++){
    if(i+1<arr.length && arr[i]===arr[i+1]){ var m=arr[i]*2; out.push(m); gained+=m; i++; }
    else out.push(arr[i]);
  }
  while(out.length<line.length) out.push(0);
  return {line:out, gained:gained};
}

// Apply a move in direction dir ("L","R","U","D"). Returns true if board changed.
function move(dir){
  var moved=false; var gained=0;
  for(var k=0;k<SIZE;k++){
    // Read a line in the order that slides toward index 0.
    var line=[];
    for(var i=0;i<SIZE;i++){
      var v;
      if(dir==="L") v=grid[k][i];
      else if(dir==="R") v=grid[k][SIZE-1-i];
      else if(dir==="U") v=grid[i][k];
      else v=grid[SIZE-1-i][k]; // "D"
      line.push(v);
    }
    var res=slideLine(line);
    gained+=res.gained;
    // Write back to the same positions.
    for(var i=0;i<SIZE;i++){
      var nv=res.line[i]; var or, oc;
      if(dir==="L"){ or=k; oc=i; }
      else if(dir==="R"){ or=k; oc=SIZE-1-i; }
      else if(dir==="U"){ or=i; oc=k; }
      else { or=SIZE-1-i; oc=k; } // "D"
      if(grid[or][oc]!==nv) moved=true;
      grid[or][oc]=nv;
    }
  }
  if(moved){ score+=gained; spawnTile(); }
  return moved;
}

// Game over: board full and no merges possible in any direction.
function checkGameOver(){
  if(emptyCells().length>0) return false;
  for(var r=0;r<SIZE;r++){
    for(var c=0;c<SIZE;c++){
      var v=grid[r][c];
      if(c+1<SIZE && grid[r][c+1]===v) return false;
      if(r+1<SIZE && grid[r+1][c]===v) return false;
    }
  }
  return true;
}

// ---- Init once, before frame() ----
log("2048: DPAD move, START restart");
reset();

// Draw a digit string centered inside a cell rectangle.
function drawCentered(str, cx, cy, s, r, g, b){
  str = String(str);
  // text width: chars are 3*s wide with s gap between -> n*3*s + (n-1)*s = 4*s*n - s
  var tw = 4*s*str.length - s;
  var th = 5*s;
  drawText(str, Math.floor(cx - tw/2), Math.floor(cy - th/2), s, r, g, b);
}

var blinkCounter = 0;

function frame(buttons){
  // ---- Update ----
  if(!gameOver){
    var did=false;
    if((buttons&BTN_LEFT)  && !(prevButtons&BTN_LEFT))  did = move("L") || did;
    if((buttons&BTN_RIGHT) && !(prevButtons&BTN_RIGHT)) did = move("R") || did;
    if((buttons&BTN_UP)    && !(prevButtons&BTN_UP))    did = move("U") || did;
    if((buttons&BTN_DOWN)  && !(prevButtons&BTN_DOWN))  did = move("D") || did;
    if(did && checkGameOver()) gameOver = true;
  } else {
    if((buttons&BTN_START) && !(prevButtons&BTN_START)) reset();
  }
  blinkCounter++;
  prevButtons = buttons;

  // ---- Draw ----
  gfx.clear(24, 22, 34); // dark background

  // Score (top), number only.
  drawText(score, 12, 8, 4, 235, 235, 245);

  // Board backing panel.
  gfx.fillRect(BOARD_X, BOARD_Y, BOARD, BOARD, 46, 42, 66);

  // Tiles.
  for(var r=0;r<SIZE;r++){
    for(var c=0;c<SIZE;c++){
      var x = BOARD_X + GAP + c*(TILE+GAP);
      var y = BOARD_Y + GAP + r*(TILE+GAP);
      var v = grid[r][c];
      if(v===0){
        gfx.fillRect(x, y, TILE, TILE, 60, 56, 84); // empty cell
      } else {
        var col = tileColor(v);
        gfx.fillRect(x, y, TILE, TILE, col[0], col[1], col[2]);
        var tc = textColor(v);
        // Pick glyph scale so the number fits in the tile.
        var digits = String(v).length;
        var s;
        if(digits<=2) s=8;
        else if(digits===3) s=6;
        else s=4; // 4 digits (1024/2048+)
        drawCentered(v, x+TILE/2, y+TILE/2, s, tc[0], tc[1], tc[2]);
      }
    }
  }

  // Game over overlay: dark cover over board + blinking restart prompt.
  if(gameOver){
    gfx.fillRect(BOARD_X, BOARD_Y, BOARD, BOARD, 10, 8, 16);
    drawCentered(score, 240, BOARD_Y + BOARD/2 - 20, 6, 255, 80, 80);
    if(Math.floor(blinkCounter/30)%2===0){
      gfx.fillRect(240-40, BOARD_Y + BOARD/2 + 16, 80, 14, 230, 200, 60);
    }
  }
}

globalThis.frame = frame;
