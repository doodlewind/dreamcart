// ============================================================================
// PONG  (pong.js)  -- for Sony PSP via QuickJS
// Controls: UP / DOWN = move left paddle. START = (only used implicitly; play
//           is endless and auto-serves). Right paddle is a capped-speed AI.
// ----------------------------------------------------------------------------
// Build everything from filled rectangles. 480x272 screen, ~60fps.
// ============================================================================

// ---- Pixel font helper (verbatim) -----------------------------------------
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
// draws a string left-to-right; each char cell is 4*s wide, 5*s tall.
function drawText(str, x, y, s, r, g, b){
  str = String(str);
  for(var i=0;i<str.length;i++){ drawGlyph(str[i], Math.floor(x + i*4*s), Math.floor(y), s, r,g,b); }
  return x + str.length*4*s;
}

// ---- Button masks ----------------------------------------------------------
var UP=0x10, DOWN=0x40; // only these are needed for Pong

// ---- Screen / playfield constants ------------------------------------------
var SCREEN_W = 480, SCREEN_H = 272;

// Paddle geometry
var PADDLE_W = 8;
var PADDLE_H = 48;
var PADDLE_MARGIN = 16;            // distance of paddle face area from edge
var LEFT_X = PADDLE_MARGIN;        // left paddle x (left edge of paddle)
var RIGHT_X = SCREEN_W - PADDLE_MARGIN - PADDLE_W; // right paddle x

// Ball geometry
var BALL_SIZE = 8;

// Speeds
var PLAYER_SPEED = 5;              // px per frame for player's paddle
var AI_MAX_SPEED = 3.4;            // capped so the AI is beatable
var BALL_START_SPEED = 3.2;        // initial horizontal-ish speed
var BALL_SPEED_INC = 0.25;         // added to speed magnitude per paddle hit
var BALL_MAX_SPEED = 7.0;          // cap on ball speed magnitude
var MAX_BOUNCE_VY = 4.5;           // max vertical velocity from a paddle deflection
var SERVE_COUNTDOWN = 40;          // frames to wait after a point before serving

// ---- Game state (top-level) ------------------------------------------------
var leftPaddleY, rightPaddleY;     // top-y of each paddle
var ballX, ballY;                  // top-left of ball
var ballVX, ballVY;                // ball velocity
var ballSpeed;                     // current speed magnitude
var playerScore, aiScore;
var serveCountdown;                // >0 means ball is parked at center waiting
var serveDir;                      // +1 serve toward AI (right), -1 toward player (left)
var prevButtons = 0;

// Clamp helper
function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

// Place the ball at center and set up a countdown, serving toward `dir`.
// dir = -1 means the ball will move LEFT (toward player) -- used after AI was scored on.
// dir = +1 means the ball will move RIGHT (toward AI).
function serveBall(dir){
  ballX = Math.floor(SCREEN_W/2 - BALL_SIZE/2);
  ballY = Math.floor(SCREEN_H/2 - BALL_SIZE/2);
  ballSpeed = BALL_START_SPEED;
  serveDir = dir;
  serveCountdown = SERVE_COUNTDOWN;
  // velocity is set when countdown ends, but seed a small vy direction now
  ballVX = 0;
  ballVY = 0;
}

function reset(){
  leftPaddleY  = Math.floor(SCREEN_H/2 - PADDLE_H/2);
  rightPaddleY = Math.floor(SCREEN_H/2 - PADDLE_H/2);
  playerScore = 0;
  aiScore = 0;
  // First serve toward the AI (arbitrary). Use +1.
  serveBall(1);
}

// Initialize once before frame() is defined.
reset();
log("PONG ready: UP/DOWN to move left paddle");

// Begin actual ball motion after countdown finishes.
function launchBall(){
  // Horizontal velocity in the serve direction.
  ballVX = serveDir * ballSpeed;
  // Random-ish small vertical component so serves vary.
  var vy = (Math.random() * 2 - 1) * 2.0; // -2..2
  ballVY = vy;
  // Normalize so the magnitude equals ballSpeed.
  var mag = Math.sqrt(ballVX*ballVX + ballVY*ballVY);
  if(mag < 0.0001) mag = 0.0001;
  ballVX = (ballVX / mag) * ballSpeed;
  ballVY = (ballVY / mag) * ballSpeed;
}

// Handle a paddle hit: reflect horizontally, set vy from hit position, speed up.
// paddleY is the top of the paddle that was hit; newVXsign is +1 (now moving right)
// or -1 (now moving left).
function paddleBounce(paddleY, newVXsign){
  // Where did the ball center hit the paddle? -1 (top) .. +1 (bottom)
  var ballCenter = ballY + BALL_SIZE/2;
  var paddleCenter = paddleY + PADDLE_H/2;
  var rel = (ballCenter - paddleCenter) / (PADDLE_H/2); // -1..1
  rel = clamp(rel, -1, 1);

  // Speed up, capped.
  ballSpeed = Math.min(ballSpeed + BALL_SPEED_INC, BALL_MAX_SPEED);

  // Vertical velocity from hit position.
  var vy = rel * MAX_BOUNCE_VY;
  // Horizontal velocity gets whatever is left to keep magnitude == ballSpeed.
  var vx2 = ballSpeed*ballSpeed - vy*vy;
  var vx = vx2 > 0 ? Math.sqrt(vx2) : 0.5; // guard against negative under sqrt
  ballVX = newVXsign * vx;
  ballVY = vy;
}

