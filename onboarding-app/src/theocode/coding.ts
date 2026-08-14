import { randomUUID } from "node:crypto";
import type { SessionRef } from "./types";

// Coding subagents: fan-out over task cards.
//
// A card is a self-contained contract — the subagent sees the card and the
// repository, never the coordinator's transcript. `notes_for_merge` is the
// coordinator's private integration context: held back from the subagent,
// echoed back with the finished result (same release valve as research's
// `hypothesis`). Scope discipline is enforced by schema and corrective
// errors, not by hoping the coordinator writes restrained prose.

export const MAX_GOAL_CHARS = 200;
export const MAX_CARDS = 8;
export const DEFAULT_PARALLEL = 3;

export interface CodeCard {
  goal: string;
  spec: string;
  files_in_scope: string[];
  done_criteria: string[];
  /** Coordinator-private; never shown to the subagent. */
  notes_for_merge?: string;
}

export interface CodeTask {
  id: string;
  parentRef: SessionRef;
  /** Where the coordinator merges children into (its worktree, or the main checkout). */
  mergeTarget: { path: string; label: string | null };
  card: CodeCard;
  subRef?: SessionRef;
  wtLabel?: string;
  branch?: string;
  wtPath?: string;
  status: "queued" | "running" | "done" | "failed";
  result?: string;
  claimed: boolean;
  /** Concurrency cap shared by this batch's coordinator. */
  parallelLimit: number;
}

export const codeTasks = new Map<string, CodeTask>();

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === "string" && !!v.trim());
  return out.length === value.length && out.length > 0 ? out : null;
}

/** Validates the whole batch up front; throws corrective, teachable errors. */
export function validateCards(raw: unknown): CodeCard[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Provide cards: a non-empty array of task cards.");
  }
  if (raw.length > MAX_CARDS) {
    throw new Error(`Too many cards (${raw.length} > ${MAX_CARDS}). Batch the rest in a later call.`);
  }
  return raw.map((item, i) => {
    const at = `cards[${i}]`;
    const card = (item ?? {}) as Record<string, unknown>;
    const goal = typeof card.goal === "string" ? card.goal.trim() : "";
    if (!goal) throw new Error(`${at}: goal is required — one sentence.`);
    if (goal.length > MAX_GOAL_CHARS) {
      throw new Error(
        `${at}: goal too long (${goal.length} > ${MAX_GOAL_CHARS} chars). One sentence; details belong in spec.`,
      );
    }
    const spec = typeof card.spec === "string" ? card.spec.trim() : "";
    if (!spec) {
      throw new Error(
        `${at}: spec is required — the contract: what to build, interfaces to conform to, expected behavior.`,
      );
    }
    const files = asStringArray(card.files_in_scope);
    if (!files) {
      throw new Error(
        `${at}: files_in_scope is required — the paths this task may modify; everything else is read-only context.`,
      );
    }
    const done = asStringArray(card.done_criteria);
    if (!done) {
      throw new Error(
        `${at}: done_criteria is required — verifiable checks (commands to run, behavior to confirm).`,
      );
    }
    const notes =
      typeof card.notes_for_merge === "string" && card.notes_for_merge.trim()
        ? card.notes_for_merge.trim()
        : undefined;
    return { goal, spec, files_in_scope: files, done_criteria: done, notes_for_merge: notes };
  });
}

export function newCodeTask(
  parentRef: SessionRef,
  mergeTarget: { path: string; label: string | null },
  card: CodeCard,
  parallelLimit: number,
): CodeTask {
  const task: CodeTask = {
    id: randomUUID().slice(0, 8),
    parentRef,
    mergeTarget,
    card,
    status: "queued",
    claimed: false,
    parallelLimit,
  };
  codeTasks.set(task.id, task);
  return task;
}

/** What the subagent sees: the card and nothing else. */
export function coderPrompt(card: CodeCard): string {
  return [
    "You are implementing exactly one task card. Follow your coding rules.",
    "",
    `## Goal`,
    card.goal,
    "",
    `## Spec`,
    card.spec,
    "",
    `## Files in scope (the only paths you may modify)`,
    ...card.files_in_scope.map((f) => `- ${f}`),
    "",
    `## Done criteria (verify each before you finish)`,
    ...card.done_criteria.map((d) => `- ${d}`),
  ].join("\n");
}

/** Delivered to the COORDINATOR: result, held-back notes, merge playbook. */
export function codeResultText(task: CodeTask): string {
  const lines = [
    `[code task ${task.id} ${task.status === "failed" ? "FAILED" : "completed"}]`,
    `Goal: ${task.card.goal}`,
    `Worktree: ${task.wtLabel ?? "(none)"} · branch ${task.branch ?? "?"}`,
  ];
  if (task.card.notes_for_merge) {
    lines.push(
      `Your private merge notes (the subagent never saw these): ${task.card.notes_for_merge}`,
    );
  }
  lines.push(
    "",
    "Subagent report:",
    task.result ?? "(the subagent produced no final report)",
    "",
    "Merge playbook:",
    `1. cd ${task.mergeTarget.path}`,
    `2. git merge --no-ff ${task.branch}`,
    `3. Verify the done criteria yourself: ${task.card.done_criteria.join("; ")}`,
    `4. When merged and verified: theocode-wt-remove {"name": "${task.wtLabel}"}`,
    task.status === "failed"
      ? "This task FAILED — inspect its session before deciding to retry with a sharper card or absorb the work yourself."
      : "Resolve any conflicts yourself; you are the only participant with cross-task context.",
  );
  return lines.join("\n");
}

export function pendingCodeFor(parentRef: SessionRef): CodeTask[] {
  return [...codeTasks.values()].filter(
    (t) =>
      (t.status === "done" || t.status === "failed") &&
      !t.claimed &&
      t.parentRef.projectId === parentRef.projectId &&
      t.parentRef.sessionId === parentRef.sessionId &&
      t.parentRef.subagentId === parentRef.subagentId,
  );
}

export function queuedCodeFor(parentRef: SessionRef): CodeTask[] {
  return [...codeTasks.values()].filter(
    (t) =>
      t.status === "queued" &&
      t.parentRef.projectId === parentRef.projectId &&
      t.parentRef.sessionId === parentRef.sessionId,
  );
}

export function runningCodeCountFor(parentRef: SessionRef): number {
  return [...codeTasks.values()].filter(
    (t) =>
      t.status === "running" &&
      t.parentRef.projectId === parentRef.projectId &&
      t.parentRef.sessionId === parentRef.sessionId,
  ).length;
}
