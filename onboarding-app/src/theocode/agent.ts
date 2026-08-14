import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectInfo, SessionMeta } from "./types";

// theocode drives the grok CLI as its agent: the CLI is already authenticated
// through the onboarding flow (it shares ~/.grok/auth.json), the MCP surfaces
// the user connected are registered per-project in <project>/.grok/config.toml
// (see turn.ts syncProjectMcp), and theocode appends its own rules to grok's
// stock system prompt.

function readPrompt(file: string): string {
  try {
    return readFileSync(join(app.getAppPath(), "prompts", file), "utf8").trim();
  } catch {
    return "";
  }
}

/** Appended to grok's own system prompt via --rules. Theo writes this. */
export function extraRules(): string {
  return readPrompt("system-prompt.md");
}

/** Rules for research subagents: pure, read-only, question-scoped. */
export function researchRules(): string {
  return readPrompt("research-rules.md");
}

/** Rules for coding subagents: one card, one worktree, commit before finish. */
export function codingRules(): string {
  return readPrompt("coding-rules.md");
}

// Researchers are structurally read-only: no terminal, no edits, no
// worktrees, no subagents. search_tool/use_tool stay, so read-only MCP
// surfaces remain reachable.
export const RESEARCH_TOOLS = "read_file,grep,list_dir,web_search,web_fetch";

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
  opts?: { research?: boolean; coding?: boolean },
): AgentInvocation {
  const sessionArgs = session.grokSessionId
    ? ["--resume", session.grokSessionId]
    : ["--session-id", session.id];
  // Once a session has moved itself into a worktree (theocode-wt), every
  // later turn runs there instead of the main checkout.
  const cwd = session.worktree?.path ?? project.path;
  const args = [
    "--output-format",
    "streaming-json",
    "--cwd",
    cwd,
    ...sessionArgs,
    "-p",
    prompt,
  ];
  if (opts?.research) args.push("--tools", RESEARCH_TOOLS);
  const rules = opts?.research
    ? researchRules()
    : opts?.coding
      ? codingRules()
      : extraRules();
  if (rules) args.push("--rules", rules);
  return { command: "grok", args, cwd };
}
