#!/usr/bin/env bash
# local-ai-review.sh — orchestrator for the local AI review hook.
#
# Computes the branch diff, runs the reviewer CLI in a watchdog'd
# subshell, and saves the output. Invoked by .githooks/post-commit
# in the background; this script must therefore tolerate detachment
# from the parent shell.
#
# Usage:
#   LOCAL_AI_REVIEW_RUNNING=1 .githooks/lib/local-ai-review.sh <reviewer> <branch>
#     reviewer: "claude" | "codex"
#     branch:   the current branch name (passed in to avoid races
#               if the user switches branches mid-run)

set -uo pipefail

# All review artifacts can contain branch diffs and reviewer stderr,
# both of which may include sensitive source or accidentally captured
# secrets. Restrict to the current user before any file is created.
umask 077

GITHOOKS_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(git rev-parse --show-toplevel)

# shellcheck source=/dev/null
. "$GITHOOKS_DIR/config"
# shellcheck source=/dev/null
. "$GITHOOKS_DIR/lib/last-reviewed.sh"

cd "$REPO_ROOT"

REVIEWER=${1:?reviewer required (claude|codex)}
BRANCH=${2:?branch required}
# Commit SHA is optional for backward compatibility with manual
# invocations, but post-commit always passes it so the review is
# pinned to the commit that triggered the hook.
COMMIT_SHA=${3:-HEAD}

STATE_DIR="$LOCAL_AI_REVIEW_STATE_DIR"
mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR" 2>/dev/null || true

LOG="$STATE_DIR/last-run.log"
ERR="$STATE_DIR/last-error.log"

