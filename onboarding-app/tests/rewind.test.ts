import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  restoreSnapshot,
  rewindGrokHistory,
  takeSnapshot,
} from "../src/theocode/rewind";
import {
  appendEvent,
  createProject,
  createSession,
  readEvents,
  readSession,
  truncateEvents,
} from "../src/theocode/sessions";
import type { SessionRef } from "../src/theocode/types";

let repo: string;
let home: string;
let grokHome: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "tc-rw-repo-"));
  home = mkdtempSync(join(tmpdir(), "tc-rw-home-"));
  grokHome = mkdtempSync(join(tmpdir(), "tc-rw-grok-"));
  process.env.THEOCODE_HOME = home;
  process.env.GROK_HOME = grokHome;
  execFileSync("git", ["-C", repo, "init", "-q"]);
  writeFileSync(join(repo, "kept.txt"), "original\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
});

afterAll(() => {
  delete process.env.THEOCODE_HOME;
  delete process.env.GROK_HOME;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(grokHome, { recursive: true, force: true });
});

test("snapshot + restore round-trips edits, new files, and deletions", () => {
  writeFileSync(join(repo, "untracked.txt"), "not yet committed\n");
  const sha = takeSnapshot(repo);
  expect(sha).toBeTruthy();

  // Snapshotting must not touch the real index.
  const staged = execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], {
    encoding: "utf8",
  }).trim();
  expect(staged).toBe("");

  writeFileSync(join(repo, "kept.txt"), "mutated\n");
  writeFileSync(join(repo, "created-later.txt"), "should vanish\n");
  rmSync(join(repo, "untracked.txt"));

  restoreSnapshot(repo, sha!);
  expect(readFileSync(join(repo, "kept.txt"), "utf8")).toBe("original\n");
  expect(readFileSync(join(repo, "untracked.txt"), "utf8")).toBe("not yet committed\n");
  expect(existsSync(join(repo, "created-later.txt"))).toBe(false);
});

test("takeSnapshot returns null outside a git checkout", () => {
  const plain = mkdtempSync(join(tmpdir(), "tc-rw-plain-"));
  try {
    expect(takeSnapshot(plain)).toBeNull();
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test("truncateEvents drops the prompt and everything after, retitles", () => {
  const project = createProject(repo);
  const session = createSession(project.id);
  const ref: SessionRef = { projectId: project.id, sessionId: session.id };
  appendEvent(ref, { type: "user_message", text: "first prompt" });
  appendEvent(ref, { type: "agent_message", text: "first answer" });
  const target = appendEvent(ref, { type: "user_message", text: "second prompt" });
  appendEvent(ref, { type: "agent_message", text: "second answer" });

  const kept = truncateEvents(ref, target.seq);
  expect(kept.map((e) => e.type)).toEqual(["user_message", "agent_message"]);
  expect(readEvents(ref)).toHaveLength(2);
  // Title re-derives from the latest surviving prompt.
  expect(readSession(ref)?.title).toBe("first prompt");
  // Appending after a truncation reuses the freed seq numbers.
  const next = appendEvent(ref, { type: "notice", text: "rewound" });
  expect(next.seq).toBe(3);
});

test("rewindGrokHistory truncates at the dropped prompt and backs up", () => {
  const sessionId = "0199-test-session";
  const dir = join(grokHome, "sessions", "%2Ftmp%2Fsomewhere", sessionId);
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "system", content: "sys" },
    { type: "user", content: [{ type: "text", text: "<user_query>first prompt</user_query>" }] },
    { type: "assistant", content: "first answer" },
    { type: "user", content: [{ type: "text", text: "<user_query>second\nprompt</user_query>" }] },
    { type: "assistant", content: "second answer" },
  ];
  writeFileSync(
    join(dir, "chat_history.jsonl"),
    lines.map((l) => JSON.stringify(l) + "\n").join(""),
  );
  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify({ num_chat_messages: 5 }) + "\n",
  );

  expect(rewindGrokHistory(sessionId, "second\nprompt")).toBe(true);
  const kept = readFileSync(join(dir, "chat_history.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim());
  expect(kept).toHaveLength(3);
  expect(JSON.parse(kept.at(-1)!).type).toBe("assistant");
  expect(existsSync(join(dir, "chat_history.jsonl.pre-rewind"))).toBe(true);
  expect(
    JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")).num_chat_messages,
  ).toBe(3);

  // A prompt that never reached grok: refuse rather than guess.
  expect(rewindGrokHistory(sessionId, "no such prompt")).toBe(false);
  expect(rewindGrokHistory("missing-session", "first prompt")).toBe(false);
});
