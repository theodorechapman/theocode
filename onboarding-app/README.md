# theocode

Electron setup flow that connects three services over OAuth 2.0 (authorization code + PKCE on a loopback redirect, RFC 8252). theocode wraps the local grok CLI and talks to the MCP servers itself, so each credential lands where the program that uses it actually reads it:

- **Grok CLI** — signs in at `auth.x.ai` with the grok CLI's own public client id and exact scope set, then writes the credential into `~/.grok/auth.json` in the CLI's record format. The real `grok` binary on this machine is what ends up authenticated; an existing `grok login` shows as already connected.
- **Supabase MCP** — theocode is the MCP client here. It discovers `https://mcp.supabase.com` protected-resource metadata, dynamically registers a client (RFC 7591), requests the server's advertised scopes, and verifies the token with an authenticated JSON-RPC `initialize` against the MCP endpoint before saving it.
- **Vercel MCP** — same discovery + dynamic registration + live verification against `https://mcp.vercel.com/`.

MCP tokens are encrypted with Electron `safeStorage` (system keychain) and written to `userData/connections.json`. The Grok credential lives only in the CLI's own store.

## Stack

TypeScript everywhere, built and managed with **Bun**; Electron runs the bundled output from `dist/`. The UI follows the design philosophy in `../design.md` (Geist foundation stylesheet, light/dark, fixed viewport with no scrolling).

## Run

```sh
bun install
bun run start      # builds main, preload, and renderer, then launches Electron
```

Other scripts: `bun run typecheck`, `bun run build`.

## Layout

```
src/
  main.ts        Electron main process, IPC, window
  preload.ts     contextBridge API (window.onboarding)
  oauth.ts       OAuth engine: discovery → DCR → PKCE → loopback callback → token exchange → MCP verify
  providers.ts   the three provider configs
  grok.ts        read/write the grok CLI's ~/.grok/auth.json credential store
  store.ts       safeStorage-encrypted token store for MCP connections
  renderer/      index.html, app.css, renderer.ts, assets/vercel-brand.css
```

Setting `THEOCODE_SCREENSHOT=/path/out.png` captures the window to a PNG and quits (used for design review).
