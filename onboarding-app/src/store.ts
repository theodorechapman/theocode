import { app, safeStorage } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConnectionInfo, ProviderId } from "./types";
import type { TokenSet } from "./oauth";

/** Everything needed to call the upstream MCP server and refresh its token. */
export interface SavedCredentials {
  tokens: TokenSet;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  resource: string;
}

interface StoredConnection {
  info: ConnectionInfo;
  /** base64 of safeStorage-encrypted SavedCredentials JSON (plain base64 if unavailable). */
  credentials: string;
  encrypted: boolean;
}

type StoreShape = Partial<Record<ProviderId, StoredConnection>>;

function storePath(): string {
  return join(app.getPath("userData"), "connections.json");
}

function readStore(): StoreShape {
  try {
    return JSON.parse(readFileSync(storePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeStore(store: StoreShape): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function encrypt(json: string): { payload: string; encrypted: boolean } {
  if (safeStorage.isEncryptionAvailable()) {
    return { payload: safeStorage.encryptString(json).toString("base64"), encrypted: true };
  }
  return { payload: Buffer.from(json).toString("base64"), encrypted: false };
}

function decrypt(conn: StoredConnection): SavedCredentials {
  const buf = Buffer.from(conn.credentials, "base64");
  const json = conn.encrypted
    ? safeStorage.decryptString(buf)
    : buf.toString("utf8");
  return JSON.parse(json);
}

export function saveConnection(info: ConnectionInfo, creds: SavedCredentials): void {
  const { payload, encrypted } = encrypt(JSON.stringify(creds));
  const store = readStore();
  store[info.providerId] = { info, credentials: payload, encrypted };
  writeStore(store);
}

export function getCredentials(providerId: ProviderId): SavedCredentials | null {
  const conn = readStore()[providerId];
  if (!conn) return null;
  try {
    return decrypt(conn);
  } catch {
    return null;
  }
}

export function updateTokens(providerId: ProviderId, tokens: TokenSet): void {
  const store = readStore();
  const conn = store[providerId];
  if (!conn) return;
  const creds = decrypt(conn);
  // Some servers rotate the refresh token; keep the old one when they don't.
  creds.tokens = {
    ...tokens,
    refresh_token: tokens.refresh_token ?? creds.tokens.refresh_token,
  };
  const { payload, encrypted } = encrypt(JSON.stringify(creds));
  store[providerId] = { ...conn, credentials: payload, encrypted };
  writeStore(store);
}

export function getConnections(): Partial<Record<ProviderId, ConnectionInfo>> {
  const store = readStore();
  const out: Partial<Record<ProviderId, ConnectionInfo>> = {};
  for (const [id, conn] of Object.entries(store)) {
    if (conn) out[id as ProviderId] = conn.info;
  }
  return out;
}

export function removeConnection(providerId: ProviderId): void {
  const store = readStore();
  delete store[providerId];
  writeStore(store);
}
