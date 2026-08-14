# theocode

Electron workspace for driving the grok CLI as an agent, plus the onboarding
flow that connects its tools over OAuth 2.0 (authorization code + PKCE on a
loopback redirect, RFC 8252).

## App experience

- **Sidebar** — threads organized project → agent session → subagent sessions.
  Projects group their sessions; subagent sessions nest under the agent
  session that spawned them.
- **Session pane** — stubbed chat: it shows the raw session records and stores
  sent messages, but message rendering and the agent loop are deliberately
  unwired until rendering decisions are made.
- **Connections** — the OAuth onboarding surface (Grok Build CLI, Supabase
  MCP, Vercel MCP), reachable from the sidebar footer. Grok credentials are
  written to the CLI's own store (`~/.grok/auth.json`); MCP tokens are
  encrypted with Electron `safeStorage`.

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

## Agent

`src/theocode/agent.ts` builds the headless grok invocation for a turn:
connected MCP servers (with stored tokens) are written per-session to
`mcp.json`, and the system prompt is read from `prompts/system-prompt.md`
(intentionally blank — Theo writes it). Spawning/streaming is not wired yet.

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
  main.ts             Electron main process, IPC, window
  preload.ts          contextBridge APIs (window.onboarding, window.workspace)
  oauth.ts            OAuth engine: discovery → DCR → PKCE → loopback → tokens
  providers.ts        the three provider configs
  grok.ts             hand-off into the grok CLI's credential store
  store.ts            safeStorage-encrypted MCP token store
  theocode/
    paths.ts          ~/.theocode layout
    sessions.ts       filesystem session store (source of truth)
    db.ts             sqlite mirror (sql.js)
    agent.ts          grok invocation builder (MCP config + system prompt)
    types.ts          workspace types + renderer API
  renderer/           app shell: sidebar tree, session pane, connections view
scripts/dev.mjs       per-instance port/userData allocator + launcher
prompts/system-prompt.md   agent system prompt (blank on purpose)
```
