import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { runOAuthFlow } from "./oauth";
import { getProvider, GROK_CLIENT_ID, GROK_ISSUER } from "./providers";
import {
  readGrokCliAuth,
  removeGrokCliAuth,
  unregisterProxyFromUserScope,
  writeGrokCliAuth,
} from "./grok";
import { setActiveProxy, startProxy, type RunningProxy } from "./proxy";
import {
  getConnections,
  getCredentials,
  removeConnection,
  saveConnection,
  updateTokens,
} from "./store";
import {
  appendEvent,
  createProject,
  createSession,
  getTree,
  readEvents,
  readSession,
  titleFromPrompt,
  truncateEvents,
  updateSessionMeta,
} from "./theocode/sessions";
import {
  restoreSnapshot,
  rewindGrokHistory,
  takeSnapshot,
} from "./theocode/rewind";
import {
  childrenOf,
  createWorktree,
  removeWorktree,
  setWorktreeScriptSource,
} from "./theocode/worktree";
import {
  codeResultText,
  codeTasks,
  coderPrompt,
  DEFAULT_PARALLEL,
  newCodeTask,
  pendingCodeFor,
  queuedCodeFor,
  runningCodeCountFor,
  validateCards,
} from "./theocode/coding";
import {
  MAX_QUESTION_CHARS,
  newResearchTask,
  pendingFor,
  reportFromEvents,
  researcherPrompt,
  researchTasks,
  resultText,
} from "./theocode/research";
import { getProject, updateProject } from "./theocode/sessions";
import { detectStack, installSetupSkill, runProjectSetup } from "./theocode/setup";
import { runAgentTurn, type TurnHandle, type TurnSinks } from "./theocode/turn";
import { loadAsyncTasks, saveAsyncTasks } from "./theocode/asyncTasks";
import { flushDb } from "./theocode/db";
import { isReasoningEffort } from "./theocode/reasoning";
import type { ReasoningEffort, SessionRef, SetupAnswers } from "./theocode/types";
import type { ConnectionInfo, ConnectResult, ProviderId } from "./types";

// scripts/dev.mjs assigns each dev instance its own suffix (and port block) so
// parallel agents' Electron processes never share a userData dir or ports.
const instance = process.env.THEOCODE_INSTANCE;
if (instance) {
  app.setPath("userData", `${app.getPath("userData")}-${instance}`);
}

let win: BrowserWindow | null = null;
const inFlight = new Set<ProviderId>();

// ---- Loopback MCP proxy ----------------------------------------------------
// The grok CLI talks to theocode at http://127.0.0.1:<port>/{supabase,vercel};
// theocode forwards each request upstream with its own bearer token attached.

const PROXY_ROUTES: Record<string, ProviderId> = {
  supabase: "supabase",
  vercel: "vercel",
};
let proxy: RunningProxy | null = null;
let proxySecret = "";

function loadProxySecret(): string {
  const path = join(app.getPath("userData"), "proxy-secret");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {
    // First run — generate below.
  }
  const secret = randomBytes(24).toString("base64url");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

/** The agent session currently running a turn for this project, if any. */
function activeTurnRef(projectId: string): SessionRef | null {
  for (const key of turnsInFlight.keys()) {
    const [p, s, sub] = key.split("/");
    if (p === projectId && !sub) return { projectId: p, sessionId: s };
  }
  return null;
}

/** Exact caller resolution: worktree labels bind 1:1 to sessions. */
function sessionByWorktreeLabel(
  projectId: string,
  label: string,
): SessionRef | null {
  for (const node of getTree().projects) {
    if (node.project.id !== projectId) continue;
    for (const { session, subagents } of node.sessions) {
      const match = (m: { worktree?: { label?: string; n?: number } }) =>
        (m.worktree?.label ?? (m.worktree?.n !== undefined ? `wt-${m.worktree.n}` : null)) === label;
      if (match(session)) return { projectId, sessionId: session.id };
      for (const sub of subagents) {
        if (match(sub)) {
          return { projectId, sessionId: session.id, subagentId: sub.id };
        }
      }
    }
  }
  return null;
}

/** Prefer the exact per-workdir identity; fall back to the in-flight guess
 *  (only main-checkout sessions still need the guess). */
function callerRef(projectId: string, callerLabel?: string): SessionRef | null {
  if (callerLabel) {
    const exact = sessionByWorktreeLabel(projectId, callerLabel);
    if (exact) return exact;
  }
  return activeTurnRef(projectId);
}

async function handleCreateWorktree(
  projectId: string,
  branch: string | undefined,
  callerLabel?: string,
): Promise<string> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  // Hierarchy is inferred from the calling session: inside wt-N you get
  // children wt-N.M (branched from wt-N's branch); inside a child you get
  // siblings. Two levels is a hard limit.
  const ref = callerRef(projectId, callerLabel);
  const callerWt = ref ? readSession(ref)?.worktree : undefined;
  const info = createWorktree(
    project.path,
    branch,
    callerWt?.label
      ? { label: callerWt.label, branch: callerWt.branch }
      : callerWt?.n !== undefined
        ? { label: `wt-${callerWt.n}`, branch: callerWt.branch }
        : undefined,
  );
  if (ref) {
    updateSessionMeta(ref, {
      worktree: { label: info.label, branch: info.branch, path: info.path },
    });
    win?.webContents.send("workspace:tree-changed");
  }
  const mergeNote = info.label.includes(".")
    ? `This is a child of ${info.label.split(".")[0]}: it branched from that worktree's branch and should merge back into it, not into the default branch.`
    : null;
  return [
    `Worktree ${info.label} created at ${info.path} (branch ${info.branch}).`,
    ...(mergeNote ? [mergeNote] : []),
    `Do ALL further work for this task inside ${info.path}: run every command there (cd ${info.path}) and edit files under that directory only.`,
    `Reserved ports for this worktree (also written to .env.ports): PORT/APP_PORT=${info.ports.app}, SUPABASE_API_PORT=${info.ports.supabaseApi}, SUPABASE_DB_PORT=${info.ports.supabaseDb}, SUPABASE_STUDIO_PORT=${info.ports.supabaseStudio}. Use them for any dev servers or local stacks so parallel worktrees never collide.`,
  ].join("\n");
}

