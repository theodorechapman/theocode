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
  /**
   * First-party worktree tool, mounted as an MCP server at /wt/<projectId>.
   * Returns the human-readable tool result; throws with a user-facing message.
   */
  createWorktree?(projectId: string, branch?: string): Promise<string>;
}

export interface RunningProxy {
  port: number;
  close(): Promise<void>;
}

// Where the app-wide proxy actually ended up, for modules (like the agent
// invocation builder) that hand its address to the grok CLI.
let activeProxy: { port: number; secret: string } | null = null;

export function setActiveProxy(port: number, secret: string): void {
  activeProxy = { port, secret };
}

export function getActiveProxy(): { port: number; secret: string } | null {
  return activeProxy;
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

// ---- First-party MCP server for the theocode-wt tool -----------------------
// A minimal streamable-HTTP MCP endpoint: single JSON-RPC messages via POST,
// plain application/json responses (no SSE needed for one short-lived tool).

const WT_TOOL = {
  name: "theocode-wt",
  description:
    "Create a fresh, non-conflicting git worktree (wt-N) for this project with its own reserved port block, and continue your work inside it. Commit your current work first.",
  inputSchema: {
    type: "object",
    properties: {
      branch: {
        type: "string",
        description: "Branch name for the worktree. Defaults to wt-N.",
      },
    },
  },
};

async function handleWtRequest(
  deps: ProxyDeps,
  projectId: string,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(body.toString());
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return;
  }
  const id = message.id;
  if (id === undefined || id === null) {
    // Notification (e.g. notifications/initialized) — acknowledge silently.
    res.writeHead(202).end();
    return;
  }
  const reply = (result: unknown) =>
    json(res, 200, { jsonrpc: "2.0", id, result });

  switch (message.method) {
    case "initialize": {
      const params = message.params as { protocolVersion?: string } | undefined;
      reply({
        protocolVersion: params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "theocode-wt", version: "0.1.0" },
      });
      return;
    }
    case "tools/list":
      reply({ tools: [WT_TOOL] });
      return;
    case "tools/call": {
      const params = message.params as
        | { name?: string; arguments?: { branch?: string } }
        | undefined;
      if (params?.name !== WT_TOOL.name || !deps.createWorktree) {
        json(res, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `unknown tool: ${params?.name}` },
        });
        return;
      }
      try {
        const text = await deps.createWorktree(
          projectId,
          params.arguments?.branch,
        );
        reply({ content: [{ type: "text", text }], isError: false });
      } catch (err) {
        reply({
          content: [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          isError: true,
        });
      }
      return;
    }
    case "ping":
      reply({});
      return;
    default:
      json(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${message.method}` },
      });
  }
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

    if (route.startsWith("wt/")) {
      const body = await readBody(req);
      await handleWtRequest(deps, route.slice(3), req, res, body);
      return;
    }

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
