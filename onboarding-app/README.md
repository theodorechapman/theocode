# theocode

Electron workspace for driving the grok CLI as an agent, plus the onboarding
flow that connects its tools over OAuth 2.0 (authorization code + PKCE on a
loopback redirect, RFC 8252).

## App experience

- **Sidebar** — threads organized project → agent session → subagent sessions.
  Projects group their sessions; subagent sessions nest under the agent
  session that spawned them.
- **Session pane** — live chat: turns stream in coalesced (thinking,
  full bash commands clipped to 5 lines, paragraph-by-paragraph fade-in),
  with quiet turn footers and a raw fallback for unknown record types.
- **Connections** — the OAuth onboarding surface (Grok Build CLI, Supabase
  MCP, Vercel MCP), reachable from the sidebar footer. Grok credentials are
  written to the CLI's own store (`~/.grok/auth.json`); MCP tokens are
  encrypted with Electron `safeStorage`.

## Loopback MCP proxy

theocode runs a local proxy (port 8917, falling back to an ephemeral port) that exposes the connected MCP servers to the grok CLI without ever handing it the upstream tokens:

- Routes: `http://127.0.0.1:8917/supabase` and `http://127.0.0.1:8917/vercel`, guarded by a per-install local secret (`userData/proxy-secret`, sent as a bearer header from the grok config).
- Registration is per project, not global: before each turn theocode syncs `<workdir>/.grok/config.toml` (main checkout or the session's worktree) so `theocode-supabase` / `theocode-vercel` / `theocode-wt` / `theocode-research` exist only inside theocode projects, with folder trust managed in the CLI's trust store.
- Each request is forwarded verbatim to the upstream MCP endpoint with theocode's bearer token attached; on a 401 the proxy refreshes the token (single-flight, persisted back to the encrypted store) and retries once.
- A provider that isn't connected returns a 503 telling the agent to finish setup in theocode.

`bun test` covers the proxy: local-secret enforcement, routing, unconnected providers, refresh-and-retry, and pass-through of MCP session headers.

## Storage

Sessions live under `~/.theocode` (override with `THEOCODE_HOME`). The
filesystem is the source of truth — raw JSON metadata plus append-only jsonl
transcripts — mirrored into sqlite (`index.db`, via sql.js) for later querying:

```
projects/<projectId>/project.json
projects/<projectId>/sessions/<sessionId>/{session.json, events.jsonl}
projects/<projectId>/sessions/<sessionId>/subagents/<subId>/{session.json, events.jsonl}
index.db
```

## Research subagents

`theocode-research` (an MCP tool on the proxy, per-project like `theocode-wt`)
spawns a pure research subagent. The parent supplies a short `question`
(hard-capped at 400 chars, delivered to the researcher verbatim and alone) and
an optional `hypothesis` that the researcher NEVER sees — theocode holds it and
echoes it back with the report, keeping the exploration uncontaminated.
Researchers run read-only (`--tools read_file,grep,list_dir,web_search,web_fetch`)
under `prompts/research-rules.md` in a nested subagent session. The spawn
returns immediately: the parent can poll mid-turn (`theocode-research-poll`),
and once its turn ends, unclaimed reports are delivered as an interrupt turn
(`research_result` event + a new parent turn carrying the report).

## Coding subagents

`theocode-code` fans out one coding subagent per task card, each in its own
child worktree (wt-N.M) branched from the coordinator's worktree. Cards are
self-contained contracts (goal, spec, files_in_scope, done_criteria) enforced
by schema; `notes_for_merge` is coordinator-private and returns with the
result. Subagents run full-capability under `prompts/coding-rules.md` (commit
before finishing, never merge), capped at `parallel` concurrent (default 3,
queue drains as slots free). Results interrupt the coordinator with a merge
playbook: merge each child branch into its worktree, verify done criteria,
then `theocode-wt-remove`. Caller identity is exact for worktree sessions —
per-workdir MCP registrations bake the label into the tool URLs
(`/code/<projectId>/<wtLabel>`), fixing the concurrent-turn ambiguity.

## Agent

`src/theocode/agent.ts` builds the headless grok invocation for a turn:
`--session-id`/`--resume` for continuity, `--cwd` following the session's
worktree once it has one, and `prompts/system-prompt.md` appended to grok's
stock system prompt via `--rules`. `turn.ts` spawns it and coalesces the
NDJSON stream into consolidated transcript events.

## Run

```sh
bun install
bun run start      # builds, then launches through scripts/dev.mjs
```

`scripts/dev.mjs` gives each running instance an exclusive port block
(43000+10n, lock files in `~/.theocode/dev-locks`) and a suffixed Electron
userData dir, so several agents can run the app from parallel worktrees
without colliding. Env it exports: `THEOCODE_INSTANCE`, `THEOCODE_PORT_BASE`,
`THEOCODE_AGENT_PORT`, `THEOCODE_DEV_PORT`.

Other scripts: `bun run typecheck`, `bun run build`.

Dev helpers: `THEOCODE_SCREENSHOT=/path/out.png` captures the window and
quits; `THEOCODE_DEMO=1` seeds a demo tree when the store is empty (point
`THEOCODE_HOME` somewhere disposable).

## Layout

```
src/
  main.ts             Electron main process, IPC, window, proxy lifecycle
  preload.ts          contextBridge APIs (window.onboarding, window.workspace)
  oauth.ts            OAuth engine: discovery → DCR → PKCE → loopback → tokens → MCP verify → refresh
  proxy.ts            loopback MCP proxy: local-secret auth, bearer injection, 401 refresh-and-retry
  providers.ts        the three provider configs
  grok.ts             grok CLI integration: ~/.grok/auth.json credentials + `grok mcp add/remove`
  store.ts            safeStorage-encrypted MCP credential store (tokens + DCR client)
  theocode/
    paths.ts          ~/.theocode layout
    sessions.ts       filesystem session store (source of truth)
    db.ts             sqlite mirror (sql.js)
    agent.ts          grok invocation builder (MCP config + system prompt)
    types.ts          workspace types + renderer API
  renderer/           app shell: sidebar tree, session pane, connections view
scripts/dev.mjs       per-instance port/userData allocator + launcher
prompts/               --rules appends: system-prompt.md, research-rules.md
tests/proxy.test.ts   proxy unit tests (`bun test`)
```
