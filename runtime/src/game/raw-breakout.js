// Breakout / Arkanoid for PSP (QuickJS)
// Controls: LEFT/RIGHT move paddle, CROSS launches ball (auto-launch after ~90 frames),
//           START restarts after game over.

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

// ---- Button masks ----
var UP=0x10, RIGHT=0x20, DOWN=0x40, LEFT=0x80;
var CROSS=0x4000, CIRCLE=0x2000, TRIANGLE=0x1000, SQUARE=0x8000, START=0x08, SELECT=0x01;

// ---- Screen / layout constants ----
var SCRW=480, SCRH=272;
var PADDLE_W=64, PADDLE_H=8;
var PADDLE_Y=SCRH-24;          // fixed vertical position of paddle
var PADDLE_SPEED=6;
var BALL_SIZE=6;

// Brick grid layout
var COLS=9, ROWS=5;
var GRID_TOP=40;               // top y of brick grid
var GRID_LEFT=24;              // left x of brick grid
var GRID_W=SCRW-48;            // usable width
var GAP=4;                     // gap between bricks
var BRICK_W=Math.floor((GRID_W-(COLS-1)*GAP)/COLS);
var BRICK_H=14;

// Per-row colors (top to bottom) and point values
var ROW_COLORS=[
  [220,60,60],   // red
  [230,140,40],  // orange
  [230,210,40],  // yellow
  [80,200,80],   // green
  [80,140,230]   // blue
];
var ROW_POINTS=[50,40,30,20,10];

// ---- Game state ----
var bricks=[];          // flat array length COLS*ROWS, true = alive
var bricksLeft=0;
var paddleX=0;
var ballX=0, ballY=0, ballVX=0, ballVY=0;
var ballOnPaddle=true;
var launchTimer=0;      // frames waited before auto-launch
var score=0;
var lives=3;
var level=1;
var baseSpeed=3.2;      // ball speed magnitude for current level
var gameOver=false;
var prevButtons=0;
var blink=0;            // frame counter for blinking prompts
var flash=0;            // brief flash timer (life lost / game over)

// Build (or rebuild) the brick grid
function buildBricks(){
  bricks=[];
  for(var i=0;i<COLS*ROWS;i++) bricks.push(true);
  bricksLeft=COLS*ROWS;
}

// Place ball resting on the paddle, ready to launch
function resetBall(){
  ballOnPaddle=true;
  launchTimer=0;
  ballX=paddleX+PADDLE_W/2-BALL_SIZE/2;
  ballY=PADDLE_Y-BALL_SIZE-1;
  ballVX=0;
  ballVY=0;
}

// Launch the ball upward with a slight horizontal angle
function launchBall(){
  ballOnPaddle=false;
  // random-ish horizontal direction, mostly upward
  var dir=(Math.random()<0.5)?-1:1;
  var spd=baseSpeed;
  ballVX=dir*spd*0.55;
  ballVY=-spd;
}

// Full new game
function reset(){
  score=0;
  lives=3;
  level=1;
  baseSpeed=3.2;
  gameOver=false;
  paddleX=SCRW/2-PADDLE_W/2;
  buildBricks();
  resetBall();
  flash=0;
}

// Advance to next level: rebuild bricks, speed up slightly
function nextLevel(){
  level++;
  baseSpeed+=0.4;
  if(baseSpeed>6.5) baseSpeed=6.5; // cap so it stays playable
  buildBricks();
  paddleX=SCRW/2-PADDLE_W/2;
  resetBall();
}

// Geometry helper: bounding box of brick at column c, row rIdx
function brickRect(c, rIdx){
  var x=GRID_LEFT + c*(BRICK_W+GAP);
  var y=GRID_TOP + rIdx*(BRICK_H+GAP);
  return {x:x, y:y, w:BRICK_W, h:BRICK_H};
}

// Initialize before frame() is defined
reset();

// ---- Per-frame update + render ----
function frame(buttons){
  // guard against undefined input
  if(typeof buttons!=='number') buttons=0;
  blink++;
  if(flash>0) flash--;

  if(gameOver){
    // Wait for START to restart
    if((buttons&START) && !(prevButtons&START)){
      reset();
    }
    renderGameOver();
    prevButtons=buttons;
    return;
  }

  // ---- Paddle movement ----
  if(buttons&LEFT)  paddleX-=PADDLE_SPEED;
  if(buttons&RIGHT) paddleX+=PADDLE_SPEED;
  if(paddleX<0) paddleX=0;
  if(paddleX>SCRW-PADDLE_W) paddleX=SCRW-PADDLE_W;

  // ---- Ball on paddle (pre-launch) ----
  if(ballOnPaddle){
    ballX=paddleX+PADDLE_W/2-BALL_SIZE/2;
    ballY=PADDLE_Y-BALL_SIZE-1;
    launchTimer++;
    var launchPressed=(buttons&CROSS) && !(prevButtons&CROSS);
    if(launchPressed || launchTimer>=90){
      launchBall();
    }
  } else {
    // ---- Ball physics ----
    ballX+=ballVX;
    ballY+=ballVY;

    // Left / right walls
    if(ballX<0){ ballX=0; ballVX=-ballVX; }
    if(ballX>SCRW-BALL_SIZE){ ballX=SCRW-BALL_SIZE; ballVX=-ballVX; }
    // Top wall
    if(ballY<0){ ballY=0; ballVY=-ballVY; }

    // ---- Paddle collision ----
    if(ballVY>0 &&
       ballY+BALL_SIZE>=PADDLE_Y &&
       ballY+BALL_SIZE<=PADDLE_Y+PADDLE_H+Math.abs(ballVY) &&
       ballX+BALL_SIZE>=paddleX &&
       ballX<=paddleX+PADDLE_W){
      // Deflect: angle depends on hit position relative to paddle center
      var hit=((ballX+BALL_SIZE/2)-(paddleX+PADDLE_W/2))/(PADDLE_W/2); // -1..1
      if(hit<-1) hit=-1; if(hit>1) hit=1;
      var spd=baseSpeed;
      var maxAngle=1.0; // controls steepness
      ballVX=spd*hit*maxAngle;
      // Ensure a minimum vertical component so ball always goes up reasonably
      var vy2=spd*spd-ballVX*ballVX;
      if(vy2<1) vy2=1;
      ballVY=-Math.sqrt(vy2);
      ballY=PADDLE_Y-BALL_SIZE-1; // place above paddle to avoid sticking
    }

    // ---- Brick collision (at most one solid hit per frame) ----
    handleBrickCollision();

    // ---- Ball lost ----
    if(ballY>SCRH){
      lives--;
      flash=8;
      if(lives<=0){
        gameOver=true;
      } else {
        resetBall();
      }
    }
  }

  // ---- Level cleared ----
  if(bricksLeft<=0){
    nextLevel();
  }

  render();
  prevButtons=buttons;
}