async function handleRemoveWorktree(
  projectId: string,
  label: string,
  cascade: boolean,
): Promise<string> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  if (!/^wt-\d+(\.\d+)?$/.test(label)) {
    throw new Error(`Invalid worktree name "${label}" — expected wt-N or wt-N.M.`);
  }

  // Never delete a worktree out from under a running turn — including the
  // turn that is invoking this tool.
  const doomed = new Set([label, ...childrenOf(project.path, label)]);
  const sessionLabel = (s: { worktree?: { label?: string; n?: number } }) =>
    s.worktree?.label ?? (s.worktree?.n !== undefined ? `wt-${s.worktree.n}` : null);
  for (const key of turnsInFlight.keys()) {
    const [p, sessionId, sub] = key.split("/");
    if (p !== projectId || sub) continue;
    const meta = readSession({ projectId, sessionId });
    const wt = meta ? sessionLabel(meta) : null;
    if (wt && doomed.has(wt)) {
      throw new Error(
        `${label} is in use: session "${meta?.title}" has a turn running in ${wt}. Finish or interrupt that turn first.`,
      );
    }
  }

  const removed = removeWorktree(project.path, label, cascade);
  const removedPaths = removed.map((name) =>
    join(project.path, ".worktrees", name),
  );
  // Clear stale bindings so no session keeps a dead cwd (covering both the
  // label shape and the legacy {n}/path-only shape).
  for (const projectNode of getTree().projects) {
    if (projectNode.project.id !== projectId) continue;
    for (const { session } of projectNode.sessions) {
      const wt = session.worktree;
      if (!wt) continue;
      const byLabel = sessionLabel(session);
      if (
        (byLabel && removed.includes(byLabel)) ||
        removedPaths.some((p) => wt.path === p || wt.path.startsWith(`${p}/`))
      ) {
        updateSessionMeta(
          { projectId, sessionId: session.id },
          { worktree: undefined },
        );
      }
    }
  }
  win?.webContents.send("workspace:tree-changed");
  return `Removed ${removed.join(", ")} and released their port blocks. Branches were kept. Sessions that lived there now run in the main checkout again.`;
}

