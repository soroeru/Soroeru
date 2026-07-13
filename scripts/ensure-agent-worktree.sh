#!/usr/bin/env bash
# ensure-agent-worktree.sh — diagnose a legacy persistent agent-lane worktree.
#
# Official agent lanes (under the primary working tree):
#   codex  → .worktrees/codex
#   claude → .worktrees/claude
#   grok   → .worktrees/grok
#   gemini → .worktrees/gemini
#
# Migration-only. It never creates a missing fixed lane; new work uses
# scripts/issue-worktree.sh.
#
# MUST rules (docs/github-operations.md §2):
#   - Primary working tree is human-only; agents never commit there.
#   - issue-implementation uses an Issue worktree, never a fixed lane.

set -euo pipefail

VALID_AGENTS="codex claude grok gemini"

usage() {
  cat <<'EOF'
ensure-agent-worktree.sh — diagnose a legacy persistent agent-lane worktree.

Official lanes (under the primary working tree):
  codex  → .worktrees/codex
  claude → .worktrees/claude
  grok   → .worktrees/grok
  gemini → .worktrees/gemini

Usage:
  scripts/ensure-agent-worktree.sh <codex|claude|grok|gemini>
      Print an existing legacy lane path. Refuse to create a missing lane.

  scripts/ensure-agent-worktree.sh --all
      Diagnose all four legacy lanes. Print existing paths; fail if missing.

  scripts/ensure-agent-worktree.sh --require-cwd <agent>
      Ensure the lane exists, then exit 0 only if cwd is that worktree root or
      a subdirectory. On failure print the expected path and exit 1 (no
      main-tree fallback).

  scripts/ensure-agent-worktree.sh --help

Do not use this helper for new work. Use scripts/issue-worktree.sh and the
issue-implementation or handoff-issue skill.
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

# Print registered worktree paths for the given primary repo (one per line).
list_registered_worktrees() {
  local primary=$1
  git -C "$primary" worktree list --porcelain | sed -n 's/^worktree //p'
}

# True if $2 matches a registered worktree path under $1 (canonical comparison).
is_registered_worktree() {
  local primary=$1 target=$2 path
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    if paths_equal "$path" "$target"; then
      return 0
    fi
  done < <(list_registered_worktrees "$primary")
  return 1
}

# Diagnose stale legacy registration without mutating it.
reject_stale_registration() {
  local primary=$1 path=$2
  if is_registered_worktree "$primary" "$path" && [ ! -d "$path" ]; then
    printf 'error: stale legacy worktree registration: %s (directory missing)\n' "$path" >&2
    printf 'error: inspect WIP and registration manually; diagnosis mode does not prune or force-remove.\n' >&2
    exit 1
  fi
}

# Diagnose an existing legacy lane; print absolute path on stdout.
ensure_one() {
  local agent=$1
  local primary path
  primary=$(primary_root)
  path=$(worktree_path_for "$primary" "$agent")
  path=$(canonicalize_path "$path")

  reject_stale_registration "$primary" "$path"

  if [ -d "$path" ] && is_registered_worktree "$primary" "$path"; then
    printf 'ensure-agent-worktree: %s already present at %s\n' "$agent" "$path" >&2
    printf '%s\n' "$path"
    return 0
  fi

  if [ -e "$path" ] && ! is_registered_worktree "$primary" "$path"; then
    printf 'error: path exists but is not a registered worktree: %s\n' "$path" >&2
    printf 'error: remove or rename it, then re-run this script.\n' >&2
    exit 1
  fi

  if is_registered_worktree "$primary" "$path" && [ ! -d "$path" ]; then
    reject_stale_registration "$primary" "$path"
  fi

  printf 'error: legacy %s lane is missing: %s\n' "$agent" "$path" >&2
  printf 'error: fixed lanes are migration-only and are not recreated.\n' >&2
  printf 'error: use scripts/issue-worktree.sh for new Issue work.\n' >&2
  exit 1
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
