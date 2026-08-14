import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { projectDir, projectsDir, sessionDir } from "./paths";
import { mirror } from "./db";
import type {
  ProjectInfo,
  ProjectNode,
  SessionEvent,
  SessionMeta,
  SessionNode,
  SessionRef,
  WorkspaceTree,
} from "./types";

// Filesystem is the source of truth: project/session metadata as JSON files,
// transcripts as append-only raw jsonl. Every mutation is mirrored into the
// sqlite index (unused for reads today; queries move there later).

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const DEFAULT_TITLE = "New session";

/** Session title from a prompt: its first line, clipped. grok emits no
 *  session-title records, so titles are derived from the latest prompt. */
export function titleFromPrompt(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ").trim();
  if (!line) return DEFAULT_TITLE;
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

export function createProject(path: string): ProjectInfo {
  const project: ProjectInfo = {
    id: randomUUID(),
    name: basename(path),
    path,
    createdAt: new Date().toISOString(),
  };
  writeJson(join(projectDir(project.id), "project.json"), project);
  mirror.projectSaved(project);
  return project;
}

export function getProject(projectId: string): ProjectInfo | null {
  return readJson<ProjectInfo>(join(projectDir(projectId), "project.json"));
}

export function updateProject(
  projectId: string,
  patch: Partial<ProjectInfo>,
): ProjectInfo | null {
  const project = getProject(projectId);
  if (!project) return null;
  const updated = { ...project, ...patch };
  writeJson(join(projectDir(projectId), "project.json"), updated);
  mirror.projectSaved(updated);
  return updated;
}

export function createSession(
  projectId: string,
  parentSessionId?: string,
  title = "New session",
): SessionMeta {
  const now = new Date().toISOString();
  const session: SessionMeta = {
    id: randomUUID(),
    projectId,
    ...(parentSessionId ? { parentSessionId } : {}),
    title,
    createdAt: now,
    updatedAt: now,
  };
  const dir = parentSessionId
    ? sessionDir(projectId, parentSessionId, session.id)
    : sessionDir(projectId, session.id);
  writeJson(join(dir, "session.json"), session);
  writeFileSync(join(dir, "events.jsonl"), "");
  mirror.sessionSaved(session);
  return session;
}

function refDir(ref: SessionRef): string {
  return sessionDir(ref.projectId, ref.sessionId, ref.subagentId);
}

export function readSession(ref: SessionRef): SessionMeta | null {
  return readJson<SessionMeta>(join(refDir(ref), "session.json"));
}

export function updateSessionMeta(
  ref: SessionRef,
  patch: Partial<SessionMeta>,
): SessionMeta | null {
  const meta = readSession(ref);
  if (!meta) return null;
  const updated = { ...meta, ...patch };
  writeJson(join(refDir(ref), "session.json"), updated);
  mirror.sessionSaved(updated);
  return updated;
}

export function readEvents(ref: SessionRef): SessionEvent[] {
  const path = join(refDir(ref), "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

export function appendEvent(
  ref: SessionRef,
  record: Record<string, unknown> & { type: string },
): SessionEvent {
  const dir = refDir(ref);
  const metaPath = join(dir, "session.json");
  const meta = readJson<SessionMeta>(metaPath);
  if (!meta) throw new Error(`No session at ${dir}`);

  const event: SessionEvent = {
    ...record,
    seq: readEvents(ref).length + 1,
    at: new Date().toISOString(),
  };
  appendFileSync(join(dir, "events.jsonl"), JSON.stringify(event) + "\n");

  meta.updatedAt = event.at;
  writeJson(metaPath, meta);
  mirror.sessionSaved(meta);
  mirror.eventAppended(ref.subagentId ?? ref.sessionId, event);
  return event;
}

/** Untitled sessions pick up the start of their latest prompt, lazily,
 *  when the tree is read (covers sessions from before titling existed). */
function backfillTitle(ref: SessionRef, meta: SessionMeta): SessionMeta {
  if (meta.title !== DEFAULT_TITLE) return meta;
  const lastPrompt = readEvents(ref)
    .filter((e) => e.type === "user_message" && typeof e.text === "string")
    .at(-1);
  if (!lastPrompt) return meta;
  const title = titleFromPrompt(String(lastPrompt.text));
  if (title === DEFAULT_TITLE) return meta;
  return updateSessionMeta(ref, { title }) ?? meta;
}

function readSessionNode(projectId: string, sessionId: string): SessionNode | null {
  const dir = sessionDir(projectId, sessionId);
  let session = readJson<SessionMeta>(join(dir, "session.json"));
  if (!session) return null;
  session = backfillTitle({ projectId, sessionId }, session);
  const subagents = listDirs(join(dir, "subagents"))
    .map((subId) => {
      const meta = readJson<SessionMeta>(
        join(sessionDir(projectId, sessionId, subId), "session.json"),
      );
      return meta
        ? backfillTitle({ projectId, sessionId, subagentId: subId }, meta)
        : null;
    })
    .filter((meta): meta is SessionMeta => meta !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { session, subagents };
}

export function getTree(): WorkspaceTree {
  const projects: ProjectNode[] = [];
  for (const projectId of listDirs(projectsDir())) {
    const project = readJson<ProjectInfo>(
      join(projectDir(projectId), "project.json"),
    );
    if (!project || project.closedAt) continue;
    const sessions = listDirs(join(projectDir(projectId), "sessions"))
      .map((sessionId) => readSessionNode(projectId, sessionId))
      .filter((node): node is SessionNode => node !== null)
      .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
    projects.push({ project, sessions });
  }
  projects.sort((a, b) => a.project.name.localeCompare(b.project.name));
  return { projects };
}
