// One-time setup after cloning: init the rust-psp / quickjs-rs submodules and
// apply the local rust-psp patch (kept as a patch file since it lives in a
// submodule). Idempotent. Run: bun run setup
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

const patches: [string, string][] = [
  ["rust-psp", root + "patches/rust-psp.patch"],
];

for (const [sub, patch] of patches) {
  // Already applied? `git apply --reverse --check` succeeds -> skip.
  const applied = await $`git -C ${sub} apply --whitespace=nowarn --reverse --check ${patch}`.cwd(root).nothrow().quiet();
  if (applied.exitCode === 0) {
    console.log(sub + ": patch already applied");
    continue;
  }
  const res = await $`git -C ${sub} apply --whitespace=nowarn ${patch}`.cwd(root).nothrow();
  if (res.exitCode === 0) console.log(sub + ": patch applied");
  else {
    console.error(sub + ": failed to apply patch");
    process.exit(1);
  }
}

console.log("\nsetup complete. Next:");
console.log("  rustup override set nightly-2026-05-28   # in repo root (for PSP)");
console.log("  bun run serve   # web playground   |   bun run psp / bun run 3ds");
