import { expect, test } from "bun:test";
import { classifySubmodule } from "./submodule-state.ts";

test("an uninitialized submodule may be initialized", () => {
  expect(classifySubmodule(false, false, "", "abc")).toEqual({ kind: "uninitialized" });
});

test("a submodule at the pinned revision is ready", () => {
  expect(classifySubmodule(true, false, "abc", "abc")).toEqual({ kind: "ready" });
});

test("a dirty submodule is protected even when it is pinned", () => {
  expect(classifySubmodule(true, true, "abc", "abc")).toEqual({
    kind: "dirty",
    head: "abc",
    expected: "abc",
  });
});

test("a clean checkout on another revision is reported as diverged", () => {
  expect(classifySubmodule(true, false, "dev", "pinned")).toEqual({
    kind: "diverged",
    head: "dev",
    expected: "pinned",
  });
});
