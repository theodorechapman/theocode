import { app } from "electron";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendEvent, createSession } from "./sessions";
import { runAgentTurn, type TurnHandle, type TurnSinks } from "./turn";
import type {
  ProjectInfo,
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
    alreadySetUp: has(".theocode", "setup.json"),
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
    answers.vercel || answers.supabase
      ? "Work autonomously; never ask questions. Finish with the exact summary structure the skill specifies."
      : "Neither Vercel nor Supabase was selected: perform ONLY the skill's 'Always' section (git repo, worktree script, gitignore), then finish with the summary.",
  ].join("\n");
}

/**
 * Creates a "Project setup" session and runs one coalesced grok turn in it.
 * Returns the session ref immediately; the run continues in the background.
 */
export function runProjectSetup(
  project: ProjectInfo,
  answers: SetupAnswers,
  sinks: TurnSinks,
): { ref: SessionRef; handle: TurnHandle } {
  const detection = detectStack(project.path);
  const session = createSession(project.id, undefined, "Project setup");
  const ref: SessionRef = { projectId: project.id, sessionId: session.id };
  const prompt = setupPrompt(answers, detection);
  sinks.onEvent(ref, appendEvent(ref, { type: "user_message", text: prompt }));
  const handle = runAgentTurn(project, session, ref, prompt, sinks);
  return { ref, handle };
}
