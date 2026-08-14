import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childrenOf,
  createWorktree,
  removeWorktree,
  setWorktreeScriptSource,
} from "../src/theocode/worktree";

let repo: string;
let locks: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "tc-wt-repo-"));
  const home = mkdtempSync(join(tmpdir(), "tc-wt-home-"));
  locks = join(home, "port-locks");
  process.env.THEOCODE_HOME = home;
  setWorktreeScriptSource(join(import.meta.dir, "..", "resources", "worktree.sh"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  writeFileSync(join(repo, "readme.md"), "hi\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
});

afterAll(() => {
  delete process.env.THEOCODE_HOME;
  rmSync(repo, { recursive: true, force: true });
  rmSync(locks, { recursive: true, force: true });
});

test("top-level worktrees allocate wt-N with distinct port blocks", () => {
  const a = createWorktree(repo);
  const b = createWorktree(repo);
  expect(a.label).toBe("wt-1");
  expect(b.label).toBe("wt-2");
  expect(a.ports.app).toBe(3100);
  expect(b.ports.app).toBe(3200);
  expect(existsSync(join(a.path, ".env.ports"))).toBe(true);
});

test("a caller inside wt-1 gets children wt-1.M branched off wt-1", () => {
  const child = createWorktree(repo, undefined, { label: "wt-1", branch: "wt-1" });
  expect(child.label).toBe("wt-1.1");
  expect(child.branch).toBe("wt-1.1");
  // Child branched from wt-1's branch, not the default branch.
  const mergeBase = execFileSync(
    "git",
    ["-C", repo, "merge-base", "wt-1", "wt-1.1"],
    { encoding: "utf8" },
  ).trim();
  const wt1Head = execFileSync("git", ["-C", repo, "rev-parse", "wt-1"], {
    encoding: "utf8",
  }).trim();
  expect(mergeBase).toBe(wt1Head);
});

test("a caller inside a child gets a SIBLING, never a third level", () => {
  const sibling = createWorktree(repo, undefined, {
    label: "wt-1.1",
    branch: "wt-1.1",
  });
  expect(sibling.label).toBe("wt-1.2");
  expect(childrenOf(repo, "wt-1")).toEqual(["wt-1.1", "wt-1.2"]);
});

test("removing a parent with live children refuses without cascade", () => {
  expect(() => removeWorktree(repo, "wt-1", false)).toThrow(/cascade/);
});

test("cascade removes the family, releases port blocks, keeps branches", () => {
  const before = readdirSync(locks).length;
  const removed = removeWorktree(repo, "wt-1", true);
  expect(removed).toEqual(["wt-1.1", "wt-1.2", "wt-1"]);
  expect(existsSync(join(repo, ".worktrees", "wt-1"))).toBe(false);
  // Three blocks released.
  expect(readdirSync(locks).length).toBe(before - 3);
  // Branches survive.
  const branches = execFileSync("git", ["-C", repo, "branch", "--list"], {
    encoding: "utf8",
  });
  expect(branches).toContain("wt-1.1");
  // Released blocks are reusable, but labels with surviving branches are
  // not — the kept wt-1 branch must never be force-reset by label reuse.
  const next = createWorktree(repo);
  expect(next.ports.app).toBe(3100);
  expect(next.label).toBe("wt-3");
});

test("removal rejects labels that are not wt-N or wt-N.M", () => {
  expect(() => removeWorktree(repo, "..", false)).toThrow(/Invalid worktree name/);
  expect(() => removeWorktree(repo, "wt-1/../..", true)).toThrow(/Invalid worktree name/);
});

test("a project-tailored script survives; a managed one refreshes", () => {
  const script = join(repo, "scripts", "worktree.sh");
  // Managed copy: drift gets refreshed back to the shipped starter.
  writeFileSync(script, "# theocode-managed: replace-on-update\n# drifted\n");
  createWorktree(repo); // ensure runs as part of any call
  expect(readFileSync(script, "utf8")).toContain("cmd_new");
  // Tailored copy (marker changed): never overwritten — but it must keep the
  // output contract, which this stub does.
  const tailored = [
    "#!/usr/bin/env bash",
    "# theocode-managed: project-tailored",
    'if [ "$1" = new ]; then',
    '  echo "WT_LABEL=wt-9"; echo "WT_BRANCH=wt-9"; echo "WT_PATH=$PWD/.worktrees/wt-9";',
    '  echo "WT_APP_PORT=3900"; echo "WT_SB_PORT=55221";',
    "else",
    '  echo "WT_REMOVED=wt-9"',
    "fi",
  ].join("\n");
  writeFileSync(script, tailored);
  const info = createWorktree(repo);
  expect(info.label).toBe("wt-9");
  expect(info.ports.app).toBe(3900);
  expect(readFileSync(script, "utf8")).toBe(tailored);
});
