export type SubmoduleState =
  | { kind: "uninitialized" }
  | { kind: "ready" }
  | { kind: "dirty"; head: string; expected: string }
  | { kind: "diverged"; head: string; expected: string };

export function classifySubmodule(
  initialized: boolean,
  dirty: boolean,
  head: string,
  expected: string,
): SubmoduleState {
  if (!initialized) return { kind: "uninitialized" };
  if (dirty) return { kind: "dirty", head, expected };
  if (head !== expected) return { kind: "diverged", head, expected };
  return { kind: "ready" };
}
