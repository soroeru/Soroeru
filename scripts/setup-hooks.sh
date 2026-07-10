#!/usr/bin/env bash
# setup-hooks.sh — wire up the local AI review git hooks for this repo.
#
# Idempotent. Run this once after cloning, and again any time the
# .githooks/ contents are pulled fresh. It does the minimum:
#
#   1. verify required commands are available
#   2. mark every hook executable
#   3. point `git config core.hooksPath` at .githooks
#
# The hooks themselves live in .githooks/ so they are tracked in git
# and kept in sync across machines.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

if [ ! -d ".githooks" ]; then
  printf 'error: .githooks directory not found at %s/.githooks\n' "$REPO_ROOT" >&2
  exit 1
fi

# --- 1. Verify required tools ------------------------------------
missing=0
require() {
  local cmd=$1 hint=$2
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'missing: %s — %s\n' "$cmd" "$hint" >&2
    missing=$((missing + 1))
  fi
}

require bash    "any modern bash (3.2+ ok); pre-installed on macOS"
require git     "https://git-scm.com/"
require jq      "brew install jq"

if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
  printf 'missing: shasum or sha256sum — checksum command required for diff hashes\n' >&2
  missing=$((missing + 1))
fi

# Reviewer CLIs are required only when their respective branch
# prefix is in use, so we warn but do not fail the setup.
warn_missing_reviewer() {
  local cmd=$1 hint=$2
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'warning: %s not on PATH — %s reviews will fail until installed (%s)\n' \
      "$cmd" "$cmd" "$hint" >&2
  fi
}
warn_missing_reviewer claude "https://docs.claude.com/claude-code"
warn_missing_reviewer codex  "https://github.com/openai/codex"
warn_missing_reviewer grok   "install the Grok Build CLI (xAI)"
# Gemini review uses the Antigravity CLI binary `agy`, not a `gemini`-named binary.
warn_missing_reviewer agy    "https://antigravity.dev (Antigravity CLI for Gemini review)"

if [ "$missing" -gt 0 ]; then
  printf '\ninstall the missing tools above and re-run this script.\n' >&2
  exit 1
fi

# --- 2. Make hook files executable -------------------------------
# All committed scripts under .githooks/ should be executable.
# Limit chmod to regular files so we do not touch directories.
find .githooks -type f \( -name 'post-commit' -o -name 'pre-commit' -o -name '*.sh' \) \
  -exec chmod +x {} +

# --- 3. Point git at the hooks dir -------------------------------
CURRENT=$(git config --local --get core.hooksPath 2>/dev/null || echo "")
if [ "$CURRENT" = ".githooks" ]; then
  printf 'core.hooksPath already set to .githooks\n'
else
  git config --local core.hooksPath .githooks
  printf 'set core.hooksPath = .githooks (was: %s)\n' "${CURRENT:-<unset>}"
fi

printf '\nhooks installed. local AI review will run on commits made\n'
printf 'on branches prefixed with claude/, codex/, grok/, or gemini/.\n'
