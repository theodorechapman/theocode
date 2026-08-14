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

function readSessionNode(projectId: string, sessionId: string): SessionNode | null {
  const dir = sessionDir(projectId, sessionId);
  const session = readJson<SessionMeta>(join(dir, "session.json"));
  if (!session) return null;
  const subagents = listDirs(join(dir, "subagents"))
    .map((subId) =>
      readJson<SessionMeta>(
        join(sessionDir(projectId, sessionId, subId), "session.json"),
      ),
    )
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
    if (!project) continue;
    const sessions = listDirs(join(projectDir(projectId), "sessions"))
      .map((sessionId) => readSessionNode(projectId, sessionId))
      .filter((node): node is SessionNode => node !== null)
      .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
    projects.push({ project, sessions });
  }
  projects.sort((a, b) => a.project.name.localeCompare(b.project.name));
  return { projects };
}
