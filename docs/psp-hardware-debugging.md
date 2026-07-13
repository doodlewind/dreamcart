# Debugging on a real PSP over USB

Run a freshly compiled DreamCart game on an actual PSP in a couple of seconds —
straight from your cargo output, with **no copying files to the memory stick**.
Edit code, press Enter, see it on the hardware.

```sh
bun run psp:hw walk3d
```

This drives the classic PSP homebrew debug chain (PSPLINK + usbhostfs) so you get
a tight edit → build → run loop on real silicon, not just the emulator.

## How it works (30 seconds)

- **`usbhostfs_pc`** (runs on your Mac) exposes a directory — your cargo output —
  to the PSP as the virtual drive `host0:` over USB.
- **PSPLINK** (a small homebrew running on the PSP) loads and starts a module
  directly from `host0:`. It stays resident underneath your game.
- **`pspsh`** is the shell used to send PSPLINK commands (`ldstart`, `reset`).
- Because PSPLINK stays resident, `reset` gives you a clean machine, and the next
  `ldstart` runs your newly built `.prx`. `bun run psp:hw` automates all of this.

## Prerequisites

- A **PSP with custom firmware** (PRO / ARK / ME / …). CFW is what lets homebrew
  and PSPLINK run at all.
- A **data** USB cable. Many PSP / mini-USB cables are charge-only — see
  [Troubleshooting](#troubleshooting).
- macOS with Homebrew (the setup commands below are for macOS/Apple Silicon;
  Linux is analogous but installs `usbhostfs_pc`/`pspsh` from your package
  manager or the same source).

## One-time setup

### 1. Host tools — `usbhostfs_pc` and `pspsh`

These are not in Homebrew; build the two clients from the pspdev `psplinkusb`
source. `pspsh` links Homebrew `readline`, which is keg-only, so its paths are
passed explicitly.

```sh
brew install libusb                       # readline is usually already present
git clone https://github.com/pspdev/psplinkusb.git ~/code/psplinkusb

make -C ~/code/psplinkusb/usbhostfs_pc
make -C ~/code/psplinkusb/pspsh \
  CPPFLAGS="-I$(brew --prefix readline)/include" \
  LIBS="-L$(brew --prefix readline)/lib -lreadline"

# put them on PATH
ln -sf ~/code/psplinkusb/usbhostfs_pc/usbhostfs_pc /opt/homebrew/bin/
ln -sf ~/code/psplinkusb/pspsh/pspsh             /opt/homebrew/bin/
```

Verify: `usbhostfs_pc -h` and `pspsh -h` should run.

### 2. PSPLINK on the PSP

Grab the prebuilt PSPLINK and copy it onto the memory stick. With the PSP
connected in USB mass-storage mode (or its stick in a card reader):

```sh
curl -L -o /tmp/psplink.zip \
  https://github.com/pspdev/psplinkusb/releases/latest/download/psplink.zip
unzip /tmp/psplink.zip -d "/Volumes/<PSP_STICK>/PSP/GAME/"
```

That creates `PSP/GAME/psplink/` (EBOOT + `.prx` modules). Eject the stick.
PSPLINK now appears in the PSP's **Game** menu.

## Daily use

```sh
bun run psp:hw walk3d
```

Then on the PSP, launch **PSPLINK** from the XMB **Game** menu. The tool waits
for the USB link, loads your game, and drops you into a reload prompt:

- Press **Enter** to rebuild and reload the latest code.
- Type **q** then Enter to quit.

Other forms:

```sh
bun run psp:hw               # default game (raw-snake)
bun run psp:hw walk3d -r     # release profile
bun run psp:hw --once        # build + load once, then exit (CI / scripts)
bun run psp:hw --no-build    # reload whatever is already built
```

No environment variables required. The tool auto-picks a free TCP port block for
the link; override the starting port with `PSP_HW_PORT` if you ever need to.

## Troubleshooting

**"PSP never connected" / nothing shows up.**
The Mac isn't seeing the PSP on USB at all. Check:
```sh
ioreg -p IOUSB | grep -i PSP     # should print: "PSP" Type B
```
If that prints nothing it is a hardware/cable issue, not software:
- Use a **data** cable — many PSP cables only carry power. This is the most
  common cause.
- Plug directly into the Mac, not through a hub or dock.
- The PSP sleeps when idle and drops the link; wake it and it reconnects
  automatically (`usbhostfs_pc` re-prints `Connected to device`).

**`bind: Address already in use`.**
Something holds the default PSPLINK port (10000). `bun run psp:hw` auto-scans for
a free block, but if you run the raw tools, give `usbhostfs_pc -b` / `pspsh -p` a
different base port. (On this project's dev Mac, Baidu Netdisk squats on 10000.)

**`ldstart … Error: 0x80020148` (`UNSUPPORTED_PRX_TYPE`).**
You pointed `ldstart` at `EBOOT.PBP`. PSPLINK doesn't unwrap the PBP container —
load the raw `pspjs-runtime.prx` instead. (`bun run psp:hw` already does this.)

**`ldstart … Error: 0x800200D9` (`MEMBLOCK_ALLOC_FAILED`) when reloading.**
The previous module didn't free its memory (rust-psp modules don't tear down on
stop, so `modstun` + `ldstart` leaks). Always `reset` before re-loading. That's
why `bun run psp:hw` resets between reloads.

**Build fails with a missing SDK.**
Run `bun run bootstrap`. DreamCart and PocketJS share the pinned SDK under
`${XDG_CACHE_HOME:-$HOME/.cache}/pocket-stack`; set `PSP_SDK` (preferred) or
`PSPDEV` only when deliberately overriding that cache.

## Doing it by hand

If you want to drive the chain manually (or on Linux):

```sh
# serve the build directory to the PSP as host0:
usbhostfs_pc -b 10200 runtime/target/mipsel-sony-psp/debug &

# launch PSPLINK on the PSP, wait for "Connected to device", then:
pspsh -p 10200 -e "ldstart host0:/pspjs-runtime.prx"    # load + run

# after rebuilding (bun run psp):
pspsh -p 10200 -e "reset"                                # clean reboot
pspsh -p 10200 -e "ldstart host0:/pspjs-runtime.prx"     # run the new build
```

Handy PSPLINK commands over `pspsh -p <port> -e "<cmd>"`: `modlist` (list loaded
modules), `ls host0:/` (list the served directory), `reset` (reboot PSPLINK),
`ldstart <prx>` (load + start a module).
