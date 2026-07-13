#!/usr/bin/env bash

set -euo pipefail

SOURCE_ROOT=$(cd "$(dirname "$0")/.." && pwd)
HELPER="$SOURCE_ROOT/scripts/issue-worktree.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/soroeru-issue-worktree.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_eq() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected output to contain '$2', got: $1" ;;
  esac
}

assert_fails() {
  local output status
  set +e
  output=$("$@" 2>&1)
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "expected command to fail: $*"
  printf '%s\n' "$output"
}

setup_repo() {
  local remote=$1 repo=$2
  git init --bare "$remote" >/dev/null
  git init -b main "$repo" >/dev/null
  git -C "$repo" config user.name Test
  git -C "$repo" config user.email test@example.invalid
  printf 'fixture\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -m init >/dev/null
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push -u origin main >/dev/null
}

REMOTE="$TMP_ROOT/remote.git"
REPO="$TMP_ROOT/repo with spaces"
setup_repo "$REMOTE" "$REPO"

ISSUE_WORKTREE_SKIP_GITHUB=1 "$HELPER" create 365 demo --agent codex --session session-a --repo "$REPO"
WORKTREE="$REPO/.worktrees/issue-365-demo"
[ -d "$WORKTREE" ] || fail "worktree was not created"
assert_eq "$(git -C "$WORKTREE" branch --show-current)" "issue-365-demo"

STATUS=$("$HELPER" status 365 --repo "$REPO" --json)
assert_eq "$(printf '%s' "$STATUS" | jq -r .issue)" "365"
assert_eq "$(printf '%s' "$STATUS" | jq -r .handoff_epoch)" "1"
assert_eq "$(printf '%s' "$STATUS" | jq -r .review_budget_used)" "0"
assert_eq "$(printf '%s' "$STATUS" | jq -r .review_budget_limit)" "2"

OUT=$(assert_fails "$HELPER" acquire 365 --agent claude --session session-b --repo "$REPO")
assert_contains "$OUT" "active lease"

"$HELPER" handoff 365 --agent codex --session session-a --repo "$REPO" >/dev/null
assert_eq "$("$HELPER" status 365 --repo "$REPO" --json | jq -r .handoff_epoch)" "1"

OUT=$(assert_fails "$HELPER" handoff 365 --agent codex --session session-b --repo "$REPO")
assert_contains "$OUT" "owner process is still running"

COMMON=$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)
STATE_FILE="$COMMON/soroeru-issue-worktrees/365.json"
jq '.owner.pid=999999' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
"$HELPER" handoff 365 --agent codex --session session-b --repo "$REPO" >/dev/null
STATUS=$("$HELPER" status 365 --repo "$REPO" --json)
assert_eq "$(printf '%s' "$STATUS" | jq -r .handoff_epoch)" "2"
assert_eq "$(printf '%s' "$STATUS" | jq -r .review_budget_used)" "0"
assert_eq "$(printf '%s' "$STATUS" | jq -r .owner.agent)" "codex"

mkdir -p "$WORKTREE/state/ai-reviews"
: > "$WORKTREE/state/ai-reviews/.lock"
OUT=$(assert_fails "$HELPER" handoff 365 --agent claude --session session-c --repo "$REPO")
assert_contains "$OUT" "local AI review"
rm "$WORKTREE/state/ai-reviews/.lock"

"$HELPER" release 365 --session session-b --repo "$REPO" >/dev/null
printf 'dirty\n' > "$WORKTREE/dirty.txt"
OUT=$(assert_fails env ISSUE_WORKTREE_PR_STATE=MERGED "$HELPER" cleanup 365 --pr 999 --repo "$REPO")
assert_contains "$OUT" "dirty"
rm "$WORKTREE/dirty.txt"

OUT=$(assert_fails env ISSUE_WORKTREE_PR_STATE=CLOSED "$HELPER" cleanup 365 --pr 999 --repo "$REPO")
assert_contains "$OUT" "MERGED"

ISSUE_WORKTREE_PR_STATE=MERGED "$HELPER" cleanup 365 --pr 999 --repo "$REPO"
[ ! -e "$WORKTREE" ] || fail "worktree still exists after cleanup"
if git -C "$REPO" show-ref --verify --quiet refs/heads/issue-365-demo; then
  fail "local branch still exists after cleanup"
fi

printf 'issue worktree lifecycle tests passed\n'