// AABB overlap test between ball and a paddle rectangle.
function overlapPaddle(px, py){
  return (ballX < px + PADDLE_W) &&
         (ballX + BALL_SIZE > px) &&
         (ballY < py + PADDLE_H) &&
         (ballY + BALL_SIZE > py);
}

// ---- Main frame ------------------------------------------------------------
function frame(buttons){
  // ----- UPDATE -----------------------------------------------------------

  // Player paddle movement.
  if(buttons & UP)   leftPaddleY -= PLAYER_SPEED;
  if(buttons & DOWN) leftPaddleY += PLAYER_SPEED;
  leftPaddleY = clamp(leftPaddleY, 0, SCREEN_H - PADDLE_H);

  // AI paddle: track ball's vertical center with capped speed.
  var aiCenter = rightPaddleY + PADDLE_H/2;
  var ballCenterY = ballY + BALL_SIZE/2;
  var diff = ballCenterY - aiCenter;
  // Small dead-zone to avoid jitter.
  if(diff > 2)      rightPaddleY += Math.min(AI_MAX_SPEED, diff);
  else if(diff < -2) rightPaddleY -= Math.min(AI_MAX_SPEED, -diff);
  rightPaddleY = clamp(rightPaddleY, 0, SCREEN_H - PADDLE_H);

  // Ball: either counting down to a serve, or in flight.
  if(serveCountdown > 0){
    serveCountdown--;
    if(serveCountdown === 0){
      launchBall();
    }
    // While counting down, keep ball parked at center (already set in serveBall).
  } else {
    // Move ball.
    ballX += ballVX;
    ballY += ballVY;

    // Top / bottom wall bounce.
    if(ballY < 0){
      ballY = 0;
      ballVY = Math.abs(ballVY);
    } else if(ballY + BALL_SIZE > SCREEN_H){
      ballY = SCREEN_H - BALL_SIZE;
      ballVY = -Math.abs(ballVY);
    }

    // Left paddle collision (only when moving left).
    if(ballVX < 0 && overlapPaddle(LEFT_X, leftPaddleY)){
      // Push ball out to the right face of the paddle.
      ballX = LEFT_X + PADDLE_W;
      paddleBounce(leftPaddleY, 1); // now moving right
    }
    // Right paddle collision (only when moving right).
    else if(ballVX > 0 && overlapPaddle(RIGHT_X, rightPaddleY)){
      ballX = RIGHT_X - BALL_SIZE;
      paddleBounce(rightPaddleY, -1); // now moving left
    }

    // Scoring.
    if(ballX + BALL_SIZE < 0){
      // Ball passed the LEFT edge -> AI scores. Serve toward the player (loser).
      aiScore++;
      serveBall(-1);
    } else if(ballX > SCREEN_W){
      // Ball passed the RIGHT edge -> player scores. Serve toward the AI (loser).
      playerScore++;
      serveBall(1);
    }
  }

  // ----- DRAW -------------------------------------------------------------

  // Dark background.
  gfx.clear(12, 14, 22);

  // Dashed vertical center line: a column of small rects.
  var cx = Math.floor(SCREEN_W/2 - 2);
  for(var dy = 4; dy < SCREEN_H; dy += 16){
    gfx.fillRect(cx, dy, 4, 8, 60, 70, 90);
  }

  // Left paddle (player) - cyan-ish.
  gfx.fillRect(Math.floor(LEFT_X), Math.floor(leftPaddleY), PADDLE_W, PADDLE_H, 80, 220, 230);
  // Right paddle (AI) - orange-ish.
  gfx.fillRect(Math.floor(RIGHT_X), Math.floor(rightPaddleY), PADDLE_W, PADDLE_H, 240, 160, 70);

  // Ball - white (blink while waiting to serve so the state is obvious).
  var showBall = true;
  if(serveCountdown > 0){
    // Blink: visible roughly half the time.
    showBall = (Math.floor(serveCountdown / 6) % 2) === 0;
  }
  if(showBall){
    gfx.fillRect(Math.floor(ballX), Math.floor(ballY), BALL_SIZE, BALL_SIZE, 245, 245, 245);
  }

  // Scores at the top. Player on left half, AI on right half.
  var scoreScale = 4; // each digit cell ~ 4*4=16 wide, 5*4=20 tall
  // Player score: centered in the left quarter-ish.
  drawText(String(playerScore), SCREEN_W/2 - 80, 18, scoreScale, 80, 220, 230);
  // AI score: in the right quarter-ish. Shift left a bit per extra digit.
  var aiStr = String(aiScore);
  var aiWidth = aiStr.length * 4 * scoreScale;
  drawText(aiStr, SCREEN_W/2 + 80 - aiWidth + (4*scoreScale), 18, scoreScale, 240, 160, 70);

  // Update edge-detect buffer (not strictly needed here, kept for robustness).
  prevButtons = buttons;
}

globalThis.frame = frame;
