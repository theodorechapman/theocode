import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Rewind support: point-in-time snapshots of a session's working directory,
// taken at each user prompt, plus best-effort truncation of the grok CLI's
// own chat history so the agent's memory rewinds with the transcript.
//
// Snapshots are plain git objects (a commit wrapping `git add -A` written
// through a throwaway index), pinned under refs/theocode/snapshots/ so gc
// never collects them. The user's real index is never touched when
// snapshotting; restoring resets index + working tree to the snapshot.

function git(dir: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Snapshot the working directory (tracked + untracked, .gitignore respected)
 * as a pinned commit. Returns the commit sha, or null when `dir` is not a
 * git checkout or the snapshot fails — rewind then simply has no file state
 * to offer for that prompt.
 */
export function takeSnapshot(dir: string): string | null {
  const tmpIndex = join(tmpdir(), `tc-snapshot-${randomUUID()}`);
  try {
    git(dir, ["rev-parse", "--git-dir"]);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    git(dir, ["add", "-A"], env);
    const tree = git(dir, ["write-tree"], env);
    const commit = git(
      dir,
      [
        "-c",
        "user.name=theocode",
        "-c",
        "user.email=theocode@local",
        "commit-tree",
        tree,
        "-m",
        "theocode rewind snapshot",
      ],
      env,
    );
    git(dir, ["update-ref", `refs/theocode/snapshots/${commit}`, commit]);
    return commit;
  } catch {
    return null;
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

/**
 * Reset the working directory to a snapshot taken by takeSnapshot. A safety
 * snapshot of the current state is taken first and returned, so a rewind is
 * itself recoverable (`git checkout <sha> -- .` by hand). Staging everything
 * before `read-tree --reset -u` is what makes files created after the
 * snapshot disappear — read-tree only removes paths it finds in the index.
 */
export function restoreSnapshot(dir: string, sha: string): string | null {
  const safety = takeSnapshot(dir);
  git(dir, ["add", "-A"]);
  git(dir, ["read-tree", "--reset", "-u", sha]);
  return safety;
}

function grokSessionsRoot(): string {
  return join(process.env.GROK_HOME ?? join(homedir(), ".grok"), "sessions");
}

/** The grok store nests sessions under a url-encoded cwd we may no longer
 *  know (sessions can move into worktrees), so locate the id by scan. */
function findGrokSessionDir(grokSessionId: string): string | null {
  let cwdDirs: string[];
  try {
    cwdDirs = readdirSync(grokSessionsRoot());
  } catch {
    return null;
  }
  for (const cwdDir of cwdDirs) {
    const candidate = join(grokSessionsRoot(), cwdDir, grokSessionId);
    if (existsSync(join(candidate, "chat_history.jsonl"))) return candidate;
  }
  return null;
}

/**
 * Truncate the grok CLI's chat_history.jsonl at the user record carrying
 * `droppedPrompt` (the first prompt being rewound away), so a later --resume
 * genuinely forgets the undone turns. Best-effort against a private format:
 * the previous history is backed up next to the file, and false means the
 * caller should surface that the agent may still remember.
 */
export function rewindGrokHistory(
  grokSessionId: string,
  droppedPrompt: string,
): boolean {
  const dir = findGrokSessionDir(grokSessionId);
  if (!dir) return false;
  const historyPath = join(dir, "chat_history.jsonl");
  // Match on the prompt as a JSON string fragment: the history stores message
  // text JSON-escaped, so escape the same way and search raw lines. Quotes
  // are stripped to allow the prompt to sit inside a larger text field.
  const needle = JSON.stringify(droppedPrompt).slice(1, -1);
  if (!needle) return false;
  try {
    const lines = readFileSync(historyPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    let cut = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(needle)) continue;
      try {
        if (JSON.parse(lines[i]).type === "user") cut = i;
      } catch {
        // Unparseable line — not a match.
      }
    }
    if (cut < 0) return false;
    copyFileSync(historyPath, `${historyPath}.pre-rewind`);
    const kept = lines.slice(0, cut);
    writeFileSync(historyPath, kept.map((l) => `${l}\n`).join(""));
    // Keep the session index consistent enough for --resume to load.
    const summaryPath = join(dir, "summary.json");
    try {
      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      summary.num_chat_messages = kept.length;
      summary.updated_at = new Date().toISOString();
      writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
    } catch {
      // Summary missing or unreadable — history truncation still stands.
    }
    return true;
  } catch {
    return false;
  }
}
