import { app, safeStorage } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConnectionInfo, ProviderId } from "./types";
import type { TokenSet } from "./oauth";

interface StoredConnection {
  info: ConnectionInfo;
  /** base64 of safeStorage-encrypted token JSON (plain base64 JSON if unavailable). */
  tokens: string;
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

export function saveConnection(info: ConnectionInfo, tokens: TokenSet): void {
  const json = JSON.stringify(tokens);
  const canEncrypt = safeStorage.isEncryptionAvailable();
  const payload = canEncrypt
    ? safeStorage.encryptString(json).toString("base64")
    : Buffer.from(json).toString("base64");
  const store = readStore();
  store[info.providerId] = { info, tokens: payload, encrypted: canEncrypt };
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