async function startProxyAndSync(): Promise<void> {
  proxySecret = loadProxySecret();
  proxy = await startProxy({
    localSecret: proxySecret,
    routes: PROXY_ROUTES,
    localServers: {
      wt: {
        serverName: "theocode-wt",
        tools: [
          {
            name: "theocode-wt",
            description:
              "Create a fresh, non-conflicting git worktree for this project with its own reserved port block, and continue your work inside it. Commit your current work first. From the main checkout you get a top-level wt-N; from inside wt-N you get a child wt-N.M branched off wt-N (merge it back into wt-N). Nesting is capped at two levels.",
            inputSchema: {
              type: "object",
              properties: {
                branch: {
                  type: "string",
                  description:
                    "Branch name for the worktree. Defaults to its label (wt-N or wt-N.M).",
                },
              },
            },
          },
          {
            name: "theocode-wt-remove",
            description:
              "Remove a worktree by name (e.g. wt-2 or wt-2.1) and release its ports. A parent with live children refuses unless cascade is true, which removes the whole family. Branches are kept.",
            inputSchema: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", description: "Worktree label to remove." },
                cascade: {
                  type: "boolean",
                  description: "Also remove all wt-N.* children.",
                },
              },
            },
          },
        ],
        call: (projectId, name, args, caller) =>
          name === "theocode-wt"
            ? handleCreateWorktree(
                projectId,
                typeof args.branch === "string" ? args.branch : undefined,
                caller,
              )
            : handleRemoveWorktree(
                projectId,
                String(args.name ?? ""),
                args.cascade === true,
              ),
      },
      research: {
        serverName: "theocode-research",
        tools: [
          {
            name: "theocode-research",
            description:
              "Spawn a research subagent to answer one question. The question is delivered to the researcher verbatim and alone — put your hypotheses and context in `hypothesis`, which the researcher NEVER sees (it is echoed back to you with the report). Returns immediately; poll with theocode-research-poll, or the report interrupts you after your turn ends.",
            inputSchema: {
              type: "object",
              required: ["question"],
              properties: {
                question: {
                  type: "string",
                  description: `The research question, stated plainly, and include any hard requirements (size, license, format, acceptance criteria) — the researcher sees ONLY this field. Max ${MAX_QUESTION_CHARS} characters; no background, no hypotheses.`,
                },
                hypothesis: {
                  type: "string",
                  description:
                    "Optional: your guesses, context, and why you ask. Held back from the researcher to keep the exploration pure.",
                },
              },
            },
          },
          {
            name: "theocode-research-poll",
            description:
              "Check a research task. Returns the report when it is finished, or its running status.",
            inputSchema: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string", description: "The research id." },
              },
            },
          },
        ],
        call: (projectId, name, args, caller) =>
          name === "theocode-research"
            ? handleResearchStart(projectId, args, caller)
            : Promise.resolve(handleResearchPoll(projectId, args)),
      },
      code: {
        serverName: "theocode-code",
        tools: [
          {
            name: "theocode-code",
            description:
              "Fan out coding subagents, one per task card, each in its own child worktree branched from yours. A card is a self-contained contract: goal (one sentence), spec, files_in_scope, done_criteria. notes_for_merge is private to you — the subagent NEVER sees it; it returns with the result. Returns immediately; poll with theocode-code-poll, or results interrupt you with a merge playbook after your turn ends.",
            inputSchema: {
              type: "object",
              required: ["cards"],
              properties: {
                cards: {
                  type: "array",
                  description: "Task cards (max 8).",
                  items: {
                    type: "object",
                    required: ["goal", "spec", "files_in_scope", "done_criteria"],
                    properties: {
                      goal: { type: "string", description: "One sentence." },
                      spec: {
                        type: "string",
                        description: "The contract: what to build, interfaces, behavior.",
                      },
                      files_in_scope: {
                        type: "array",
                        items: { type: "string" },
                        description: "Paths the task may modify.",
                      },
                      done_criteria: {
                        type: "array",
                        items: { type: "string" },
                        description: "Verifiable checks.",
                      },
                      notes_for_merge: {
                        type: "string",
                        description:
                          "Private integration context, held back from the subagent.",
                      },
                    },
                  },
                },
                parallel: {
                  type: "number",
                  description: "Max concurrent subagents (default 3).",
                },
              },
            },
          },
          {
            name: "theocode-code-poll",
            description:
              "Check a code task. Returns the result and merge playbook when finished, or its running status.",
            inputSchema: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string", description: "The code task id." },
              },
            },
          },
        ],
        call: (projectId, name, args, caller) =>
          name === "theocode-code"
            ? handleCodeStart(projectId, args, caller)
            : Promise.resolve(handleCodePoll(projectId, args)),
      },
    },
    getCredentials: (providerId) => {
      const creds = getCredentials(providerId as ProviderId);
      if (!creds) return null;
      return {
        accessToken: creds.tokens.access_token,
        refreshToken: creds.tokens.refresh_token,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        tokenEndpoint: creds.tokenEndpoint,
        resource: creds.resource,
      };
    },
    saveTokens: (providerId, tokens) =>
      updateTokens(providerId as ProviderId, tokens),
  });
  setActiveProxy(proxy.port, proxySecret);
  // Dev/tooling convenience: the actual bound port, next to the secret.
  writeFileSync(join(app.getPath("userData"), "proxy-port"), String(proxy.port));
  // Registration is now per-project (turn.ts syncProjectMcp); drop any
  // user-scope entries left behind by earlier versions.
  await Promise.all(
    Object.keys(PROXY_ROUTES).map((route) =>
      unregisterProxyFromUserScope(`theocode-${route}`),
    ),
  );
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1024,
    height: 680,
    minWidth: 760,
    minHeight: 600,
    title: "theocode",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(app.getAppPath(), "dist", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Evidence tabs render URLs in <webview> guests.
      webviewTag: true,
    },
  });
  win.loadFile(join(app.getAppPath(), "dist", "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => {
    win = null;
  });

  const shotPath = process.env.THEOCODE_SCREENSHOT;
  if (shotPath) {
    win.setMinimumSize(360, 600);
    const theme = process.env.THEOCODE_THEME;
    if (theme === "light" || theme === "dark") nativeTheme.themeSource = theme;
    win.webContents.on("did-finish-load", async () => {
      const delay = Number(process.env.THEOCODE_SCREENSHOT_DELAY_MS) || 1500;
      await new Promise((r) => setTimeout(r, delay));
      if (process.env.THEOCODE_SCREENSHOT_THEME === "light") {
        await win!.webContents.executeJavaScript(
          `document.body.classList.add("light-theme");document.body.classList.remove("dark-theme");`,
        );
      }
      const width = Number(process.env.THEOCODE_WINDOW_WIDTH);
      const height = Number(process.env.THEOCODE_WINDOW_HEIGHT);
      if (width > 0 && height > 0) win!.setSize(width, height);
      const script = process.env.THEOCODE_SCREENSHOT_JS;
      const click = process.env.THEOCODE_SCREENSHOT_CLICK;
      if (script) {
        await win!.webContents.executeJavaScript(script);
      } else if (click) {
        await win!.webContents.executeJavaScript(
          `document.querySelector(${JSON.stringify(click)})?.click()`,
        );
      }
      if (script || click) await new Promise((r) => setTimeout(r, 800));
      const image = await win!.webContents.capturePage();
      const { writeFileSync } = await import("node:fs");
      writeFileSync(shotPath, image.toPNG());
      app.quit();
    });
  }
}

