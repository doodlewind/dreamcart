// One-time setup after cloning: init the rust-psp / quickjs-rs submodules and
// apply the small local patches they need (kept as patch files since they live
// in submodules). Idempotent. Run: bun run setup
import { $ } from "bun";

const root = new URL("..", import.meta.url).pathname;

console.log("init submodules...");
await $`git submodule update --init --depth 1`.cwd(root).nothrow();

const patches: [string, string][] = [
  ["rust-psp", root + "patches/rust-psp.patch"],
  ["quickjs-rs", root + "patches/quickjs-rs.patch"],
];

for (const [sub, patch] of patches) {
  // Already applied? `git apply --reverse --check` succeeds -> skip.
  const applied = await $`git -C ${sub} apply --reverse --check ${patch}`.cwd(root).nothrow().quiet();
  if (applied.exitCode === 0) {
    console.log(sub + ": patch already applied");
    continue;
  }
  const res = await $`git -C ${sub} apply ${patch}`.cwd(root).nothrow();
  if (res.exitCode === 0) console.log(sub + ": patch applied");
  else {
    console.error(sub + ": failed to apply patch");
    process.exit(1);
  }
}

console.log("\nsetup complete. Next:");
console.log("  rustup override set nightly-2021-11-01-x86_64-apple-darwin   # in repo root (for PSP)");
console.log("  bun run serve   # web playground   |   bun run psp / bun run 3ds");
