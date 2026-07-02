// test/golden.ts — headless byte-exact pixel goldens for the wasm rasterizer.
//
// Loads host-web/psp-ui.wasm under Bun, installs the SAME HostOps binding the
// browser host uses (host-web/wasm-ops.js), evals a dist/<demo>.js bundle with
// globalThis.ui + globalThis.__dcpak pre-installed (the host contract), drives
// N fixed-dt frames with a scripted input function, captures the RGBA
// framebuffer at chosen frames and byte-compares the encoded PNG against the
// committed test/goldens/<demo>.<frame>.png.
//
//   bun test/golden.ts            # compare (builds wasm/bundle if missing)
//   UPDATE=1 bun test/golden.ts   # (re)write goldens
//
// Determinism: core ticks exactly 1/60 s per frame (frame content is a pure
// function of frame index), the rasterizer is integer/exact-f32 math, and the
// PNG encoder (Bun.deflateSync) is deterministic — so byte equality holds.
// On mismatch a <demo>.<frame>.actual.png is written next to the golden.

import { existsSync, mkdirSync } from "node:fs";
import { createWasmUi } from "../host-web/wasm-ops.js";
import { BTN, SCREEN_H, SCREEN_W } from "../spec/spec.ts";

const ROOT = new URL("..", import.meta.url).pathname; // psp-ui/
const DIST = ROOT + "dist/";
const GOLDEN_DIR = ROOT + "test/goldens/";
const WASM_PATH = ROOT + "host-web/psp-ui.wasm";
const UPDATE = !!process.env.UPDATE;

const W = SCREEN_W;
const H = SCREEN_H;

// ---------------------------------------------------------------------------
// Ensure build artifacts exist (missing only — never silently rebuild stale)
// ---------------------------------------------------------------------------

