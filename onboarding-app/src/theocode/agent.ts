import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTokens } from "../store";
import { sessionDir } from "./paths";
import type { ProjectInfo, SessionMeta } from "./types";

// theocode drives the grok CLI as its agent: the CLI is already authenticated
// through the onboarding flow (it shares ~/.grok/auth.json), and theocode adds
// two things on top — the MCP surfaces the user connected (Supabase, Vercel)
// and a theocode-specific system prompt.
//
// The chat loop is not wired yet; this module owns how an invocation is built
// so that wiring it later is a matter of spawning `invocation` and streaming
// its NDJSON output into the session's events.jsonl.

/** Blank on purpose — Theo writes this. Shipped at prompts/system-prompt.md. */
export function systemPrompt(): string {
  try {
    return readFileSync(
      join(app.getAppPath(), "prompts", "system-prompt.md"),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

interface McpServerConfig {
  type: "http";
  url: string;
  headers: Record<string, string>;
}

/**
 * MCP servers to hand the agent, authorized with the tokens the onboarding
 * flow stored. Written per-session so a session's transcript and its tool
 * surface live together.
 */
export function buildMcpConfig(): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  const supabase = getTokens("supabase");
  if (supabase) {
    servers.supabase = {
      type: "http",
      url: "https://mcp.supabase.com/mcp",
      headers: { Authorization: `Bearer ${supabase.access_token}` },
    };
  }
  const vercel = getTokens("vercel");
  if (vercel) {
    servers.vercel = {
      type: "http",
      url: "https://mcp.vercel.com",
      headers: { Authorization: `Bearer ${vercel.access_token}` },
    };
  }
  return servers;
}

export interface AgentInvocation {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * Builds the headless grok invocation for one turn of an agent session.
 * `--session-id` keys the CLI's own transcript to ours; subagent activity
 * arrives as records in the NDJSON stream and lands under the parent
 * session's subagents/ directory when the loop is wired.
 */
export function buildAgentInvocation(
  project: ProjectInfo,
  session: SessionMeta,
  prompt: string,
): AgentInvocation {
  const dir = sessionDir(project.id, session.id);
  const mcpConfigPath = join(dir, "mcp.json");
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({ mcpServers: buildMcpConfig() }, null, 2) + "\n",
    { mode: 0o600 },
  );

  const args = [
    "--output-format",
    "streaming-json",
    "--cwd",
    project.path,
    "--session-id",
    session.id,
    "-p",
    prompt,
  ];
  const system = systemPrompt();
  if (system) args.push("--system-prompt-override", system);
  // TODO(wiring): register mcpConfigPath with the CLI (grok mcp add / agent
  // profile) once the chat loop is implemented; the file is already written.
  return { command: "grok", args, cwd: project.path };
}
