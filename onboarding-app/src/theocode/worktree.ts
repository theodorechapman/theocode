import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { portLocksDir } from "./paths";

// Worktree allocation for the theocode-wt tool.
//
// Naming encodes the merge topology and is HARD-CAPPED at two levels:
//   wt-N     top-level task worktree, branched from the project HEAD
//   wt-N.M   child of wt-N, branched from wt-N's branch, merges back into it
// A caller already inside wt-N gets children wt-N.M; a caller inside a child
// wt-N.M gets SIBLINGS (more wt-N.*), never wt-N.M.X.
//
// Every worktree claims a flat port block (app 3100+100b, supabase 54321+100b)
// via atomic mkdir locks so parallel stacks never collide; hierarchy never
// leaks into port allocation.

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

const LABEL_RE = /^wt-\d+(\.\d+)?$/;

function lockRoot(): string {
  return portLocksDir();
}

function branchExists(projectPath: string, branch: string): boolean {
  try {
    git(projectPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

function git(projectPath: string, ...args: string[]): string {
  return execFileSync("git", ["-C", projectPath, ...args], {
    encoding: "utf8",
  }).trim();
}

function ensureIgnored(projectPath: string, entry: string): void {
  const path = join(projectPath, ".gitignore");
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    // No .gitignore yet.
  }
  const bare = entry.replace(/\/$/, "");
  if (content.split("\n").some((l) => l.trim().replace(/\/$/, "") === bare)) {
    return;
  }
  appendFileSync(path, `${content.endsWith("\n") || !content ? "" : "\n"}${entry}\n`);
}

/** Next free label: skips labels whose directory OR branch still exists, so
 *  a removed worktree's kept branch is never force-reset by label reuse. */
function nextLabel(projectPath: string, wtRoot: string, prefix: string): string {
  let n = 1;
  while (
    existsSync(join(wtRoot, `${prefix}${n}`)) ||
    branchExists(projectPath, `${prefix}${n}`)
  ) {
    n++;
  }
  return `${prefix}${n}`;
}

function branchOfWorktree(dir: string): string | null {
  try {
    return git(dir, "branch", "--show-current") || null;
  } catch {
    return null;
  }
}

export function createWorktree(
  projectPath: string,
  branchArg?: string,
  callerWt?: { label: string; branch: string },
): WorktreeInfo {
  try {
    git(projectPath, "rev-parse", "--git-dir");
  } catch {
    throw new Error("This project is not a git repository — run git init first.");
  }
  try {
    git(projectPath, "rev-parse", "HEAD");
  } catch {
    throw new Error(
      "The repository has no commits yet — commit your work first, then create a worktree.",
    );
  }

  const wtRoot = join(projectPath, ".worktrees");
  mkdirSync(wtRoot, { recursive: true });

  // Two-level hierarchy: children of the caller's top-level worktree.
  let label: string;
  let baseBranch: string | null = null;
  if (callerWt) {
    const parentLabel = callerWt.label.split(".")[0];
    const parentDir = join(wtRoot, parentLabel);
    if (existsSync(parentDir)) {
      label = nextLabel(projectPath, wtRoot, `${parentLabel}.`);
      // Detached HEAD (or any git hiccup) in the parent must not silently
      // rebase the child onto the project HEAD — fall back to the branch
      // recorded on the calling session.
      baseBranch = branchOfWorktree(parentDir) ?? callerWt.branch;
    } else {
      // Parent worktree is gone — fall back to a fresh top-level worktree.
      label = nextLabel(projectPath, wtRoot, "wt-");
    }
  } else {
    label = nextLabel(projectPath, wtRoot, "wt-");
  }

  const branch = branchArg?.trim() || label;
  const dir = join(wtRoot, label);
  git(
    projectPath,
    "worktree",
    "add",
    dir,
    "-B",
    branch,
    ...(baseBranch ? [baseBranch] : []),
  );
  ensureIgnored(projectPath, ".worktrees/");

  // Claim the first free port block for this repo (flat, name-independent).
  mkdirSync(lockRoot(), { recursive: true });
  const repo = basename(projectPath);
  let block = -1;
  let lock = "";
  for (let i = 0; i < 50; i++) {
    const candidate = join(lockRoot(), `${repo}-block-${i}`);
    try {
      mkdirSync(candidate);
      writeFileSync(join(candidate, "claim"), dir);
      block = i;
      lock = candidate;
      break;
    } catch {
      // Block taken — try the next one.
    }
  }
  if (block < 0) throw new Error("No free port block (50 in use for this repo)");

  const app = 3100 + 100 * block;
  const sb = 54321 + 100 * block;
  writeFileSync(
    join(dir, ".env.ports"),
    [
      `PORT=${app}`,
      `APP_PORT=${app}`,
      `SUPABASE_API_PORT=${sb}`,
      `SUPABASE_DB_PORT=${sb + 1}`,
      `SUPABASE_STUDIO_PORT=${sb + 2}`,
      `PORT_LOCK=${lock}`,
      "",
    ].join("\n"),
  );

  // The worktree's local supabase stack gets its own ports too.
  const supabaseConfig = join(dir, "supabase", "config.toml");
  if (existsSync(supabaseConfig)) {
    const patched = readFileSync(supabaseConfig, "utf8")
      .replace(/^port = 54321$/m, `port = ${sb}`)
      .replace(/^port = 54322$/m, `port = ${sb + 1}`)
      .replace(/^port = 54323$/m, `port = ${sb + 2}`);
    writeFileSync(supabaseConfig, patched);
  }

  return {
    label,
    branch,
    path: dir,
    ports: {
      app,
      supabaseApi: sb,
      supabaseDb: sb + 1,
      supabaseStudio: sb + 2,
    },
  };
}

export function childrenOf(projectPath: string, label: string): string[] {
  const wtRoot = join(projectPath, ".worktrees");
  try {
    return readdirSync(wtRoot)
      .filter((name) => name.startsWith(`${label}.`))
      .sort();
  } catch {
    return [];
  }
}

/** Release by scanning lockRoot for the claim that names this worktree —
 *  never by trusting the agent-writable .env.ports contents. */
function releasePortLock(dir: string): void {
  try {
    for (const name of readdirSync(lockRoot())) {
      const lock = join(lockRoot(), name);
      let claim = "";
      try {
        claim = readFileSync(join(lock, "claim"), "utf8").trim();
      } catch {
        continue;
      }
      if (claim === dir) {
        rmSync(lock, { recursive: true, force: true });
        return;
      }
    }
  } catch {
    // No lock root — nothing to release.
  }
}

/**
 * Removes a worktree, releasing its port block. A top-level worktree with
 * live children refuses unless `cascade` is set; cascade removes children
 * first. Branches are left in place.
 */
export function removeWorktree(
  projectPath: string,
  label: string,
  cascade: boolean,
): string[] {
  if (!LABEL_RE.test(label)) {
    throw new Error(
      `Invalid worktree name "${label}" — expected wt-N or wt-N.M.`,
    );
  }
  const wtRoot = join(projectPath, ".worktrees");
  if (!existsSync(join(wtRoot, label))) {
    throw new Error(`No worktree named ${label}`);
  }
  const children = childrenOf(projectPath, label);
  if (children.length > 0 && !cascade) {
    throw new Error(
      `${label} has live child worktrees (${children.join(", ")}). Remove them first, or pass cascade: true to remove the whole family.`,
    );
  }
  const removed: string[] = [];
  for (const name of [...children, label]) {
    const dir = join(wtRoot, name);
    releasePortLock(dir);
    try {
      git(projectPath, "worktree", "remove", "--force", dir);
    } catch {
      // Fall back to deleting the directory and letting git prune the record.
      rmSync(dir, { recursive: true, force: true });
      try {
        git(projectPath, "worktree", "prune");
      } catch {
        // Best effort.
      }
    }
    removed.push(name);
  }
  return removed;
}