// The grok connection's source of truth is the CLI's own credential store,
// so an existing `grok login` shows up as connected here.
function grokConnection(): ConnectionInfo | undefined {
  const status = readGrokCliAuth(GROK_ISSUER, GROK_CLIENT_ID);
  if (!status) return undefined;
  return {
    providerId: "grok",
    connectedAt: status.createdAt ?? "",
    account: status.email,
    expiresAt: status.expiresAt,
  };
}

ipcMain.handle("connections:get", () => {
  const connections = getConnections();
  delete connections.grok;
  const grok = grokConnection();
  if (grok) connections.grok = grok;
  return connections;
});

ipcMain.handle(
  "oauth:connect",
  async (_event, providerId: ProviderId): Promise<ConnectResult> => {
    if (inFlight.has(providerId)) {
      return { ok: false, error: "A sign-in for this provider is already in progress" };
    }
    inFlight.add(providerId);
    try {
      const provider = getProvider(providerId);
      const outcome = await runOAuthFlow(
        provider,
        (url) => shell.openExternal(url),
        (phase) => win?.webContents.send("oauth:progress", { providerId, phase }),
      );
      const connection: ConnectionInfo = {
        providerId,
        connectedAt: new Date().toISOString(),
        account: outcome.account,
        scopes: outcome.scopes,
        expiresAt: outcome.expiresAt,
      };
      if (providerId === "grok") {
        writeGrokCliAuth(GROK_ISSUER, GROK_CLIENT_ID, outcome);
      } else {
        saveConnection(connection, {
          tokens: outcome.tokens,
          clientId: outcome.client.clientId,
          clientSecret: outcome.client.clientSecret,
          tokenEndpoint: outcome.client.tokenEndpoint,
          resource: outcome.resource ?? "",
        });
      }
      return { ok: true, connection };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      inFlight.delete(providerId);
    }
  },
);

ipcMain.handle("connections:disconnect", async (_event, providerId: ProviderId) => {
  if (providerId === "grok") {
    removeGrokCliAuth(GROK_ISSUER, GROK_CLIENT_ID);
  } else {
    removeConnection(providerId);
  }
});

ipcMain.handle("workspace:tree", () => getTree());

ipcMain.handle("workspace:createProject", async () => {
  const result = await dialog.showOpenDialog(win!, {
    title: "Choose a project directory",
    properties: ["openDirectory", "createDirectory"],
  });
  const path = result.filePaths[0];
  if (result.canceled || !path) return null;
  return createProject(path);
});

ipcMain.handle("workspace:createSession", (_event, projectId: string) =>
  createSession(projectId),
);

ipcMain.handle("workspace:events", (_event, ref: SessionRef) => readEvents(ref));

// ---- Agent turns -----------------------------------------------------------

const turnsInFlight = new Map<string, TurnHandle>();

function broadcastActiveTurns(): void {
  win?.webContents.send("workspace:active-turns", [...turnsInFlight.keys()]);
}

function trackTurn(key: string, handle: TurnHandle): void {
  turnsInFlight.set(key, handle);
  broadcastActiveTurns();
}

function untrackTurn(key: string): void {
  turnsInFlight.delete(key);
  broadcastActiveTurns();
}

function turnKey(ref: SessionRef): string {
  return `${ref.projectId}/${ref.sessionId}/${ref.subagentId ?? ""}`;
}

function turnSinks(extra?: Partial<TurnSinks>): TurnSinks {
  return {
    onEvent: (ref, event) =>
      win?.webContents.send("workspace:event", { ref, event }),
    onPartial: (ref, partial) =>
      win?.webContents.send("workspace:partial", { ref, partial }),
    ...extra,
  };
}

// research sub-turn key -> research task id, so onTurnFinished can finalize.
const researchTurnKeys = new Map<string, string>();
// code sub-turn key -> code task id.
const codeTurnKeys = new Map<string, string>();

/** Starts a turn unless the session is busy. Returns whether it started. */
function startTurn(
  ref: SessionRef,
  prompt: string,
  opts?: { research?: boolean; coding?: boolean },
): boolean {
  const key = turnKey(ref);
  if (turnsInFlight.has(key)) return false;
  const project = getProject(ref.projectId);
  const session = readSession(ref);
  if (!project || !session) return false;
  const handle = runAgentTurn(
    project,
    session,
    ref,
    prompt,
    turnSinks({
      onDone: (code) => {
        untrackTurn(key);
        onTurnFinished(ref, code);
      },
    }),
    { research: opts?.research, coding: opts?.coding },
  );
  trackTurn(key, handle);
  return true;
}

