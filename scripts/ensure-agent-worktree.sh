#!/usr/bin/env bash
# ensure-agent-worktree.sh — bootstrap or resolve a persistent agent-lane worktree.
#
# Official agent lanes (under the primary working tree):
#   codex  → .worktrees/codex
#   claude → .worktrees/claude
#   grok   → .worktrees/grok
#   gemini → .worktrees/gemini
#
# New lanes are checked out at origin/main (usually detached HEAD). That is
# expected: skill / github-operations §2.2 always create a named issue branch
# before implementation. Do not implement while still detached.
#
# Idempotent. Safe to re-run.
#
# MUST rules (docs/github-operations.md §2):
#   - Primary working tree is human-only; agents never commit there.
#   - issue-implementation always runs inside the matching agent worktree.

set -euo pipefail

VALID_AGENTS="codex claude grok gemini"

usage() {
  cat <<'EOF'
ensure-agent-worktree.sh — bootstrap or resolve a persistent agent-lane worktree.

Official lanes (under the primary working tree):
  codex  → .worktrees/codex
  claude → .worktrees/claude
  grok   → .worktrees/grok
  gemini → .worktrees/gemini

Usage:
  scripts/ensure-agent-worktree.sh <codex|claude|grok|gemini>
      Ensure the lane worktree exists (create if missing). Print its absolute
      path on stdout. Messages go to stderr.

  scripts/ensure-agent-worktree.sh --all
      Ensure all four lanes. Print each absolute path on its own line.

  scripts/ensure-agent-worktree.sh --require-cwd <agent>
      Ensure the lane exists, then exit 0 only if cwd is that worktree root or
      a subdirectory. On failure print the expected path and exit 1 (no
      main-tree fallback).

  scripts/ensure-agent-worktree.sh --help

New lanes start at origin/main (often detached HEAD). Create the issue branch
with git switch -c <agent>/issue-… origin/main before implementing.
EOF
}

# Canonical absolute path when the path exists; otherwise normalize logically.
canonicalize_path() {
  local p=$1
  if [ -e "$p" ] || [ -L "$p" ]; then
    if command -v realpath >/dev/null 2>&1; then
      realpath "$p"
      return 0
    fi
    if command -v python3 >/dev/null 2>&1; then
      python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$p"
      return 0
    fi
  fi
  # Path may not exist yet (about to create). Best-effort absolute form.
  case "$p" in
    /*) printf '%s\n' "$p" ;;
    *) printf '%s/%s\n' "$(pwd -P 2>/dev/null || pwd)" "$p" ;;
  esac
}

paths_equal() {
  local a b
  a=$(canonicalize_path "$1")
  b=$(canonicalize_path "$2")
  [ "$a" = "$b" ]
}

# Resolve the primary working tree (owns the shared .git directory).
primary_root() {
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
    || common=$(cd "$(git rev-parse --git-common-dir)" && pwd)
  case "$common" in
    */.git) printf '%s\n' "${common%/.git}" ;;
    */.git/) printf '%s\n' "${common%/.git/}" ;;
    *)
      printf 'error: unexpected git-common-dir: %s\n' "$common" >&2
      exit 1
      ;;
  esac
}

is_valid_agent() {
  local agent=$1 a
  for a in $VALID_AGENTS; do
    if [ "$a" = "$agent" ]; then
      return 0
    fi
  done
  return 1
}

worktree_path_for() {
  local primary=$1 agent=$2
  printf '%s/.worktrees/%s\n' "$primary" "$agent"
}

# Print registered worktree paths (one per line), absolute as Git reports them.
list_registered_worktrees() {
  git worktree list --porcelain | sed -n 's/^worktree //p'
}

# True if $1 matches a registered worktree path (canonical comparison).
is_registered_worktree() {
  local target=$1 path
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    if paths_equal "$path" "$target"; then
      return 0
    fi
  done < <(list_registered_worktrees)
  return 1
}

