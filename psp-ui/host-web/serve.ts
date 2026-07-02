// host-web/serve.ts — tiny static dev server for the browser host.
//
//   bun host-web/serve.ts            # http://127.0.0.1:8130
//   PORT=9000 bun host-web/serve.ts
//
// Serves host-web/ at /, dist/ at /dist/, plus a /demos JSON manifest
// (every dist/*.js bundle; `mounts` marks bundles that actually call
// render() and install globalThis.frame — i.e. the *-main entries).
// Dev-tool only: binds 127.0.0.1, no cache, no livereload (reload the page
// after `bun scripts/build.ts <demo>` / `bun scripts/wasm.ts`).

import { existsSync, readFileSync, readdirSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname; // psp-ui/
const HOST_DIR = ROOT + "host-web/";
const DIST_DIR = ROOT + "dist/";
const PORT = Number(process.env.PORT ?? 8130);

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  wasm: "application/wasm",
  png: "image/png",
  dcpak: "application/octet-stream",
};

function fileResponse(path: string): Response {
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const ext = path.slice(path.lastIndexOf(".") + 1);
  return new Response(Bun.file(path), {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}

function demoManifest(): { name: string; hasPak: boolean; mounts: boolean }[] {
  if (!existsSync(DIST_DIR)) return [];
  return readdirSync(DIST_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => {
      const name = f.slice(0, -3);
      // A mounting entry bundles src/index.ts, whose frame hookup goes
      // through installFrameHandler — cheap, reliable dev-tool heuristic.
      const src = readFileSync(DIST_DIR + f, "utf8");
      return {
        name,
        hasPak: existsSync(DIST_DIR + name + ".dcpak"),
        mounts: src.includes("installFrameHandler"),
      };
    });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req) {
    const path = new URL(req.url).pathname.replace(/\.\.+/g, ""); // no traversal
    if (path === "/" || path === "/index.html") return fileResponse(HOST_DIR + "index.html");
    if (path === "/demos") {
      return Response.json(demoManifest(), { headers: { "cache-control": "no-store" } });
    }
    if (path.startsWith("/dist/")) return fileResponse(DIST_DIR + path.slice("/dist/".length));
    return fileResponse(HOST_DIR + path.slice(1));
  },
});

console.log(`psp-ui host-web: http://127.0.0.1:${server.port}/  (demos: ${demoManifest().map((d) => d.name).join(", ") || "none — build one first"})`);