function onTurnFinished(ref: SessionRef, code: number | null): void {
  const researchId = researchTurnKeys.get(turnKey(ref));
  if (researchId) {
    researchTurnKeys.delete(turnKey(ref));
    finalizeResearch(researchId, code);
    return;
  }
  const codeId = codeTurnKeys.get(turnKey(ref));
  if (codeId) {
    codeTurnKeys.delete(turnKey(ref));
    finalizeCodeTask(codeId, code);
    return;
  }
  deliverPendingAsync(ref);
}

function finalizeResearch(taskId: string, code: number | null): void {
  const task = researchTasks.get(taskId);
  if (!task) return;
  task.report = reportFromEvents(readEvents(task.subRef)) ?? undefined;
  task.status = code === 0 ? "done" : "failed";
  saveAsyncTasks();
  if (task.parentRef) deliverPendingAsync(task.parentRef);
}

function finalizeCodeTask(taskId: string, code: number | null): void {
  const task = codeTasks.get(taskId);
  if (!task || !task.subRef) return;
  task.result = reportFromEvents(readEvents(task.subRef)) ?? undefined;
  task.status = code === 0 && task.result ? "done" : "failed";
  saveAsyncTasks();
  // A slot freed up — start the next queued card for this coordinator.
  launchQueuedCodeTasks(task.parentRef);
  deliverPendingAsync(task.parentRef);
}

function launchQueuedCodeTasks(parentRef: SessionRef): void {
  const project = getProject(parentRef.projectId);
  if (!project) return;
  for (const task of queuedCodeFor(parentRef)) {
    if (runningCodeCountFor(parentRef) >= task.parallelLimit) break;
    try {
      launchCodeTask(project, task);
    } catch (err) {
      task.status = "failed";
      task.result = `Failed to launch: ${err instanceof Error ? err.message : err}`;
    }
  }
}

/** The interrupt: once the parent is idle, unclaimed research reports and
 *  finished code tasks start a turn together. */
function deliverPendingAsync(parentRef: SessionRef): void {
  if (turnsInFlight.has(turnKey(parentRef))) return;
  const research = pendingFor(parentRef);
  const code = pendingCodeFor(parentRef);
  if (research.length === 0 && code.length === 0) return;
  const parts: string[] = [];
  for (const task of research) {
    task.claimed = true;
    const text = resultText(task);
    parts.push(text);
    const event = appendEvent(parentRef, { type: "research_result", text });
    win?.webContents.send("workspace:event", { ref: parentRef, event });
  }
  for (const task of code) {
    task.claimed = true;
    const text = codeResultText(task);
    parts.push(text);
    const event = appendEvent(parentRef, { type: "code_result", text });
    win?.webContents.send("workspace:event", { ref: parentRef, event });
  }
  if (!startTurn(parentRef, parts.join("\n\n---\n\n"))) {
    for (const task of [...research, ...code]) task.claimed = false;
  }
  saveAsyncTasks();
}

async function handleResearchStart(
  projectId: string,
  args: Record<string, unknown>,
  callerLabel?: string,
): Promise<string> {
  const question = String(args.question ?? "").trim();
  const hypothesis =
    typeof args.hypothesis === "string" && args.hypothesis.trim()
      ? args.hypothesis.trim()
      : undefined;
  if (!question) throw new Error("Provide a research question.");
  if (question.length > MAX_QUESTION_CHARS) {
    throw new Error(
      `Question too long (${question.length} > ${MAX_QUESTION_CHARS} chars). State only the question; move your context and guesses into the hypothesis field — the researcher never sees it.`,
    );
  }
  const project = getProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);

  const parentRef = callerRef(projectId, callerLabel);
  const sub = createSession(
    project.id,
    parentRef?.sessionId,
    question.length > 60 ? `${question.slice(0, 57)}…` : question,
  );
  const subRef: SessionRef = parentRef
    ? { projectId: project.id, sessionId: parentRef.sessionId, subagentId: sub.id }
    : { projectId: project.id, sessionId: sub.id };

  const task = newResearchTask(parentRef, subRef, question, hypothesis);
  const parentEffort = parentRef
    ? readSession(parentRef)?.reasoningEffort
    : undefined;
  updateSessionMeta(subRef, {
    question,
    ...(parentEffort ? { reasoningEffort: parentEffort } : {}),
  });
  const prompt = researcherPrompt(question);
  const event = appendEvent(subRef, { type: "user_message", text: prompt });
  win?.webContents.send("workspace:event", { ref: subRef, event });
  win?.webContents.send("workspace:tree-changed");
  researchTurnKeys.set(turnKey(subRef), task.id);
  if (!startTurn(subRef, prompt, { research: true })) {
    researchTurnKeys.delete(turnKey(subRef));
    throw new Error("Could not start the researcher");
  }
  return [
    `Research ${task.id} started: "${question}".`,
    `The researcher sees only that question${hypothesis ? "; your hypothesis stays with me and comes back with the report" : ""}.`,
    `Keep working. Poll with theocode-research-poll {"id":"${task.id}"} if you want the result mid-turn; otherwise it will interrupt you once your turn ends.`,
  ].join(" ");
}

