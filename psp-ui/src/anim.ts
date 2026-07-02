// Typed animation API over ops.animate — JS declares motion once, the Rust
// core ticks it per vblank at fixed dt = 1/60 s (byte-exact goldens [R]).
//
// Prop names are the spec PROP keys (spec/spec.ts is plain TS and bundles
// fine); only ANIMATABLE props are accepted. Colors animate per ABGR channel
// natively — pass a packed u32 or a '#rrggbb' string.

import { animBit, ENUMS, PROP, type PropName } from "../spec/spec.ts";
import { encodePropValue, getOps } from "./host.ts";
import type { NodeMirror } from "./renderer.ts";

export type EasingName =
  | "linear"
  | "in"
  | "out"
  | "in-out"
  | "out-back"
  | "spring"
  | "spring-bouncy";

const EASING_BY_NAME: Record<EasingName, number> = {
  linear: ENUMS.Easing.Linear,
  in: ENUMS.Easing.EaseIn,
  out: ENUMS.Easing.EaseOut,
  "in-out": ENUMS.Easing.EaseInOut,
  "out-back": ENUMS.Easing.OutBack,
  spring: ENUMS.Easing.Spring,
  "spring-bouncy": ENUMS.Easing.SpringBouncy,
};

export interface AnimateOptions {
  /** Duration in ms (default 200). Ignored by spring easings (physics). */
  dur?: number;
  /** Easing name or a raw ENUMS.Easing ordinal (default "out"). */
  easing?: EasingName | number;
  /** Delay in ms before the tween starts (default 0). */
  delay?: number;
}

function nodeId(node: NodeMirror | number): number {
  return typeof node === "number" ? node : node.id;
}

function animatablePropId(prop: PropName): number {
  const propId = PROP[prop];
  if (propId === undefined) {
    throw new Error(`psp-ui: unknown prop '${prop}'`);
  }
  if (animBit(prop) < 0) {
    throw new Error(`psp-ui: prop '${prop}' is not animatable (see spec ANIMATABLE)`);
  }
  return propId;
}

/**
 * Tween a node prop from its CURRENT value to `to`. Returns the animId
 * (cancelAnim). `to` for color props: packed u32 ABGR or '#rrggbb[aa]'.
 */
export function animate(
  node: NodeMirror | number,
  prop: PropName,
  to: number | string,
  opts: AnimateOptions = {},
): number {
  const propId = animatablePropId(prop);
  let easing: number;
  if (typeof opts.easing === "number") {
    easing = opts.easing;
  } else {
    const named = EASING_BY_NAME[opts.easing ?? "out"];
    if (named === undefined) {
      throw new Error(`psp-ui: unknown easing '${opts.easing}'`);
    }
    easing = named;
  }
  return getOps().animate(
    nodeId(node),
    propId,
    encodePropValue(prop, to),
    opts.dur ?? 200,
    easing,
    opts.delay ?? 0,
  );
}

export type SpringPreset = "default" | "bouncy";

/** Spring a node prop to `to`; duration comes from the physics, not a timer. */
export function spring(
  node: NodeMirror | number,
  prop: PropName,
  to: number | string,
  preset: SpringPreset = "default",
): number {
  const propId = animatablePropId(prop);
  const easing =
    preset === "bouncy" ? ENUMS.Easing.SpringBouncy : ENUMS.Easing.Spring;
  return getOps().animate(nodeId(node), propId, encodePropValue(prop, to), 0, easing, 0);
}

/** Stop a running animation by the id animate()/spring() returned. */
export function cancelAnim(animId: number): void {
  getOps().cancelAnim(animId);
}