# If Git still registers $path but the directory is gone, drop the stale entry.
repair_stale_registration() {
  local primary=$1 path=$2
  if is_registered_worktree "$path" && [ ! -d "$path" ]; then
    printf 'ensure-agent-worktree: stale registration for %s (dir missing); repairing\n' \
      "$path" >&2
    # Prefer remove; fall back to prune of dead entries.
    if ! git -C "$primary" worktree remove --force "$path" 2>/dev/null; then
      git -C "$primary" worktree prune -v >&2 || true
    fi
    if is_registered_worktree "$path"; then
      printf 'error: could not clear stale worktree registration for %s\n' "$path" >&2
      printf 'error: try: git worktree remove --force %s && git worktree prune\n' "$path" >&2
      exit 1
    fi
  fi
}

# Ensure lane exists; print absolute path on stdout.
ensure_one() {
  local agent=$1
  local primary path
  primary=$(primary_root)
  path=$(worktree_path_for "$primary" "$agent")
  path=$(canonicalize_path "$path")

  repair_stale_registration "$primary" "$path"

  if [ -d "$path" ] && is_registered_worktree "$path"; then
    printf 'ensure-agent-worktree: %s already present at %s\n' "$agent" "$path" >&2
    printf '%s\n' "$path"
    return 0
  fi

  if [ -e "$path" ] && ! is_registered_worktree "$path"; then
    printf 'error: path exists but is not a registered worktree: %s\n' "$path" >&2
    printf 'error: remove or rename it, then re-run this script.\n' >&2
    exit 1
  fi

  if is_registered_worktree "$path" && [ ! -d "$path" ]; then
    # Should have been repaired; belt-and-suspenders.
    repair_stale_registration "$primary" "$path"
  fi

  mkdir -p "$(dirname "$path")"
  git -C "$primary" fetch origin 2>/dev/null || true
  # Detached HEAD at origin/main is expected; skills create named issue branches next.
  if git -C "$primary" rev-parse --verify origin/main >/dev/null 2>&1; then
    git -C "$primary" worktree add "$path" origin/main
  else
    git -C "$primary" worktree add "$path" main
  fi

  path=$(canonicalize_path "$path")
  printf 'ensure-agent-worktree: created %s at %s (detached at trunk tip; create an issue branch before implementing)\n' \
    "$agent" "$path" >&2
  printf '%s\n' "$path"
}

require_cwd() {
  local agent=$1
  local path cwd
  path=$(ensure_one "$agent")
  path=$(canonicalize_path "$path")
  cwd=$(pwd -P 2>/dev/null || pwd)
  cwd=$(canonicalize_path "$cwd")

  case "$cwd" in
    "$path"|"$path"/*)
      printf 'ensure-agent-worktree: cwd OK for %s (%s)\n' "$agent" "$cwd" >&2
      printf '%s\n' "$path"
      return 0
      ;;
  esac

  printf 'error: cwd is not inside the %s agent worktree.\n' "$agent" >&2
  printf 'error:   cwd:      %s\n' "$cwd" >&2
  printf 'error:   required: %s (or a subdirectory)\n' "$path" >&2
  printf 'error: cd there (or re-launch the agent with that cwd), then continue.\n' >&2
  printf 'error: the primary clone is human-only — agents must not commit there.\n' >&2
  exit 1
}

main() {
  if [ "$#" -lt 1 ]; then
    usage >&2
    exit 2
  fi

  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --all)
      local agent
      for agent in $VALID_AGENTS; do
        ensure_one "$agent"
      done
      exit 0
      ;;
    --require-cwd)
      if [ "$#" -ne 2 ]; then
        printf 'usage: %s --require-cwd <codex|claude|grok|gemini>\n' "$0" >&2
        exit 2
      fi
      if ! is_valid_agent "$2"; then
        printf 'error: unknown agent %q (want: %s)\n' "$2" "$VALID_AGENTS" >&2
        exit 2
      fi
      require_cwd "$2"
      exit 0
      ;;
    -*)
      printf 'error: unknown option %q\n' "$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if ! is_valid_agent "$1"; then
        printf 'error: unknown agent %q (want: %s)\n' "$1" "$VALID_AGENTS" >&2
        exit 2
      fi
      if [ "$#" -ne 1 ]; then
        printf 'usage: %s <codex|claude|grok|gemini>\n' "$0" >&2
        exit 2
      fi
      ensure_one "$1"
      exit 0
      ;;
  esac
}

main "$@"
