import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runOAuthFlow } from "./oauth";
import { getProvider, GROK_CLIENT_ID, GROK_ISSUER } from "./providers";
import {
  readGrokCliAuth,
  registerProxyWithGrok,
  removeGrokCliAuth,
  unregisterProxyFromGrok,
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
} from "./theocode/sessions";
import { getProject, updateProject } from "./theocode/sessions";
import { detectStack, installSetupSkill, runProjectSetup } from "./theocode/setup";
import { flushDb } from "./theocode/db";
import type { SessionRef, SetupAnswers } from "./theocode/types";
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

function grokMcpName(route: string): string {
  return `theocode-${route}`;
}

async function syncGrokRegistration(route: string): Promise<void> {
  const providerId = PROXY_ROUTES[route];
  try {
    if (proxy && getCredentials(providerId)) {
      await registerProxyWithGrok(
        grokMcpName(route),
        `http://127.0.0.1:${proxy.port}/${route}`,
        proxySecret,
      );
    } else {
      await unregisterProxyFromGrok(grokMcpName(route));
    }
  } catch (err) {
    console.error(`grok MCP registration for ${route} failed:`, err);
  }
}

async function startProxyAndSync(): Promise<void> {
  proxySecret = loadProxySecret();
  proxy = await startProxy({
    localSecret: proxySecret,
    routes: PROXY_ROUTES,
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
  await Promise.all(Object.keys(PROXY_ROUTES).map(syncGrokRegistration));
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
    win.webContents.on("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 1500));
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
        await syncGrokRegistration(providerId);
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
    await syncGrokRegistration(providerId);
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

// Records the user's message. Invoking the grok turn (src/theocode/agent.ts)
// is intentionally not wired yet — the chat surface is a stub while rendering
// decisions are made.
ipcMain.handle(
  "workspace:send",
  (_event, ref: SessionRef, text: string) => {
    const event = appendEvent(ref, { type: "user_message", text });
    win?.webContents.send("workspace:event", { ref, event });
    return readEvents(ref);
  },
);

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
    return runProjectSetup(project, answers, (ref, event) =>
      win?.webContents.send("workspace:event", { ref, event }),
    );
  },
);

ipcMain.handle("workspace:setupSeen", (_event, projectId: string) => {
  updateProject(projectId, { setupPromptedAt: new Date().toISOString() });
});

// THEOCODE_DEMO=1 (with THEOCODE_HOME pointed somewhere disposable) seeds a
// tree so the sidebar and subagent nesting can be exercised without an agent.
function seedDemo(): void {
  if (getTree().projects.length > 0) return;
  const project = createProject(join(app.getPath("home"), "Coding", "xai_onsite"));
  const session = createSession(project.id, undefined, "Wire up the sidebar");
  const ref: SessionRef = { projectId: project.id, sessionId: session.id };
  appendEvent(ref, { type: "user_message", text: "Build the session sidebar." });
  appendEvent(ref, { type: "agent_message", text: "Scaffolding the tree now." });
  const sub = createSession(project.id, session.id, "Explore renderer layout");
  appendEvent(
    { ...ref, subagentId: sub.id },
    { type: "agent_message", text: "Reading src/renderer for conventions." },
  );
  createSession(project.id, undefined, "Session storage design");
}

app.whenReady().then(async () => {
  if (process.env.THEOCODE_DEMO === "1") seedDemo();
  installSetupSkill();
  createWindow();
  await startProxyAndSync();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => flushDb());
