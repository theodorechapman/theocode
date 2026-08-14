import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ConnectionPhase, ProviderConfig } from "./types";

interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  userinfo_endpoint?: string;
}

interface ResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface OAuthOutcome {
  tokens: TokenSet;
  account?: string;
  scopes?: string;
  expiresAt?: string;
  /** Merged claims: access-token JWT + id_token + userinfo response. */
  claims: Record<string, unknown>;
}

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${url} responded ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

async function discoverAuthServer(issuer: string): Promise<AuthServerMetadata> {
  const base = issuer.replace(/\/$/, "");
  const candidates = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];
  let lastError: unknown;
  for (const url of candidates) {
    try {
      return await fetchJson<AuthServerMetadata>(url);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`OAuth discovery failed for ${issuer}: ${lastError}`);
}

async function resolveProvider(provider: ProviderConfig): Promise<{
  meta: AuthServerMetadata;
  resource?: string;
  scopes: string;
}> {
  if (provider.resourceMetadataUrl) {
    const rm = await fetchJson<ResourceMetadata>(provider.resourceMetadataUrl);
    const issuer = rm.authorization_servers?.[0];
    if (!issuer) throw new Error("Resource metadata lists no authorization server");
    const meta = await discoverAuthServer(issuer);
    const scopes =
      provider.scopes ?? (rm.scopes_supported ?? []).join(" ") ?? "";
    return { meta, resource: rm.resource, scopes };
  }
  if (!provider.issuer) throw new Error("Provider has neither issuer nor resource");
  const meta = await discoverAuthServer(provider.issuer);
  return { meta, scopes: provider.scopes ?? "openid" };
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  const registration = await fetchJson<{
    client_id: string;
    client_secret?: string;
  }>(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "theocode",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  return {
    clientId: registration.client_id,
    clientSecret: registration.client_secret,
  };
}

const CALLBACK_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Signed in</title>
<style>
  body { font-family: system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100vh; margin: 0; background: #fff; color: #171717; }
  @media (prefers-color-scheme: dark) { body { background: #0a0a0a; color: #ededed; } }
  p { font-size: 15px; }
</style></head>
<body><p>Sign-in complete. You can close this tab and return to the app.</p></body></html>`;

function waitForCallback(
  server: Server,
  expectedState: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for the browser sign-in"));
    }, AUTH_TIMEOUT_MS);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(CALLBACK_PAGE);
      clearTimeout(timer);
      const err = url.searchParams.get("error");
      if (err) {
        reject(
          new Error(url.searchParams.get("error_description") ?? err),
        );
        return;
      }
      if (url.searchParams.get("state") !== expectedState) {
        reject(new Error("OAuth state mismatch"));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        reject(new Error("Callback carried no authorization code"));
        return;
      }
      resolve(code);
    });
  });
}

function decodeJwtPayload(jwt?: string): Record<string, unknown> {
  if (!jwt) return {};
  try {
    const payload = jwt.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * Confirms the access token is actually accepted by the MCP server theocode
 * will talk to, by sending an authenticated JSON-RPC initialize request.
 */
async function verifyMcpToken(
  resourceUrl: string,
  accessToken: string,
): Promise<void> {
  const res = await fetch(resourceUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "theocode", version: "0.1.0" },
      },
    }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`The MCP server rejected the new token (${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`MCP verification failed: ${res.status}`);
  }
}

export async function runOAuthFlow(
  provider: ProviderConfig,
  openExternal: (url: string) => Promise<void>,
  onPhase: (phase: ConnectionPhase) => void,
): Promise<OAuthOutcome> {
  onPhase("discovering");
  const { meta, resource, scopes } = await resolveProvider(provider);

  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  try {
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    let clientId = provider.clientId;
    let clientSecret: string | undefined;
    if (!clientId) {
      if (!meta.registration_endpoint) {
        throw new Error(
          `${provider.name} supports neither a public client nor dynamic registration`,
        );
      }
      onPhase("registering");
      const client = await registerClient(meta.registration_endpoint, redirectUri);
      clientId = client.clientId;
      clientSecret = client.clientSecret;
    }

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(
      createHash("sha256").update(verifier).digest(),
    );
    const state = base64url(randomBytes(16));

    const authUrl = new URL(meta.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    if (scopes) authUrl.searchParams.set("scope", scopes);
    if (resource) authUrl.searchParams.set("resource", resource);

    onPhase("waiting_for_browser");
    const codePromise = waitForCallback(server, state);
    await openExternal(authUrl.toString());
    const code = await codePromise;

    onPhase("exchanging");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    if (resource) body.set("resource", resource);

    const tokens = await fetchJson<TokenSet>(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!tokens.access_token) throw new Error("Token response had no access token");

    onPhase("verifying");
    if (resource) {
      await verifyMcpToken(resource, tokens.access_token);
    }

    let claims: Record<string, unknown> = {
      ...decodeJwtPayload(tokens.access_token),
      ...decodeJwtPayload(tokens.id_token),
    };
    if (meta.userinfo_endpoint) {
      try {
        const userinfo = await fetchJson<Record<string, unknown>>(
          meta.userinfo_endpoint,
          { headers: { authorization: `Bearer ${tokens.access_token}` } },
        );
        claims = { ...claims, ...userinfo };
      } catch {
        // Userinfo enrichment is best-effort; the token itself already works.
      }
    }
    const account =
      (claims.email as string | undefined) ??
      (claims.preferred_username as string | undefined);
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;

    return { tokens, account, scopes: tokens.scope ?? scopes, expiresAt, claims };
  } finally {
    server.close();
  }
}
