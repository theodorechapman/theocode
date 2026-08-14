#!/usr/bin/env bash
# theocode worktrees — canonical implementation, installed by theocode as
# scripts/worktree.sh in every project. The theocode-wt tool executes THIS
# script, so terminal use and in-app use can never drift.
#
#   scripts/worktree.sh new [--parent wt-N[.M]] [--base <branch>] [--branch <name>]
#   scripts/worktree.sh remove <wt-N[.M]> [--cascade]
#
# Naming encodes merge topology, hard-capped at two levels:
#   wt-N    top-level, branched from HEAD; wt-N.M  child of wt-N, branched
#   from wt-N's branch (merge back into wt-N). A caller already in a child
#   gets a SIBLING, never a third level.
# Every worktree claims a flat port block (app 3100+100b, supabase 54321+100b)
# via atomic mkdir locks under $THEOCODE_HOME/port-locks (default ~/.theocode).
# Machine-readable KEY=VALUE lines go to stdout; prose goes to stderr.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
REPO="$(basename "$ROOT")"
WT_ROOT="$ROOT/.worktrees"
LOCK_ROOT="${THEOCODE_HOME:-$HOME/.theocode}/port-locks"

die() { echo "$1" >&2; exit 1; }

branch_exists() { git -C "$ROOT" show-ref --verify --quiet "refs/heads/$1"; }

ensure_ignored() {
  local entry="$1" file="$ROOT/.gitignore"
  touch "$file"
  grep -qxF "$entry" "$file" || printf '%s\n' "$entry" >> "$file"
}

release_lock_for() {
  local dir="$1" lock
  for lock in "$LOCK_ROOT"/*/; do
    [ -f "${lock}claim" ] || continue
    if [ "$(cat "${lock}claim")" = "$dir" ]; then
      rm -rf "$lock"
      return 0
    fi
  done
  return 0
}

cmd_new() {
  local parent="" base="" branch=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --parent) parent="$2"; shift 2 ;;
      --base) base="$2"; shift 2 ;;
      --branch) branch="$2"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  git -C "$ROOT" rev-parse HEAD >/dev/null 2>&1 \
    || die "The repository has no commits yet — commit your work first, then create a worktree."
  mkdir -p "$WT_ROOT" "$LOCK_ROOT"

  # Two-level hierarchy: children of the caller's top-level worktree.
  local prefix="wt-"
  if [ -n "$parent" ]; then
    local parent_label="${parent%%.*}"
    local parent_dir="$WT_ROOT/$parent_label"
    if [ -d "$parent_dir" ]; then
      prefix="${parent_label}."
      local parent_branch
      parent_branch="$(git -C "$parent_dir" branch --show-current || true)"
      # Detached HEAD must not silently rebase the child onto project HEAD.
      base="${parent_branch:-$base}"
    fi
  fi

  # Never reuse a label whose directory OR branch still exists — removal
  # keeps branches, and -B would force-reset them.
  local n=1 label
  while :; do
    label="${prefix}${n}"
    [ -d "$WT_ROOT/$label" ] || branch_exists "$label" || break
    n=$((n + 1))
  done
  branch="${branch:-$label}"
  local dir="$WT_ROOT/$label"
  git -C "$ROOT" worktree add "$dir" -B "$branch" ${base:+"$base"} >&2
  ensure_ignored ".worktrees/"

  # Claim the first free port block for this repo (flat, name-independent).
  local block=-1 lock i
  for i in $(seq 0 49); do
    lock="$LOCK_ROOT/$REPO-block-$i"
    if mkdir "$lock" 2>/dev/null; then
      printf '%s' "$dir" > "$lock/claim"
      block=$i
      break
    fi
  done
  [ "$block" -ge 0 ] || die "No free port block (50 in use for this repo)"
  local app=$((3100 + 100 * block)) sb=$((54321 + 100 * block))
  cat > "$dir/.env.ports" <<EOF
PORT=$app
APP_PORT=$app
SUPABASE_API_PORT=$sb
SUPABASE_DB_PORT=$((sb + 1))
SUPABASE_STUDIO_PORT=$((sb + 2))
PORT_LOCK=$lock
EOF

  # The worktree's local supabase stack gets its own ports too.
  if [ -f "$dir/supabase/config.toml" ]; then
    sed -i.bak -E \
      -e "s/^port = 54321$/port = $sb/" \
      -e "s/^port = 54322$/port = $((sb + 1))/" \
      -e "s/^port = 54323$/port = $((sb + 2))/" \
      "$dir/supabase/config.toml"
    rm -f "$dir/supabase/config.toml.bak"
  fi

  echo "worktree $label ready at $dir (branch $branch, app $app, supabase $sb+)" >&2
  echo "WT_LABEL=$label"
  echo "WT_BRANCH=$branch"
  echo "WT_PATH=$dir"
  echo "WT_APP_PORT=$app"
  echo "WT_SB_PORT=$sb"
}

cmd_remove() {
  local label="${1:-}" cascade="no"
  [ "${2:-}" = "--cascade" ] && cascade="yes"
  printf '%s' "$label" | grep -qE '^wt-[0-9]+(\.[0-9]+)?$' \
    || die "Invalid worktree name \"$label\" — expected wt-N or wt-N.M."
  [ -d "$WT_ROOT/$label" ] || die "No worktree named $label"

  local children=()
  local child
  for child in "$WT_ROOT/$label".*; do
    [ -d "$child" ] && children+=("$(basename "$child")")
  done
  if [ "${#children[@]}" -gt 0 ] && [ "$cascade" = "no" ]; then
    die "$label has live child worktrees (${children[*]}). Remove them first, or pass --cascade to remove the whole family."
  fi

  local removed=()
  for name in "${children[@]:-}" "$label"; do
    [ -n "$name" ] || continue
    local dir="$WT_ROOT/$name"
    release_lock_for "$dir"
    git -C "$ROOT" worktree remove --force "$dir" >&2 2>/dev/null \
      || { rm -rf "$dir"; git -C "$ROOT" worktree prune >&2 || true; }
    removed+=("$name")
  done
  echo "removed ${removed[*]} (port blocks released, branches kept)" >&2
  echo "WT_REMOVED=$(IFS=,; echo "${removed[*]}")"
}

case "${1:-}" in
  new) shift; cmd_new "$@" ;;
  remove) shift; cmd_remove "$@" ;;
  *) die "usage: worktree.sh new [--parent wt-N] [--base branch] [--branch name] | remove wt-N[.M] [--cascade]" ;;
esac
