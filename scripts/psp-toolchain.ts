import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";

export interface PspToolchainManifest {
  schemaVersion: 1;
  rust: { toolchain: string; components: string[] };
  rustPsp: { repository: string; rev: string };
  quickJsRs: { repository: string; rev: string };
  cargoPsp: { package: string; tools: string[]; cachePath: string };
  sdk: {
    repository: string;
    tag: string;
    asset: string;
    url: string;
    sha256: string;
    marker: string;
    receipt: string;
    cachePath: string;
  };
}

export const PSP_TOOLCHAIN = await Bun.file(
  new URL("../toolchains/psp.json", import.meta.url),
).json() as PspToolchainManifest;

if (PSP_TOOLCHAIN.schemaVersion !== 1) {
  throw new Error(`unsupported PSP toolchain manifest schema ${PSP_TOOLCHAIN.schemaVersion}`);
}

export const CARGO_PSP_RECEIPT = ".pocket-stack-cargo-psp.json";

export function cargoHostTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  if (platform === "darwin") return `${cpu}-apple-darwin`;
  if (platform === "linux") return `${cpu}-unknown-linux-gnu`;
  if (platform === "win32") return `${cpu}-pc-windows-msvc`;
  return `${cpu}-unknown-${platform}`;
}

export interface ArtifactLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
}

function uniqueSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
}

function lockOwner(lock: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as {
      token?: unknown;
      pid?: unknown;
      hostname?: unknown;
    };
    return typeof value.token === "string" && Number.isInteger(value.pid) &&
        typeof value.hostname === "string"
      ? { token: value.token, pid: value.pid as number, hostname: value.hostname }
      : undefined;
  } catch {
    return undefined;
  }
}

function sameOwner(left: LockOwner | undefined, right: LockOwner | undefined): boolean {
  return !!left && !!right && left.token === right.token && left.pid === right.pid &&
    left.hostname === right.hostname;
}

function ownerCanBeRecovered(owner: LockOwner | undefined): boolean {
  if (!owner) return true;
  if (owner.hostname !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Shared-cache lock with bounded waiting, heartbeat, and stale-owner recovery. */
export async function withArtifactLock<T>(
  lock: string,
  operation: () => Promise<T>,
  options: ArtifactLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const staleMs = options.staleMs ?? 30 * 60_000;
  const pollMs = options.pollMs ?? 100;
  const started = Date.now();
  const token = uniqueSuffix();
  mkdirSync(dirname(lock), { recursive: true });

  for (;;) {
    try {
      mkdirSync(lock);
      try {
        writeFileSync(
          join(lock, "owner.json"),
          JSON.stringify({
            token,
            pid: process.pid,
            hostname: hostname(),
            startedAt: new Date().toISOString(),
          }) + "\n",
        );
      } catch (error) {
        rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          const staleOwner = lockOwner(lock);
          const quarantine = `${lock}.stale-${uniqueSuffix()}`;
          if ((ownerCanBeRecovered(staleOwner) && sameOwner(staleOwner, lockOwner(lock))) ||
              (!staleOwner && !lockOwner(lock))) {
            renameSync(lock, quarantine);
            rmSync(quarantine, { recursive: true, force: true });
            continue;
          }
        }
      } catch {
        // Another waiter can recover the same stale lock; retry until timeout.
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`timed out waiting for artifact lock ${lock}`);
      }
      await Bun.sleep(pollMs);
    }
  }

  const heartbeatMs = Math.max(10, Math.min(30_000, Math.floor(staleMs / 3)));
  const heartbeat = setInterval(() => {
    if (lockOwner(lock)?.token !== token) return;
    const now = new Date();
    try {
      utimesSync(lock, now, now);
    } catch {}
  }, heartbeatMs);
  heartbeat.unref?.();

  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    if (lockOwner(lock)?.token === token) rmSync(lock, { recursive: true, force: true });
  }
}

/** Publish a complete staged directory; installers never write into the live root. */
export function publishStagedDirectory(staging: string, destination: string): void {
  if (!existsSync(staging)) throw new Error(`staged artifact is missing: ${staging}`);
  mkdirSync(dirname(destination), { recursive: true });
  const previous = `${destination}.previous-${uniqueSuffix()}`;
  const hadPrevious = existsSync(destination);
  if (hadPrevious) renameSync(destination, previous);
  try {
    renameSync(staging, destination);
  } catch (error) {
    if (hadPrevious && existsSync(previous) && !existsSync(destination)) {
      renameSync(previous, destination);
    }
    throw error;
  }
  if (hadPrevious) rmSync(previous, { recursive: true, force: true });
}

export interface PspToolchainPaths {
  cacheRoot: string;
  sdkRoot: string;
  sdkArchive: string;
  toolsBin: string;
  toolsRoot: string;
}

export function pocketStackCacheRoot(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  const explicit = env.POCKET_STACK_CACHE_DIR?.trim();
  if (explicit) return resolve(explicit);
  const cacheHome = env.XDG_CACHE_HOME?.trim() || join(home, ".cache");
  return resolve(cacheHome, "pocket-stack");
}

