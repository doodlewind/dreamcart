// psp-js Web engine — an isomorphic Canvas implementation of the same tiny
// runtime the PSP and 3DS builds provide. A game is a .js file that uses only:
//   gfx.clear(r,g,b), gfx.fillRect(x,y,w,h,r,g,b), log(msg)
//   globalThis.frame = function(buttons){ ... }   // called ~60x/second
// The button bitmask MUST match every platform (see BTN below), so the exact
// same game source runs unchanged on Web, PSP, and 3DS.
(function () {
  'use strict';

  var W = 480, H = 272;          // logical screen, identical to PSP

  // Button bits — identical to psp::sys::CtrlButtons used by the games.
  var BTN = {
    SELECT: 0x01, START: 0x08,
    UP: 0x10, RIGHT: 0x20, DOWN: 0x40, LEFT: 0x80,
    TRIANGLE: 0x1000, CIRCLE: 0x2000, CROSS: 0x4000, SQUARE: 0x8000,
  };

  // Keyboard -> button. Arrows/WASD = d-pad; Z/X/A/S = face; Enter = START.
  var KEYMAP = {
    ArrowUp: BTN.UP, ArrowRight: BTN.RIGHT, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT,
    KeyW: BTN.UP, KeyD: BTN.RIGHT, KeyS: BTN.DOWN, KeyA: BTN.LEFT,
    KeyZ: BTN.CROSS, KeyX: BTN.CIRCLE, KeyC: BTN.SQUARE, KeyV: BTN.TRIANGLE,
    Enter: BTN.START, Space: BTN.CROSS, ShiftRight: BTN.SELECT,
  };

  var canvas = null, ctx = null;
  var held = 0;                  // current held button bitmask
  var rafId = 0, runningGame = null, paused = false;
  var acc = 0, last = 0;
  var frameCb = null;            // the game's frame(buttons)
  var logSink = function () {};
  var fpsSink = function () {};
  var statsFrames = 0, statsT = 0;

  function rgb(r, g, b) {
    return 'rgb(' + (r & 255) + ',' + (g & 255) + ',' + (b & 255) + ')';
  }

  // The native API exposed to the game (mirrors the Rust/C bridges).
  var gfx = {
    clear: function (r, g, b) { ctx.fillStyle = rgb(r, g, b); ctx.fillRect(0, 0, W, H); },
    fillRect: function (x, y, w, h, r, g, b) {
      ctx.fillStyle = rgb(r, g, b);
      ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
    },
  };

  function installGlobals() {
    window.gfx = gfx;
    window.log = function (msg) { logSink(String(msg)); };
    // games read globalThis.frame; clear any previous one before (re)loading.
    try { delete window.frame; } catch (e) { window.frame = undefined; }
  }

  // Load (or reload) a game from source. Returns null on success, else an error.
  function load(src) {
    stop();
    installGlobals();
    // Run the game body in a fresh function scope so its top-level vars don't
    // leak or collide on reload; the game assigns globalThis.frame itself.
    try {
      // eslint-disable-next-line no-new-func
      var run = new Function(src + '\n//# sourceURL=game.js');
      run();
    } catch (e) {
      logSink('LOAD ERROR: ' + (e && e.stack ? e.stack : e));
      return e;
    }
    if (typeof window.frame !== 'function') {
      var err = new Error('game did not define globalThis.frame');
      logSink('ERROR: ' + err.message);
      return err;
    }
    frameCb = window.frame;
    runningGame = src;
    // Draw one frame immediately so the canvas isn't blank before start().
    safeFrame();
    return null;
  }

  function safeFrame() {
    if (!frameCb) return;
    try { frameCb(held); }
    catch (e) { logSink('FRAME ERROR: ' + (e && e.stack ? e.stack : e)); }
  }

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    if (paused) { last = now; return; }
    var dt = now - last; last = now;
    if (dt > 250) dt = 250;       // avoid spiral after tab was hidden
    acc += dt;
    var STEP = 1000 / 60, steps = 0;
    while (acc >= STEP && steps < 4) { safeFrame(); acc -= STEP; steps++; statsFrames++; }
    // fps once per second
    statsT += dt;
    if (statsT >= 1000) { fpsSink(Math.round(statsFrames * 1000 / statsT)); statsFrames = 0; statsT = 0; }
  }

  function start() {
    if (rafId) return;
    paused = false; last = performance.now(); acc = 0;
    rafId = requestAnimationFrame(tick);
  }
  function stop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    paused = false;
  }
  function setPaused(p) { paused = !!p; if (paused) fpsSink(0); }
  function step() { paused = true; safeFrame(); }   // single-frame advance

  // ---- input ----
  function onKey(down) {
    return function (e) {
      var bit = KEYMAP[e.code];
      if (bit === undefined) return;
      e.preventDefault();
      if (down) held |= bit; else held &= ~bit;
    };
  }
  function pressVirtual(bit, down) { if (down) held |= bit; else held &= ~bit; }

  function mount(theCanvas) {
    canvas = theCanvas;
    canvas.width = W; canvas.height = H;
    ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    window.addEventListener('keydown', onKey(true));
    window.addEventListener('keyup', onKey(false));
    // lose focus -> release all buttons
    window.addEventListener('blur', function () { held = 0; });
    gfx.clear(0, 0, 0);
  }

  window.PSPJS = {
    W: W, H: H, BTN: BTN,
    mount: mount, load: load, start: start, stop: stop,
    setPaused: setPaused, step: step,
    pressVirtual: pressVirtual,
    getButtons: function () { return held; },
    onLog: function (cb) { logSink = cb; },
    onFps: function (cb) { fpsSink = cb; },
    isPaused: function () { return paused; },
  };
})();
