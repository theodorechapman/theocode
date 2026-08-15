import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  ensureFolderTrusted,
  grokTurnBinary,
  registerProxyInProject,
  unregisterProxyFromProject,
} from "../grok";
import { getActiveProxy } from "../proxy";
import { getCredentials } from "../store";
import { MCP_PROVIDERS } from "../providers";
import { buildAgentInvocation } from "./agent";
import { appendEvent, updateSessionMeta } from "./sessions";
import { ensureWorktreeScript } from "./worktree";
import type {
  ProjectInfo,
  SessionEvent,
  SessionMeta,
  SessionRef,
  TurnPartial,
} from "./types";

// One headless grok turn, coalesced for the transcript.
//
// grok's streaming-json emits per-token `thought`/`text` deltas and
// incremental `tool_call`/`tool_call_update` records. Writing those raw would
// bloat events.jsonl with one event per token, so this runner accumulates:
// deltas stream to the renderer as a TurnPartial snapshot, and events.jsonl
// receives one consolidated record per thought block, message block, and
// completed tool call, plus a turn_end footer.

export interface TurnSinks {
  onEvent(ref: SessionRef, event: SessionEvent): void;
  onPartial(ref: SessionRef, partial: TurnPartial | null): void;
  onDone?(exitCode: number | null): void;
}

export interface TurnHandle {
  /** Kills the grok process; the transcript gets a notice, not an error. */
  interrupt(): void;
}

interface ToolState {
  toolCallId: string;
  toolName: string;
  kind?: string;
  command?: string;
  description?: string;
  input?: unknown;
  output: string;
  status: string;
  exitCode?: number;
}

const PARTIAL_THROTTLE_MS = 80;

// --- Combined turn diff (sanity-check evidence) ------------------------------

function gitTry(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 8_000_000,
    });
  } catch {
    return null;
  }
}

interface GitState {
  head: string;
  working: string;
}

function captureGitState(cwd: string): GitState | null {
  const head = gitTry(cwd, ["rev-parse", "HEAD"])?.trim();
  if (!head) return null;
  return { head, working: gitTry(cwd, ["diff", "HEAD"]) ?? "" };
}

/**
 * The full diff a turn produced — commits made during the turn plus any new
 * working-tree changes — written under .theocode/evidence/. Returns null when
 * the turn changed nothing (the proper no-evidence scenario).
 */
function buildTurnDiff(
  cwd: string,
  pre: GitState | null,
): { path: string; files: number } | null {
  if (!pre) return null;
  const postHead = gitTry(cwd, ["rev-parse", "HEAD"])?.trim();
  const committed =
    postHead && postHead !== pre.head
      ? (gitTry(cwd, ["diff", `${pre.head}..${postHead}`]) ?? "")
      : "";
  const working = gitTry(cwd, ["diff", "HEAD"]) ?? "";
  const workingChanged = working !== pre.working && working.trim().length > 0;
  let combined = committed.trim();
  if (workingChanged) {
    combined += (combined ? "\n" : "") + working.trim();
  }
  if (!combined) return null;
  const files = new Set(
    [...combined.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]),
  ).size;
  const dir = join(cwd, ".theocode", "evidence");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `turn-diff-${Date.now()}.patch`);
  writeFileSync(
    path,
    `# combined diff for one theocode turn (commits during the turn + new working-tree changes)\n${combined}\n`,
  );
  return { path, files };
}

/** .grok/ carries the proxy secret and .theocode/ is per-machine state —
 *  neither belongs in the repo. */
function ensureLocalDirsIgnored(projectPath: string): void {
  const path = join(projectPath, ".gitignore");
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    // No .gitignore yet — create one.
  }
  for (const entry of [".grok/", ".theocode/"]) {
    const bare = entry.replace(/\/$/, "");
    if (content.split("\n").some((l) => l.trim().replace(/\/$/, "") === bare)) {
      continue;
    }
    content = `${content.endsWith("\n") || !content ? content : content + "\n"}${entry}\n`;
  }
  writeFileSync(path, content);
}

/**
 * Keeps the project's .grok/config.toml in step with what is connected in
 * theocode: connected providers point at the loopback proxy, disconnected
 * ones are removed. Project scope (not user scope) so the MCP surface exists
 * only inside theocode projects, not in every grok session on the machine.
 */
/** For worktrees: hide .grok/ via the shared .git/info/exclude instead of the
 *  branch-tracked .gitignore, so registering tools never dirties the tree. */
function ensureGrokDirExcluded(dir: string): void {
  try {
    const common = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--git-common-dir"],
      { encoding: "utf8" },
    ).trim();
    const gitDir = isAbsolute(common) ? common : join(dir, common);
    const path = join(gitDir, "info", "exclude");
    let content = "";
    try {
      content = readFileSync(path, "utf8");
    } catch {
      // No exclude file yet.
    }
    if (content.split("\n").some((l) => l.trim().replace(/\/$/, "") === ".grok")) {
      return;
    }
    mkdirSync(join(gitDir, "info"), { recursive: true });
    appendFileSync(
      path,
      `${content.endsWith("\n") || !content ? "" : "\n"}.grok/\n`,
    );
  } catch {
    // Not a git checkout — nothing to exclude.
  }
}

