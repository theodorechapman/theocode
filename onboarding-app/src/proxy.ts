import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { refreshTokens, type TokenSet } from "./oauth";

// Loopback MCP proxy.
//
// The grok CLI registers http://127.0.0.1:<port>/<route> as a plain streamable
// HTTP MCP server. Each request is forwarded verbatim to the real MCP endpoint
// with theocode's bearer token attached, so upstream credentials never leave
// theocode. A per-install local secret keeps other local processes out.

export interface ProxyCredentials {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  /** Upstream MCP endpoint URL. */
  resource: string;
}

export interface ProxyDeps {
  localSecret: string;
  /** route name (e.g. "supabase") -> provider id used for credential lookup. */
  routes: Record<string, string>;
  getCredentials(providerId: string): ProxyCredentials | null;
  saveTokens(providerId: string, tokens: TokenSet): void;
}

export interface RunningProxy {
  port: number;
  close(): Promise<void>;
}

const FORWARD_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "cache-control",
];

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(
    JSON.stringify(body),
  );
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createProxy(deps: ProxyDeps) {
  // Single-flight refresh per provider so parallel 401s trigger one refresh.
  const refreshing = new Map<string, Promise<string>>();

  async function freshAccessToken(
    providerId: string,
    creds: ProxyCredentials,
  ): Promise<string> {
    const existing = refreshing.get(providerId);
    if (existing) return existing;
    const p = (async () => {
      if (!creds.refreshToken) {
        throw new Error("No refresh token available");
      }
      const tokens = await refreshTokens(
        creds.tokenEndpoint,
        creds.clientId,
        creds.clientSecret,
        creds.refreshToken,
      );
      deps.saveTokens(providerId, tokens);
      return tokens.access_token;
    })().finally(() => refreshing.delete(providerId));
    refreshing.set(providerId, p);
    return p;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${deps.localSecret}`) {
      json(res, 401, { error: "missing or invalid local proxy token" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = url.pathname.replace(/^\/+|\/+$/g, "");
    const providerId = deps.routes[route];
    if (!providerId) {
      json(res, 404, { error: `unknown route: /${route}` });
      return;
    }

    const creds = deps.getCredentials(providerId);
    if (!creds) {
      json(res, 503, {
        error: `${providerId} is not connected in theocode — open theocode setup and connect it`,
      });
      return;
    }

    const method = req.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
    const headers: Record<string, string> = {};
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }

    const forward = (accessToken: string) =>
      fetch(creds.resource, {
        method,
        headers: { ...headers, authorization: `Bearer ${accessToken}` },
        body: body && body.length > 0 ? new Uint8Array(body) : undefined,
      });

    try {
      let upstream = await forward(creds.accessToken);
      if (upstream.status === 401 && creds.refreshToken) {
        upstream.body?.cancel().catch(() => {});
        const token = await freshAccessToken(providerId, creds);
        upstream = await forward(token);
      }

      const responseHeaders: Record<string, string> = {};
      for (const name of FORWARD_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      res.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        Readable.fromWeb(upstream.body as never).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      json(res, 502, {
        error: `proxy failed to reach upstream: ${err instanceof Error ? err.message : err}`,
      });
    }
  }

  return handle;
}

export async function startProxy(
  deps: ProxyDeps,
  preferredPort = 8917,
): Promise<RunningProxy> {
  const server = createServer(createProxy(deps));
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Fall back to an ephemeral port; registration always follows startup,
        // so the grok config is rewritten with whatever port we actually got.
        server.removeAllListeners("error");
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      } else {
        reject(err);
      }
    });
    server.listen(preferredPort, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
