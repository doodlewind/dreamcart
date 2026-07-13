import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  cargoHostTriple,
  hasPinnedPspTools,
  pocketStackCacheRoot,
  publishStagedDirectory,
  pspBuildEnvironment,
  PSP_TOOLCHAIN,
  pspToolchainPaths,
  requirePspTools,
  resolvePspSdk,
  withArtifactLock,
} from "./psp-toolchain.ts";

const root = new URL("..", import.meta.url).pathname;
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function sdk(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `dreamcart-${name}-`));
  temporaryDirectories.push(root);
  const marker = join(root, PSP_TOOLCHAIN.sdk.marker);
  mkdirSync(join(marker, ".."), { recursive: true });
  writeFileSync(marker, "fixture");
  return root;
}

test("manifest pins Pocket Stack repositories and the verified SDK", () => {
  expect(PSP_TOOLCHAIN.quickJsRs.repository).toBe("https://github.com/pocket-stack/quickjs-rs.git");
  expect(PSP_TOOLCHAIN.quickJsRs.rev).toBe("0fc946fb670c0c29bc0135f510bcb0f595415a61");
  expect(PSP_TOOLCHAIN.rustPsp.repository).toBe("https://github.com/pocket-stack/rust-psp.git");
  expect(PSP_TOOLCHAIN.rustPsp.rev).toBe("2cbaf8c9bc72569c76240a1d9743de10731e5f6b");
  expect(PSP_TOOLCHAIN.sdk.url).toContain("github.com/pocket-stack/pspdev/");
  expect(PSP_TOOLCHAIN.sdk.sha256).toBe("fc7d7d502d53987f356871bc8c58396fb0f2a6eb6f5828b16c3bc3f22991a273");
});

test("manifest stays aligned with gitlinks and the Rust toolchain file", async () => {
  const gitmodules = await Bun.file(join(root, ".gitmodules")).text();
  expect(gitmodules).toContain(PSP_TOOLCHAIN.quickJsRs.repository);
  expect(gitmodules).toContain(PSP_TOOLCHAIN.rustPsp.repository);

  const gitlink = (path: string) => Bun.spawnSync({
    cmd: ["git", "rev-parse", `:${path}`],
    cwd: root,
  }).stdout.toString().trim();
  expect(gitlink("quickjs-rs")).toBe(PSP_TOOLCHAIN.quickJsRs.rev);
  expect(gitlink("rust-psp")).toBe(PSP_TOOLCHAIN.rustPsp.rev);

  const rustToolchain = await Bun.file(join(root, "rust-toolchain.toml")).text();
  expect(rustToolchain).toContain(`channel = "${PSP_TOOLCHAIN.rust.toolchain}"`);
  for (const component of PSP_TOOLCHAIN.rust.components) {
    expect(rustToolchain).toContain(`"${component}"`);
  }
});

test("shared cache follows POCKET_STACK_CACHE_DIR then XDG_CACHE_HOME", () => {
  expect(pocketStackCacheRoot({ POCKET_STACK_CACHE_DIR: "/custom/cache" }, "/home/me"))
    .toBe("/custom/cache");
  expect(pocketStackCacheRoot({ XDG_CACHE_HOME: "/xdg" }, "/home/me"))
    .toBe("/xdg/pocket-stack");
  expect(pocketStackCacheRoot({}, "/home/me")).toBe("/home/me/.cache/pocket-stack");
  expect(pspToolchainPaths({}, "/home/me").sdkRoot).toBe(
    "/home/me/.cache/pocket-stack/psp/sdk/sdk-noabicalls-normalized-2026-06-19/mipsel-sony-psp",
  );
});

test("PSP_SDK has precedence and build env exports both SDK names", () => {
  const primary = sdk("primary");
  const secondary = sdk("secondary");
  const resolved = resolvePspSdk({ PSP_SDK: primary, PSPDEV: secondary });
  expect(resolved).toMatchObject({ root: primary, source: "PSP_SDK" });
  expect(pspBuildEnvironment(resolved, { PATH: "/bin" }, "/home/me")).toMatchObject({
    PSP_SDK: primary,
    PSPDEV: primary,
  });
});

test("PSPDEV is accepted as the explicit fallback", () => {
  const root = sdk("pspdev");
  expect(resolvePspSdk({ PSPDEV: root })).toMatchObject({ root, source: "PSPDEV" });
});

test("the shared cache requires a receipt for the verified archive", () => {
  const cache = mkdtempSync(join(tmpdir(), "dreamcart-receipt-"));
  temporaryDirectories.push(cache);
  const env = { POCKET_STACK_CACHE_DIR: cache };
  const root = pspToolchainPaths(env).sdkRoot;
  const marker = join(root, PSP_TOOLCHAIN.sdk.marker);
  mkdirSync(join(marker, ".."), { recursive: true });
  writeFileSync(marker, "fixture");
  expect(() => resolvePspSdk(env)).toThrow(PSP_TOOLCHAIN.sdk.receipt);

  writeFileSync(join(root, PSP_TOOLCHAIN.sdk.receipt), JSON.stringify({
    tag: PSP_TOOLCHAIN.sdk.tag,
    asset: PSP_TOOLCHAIN.sdk.asset,
    url: PSP_TOOLCHAIN.sdk.url,
    sha256: PSP_TOOLCHAIN.sdk.sha256,
  }));
  expect(resolvePspSdk(env)).toMatchObject({ root, source: "cache" });
});

