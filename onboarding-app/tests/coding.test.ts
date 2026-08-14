import { expect, test } from "bun:test";
import {
  codeResultText,
  coderPrompt,
  newCodeTask,
  validateCards,
} from "../src/theocode/coding";

const CARD = {
  goal: "Add a health endpoint",
  spec: "GET /health returns {ok:true} with status 200.",
  files_in_scope: ["src/server.ts"],
  done_criteria: ["curl localhost:$PORT/health returns ok"],
  notes_for_merge: "must land before the deploy task",
};

test("validateCards enforces the contract with corrective errors", () => {
  expect(() => validateCards([])).toThrow(/non-empty/);
  expect(() => validateCards([{ ...CARD, goal: "" }])).toThrow(/goal is required/);
  expect(() => validateCards([{ ...CARD, goal: "x".repeat(300) }])).toThrow(
    /details belong in spec/,
  );
  expect(() => validateCards([{ ...CARD, spec: "" }])).toThrow(/spec is required/);
  expect(() => validateCards([{ ...CARD, files_in_scope: [] }])).toThrow(
    /files_in_scope/,
  );
  expect(() => validateCards([{ ...CARD, done_criteria: undefined }])).toThrow(
    /done_criteria/,
  );
  const ok = validateCards([CARD]);
  expect(ok[0].goal).toBe(CARD.goal);
});

test("the subagent prompt carries the card but never notes_for_merge", () => {
  const prompt = coderPrompt(validateCards([CARD])[0]);
  expect(prompt).toContain("Add a health endpoint");
  expect(prompt).toContain("src/server.ts");
  expect(prompt).not.toContain("must land before the deploy task");
});

test("the coordinator result echoes held-back notes and the merge playbook", () => {
  const task = newCodeTask(
    { projectId: "p", sessionId: "s" },
    { path: "/repo/.worktrees/wt-1", label: "wt-1" },
    validateCards([CARD])[0],
    3,
  );
  task.status = "done";
  task.wtLabel = "wt-1.1";
  task.branch = "wt-1.1";
  task.result = "## Result\nDone.";
  const text = codeResultText(task);
  expect(text).toContain("must land before the deploy task");
  expect(text).toContain("git merge --no-ff wt-1.1");
  expect(text).toContain("cd /repo/.worktrees/wt-1");
  expect(text).toContain('theocode-wt-remove {"name": "wt-1.1"}');
});
