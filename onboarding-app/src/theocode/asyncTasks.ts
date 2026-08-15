import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { theocodeHome } from "./paths";
import { codeTasks, type CodeTask } from "./coding";
import { researchTasks, type ResearchTask } from "./research";

// Durable registry for async results (research + code tasks).
//
// The maps live in memory; this mirrors them to disk on every mutation so an
// app restart can neither orphan a finished report nor forget a claim.
// On load, tasks that were "running" are marked failed — their processes
// died with the old app — while unclaimed finished results survive to be
// delivered at the next opportunity.

function registryPath(): string {
  return join(theocodeHome(), "async-tasks.json");
}

export function saveAsyncTasks(): void {
  try {
    mkdirSync(theocodeHome(), { recursive: true });
    writeFileSync(
      registryPath(),
      JSON.stringify(
        {
          research: [...researchTasks.values()],
          code: [...codeTasks.values()],
        },
        null,
        2,
      ) + "\n",
    );
  } catch (err) {
    console.error("could not persist async tasks:", err);
  }
}

/** Loads the registry; returns the tasks that were cut off mid-run. */
export function loadAsyncTasks(): {
  interruptedResearch: ResearchTask[];
  interruptedCode: CodeTask[];
} {
  const interruptedResearch: ResearchTask[] = [];
  const interruptedCode: CodeTask[] = [];
  try {
    const raw = JSON.parse(readFileSync(registryPath(), "utf8")) as {
      research?: ResearchTask[];
      code?: CodeTask[];
    };
    for (const task of raw.research ?? []) {
      if (task.status === "running") {
        task.status = "failed";
        task.report =
          task.report ??
          "(cut off: the app restarted while this researcher was mid-investigation — its partial transcript is in the subagent session; re-ask to finish)";
        interruptedResearch.push(task);
      }
      researchTasks.set(task.id, task);
    }
    for (const task of raw.code ?? []) {
      if (task.status === "running" || task.status === "queued") {
        task.status = "failed";
        task.result =
          task.result ??
          "(cut off: the app restarted while this task was in flight — its worktree and partial transcript survive; retry with a fresh card)";
        interruptedCode.push(task);
      }
      codeTasks.set(task.id, task);
    }
  } catch {
    // No registry yet.
  }
  return { interruptedResearch, interruptedCode };
}