test("an invalid explicit override fails instead of falling through to cache", () => {
  const cache = mkdtempSync(join(tmpdir(), "dreamcart-cache-"));
  temporaryDirectories.push(cache);
  const cachedMarker = join(
    pspToolchainPaths({ POCKET_STACK_CACHE_DIR: cache }).sdkRoot,
    PSP_TOOLCHAIN.sdk.marker,
  );
  mkdirSync(join(cachedMarker, ".."), { recursive: true });
  writeFileSync(cachedMarker, "fixture");
  expect(existsSync(cachedMarker)).toBe(true);
  expect(() => resolvePspSdk({
    POCKET_STACK_CACHE_DIR: cache,
    PSP_SDK: join(cache, "missing"),
  })).toThrow("PSP_SDK PSP SDK is invalid");
});

test("build tools must come from the pinned revision cache for this host", () => {
  const cache = mkdtempSync(join(tmpdir(), "dreamcart-tools-"));
  temporaryDirectories.push(cache);
  const env = { POCKET_STACK_CACHE_DIR: cache };
  expect(() => requirePspTools(env)).toThrow("missing, from the wrong revision");
  const paths = pspToolchainPaths(env);
  const toolsBin = paths.toolsBin;
  mkdirSync(toolsBin, { recursive: true });
  for (const tool of PSP_TOOLCHAIN.cargoPsp.tools) {
    writeFileSync(join(toolsBin, tool), "fixture");
  }
  expect(() => requirePspTools(env)).toThrow("wrong revision");
  const writeMetadata = (rev: string, target: string) => writeFileSync(
    join(paths.toolsRoot, ".crates2.json"),
    JSON.stringify({ installs: {
      [`cargo-psp 0.2.8 (git+${PSP_TOOLCHAIN.rustPsp.repository}?rev=${rev}#${rev})`]: {
        bins: PSP_TOOLCHAIN.cargoPsp.tools,
        target,
      },
    } }),
  );
  writeMetadata("0000000000000000000000000000000000000000", cargoHostTriple());
  expect(hasPinnedPspTools(paths.toolsRoot)).toBe(false);
  writeMetadata(PSP_TOOLCHAIN.rustPsp.rev, "wrong-host-triple");
  expect(hasPinnedPspTools(paths.toolsRoot)).toBe(false);
  writeMetadata(PSP_TOOLCHAIN.rustPsp.rev, cargoHostTriple());
  expect(requirePspTools(env)).toBe(toolsBin);
});

test("artifact locks bound waits, preserve live owners, and recover abandoned locks", async () => {
  const base = mkdtempSync(join(tmpdir(), "dreamcart-lock-"));
  temporaryDirectories.push(base);
  const lock = join(base, "artifact.lock");
  let release!: () => void;
  let acquired!: () => void;
  const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
  const held = withArtifactLock(lock, async () => {
    acquired();
    await new Promise<void>((resolve) => { release = resolve; });
  }, { timeoutMs: 200, staleMs: 5, pollMs: 2 });
  await acquiredPromise;
  const old = new Date(Date.now() - 10_000);
  utimesSync(lock, old, old);
  await expect(withArtifactLock(
    lock,
    async () => undefined,
    { timeoutMs: 20, staleMs: 5, pollMs: 2 },
  )).rejects.toThrow("timed out waiting for artifact lock");
  release();
  await held;

  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({
    token: "abandoned",
    pid: 2_147_483_647,
    hostname: hostname(),
  }));
  utimesSync(lock, old, old);
  expect(await withArtifactLock(
    lock,
    async () => "recovered",
    { timeoutMs: 100, staleMs: 5, pollMs: 2 },
  )).toBe("recovered");
});

test("staged publication restores the previous complete artifact on failure", () => {
  const base = mkdtempSync(join(tmpdir(), "dreamcart-publish-"));
  temporaryDirectories.push(base);
  const live = join(base, "live");
  mkdirSync(join(live, "nested-stage"), { recursive: true });
  writeFileSync(join(live, "receipt"), "old-complete");
  writeFileSync(join(live, "nested-stage", "receipt"), "new-complete");
  expect(() => publishStagedDirectory(join(live, "nested-stage"), live)).toThrow();
  expect(readFileSync(join(live, "receipt"), "utf8")).toBe("old-complete");

  const staging = join(base, "staging");
  mkdirSync(staging);
  writeFileSync(join(staging, "receipt"), "new-complete");
  publishStagedDirectory(staging, live);
  expect(readFileSync(join(live, "receipt"), "utf8")).toBe("new-complete");
});
