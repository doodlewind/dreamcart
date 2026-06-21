// Tiny static reference server for the BSP ground-truth harness (decoupled from the
// site dev server, which now serves only the built web/site/). It serves:
//   /headless.html        -> framework/test/bsp-compare/headless.html (this dir)
//   /engine.js            -> web/engine.js (the vanilla web runtime)
//   /games.generated.js   -> web/games.generated.js (window.GAMES bundle)
// Used by webgl-shoot.ts and seq-capture.ts to drive headless Chrome.
//   PORT=8199 bun framework/test/bsp-compare/ref-server.ts
const here = new URL('.', import.meta.url).pathname;
const root = here + '../../../';

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
};

// Map served paths to real files on disk.
function resolve(path: string): string | null {
  if (path === '/' || path === '/headless.html') return here + 'headless.html';
  if (path === '/engine.js') return root + 'web/engine.js';
  if (path === '/games.generated.js') return root + 'web/games.generated.js';
  return null;
}

export function startRefServer(port = Number(process.env.PORT ?? 8199)) {
  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const file = resolve(path);
      if (!file) return new Response('Not found: ' + path, { status: 404 });
      const f = Bun.file(file);
      if (!(await f.exists())) return new Response('Missing: ' + file, { status: 404 });
      const ext = file.split('.').pop() ?? '';
      return new Response(f, { headers: { 'content-type': TYPES[ext] ?? 'application/octet-stream' } });
    },
  });
}

if (import.meta.main) {
  const s = startRefServer();
  console.log('bsp-compare reference server -> http://127.0.0.1:' + s.port + '/headless.html');
}
