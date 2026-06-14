// Build the PSP EBOOT.PBP via `cargo psp`, with the toolchain env wired up using
// Bun shell. Select the game with PSPJS_GAME. Run: bun runtime/build.ts
import { $ } from "bun";
import { existsSync } from "node:fs";

const runtimeDir = new URL(".", import.meta.url).pathname; // .../runtime/
const root = new URL("..", import.meta.url).pathname; // repo root
const sdk = root + "mipsel-sony-psp";
const llvm = existsSync("/opt/homebrew/opt/llvm/bin") ? "/opt/homebrew/opt/llvm/bin" : "/usr/local/opt/llvm/bin";
const home = process.env.HOME ?? "";

const TOOLCHAIN = "nightly-2021-11-01-x86_64-apple-darwin";
const env = {
  ...process.env,
  PATH: `${llvm}:${home}/.cargo/bin:${process.env.PATH}`,
  CRATE_CC_NO_DEFAULTS: "1",
  TARGET_CC: "clang",
  TARGET_AR: `${llvm}/llvm-ar`,
  TARGET_CFLAGS:
    `-target mipsel-sony-psp -mcpu=mips2 -msingle-float -mlittle-endian -mno-check-zero-division ` +
    `-fno-stack-protector -I${sdk}/psp/include -I${sdk}/psp/sdk/include`,
  // CRITICAL: archive MIPS objects with llvm-ar (Apple ar drops them -> undefined JS_*).
  AR_mipsel_sony_psp: `${llvm}/llvm-ar`,
  RANLIB_mipsel_sony_psp: `${llvm}/llvm-ranlib`,
};

const game = process.env.PSPJS_GAME ?? "snake.js";
console.log("PSP build: " + game);
// Invoke the pinned toolchain's cargo by ABSOLUTE path: Bun's $ resolves command
// names against the original process PATH (not .env), so a bare `cargo` would hit
// the wrong (newer) cargo and desync from the 1.58 rustc. The spawned cargo still
// gets our env PATH, so it finds cargo-psp + llvm clang/ar.
const cargo = `${home}/.rustup/toolchains/${TOOLCHAIN}/bin/cargo`;
await $`${cargo} psp ${Bun.argv.slice(2)}`.cwd(runtimeDir).env(env);
console.log("output: runtime/target/mipsel-sony-psp/debug/EBOOT.PBP");
