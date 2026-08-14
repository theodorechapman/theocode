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
- If the directory is not a git repository, run `git init` first (the worktree script requires it).
- You have MCP servers `theocode-vercel` and `theocode-supabase` (when connected in theocode) for platform operations — listing orgs/teams, creating projects, reading project settings. Prefer them for account-level operations; use the CLIs for local linking and files. If an MCP server responds 503 "not connected", note it in "Needs you" and fall back to the CLI.

## Vercel (when selected or detected)

1. **CLI**: `vercel --version`; if missing, `npm install -g vercel`.
2. **Auth**: `vercel whoami`. If not authenticated, add `vercel login` to "Needs you" and skip steps 3–4 (still do 5–6).
3. **Link**: if `.vercel/project.json` is absent, run `vercel link --yes` (creates an empty Vercel project named after the directory and links it). Do not create a second project if one is already linked.
4. **Secrets**: `vercel env pull .env.local` (creates the file if there are no envs yet). Document in the summary that new secrets are added with `vercel env add <NAME> <environment>` and re-pulled — never hand-edited into committed files.
5. **Gitignore**: ensure `.gitignore` covers `.vercel`, `.env*`, `!.env.example`, and `.worktrees/`.
6. **Worktree script**: write `scripts/worktree.sh` exactly as below (create `scripts/`, `chmod +x`). It creates an isolated git worktree per branch and claims a port block so parallel dev processes never collide.

```bash
#!/usr/bin/env bash
# scripts/worktree.sh — isolated worktree + port block per branch.
#   scripts/worktree.sh <branch>            create worktree + claim ports
#   scripts/worktree.sh --remove <branch>   remove worktree + release ports
set -euo pipefail

LOCK_ROOT="${HOME}/.theocode/port-locks"
REPO_NAME="$(basename "$(git rev-parse --show-toplevel)")"
mkdir -p "${LOCK_ROOT}" .worktrees

release() {
  local dir=".worktrees/$1"
  if [ -f "${dir}/.env.ports" ]; then
    lock="$(grep '^PORT_LOCK=' "${dir}/.env.ports" | cut -d= -f2 || true)"
    [ -n "${lock:-}" ] && rm -rf "${lock}"
  fi
  git worktree remove --force "${dir}" 2>/dev/null || true
  echo "removed ${dir}"
}

if [ "${1:-}" = "--remove" ]; then release "${2:?branch required}"; exit 0; fi

BRANCH="${1:?usage: scripts/worktree.sh <branch>}"
DIR=".worktrees/${BRANCH}"
git worktree add "${DIR}" -B "${BRANCH}" >/dev/null

# Claim the first free block: app ports 3100+100n, supabase ports 54321+100n.
for n in $(seq 0 49); do
  LOCK="${LOCK_ROOT}/${REPO_NAME}-block-${n}"
  if mkdir "${LOCK}" 2>/dev/null; then
    echo "${DIR}" > "${LOCK}/claim"
    APP_PORT=$((3100 + 100 * n))
    SB_BASE=$((54321 + 100 * n))
    cat > "${DIR}/.env.ports" <<EOF
PORT=${APP_PORT}
APP_PORT=${APP_PORT}
SUPABASE_API_PORT=${SB_BASE}
SUPABASE_DB_PORT=$((SB_BASE + 1))
SUPABASE_STUDIO_PORT=$((SB_BASE + 2))
PORT_LOCK=${LOCK}
EOF
    # Give the worktree's local supabase stack its own ports too.
    if [ -f "${DIR}/supabase/config.toml" ]; then
      sed -i.bak -E "s/^port = 54321$/port = ${SB_BASE}/; s/^port = 54322$/port = $((SB_BASE + 1))/; s/^port = 54323$/port = $((SB_BASE + 2))/" "${DIR}/supabase/config.toml"
      rm -f "${DIR}/supabase/config.toml.bak"
    fi
    echo "worktree ${DIR} ready — port block ${n} (app ${APP_PORT}, supabase ${SB_BASE}+)"
    exit 0
  fi
done
echo "no free port block" >&2; exit 1
```

## Supabase (when selected or detected)

1. **Docker**: `docker info`. If the daemon is not running but Docker is installed, note "start Docker Desktop" in "Needs you". If Docker is not installed at all, add "install Docker Desktop (https://docs.docker.com/desktop/)" to "Needs you" and continue — init/link/ports do not need it.
2. **CLI**: `supabase --version`; if missing, `brew install supabase/tap/supabase` (fall back to `npm install -g supabase`).
3. **Init**: if `supabase/config.toml` is absent, run `supabase init`.
4. **Local port block**: so multiple local Postgres stacks can coexist, claim a block from the SAME lock namespace the worktree script uses (this keeps the main checkout and its worktrees from colliding): pick the first `n` in 0–49 where `mkdir ~/.theocode/port-locks/<repo>-block-<n>` succeeds and write the repo path into `<lock>/claim`. Then rewrite the default ports in `supabase/config.toml` — `54321 → 54321+100n` (api), `54322 → +1` (db), `54323 → +2` (studio), and any other `543xx` defaults by the same `+100n` offset. Record the block in the summary. If the config already has non-default ports, leave them alone and claim nothing.
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
- Scripts: <scripts/worktree.sh written / already present>

## Needs you
- <only items a human must do, with the exact command; omit section if empty>
```
