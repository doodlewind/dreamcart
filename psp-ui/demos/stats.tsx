// demos/stats.tsx — "animated dashboard" showcase: three stat tiles whose
// numbers count up over the first ~1.2 s, horizontal bars that grow to their
// value with a staggered ease-out (native width tweens declared once on
// mount), and UP/DOWN switching two tabs (<Show> panels with mount fades).
//
// Frame driving: statsFrame(buttons) is called once per frame by the
// stats-main entry (it wraps globalThis.frame). It edge-detects UP/DOWN for
// the tab switch and steps a frame-counter signal that the count-up memo
// derives from — CAPPED at COUNT_FRAMES, so after ~1.2 s the signal stops
// changing and steady-state JS work is zero. Content stays a pure function
// of the frame index (byte-exact goldens).

import { createMemo, createSignal, onMount, Show } from "solid-js";
import { animate, spring } from "../src/anim.ts";
import { BTN } from "../spec/spec.ts";
import type { NodeMirror } from "../src/renderer.ts";

// ---------------------------------------------------------------------------
// Frame driver (wired by stats-main.tsx)
// ---------------------------------------------------------------------------

const COUNT_FRAMES = 75;
const [frameN, setFrameN] = createSignal(0);
const [tab, setTab] = createSignal(0);
let prevButtons = 0;

