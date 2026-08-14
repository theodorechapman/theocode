import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// Worktree allocation for the theocode-wt tool. Mirrors the conventions of
// the skill's scripts/worktree.sh: worktrees live at .worktrees/wt-N, and
// each claims a port block (app 3100+100n, supabase 54321+100n) via atomic
// mkdir locks under ~/.theocode/port-locks so parallel stacks never collide.

export interface WorktreeInfo {
  n: number;
  branch: string;
  path: string;
  ports: {
    app: number;
    supabaseApi: number;
    supabaseDb: number;
    supabaseStudio: number;
  };
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

export function createWorktree(
  projectPath: string,
  branchArg?: string,
): WorktreeInfo {
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", projectPath, ...args], { encoding: "utf8" });

  try {
    git("rev-parse", "--git-dir");
  } catch {
    throw new Error("This project is not a git repository — run git init first.");
  }
  try {
    git("rev-parse", "HEAD");
  } catch {
    throw new Error(
      "The repository has no commits yet — commit your work first, then create a worktree.",
    );
  }

  const wtRoot = join(projectPath, ".worktrees");
  mkdirSync(wtRoot, { recursive: true });
  let n = 1;
  while (existsSync(join(wtRoot, `wt-${n}`))) n++;
  const branch = branchArg?.trim() || `wt-${n}`;
  const dir = join(wtRoot, `wt-${n}`);
  git("worktree", "add", dir, "-B", branch);
  ensureIgnored(projectPath, ".worktrees/");

  // Claim the first free port block for this repo.
  const lockRoot = join(homedir(), ".theocode", "port-locks");
  mkdirSync(lockRoot, { recursive: true });
  const repo = basename(projectPath);
  let block = -1;
  let lock = "";
  for (let i = 0; i < 50; i++) {
    const candidate = join(lockRoot, `${repo}-block-${i}`);
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
    n,
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
