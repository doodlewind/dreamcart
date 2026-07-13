/**
 * PlayPage — the DreamCart Playground (route "/play/").
 *
 * Runs window.GAMES inside the headless, themeable ConsoleShell (a centered
 * handheld): desktop = horizontal PSP-like, mobile = vertical GBA-SP-like
 * (data-layout switched via a media query). The 480x272 PSP screen is a <canvas>
 * mounted into the shell's screen slot via window.DreamCart.mount.
 *
 * - Game picker over window.GAMES (sorted by .order). ?game=<file> deep-links.
 * - ConsoleShell button presses -> DreamCart.pressVirtual; keyboard is handled inside
 *   engine.js. FPS via DreamCart.onFps. Pause / Step / Reset transport controls.
 * - Code is HIDDEN by default. A "Code" button opens a Modal showing the JS source.
 *   Raw games: editable + Run (re-loads via DreamCart.load + start). Framework games:
 *   read-only. The log console (DreamCart.onLog) lives inside this modal.
 *
 * engine.js + games.generated.js are loaded as plain <script> tags by the build
 * (deploy-build.ts preScripts) BEFORE this bundle, so window.DreamCart / window.GAMES
 * exist by the time this component mounts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layout, Button, Modal, ConsoleShell, type ConsoleLayout } from "../components";

// Minimal typings for the globals engine.js / games.generated.js set.
interface DreamCartRuntime {
  W: number;
  H: number;
  BTN: Record<string, number>;
  mount(el: HTMLElement): void;
  load(js: string, dcpakBase64?: string): unknown;
  start(): void;
  stop(): void;
  setPaused(b: boolean): void;
  step(): void;
  pressVirtual(bit: number, down: boolean): void;
  isPaused(): boolean;
  onLog(cb: (msg: string) => void): void;
  onFps(cb: (fps: number) => void): void;
}
interface GameDef {
  title: string;
  order: number;
  controls: string;
  kind: "raw" | "fw";
  run: string;
  src: string;
  lang: string;
  dcpak: string;
}
declare global {
  interface Window {
    DreamCart?: DreamCartRuntime;
    GAMES?: Record<string, GameDef>;
  }
}

function useLayout(): ConsoleLayout {
  const [layout, setLayout] = useState<ConsoleLayout>("horizontal");
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const sync = () => setLayout(mq.matches ? "vertical" : "horizontal");
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return layout;
}

/** Normalize a game id for fuzzy ?game= matching: drop dir, raw- prefix, .js. */
function normGame(s: string): string {
  return s.replace(/^.*\//, "").replace(/\.js$/, "").replace(/^raw-/, "").toLowerCase();
}

/** First game by ?game= deep link (exact, then fuzzy), else lowest .order, else "". */
function pickInitial(games: Record<string, GameDef>, names: string[]): string {
  if (typeof window !== "undefined") {
    const q = new URLSearchParams(window.location.search).get("game");
    if (q) {
      if (games[q]) return q;
      const want = normGame(q);
      const hit = names.find((n) => normGame(n) === want);
      if (hit) return hit;
    }
  }
  return names[0] ?? "";
}

export function PlayPage() {
  const layout = useLayout();
  const screenRef = useRef<HTMLDivElement>(null);
  const booted = useRef(false);

  const [showSource, setShowSource] = useState(false);
  const [fps, setFps] = useState(0);
  const [paused, setPaused] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const games = useMemo(() => window.GAMES ?? {}, []);
  const gameNames = useMemo(
    () =>
      Object.keys(games).sort(
        (a, b) => games[a].order - games[b].order || a.localeCompare(b),
      ),
    [games],
  );
  const [current, setCurrent] = useState<string>(() => pickInitial(games, gameNames));
  const cur = current ? games[current] : undefined;

  // Editable source buffer for raw games (kept in sync when the game changes).
  const [draft, setDraft] = useState<string>("");
  useEffect(() => {
    setDraft(cur ? cur.run : "");
  }, [current, cur]);

  /** Load + run a game by manifest key, syncing transport state + the URL. */
  const loadGame = useCallback(
    (name: string, opts?: { push?: boolean }) => {
      const psp = window.DreamCart;
      const g = games[name];
      if (!psp || !g) return;
      setCurrent(name);
      setLogs([]);
      psp.load(g.run, g.dcpak || undefined);
      psp.start();
      setPaused(false);
      if (opts?.push && typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.set("game", name);
        window.history.replaceState(null, "", url);
      }
    },
    [games],
  );

  // One-time boot: mount the canvas + wire FPS/log sinks + run the initial game.
  useEffect(() => {
    const psp = window.DreamCart;
    if (!psp || !screenRef.current || booted.current) return;
    booted.current = true;

    const canvas = document.createElement("canvas");
    canvas.width = psp.W;
    canvas.height = psp.H;
    screenRef.current.appendChild(canvas);
    psp.mount(canvas);

    psp.onFps((f) => setFps(Math.round(f)));
    psp.onLog((msg) =>
      setLogs((prev) => {
        const next = prev.concat(msg);
        return next.length > 200 ? next.slice(next.length - 200) : next;
      }),
    );

    const first = current || gameNames[0];
    if (first) loadGame(first);
    return () => psp.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPress = useCallback((bit: number, down: boolean) => {
    window.DreamCart?.pressVirtual(bit, down);
  }, []);

  // ---- transport controls ----
  const togglePause = () => {
    const psp = window.DreamCart;
    if (!psp) return;
    const next = !paused;
    psp.setPaused(next);
    setPaused(next);
  };
  const stepOne = () => {
    const psp = window.DreamCart;
    if (!psp) return;
    psp.step();
    setPaused(true);
  };
  const reset = () => {
    if (current) loadGame(current);
  };

  // Run an edited raw-game source from the Code modal.
  const runDraft = () => {
    const psp = window.DreamCart;
    if (!psp || !cur || cur.kind !== "raw") return;
    setLogs([]);
    psp.load(draft, cur.dcpak || undefined);
    psp.start();
    setPaused(false);
  };

  const editable = cur?.kind === "raw";

  return (
    <Layout active="play" contained={false}>
      <section className="container play-intro">
        <p className="eyebrow">Playground</p>
        <h1 className="play-title">Run a cartridge</h1>
        <p className="lede">
          The same game <code>.js</code> that runs on a PSP, a 3DS and Android —
          running here in an on-screen handheld. Pick a cartridge, then drive it with
          the on-screen pad or your keyboard.
        </p>
      </section>

      {/* Toolbar: cartridge picker + live stats + transport + code button. */}
      <div className="container play-toolbar" data-part="play-toolbar">
        <label className="play-slot" data-part="play-slot">
          <span className="play-slot-label">Cartridge</span>
          <select
            data-part="play-select"
            value={current}
            onChange={(e) => loadGame(e.target.value, { push: true })}
            aria-label="Pick a game"
          >
            {gameNames.map((n) => (
              <option key={n} value={n}>
                {games[n].title}
                {games[n].kind === "raw" ? "  ·  raw API" : ""}
              </option>
            ))}
          </select>
        </label>

        <span className="badge play-fps" title="Frames per second">
          {fps} FPS
        </span>
        {cur && (
          <span className="play-controls-hint" data-part="play-hint">
            {cur.controls}
          </span>
        )}

        <div className="play-toolbar-spacer" />

        <div className="play-transport">
          <Button size="sm" onClick={togglePause}>
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" onClick={stepOne} disabled={!paused} title="Advance one frame">
            Step
          </Button>
          <Button size="sm" onClick={reset} title="Restart this game">
            Reset
          </Button>
          <Button size="sm" variant="primary" onClick={() => setShowSource(true)}>
            Code
          </Button>
        </div>
      </div>

      {/* The handheld stage. */}
      <div className="play-stage">
        <ConsoleShell
          layout={layout}
          onPress={onPress}
          brand={cur ? cur.title : "DreamCart"}
          screen={
            <div ref={screenRef} className="play-screen-mount" aria-label="Game screen" />
          }
        />
      </div>

      {/* Code / source — hidden by default; log console lives inside. */}
      <Modal
        open={showSource}
        onClose={() => setShowSource(false)}
        variant="drawer"
        title={
          cur
            ? `${cur.title} — ${editable ? "editable source" : "source (read-only)"}`
            : "Source"
        }
        headerExtra={
          editable ? (
            <Button size="sm" variant="primary" onClick={runDraft}>
              Run ▸
            </Button>
          ) : null
        }
      >
        {editable ? (
          <textarea
            data-part="source-editor"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // The engine registers bubble-phase keydown/keyup on window and
            // preventDefault()s every mapped game key (WASD, ZXCV, etc.). Stop the
            // event here so it never reaches that listener and the key types normally.
            onKeyDown={(e) => e.stopPropagation()}
            onKeyUp={(e) => e.stopPropagation()}
            aria-label="Editable game source"
          />
        ) : (
          <pre>
            <code>{cur?.src ?? "// pick a game"}</code>
          </pre>
        )}

        <div className="play-console-head">
          <span className="play-console-title">Console</span>
          {logs.length > 0 && (
            <button
              type="button"
              className="play-console-clear"
              onClick={() => setLogs([])}
            >
              clear
            </button>
          )}
        </div>
        <div data-part="console-log" aria-live="polite">
          {logs.length ? logs.join("\n") : "// log() output appears here"}
        </div>
      </Modal>
    </Layout>
  );
}
