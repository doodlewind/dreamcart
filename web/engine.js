// DreamCart Web engine — an isomorphic Canvas implementation of the same tiny
// runtime the PSP and 3DS builds provide. A game is a .js file that uses only:
//   gfx.clear(r,g,b), gfx.fillRect(x,y,w,h,r,g,b), log(msg)
//   globalThis.frame = function(buttons){ ... }   // called ~60x/second
// The button bitmask MUST match every platform (see BTN below), so the exact
// same game source runs unchanged on Web, PSP, and 3DS.
(function () {
  'use strict';

  var W = 480, H = 272;          // logical screen, identical to PSP

  // Button bits — canonical source is framework/src/input.ts (Btn); this plain
  // script can't import it, so the copy is enforced by framework/test/contract.ts.
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
  var glCanvas = null, gl = null; // optional WebGL2 layer for the 3D `g3d` pass
  var used3dThisFrame = false;    // did g3d.submit run during the current logic frame?
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
    clear: function (r, g, b) {
      // In a 3D frame the WebGL layer underneath owns the background, so the
      // Canvas2D HUD must be TRANSPARENT where nothing is drawn — otherwise an
      // opaque fill would hide the 3D scene (docs/3d-design.md §10.1 R10).
      // 2D-only frames (no g3d.submit this frame) keep today's exact opaque fill.
      if (used3dThisFrame) { ctx.clearRect(0, 0, W, H); return; }
      ctx.fillStyle = rgb(r, g, b); ctx.fillRect(0, 0, W, H);
    },
    fillRect: function (x, y, w, h, r, g, b) {
      ctx.fillStyle = rgb(r, g, b);
      ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
    },
  };

  // ===========================================================================
  // 3D layer (`g3d`) — a WebGL2 implementation of the same retained-mesh + one
  // batched `submit`-per-frame contract the PSP and 3DS hosts provide. The wire
  // format is framework/src/g3d.ts; the visual target is framework/test/raster3d.ts.
  // This whole block is optional: if WebGL2 isn't available, window.g3d is left
  // undefined and the framework skips the 3D pass entirely (capability probe).
  // ===========================================================================

  // Wire constants — MUST stay byte-identical to framework/src/g3d.ts. Declared
  // one-per-line `var NAME = 0x..;` so framework/test/contract.ts can grep+assert
  // parity (its regex forbids digits/newlines between the name and the hex value).
  var DC3D_MAGIC = 0x44433344;   // 'DC3D' little-endian
  var DC3D_VERSION = 0x0001;
  var OP_SET_CAMERA = 0x0001;
  var OP_DRAW = 0x0002;
  var OP_IMM_TRIS = 0x0003;
  var FMT_POS = 0x0001;          // 3 x f32
  var FMT_COLOR = 0x0002;        // u32 ABGR
  var FMT_NORMAL = 0x0004;       // 3 x f32 (reserved)
  var FMT_UV = 0x0008;           // 2 x f32 (reserved)

  // v1 vertex layout (FMT_POS|FMT_COLOR): 16 bytes/vertex, interleaved, matching
  // the bytes the encoder emits — [u32 ABGR @0][3 x f32 pos @4].
  var V1_STRIDE = 16;

  // GLSL ES 3.00. u_viewProj is the shared math.ts proj*view (standard Y-up NDC;
  // NO baked Y-flip — WebGL clip space is already Y-up), so the shader is a plain
  // MVP. a_color is ABGR bytes the GPU normalizes via the vertexAttribPointer flag.
  var VERT_SRC =
    '#version 300 es\n' +
    'layout(location=0) in vec3 a_pos;\n' +
    'layout(location=1) in vec4 a_color;\n' + // unsigned-byte normalized, ABGR order
    'uniform mat4 u_viewProj;\n' +
    'uniform mat4 u_model;\n' +
    'out vec4 v_color;\n' +
    'void main() {\n' +
    '  v_color = a_color;\n' +
    '  gl_Position = u_viewProj * u_model * vec4(a_pos, 1.0);\n' +
    '}\n';
  var FRAG_SRC =
    '#version 300 es\n' +
    'precision highp float;\n' +
    'in vec4 v_color;\n' +
    'uniform vec4 u_tint;\n' +
    'out vec4 outColor;\n' +
    'void main() {\n' +
    '  outColor = v_color * u_tint;\n' +
    '}\n';

  var glProgram = null;
  var uViewProj = null, uModel = null, uTint = null;
  var meshes = [];               // handle -> { vao, ibo, indexCount, vertexCount } (or null when freed)
  var reversedZ = false;         // true once EXT_clip_control gives a real [0,1] range
  var immVao = null, immVbo = null; // dynamic geometry (IMM_TRIS) scratch
  var camMat = new Float32Array(16); // current u_viewProj (last SET_CAMERA)

  function compileShader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      logSink('g3d shader error: ' + gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  // Build the GL program + global state once, after a WebGL2 context is acquired.
  function initGL() {
    var vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
    var fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) { gl = null; return; }
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.bindAttribLocation(p, 1, 'a_color');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      logSink('g3d link error: ' + gl.getProgramInfoLog(p));
      gl = null; return;
    }
    glProgram = p;
    uViewProj = gl.getUniformLocation(p, 'u_viewProj');
    uModel = gl.getUniformLocation(p, 'u_model');
    uTint = gl.getUniformLocation(p, 'u_tint');

    // Reversed-Z: the shared projection defaults to a [0,1] near->1/far->0 clip
    // range. Plain WebGL2 only clips z to [-1,1], so prefer EXT_clip_control to
    // get a true [0,1] range matching PSP/3DS; clear depth to 0 + GREATER test.
    // Without the extension, fall back to standard-Z (clear 1, LESS) — Web depth
    // is then threshold-compared, not byte-matched (docs §10.1 C1).
    var ext = gl.getExtension('EXT_clip_control');
    if (ext) {
      ext.clipControlEXT(ext.LOWER_LEFT_EXT, ext.ZERO_TO_ONE_EXT);
      reversedZ = true;
    }
    gl.enable(gl.DEPTH_TEST);
    // No back-face culling — match raster3d.ts (depth resolves occlusion).
    gl.disable(gl.CULL_FACE);

    // Dynamic-geometry (IMM_TRIS) scratch: one reused DYNAMIC_DRAW VBO+VAO.
    immVbo = gl.createBuffer();
    immVao = gl.createVertexArray();
    gl.bindVertexArray(immVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, immVbo);
    setupV1Attribs();
    gl.bindVertexArray(null);
  }

  // Configure the v1 (POS|COLOR) attribute layout on the currently-bound VBO/VAO.
  function setupV1Attribs() {
    gl.enableVertexAttribArray(0);
    // a_pos: 3 x f32 at byte offset 4, stride 16.
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, V1_STRIDE, 4);
    gl.enableVertexAttribArray(1);
    // a_color: 4 unsigned bytes normalized at byte offset 0 (ABGR), stride 16.
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, V1_STRIDE, 0);
  }

  var g3d = {
    // Upload a mesh ONCE; the host COPIES the bytes into a VBO(+IBO) and returns
    // a small int handle. v1 format is POS|COLOR (16-byte stride).
    uploadMesh: function (vertices, indices, format) {
      var vbo = gl.createBuffer();
      var vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW); // copies the bytes
      setupV1Attribs();
      var vertexCount = vertices.byteLength / V1_STRIDE | 0;
      var ibo = null, indexCount = 0;
      if (indices) {
        ibo = gl.createBuffer();
        // The IBO binding is captured in the VAO's element-array state.
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
        indexCount = indices.byteLength / 2 | 0; // Uint16 indices
      }
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      meshes.push({ vao: vao, vbo: vbo, ibo: ibo, indexCount: indexCount, vertexCount: vertexCount });
      return meshes.length - 1;
    },

    // Release native storage (optional; many games never call it).
    freeMesh: function (handle) {
      var m = meshes[handle];
      if (!m) return;
      gl.deleteVertexArray(m.vao);
      gl.deleteBuffer(m.vbo);
      if (m.ibo) gl.deleteBuffer(m.ibo);
      meshes[handle] = null;
    },

    // THE per-frame call: parse the one little-endian command buffer, run the 3D
    // pass (clear color+depth, replay records), then leave depth DISABLED so the
    // Canvas2D HUD draws on top. Called once per logic frame by the framework.
    submit: function (buffer, byteLength) {
      var dv = new DataView(buffer, 0, byteLength);
      if (dv.getUint32(0, true) !== DC3D_MAGIC) return; // ignore foreign/garbage
      var recordCount = dv.getUint16(6, true);

      used3dThisFrame = true;
      // Clear the Canvas2D HUD layer to TRANSPARENT so the WebGL cube underneath
      // shows through. submit() runs before the frame's gfx HUD draws, so the HUD
      // text lands on a fresh transparent layer. (Without this, the opaque black
      // fill from mount()'s initial gfx.clear hides the 3D layer — 3D games like
      // cube3d never call gfx.clear themselves.)
      if (ctx) ctx.clearRect(0, 0, W, H);
      gl.useProgram(glProgram);
      gl.viewport(0, 0, W, H);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      // Reversed-Z [0,1]: clear depth to 0, keep nearer (GREATER). Standard-Z
      // fallback: clear to 1, keep nearer (LESS). Background matches raster3d.ts.
      gl.clearColor(0x10 / 255, 0x14 / 255, 0x1e / 255, 1.0);
      gl.clearDepth(reversedZ ? 0.0 : 1.0);
      gl.depthFunc(reversedZ ? gl.GREATER : gl.LESS);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // SET_CAMERA defaults to identity until the first one is seen this frame.
      identity16(camMat);
      gl.uniformMatrix4fv(uViewProj, false, camMat);

      var o = 8;
      for (var r = 0; r < recordCount; r++) {
        var op = dv.getUint16(o, true);
        var words = dv.getUint16(o + 2, true);
        var base = o + 4;
        o = base + words * 4;
        if (op === OP_SET_CAMERA) {
          // 16 f32 column-major view*proj, loaded verbatim (no transpose).
          var vp = new Float32Array(buffer, base, 16);
          camMat.set(vp);
          gl.uniformMatrix4fv(uViewProj, false, camMat);
        } else if (op === OP_DRAW) {
          var handle = dv.getUint32(base, true);
          var tint = dv.getUint32(base + 4, true) >>> 0;
          var model = new Float32Array(buffer, base + 8, 16);
          gl.uniformMatrix4fv(uModel, false, model);
          setTint(tint);
          drawMesh(meshes[handle]);
        } else if (op === OP_IMM_TRIS) {
          drawImm(dv, buffer, base, words);
        }
      }

      // HUD pass draws next with depth OFF (gfx.fillRect on the Canvas2D layer).
      gl.disable(gl.DEPTH_TEST);
    },
  };

  // 0xFFFFFFFF -> no tint (1,1,1,1); otherwise unpack ABGR to a normalized vec4.
  function setTint(abgr) {
    if (abgr === 0xffffffff) { gl.uniform4f(uTint, 1, 1, 1, 1); return; }
    var rr = (abgr & 255) / 255;
    var gg = ((abgr >>> 8) & 255) / 255;
    var bb = ((abgr >>> 16) & 255) / 255;
    var aa = ((abgr >>> 24) & 255) / 255;
    gl.uniform4f(uTint, rr, gg, bb, aa);
  }

  function drawMesh(m) {
    if (!m) return;
    gl.bindVertexArray(m.vao);
    if (m.ibo) gl.drawElements(gl.TRIANGLES, m.indexCount, gl.UNSIGNED_SHORT, 0);
    else gl.drawArrays(gl.TRIANGLES, 0, m.vertexCount);
    gl.bindVertexArray(null);
  }

  // OP_IMM_TRIS: inline dynamic geometry. payload = u32 vertexCount, u32 format,
  // then 4-byte-padded interleaved vertex bytes. v1 supports POS|COLOR only.
  function drawImm(dv, buffer, base, words) {
    var vertexCount = dv.getUint32(base, true);
    var format = dv.getUint32(base + 4, true);
    if ((format & FMT_POS) === 0 || (format & FMT_COLOR) === 0) return; // unsupported -> safe skip
    var byteLength = words * 4 - 8; // payloadWords includes the 2 header words
    if (byteLength <= 0 || vertexCount === 0) return;
    var verts = new Uint8Array(buffer, base + 8, byteLength);
    gl.bindVertexArray(immVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, immVbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.uniformMatrix4fv(uModel, false, IDENTITY16); // IMM verts are world-space
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    gl.bindVertexArray(null);
  }

  var IDENTITY16 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  function identity16(m) {
    m[0] = 1; m[1] = 0; m[2] = 0; m[3] = 0;
    m[4] = 0; m[5] = 1; m[6] = 0; m[7] = 0;
    m[8] = 0; m[9] = 0; m[10] = 1; m[11] = 0;
    m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
  }

  function installGlobals() {
    window.gfx = gfx;
    // Only expose g3d when a WebGL2 context was acquired in mount(); otherwise
    // leave it undefined so the framework skips the 3D pass (capability probe).
    if (gl) window.g3d = g3d; else { try { delete window.g3d; } catch (e) { window.g3d = undefined; } }
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
    // Reset the 3D flag BEFORE the game frame: a 3D game's g3d.submit sets it
    // true (so the HUD gfx.clear goes transparent); a 2D-only frame leaves it
    // false (so gfx.clear keeps its opaque fill, byte-identical to today).
    used3dThisFrame = false;
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

  // Build a WebGL2 canvas stacked UNDER the Canvas2D HUD canvas, same 480x272
  // backing store and same CSS box, so the GL 3D layer shows through wherever the
  // HUD is transparent (docs/3d-design.md §4.3 + §10.1 R2). The public
  // PSPJS.mount(el) signature is unchanged: the GL canvas is created here, the
  // caller still only knows about the HUD canvas it passed in.
  function mountGLLayer(hud) {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    // Stack: GL canvas underneath (kept in normal flow), the HUD canvas absolutely
    // overlaid on top. The two are kept the same size+position by syncStack()
    // below — robust to however the host page sizes the HUD (a CSS rule on the web
    // playground, an inline letterbox style in the Android WebView).
    var parent = hud.parentNode;
    if (!parent) return; // detached HUD canvas — can't stack a sibling
    // Try to acquire WebGL2 BEFORE touching the DOM layout, so a missing context
    // leaves the existing 2D-only page byte-identical to today.
    try {
      gl = c.getContext('webgl2', { antialias: false, depth: true, alpha: false });
    } catch (e) { gl = null; }
    if (!gl) return; // no WebGL2 -> leave g3d undefined; framework skips 3D

    var pcs = window.getComputedStyle(parent);
    if (pcs.position === 'static') parent.style.position = 'relative';
    parent.insertBefore(c, hud); // GL canvas takes the HUD's place in flow
    hud.style.position = 'absolute';
    // The HUD must be transparent so the GL layer shows through in 3D frames; the
    // GL layer owns the (cleared) background. The GL canvas inherits the existing
    // stylesheet's #000 background, so 2D-only frames look identical to today.
    hud.style.background = 'transparent';
    glCanvas = c;

    // Keep the two layers registered. The web playground sizes the canvas via a
    // CSS rule (no inline style) — both canvases inherit it, so we leave the GL
    // canvas alone. The Android WebView (and any host) instead sizes the HUD with
    // an inline style.width/height (its fit() letterboxes the fixed 480x272 to the
    // physical display); we MIRROR that inline size onto the GL canvas, then pin
    // the HUD over it. A ResizeObserver re-runs this whenever the HUD box changes.
    function syncStack() {
      if (hud.style.width) c.style.width = hud.style.width;
      if (hud.style.height) c.style.height = hud.style.height;
      hud.style.left = c.offsetLeft + 'px';
      hud.style.top = c.offsetTop + 'px';
    }
    syncStack();
    if (window.ResizeObserver) {
      try { new ResizeObserver(syncStack).observe(hud); } catch (e) {}
    }
    window.addEventListener('resize', syncStack);

    initGL();
    if (!gl && glCanvas) { // initGL failed (shader/link) — tear the layer back down
      parent.removeChild(c);
      hud.style.position = '';
      hud.style.left = '';
      hud.style.top = '';
      hud.style.background = '';
      glCanvas = null;
    }
  }

  function mount(theCanvas) {
    canvas = theCanvas;
    canvas.width = W; canvas.height = H;
    ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    mountGLLayer(canvas);          // create the optional WebGL2 layer underneath
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
