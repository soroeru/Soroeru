#!/usr/bin/env bash
# Wait for the local AI review hook (.githooks/lib/local-ai-review.sh) to
# finish reviewing a given commit, without repeated agent-side polling turns.
#
# Intended to be run as a single backgrounded shell command (e.g. Claude
# Code's `Bash` tool with `run_in_background: true`) so its one completion
# notification replaces manual re-checking of state/ai-reviews/. See
# docs/local-ai-review.md §10 for the full rationale and matching mechanics.
#
# A review is "done" for a requested unit once a
# state/ai-reviews/<timestamp>-<reviewer>-<unit>-<pid>.md file exists whose
# `- commit: `<sha>`` line matches the target commit (not a stale file from an
# earlier run of the same unit), and it is fully done once every requested
# unit has such a file AND the shared .lock is gone (a single commit can
# trigger several units sequentially under one lock, per
# docs/local-ai-review.md §5).
#
# Usage:
#   scripts/wait-for-local-ai-review.sh --unit <name>[,<name>...]
#                                        [--commit <sha>] [--timeout <seconds>] [--poll <seconds>]
#
# Exit codes: 0 success, 1 timeout, 2 usage error.

set -euo pipefail
shopt -s nullglob

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

# shellcheck source=/dev/null
. "$REPO_ROOT/.githooks/config"

UNITS=""
COMMIT=""
TIMEOUT_SEC=540
POLL_SEC=10

usage() {
  printf 'Usage: %s --unit <name>[,<name>...] [--commit <sha>] [--timeout <seconds>] [--poll <seconds>]\n' "$0" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --unit)
      UNITS=${2:?--unit requires a value}
      shift 2
      ;;
    --commit)
      COMMIT=${2:?--commit requires a value}
      shift 2
      ;;
    --timeout)
      TIMEOUT_SEC=${2:?--timeout requires a value}
      shift 2
      ;;
    --poll)
      POLL_SEC=${2:?--poll requires a value}
      shift 2
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ -z "$UNITS" ]; then
  printf 'missing required --unit\n' >&2
  usage
  exit 2
fi

case "$TIMEOUT_SEC" in
  ''|*[!0-9]*|0)
    printf -- '--timeout must be a positive integer number of seconds, got: %s\n' "$TIMEOUT_SEC" >&2
    exit 2
    ;;
esac
case "$POLL_SEC" in
  ''|*[!0-9]*|0)
    # A 0 poll interval would busy-loop (sleep 0 every iteration, hammering
    # date/glob/grep on every spin) instead of failing fast.
    printf -- '--poll must be a positive integer number of seconds, got: %s\n' "$POLL_SEC" >&2
    exit 2
    ;;
esac

if [ -z "$COMMIT" ]; then
  COMMIT=$(cd "$REPO_ROOT" && git rev-parse HEAD)
fi

# The output template always writes the full 40-char SHA (local-ai-review.sh
# writes `$COMMIT_SHA` from `git rev-parse HEAD`/the post-commit hook's
# argument, never an abbreviation), so an abbreviated --commit could never
# match and would otherwise silently run out the full --timeout instead of
# failing fast.
case "$COMMIT" in
  *[!0-9a-f]*) COMMIT_IS_HEX=0 ;;
  *) COMMIT_IS_HEX=1 ;;
esac
if [ "${#COMMIT}" -ne 40 ] || [ "$COMMIT_IS_HEX" -ne 1 ]; then
  printf -- '--commit must be a full 40-character hex SHA (got: %s); abbreviated SHAs never match the output template and would silently time out\n' "$COMMIT" >&2
  exit 2
fi

STATE_DIR="$REPO_ROOT/$LOCAL_AI_REVIEW_STATE_DIR"
LOCK_FILE="$STATE_DIR/.lock"
SHORT_COMMIT=${COMMIT:0:7}

# Split the comma list into a Bash 3.2-safe indexed array (no associative
# arrays / mapfile dependency).
OLD_IFS=$IFS
IFS=','
# shellcheck disable=SC2206
UNIT_LIST=($UNITS)
IFS=$OLD_IFS

# Finds this commit's confirmed output file for one unit, or returns 1.
# Printed to stdout on success so the caller can collect it.
#
# The glob below matches by substring position, not by parsing the
# documented <timestamp>-<reviewer>-<unit>-<pid> field layout. This is safe
# only because reviewer names (claude/codex) and unit names never contain
# a dash; if either ever gained one, the glob could misroute matches.
find_unit_output() {
  local unit=$1 file
  for file in "$STATE_DIR"/*-"$unit"-*.md; do
    if grep -qF -- "- commit: \`$COMMIT\`" "$file" 2>/dev/null; then
      printf '%s' "$file"
      return 0
    fi
  done
  return 1
}

START=$(date +%s)
DEADLINE=$((START + TIMEOUT_SEC))

while :; do
  ALL_FOUND=1
  MATCHED=""
  for unit in "${UNIT_LIST[@]}"; do
    if FOUND_FILE=$(find_unit_output "$unit"); then
      MATCHED="$MATCHED $FOUND_FILE"
    else
      ALL_FOUND=0
      break
    fi
  done

  if [ "$ALL_FOUND" -eq 1 ] && [ ! -e "$LOCK_FILE" ]; then
    ELAPSED=$(($(date +%s) - START))
    printf 'wait-for-local-ai-review: done commit=%s units=%s elapsed=%ss ->%s\n' \
      "$SHORT_COMMIT" "$UNITS" "$ELAPSED" "$MATCHED"
    exit 0
  fi

  NOW=$(date +%s)
  if [ "$NOW" -ge "$DEADLINE" ]; then
    LOCK_PRESENT=no
    [ -e "$LOCK_FILE" ] && LOCK_PRESENT=yes
    printf 'wait-for-local-ai-review: TIMEOUT after %ss waiting for units=%s commit=%s (lock_present=%s); check %s/last-run.log and last-error.log\n' \
      "$TIMEOUT_SEC" "$UNITS" "$SHORT_COMMIT" "$LOCK_PRESENT" "$LOCAL_AI_REVIEW_STATE_DIR" >&2
    exit 1
  fi

  sleep "$POLL_SEC"
done
