import { homedir } from "node:os";
import { join } from "node:path";

/**
 * On-disk layout under ~/.theocode (override with THEOCODE_HOME for tests
 * and parallel dev instances):
 *
 *   projects/<projectId>/project.json
 *   projects/<projectId>/sessions/<sessionId>/session.json
 *   projects/<projectId>/sessions/<sessionId>/events.jsonl
 *   projects/<projectId>/sessions/<sessionId>/subagents/<subId>/session.json
 *   projects/<projectId>/sessions/<sessionId>/subagents/<subId>/events.jsonl
 *   index.db                       sqlite mirror of the same tree
 */
export function theocodeHome(): string {
  return process.env.THEOCODE_HOME ?? join(homedir(), ".theocode");
}

export function projectsDir(): string {
  return join(theocodeHome(), "projects");
}

export function projectDir(projectId: string): string {
  return join(projectsDir(), projectId);
}

export function sessionDir(
  projectId: string,
  sessionId: string,
  subagentId?: string,
): string {
  const base = join(projectDir(projectId), "sessions", sessionId);
  return subagentId ? join(base, "subagents", subagentId) : base;
}

export function dbPath(): string {
  return join(theocodeHome(), "index.db");
}
