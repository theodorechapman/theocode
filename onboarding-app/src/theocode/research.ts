import { randomUUID } from "node:crypto";
import type { SessionEvent, SessionRef } from "./types";

// Research subagents.
//
// The design deliberately splits what the parent says from what the
// researcher sees: the tool takes a short `question` (delivered verbatim)
// and an optional `hypothesis` that theocode HOLDS BACK — the researcher
// never sees it, keeping the exploration pure. It is echoed back to the
// parent alongside the finished report.
//
// The spawn returns immediately. The parent can poll (theocode-research-poll)
// during its turn; when the parent's turn is over, unclaimed reports are
// delivered as an interrupt turn.

export const MAX_QUESTION_CHARS = 400;

export interface ResearchTask {
  id: string;
  parentRef: SessionRef | null;
  subRef: SessionRef;
  question: string;
  /** Parent's private note — never shown to the researcher. */
  hypothesis?: string;
  status: "running" | "done" | "failed";
  report?: string;
  claimed: boolean;
}

export const researchTasks = new Map<string, ResearchTask>();

export function newResearchTask(
  parentRef: SessionRef | null,
  subRef: SessionRef,
  question: string,
  hypothesis?: string,
): ResearchTask {
  const task: ResearchTask = {
    id: randomUUID().slice(0, 8),
    parentRef,
    subRef,
    question,
    hypothesis,
    status: "running",
    claimed: false,
  };
  researchTasks.set(task.id, task);
  return task;
}

/** What the researcher sees: the question, verbatim, and nothing else. */
export function researcherPrompt(question: string): string {
  return [
    "Research question:",
    "",
    question,
    "",
    "Answer this question and nothing else. Follow your research rules and end with the structured report.",
  ].join("\n");
}

/** The final report = the researcher's last message. */
export function reportFromEvents(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "agent_message") {
      const text = events[i].text;
      if (typeof text === "string" && text.trim()) return text;
    }
  }
  return null;
}

/** Delivered to the PARENT: report plus its own held-back hypothesis. */
export function resultText(task: ResearchTask): string {
  const lines = [
    `[research ${task.id} ${task.status === "failed" ? "failed" : "completed"}]`,
    `Question: ${task.question}`,
  ];
  if (task.hypothesis) {
    lines.push(
      `Your private hypothesis when you asked (the researcher never saw this): ${task.hypothesis}`,
    );
  }
  lines.push(
    "",
    "Report:",
    task.report ?? "(the researcher produced no final report)",
  );
  return lines.join("\n");
}

export function pendingFor(parentRef: SessionRef): ResearchTask[] {
  return [...researchTasks.values()].filter(
    (t) =>
      t.status !== "running" &&
      !t.claimed &&
      t.parentRef !== null &&
      t.parentRef.projectId === parentRef.projectId &&
      t.parentRef.sessionId === parentRef.sessionId &&
      t.parentRef.subagentId === parentRef.subagentId,
  );
}
