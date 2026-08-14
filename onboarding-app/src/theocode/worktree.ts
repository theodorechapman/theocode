import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// Worktree allocation for the theocode-wt tool.
//
// The logic lives in ONE place: resources/worktree.sh, which theocode
// installs into every project as scripts/worktree.sh. This module installs
// (and refreshes) that script and executes it, so the in-app tool, the
// setup skill, and a human in a terminal all share identical semantics —
// wt-N / wt-N.M naming, two-level cap, branch-reuse guard, and the flat
// port-block locks under $THEOCODE_HOME/port-locks.

export interface WorktreeInfo {
  label: string;
  branch: string;
  path: string;
  ports: {
    app: number;
    supabaseApi: number;
    supabaseDb: number;
    supabaseStudio: number;
  };
}

const MANAGED_MARKER = "# theocode-managed: replace-on-update";

let scriptSource: string | null = null;

/** Where the canonical script ships from (set at app startup; tests point it
 *  at the repo's resources/worktree.sh directly). */
export function setWorktreeScriptSource(path: string): void {
  scriptSource = path;
}

/** Installs or refreshes the project's scripts/worktree.sh from the shipped
 *  starter. A project-tailored script (managed marker removed by the setup
 *  agent) is NEVER overwritten — only its CLI/output contract is relied on.
 *  Returns the script path. */
export function ensureWorktreeScript(projectPath: string): string {
  const target = join(projectPath, "scripts", "worktree.sh");
  if (scriptSource && existsSync(scriptSource)) {
    const wanted = readFileSync(scriptSource, "utf8");
    let current: string | null = null;
    try {
      current = readFileSync(target, "utf8");
    } catch {
      // Not installed yet.
    }
    const managed = current === null || current.includes(MANAGED_MARKER);
    if (managed && current !== wanted) {
      mkdirSync(join(projectPath, "scripts"), { recursive: true });
      writeFileSync(target, wanted);
    }
    chmodSync(target, 0o755);
  } else if (!existsSync(target)) {
    throw new Error(
      "worktree script unavailable: no shipped copy configured and the project has no scripts/worktree.sh",
    );
  }
  return target;
}

function runScript(projectPath: string, args: string[]): Map<string, string> {
  const script = ensureWorktreeScript(projectPath);
  let stdout: string;
  try {
    stdout = execFileSync("bash", [script, ...args], {
      cwd: projectPath,
      encoding: "utf8",
      env: process.env,
    });
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : "";
    throw new Error(stderr.split("\n").at(-1) || "worktree script failed");
  }
  const out = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (line.startsWith("WT_") && eq > 0) {
      out.set(line.slice(0, eq), line.slice(eq + 1));
    }
  }
  return out;
}

export function createWorktree(
  projectPath: string,
  branchArg?: string,
  callerWt?: { label: string; branch: string },
): WorktreeInfo {
  const args = ["new"];
  if (callerWt) args.push("--parent", callerWt.label, "--base", callerWt.branch);
  if (branchArg?.trim()) args.push("--branch", branchArg.trim());
  const out = runScript(projectPath, args);
  const label = out.get("WT_LABEL");
  const branch = out.get("WT_BRANCH");
  const path = out.get("WT_PATH");
  const app = Number(out.get("WT_APP_PORT"));
  const sb = Number(out.get("WT_SB_PORT"));
  if (!label || !branch || !path || !app || !sb) {
    throw new Error("worktree script returned an incomplete result");
  }
  return {
    label,
    branch,
    path,
    ports: {
      app,
      supabaseApi: sb,
      supabaseDb: sb + 1,
      supabaseStudio: sb + 2,
    },
  };
}

export function childrenOf(projectPath: string, label: string): string[] {
  try {
    return readdirSync(join(projectPath, ".worktrees"))
      .filter((name) => name.startsWith(`${label}.`))
      .sort();
  } catch {
    return [];
  }
}

/** Removes a worktree via the script (cascade removes wt-N.* first). */
export function removeWorktree(
  projectPath: string,
  label: string,
  cascade: boolean,
): string[] {
  const out = runScript(projectPath, [
    "remove",
    label,
    ...(cascade ? ["--cascade"] : []),
  ]);
  const removed = out.get("WT_REMOVED");
  if (!removed) throw new Error("worktree script returned an incomplete result");
  return removed.split(",").filter(Boolean);
}