function handleResearchPoll(
  projectId: string,
  args: Record<string, unknown>,
): string {
  const id = String(args.id ?? "");
  const task = researchTasks.get(id);
  if (!task || task.subRef.projectId !== projectId) {
    throw new Error(`Unknown research id: ${id}`);
  }
  if (task.status === "running") {
    return `Research ${id} is still running. Keep working and poll again later, or finish your turn and it will interrupt you.`;
  }
  task.claimed = true;
  saveAsyncTasks();
  return resultText(task);
}

function launchCodeTask(project: ReturnType<typeof getProject> & object, task: import("./theocode/coding").CodeTask): void {
  const parentMeta = readSession(task.parentRef);
  const parentWt = parentMeta?.worktree;
  const parentLabel =
    parentWt?.label ?? (parentWt?.n !== undefined ? `wt-${parentWt.n}` : undefined);
  const info = createWorktree(
    project.path,
    undefined,
    parentLabel && parentWt
      ? { label: parentLabel, branch: parentWt.branch }
      : undefined,
  );
  const sub = createSession(
    project.id,
    task.parentRef.sessionId,
    task.card.goal.length > 60 ? `${task.card.goal.slice(0, 57)}…` : task.card.goal,
  );
  const subRef: SessionRef = {
    projectId: project.id,
    sessionId: task.parentRef.sessionId,
    subagentId: sub.id,
  };
  updateSessionMeta(subRef, {
    worktree: { label: info.label, branch: info.branch, path: info.path },
  });
  task.subRef = subRef;
  task.wtLabel = info.label;
  task.branch = info.branch;
  task.wtPath = info.path;
  task.status = "running";
  const prompt = coderPrompt(task.card);
  const event = appendEvent(subRef, { type: "user_message", text: prompt });
  win?.webContents.send("workspace:event", { ref: subRef, event });
  win?.webContents.send("workspace:tree-changed");
  codeTurnKeys.set(turnKey(subRef), task.id);
  if (!startTurn(subRef, prompt, { coding: true })) {
    codeTurnKeys.delete(turnKey(subRef));
    task.status = "failed";
    task.result = "Could not start the coding subagent";
  }
}

async function handleCodeStart(
  projectId: string,
  args: Record<string, unknown>,
  callerLabel?: string,
): Promise<string> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const cards = validateCards(args.cards);
  const parallel = Math.max(
    1,
    Math.min(8, Number(args.parallel) || DEFAULT_PARALLEL),
  );
  const parentRef = callerRef(projectId, callerLabel);
  if (!parentRef) {
    throw new Error("Could not identify the calling session for this fan-out.");
  }
  const parentMeta = readSession(parentRef);
  const parentWt = parentMeta?.worktree;
  const mergeTarget = parentWt
    ? {
        path: parentWt.path,
        label: parentWt.label ?? (parentWt.n !== undefined ? `wt-${parentWt.n}` : null),
      }
    : { path: project.path, label: null };

  const tasks = cards.map((card) =>
    newCodeTask(parentRef, mergeTarget, card, parallel),
  );
  saveAsyncTasks();
  launchQueuedCodeTasks(parentRef);
  const launched = tasks.filter((t) => t.status === "running").length;
  return [
    `${tasks.length} code task(s) created: ${tasks.map((t) => `${t.id} ("${t.card.goal.slice(0, 50)}")`).join(", ")}.`,
    `${launched} running now (parallel cap ${parallel}), the rest start as slots free up.`,
    `Each runs in its own child worktree branched from ${mergeTarget.label ?? "the main checkout"}; subagents see only their card.`,
    `Keep working. Poll with theocode-code-poll {"id": "<id>"}, or results will interrupt you with a merge playbook after your turn ends.`,
  ].join(" ");
}

function handleCodePoll(
  projectId: string,
  args: Record<string, unknown>,
): string {
  const id = String(args.id ?? "");
  const task = codeTasks.get(id);
  if (!task || task.parentRef.projectId !== projectId) {
    throw new Error(`Unknown code task id: ${id}`);
  }
  if (task.status === "queued" || task.status === "running") {
    return `Code task ${id} is ${task.status}${task.wtLabel ? ` in ${task.wtLabel}` : ""}. Keep working and poll again later, or finish your turn and it will interrupt you.`;
  }
  task.claimed = true;
  saveAsyncTasks();
  return codeResultText(task);
}