// Detect and resolve collision with a single brick this frame.
function handleBrickCollision(){
  var bx=ballX, by=ballY, bw=BALL_SIZE, bh=BALL_SIZE;
  for(var rIdx=0;rIdx<ROWS;rIdx++){
    for(var c=0;c<COLS;c++){
      var idx=rIdx*COLS+c;
      if(!bricks[idx]) continue;
      var r=brickRect(c,rIdx);
      // AABB overlap test
      if(bx+bw>r.x && bx<r.x+r.w && by+bh>r.y && by<r.y+r.h){
        // Determine reflection axis by smallest overlap (penetration)
        var overlapLeft   = (bx+bw)-r.x;     // how far ball entered from left
        var overlapRight  = (r.x+r.w)-bx;    // from right
        var overlapTop    = (by+bh)-r.y;     // from top
        var overlapBottom = (r.y+r.h)-by;    // from bottom
        var minX=Math.min(overlapLeft,overlapRight);
        var minY=Math.min(overlapTop,overlapBottom);
        if(minX<minY){
          ballVX=-ballVX; // hit a vertical side
        } else {
          ballVY=-ballVY; // hit top/bottom
        }
        // Remove brick & score
        bricks[idx]=false;
        bricksLeft--;
        score+=ROW_POINTS[rIdx]||10;
        return; // only one brick per frame
      }
    }
  }
}

// ---- Rendering ----
function render(){
  // Background (slight flash when life lost)
  if(flash>0){ gfx.clear(60,20,20); }
  else { gfx.clear(12,12,24); }

  // Bricks
  for(var rIdx=0;rIdx<ROWS;rIdx++){
    var col=ROW_COLORS[rIdx];
    for(var c=0;c<COLS;c++){
      if(!bricks[rIdx*COLS+c]) continue;
      var r=brickRect(c,rIdx);
      gfx.fillRect(Math.floor(r.x),Math.floor(r.y),r.w,r.h,col[0],col[1],col[2]);
    }
  }

  // Paddle
  gfx.fillRect(Math.floor(paddleX),PADDLE_Y,PADDLE_W,PADDLE_H,230,230,240);

  // Ball
  gfx.fillRect(Math.floor(ballX),Math.floor(ballY),BALL_SIZE,BALL_SIZE,255,240,120);

  // ---- HUD ----
  // Score (top-left)
  drawText(String(score), 8, 6, 3, 255,255,255);

  // Level (top-center), shown as a number
  var lvlStr=String(level);
  drawText(lvlStr, SCRW/2 - (lvlStr.length*4*2)/2, 8, 2, 180,200,255);

  // Lives as small squares (top-right)
  for(var i=0;i<lives;i++){
    gfx.fillRect(SCRW-12-i*12, 8, 8, 8, 120,230,120);
  }

  // Launch prompt: blinking ball area hint while resting on paddle
  if(ballOnPaddle){
    if((blink>>4)&1){ // blink ~ every 16 frames
      gfx.fillRect(Math.floor(ballX)-2,Math.floor(ballY)-2,BALL_SIZE+4,BALL_SIZE+4,255,255,255);
      gfx.fillRect(Math.floor(ballX),Math.floor(ballY),BALL_SIZE,BALL_SIZE,255,240,120);
    }
  }
}

function renderGameOver(){
  // Dark red tint background
  gfx.clear(40,8,8);

  // Show final score in the center
  var s=4;
  var str=String(score);
  var w=str.length*4*s;
  drawText(str, SCRW/2-w/2, 90, s, 255,220,220);

  // Show level reached below (smaller)
  var ls=String(level);
  var lw=ls.length*4*2;
  drawText(ls, SCRW/2-lw/2, 140, 2, 200,160,160);

  // Blinking "press START" prompt: a blinking rectangle bar near the bottom
  if((blink>>4)&1){
    gfx.fillRect(SCRW/2-60, 180, 120, 12, 230,230,80);
  }
}

globalThis.frame = frame;
