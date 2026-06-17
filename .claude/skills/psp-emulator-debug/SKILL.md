---
name: psp-emulator-debug
description: Drive the PPSSPP emulator on macOS to visually debug the PSP runtime (runtime/) — build an EBOOT for a chosen game, launch it, screenshot the render, and diagnose crashes/hangs/low-FPS without the user's eyes. Use when a PSP build "boots to black", crashes, renders wrong, or runs slow, and you need to SEE the screen or read the emulator's logs yourself. macOS + PPSSPPSDL only.
---

# Debugging the PSP runtime via PPSSPP (macOS)

This project's `runtime/` is a Rust + QuickJS PSP app. You can build an EBOOT for any
game and run it in PPSSPP yourself — launching it, screenshotting the framebuffer with
macOS `screencapture`, and reading the emulator's crash reports + logs. Use this to
diagnose "boots to black", crashes, wrong rendering, and low FPS without asking the
user to look.

## Build + launch one game

```bash
# Build the EBOOT with a specific game embedded (the game is selected at BUILD time).
PSPJS_GAME=outdoor3d.js bun runtime/build.ts        # -> runtime/target/.../EBOOT.PBP
# CRITICAL: builds don't always relink on rapid re-runs. VERIFY which game is embedded:
strings runtime/target/mipsel-sony-psp/debug/EBOOT.PBP | grep -c "OUTDOOR 3D"   # 1 = yes
```

Two launch modes:

```bash
# GUI launch (for screenshotting). open -a does NOT reliably pass stdout.
pkill -x PPSSPPSDL; sleep 1
open -a PPSSPPSDL runtime/target/mipsel-sony-psp/debug/EBOOT.PBP

# CLI launch (for capturing the emulator's stdout/stderr log — the GOLD for crashes).
( /Applications/PPSSPPSDL.app/Contents/MacOS/PPSSPPSDL "$ABS_PATH_TO_EBOOT" \
  >/tmp/ppsspp.log 2>&1 & )
sleep 16; pkill -x PPSSPPSDL    # kill after it has run a bit
```

Always use an **absolute** path to the EBOOT for the CLI form.

## Screenshot the render

```bash
sleep N                                  # WAIT for boot (see timing below)
open -a PPSSPPSDL                         # re-focus WITHOUT keystrokes (see pitfalls)
sleep 2
screencapture -x -o /tmp/shot.png         # whole screen; the PPSSPP window is in it
```

Then Read /tmp/shot.png. If you only need a number/text on screen and the window is
occluded, that's fine — read what's visible; re-focus and retry if needed.

## Boot timing (do not mistake "slow" for "hung")

QuickJS evaluating a large bundle + decoding base64 assets + heavy `onEnter` work is
SLOW on the emulated 333 MHz core. Typical waits before the first frame renders:
- Small 2D / simple 3D bundle (<100 KB): ~6–8 s
- Textured glTF game (car ~500 KB): ~8–12 s
- Skinned Fox / terrain-gen scene (~400–700 KB): **20–30 s**

If `pgrep -x PPSSPPSDL` still shows it RUNNING, it's booting, not hung. Only treat it
as a crash if the process is gone AND a fresh `.ips` crash report appeared.

## Diagnose a crash

PPSSPP crashing natively writes a macOS crash report:

```bash
latest=$(ls -t ~/Library/Logs/DiagnosticReports/PPSSPPSDL-*.ips | head -1)
python3 -c "import json; raw=open('$latest').read(); d=json.loads(raw[raw.find(chr(10))+1:]); \
print(d['exception']); th=d['threads'][d['faultingThread']]; \
imgs=d['usedImages']; \
[print(imgs[f['imageIndex']]['name'] if f.get('imageIndex') is not None else '?', f.get('symbol','')) for f in th['frames'][:8]]"
```

A fault at host `0x0000000300000000` inside `MIPSState::RunLoopUntil` (JIT, no symbol)
means the GUEST jumped to its address 0 (PPSSPP maps guest RAM base at 0x300000000) —
i.e. guest memory corruption / a null write. The CLI **stdout log** usually names the
real cause; grep it:

```bash
grep -iE "too many|Unable to alloc|partition|invalid|jump to|0=sceKernel" /tmp/ppsspp.log
# e.g. "Unable to allocate kernel object, too many objects slots in use" -> the PSP
# kernel object cap was hit (rust-psp allocates one kernel block PER allocation; see
# the psp-memory-constraints memory + runtime/src/arena.rs).
```

## In-game instrumentation

`log(msg)` (bridge.rs) writes to the PSP **debug screen overlay** (via `psp::dprintln!`),
NOT to PPSSPP stdout — so you can't grep it; you must screenshot the screen, and it
floods. Prefer on-screen HUD you control:
- `now()` (bridge.rs, µs from `sceKernelGetSystemTimeWide`) lets a game compute real
  frame time / FPS (the engine `dt` is a FIXED timestep, not wall-clock). Render it
  with `g.text` so you can read it in a screenshot. (See outdoor3d's `measureFps`.)
- To isolate a cost, patch the **gitignored** bundle in `runtime/src/game/<game>.js`
  directly (sed/python), rebuild, measure; `bun run bundle` restores it from source.
  Toggle one thing at a time (node count, lighting, fog, HUD text) and read the FPS.

## Pitfalls (learned the hard way)

- **`osascript ... keystroke` / `key code` opens PPSSPP's pause menu or bounces focus**
  to another app. To re-focus PPSSPP, use `open -a PPSSPPSDL` (no file arg) — it brings
  the window forward without sending keys. Avoid sending keystrokes unless you mean to.
- **Stale EBOOT**: if a screenshot shows the WRONG game, the build didn't relink —
  rebuild explicitly and re-verify with `strings ... | grep "<TITLE>"`.
- **Enable PPSSPP's own FPS counter** only as a fallback: set `ShowFPSCounter = 3`
  under `[Graphics]` in `~/.config/ppsspp/PSP/SYSTEM/ppsspp.ini` while PPSSPP is NOT
  running (it rewrites the ini on exit). It renders small in the emulated screen's
  corner — an in-game HUD via `now()` is more reliable to read.
- Always `pkill -x PPSSPPSDL` before relaunching so you measure a fresh boot.
