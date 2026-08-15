# theoCode

A desktop app for driving the grok CLI as a coding agent — projects, sessions, worktrees, and subagents in one window. Not affiliated with t3 code 😂

Built on Electron for Mac + Linux support, readable TypeScript, and development speed (the whole UI conforms to one `design.md`).

## Four opinions

1. **Visibility and a feeling of control over the pivotal decisions.**
2. **Being able to sanity check my work.**
3. **Ergonomic to work with others / multiple agents.**
4. **Deploy easily.**

Those opinions became four features.

## 1 · Direct deployment integration

Onboarding is three OAuth connections: the **Grok CLI** (the credential lands in `~/.grok/auth.json`, so the actual binary on your machine is what gets authenticated), **Supabase MCP**, and **Vercel MCP**. The MCP tokens never reach the agent — theocode runs a loopback proxy that holds them, refreshes them, and registers per-project MCP servers the agent talks to. Credentials are encrypted with the system keychain and stay on this device.

Opening a project for the first time shows a two-question box — *using Vercel? using Supabase?* — answered with the `1`/`2` keys. Any answer starts a setup agent that installs the worktree tooling every project needs, and optionally links Vercel (deploys + secrets) and Supabase (Postgres/auth, local stack via Docker). A `.theocode/setup.json` marker means a set-up project never asks again.

## 2 · First-class worktrees

Other tools bolt a setup script onto worktree creation and hope the env works out. Here the agent **explores how the project is actually deployed locally first**, then owns a per-project `scripts/worktree.sh` bound to a strict contract — the same script the in-app `theocode-wt` tool executes, so terminal use and agent use can never drift.

- `wt-N` labels in the sidebar; children `wt-N.M` branch from their parent's branch and merge back into it (two levels, hard cap).
- Every worktree claims a **port block** — reserved dev frontend, dev backend, and supabase ports (`3100+100b` / `54321+100b`) recorded in `.env.ports`, with the worktree's supabase config patched to match — so parallel stacks never collide.
- The standing rule the agent works under: *when starting something fresh, commit where you are, then use theocode-wt — the logic is handled for you.*

## 3 · Sanity checks first

Finding ground truth with coding agents often isn't about reading diffs — it's information density: a random sample of the real output, a matplotlib graph, the running page. The agent is nudged to end every substantive turn with an **Evidence** list — a URL, a screenshot, an example output file, a plot — written under `.theocode/evidence/`.

Clicking any transcript link opens an **evidence tab** inside the app, grouped under its project with the project's accent color: URLs in a webview, images inline, JSON pretty-printed, `.patch` files colorized. Every turn that changed files also gets an automatic **combined diff** linked from its footer. Ask for three Kaggle datasets through an MLP and the receipts — dataset overview, training curves, test predictions, metrics vs baselines, full results JSON — are one click each.

## 4 · Rigorous subagent coordination

**Research subagents** fix a theory-of-mind problem: parents contaminate researchers by dumping their guesses into the prompt. The `theocode-research` tool splits the call — the **question** (with any hard requirements) is delivered to the researcher verbatim and alone; the **hypothesis** ("your guesses, context, and why you ask") is held back by theocode and echoed to the parent only when the report returns. Researchers run read-only and interrupt the parent when it's idle.

**Coding subagents** fan out over **task cards** — self-contained contracts (`goal`, `spec`, `files_in_scope`, `done_criteria`) validated with corrective errors. Each card runs full-capability in its own `wt-N.M` worktree with its own ports, sees only its card, commits on its branch, and never merges. `notes_for_merge` is coordinator-private and comes back attached to the result with a merge playbook. The coordinator merges children into its worktree; `wt-N → main` stays human.

Both kinds persist to a durable registry — an app restart can't orphan a finished report.

## Running it

```sh
cd onboarding-app
bun install
bun run start
```

Bun + TypeScript throughout; Electron runs the bundled output. See [`onboarding-app/README.md`](onboarding-app/README.md) for architecture detail (the OAuth engine, the MCP proxy, session storage, the turn runner) and dev helpers, and [`design.md`](.claude/skills/theocode-design-guidelines/SKILL.md) for the design system the UI conforms to.