/**
 * `workDir` is where the turn actually runs (the session's worktree once it
 * has one) — grok resolves repo-local MCP config against that directory, so
 * the registration has to live there, not just in the main checkout.
 */
async function syncProjectMcp(
  project: ProjectInfo,
  workDir: string,
  wtLabel?: string,
): Promise<void> {
  const proxy = getActiveProxy();
  if (!proxy) return;
  const projectPath = workDir;
  // Worktree registrations bake the label into the tool URLs so the proxy
  // knows exactly which session is calling (worktrees bind 1:1 to sessions).
  const target = wtLabel ? `${project.id}/${wtLabel}` : project.id;
  try {
    ensureFolderTrusted(projectPath);
    if (projectPath === project.path) {
      ensureLocalDirsIgnored(projectPath);
      // The canonical worktree script lives in every project; refreshing it
      // here keeps terminal use and the theocode-wt tool identical.
      try {
        ensureWorktreeScript(projectPath);
      } catch {
        // No shipped copy configured (tests) — the tool ensures it on use.
      }
    } else {
      ensureGrokDirExcluded(projectPath);
    }
    // Shelling out to `grok mcp` costs seconds; read the config first and
    // only exec when the desired state differs.
    let config = "";
    try {
      config = readFileSync(join(projectPath, ".grok", "config.toml"), "utf8");
    } catch {
      // No project config yet.
    }
    const wanted: Array<{ name: string; url: string | null }> = [
      // First-party tools: always available in theocode projects.
      { name: "theocode-wt", url: `http://127.0.0.1:${proxy.port}/wt/${target}` },
      {
        name: "theocode-research",
        url: `http://127.0.0.1:${proxy.port}/research/${target}`,
      },
      {
        name: "theocode-code",
        url: `http://127.0.0.1:${proxy.port}/code/${target}`,
      },
      ...MCP_PROVIDERS.map((providerId) => ({
        name: `theocode-${providerId}`,
        url: getCredentials(providerId)
          ? `http://127.0.0.1:${proxy.port}/${providerId}`
          : null,
      })),
    ];
    for (const { name, url } of wanted) {
      const registered = config.includes(`[mcp_servers.${name}]`);
      if (url) {
        const current =
          registered && config.includes(url) && config.includes(proxy.secret);
        if (!current) {
          await registerProxyInProject(projectPath, name, url, proxy.secret);
        }
      } else if (registered) {
        await unregisterProxyFromProject(projectPath, name);
      }
    }
  } catch (err) {
    console.error("project MCP sync failed:", err);
  }
}