ipcMain.handle(
  "workspace:send",
  (_event, ref: SessionRef, text: string) => {
    // Research subagents are agent-driven; the UI never prompts them.
    const session = readSession(ref);
    if (session?.question) return readEvents(ref);

    // Stamp the prompt with a snapshot of the workdir so a later rewind can
    // offer to restore files to exactly this moment. Null (not a git repo,
    // snapshot failed) just means rewind won't offer file restore here.
    const workdir =
      session?.worktree?.path ?? getProject(ref.projectId)?.path;
    const snapshotSha =
      !ref.subagentId && workdir ? takeSnapshot(workdir) : null;
    const event = appendEvent(ref, {
      type: "user_message",
      text,
      ...(snapshotSha ? { snapshotSha } : {}),
    });
    win?.webContents.send("workspace:event", { ref, event });
    // Sessions are titled by their latest prompt (grok never names them).
    updateSessionMeta(ref, { title: titleFromPrompt(text) });

    // Subagent sessions are driven by theocode; only store there.
    if (!ref.subagentId && !startTurn(ref, text)) {
      if (turnsInFlight.has(turnKey(ref))) {
        const notice = appendEvent(ref, {
          type: "notice",
          text: "A turn is already running. The message was stored but not sent to the agent.",
        });
        win?.webContents.send("workspace:event", { ref, event: notice });
      }
    }
    return readEvents(ref);
  },
);

ipcMain.handle("workspace:activeTurns", () => [...turnsInFlight.keys()]);

ipcMain.handle("workspace:interrupt", (_event, ref: SessionRef) => {
  turnsInFlight.get(turnKey(ref))?.interrupt();
});

// Rewind the session to just before the user prompt at `seq`: drop that
// prompt and everything after it from the transcript, trim the grok CLI's
// own chat history to match (best-effort), and optionally reset the workdir
// to the snapshot taken when that prompt was sent.
ipcMain.handle(
  "workspace:rewind",
  (_event, ref: SessionRef, seq: number, restoreFiles: boolean) => {
    if (turnsInFlight.has(turnKey(ref))) {
      throw new Error("Cannot rewind while a turn is running.");
    }
    const target = readEvents(ref).find(
      (e) => e.seq === seq && e.type === "user_message",
    );
    if (!target) throw new Error(`No prompt at seq ${seq} to rewind to.`);
    const prompt = String(target.text ?? "");
    const dropped = truncateEvents(ref, seq);

    const session = readSession(ref);
    const notes: string[] = [];
    if (restoreFiles && typeof target.snapshotSha === "string") {
      const workdir =
        session?.worktree?.path ?? getProject(ref.projectId)?.path;
      try {
        if (!workdir) throw new Error("no working directory");
        restoreSnapshot(workdir, target.snapshotSha);
        notes.push("Files were restored to the state before that prompt.");
      } catch (err) {
        notes.push(
          `File restore failed: ${err instanceof Error ? err.message : err}.`,
        );
      }
    }
    // Without this, --resume replays the full grok-side history and the
    // agent "remembers" the turns the transcript no longer shows.
    if (session?.grokSessionId && !rewindGrokHistory(session.grokSessionId, prompt)) {
      notes.push(
        "The agent's internal history could not be trimmed; it may still remember the undone turns.",
      );
    }
    const notice = appendEvent(ref, {
      type: "notice",
      text: ["Rewound the session to this point.", ...notes].join(" "),
    });
    win?.webContents.send("workspace:event", { ref, event: notice });
    win?.webContents.send("workspace:tree-changed");
    return { events: [...dropped, notice], prompt };
  },
);

// Native (macOS) context menu for a project tab. Resolves true if the
// project was closed; closing archives it (closedAt) — data stays on disk.
ipcMain.handle(
  "workspace:projectMenu",
  (_event, projectId: string): Promise<boolean> => {
    const project = getProject(projectId);
    if (!project) return Promise.resolve(false);
    return new Promise((resolve) => {
      let closed = false;
      const menu = Menu.buildFromTemplate([
        {
          label: `Close “${project.name}”`,
          click: () => {
            updateProject(projectId, { closedAt: new Date().toISOString() });
            closed = true;
          },
        },
        { type: "separator" },
        {
          label: "Reveal in Finder",
          click: () => void shell.openPath(project.path),
        },
      ]);
      menu.popup({
        window: win ?? undefined,
        // Item click handlers can fire after the close callback; defer so
        // `closed` is settled before we resolve.
        callback: () => setImmediate(() => resolve(closed)),
      });
    });
  },
);

// Evidence viewer: bounded text/JSON file reads for the renderer.
ipcMain.handle("workspace:readFile", (_event, path: string) => {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { ok: false, error: "not a file" };
    if (stat.size > 2_000_000) return { ok: false, error: "file too large to preview (2MB cap)" };
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// Fallback for List blocks whose tool result carried no listing text.
ipcMain.handle("workspace:listDir", (_event, path: string): string[] => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 50)
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  } catch {
    return [];
  }
});

function requireProject(projectId: string) {
  const project = getProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return project;
}

ipcMain.handle("workspace:setupInfo", (_event, projectId: string) =>
  detectStack(requireProject(projectId).path),
);