/** Once per frame, BEFORE the engine's own handler (stats-main wraps frame). */
export function statsFrame(buttons: number): void {
  const pressed = buttons & ~prevButtons;
  prevButtons = buttons;
  if (pressed & BTN.DOWN) setTab(1);
  if (pressed & BTN.UP) setTab(0);
  if (frameN() < COUNT_FRAMES) setFrameN(frameN() + 1); // settles, then silence
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface Stat {
  label: string;
  target: number;
  delta: string;
  valueCls: string;
}

const STATS: Stat[] = [
  { label: "PLAYERS ONLINE", target: 12480, delta: "+318", valueCls: "text-2xl text-indigo-300 font-bold" },
  { label: "SESSIONS TODAY", target: 3642, delta: "+9%", valueCls: "text-2xl text-emerald-300 font-bold" },
  { label: "DRAW CALLS", target: 268, delta: "-12", valueCls: "text-2xl text-amber-300 font-bold" },
];

interface Bar {
  label: string;
  pct: number; // 0..100
  fill: string;
}

const BAR_W = 280; // track px — fill animates to pct/100 * BAR_W

const BARS: Bar[] = [
  { label: "CPU", pct: 42, fill: "h-2 w-0 bg-gradient-to-r from-indigo-400 to-indigo-600 transition-colors duration-200 ease-out" },
  { label: "GPU", pct: 71, fill: "h-2 w-0 bg-gradient-to-r from-emerald-400 to-emerald-600 transition-colors duration-200 ease-out" },
  { label: "RAM", pct: 63, fill: "h-2 w-0 bg-gradient-to-r from-amber-400 to-amber-600 transition-colors duration-200 ease-out" },
  { label: "I/O", pct: 28, fill: "h-2 w-0 bg-gradient-to-r from-sky-400 to-sky-600 transition-colors duration-200 ease-out" },
];

interface Sys {
  name: string;
  status: string;
  led: string;
  statusCls: string;
}

const SYSTEMS: Sys[] = [
  { name: "GE PIPELINE", status: "ONLINE", led: "w-2 h-2 bg-emerald-400", statusCls: "text-xs text-emerald-400" },
  { name: "AUDIO MIXER", status: "ONLINE", led: "w-2 h-2 bg-emerald-400", statusCls: "text-xs text-emerald-400" },
  { name: "MEMORY ARENA", status: "87% USED", led: "w-2 h-2 bg-amber-400", statusCls: "text-xs text-amber-400" },
  { name: "WIFI LINK", status: "ONLINE", led: "w-2 h-2 bg-emerald-400", statusCls: "text-xs text-emerald-400" },
];

function fmt(n: number): string {
  const s = String(n);
  return s.length > 3 ? s.slice(0, -3) + "," + s.slice(-3) : s;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/** OVERVIEW tab: bars grow to their value with staggered native ease-out
 *  width tweens — remounting the tab replays the whole choreography. */
function Overview() {
  const fills: (NodeMirror | undefined)[] = [];
  onMount(() => {
    BARS.forEach((bar, i) => {
      const el = fills[i];
      if (el) {
        animate(el, "width", (bar.pct / 100) * BAR_W, {
          dur: 600,
          easing: "out",
          delay: i * 90,
        });
      }
    });
  });
  return (
    <view class="flex-col gap-1">
      {BARS.map((bar, i) => (
        <view class="flex-row items-center gap-2">
          <view class="w-9 flex-row justify-end">
            <text class="text-xs text-slate-400">{bar.label}</text>
          </view>
          <view class="w-[280] h-2 bg-slate-800 transition-colors duration-200 ease-out">
            <view ref={fills[i]} class={bar.fill} />
          </view>
          <text class="text-xs text-slate-500">{bar.pct + "%"}</text>
        </view>
      ))}
    </view>
  );
}

/** SYSTEMS tab: status board (square LEDs — v1 renders no rounded corners).
 *  Slides up on mount (spring) while the row backgrounds fade in natively. */
function Systems() {
  let el: NodeMirror | undefined;
  onMount(() => {
    if (el) spring(el, "translateY", 0);
  });
  return (
    <view ref={el} style={{ translateY: 16 }} class="flex-col gap-1">
      {SYSTEMS.map((sys) => (
        <view class="flex-row items-center justify-between px-2 py-[2] bg-slate-800 transition-colors duration-200 ease-out">
          <view class="flex-row items-center gap-2">
            <view class={sys.led} />
            <text class="text-xs text-slate-300 tracking-wide">{sys.name}</text>
          </view>
          <text class={sys.statusCls}>{sys.status}</text>
        </view>
      ))}
    </view>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function Stats() {
  // Count-up: eased share of the capped frame counter — pure per-frame math,
  // silent once frameN stops at COUNT_FRAMES.
  const t = createMemo(() => {
    const x = Math.min(1, frameN() / COUNT_FRAMES);
    return 1 - (1 - x) * (1 - x) * (1 - x); // ease-out cubic
  });

  return (
    <view class="flex-col w-full h-full p-4 gap-3 bg-gradient-to-b from-slate-900 to-slate-950">
      <view class="flex-row items-end justify-between">
        <view class="flex-col">
          <text class="text-xs text-emerald-300 tracking-wide">LIVE TELEMETRY</text>
          <text class="text-2xl text-white font-bold">Mission Control</text>
        </view>
        <view class="flex-row gap-2">
          <view
            class={
              tab() === 0
                ? "px-2 py-1 bg-indigo-600 border-indigo-400 transition-colors duration-150"
                : "px-2 py-1 bg-slate-800 border-slate-700 transition-colors duration-150"
            }
          >
            <text
              class={
                tab() === 0
                  ? "text-xs text-white font-bold tracking-wide"
                  : "text-xs text-slate-500 tracking-wide"
              }
            >
              OVERVIEW
            </text>
          </view>
          <view
            class={
              tab() === 1
                ? "px-2 py-1 bg-indigo-600 border-indigo-400 transition-colors duration-150"
                : "px-2 py-1 bg-slate-800 border-slate-700 transition-colors duration-150"
            }
          >
            <text
              class={
                tab() === 1
                  ? "text-xs text-white font-bold tracking-wide"
                  : "text-xs text-slate-500 tracking-wide"
              }
            >
              SYSTEMS
            </text>
          </view>
        </view>
      </view>

      <view class="flex-row gap-3">
        {STATS.map((stat) => (
          <view class="flex-1 flex-col gap-1 p-2 bg-slate-800 border-slate-700">
            <text class="text-xs text-slate-400 tracking-wide">{stat.label}</text>
            <view class="flex-row items-end gap-1">
              <text class={stat.valueCls}>{fmt(Math.round(stat.target * t()))}</text>
              <text class="text-xs text-emerald-400">{stat.delta}</text>
            </view>
          </view>
        ))}
      </view>

      <view class="grow flex-col">
        <Show when={tab() === 0}>
          <Overview />
        </Show>
        <Show when={tab() === 1}>
          <Systems />
        </Show>
      </view>

      <text class="text-xs text-slate-500">UP / DOWN switch tab</text>
    </view>
  );
}
