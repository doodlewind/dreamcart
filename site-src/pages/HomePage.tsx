/**
 * HomePage — the marketing home: hero (slogan) + deep #engine section + platforms
 * + games showcase. Uses ONLY the foundation Layout + tokens (no raw colors); all
 * structure styled via classes/tokens in styles/base.ts so every theme inherits it.
 *
 * Keep <Layout active="engine"> and the id="engine" anchor (nav links to /#engine).
 * Build picks it up via web/site-src/entries/home.tsx -> route "/".
 *
 * Every engine/platform claim here is verified against README.md, docs/, and
 * framework/src — do not overclaim.
 */
import { Layout, Button } from "../components";

/** A capability tile in the engine grid. */
function Feat({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="feat">
      <h3>
        <span className="feat-ic" aria-hidden="true">{icon}</span>
        {title}
      </h3>
      <p>{children}</p>
    </div>
  );
}

const PLATFORMS: {
  name: string; host: string; gfx2d: string; gfx3d: string; status: string;
}[] = [
  { name: "PSP", host: "Rust (rust-psp) + QuickJS", gfx2d: "sceGu", gfx3d: "sceGu + sceGum", status: "Runs (PPSSPP + hardware)" },
  { name: "Web", host: "Canvas + requestAnimationFrame", gfx2d: "Canvas2D", gfx3d: "WebGL2", status: "Runs (this Playground)" },
  { name: "3DS", host: "C (libctru) + QuickJS", gfx2d: "citro2d", gfx3d: "citro3d", status: "Runs (Azahar / hardware)" },
  { name: "Android", host: "Kotlin + WebView (web engine)", gfx2d: "Canvas2D", gfx3d: "WebGL2", status: "Runs (dual-screen handheld)" },
];

const GAMES: { file: string; name: string; tag: string; glyph: string; kind: string }[] = [
  { file: "snake", name: "Snake", tag: "Raw demo — the bare gfx/frame contract", glyph: "🐍", kind: "2D" },
  { file: "rpg", name: "Wuxia Village", tag: "Jin-Yong story RPG — scene tree, tilemap, dialogue", glyph: "🏯", kind: "RPG" },
  { file: "skin3d", name: "Skinned Fox", tag: "glTF hardware skinning + native animation sampler", glyph: "🦊", kind: "3D" },
  { file: "racing3d", name: "Racing 3D", tag: "Textured track, batched 3D draw list", glyph: "🏎️", kind: "3D" },
  { file: "fps3d", name: "FPS 3D", tag: "First-person movement on the g3d contract", glyph: "🔫", kind: "3D" },
  { file: "bsp3d", name: "BSP Map", tag: "Imported GoldSrc / CS1.6 BSP v30 world", glyph: "🗺️", kind: "3D" },
  { file: "outdoor3d", name: "Outdoor 3D", tag: "Retained native scene — cull + draw in Rust", glyph: "⛰️", kind: "3D" },
  { file: "maze", name: "Maze", tag: "Procedural framework game", glyph: "🌀", kind: "2D" },
  { file: "tetris", name: "Tetris", tag: "Raw demo — rotate, drop, line clears", glyph: "🧱", kind: "2D" },
];