export function runAgentTurn(
  project: ProjectInfo,
  session: SessionMeta,
  ref: SessionRef,
  prompt: string,
  sinks: TurnSinks,
  opts?: { research?: boolean; coding?: boolean },
): TurnHandle {
  // The handle exists before the process does: MCP registration has to land
  // in the project config before grok reads it, so the spawn is deferred
  // behind that async sync. Interrupting pre-spawn just cancels the start.
  let child: ChildProcess | null = null;
  let interrupted = false;

  const start = async () => {
  const wt = session.worktree;
  await syncProjectMcp(
    project,
    wt?.path ?? project.path,
    wt ? (wt.label ?? (wt.n !== undefined ? `wt-${wt.n}` : undefined)) : undefined,
  );
  if (interrupted) {
    sinks.onPartial(ref, null);
    sinks.onDone?.(null);
    return;
  }
  const invocation = buildAgentInvocation(project, session, prompt, opts);
  const gitPre = captureGitState(invocation.cwd);
  const proc = spawn(grokTurnBinary(), invocation.args, {
    cwd: invocation.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = proc;

  let cur: { kind: "thought" | "text" | null; buf: string } = {
    kind: null,
    buf: "",
  };
  const tools = new Map<string, ToolState>();
  let partialTimer: NodeJS.Timeout | null = null;

  const emit = (record: Record<string, unknown> & { type: string }) =>
    sinks.onEvent(ref, appendEvent(ref, record));

  function snapshotPartial(): TurnPartial | null {
    const tool = [...tools.values()].at(-1);
    const partial: TurnPartial = {
      ...(cur.kind === "thought" && cur.buf ? { thought: cur.buf } : {}),
      ...(cur.kind === "text" && cur.buf ? { text: cur.buf } : {}),
      ...(tool
        ? {
            tool: {
              toolName: tool.toolName,
              command: tool.command,
              output: tool.output,
              status: tool.status,
            },
          }
        : {}),
    };
    return Object.keys(partial).length > 0 ? partial : null;
  }

  function pushPartial(): void {
    if (partialTimer) return;
    partialTimer = setTimeout(() => {
      partialTimer = null;
      sinks.onPartial(ref, snapshotPartial());
    }, PARTIAL_THROTTLE_MS);
  }

  function flushCur(): void {
    const { kind, buf } = cur;
    cur = { kind: null, buf: "" };
    if (!kind || !buf.trim()) return;
    emit(
      kind === "thought"
        ? { type: "thought", text: buf }
        : { type: "agent_message", text: buf },
    );
  }

  function flushTool(tool: ToolState): void {
    emit({
      type: "tool_call",
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      kind: tool.kind,
      command: tool.command,
      description: tool.description,
      ...(tool.command ? {} : { input: tool.input }),
      output: tool.output,
      exitCode: tool.exitCode,
      status: tool.status,
    });
    tools.delete(tool.toolCallId);
  }

  function handleRecord(record: Record<string, unknown>): void {
    switch (record.type) {
      case "thought":
      case "text": {
        const kind = record.type === "thought" ? "thought" : "text";
        if (cur.kind !== kind) flushCur();
        cur.kind = kind;
        cur.buf += String(record.data ?? "");
        pushPartial();
        break;
      }
      case "tool_call": {
        flushCur();
        const raw = (record.rawInput ?? {}) as Record<string, unknown>;
        const id = String(record.toolCallId ?? "");
        tools.set(id, {
          toolCallId: id,
          toolName: String(record.toolName ?? record.title ?? "tool"),
          kind: typeof record.kind === "string" ? record.kind : undefined,
          command: typeof raw.command === "string" ? raw.command : undefined,
          description:
            typeof raw.description === "string" ? raw.description : undefined,
          input: raw,
          output: "",
          status: String(record.status ?? "pending"),
        });
        pushPartial();
        break;
      }
      case "tool_call_update": {
        const tool = tools.get(String(record.toolCallId ?? ""));
        if (!tool) break;
        const content = record.content as
          | Array<Record<string, unknown>>
          | undefined;
        if (Array.isArray(content)) {
          const texts = content
            .map((item) => {
              const inner = item.content as
                | Record<string, unknown>
                | undefined;
              const text = inner?.text ?? item.text;
              return typeof text === "string" ? text : "";
            })
            .filter(Boolean);
          if (texts.length > 0) tool.output = texts.join("\n");
        }
        if (typeof record.status === "string" && record.status) {
          tool.status = record.status;
        }
        const rawOutput = record.rawOutput as
          | Record<string, unknown>
          | null
          | undefined;
        if (typeof rawOutput?.exit_code === "number") {
          tool.exitCode = rawOutput.exit_code;
        }
        // Some tools (list_dir among them) put their result only in
        // rawOutput; fall back to any string field that looks like output.
        if (!tool.output && rawOutput) {
          for (const key of ["output", "stdout", "content", "result", "text"]) {
            const value = rawOutput[key];
            if (typeof value === "string" && value.trim()) {
              tool.output = value;
              break;
            }
          }
        }
        if (tool.status === "completed" || tool.status === "failed") {
          flushTool(tool);
        }
        pushPartial();
        break;
      }
      case "end": {
        flushCur();
        if (typeof record.sessionId === "string") {
          updateSessionMeta(ref, { grokSessionId: record.sessionId });
          session.grokSessionId = record.sessionId;
        }
        const usage = record.usage as { total_tokens?: number } | undefined;
        let diff: { path: string; files: number } | null = null;
        try {
          diff = buildTurnDiff(invocation.cwd, gitPre);
        } catch {
          // Evidence is best-effort; the turn footer stands without it.
        }
        emit({
          type: "turn_end",
          stopReason: record.stopReason,
          totalTokens: usage?.total_tokens,
          costUsd: record.total_cost_usd,
          ...(diff ? { diffPath: diff.path, diffFiles: diff.files } : {}),
        });
        break;
      }
      case "available_commands":
      case "usage":
        break;
      default:
        emit({
          ...record,
          type: typeof record.type === "string" ? record.type : "agent_event",
        });
    }
  }

  let stdoutBuf = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    let newline: number;
    while ((newline = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, newline).trim();
      stdoutBuf = stdoutBuf.slice(newline + 1);
      if (!line) continue;
      try {
        handleRecord(JSON.parse(line) as Record<string, unknown>);
      } catch {
        emit({ type: "agent_output", text: line });
      }
    }
  });

  let stderrTail = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  proc.on("error", (err) => {
    emit({ type: "turn_error", text: `Failed to launch grok: ${err.message}` });
    sinks.onPartial(ref, null);
    sinks.onDone?.(null);
  });
  proc.on("close", (code) => {
    if (partialTimer) clearTimeout(partialTimer);
    flushCur();
    for (const tool of [...tools.values()]) flushTool(tool);
    if (interrupted) {
      emit({ type: "notice", text: "Interrupted." });
    } else if (code !== 0) {
      emit({
        type: "turn_error",
        text: `grok exited with code ${code}`,
        ...(stderrTail ? { stderr: stderrTail } : {}),
      });
    }
    sinks.onPartial(ref, null);
    sinks.onDone?.(code);
  });
  };

  void start().catch((err) => {
    sinks.onEvent(
      ref,
      appendEvent(ref, {
        type: "turn_error",
        text: `Turn failed to start: ${err instanceof Error ? err.message : err}`,
      }),
    );
    sinks.onPartial(ref, null);
    sinks.onDone?.(null);
  });

  return {
    interrupt() {
      if (interrupted) return;
      interrupted = true;
      child?.kill("SIGTERM");
    },
  };
}
