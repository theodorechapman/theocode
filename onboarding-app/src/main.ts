import { app, BrowserWindow, ipcMain, shell } from "electron";
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
import { startProxy, type RunningProxy } from "./proxy";
import {
  getConnections,
  getCredentials,
  removeConnection,
  saveConnection,
  updateTokens,
} from "./store";
import type { ConnectionInfo, ConnectResult, ProviderId } from "./types";

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

app.whenReady().then(async () => {
  createWindow();
  await startProxyAndSync();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
