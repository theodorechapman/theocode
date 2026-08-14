import { button, h } from "./dom";
import type {
  ProjectInfo,
  SessionRef,
  SetupDetection,
  WorkspaceApi,
} from "../theocode/types";

// The quick setup prompt: two yes/no rows answered with the 1 / 2 keys (or
// clicks). Row two stays inert until row one is answered. Any "yes" launches
// the theocode-project-setup skill run in a new "Project setup" session.

interface Row {
  el: HTMLElement;
  status: HTMLElement;
  answer?: boolean;
}

export function showSetupDialog(
  api: WorkspaceApi,
  project: ProjectInfo,
  detection: SetupDetection,
  onStarted: (ref: SessionRef) => void,
): void {
  const rows: Row[] = [];
  let finished = false;

  function makeRow(question: string, detected: boolean): Row {
    const status = h("span", "tc-ask-status");
    const row: Row = { el: h("div", "tc-ask-row"), status };
    const answerWith = (value: boolean) => answer(row, value);
    row.el.append(
      h(
        "div",
        "tc-ask-question",
        h("p", "tc-ask-text", question),
        ...(detection.existing && detected
          ? [h("p", "tc-ask-hint", "Detected in this directory")]
          : []),
      ),
      h(
        "div",
        "tc-ask-actions",
        button("tc-ask-choice", "", () => answerWith(true)),
        button("tc-ask-choice", "", () => answerWith(false)),
        status,
      ),
    );
    const [yes, no] = row.el.querySelectorAll<HTMLButtonElement>(".tc-ask-choice");
    yes.append(h("kbd", "tc-ask-key", "1"), "Yes");
    no.append(h("kbd", "tc-ask-key", "2"), "No");
    return row;
  }

  function activeRow(): Row | undefined {
    return rows.find((row) => row.answer === undefined);
  }

  function refresh(): void {
    for (const row of rows) {
      const active = row === activeRow();
      row.el.dataset.state =
        row.answer !== undefined ? "answered" : active ? "active" : "waiting";
      if (row.answer !== undefined) {
        row.status.textContent = row.answer ? "Yes" : "No";
        for (const b of row.el.querySelectorAll("button")) b.remove();
      }
    }
  }

  async function answer(row: Row, value: boolean): Promise<void> {
    if (finished || row.answer !== undefined || row !== activeRow()) return;
    row.answer = value;
    refresh();
    if (rows.every((r) => r.answer !== undefined)) {
      finished = true;
      const [vercel, supabase] = rows.map((r) => r.answer === true);
      close();
      // Even with both answered no, setup still runs: it installs the
      // worktree script and repo hygiene every project needs.
      onStarted(await api.runSetup(project.id, { vercel, supabase }));
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      finished = true;
      close();
      void api.setupSeen(project.id);
      return;
    }
    if (event.key !== "1" && event.key !== "2") return;
    event.preventDefault();
    const row = activeRow();
    if (row) void answer(row, event.key === "1");
  }

  rows.push(
    makeRow("Are you using Vercel to deploy and store secrets?", detection.vercel),
    makeRow(
      "Are you using Supabase for Postgres, auth, or a backend?",
      detection.supabase,
    ),
  );

  const overlay = h("div", "tc-ask-overlay");
  const box = h(
    "div",
    "tc-ask-box",
    h("h2", "tc-ask-title", `Set up ${project.name}`),
    h(
      "p",
      "tc-ask-lede",
      detection.existing
        ? "Existing project. Confirm what it uses and the agent will conform the setup."
        : "Answer with the 1 and 2 keys. Any yes starts the setup agent.",
    ),
    ...rows.map((row) => row.el),
    h("p", "tc-ask-hint", "Esc to skip. You can rerun setup from a session later."),
  );
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", `Set up ${project.name}`);
  overlay.append(box);

  function close(): void {
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
  }

  window.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  refresh();
}
