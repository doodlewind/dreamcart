// Build the PSP EBOOT.PBP via `cargo psp`, with the toolchain env wired up using
// Bun shell. Select the game with DREAMCART_GAME. Run: bun runtime/build.ts
import { $ } from "bun";
import { existsSync } from "node:fs";
import {
  pspBuildEnvironment,
  PSP_TOOLCHAIN,
  requirePspTools,
  resolvePspSdk,
} from "../scripts/psp-toolchain.ts";

const runtimeDir = new URL(".", import.meta.url).pathname; // .../runtime/
const llvm = existsSync("/opt/homebrew/opt/llvm/bin") ? "/opt/homebrew/opt/llvm/bin" : "/usr/local/opt/llvm/bin";
const home = process.env.HOME ?? "";
const pspTarget = runtimeDir + "targets/mipsel-sony-psp.json";

let sdk: ReturnType<typeof resolvePspSdk>;
try {
  sdk = resolvePspSdk();
  requirePspTools();
} catch (error) {
  console.error(`DreamCart PSP build: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const rustup = Bun.which("rustup") ?? (existsSync(`${home}/.cargo/bin/rustup`) ? `${home}/.cargo/bin/rustup` : null);
const toolchainEnv = pspBuildEnvironment(sdk);
const rustflags = [
  process.env.RUSTFLAGS,
  // The prebuilt PSPSDK newlib (libc.a/libm.a) is compiled +abicalls, while the
  // rust-psp target is +noabicalls. rust-lld's `linker_messages` lint (warn by
  // default since the 2026 nightly) then floods one "linking abicalls code with
  // non-abicalls code" warning PER newlib object — a benign, structural property
  // of the rust-psp + PSPSDK combination that has always held (the EBOOT links
  // and runs). Suppress it by DEFAULT so the noise can't bury a real linker
  // message; set DREAMCART_SHOW_LINKER_MESSAGES=1 to inspect raw linker output. Real
  // link failures (undefined symbols, etc.) are hard errors, unaffected by this.
  process.env.DREAMCART_SHOW_LINKER_MESSAGES === "1" ? undefined : "-A linker-messages",
  "-A unexpected-cfgs",
  "-A unstable-name-collisions",
].filter(Boolean).join(" ");
const env = {
  ...toolchainEnv,
  PATH: `${llvm}:${home}/.cargo/bin:${toolchainEnv.PATH}`,
  RUSTFLAGS: rustflags,
  CRATE_CC_NO_DEFAULTS: "1",
  TARGET_CC: "clang",
  TARGET_AR: `${llvm}/llvm-ar`,
  // Match the Rust PSP target's +noabicalls mode. -G0 avoids clang's MIPS
  // backend selecting unsupported GP-relative accesses for large C sources.
  TARGET_CFLAGS:
    `-target mipsel-sony-psp -mcpu=mips2 -msingle-float -mlittle-endian -mno-abicalls -fno-pic -G0 -mno-check-zero-division ` +
    `-fno-stack-protector -I${sdk.root}/psp/include -I${sdk.root}/psp/sdk/include`,
  // CRITICAL: archive MIPS objects with llvm-ar (Apple ar drops them -> undefined JS_*).
  AR_mipsel_sony_psp: `${llvm}/llvm-ar`,
  RANLIB_mipsel_sony_psp: `${llvm}/llvm-ranlib`,
  RUST_PSP_TARGET: pspTarget,
  // Dreamcart runs panic-abort on PSP; this avoids building/linking
  // panic_unwind + libunwind into no_std EBOOTs.
  RUST_PSP_ABORT_ONLY: "1",
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
const game = process.env.DREAMCART_GAME ?? "raw-snake.js";
console.log("PSP build: " + game);
if (process.env.DREAMCART_TRACE === "1") console.log("PSP trace: enabled");
if (!rustup) {
  console.error("rustup not found; install rustup, then run `bun run bootstrap`");
  process.exit(1);
}
await $`${rustup} run ${PSP_TOOLCHAIN.rust.toolchain} cargo psp ${cargoArgs}`.cwd(runtimeDir).env(env);
console.log(`output: runtime/target/mipsel-sony-psp/${profile}/EBOOT.PBP`);