function ensureBuilt(path: string, cmd: string[]): void {
  if (existsSync(path)) return;
  console.log(`golden: ${path.slice(ROOT.length)} missing — running: ${cmd.join(" ")}`);
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(path)) {
    console.error(`golden: failed to produce ${path}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Minimal deterministic PNG encoder (dreamcart framework/test/golden.ts copy)
// ---------------------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** adler32 (the zlib-stream trailer). */
function adler32(buf: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Bun.deflateSync emits a RAW deflate stream; PNG IDAT needs the zlib
 *  wrapper (2-byte header + adler32 trailer) — add it ourselves. */
function zlibWrap(raw: Uint8Array): Buffer {
  // (cast: Buffer is Uint8Array<ArrayBufferLike> but this one is always heap-backed)
  const body = Bun.deflateSync(raw as Uint8Array<ArrayBuffer>);
  const out = Buffer.alloc(body.length + 6);
  out[0] = 0x78; // CM=8, CINFO=7
  out[1] = 0x01; // FCHECK making (out[0]<<8|out[1]) % 31 == 0, FLEVEL 0
  Buffer.from(body).copy(out, 2);
  out.writeUInt32BE(adler32(raw), body.length + 2);
  return out;
}

function encodePNG(rgba: Uint8Array): Buffer {
  const stride = W * 4;
  const raw = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibWrap(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Distinct packed-pixel count — a golden must never be one flat color. */
function distinctPixels(rgba: Uint8Array): number {
  const seen = new Set<number>();
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, W * H);
  for (let i = 0; i < u32.length; i++) {
    seen.add(u32[i]);
    if (seen.size > 16) break; // enough to prove non-triviality
  }
  return seen.size;
}

// ---------------------------------------------------------------------------
// Demo specs (scripted input per DESIGN.md testing plan)
// ---------------------------------------------------------------------------

interface Spec {
  name: string;
  frames: number;
  /** Frame indices to capture+compare (after frame()+tick()+render()). */
  capture: number[];
  input?: (f: number) => number;
}

const SPECS: Spec[] = [
  {
    // hero: initial layout (f2), mid focus-transition after DOWN at f5 —
    // transition-colors 150ms ≈ 9 frames (f10), then five CIRCLE presses
    // (edge-detected: 1-frame pulses) -> count 5: "You pressed a lot!" row
    // visible, white bar translated 10px, focus color settled (f80).
    name: "hero-main",
    frames: 90,
    capture: [2, 10, 80],
    input: (f) =>
      f === 5
        ? BTN.DOWN
        : f >= 20 && f <= 36 && (f - 20) % 4 === 0
          ? BTN.CIRCLE
          : 0,
  },
  {
    // cards: f2 = early layout (cards mid mount-fade, nothing focused);
    // RIGHT at f4 focuses card 0, RIGHT at f8 moves to card 1 — f12 is
    // mid focus-transition (card 0 settling back down, card 1 lifting);
    // CIRCLE at f18 opens card 1's detail panel (mount color-fade + translateY
    // spring) — f78 is fully settled, ambient streaks drifted ~1.2 s.
    name: "cards-main",
    frames: 90,
    capture: [2, 12, 78],
    input: (f) => (f === 4 || f === 8 ? BTN.RIGHT : f === 18 ? BTN.CIRCLE : 0),
  },
  {
    // stats: f2 = early layout (counters near 0, bar fills barely started —
    // staggered 90 ms delays); f20 = mid animation (counters mid ease-out,
    // bars part-grown); DOWN at f50 switches OVERVIEW -> SYSTEMS — f85 is
    // settled on the second tab (counters capped at f75, rows faded/sprung in).
    name: "stats-main",
    frames: 95,
    capture: [2, 20, 85],
    input: (f) => (f === 50 ? BTN.DOWN : 0),
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

ensureBuilt(WASM_PATH, ["bun", "scripts/wasm.ts"]);
for (const spec of SPECS) {
  ensureBuilt(DIST + spec.name + ".js", ["bun", "scripts/build.ts", `demos/${spec.name}.tsx`]);
}
mkdirSync(GOLDEN_DIR, { recursive: true });

const wasmBytes = await Bun.file(WASM_PATH).arrayBuffer();

async function runDemo(spec: Spec): Promise<Map<number, Uint8Array>> {
  // A fresh wasm instance per demo: fresh core, zero cross-demo state.
  const wasm = await createWasmUi(wasmBytes);
  const g = globalThis as Record<string, unknown>;
  g.ui = wasm.ops; // the host contract: HostOps BEFORE eval
  g.__dcpak = existsSync(DIST + spec.name + ".dcpak")
    ? await Bun.file(DIST + spec.name + ".dcpak").arrayBuffer()
    : undefined;
  g.frame = undefined;
  try {
    const src = await Bun.file(DIST + spec.name + ".js").text();
    (0, eval)(src); // IIFE mounts the app and installs globalThis.frame
    const frame = g.frame as ((buttons: number) => void) | undefined;
    if (typeof frame !== "function") {
      throw new Error("bundle did not install globalThis.frame (does the entry call render()?)");
    }
    const captures = new Map<number, Uint8Array>();
    const want = new Set(spec.capture);
    for (let f = 0; f < spec.frames; f++) {
      frame(spec.input ? spec.input(f) : 0); // input + effects + sweep
      wasm.tick(); // anims + layout, exactly 1/60 s
      if (want.has(f)) captures.set(f, wasm.render().slice());
    }
    return captures;
  } finally {
    delete g.ui;
    delete g.__dcpak;
    g.frame = undefined;
  }
}

let pass = 0;
let fail = 0;
for (const spec of SPECS) {
  let captures: Map<number, Uint8Array>;
  try {
    captures = await runDemo(spec);
  } catch (e) {
    console.log("FAIL ", spec.name, "- threw:", (e as Error)?.stack ?? e);
    fail++;
    continue;
  }
  for (const f of spec.capture) {
    const label = `${spec.name}.${f}`;
    const buf = captures.get(f)!;
    const distinct = distinctPixels(buf);
    if (distinct < 3) {
      console.log("FAIL ", label, `- degenerate frame (${distinct} distinct pixel value(s))`);
      await Bun.write(GOLDEN_DIR + label + ".actual.png", encodePNG(buf));
      fail++;
      continue;
    }
    const png = encodePNG(buf);
    const goldPath = GOLDEN_DIR + label + ".png";
    if (UPDATE || !existsSync(goldPath)) {
      await Bun.write(goldPath, png);
      console.log(UPDATE ? "WROTE" : "NEW  ", label);
      pass++;
    } else {
      const gold = new Uint8Array(await Bun.file(goldPath).arrayBuffer());
      let diff = png.length !== gold.length ? 1 : 0;
      for (let i = 0; i < png.length && diff === 0; i++) {
        if (png[i] !== gold[i]) diff = 1;
      }
      if (diff === 0) {
        console.log("PASS ", label);
        pass++;
      } else {
        await Bun.write(GOLDEN_DIR + label + ".actual.png", png);
        console.log("FAIL ", label, "- PNG bytes differ (see " + label + ".actual.png)");
        fail++;
      }
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
