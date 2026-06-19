// One-time setup after cloning: init the rust-psp / quickjs-rs submodules.
// Idempotent. Run: bun run setup
import { $ } from "bun";
import { existsSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const submodules = ["rust-psp", "quickjs-rs"];

console.log("init submodules...");
for (const sub of submodules) {
  if (existsSync(root + sub + "/.git")) {
    const status = await $`git -C ${sub} status --porcelain`.cwd(root).nothrow().quiet().text().catch(() => "");
    if (status.trim()) {
      console.log(sub + ": local changes present; skip checkout");
      continue;
    }
  }
  const res = await $`git submodule update --init --depth 1 -- ${sub}`.cwd(root).nothrow();
  if (res.exitCode !== 0) {
    console.error(sub + ": failed to init/update submodule");
    process.exit(1);
  }
}

console.log("\nsetup complete. Next:");
console.log("  rustup override set nightly-2026-05-28   # in repo root (for PSP)");
console.log("  bun run serve   # web playground   |   bun run psp / bun run 3ds");