log()  { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }
warn() { printf '[%s] WARN: %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }
fail() { printf '[%s] ERROR: %s\n' "$(date -u +%FT%TZ)" "$*" >> "$ERR"; }

sha256_file() {
  local file=$1
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 < "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$file" | awk '{print $1}'
  else
    fail "missing checksum command: install shasum or sha256sum"
    return 1
  fi
}

PHASE="init"
set_phase() {
  PHASE=$1
  log "phase=$PHASE"
}

cleanup_temp_for_pid() {
  local pid=$1 reason=$2 f
  for f in \
    "$STATE_DIR/.diff.$pid" \
    "$STATE_DIR/.payload.$pid" \
    "$STATE_DIR/.review-out.$pid" \
    "$STATE_DIR/.review-err.$pid"; do
    if [ -e "$f" ]; then
      rm -f "$f"
      warn "removed stale temp file=$f pid=$pid reason=$reason"
    fi
  done
}

cleanup_orphan_temp_files() {
  local f pid
  shopt -s nullglob
  for f in \
    "$STATE_DIR"/.diff.* \
    "$STATE_DIR"/.payload.* \
    "$STATE_DIR"/.review-out.* \
    "$STATE_DIR"/.review-err.*; do
    pid=${f##*.}
    case "$pid" in
      *[!0-9]*|'') continue ;;
    esac
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$f"
      warn "removed orphan temp file=$f pid=$pid"
    fi
  done
  shopt -u nullglob
}

# --- Lock acquisition ------------------------------------------
LOCK_FILE="$STATE_DIR/.lock"
NOW_EPOCH=$(date +%s)
LOCK_TOKEN="$$:$NOW_EPOCH"

cleanup_orphan_temp_files

if [ -f "$LOCK_FILE" ]; then
  LOCK_PID=""
  LOCK_TS=""
  IFS=':' read -r LOCK_PID LOCK_TS < "$LOCK_FILE" || true
  if [ -z "$LOCK_PID" ] || [ -z "$LOCK_TS" ]; then
    warn "malformed stale lock, removing contents=$(cat "$LOCK_FILE" 2>/dev/null || true)"
    rm -f "$LOCK_FILE"
  elif kill -0 "$LOCK_PID" 2>/dev/null; then
    AGE=$((NOW_EPOCH - ${LOCK_TS:-0}))
    if [ "$AGE" -lt "$LOCAL_AI_REVIEW_LOCK_TIMEOUT_SEC" ]; then
      log "skip: another review is in progress (pid=$LOCK_PID, age=${AGE}s)"
      exit 0
    fi
    warn "stale lock pid=$LOCK_PID age=${AGE}s, taking over"
    kill -TERM "$LOCK_PID" 2>/dev/null || true
    cleanup_temp_for_pid "$LOCK_PID" "stale-lock-takeover"
  else
    AGE=$((NOW_EPOCH - ${LOCK_TS:-0}))
    warn "dead stale lock pid=$LOCK_PID age=${AGE}s, removing"
    cleanup_temp_for_pid "$LOCK_PID" "dead-stale-lock"
    rm -f "$LOCK_FILE"
  fi
fi

printf '%s\n' "$LOCK_TOKEN" > "$LOCK_FILE"
set_phase "lock-acquired pid=$$"

# Cleanup removes auxiliary files unconditionally, but the lock file
# only when its contents still match our token — so a successor
# process (after timeout / takeover) cannot have its lock removed
# by our exit trap.
cleanup_files=()
cleanup() {
  local status=$?
  local f stored
  for f in "${cleanup_files[@]}"; do
    if [ -e "$f" ]; then
      rm -f "$f"
      warn "cleanup removed temp file=$f phase=$PHASE status=$status"
    fi
  done
  if [ -f "$LOCK_FILE" ]; then
    stored=$(cat "$LOCK_FILE" 2>/dev/null || true)
    if [ "$stored" = "$LOCK_TOKEN" ]; then
      rm -f "$LOCK_FILE"
      log "cleanup removed lock phase=$PHASE status=$status"
    fi
  fi
  if [ "$status" -ne 0 ]; then
    fail "exit status=$status phase=$PHASE reviewer=$REVIEWER branch=$BRANCH commit=$COMMIT_SHA"
  fi
}
signal_exit() {
  local signal=$1 status=$2
  fail "signal=$signal phase=$PHASE reviewer=$REVIEWER branch=$BRANCH commit=$COMMIT_SHA"
  exit "$status"
}
trap cleanup EXIT
trap 'signal_exit HUP 129' HUP
trap 'signal_exit INT 130' INT
trap 'signal_exit TERM 143' TERM

log "start reviewer=$REVIEWER branch=$BRANCH commit=$COMMIT_SHA"

# Resolve the pinned commit once. If it has gone away (e.g. because
# of a hard reset between commit and background launch) we cannot
# meaningfully review.
set_phase "resolve-commit"
if ! COMMIT_SHA=$(git rev-parse --verify "${COMMIT_SHA}^{commit}" 2>/dev/null); then
  warn "commit $COMMIT_SHA not resolvable; skipping"
  exit 0
fi

# --- Compute merge-base ----------------------------------------
set_phase "merge-base"
if ! MERGE_BASE=$(git merge-base "$LOCAL_AI_REVIEW_BASE_REF" "$COMMIT_SHA" 2>/dev/null); then
  warn "no merge-base with $LOCAL_AI_REVIEW_BASE_REF; skipping"
  exit 0
fi

# --- Compute diff against allowed paths ------------------------
set_phase "diff"
DIFF_FILE="$STATE_DIR/.diff.$$"
cleanup_files+=("$DIFF_FILE")

git diff "$MERGE_BASE" "$COMMIT_SHA" -- "${LOCAL_AI_REVIEW_TARGET_PATHS[@]}" > "$DIFF_FILE"
DIFF_SIZE=$(wc -c < "$DIFF_FILE" | tr -d ' ')

if [ "$DIFF_SIZE" = "0" ]; then
  log "skip: empty diff for target paths"
  exit 0
fi

# --- Compute diff hash ------------------------------------------
set_phase "diff-hash"
DIFF_SHA=$(sha256_file "$DIFF_FILE") || exit 1

# --- Idempotency check ------------------------------------------
set_phase "idempotency"
if last_reviewed_matches "$BRANCH" "$MERGE_BASE" "$DIFF_SHA"; then
  log "skip: same as last-reviewed (sha=$(printf '%s' "$DIFF_SHA" | cut -c1-12))"
  exit 0
fi

# --- Diff size warning ------------------------------------------
if [ "$DIFF_SIZE" -gt "$LOCAL_AI_REVIEW_DIFF_WARN_BYTES" ]; then
  warn "diff size ${DIFF_SIZE}B exceeds warn threshold ${LOCAL_AI_REVIEW_DIFF_WARN_BYTES}B"
fi

# --- Build prompt payload ---------------------------------------
case "$REVIEWER" in
  claude) PROMPT_FILE="$GITHOOKS_DIR/prompts/local-review-claude.md" ;;
  codex)  PROMPT_FILE="$GITHOOKS_DIR/prompts/local-review-codex.md" ;;
  *) fail "unknown reviewer: $REVIEWER"; exit 1 ;;
esac

if [ ! -f "$PROMPT_FILE" ]; then
  fail "prompt file not found: $PROMPT_FILE"
  exit 1
fi

set_phase "payload"
CHANGED_FILES=$(git diff --name-only "$MERGE_BASE" "$COMMIT_SHA" -- "${LOCAL_AI_REVIEW_TARGET_PATHS[@]}")