export function pspToolchainPaths(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): PspToolchainPaths {
  const cacheRoot = pocketStackCacheRoot(env, home);
  const toolsRoot = join(cacheRoot, PSP_TOOLCHAIN.cargoPsp.cachePath);
  return {
    cacheRoot,
    sdkRoot: join(cacheRoot, PSP_TOOLCHAIN.sdk.cachePath),
    sdkArchive: join(cacheRoot, `downloads/psp-sdk-${PSP_TOOLCHAIN.sdk.sha256}.zip`),
    toolsRoot,
    toolsBin: join(toolsRoot, "bin"),
  };
}

export type PspSdkSource = "PSP_SDK" | "PSPDEV" | "cache";

export interface ResolvedPspSdk {
  root: string;
  marker: string;
  source: PspSdkSource;
}

function pspSdkReceipt(root: string): string {
  return join(root, PSP_TOOLCHAIN.sdk.receipt);
}

function hasVerifiedCachedPspSdk(root: string): boolean {
  if (!existsSync(join(root, PSP_TOOLCHAIN.sdk.marker))) return false;
  try {
    const receipt = JSON.parse(readFileSync(pspSdkReceipt(root), "utf8")) as Record<string, unknown>;
    return receipt.tag === PSP_TOOLCHAIN.sdk.tag &&
      receipt.asset === PSP_TOOLCHAIN.sdk.asset &&
      receipt.url === PSP_TOOLCHAIN.sdk.url &&
      receipt.sha256 === PSP_TOOLCHAIN.sdk.sha256;
  } catch {
    return false;
  }
}

export function resolvePspSdk(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): ResolvedPspSdk {
  const override = env.PSP_SDK?.trim()
    ? { source: "PSP_SDK" as const, root: env.PSP_SDK.trim() }
    : env.PSPDEV?.trim()
      ? { source: "PSPDEV" as const, root: env.PSPDEV.trim() }
      : { source: "cache" as const, root: pspToolchainPaths(env, home).sdkRoot };
  const root = resolve(override.root);
  const marker = join(root, PSP_TOOLCHAIN.sdk.marker);
  const ready = override.source === "cache"
    ? hasVerifiedCachedPspSdk(root)
    : existsSync(marker);
  if (!ready) {
    const action = override.source === "cache"
      ? `run \`bun run bootstrap\` to install and verify it with ${PSP_TOOLCHAIN.sdk.receipt}`
      : `fix or unset ${override.source}`;
    const expectation = override.source === "cache"
      ? `${marker} and a matching ${pspSdkReceipt(root)}`
      : marker;
    throw new Error(
      `${override.source} PSP SDK is invalid: expected ${expectation}; ${action}`,
    );
  }
  return { root, marker, source: override.source };
}

export function pspBuildEnvironment(
  sdk: ResolvedPspSdk,
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): Record<string, string | undefined> {
  const toolsBin = pspToolchainPaths(env, home).toolsBin;
  return {
    ...env,
    PSP_SDK: sdk.root,
    PSPDEV: sdk.root,
    PATH: `${toolsBin}:${env.PATH ?? ""}`,
  };
}

export function requirePspTools(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  const paths = pspToolchainPaths(env, home);
  if (!hasPinnedPspTools(paths.toolsRoot)) {
    throw new Error(
      `PSP tools in ${paths.toolsBin} are missing, from the wrong revision, or for another host; ` +
        "run `bun run bootstrap`",
    );
  }
  return paths.toolsBin;
}

function hasPinnedCargoMetadata(root: string): boolean {
  const source =
    `git+${PSP_TOOLCHAIN.rustPsp.repository}?rev=${PSP_TOOLCHAIN.rustPsp.rev}#${PSP_TOOLCHAIN.rustPsp.rev}`;
  try {
    const metadata = JSON.parse(readFileSync(join(root, ".crates2.json"), "utf8")) as {
      installs?: Record<string, { bins?: unknown; target?: unknown }>;
    };
    return Object.entries(metadata.installs ?? {}).some(([id, install]) => {
      const bins = install.bins;
      return id.startsWith(`${PSP_TOOLCHAIN.cargoPsp.package} `) && id.includes(source) &&
        install.target === cargoHostTriple() && Array.isArray(bins) &&
        PSP_TOOLCHAIN.cargoPsp.tools.every((tool) => bins.includes(tool));
    });
  } catch {
    return false;
  }
}

function hasPinnedCargoReceipt(root: string): boolean {
  try {
    const receipt = JSON.parse(readFileSync(join(root, CARGO_PSP_RECEIPT), "utf8")) as {
      schemaVersion?: unknown;
      repository?: unknown;
      rev?: unknown;
      package?: unknown;
      tools?: unknown;
      host?: unknown;
    };
    const tools = receipt.tools;
    return receipt.schemaVersion === 1 &&
      receipt.repository === PSP_TOOLCHAIN.rustPsp.repository &&
      receipt.rev === PSP_TOOLCHAIN.rustPsp.rev &&
      receipt.package === PSP_TOOLCHAIN.cargoPsp.package &&
      receipt.host === cargoHostTriple() &&
      Array.isArray(tools) && tools.length === PSP_TOOLCHAIN.cargoPsp.tools.length &&
      PSP_TOOLCHAIN.cargoPsp.tools.every((tool) => tools.includes(tool));
  } catch {
    return false;
  }
}

