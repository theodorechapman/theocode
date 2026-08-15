import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { dbPath } from "./paths";
import type { ProjectInfo, SessionEvent, SessionMeta } from "./types";

// Sqlite mirror of the filesystem store (sql.js keeps it dependency-light:
// pure wasm, no native rebuild against Electron). Reads still come from the
// filesystem; this index exists so later features can query instead of walk.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  parent_session_id TEXT,
  title             TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  at         TEXT NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
`;

let db: Database | null = null;
let ready: Promise<void> | null = null;
let flushTimer: NodeJS.Timeout | null = null;

async function open(): Promise<void> {
  const SQL = await initSqlJs({
    // Resolved at runtime from node_modules (sql.js stays external to the bundle).
    locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm"),
  });
  const path = dbPath();
  db = existsSync(path) ? new SQL.Database(readFileSync(path)) : new SQL.Database();
  db.run(SCHEMA);
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDb();
  }, 500);
}

export function flushDb(): void {
  if (!db) return;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(db.export()));
}

/** Queues a write so callers stay synchronous while the wasm module loads. */
function enqueue(run: (database: Database) => void): void {
  ready ??= open();
  ready = ready
    .then(() => {
      run(db!);
      scheduleFlush();
    })
    .catch((err) => {
      console.error("theocode sqlite mirror failed:", err);
    });
}

export const mirror = {
  projectSaved(project: ProjectInfo): void {
    enqueue((database) =>
      database.run(
        "INSERT OR REPLACE INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)",
        [project.id, project.name, project.path, project.createdAt],
      ),
    );
  },

  sessionSaved(session: SessionMeta): void {
    enqueue((database) =>
      database.run(
        "INSERT OR REPLACE INTO sessions (id, project_id, parent_session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          session.id,
          session.projectId,
          session.parentSessionId ?? null,
          session.title,
          session.createdAt,
          session.updatedAt,
        ],
      ),
    );
  },

  eventAppended(sessionId: string, event: SessionEvent): void {
    enqueue((database) =>
      database.run(
        "INSERT OR REPLACE INTO events (session_id, seq, at, type, payload) VALUES (?, ?, ?, ?, ?)",
        [sessionId, event.seq, event.at, event.type, JSON.stringify(event)],
      ),
    );
  },

  eventsTruncated(sessionId: string, fromSeq: number): void {
    enqueue((database) =>
      database.run("DELETE FROM events WHERE session_id = ? AND seq >= ?", [
        sessionId,
        fromSeq,
      ]),
    );
  },
};