ipcMain.handle(
  "workspace:runSetup",
  (_event, projectId: string, answers: SetupAnswers): SessionRef => {
    const project = requireProject(projectId);
    updateProject(projectId, { setupPromptedAt: new Date().toISOString() });
    // The durable "this project is set up" boolean lives in the project
    // itself, so re-adding the project never re-prompts.
    try {
      mkdirSync(join(project.path, ".theocode"), { recursive: true });
      writeFileSync(
        join(project.path, ".theocode", "setup.json"),
        JSON.stringify({ setUp: true, answers, at: new Date().toISOString() }, null, 2) + "\n",
      );
    } catch (err) {
      console.error("could not write setup marker:", err);
    }
    let key = "";
    const { ref, handle } = runProjectSetup(
      project,
      answers,
      turnSinks({
        onDone: (code) => {
          untrackTurn(key);
          onTurnFinished(ref, code);
        },
      }),
    );
    key = turnKey(ref);
    trackTurn(key, handle);
    return ref;
  },
);

ipcMain.handle("workspace:setupSeen", (_event, projectId: string) => {
  updateProject(projectId, { setupPromptedAt: new Date().toISOString() });
});

ipcMain.handle(
  "workspace:setReasoningEffort",
  (_event, ref: SessionRef, effort: ReasoningEffort) => {
    if (!isReasoningEffort(effort)) {
      throw new Error(`Invalid reasoning effort: ${String(effort)}`);
    }
    const updated = updateSessionMeta(ref, { reasoningEffort: effort });
    if (updated) win?.webContents.send("workspace:tree-changed");
    return updated;
  },
);

// THEOCODE_DEMO=1 (with THEOCODE_HOME pointed somewhere disposable) seeds a
// tree so the sidebar and subagent nesting can be exercised without an agent.
function seedDemo(): void {
  if (getTree().projects.length > 0) return;
  const project = createProject(join(app.getPath("home"), "Coding", "xai_onsite"));
  // Sorts after xai_onsite so the first paint still opens the seeded session.
  createProject(join(app.getPath("home"), "Coding", "zeta-app"));
  createSession(project.id, undefined, "Session storage design");
  const session = createSession(project.id, undefined, "Wire up the sidebar");
  const ref: SessionRef = { projectId: project.id, sessionId: session.id };
  appendEvent(ref, { type: "user_message", text: "Build the session sidebar." });
  appendEvent(ref, { type: "agent_message", text: "Scaffolding the tree now." });
  const question = "What does the renderer own versus main?";
  const sub = createSession(project.id, session.id, question);
  const subRef: SessionRef = { ...ref, subagentId: sub.id };
  updateSessionMeta(subRef, { question });
  appendEvent(subRef, {
    type: "user_message",
    text: `Research question:\n\n${question}\n\nAnswer this question and nothing else.`,
  });
  appendEvent(subRef, {
    type: "agent_message",
    text: "Reading src/renderer for conventions.",
  });
}

// Marks the research parent (and the researcher) as in-flight so screenshots
// can capture both ripple colors without spending a real grok turn.
function seedDemoActiveTurns(): void {
  for (const node of getTree().projects) {
    for (const sessionNode of node.sessions) {
      const research = sessionNode.subagents.find((s) => s.question);
      if (!research) continue;
      const ref: SessionRef = {
        projectId: node.project.id,
        sessionId: sessionNode.session.id,
      };
      turnsInFlight.set(turnKey(ref), { interrupt() {} });
      turnsInFlight.set(turnKey({ ...ref, subagentId: research.id }), {
        interrupt() {},
      });
      return;
    }
  }
}

// THEOCODE_DEMO_TURN=1 runs one turn on the first session at startup — with
// THEOCODE_GROK_BIN pointed at an NDJSON replayer this exercises streaming
// and rendering without spending a real agent turn.
function runDemoTurn(): void {
  const node = getTree().projects[0];
  const sessionNode = node?.sessions[0];
  if (!node || !sessionNode) return;
  const ref: SessionRef = {
    projectId: node.project.id,
    sessionId: sessionNode.session.id,
  };
  const event = appendEvent(ref, { type: "user_message", text: "Demo turn." });
  win?.webContents.send("workspace:event", { ref, event });
  startTurn(ref, "Demo turn.");
}

app.whenReady().then(async () => {
  setWorktreeScriptSource(join(app.getAppPath(), "resources", "worktree.sh"));
  loadAsyncTasks();
  saveAsyncTasks();
  // Reports that finished before a restart still reach their coordinator:
  // once the window is up, fire the normal idle-delivery for each parent
  // with unclaimed results.
  setTimeout(() => {
    const parents = new Map<string, SessionRef>();
    for (const t of [...researchTasks.values(), ...codeTasks.values()]) {
      if ((t.status === "done" || t.status === "failed") && !t.claimed && t.parentRef) {
        parents.set(turnKey(t.parentRef), t.parentRef);
      }
    }
    for (const ref of parents.values()) {
      if (getProject(ref.projectId) && readSession(ref)) {
        deliverPendingAsync(ref);
      }
    }
  }, 3000);
  if (process.env.THEOCODE_DEMO === "1") seedDemo();
  if (process.env.THEOCODE_DEMO_ACTIVE === "1") seedDemoActiveTurns();
  installSetupSkill();
  createWindow();
  if (process.env.THEOCODE_DEMO_TURN === "1") {
    setTimeout(runDemoTurn, 1200);
  }
  await startProxyAndSync();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  saveAsyncTasks();
  flushDb();
});
