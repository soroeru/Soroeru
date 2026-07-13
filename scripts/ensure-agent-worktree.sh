#!/usr/bin/env bash
# ensure-agent-worktree.sh — bootstrap or resolve a persistent agent-lane worktree.
#
# Official agent lanes (paths are under the primary working tree):
#   codex  → .worktrees/codex
#   claude → .worktrees/claude
#   grok   → .worktrees/grok
#   gemini → .worktrees/gemini
#
# Usage:
#   scripts/ensure-agent-worktree.sh <codex|claude|grok|gemini>
#       Ensure the lane worktree exists (create if missing). Print its absolute
#       path on stdout. Messages go to stderr.
#
#   scripts/ensure-agent-worktree.sh --all
#       Ensure all four lanes. Print each absolute path on its own line.
#
#   scripts/ensure-agent-worktree.sh --require-cwd <agent>
#       Ensure the lane exists, then exit 0 only if the current working
#       directory is that worktree root or a subdirectory of it. On failure
#       print the expected path and exit 1 (no main-tree fallback).
#
#   scripts/ensure-agent-worktree.sh --help
#
# MUST rules (see docs/github-operations.md §2):
#   - The primary working tree (main clone) is human-only.
#   - Agents never commit on the primary tree.
#   - issue-implementation and other skill paths always use this script and
#     continue only inside the matching agent worktree.
#
# Idempotent. Safe to re-run.

set -euo pipefail

VALID_AGENTS="codex claude grok gemini"

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

# Resolve the primary working tree (the one that owns the shared .git directory).
# Works when invoked from the primary tree or from any linked worktree.
primary_root() {
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
    || common=$(cd "$(git rev-parse --git-common-dir)" && pwd)
  # common is .../repo/.git (directory) or rarely a path ending in /.git
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

# True if $1 is registered as a worktree path for this repository.
is_registered_worktree() {
  local target=$1 path
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    if [ "$path" = "$target" ]; then
      return 0
    fi
  done < <(git worktree list --porcelain | sed -n 's/^worktree //p')
  return 1
}

# Ensure lane exists; print absolute path on stdout.
ensure_one() {
  local agent=$1
  local primary path
  primary=$(primary_root)
  path=$(worktree_path_for "$primary" "$agent")

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

  mkdir -p "$(dirname "$path")"
  # Run add from primary so relative paths stay consistent.
  git -C "$primary" fetch origin 2>/dev/null || true
  if git -C "$primary" rev-parse --verify origin/main >/dev/null 2>&1; then
    git -C "$primary" worktree add "$path" origin/main
  else
    git -C "$primary" worktree add "$path" main
  fi

  printf 'ensure-agent-worktree: created %s at %s\n' "$agent" "$path" >&2
  printf '%s\n' "$path"
}

require_cwd() {
  local agent=$1
  local path cwd
  path=$(ensure_one "$agent")
  cwd=$(pwd -P 2>/dev/null || pwd)
  # Normalize path for prefix check (best-effort physical path).
  if command -v realpath >/dev/null 2>&1; then
    path=$(realpath "$path")
    cwd=$(realpath "$cwd")
  fi

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
