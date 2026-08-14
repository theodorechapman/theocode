import { expect, test } from "bun:test";
import {
  DEFAULT_REASONING_EFFORT,
  isReasoningEffort,
  reasoningEffortArgs,
  reasoningEffortInfo,
  resolveReasoningEffort,
} from "../src/theocode/reasoning";

test("xhigh is the default so unset sessions match grok config", () => {
  expect(DEFAULT_REASONING_EFFORT).toBe("xhigh");
  expect(resolveReasoningEffort(undefined)).toBe("xhigh");
  expect(resolveReasoningEffort("nope")).toBe("xhigh");
});

test("only the four grok-4.6 menu levels are accepted", () => {
  expect(isReasoningEffort("low")).toBe(true);
  expect(isReasoningEffort("medium")).toBe(true);
  expect(isReasoningEffort("high")).toBe(true);
  expect(isReasoningEffort("xhigh")).toBe(true);
  expect(isReasoningEffort("max")).toBe(false);
  expect(isReasoningEffort("none")).toBe(false);
});

test("invocations always pass --reasoning-effort so config.toml cannot override", () => {
  expect(reasoningEffortArgs(undefined)).toEqual([
    "--reasoning-effort",
    "xhigh",
  ]);
  expect(reasoningEffortArgs("low")).toEqual(["--reasoning-effort", "low"]);
});

test("info lookup falls back to extra high", () => {
  expect(reasoningEffortInfo("high").label).toBe("High");
  expect(reasoningEffortInfo(null).id).toBe("xhigh");
});