export function hasPinnedPspTools(root: string): boolean {
  if (PSP_TOOLCHAIN.cargoPsp.tools.some((tool) => !existsSync(join(root, "bin", tool)))) {
    return false;
  }
  return hasPinnedCargoMetadata(root) || hasPinnedCargoReceipt(root);
}

export function writePinnedPspToolsReceipt(root: string): void {
  writeFileSync(join(root, CARGO_PSP_RECEIPT), JSON.stringify({
    schemaVersion: 1,
    repository: PSP_TOOLCHAIN.rustPsp.repository,
    rev: PSP_TOOLCHAIN.rustPsp.rev,
    package: PSP_TOOLCHAIN.cargoPsp.package,
    tools: PSP_TOOLCHAIN.cargoPsp.tools,
    host: cargoHostTriple(),
  }, null, 2) + "\n");
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifiedArchive(path: string): Promise<boolean> {
  return existsSync(path) && (await sha256(path)) === PSP_TOOLCHAIN.sdk.sha256;
}

export async function ensurePspSdk(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): Promise<{ sdk: ResolvedPspSdk; installed: boolean }> {
  if (env.PSP_SDK?.trim() || env.PSPDEV?.trim()) {
    return { sdk: resolvePspSdk(env, home), installed: false };
  }

  const paths = pspToolchainPaths(env, home);
  if (hasVerifiedCachedPspSdk(paths.sdkRoot)) {
    return { sdk: resolvePspSdk(env, home), installed: false };
  }

  mkdirSync(dirname(paths.sdkArchive), { recursive: true });
  await withArtifactLock(
    join(paths.cacheRoot, "psp", ".locks", `sdk-download-${PSP_TOOLCHAIN.sdk.sha256}.lock`),
    async () => {
      if (await verifiedArchive(paths.sdkArchive)) return;
      const temporaryArchive = `${paths.sdkArchive}.tmp-${uniqueSuffix()}`;
      rmSync(temporaryArchive, { force: true });
      try {
        const download = await $`curl -fL --retry 3 -o ${temporaryArchive} ${PSP_TOOLCHAIN.sdk.url}`.nothrow();
        if (download.exitCode !== 0) {
          throw new Error(`PSP SDK download failed from ${PSP_TOOLCHAIN.sdk.url}`);
        }
        if (!(await verifiedArchive(temporaryArchive))) {
          throw new Error(`PSP SDK checksum mismatch; expected ${PSP_TOOLCHAIN.sdk.sha256}`);
        }
        // Only a verified, complete archive is made visible to other processes.
        renameSync(temporaryArchive, paths.sdkArchive);
      } finally {
        rmSync(temporaryArchive, { force: true });
      }
    },
  );

  const installed = await withArtifactLock(
    join(paths.cacheRoot, "psp", ".locks", `sdk-${PSP_TOOLCHAIN.sdk.sha256}.lock`),
    async () => {
      if (hasVerifiedCachedPspSdk(paths.sdkRoot)) return false;
      const temporaryDir = `${paths.sdkRoot}.stage-${uniqueSuffix()}`;
      rmSync(temporaryDir, { recursive: true, force: true });
      mkdirSync(temporaryDir, { recursive: true });
      try {
        const extraction = await $`unzip -q -o ${paths.sdkArchive} -d ${temporaryDir}`.nothrow();
        if (extraction.exitCode !== 0) {
          throw new Error(`failed to extract PSP SDK archive ${paths.sdkArchive}`);
        }
        const extractedRoot = existsSync(join(temporaryDir, "mipsel-sony-psp", PSP_TOOLCHAIN.sdk.marker))
          ? join(temporaryDir, "mipsel-sony-psp")
          : existsSync(join(temporaryDir, PSP_TOOLCHAIN.sdk.marker))
            ? temporaryDir
            : undefined;
        if (!extractedRoot) {
          throw new Error(`PSP SDK archive is missing ${PSP_TOOLCHAIN.sdk.marker}`);
        }
        writeFileSync(
          pspSdkReceipt(extractedRoot),
          `${JSON.stringify({
            tag: PSP_TOOLCHAIN.sdk.tag,
            asset: PSP_TOOLCHAIN.sdk.asset,
            url: PSP_TOOLCHAIN.sdk.url,
            sha256: PSP_TOOLCHAIN.sdk.sha256,
          }, null, 2)}\n`,
        );
        publishStagedDirectory(extractedRoot, paths.sdkRoot);
        return true;
      } finally {
        rmSync(temporaryDir, { recursive: true, force: true });
      }
    },
  );
  return { sdk: resolvePspSdk(env, home), installed };
}
