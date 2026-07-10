#!/usr/bin/env bash
# Verify local AI review branch-prefix to reviewer mapping without
# launching reviewer CLIs.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

# shellcheck source=/dev/null
. "$REPO_ROOT/.githooks/config"
# shellcheck source=/dev/null
. "$REPO_ROOT/.githooks/lib/reviewer-selection.sh"

assert_reviewer() {
  local branch=$1
  local expected=$2
  local actual
  actual=$(local_ai_review_select_reviewer "$branch")
  if [ "$actual" != "$expected" ]; then
    printf 'expected %s for %s, got %s\n' "$expected" "$branch" "$actual" >&2
    exit 1
  fi
}

assert_skip() {
  local branch=$1
  if actual=$(local_ai_review_select_reviewer "$branch"); then
    printf 'expected %s to skip, got %s\n' "$branch" "$actual" >&2
    exit 1
  fi
}

assert_reviewer "codex/test-local-review" "codex"
assert_reviewer "claude/test-local-review" "claude"
assert_reviewer "grok/test-local-review" "grok"
assert_reviewer "gemini/test-local-review" "gemini"
assert_skip "feature/test-local-review"
# antigravity/ has no reviewer defined; keep this assertion to catch
# accidental future mappings of this prefix.
assert_skip "antigravity/test-local-review"

printf 'local AI review branch mapping smoke check passed\n'
