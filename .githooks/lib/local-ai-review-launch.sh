#!/usr/bin/env bash
# Launch wrapper for local AI review.
#
# This process is the target of launchctl/nohup from post-commit. It
# owns stdio redirection and then execs the real orchestrator, so all
# launch diagnostics land in the repository-local review logs.

set -uo pipefail
umask 077

REPO_ROOT=${1:?repo root required}
GITHOOKS_DIR=${2:?githooks dir required}
STATE_DIR=${3:?state dir required}
REVIEWER=${4:?reviewer required}
BRANCH=${5:?branch required}
COMMIT_SHA=${6:?commit sha required}
LAUNCH_SERVICE=${7:-}
LAUNCH_PLIST=${8:-}

mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR" 2>/dev/null || true

LOG="$STATE_DIR/last-run.log"
ERR="$STATE_DIR/last-error.log"

exec </dev/null >> "$LOG" 2>> "$ERR"

printf '[%s] launch worker pid=%s ppid=%s method=%s reviewer=%s branch=%s commit=%s\n' \
  "$(date -u +%FT%TZ)" "$$" "$PPID" "${LOCAL_AI_REVIEW_LAUNCH_METHOD:-launchctl}" \
  "$REVIEWER" "$BRANCH" "$COMMIT_SHA"

if ! cd "$REPO_ROOT"; then
  printf '[%s] ERROR: launch worker could not cd to repo root: %s\n' \
    "$(date -u +%FT%TZ)" "$REPO_ROOT" >> "$ERR"
  exit 1
fi

export LOCAL_AI_REVIEW_RUNNING=1
"$GITHOOKS_DIR/lib/local-ai-review.sh" "$REVIEWER" "$BRANCH" "$COMMIT_SHA"
STATUS=$?

if [ -n "$LAUNCH_SERVICE" ]; then
  # shellcheck disable=SC2016
  nohup /bin/sh -c '
    sleep 1
    /bin/launchctl bootout "$1" >/dev/null 2>&1 || true
    [ -n "$2" ] && rm -f "$2"
  ' sh "$LAUNCH_SERVICE" "$LAUNCH_PLIST" >/dev/null 2>&1 </dev/null &
fi

exit "$STATUS"
