import { spawn } from "node:child_process";
import { grokBinary } from "../grok";
import { buildAgentInvocation } from "./agent";
import { appendEvent, updateSessionMeta } from "./sessions";
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

export function runAgentTurn(
  project: ProjectInfo,
  session: SessionMeta,
  ref: SessionRef,
  prompt: string,
  sinks: TurnSinks,
): void {
  const invocation = buildAgentInvocation(project, session, prompt);
  const child = spawn(grokBinary(), invocation.args, {
    cwd: invocation.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

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
          | Array<{ content?: { text?: unknown } }>
          | undefined;
        const text = content?.[0]?.content?.text;
        if (typeof text === "string" && text) tool.output = text;
        if (typeof record.status === "string" && record.status) {
          tool.status = record.status;
        }
        const rawOutput = record.rawOutput as { exit_code?: unknown } | null;
        if (typeof rawOutput?.exit_code === "number") {
          tool.exitCode = rawOutput.exit_code;
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
        emit({
          type: "turn_end",
          stopReason: record.stopReason,
          totalTokens: usage?.total_tokens,
          costUsd: record.total_cost_usd,
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
  child.stdout.on("data", (chunk: Buffer) => {
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
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  child.on("error", (err) => {
    emit({ type: "turn_error", text: `Failed to launch grok: ${err.message}` });
    sinks.onPartial(ref, null);
    sinks.onDone?.(null);
  });
  child.on("close", (code) => {
    if (partialTimer) clearTimeout(partialTimer);
    flushCur();
    for (const tool of [...tools.values()]) flushTool(tool);
    if (code !== 0) {
      emit({
        type: "turn_error",
        text: `grok exited with code ${code}`,
        ...(stderrTail ? { stderr: stderrTail } : {}),
      });
    }
    sinks.onPartial(ref, null);
    sinks.onDone?.(code);
  });
}
