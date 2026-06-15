// Bun.serve static server for the psp-js Playground.
//   bun web/serve.ts            -> http://localhost:8123
//   PORT=3000 bun web/serve.ts
// Regenerates web/games.generated.js on startup so the manifest is always fresh.
import { buildGames } from "./build-games.ts";

const ROOT = new URL(".", import.meta.url).pathname; // the web/ dir

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  png: "image/png",
  json: "application/json",
};

/** Build the manifest and start the static server. Returns the Bun server. */
export async function startServer(port = Number(process.env.PORT ?? 8123)) {
  const n = await buildGames();
  console.log("manifest: " + n + " games");

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      let path = new URL(req.url).pathname;
      if (path === "/") path = "/index.html";
      const safe = path.replace(/\.\.+/g, "").replace(/^\/+/, "");
      const file = Bun.file(ROOT + safe);
      if (!(await file.exists())) return new Response("Not found: " + path, { status: 404 });
      const ext = safe.split(".").pop() ?? "";
      return new Response(file, { headers: { "content-type": TYPES[ext] ?? "application/octet-stream" } });
    },
  });

  console.log("psp-js Playground -> http://localhost:" + server.port + "/");
  console.log("  pick a game:        http://localhost:" + server.port + "/?game=fw-rpg.js");
  return server;
}

if (import.meta.main) {
  await startServer();
  console.log("Press Ctrl-C to stop.");
}