PAYLOAD_FILE="$STATE_DIR/.payload.$$"
cleanup_files+=("$PAYLOAD_FILE")
{
  cat "$PROMPT_FILE"
  printf '\n\n---\n\n## Context\n\n'
  printf -- "- branch: \`%s\`\n" "$BRANCH"
  printf -- "- commit: \`%s\`\n" "$COMMIT_SHA"
  printf -- "- base: \`%s\` @ \`%s\`\n" "$LOCAL_AI_REVIEW_BASE_REF" "$MERGE_BASE"
  printf -- '- diff bytes: %s\n' "$DIFF_SIZE"
  printf -- "- diff sha256: \`%s\`\n\n" "$DIFF_SHA"
  printf "## Changed files\n\n\`\`\`\n%s\n\`\`\`\n\n" "$CHANGED_FILES"
  printf '## Diff\n\n```diff\n'
  cat "$DIFF_FILE"
  printf '\n```\n'
} > "$PAYLOAD_FILE"

# --- Run reviewer with watchdog timeout (bash 3.2-safe) ---------
set_phase "reviewer-start"
TS=$(date +%Y%m%d-%H%M%S)
OUTPUT="$STATE_DIR/${TS}-${REVIEWER}.md"
REVIEWER_OUT="$STATE_DIR/.review-out.$$"
REVIEWER_ERR="$STATE_DIR/.review-err.$$"
cleanup_files+=("$REVIEWER_OUT" "$REVIEWER_ERR")

# Recursion guard for any sub-hooks spawned by the reviewer itself.
export LOCAL_AI_REVIEW_RUNNING=1

run_reviewer() {
  case "$REVIEWER" in
    claude) local_ai_review_run_claude < "$PAYLOAD_FILE" ;;
    codex)  local_ai_review_run_codex < "$PAYLOAD_FILE" ;;
  esac
}

(run_reviewer > "$REVIEWER_OUT" 2> "$REVIEWER_ERR") &
REVIEWER_PID=$!
log "reviewer spawned pid=$REVIEWER_PID timeout=${LOCAL_AI_REVIEW_REVIEWER_TIMEOUT_SEC}s"

(
  sleep "$LOCAL_AI_REVIEW_REVIEWER_TIMEOUT_SEC"
  if kill -0 "$REVIEWER_PID" 2>/dev/null; then
    warn "reviewer timeout pid=$REVIEWER_PID; sending TERM"
    kill -TERM "$REVIEWER_PID" 2>/dev/null
    sleep 5
    warn "reviewer timeout pid=$REVIEWER_PID; sending KILL if still alive"
    kill -KILL "$REVIEWER_PID" 2>/dev/null
  fi
) &
WATCHDOG_PID=$!
log "watchdog spawned pid=$WATCHDOG_PID"

set +e
wait "$REVIEWER_PID"
REVIEWER_STATUS=$?
set -e
log "reviewer exited pid=$REVIEWER_PID status=$REVIEWER_STATUS"

kill "$WATCHDOG_PID" 2>/dev/null || true
wait "$WATCHDOG_PID" 2>/dev/null || true

# --- Save output ------------------------------------------------
set_phase "save-output"
{
  printf '# Local AI review (%s)\n\n' "$REVIEWER"
  printf -- '- timestamp: %s\n' "$(date -u +%FT%TZ)"
  printf -- "- branch: \`%s\`\n" "$BRANCH"
  printf -- "- commit: \`%s\`\n" "$COMMIT_SHA"
  printf -- "- merge_base: \`%s\`\n" "$MERGE_BASE"
  printf -- "- diff_sha256: \`%s\`\n" "$DIFF_SHA"
  printf -- '- reviewer_exit: %s\n\n' "$REVIEWER_STATUS"
  printf '## Review\n\n'
  if [ -s "$REVIEWER_OUT" ]; then
    cat "$REVIEWER_OUT"
  else
    printf '_(no output)_\n'
  fi
  if [ -s "$REVIEWER_ERR" ]; then
    printf '\n\n## stderr\n\n```\n'
    cat "$REVIEWER_ERR"
    printf '\n```\n'
  fi
} > "$OUTPUT"

if [ "$REVIEWER_STATUS" -ne 0 ]; then
  fail "reviewer exit=$REVIEWER_STATUS, output saved to $OUTPUT"
  exit 0
fi

set_phase "save-last-reviewed"
last_reviewed_save "$BRANCH" "$MERGE_BASE" "$DIFF_SHA" "$REVIEWER"
set_phase "done"
log "done reviewer=$REVIEWER output=$OUTPUT"
