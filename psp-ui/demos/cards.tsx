// demos/cards.tsx — "card carousel" showcase: three feature cards in a row,
// LEFT/RIGHT d-pad moves focus (native focus: variants lift + brighten the
// focused card — zero JS on focus change), CIRCLE flips a <Show> detail panel
// that fades in (mount transition) and springs up into place. Two slow
// gradient streaks drift behind everything (long native tweens started once
// on mount — deterministic fixed-dt, no per-frame JS).
//
// v1-aware design notes: no rounded corners/shadows (they don't render),
// focus emphasis = translate-y lift + bg/border color (never scale — glyphs
// don't scale), all text single-line, every class a FULL literal.

import { createSignal, onMount, Show } from "solid-js";
import { spring, animate } from "../src/anim.ts";
import type { NodeMirror } from "../src/renderer.ts";

interface Card {
  title: string;
  caption: string;
  detail: string;
  /** card body class (base + focus variants, per-accent border). */
  cls: string;
  /** gradient accent strip on the card. */
  strip: string;
  /** vertical accent bar in the detail panel. */
  bar: string;
}

const CARDS: Card[] = [
  {
    title: "Layout",
    caption: "Flexbox via Taffy",
    detail: "Rows, columns, gaps and insets — solved natively in Rust.",
    cls: "flex-col gap-1 p-3 w-[136] bg-slate-800 border-slate-700 translate-y-1 focus:bg-slate-700 focus:border-indigo-400 focus:translate-y-0 transition-all duration-150 ease-out",
    strip: "h-1 w-full bg-gradient-to-r from-indigo-400 to-indigo-600",
    bar: "w-1 h-7 bg-indigo-400",
  },
  {
    title: "Motion",
    caption: "Springs and tweens",
    detail: "Fixed-dt springs and tweens tick natively at 60 FPS.",
    cls: "flex-col gap-1 p-3 w-[136] bg-slate-800 border-slate-700 translate-y-1 focus:bg-slate-700 focus:border-emerald-400 focus:translate-y-0 transition-all duration-150 ease-out",
    strip: "h-1 w-full bg-gradient-to-r from-emerald-400 to-emerald-600",
    bar: "w-1 h-7 bg-emerald-400",
  },
  {
    title: "Input",
    caption: "D-pad and focus",
    detail: "Native focus variants respond before JS even wakes up.",
    cls: "flex-col gap-1 p-3 w-[136] bg-slate-800 border-slate-700 translate-y-1 focus:bg-slate-700 focus:border-amber-400 focus:translate-y-0 transition-all duration-150 ease-out",
    strip: "h-1 w-full bg-gradient-to-r from-amber-400 to-amber-600",
    bar: "w-1 h-7 bg-amber-400",
  },
];

/** Detail panel — remounts (keyed <Show>) per card, so the mount fade
 *  (transition-opacity) and the translate-y spring replay on every open. */
function Detail(props: { card: Card }) {
  let el: NodeMirror | undefined;
  onMount(() => {
    if (el) spring(el, "translateY", 0);
  });
  return (
    <view
      ref={el}
      style={{ translateY: 22 }}
      class="flex-row items-center gap-3 p-3 bg-slate-800 border-slate-600 transition-colors duration-200 ease-out"
    >
      <view class={props.card.bar} />
      <view class="flex-col gap-1">
        <text class="text-sm text-white font-bold">{props.card.title}</text>
        <text class="text-xs text-slate-400">{props.card.detail}</text>
      </view>
    </view>
  );
}

export default function Cards() {
  const [open, setOpen] = createSignal(-1);
  const selected = () => (open() >= 0 ? CARDS[open()] : undefined);

  let streakA: NodeMirror | undefined;
  let streakB: NodeMirror | undefined;
  onMount(() => {
    // Slow ambient drift: one long linear tween each, declared once — the
    // Rust core owns the motion from here (zero steady-state JS).
    if (streakA) animate(streakA, "translateX", 300, { dur: 20000, easing: "linear" });
    if (streakB) animate(streakB, "translateX", -260, { dur: 26000, easing: "linear" });
  });

  return (
    <view class="relative flex-col w-full h-full p-4 gap-3 bg-slate-900 overflow-hidden">
      <view
        ref={streakA}
        class="absolute left-0 top-[58] w-64 h-1 opacity-50 bg-gradient-to-r from-indigo-500 to-transparent"
        style={{ translateX: 24 }}
      />
      <view
        ref={streakB}
        class="absolute left-[210] top-[246] w-56 h-1 opacity-40 bg-gradient-to-l from-fuchsia-500 to-transparent"
        style={{ translateX: 0 }}
      />

      <view class="flex-row items-end justify-between">
        <view class="flex-col">
          <text class="text-xs text-indigo-300 tracking-wide">PSP-UI SHOWCASE</text>
          <text class="text-2xl text-white font-bold">Feature Cards</text>
        </view>
        <text class="text-xs text-slate-500">3 MODULES</text>
      </view>

      <view class="flex-row gap-3">
        {CARDS.map((card, i) => (
          <view
            class={card.cls}
            focusable
            onPress={() => setOpen(open() === i ? -1 : i)}
          >
            <view class={card.strip} />
            <text class="text-sm text-white font-bold">{card.title}</text>
            <text class="text-xs text-slate-400">{card.caption}</text>
          </view>
        ))}
      </view>

      <view class="grow flex-col">
        <Show when={selected()} keyed>
          {(card) => <Detail card={card} />}
        </Show>
      </view>

      <text class="text-xs text-slate-500">LEFT / RIGHT move focus · CIRCLE toggle details</text>
    </view>
  );
}
