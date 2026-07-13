#!/usr/bin/env bash
# Verify Issue metadata reviewer routing and legacy branch-prefix fallback
# without launching reviewer CLIs.

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

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/soroeru-review-routing.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT
git init -q "$TMP_ROOT/repo"
COMMON=$(git -C "$TMP_ROOT/repo" rev-parse --path-format=absolute --git-common-dir)
mkdir -p "$COMMON/soroeru-issue-worktrees"
cat > "$COMMON/soroeru-issue-worktrees/365.json" <<'EOF'
{"schema":1,"issue":365,"branch":"issue-365-review-routing","worktree":"/tmp/not-needed","owner":{"agent":"claude","session_hash":"abc","active":true,"generation":2,"updated_at":"2026-07-13T00:00:00Z"},"handoff_epoch":3,"review":{"epoch":3,"used":1,"limit":2,"reviewer":"claude"}}
EOF

CONTEXT=$(local_ai_review_select_context "issue-365-review-routing" "$TMP_ROOT/repo")
assert_eq() {
  if [ "$1" != "$2" ]; then
    printf 'expected %s, got %s\n' "$2" "$1" >&2
    exit 1
  fi
}
assert_eq "$CONTEXT" $'claude\t365\t3\t1\t2'
assert_eq "$(local_ai_review_select_context 'codex/legacy-work' "$TMP_ROOT/repo")" $'codex\tlegacy\t0\t0\t2'

if local_ai_review_select_context "issue-999-missing" "$TMP_ROOT/repo" >/dev/null 2>&1; then
  printf 'expected missing Issue metadata to fail\n' >&2
  exit 1
fi

printf '{broken' > "$COMMON/soroeru-issue-worktrees/366.json"
if local_ai_review_select_context "issue-366-corrupt" "$TMP_ROOT/repo" >/dev/null 2>&1; then
  printf 'expected corrupt Issue metadata to fail\n' >&2
  exit 1
fi

assert_reviewer "codex/test-local-review" "codex"
assert_reviewer "claude/test-local-review" "claude"
assert_reviewer "grok/test-local-review" "grok"
assert_reviewer "gemini/test-local-review" "gemini"
assert_skip "feature/test-local-review"
# antigravity/ has no reviewer defined; keep this assertion to catch
# accidental future mappings of this prefix.
assert_skip "antigravity/test-local-review"

printf 'local AI review branch mapping smoke check passed\n'
