// One-shot environment bootstrap for a fresh clone (macOS). Idempotent — each
// step checks first and skips if already done. Run: bun run bootstrap
//
// Sets up: bun deps, submodules + patches, LLVM, PPSSPP, Azahar (3DS emulator),
// Rust nightly + rust-src, cargo-psp/prxgen/pack-pbp/mksfo, the PSPSDK, and the
// devkitARM docker image. Prereqs it can't auto-install (Bun, Homebrew, Docker
// daemon) are detected and reported.
import { $ } from "bun";
import { existsSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const home = process.env.HOME!;
const TOOLCHAIN = "nightly-2021-11-01-x86_64-apple-darwin";
const arch = process.arch === "arm64" ? "arm64" : "x86_64";

const brew = Bun.which("brew");
const rustup = Bun.which("rustup") ?? (existsSync(`${home}/.cargo/bin/rustup`) ? `${home}/.cargo/bin/rustup` : null);
const cargo = Bun.which("cargo") ?? (existsSync(`${home}/.cargo/bin/cargo`) ? `${home}/.cargo/bin/cargo` : null);
const docker = Bun.which("docker");

type Status = "ok" | "skip" | "warn" | "fail";
const results: { name: string; status: Status; note?: string }[] = [];
const rec = (name: string, status: Status, note?: string) => {
  const icon = { ok: "✓", skip: "·", warn: "!", fail: "✗" }[status];
  console.log(`  ${icon} ${name}${note ? " — " + note : ""}`);
  results.push({ name, status, note });
};

async function run(p: ReturnType<typeof $>): Promise<boolean> {
  const r = await p.nothrow().quiet();
  return r.exitCode === 0;
}

console.log("psp-js environment setup (" + arch + ")\n");

// 1) Bun deps
console.log("deps:");
if (await run($`bun install`.cwd(root))) rec("bun install", "ok");
else rec("bun install", "fail");

// 2) submodules + patches
console.log("submodules:");
if (await run($`bun ${root}scripts/setup.ts`)) rec("submodules + patches (bun run setup)", "ok");
else rec("submodules + patches", "fail");

// 3) Homebrew (prereq)
console.log("homebrew packages:");
if (!brew) {
  rec("Homebrew", "warn", "not found — install from https://brew.sh, then re-run");
} else {
  // LLVM (Apple clang can't target MIPS)
  if (existsSync("/opt/homebrew/opt/llvm/bin/clang") || existsSync("/usr/local/opt/llvm/bin/clang")) rec("LLVM", "skip");
  else rec("LLVM", (await run($`${brew} install llvm`)) ? "ok" : "fail");
  // PPSSPP (PSP emulator)
  if (existsSync("/Applications/PPSSPPSDL.app")) rec("PPSSPP", "skip");
  else rec("PPSSPP", (await run($`${brew} install --cask ppsspp`)) ? "ok" : "fail");
}

// 4) Azahar (3DS emulator) — standalone macOS build from GitHub releases
console.log("3ds emulator:");
await installAzahar();

// 5) Rust nightly toolchain
console.log("rust:");
if (!rustup) {
  rec("rustup", "warn", "not found — install from https://rustup.rs, then re-run");
} else {
  const haveTc = await run($`${rustup} toolchain list`.env({ ...process.env }));
  const tcList = (await $`${rustup} toolchain list`.nothrow().quiet().text().catch(() => "")) || "";
  if (haveTc && tcList.includes(TOOLCHAIN)) rec("nightly toolchain", "skip", TOOLCHAIN);
  else {
    const okTc = await run($`${rustup} toolchain install ${TOOLCHAIN} --component rust-src --profile minimal --force-non-host`);
    rec("nightly toolchain", okTc ? "ok" : "fail", TOOLCHAIN);
  }
  // rust-src component (in case toolchain existed without it)
  await run($`${rustup} component add rust-src --toolchain ${TOOLCHAIN}`);
  // pin the override for this repo
  if (await run($`${rustup} override set ${TOOLCHAIN}`.cwd(root))) rec("rustup override (repo)", "ok");
}

// 6) cargo-psp + prxgen/pack-pbp/mksfo on PATH
console.log("cargo-psp tools:");
const tools = ["cargo-psp", "prxgen", "pack-pbp", "mksfo"];
if (tools.every((t) => existsSync(`${home}/.cargo/bin/${t}`))) {
  rec("cargo-psp tools", "skip");
} else if (!cargo) {
  rec("cargo-psp tools", "warn", "cargo not found");
} else if (!existsSync(root + "rust-psp/cargo-psp/Cargo.toml")) {
  rec("cargo-psp tools", "warn", "rust-psp submodule missing (run setup)");
} else {
  const built = await run($`${cargo} +stable build --release --bins`.cwd(root + "rust-psp/cargo-psp"));
  if (built) {
    for (const t of tools) await run($`cp ${root}rust-psp/target/release/${t} ${home}/.cargo/bin/${t}`);
    rec("cargo-psp tools", "ok");
  } else rec("cargo-psp tools", "fail", "build failed");
}

// 7) PSPSDK (prebuilt newlib)
console.log("pspsdk:");
if (existsSync(root + "mipsel-sony-psp/psp/lib/libc.a")) {
  rec("PSPSDK", "skip");
} else {
  const url = "https://github.com/doodlewind/psp-test-app/releases/download/sdk/mipsel-sony-psp.zip";
  const okDl = await run($`curl -fsSL -o /tmp/psp-sdk.zip ${url}`);
  const okUz = okDl && (await run($`unzip -q -o /tmp/psp-sdk.zip -d ${root}`));
  rec("PSPSDK", okUz ? "ok" : "fail");
}

// 8) devkitARM docker image (3DS toolchain)
console.log("3ds toolchain (docker):");
if (!docker) {
  rec("devkitARM image", "warn", "docker not found (install OrbStack/Docker Desktop)");
} else if (!(await run($`docker info`))) {
  rec("devkitARM image", "warn", "docker daemon not running — start it, then re-run");
} else if (await run($`docker image inspect devkitpro/devkitarm:latest`)) {
  rec("devkitARM image", "skip");
} else {
  rec("devkitARM image", (await run($`docker pull devkitpro/devkitarm:latest`)) ? "ok" : "fail");
}

// summary
console.log("\nsummary:");
const fails = results.filter((r) => r.status === "fail");
const warns = results.filter((r) => r.status === "warn");
for (const w of warns) console.log("  ! " + w.name + (w.note ? ": " + w.note : ""));
for (const f of fails) console.log("  ✗ " + f.name + (f.note ? ": " + f.note : ""));
if (!fails.length && !warns.length) console.log("  all set! try:  bun run play web   /   bun run play psp raw-tetris   /   bun run play 3ds rpg");
else console.log("\n  resolve the items above, then re-run `bun run bootstrap` (it's idempotent).");
process.exit(fails.length ? 1 : 0);

// --- Azahar installer ---
async function installAzahar(): Promise<void> {
  const dests = ["/Applications/Azahar.app", `${home}/Applications/Azahar.app`];
  if (dests.some((d) => existsSync(d))) {
    rec("Azahar", "skip");
    return;
  }
  // find a stable macOS build for this arch (fall back to a pinned version)
  let url = "";
  try {
    const rels: any[] = await fetch("https://api.github.com/repos/azahar-emu/azahar/releases?per_page=20").then((r) => r.json());
    for (const r of rels) {
      if (r.prerelease) continue;
      const a = (r.assets || []).find(
        (x: any) => x.name?.startsWith(`azahar-macos-${arch}-`) && x.name.endsWith(".zip") && !x.name.includes("libretro"),
      );
      if (a) { url = a.browser_download_url; break; }
    }
  } catch { /* offline -> fallback */ }
  if (!url) url = `https://github.com/azahar-emu/azahar/releases/download/2125.1.2/azahar-macos-${arch}-2125.1.2.zip`;

  if (!(await run($`curl -fsSL -o /tmp/azahar.zip ${url}`))) { rec("Azahar", "fail", "download failed"); return; }
  await run($`rm -rf /tmp/azahar-extract`);
  await run($`mkdir -p /tmp/azahar-extract`);
  if (!(await run($`ditto -xk /tmp/azahar.zip /tmp/azahar-extract`))) { rec("Azahar", "fail", "unzip failed"); return; }
  const found = (await $`/usr/bin/find /tmp/azahar-extract -maxdepth 4 -name ${"*.app"} -type d`.nothrow().quiet().text().catch(() => "")).trim().split("\n")[0];
  if (!found) { rec("Azahar", "fail", "no .app in archive"); return; }
  let dest = "/Applications/Azahar.app";
  await run($`rm -rf ${dest}`);
  if (!(await run($`cp -R ${found} ${dest}`))) {
    dest = `${home}/Applications/Azahar.app`;
    await run($`mkdir -p ${home}/Applications`);
    await run($`rm -rf ${dest}`);
    if (!(await run($`cp -R ${found} ${dest}`))) { rec("Azahar", "fail", "copy failed"); return; }
  }
  await run($`xattr -dr com.apple.quarantine ${dest}`); // allow first launch
  rec("Azahar", "ok", url.split("/").pop());
}
