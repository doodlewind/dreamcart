// One-time setup after cloning: init the rust-psp / quickjs-rs submodules.
// Idempotent. Run: bun run setup
import { $ } from "bun";
import { existsSync } from "node:fs";
import { classifySubmodule } from "./submodule-state.ts";

const root = new URL("..", import.meta.url).pathname;
const submodules = ["rust-psp", "quickjs-rs"];

console.log("init submodules...");
await $`git submodule sync -- ${submodules}`.cwd(root);
let protectedCheckout = false;
for (const sub of submodules) {
  const initialized = existsSync(root + sub + "/.git");
  const expected = (await $`git rev-parse :${sub}`.cwd(root).quiet().text()).trim();
  const head = initialized
    ? (await $`git -C ${sub} rev-parse HEAD`.cwd(root).quiet().text()).trim()
    : "";
  const status = initialized
    ? await $`git -C ${sub} status --porcelain`.cwd(root).quiet().text()
    : "";
  const state = classifySubmodule(initialized, status.trim() !== "", head, expected);

  if (state.kind === "ready") {
    console.log(`${sub}: ready (${expected.slice(0, 12)})`);
    continue;
  }
  if (state.kind === "dirty") {
    console.error(`${sub}: local changes present at ${head.slice(0, 12)}; refusing to reset`);
    protectedCheckout = true;
    continue;
  }
  if (state.kind === "diverged") {
    console.error(
      `${sub}: HEAD ${head.slice(0, 12)} differs from pinned ${expected.slice(0, 12)}; refusing to reset`,
    );
    protectedCheckout = true;
    continue;
  }

  const res = await $`git submodule update --init --depth 1 -- ${sub}`.cwd(root).nothrow();
  if (res.exitCode !== 0) {
    console.error(sub + ": failed to init/update submodule");
    process.exit(1);
  }
}

if (protectedCheckout) {
  console.error("\nsetup stopped to preserve submodule work.");
  console.error("Commit/stash that work, or explicitly run `git submodule update --checkout -- <path>`.");
  process.exit(1);
}

console.log("\nsetup complete. Next:");
console.log("  bun run serve   # web playground   |   bun run psp / bun run 3ds");