export function HomePage() {
  return (
    <Layout active="engine">
      {/* ── 1. HERO ─────────────────────────────────────────────────────── */}
      <section data-part="hero">
        <div className="container">
          <div className="hero-cart">
            <img className="hero-cart-chip" src="/logo.png" alt="" aria-hidden="true" />
            <span className="hero-cart-word">DreamCart</span>
          </div>
          <p className="eyebrow">Isomorphic game runtime</p>
          <h1>
            Self-contained game cartridges
            <br />
            for <span className="accent">tiny worlds</span>
          </h1>
          <p className="lede">
            Write a game once in plain JavaScript and run it unchanged on a Sony
            PSP, the Web, a Nintendo 3DS, and an Android handheld —
            powered by QuickJS on hardware with as little as 32&nbsp;MB of RAM.
          </p>
          <div style={{ display: "flex", gap: 12, marginTop: 28, flexWrap: "wrap" }}>
            <Button href="/play/" variant="primary">
              Open the Playground →
            </Button>
            <Button href="/docs/" variant="default">
              Read the docs
            </Button>
          </div>
          <div className="hero-stats">
            <div className="hero-stat"><b>4</b><span>target platforms</span></div>
            <div className="hero-stat"><b>1</b><span>game source file</span></div>
            <div className="hero-stat"><b>32&nbsp;MB</b><span>minimum RAM</span></div>
            <div className="hero-stat"><b>60</b><span>frames / second</span></div>
          </div>
        </div>
      </section>

      {/* ── 2. ENGINE ───────────────────────────────────────────────────── */}
      <section id="engine" className="section section--elev">
        <div className="container">
          <p className="eyebrow">The engine</p>
          <h2>One tiny native contract, every platform</h2>
          <p className="lede">
            Each platform implements the <em>same</em> minimal native contract, so
            the JavaScript above it never changes. Logic, scene, physics and math
            live in shared JS; only the thin rendering layer is native per platform.
          </p>

          {/* The contract layers */}
          <div className="contract">
            <div className="contract-row">
              <div className="contract-tier">2D contract<span>required</span></div>
              <div className="contract-api">
                <code>gfx.clear(r,g,b)</code> · <code>gfx.fillRect(x,y,w,h,r,g,b)</code> ·{" "}
                <code>log(msg)</code> · your <code>frame(buttons)</code> called ~60×/sec
                with a fixed controller bitmask.
              </div>
            </div>
            <div className="contract-row">
              <div className="contract-tier">g3d contract<span>optional</span></div>
              <div className="contract-api">
                Hardware-accelerated 3D the same way — meshes uploaded once, then one
                batched draw list per frame. A native engine per platform (sceGu/sceGum,
                WebGL2, citro3d).
              </div>
            </div>
            <div className="contract-row">
              <div className="contract-tier">Framework SDK<span>opt-in JS</span></div>
              <div className="contract-api">
                A TypeScript-authored SDK layered on top — games stay plain JS but get
                full editor/CI type-checking via <code>@ts-check</code> + JSDoc.
              </div>
            </div>
          </div>

          {/* Capability grid */}
          <div className="feat-grid">
            <Feat icon="🔁" title="Truly isomorphic">
              The identical bundled <code>.js</code> runs on PSP, Web, 3DS and
              Android. Golden tests render each game headlessly and byte-compare the
              framebuffer, so shared code can't silently regress.
            </Feat>
            <Feat icon="⚡" title="QuickJS, full modern JS">
              Modern JavaScript on tiny hardware via QuickJS — running on a PSP with
              as little as 32&nbsp;MB RAM, allocating through the platform allocator.
            </Feat>
            <Feat icon="🧩" title="Framework SDK">
              A Scene/Node tree with <code>update</code>/<code>draw</code>, the game
              loop, edge-detecting Input, seeded deterministic Rng, Graphics, palette
              Bitmaps, TileMap with camera, DialogueBox, a shared CharController with an
              analog input contract, ActionMap, and data-driven scenes.
            </Feat>
            <Feat icon="🎬" title="Hardware-accelerated 3D">
              The g3d layer adds Scene3D, meshes, materials, lighting and textures —
              upload once, draw a batched list per frame on the GPU.
            </Feat>
            <Feat icon="🦊" title="glTF hardware skinning">
              Skinned, animated glTF models with a native animation sampler — the
              animated Fox went from 6→30 FPS with HW skinning, 30→60 with native sampling.
            </Feat>
            <Feat icon="🚀" title="Retained native scene">
              The key PSP perf unlock: cull and draw a retained scene in Rust instead of
              walking every node from interpreted JS each frame.
            </Feat>
            <Feat icon="🗺️" title="World import">
              Import GoldSrc / Half-Life / CS1.6 BSP v30 maps — parsed and baked into
              textured, frustum-culled, walkable scenes.
            </Feat>
            <Feat icon="📦" title="Baked .dcpak assets">
              Assets — fonts, sprites, glTF, scenes, BSP — bake into a binary
              <code> .dcpak</code> container, replacing base64-in-JS that slowed QuickJS boot.
            </Feat>
            <Feat icon="🧠" title="Memory-aware runtime">
              A segregated O(1) arena allocator fixed PSP kernel-object exhaustion that
              crashed large 3D games; ships with a PSP performance field guide.
            </Feat>
          </div>
        </div>
      </section>

      {/* ── 3. PLATFORMS ────────────────────────────────────────────────── */}
      <section className="section">
        <div className="container">
          <p className="eyebrow">Targets</p>
          <h2>Four hosts, one game</h2>
          <p className="lede">
            Every target binds the same contract to its own host and graphics stack.
          </p>
          <div className="platform-grid">
            {PLATFORMS.map((p) => (
              <div className="platform" key={p.name}>
                <h3>{p.name}</h3>
                <p className="platform-host">{p.host}</p>
                <dl>
                  <dt>2D</dt><dd>{p.gfx2d}</dd>
                  <dt>3D</dt><dd>{p.gfx3d}</dd>
                  <dt>Status</dt><dd>{p.status}</dd>
                </dl>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 4. GAMES SHOWCASE ───────────────────────────────────────────── */}
      <section className="section section--elev">
        <div className="container">
          <p className="eyebrow">Showcase</p>
          <h2>Cartridges to play right now</h2>
          <p className="lede">
            Raw demos that exercise the bare contract, framework games, and 3D scenes —
            all running in the browser Playground on the same engine that targets the PSP.
          </p>
          <div className="game-grid">
            {GAMES.map((g) => (
              <a className="game-card" key={g.file} href={`/play/?game=${g.file}`}>
                <div className="game-screen">
                  <span className="game-kind">{g.kind}</span>
                  <span className="game-glyph" aria-hidden="true">{g.glyph}</span>
                </div>
                <span className="game-name">{g.name}</span>
                <span className="game-tag">{g.tag}</span>
              </a>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 30, flexWrap: "wrap" }}>
            <Button href="/play/" variant="primary">Open the Playground →</Button>
            <Button href="/docs/" variant="default">How it works</Button>
          </div>
        </div>
      </section>
    </Layout>
  );
}
