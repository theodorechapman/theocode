import { app } from "electron";
import { spawn } from "node:child_process";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { grokBinary } from "../grok";
import { buildAgentInvocation } from "./agent";
import { appendEvent, createSession } from "./sessions";
import type {
  ProjectInfo,
  SessionEvent,
  SessionRef,
  SetupAnswers,
  SetupDetection,
} from "./types";

const SKILL_NAME = "theocode-project-setup";

/**
 * Installs the bundled project-setup skill into the grok CLI's user skill
 * directory (~/.grok/skills/<name>/SKILL.md). Copy-on-start keeps the CLI's
 * copy in sync with the version this app shipped with.
 */
export function installSetupSkill(): void {
  try {
    cpSync(
      join(app.getAppPath(), "skills", SKILL_NAME),
      join(homedir(), ".grok", "skills", SKILL_NAME),
      { recursive: true },
    );
  } catch (err) {
    console.error("setup skill install failed:", err);
  }
}

/** Cheap filesystem sniff — the deep conform pass is the agent's job. */
export function detectStack(projectPath: string): SetupDetection {
  const has = (...parts: string[]) => existsSync(join(projectPath, ...parts));
  let existing = false;
  try {
    existing = readdirSync(projectPath).some(
      (name) => name !== ".git" && name !== ".DS_Store",
    );
  } catch {
    // Unreadable directory — treat as new.
  }
  return {
    existing,
    vercel: has(".vercel", "project.json") || has("vercel.json"),
    supabase: has("supabase", "config.toml"),
  };
}

function setupPrompt(answers: SetupAnswers, detection: SetupDetection): string {
  const yn = (v: boolean) => (v ? "yes" : "no");
  return [
    `Set up this project's infrastructure by following the skill at ~/.grok/skills/${SKILL_NAME}/SKILL.md exactly.`,
    "",
    "Context:",
    `- mode: ${detection.existing ? "existing" : "new"}`,
    `- Vercel selected: ${yn(answers.vercel)}`,
    `- Supabase selected: ${yn(answers.supabase)}`,
    `- detection: vercel config present: ${yn(detection.vercel)}; supabase config present: ${yn(detection.supabase)}`,
    "",
    "Work autonomously; never ask questions. Finish with the exact summary structure the skill specifies.",
  ].join("\n");
}

/**
 * Creates a "Project setup" session and runs one headless grok turn in it,
 * streaming the CLI's NDJSON records into the session transcript. Returns the
 * session ref immediately; the run continues in the background.
 */
export function runProjectSetup(
  project: ProjectInfo,
  answers: SetupAnswers,
  onEvent: (ref: SessionRef, event: SessionEvent) => void,
): SessionRef {
  const detection = detectStack(project.path);
  const session = createSession(project.id, undefined, "Project setup");
  const ref: SessionRef = { projectId: project.id, sessionId: session.id };
  const emit = (record: Record<string, unknown> & { type: string }) =>
    onEvent(ref, appendEvent(ref, record));

  const prompt = setupPrompt(answers, detection);
  emit({ type: "user_message", text: prompt });

  const invocation = buildAgentInvocation(project, session, prompt);
  const child = spawn(grokBinary(), invocation.args, {
    cwd: invocation.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    let newline: number;
    while ((newline = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, newline).trim();
      stdoutBuf = stdoutBuf.slice(newline + 1);
      if (!line) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        emit({
          ...record,
          type: typeof record.type === "string" ? record.type : "agent_event",
        });
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
    emit({ type: "setup_error", text: `Failed to launch grok: ${err.message}` });
  });
  child.on("close", (code) => {
    emit({
      type: "setup_finished",
      code,
      ...(code !== 0 && stderrTail ? { stderr: stderrTail } : {}),
    });
  });

  return ref;
}
