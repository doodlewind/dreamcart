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
const toolchainBin = `${home}/.rustup/toolchains/${TOOLCHAIN}/bin`;
const pspTools = root + "rust-psp/target/release";
const env = {
  ...process.env,
  PATH: `${toolchainBin}:${pspTools}:${llvm}:${home}/.cargo/bin:${process.env.PATH}`,
  RUSTC: `${toolchainBin}/rustc`,
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

const game = process.env.PSPJS_GAME ?? "raw-snake.js";
console.log("PSP build: " + game);

if (!existsSync(`${sdk}/psp/lib/libc.a`)) {
  throw new Error("PSPSDK is missing. Run `bun run bootstrap` to install mipsel-sony-psp.");
}

if (!existsSync(`${toolchainBin}/cargo`)) {
  throw new Error(`Rust PSP toolchain is missing: ${TOOLCHAIN}. Run \`bun run bootstrap\`.`);
}

if (!existsSync(`${pspTools}/cargo-psp`) && !existsSync(root + "rust-psp/cargo-psp/Cargo.toml")) {
  throw new Error("rust-psp submodule is missing. Run `bun run setup`, then retry.");
}

if (!existsSync(`${pspTools}/cargo-psp`)) {
  console.log("building local cargo-psp tools...");
  const stableCargo =
    existsSync(`${home}/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo`)
      ? `${home}/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo`
      : `${home}/.cargo/bin/cargo`;
  await $`${stableCargo} build --release --bins`.cwd(root + "rust-psp/cargo-psp").env({
    ...process.env,
    PATH: `${home}/.cargo/bin:${process.env.PATH}`,
  });
}

// Invoke the matching local cargo-psp by ABSOLUTE path. Calling `cargo psp`
// lets Cargo resolve a global subcommand before our env PATH is applied on some
// setups, which can pick up a newer cargo-psp that requires an incompatible
// rustc. The extra `psp` argument preserves cargo-subcommand argv shape because
// rust-psp's cargo-psp skips argv[0] and argv[1].
const cargoPsp = `${pspTools}/cargo-psp`;
await $`${cargoPsp} psp ${Bun.argv.slice(2)}`.cwd(runtimeDir).env(env);
console.log("output: runtime/target/mipsel-sony-psp/debug/EBOOT.PBP");
