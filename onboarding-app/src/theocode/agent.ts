import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectInfo, SessionMeta } from "./types";

// theocode drives the grok CLI as its agent: the CLI is already authenticated
// through the onboarding flow (it shares ~/.grok/auth.json), the MCP surfaces
// the user connected are registered per-project in <project>/.grok/config.toml
// (see turn.ts syncProjectMcp), and theocode appends its own rules to grok's
// stock system prompt.

/** Appended to grok's own system prompt via --rules. Theo writes this. */
export function extraRules(): string {
  try {
    return readFileSync(
      join(app.getAppPath(), "prompts", "system-prompt.md"),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

export interface AgentInvocation {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * Builds the headless grok invocation for one turn of an agent session.
 * The first turn creates the grok session under our UUID; later turns
 * resume it, so conversational context lives in grok's own session store.
 */
export function buildAgentInvocation(
  project: ProjectInfo,
  session: SessionMeta,
  prompt: string,
): AgentInvocation {
  const sessionArgs = session.grokSessionId
    ? ["--resume", session.grokSessionId]
    : ["--session-id", session.id];
  const args = [
    "--output-format",
    "streaming-json",
    "--cwd",
    project.path,
    ...sessionArgs,
    "-p",
    prompt,
  ];
  const rules = extraRules();
  if (rules) args.push("--rules", rules);
  return { command: "grok", args, cwd: project.path };
}
