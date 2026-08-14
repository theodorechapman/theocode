#!/usr/bin/env node
// Launches a command (default: electron .) with an exclusive dev instance:
// several agents can run the app from their own worktrees at once without
// colliding on ports or on Electron's userData directory.
//
// Each instance claims a block of 10 ports starting at 43000 + 10*n, guarded
// by a lock file in ~/.theocode/dev-locks. The chosen block is exported as:
//   THEOCODE_INSTANCE    "n" — main.ts suffixes userData with this
//   THEOCODE_PORT_BASE   first port of the block
//   THEOCODE_AGENT_PORT  base+0, reserved for `grok agent serve`
//   THEOCODE_DEV_PORT    base+1, reserved for a future dev/reload server
//
// Usage: node scripts/dev.mjs [-- <command...>]

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = 43000;
const BLOCK = 10;
const MAX_INSTANCES = 50;
const LOCK_DIR = join(
  process.env.THEOCODE_HOME ?? join(homedir(), ".theocode"),
  "dev-locks",
);

function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryLock(n) {
  mkdirSync(LOCK_DIR, { recursive: true });
  const path = join(LOCK_DIR, `instance-${n}.lock`);
  try {
    const holder = Number(readFileSync(path, "utf8").trim());
    if (pidAlive(holder)) return null;
    rmSync(path); // stale lock from a dead process
  } catch {
    // no lock file — free
  }
  try {
    writeFileSync(path, String(process.pid), { flag: "wx" });
    return path;
  } catch {
    return null; // raced another launcher
  }
}

async function claimInstance() {
  for (let n = 0; n < MAX_INSTANCES; n++) {
    const lock = tryLock(n);
    if (!lock) continue;
    const base = BASE + n * BLOCK;
    const checks = await Promise.all(
      Array.from({ length: BLOCK }, (_, i) => portFree(base + i)),
    );
    if (checks.every(Boolean)) return { n, base, lock };
    rmSync(lock, { force: true }); // ports taken by something else — move on
  }
  throw new Error(`No free dev instance below ${MAX_INSTANCES}`);
}

const { n, base, lock } = await claimInstance();
const sep = process.argv.indexOf("--");
const command = sep === -1 ? ["electron", "."] : process.argv.slice(sep + 1);

console.log(`theocode dev instance ${n} (ports ${base}-${base + BLOCK - 1})`);
const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env: {
    ...process.env,
    // Let bare "electron" resolve when the script is run outside bun/npm.
    PATH: `${join(process.cwd(), "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
    THEOCODE_INSTANCE: String(n),
    THEOCODE_PORT_BASE: String(base),
    THEOCODE_AGENT_PORT: String(base),
    THEOCODE_DEV_PORT: String(base + 1),
  },
});

function release() {
  rmSync(lock, { force: true });
}
child.on("exit", (code) => {
  release();
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
