// Build the PSP EBOOT.PBP via `cargo psp`, with the toolchain env wired up using
// Bun shell. Select the game with PSPJS_GAME. Run: bun runtime/build.ts
import { $ } from "bun";
import { existsSync } from "node:fs";

const runtimeDir = new URL(".", import.meta.url).pathname; // .../runtime/
const root = new URL("..", import.meta.url).pathname; // repo root
const sdk = root + "mipsel-sony-psp";
const llvm = existsSync("/opt/homebrew/opt/llvm/bin") ? "/opt/homebrew/opt/llvm/bin" : "/usr/local/opt/llvm/bin";
const home = process.env.HOME ?? "";
const pspTarget = runtimeDir + "targets/mipsel-sony-psp.json";

const TOOLCHAIN = "nightly-2026-05-28";
const rustup = Bun.which("rustup") ?? (existsSync(`${home}/.cargo/bin/rustup`) ? `${home}/.cargo/bin/rustup` : null);
const rustflags = [
  process.env.RUSTFLAGS,
  process.env.PSPJS_SUPPRESS_LINKER_MESSAGES === "1" ? "-A linker-messages" : undefined,
  "-A unexpected-cfgs",
  "-A unstable-name-collisions",
].filter(Boolean).join(" ");
const env = {
  ...process.env,
  PATH: `${llvm}:${home}/.cargo/bin:${process.env.PATH}`,
  RUSTFLAGS: rustflags,
  CRATE_CC_NO_DEFAULTS: "1",
  TARGET_CC: "clang",
  TARGET_AR: `${llvm}/llvm-ar`,
  // Match the Rust PSP target's +noabicalls mode. -G0 avoids clang's MIPS
  // backend selecting unsupported GP-relative accesses for large C sources.
  TARGET_CFLAGS:
    `-target mipsel-sony-psp -mcpu=mips2 -msingle-float -mlittle-endian -mno-abicalls -fno-pic -G0 -mno-check-zero-division ` +
    `-fno-stack-protector -I${sdk}/psp/include -I${sdk}/psp/sdk/include`,
  // CRITICAL: archive MIPS objects with llvm-ar (Apple ar drops them -> undefined JS_*).
  AR_mipsel_sony_psp: `${llvm}/llvm-ar`,
  RANLIB_mipsel_sony_psp: `${llvm}/llvm-ranlib`,
  RUST_PSP_TARGET: pspTarget,
  // Keep PSP dev builds fast without reviving the old RUSTFLAGS workaround that
  // mixed opt-level with link-dead-code and triggered noisy MIPS relocations.
  CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "3",
};

function outputProfile(args: string[]): string {
  const inlineProfile = args.find((arg) => arg.startsWith("--profile="));
  if (inlineProfile) return inlineProfile.slice("--profile=".length);
  const profileFlag = args.indexOf("--profile");
  if (profileFlag !== -1 && args[profileFlag + 1]) return args[profileFlag + 1];
  return args.includes("--release") || args.includes("-r") ? "release" : "debug";
}

const cargoArgs = Bun.argv.slice(2);
const profile = outputProfile(cargoArgs);
const game = process.env.PSPJS_GAME ?? "raw-snake.js";
console.log("PSP build: " + game);
if (process.env.PSPJS_DIAG_MODE) console.log("PSP diag mode: " + process.env.PSPJS_DIAG_MODE);
if (!rustup) {
  console.error("rustup not found; run `bun run bootstrap` first");
  process.exit(1);
}
await $`${rustup} run ${TOOLCHAIN} cargo psp ${cargoArgs}`.cwd(runtimeDir).env(env);
console.log(`output: runtime/target/mipsel-sony-psp/${profile}/EBOOT.PBP`);
