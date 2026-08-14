/** Reasoning-vs-speed levels the grok CLI accepts on grok-4.6. */

export const REASONING_EFFORTS = [
  {
    id: "low",
    label: "Low",
    detail: "Faster replies, less deliberation.",
  },
  {
    id: "medium",
    label: "Medium",
    detail: "Standard implementation and testing.",
  },
  {
    id: "high",
    label: "High",
    detail: "More reasoning before it acts.",
  },
  {
    id: "xhigh",
    label: "Extra high",
    detail: "Highest effort. Slowest.",
  },
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]["id"];

/** Matches grok's `[models] default_reasoning_effort` so we do not
 *  change behavior until the user picks something else. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "xhigh";

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.some((level) => level.id === value);
}

export function resolveReasoningEffort(value: unknown): ReasoningEffort {
  return isReasoningEffort(value) ? value : DEFAULT_REASONING_EFFORT;
}

export function reasoningEffortInfo(value: unknown) {
  const id = resolveReasoningEffort(value);
  return REASONING_EFFORTS.find((level) => level.id === id)!;
}

/** Flag pair for a grok invocation. Always set, so the session's choice
 *  wins over ~/.grok/config.toml. */
export function reasoningEffortArgs(
  value: unknown,
): ["--reasoning-effort", ReasoningEffort] {
  return ["--reasoning-effort", resolveReasoningEffort(value)];
}
