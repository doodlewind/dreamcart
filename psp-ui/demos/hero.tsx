// Demo app + the jsx.d.ts typecheck fixture (bunx tsc --noEmit must pass).
// Uses all three intrinsics, class literals, a dynamic style object, focus +
// onPress, and a signal in text — the exact surface phase v1 supports.

import { createSignal, onMount, Show } from "solid-js";
import { animate } from "../src/anim.ts";
import type { NodeMirror } from "../src/renderer.ts";

function Stat(props: { label: string; value: string; cls: string }) {
  return (
    <view class="flex-col items-end">
      <text class={props.cls}>{props.value}</text>
      <text class="text-xs text-slate-500 tracking-wide">{props.label}</text>
    </view>
  );
}

export default function Hero() {
  const [count, setCount] = createSignal(0);
  let underline: NodeMirror | undefined;
  onMount(() => {
    // Underline sweeps in once on mount — native tween, zero steady-state JS.
    if (underline) animate(underline, "width", 210, { dur: 700, easing: "out", delay: 150 });
  });
  return (
    <view class="w-full h-full flex-col justify-between p-5 bg-gradient-to-b from-slate-900 to-slate-950">
      <view class="flex-row items-center justify-between">
        <view class="flex-row items-center gap-3">
          <image class="w-10 h-10" src="logo.png" />
          <view class="flex-col">
            <text class="text-base text-white font-bold tracking-wide">psp-ui</text>
            <text class="text-xs text-slate-500 tracking-wide">SOLID + RUST + SCEGU</text>
          </view>
        </view>
        <view class="flex-row gap-4">
          <Stat label="FPS" value="60" cls="text-lg text-emerald-300 font-bold" />
          <Stat label="NODES" value="42" cls="text-lg text-indigo-300 font-bold" />
          <Stat label="DRAWS" value="9" cls="text-lg text-amber-300 font-bold" />
        </view>
      </view>

      <view class="flex-col gap-2">
        <text class="text-xs text-indigo-300 tracking-wide">ONE RUST CORE · ONE JSX APP</text>
        <text class="text-4xl text-white font-bold">JSX at 60 FPS.</text>
        <view
          ref={underline}
          class="h-1 w-0 bg-gradient-to-r from-indigo-400 to-fuchsia-500"
          style={{ translateX: count() * 2 }}
        />
        <text class="text-sm text-slate-300">
          Flexbox, springs and baked type — running on a 2005 handheld.
        </text>
      </view>

      <view class="flex-row items-center gap-4">
        <view
          class="px-4 py-2 bg-indigo-500 border-indigo-300 focus:bg-indigo-300 active:bg-indigo-200 transition-colors duration-150"
          focusable
          onPress={() => setCount(count() + 1)}
        >
          <text class="text-base text-white font-bold">Press Circle</text>
        </view>
        <text class="text-sm text-slate-400">Count: {count()}</text>
        <Show when={count() > 3}>
          <text class="text-sm text-emerald-400">Reactive on real hardware.</text>
        </Show>
      </view>
    </view>
  );
}
