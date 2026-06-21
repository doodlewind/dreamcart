// Local dev server for the DreamCart site. Builds the full static site into
// web/site/ (Home, Playground, Docs, Changelog) then serves it, resolving
// directory routes (e.g. /play/ -> /play/index.html) like Cloudflare Pages.
//   bun web/serve.ts            -> http://localhost:8123
//   PORT=3000 bun web/serve.ts
import { buildSite } from "./deploy-build.ts";

const SITE = new URL("./site/", import.meta.url).pathname;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  png: "image/png",
  json: "application/json",
  svg: "image/svg+xml",
  map: "application/json",
};

export async function startServer(port = Number(process.env.PORT ?? 8123)) {
  await buildSite();

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      let path = new URL(req.url).pathname;
      const safe = path.replace(/\.\.+/g, "").replace(/^\/+/, "");
      // Directory route -> index.html (Pages-style).
      let rel = safe;
      if (rel === "" || rel.endsWith("/")) rel += "index.html";
      let file = Bun.file(SITE + rel);
      if (!(await file.exists()) && !rel.includes(".")) {
        file = Bun.file(SITE + rel + "/index.html");
      }
      if (!(await file.exists())) return new Response("Not found: " + path, { status: 404 });
      const ext = file.name?.split(".").pop() ?? "";
      return new Response(file, {
        headers: { "content-type": TYPES[ext] ?? "application/octet-stream" },
      });
    },
  });

  console.log("DreamCart site -> http://localhost:" + server.port + "/");
  console.log("  Playground:    http://localhost:" + server.port + "/play/");
  console.log("  Docs:          http://localhost:" + server.port + "/docs/");
  return server;
}

if (import.meta.main) {
  await startServer();
  console.log("Press Ctrl-C to stop.");
}
