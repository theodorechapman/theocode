import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startProxy, type ProxyCredentials, type RunningProxy } from "../src/proxy";
import type { TokenSet } from "../src/oauth";

const SECRET = "local-test-secret";

let upstream: Server;
let upstreamPort = 0;
let proxy: RunningProxy;

// Mock upstream MCP server + token endpoint. Accepts "good" bearer tokens,
// 401s "stale", and issues "refreshed-token" from the token endpoint.
const upstreamRequests: Array<{ auth?: string; path: string; body: string }> = [];

const creds: ProxyCredentials = {
  accessToken: "stale",
  refreshToken: "refresh-1",
  clientId: "client-1",
  clientSecret: undefined,
  tokenEndpoint: "",
  resource: "",
};
const savedTokens: TokenSet[] = [];

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      upstreamRequests.push({ auth: req.headers.authorization, path: req.url ?? "", body });
      if (req.url === "/token") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ access_token: "refreshed-token", refresh_token: "refresh-2" }),
        );
        return;
      }
      const token = (req.headers.authorization ?? "").replace("Bearer ", "");
      if (token === "stale") {
        res.writeHead(401, { "content-type": "application/json" }).end("{}");
        return;
      }
      res
        .writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "sess-42",
        })
        .end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { echo: body } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;
  creds.tokenEndpoint = `http://127.0.0.1:${upstreamPort}/token`;
  creds.resource = `http://127.0.0.1:${upstreamPort}/mcp`;

  proxy = await startProxy(
    {
      localSecret: SECRET,
      routes: { supabase: "supabase", vercel: "vercel" },
      getCredentials: (id) => (id === "supabase" ? { ...creds } : null),
      saveTokens: (_id, tokens) => {
        savedTokens.push(tokens);
        creds.accessToken = tokens.access_token;
        creds.refreshToken = tokens.refresh_token;
      },
      createWorktree: async (projectId, branch) => {
        if (projectId === "bad") throw new Error("not a git repo");
        return `Worktree wt-1 created for ${projectId} (branch ${branch ?? "wt-1"}).`;
      },
    },
    0,
  );
});

afterAll(async () => {
  await proxy.close();
  await new Promise((r) => upstream.close(r));
});

function call(path: string, secret = SECRET, body?: string) {
  return fetch(`http://127.0.0.1:${proxy.port}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
}

test("rejects a bad local secret", async () => {
  const res = await call("/supabase", "wrong");
  expect(res.status).toBe(401);
});

test("404s an unknown route", async () => {
  const res = await call("/github");
  expect(res.status).toBe(404);
});

test("503s a provider that is not connected", async () => {
  const res = await call("/vercel");
  expect(res.status).toBe(503);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("not connected");
});

test("refreshes a stale token, retries, and forwards the response", async () => {
  const res = await call("/supabase", SECRET, JSON.stringify({ hello: "world" }));
  expect(res.status).toBe(200);
  expect(res.headers.get("mcp-session-id")).toBe("sess-42");
  const body = (await res.json()) as { result: { echo: string } };
  expect(body.result.echo).toBe(JSON.stringify({ hello: "world" }));

  // The stale token hit /mcp, then the token endpoint, then the retry.
  expect(savedTokens.length).toBe(1);
  expect(savedTokens[0].access_token).toBe("refreshed-token");
  const retried = upstreamRequests.filter((r) => r.path === "/mcp");
  expect(retried.at(-1)?.auth).toBe("Bearer refreshed-token");
});

test("forwards directly once the token is fresh", async () => {
  const before = upstreamRequests.filter((r) => r.path === "/token").length;
  const res = await call("/supabase");
  expect(res.status).toBe(200);
  const after = upstreamRequests.filter((r) => r.path === "/token").length;
  expect(after).toBe(before);
});

function rpc(path: string, body: unknown, secret = SECRET) {
  return fetch(`http://127.0.0.1:${proxy.port}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("wt endpoint requires the local secret", async () => {
  const res = await rpc("/wt/p1", { jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong");
  expect(res.status).toBe(401);
});

test("wt endpoint speaks MCP: initialize, tools/list, tools/call", async () => {
  const init = await rpc("/wt/p1", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  expect(init.status).toBe(200);
  const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
  expect(initBody.result.serverInfo.name).toBe("theocode-wt");

  const notify = await rpc("/wt/p1", { jsonrpc: "2.0", method: "notifications/initialized" });
  expect(notify.status).toBe(202);

  const list = await rpc("/wt/p1", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listBody = (await list.json()) as { result: { tools: Array<{ name: string }> } };
  expect(listBody.result.tools[0].name).toBe("theocode-wt");

  const call = await rpc("/wt/p1", {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "theocode-wt", arguments: { branch: "feature-x" } },
  });
  const callBody = (await call.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  expect(callBody.result.isError).toBe(false);
  expect(callBody.result.content[0].text).toContain("wt-1");
  expect(callBody.result.content[0].text).toContain("feature-x");
});

test("wt tool errors surface as isError results, not crashes", async () => {
  const call = await rpc("/wt/bad", {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "theocode-wt", arguments: {} },
  });
  const body = (await call.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0].text).toContain("not a git repo");
});
