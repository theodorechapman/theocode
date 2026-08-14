import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OAuthOutcome } from "./oauth";

const execFileAsync = promisify(execFile);

// The grok CLI reads its credentials from ~/.grok/auth.json, keyed by
// "<issuer>::<client_id>". theocode signs in with the CLI's own public client
// and writes the result here, so the actual `grok` binary on this machine is
// authenticated — theocode then wraps the CLI rather than holding a separate
// credential.
const GROK_DIR = join(homedir(), ".grok");
const AUTH_PATH = join(GROK_DIR, "auth.json");

export interface GrokCliAuthStatus {
  email?: string;
  createdAt?: string;
  expiresAt?: string;
  hasRefreshToken: boolean;
}

function entryKey(issuer: string, clientId: string): string {
  return `${issuer}::${clientId}`;
}

function readAuthFile(): Record<string, Record<string, unknown>> {
  try {
    return JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeAuthFile(data: Record<string, Record<string, unknown>>): void {
  mkdirSync(GROK_DIR, { recursive: true });
  const tmp = `${AUTH_PATH}.theocode-tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, AUTH_PATH);
}

export function readGrokCliAuth(
  issuer: string,
  clientId: string,
): GrokCliAuthStatus | null {
  const entry = readAuthFile()[entryKey(issuer, clientId)];
  if (!entry || typeof entry.key !== "string") return null;
  const expiresAt = entry.expires_at as string | undefined;
  const hasRefreshToken = typeof entry.refresh_token === "string";
  const expired = expiresAt ? Date.parse(expiresAt) < Date.now() : false;
  if (expired && !hasRefreshToken) return null;
  return {
    email: entry.email as string | undefined,
    createdAt: entry.create_time as string | undefined,
    expiresAt,
    hasRefreshToken,
  };
}

export function writeGrokCliAuth(
  issuer: string,
  clientId: string,
  outcome: OAuthOutcome,
): void {
  const data = readAuthFile();
  const key = entryKey(issuer, clientId);
  const existing = data[key] ?? {};
  const claims = outcome.claims;
  data[key] = {
    coding_data_retention_opt_out: false,
    ...existing,
    key: outcome.tokens.access_token,
    auth_mode: "oidc",
    create_time: new Date().toISOString(),
    user_id: claims.sub ?? existing.user_id ?? "",
    email: claims.email ?? existing.email ?? "",
    first_name: claims.given_name ?? existing.first_name ?? "",
    last_name: claims.family_name ?? existing.last_name ?? "",
    principal_type: claims.principal_type ?? existing.principal_type ?? "User",
    principal_id: claims.principal_id ?? claims.sub ?? existing.principal_id ?? "",
    team_id: claims.team_id ?? existing.team_id ?? "",
    refresh_token: outcome.tokens.refresh_token ?? existing.refresh_token ?? "",
    expires_at: outcome.expiresAt ?? "",
    oidc_issuer: issuer,
    oidc_client_id: clientId,
  };
  writeAuthFile(data);
}

export function removeGrokCliAuth(issuer: string, clientId: string): void {
  const data = readAuthFile();
  delete data[entryKey(issuer, clientId)];
  writeAuthFile(data);
}

function grokBinary(): string {
  const installed = join(GROK_DIR, "bin", "grok");
  return existsSync(installed) ? installed : "grok";
}

/**
 * Registers a theocode proxy route as an MCP server in the grok CLI's user
 * config (`grok mcp add` is add-or-update, so re-running after a port change
 * rewrites the URL).
 */
export async function registerProxyWithGrok(
  name: string,
  url: string,
  localSecret: string,
): Promise<void> {
  await execFileAsync(grokBinary(), [
    "mcp",
    "add",
    name,
    url,
    "--transport",
    "http",
    "--scope",
    "user",
    "--header",
    `Authorization: Bearer ${localSecret}`,
  ]);
}

export async function unregisterProxyFromGrok(name: string): Promise<void> {
  try {
    await execFileAsync(grokBinary(), ["mcp", "remove", name, "--scope", "user"]);
  } catch {
    // Not registered — nothing to remove.
  }
}
