// Input: button edge-detection + the focus manager.
//
// Focus model (v1, no layout access from JS [R]):
//   - Traversal order = DOCUMENT ORDER over the mirror tree, derived lazily
//     (a DFS per navigation press — cheap for UI-sized trees, always correct
//     after <For> reorders).
//   - DOWN/RIGHT → next focusable, UP/LEFT → previous (aliases; clamped at
//     the ends, no wrap).
//   - CIRCLE fires onPress of the focused node, bubbling up to the nearest
//     ancestor with a handler.
//   - Focus loss on removal [R]: next sibling subtree → previous sibling
//     subtree → nearest focusable ancestor → none. Computed BEFORE the mirror
//     unlink (renderer calls notifyDetached first).
//   - Every focus change calls ops.setFocus so the native core applies the
//     `focus:` style variant with zero further JS.

import { BTN } from "../spec/spec.ts";
import { getOps } from "./host.ts";
import type { NodeMirror } from "./renderer.ts";

let root: NodeMirror | null = null;
let focused: NodeMirror | null = null;
let prevButtons = 0;

/** Bind the focus manager to a mirror tree root (index.ts render()). */
export function setInputRoot(r: NodeMirror | null): void {
  root = r;
  focused = null;
  prevButtons = 0;
}

/** Tests: forget focus + edge state. */
export function resetInput(): void {
  setInputRoot(null);
}

// ---- registries (renderer setProperty dispatch targets) --------------------

export function registerPress(
  node: NodeMirror,
  fn: (() => void) | undefined | null,
): void {
  node.onPress = fn ?? undefined;
}

export function registerFocusable(node: NodeMirror, on: boolean): void {
  node.focusable = on;
  if (!on && focused === node) {
    focusNode(null);
  }
}

// ---- focus ------------------------------------------------------------------

/** Programmatic focus (also used internally). null clears. */
export function focusNode(node: NodeMirror | null): void {
  focused = node;
  getOps().setFocus(node ? node.id : 0);
}

export function getFocused(): NodeMirror | null {
  return focused;
}

function collectFocusables(node: NodeMirror, out: NodeMirror[]): void {
  if (node.focusable) out.push(node);
  for (let i = 0; i < node.children.length; i++) {
    collectFocusables(node.children[i], out);
  }
}

function focusables(): NodeMirror[] {
  const out: NodeMirror[] = [];
  if (root) collectFocusables(root, out);
  return out;
}

function moveFocus(dir: 1 | -1): void {
  const list = focusables();
  if (list.length === 0) {
    if (focused) focusNode(null);
    return;
  }
  const i = focused ? list.indexOf(focused) : -1;
  if (i < 0) {
    // Nothing (validly) focused: enter the order from the direction's end.
    focusNode(dir === 1 ? list[0] : list[list.length - 1]);
    return;
  }
  const j = i + dir;
  if (j < 0 || j >= list.length) return; // clamp at the ends
  focusNode(list[j]);
}

function firePress(): void {
  let n: NodeMirror | null = focused;
  while (n) {
    if (n.onPress) {
      n.onPress();
      return;
    }
    n = n.parent;
  }
}

// ---- removal repair [R] ------------------------------------------------------

function isWithin(node: NodeMirror, ancestor: NodeMirror): boolean {
  let n: NodeMirror | null = node;
  while (n) {
    if (n === ancestor) return true;
    n = n.parent;
  }
  return false;
}

function firstFocusable(node: NodeMirror): NodeMirror | null {
  if (node.focusable) return node;
  for (let i = 0; i < node.children.length; i++) {
    const f = firstFocusable(node.children[i]);
    if (f) return f;
  }
  return null;
}

/**
 * Called by the renderer's removeNode BEFORE the mirror unlink. If the focused
 * node is inside the removed subtree, refocus: next sibling subtree → previous
 * sibling subtree → nearest focusable ancestor → none.
 */
export function notifyDetached(node: NodeMirror): void {
  if (!focused || !isWithin(focused, node)) return;
  const parent = node.parent;
  if (parent) {
    const idx = parent.children.indexOf(node);
    for (let i = idx + 1; i < parent.children.length; i++) {
      const f = firstFocusable(parent.children[i]);
      if (f) {
        focusNode(f);
        return;
      }
    }
    for (let i = idx - 1; i >= 0; i--) {
      const f = firstFocusable(parent.children[i]);
      if (f) {
        focusNode(f);
        return;
      }
    }
    let a: NodeMirror | null = parent;
    while (a) {
      if (a.focusable) {
        focusNode(a);
        return;
      }
      a = a.parent;
    }
  }
  focusNode(null);
}

// ---- per-frame entry ----------------------------------------------------------

/**
 * Edge-detect the button bitmask (spec BTN) and run navigation/press. Called
 * once per frame from globalThis.frame (index.ts) before the renderer sweep.
 */
export function handleFrame(buttons: number): void {
  const pressed = buttons & ~prevButtons;
  prevButtons = buttons;
  if (pressed === 0) return;
  if (pressed & (BTN.DOWN | BTN.RIGHT)) moveFocus(1);
  if (pressed & (BTN.UP | BTN.LEFT)) moveFocus(-1);
  if (pressed & BTN.CIRCLE) firePress();
}
