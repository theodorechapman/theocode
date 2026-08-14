---
name: theocode-project-setup
description: Set up Vercel (deploy + secrets) and/or Supabase (Postgres, auth, backend) for a theocode project, including worktree/port isolation scripts, working idempotently and conforming existing projects instead of clobbering them.
when-to-use: Invoked by theocode after the user answers the project-setup prompt (new project or first open of an existing one). Also usable directly when asked to "set up vercel", "set up supabase", or "set up this project's infra".
argument-hint: "mode + answers are provided in the invoking prompt"
---

# theocode project setup

You are setting up infrastructure for the project in the current working directory. The invoking prompt tells you:

- **mode** — `new` (directory was empty) or `existing` (directory already had files)
- **Vercel selected** — whether the user wants Vercel for deploys and secret storage
- **Supabase selected** — whether the user wants Supabase for Postgres, auth, or backend
- **detection** — whether Vercel/Supabase config was already found in the directory

## Ground rules

- Work autonomously; never ask questions. When a step needs something only the user can do (an interactive login, installing Docker Desktop), skip it, continue with everything else, and list it under "Needs you" in the final summary.
- Be idempotent and conforming: re-running must be safe. Never delete or rewrite existing config; only add what is missing. In `existing` mode, treat detection as the source of truth and complete the gaps (e.g. `vercel.json` present but not linked → link it).
- Secrets are never committed. Vercel env is the source of truth for secrets; local copies live only in gitignored `.env.local`.
- You have MCP servers `theocode-vercel` and `theocode-supabase` (when connected in theocode) for platform operations — listing orgs/teams, creating projects, reading project settings. Prefer them for account-level operations; use the CLIs for local linking and files. If an MCP server responds 503 "not connected", note it in "Needs you" and fall back to the CLI.

## Always — regardless of which options were selected

Do these even when neither Vercel nor Supabase was selected:

1. **Git**: if the directory is not a git repository, run `git init` and make an initial commit.
2. **Worktree script**: theocode installs the canonical worktree script at `scripts/worktree.sh` (the theocode-wt tool executes this exact script, so terminal use and in-app use never drift). Verify it exists and is executable; if it is somehow missing, report that in "Needs you" — do NOT write your own version. Commit it so the team shares it. Usage, for reference:
   - `scripts/worktree.sh new [--parent wt-N] [--base <branch>] [--branch <name>]` — next free wt-N (or child wt-N.M branched from wt-N), claims a port block (app 3100+100b, supabase 54321+100b, recorded in the worktree's `.env.ports`), patches the worktree's supabase ports.
   - `scripts/worktree.sh remove wt-N [--cascade]` — refuses while children exist unless cascaded; releases port blocks; keeps branches.
3. **Gitignore**: ensure `.gitignore` covers `.worktrees/`, `.grok/`, `.theocode/`, `.env*`, and `!.env.example`.

## Vercel (when selected or detected)

1. **CLI**: `vercel --version`; if missing, `npm install -g vercel`.
2. **Auth**: `vercel whoami`. If not authenticated, add `vercel login` to "Needs you" and skip steps 3–4 (still do 5).
3. **Link**: if `.vercel/project.json` is absent, run `vercel link --yes` (creates an empty Vercel project named after the directory and links it). Do not create a second project if one is already linked.
4. **Secrets**: `vercel env pull .env.local` (creates the file if there are no envs yet). Document in the summary that new secrets are added with `vercel env add <NAME> <environment>` and re-pulled — never hand-edited into committed files.
5. **Gitignore**: additionally ensure `.vercel` is ignored.

## Supabase (when selected or detected)

1. **Docker**: `docker info`. If the daemon is not running but Docker is installed, note "start Docker Desktop" in "Needs you". If Docker is not installed at all, add "install Docker Desktop (https://docs.docker.com/desktop/)" to "Needs you" and continue — init/link/ports do not need it.
2. **CLI**: `supabase --version`; if missing, `brew install supabase/tap/supabase` (fall back to `npm install -g supabase`).
3. **Init**: if `supabase/config.toml` is absent, run `supabase init`.
4. **Local port block**: so multiple local Postgres stacks can coexist, claim a block from the SAME lock namespace the worktree script uses (this keeps the main checkout and its worktrees from colliding): pick the first `n` in 0–49 where `mkdir ~/.theocode/port-locks/<repo>-block-<n>` succeeds and write the repo path into `<lock>/claim` — identical to what `scripts/worktree.sh` does. Then rewrite the default ports in `supabase/config.toml` — `54321 → 54321+100n` (api), `54322 → +1` (db), `54323 → +2` (studio), and any other `543xx` defaults by the same `+100n` offset. Record the block in the summary. If the config already has non-default ports, leave them alone and claim nothing.
5. **Auth**: `supabase projects list`. If unauthenticated, prefer the `theocode-supabase` MCP server for the remote steps; if that is also unavailable, add `supabase login` to "Needs you" and skip step 6.
6. **Remote project + link**: if `supabase/.temp/project-ref` (or `supabase link` status) shows no linked project: find the user's organization (MCP `list_organizations` or `supabase orgs list`), create a project named after the directory (MCP `create_project` or `supabase projects create`), then `supabase link --project-ref <ref>`. Reuse an existing same-named project instead of creating a duplicate.
7. **Secrets**: put `SUPABASE_URL` and `SUPABASE_ANON_KEY` (from MCP project settings or `supabase projects api-keys`) into `.env.local`. If Vercel is also set up and authenticated, store them in Vercel too (`vercel env add`) so Vercel remains the secret source of truth.

## Finish

End with exactly this summary structure:

```
## Setup summary
- Vercel: <done / skipped / partial — one line of what happened>
- Supabase: <done / skipped / partial — one line>
- Ports: <blocks claimed, or none>
- Scripts: <scripts/worktree.sh verified and committed / missing (reported)>

## Needs you
- <only items a human must do, with the exact command; omit section if empty>
```
