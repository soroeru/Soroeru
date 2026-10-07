#!/usr/bin/env bash
# Verify scripts/wait-for-local-ai-review.sh's matching logic (commit-SHA
# guard, lock-wait, timeout) against fixture state/ai-reviews/ artifacts,
# without invoking a real reviewer CLI or the local-ai-review.sh orchestrator.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/soroeru-wait-for-review.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT

WORK="$TMP_DIR/repo"
mkdir -p "$WORK/scripts" "$WORK/state/ai-reviews" "$WORK/.githooks"
cat > "$WORK/.githooks/config" <<'EOF'
LOCAL_AI_REVIEW_STATE_DIR="state/ai-reviews"
LOCAL_AI_REVIEW_REVIEWER_TIMEOUT_SEC=900
EOF
cp "$REPO_ROOT/scripts/wait-for-local-ai-review.sh" "$WORK/scripts/"

git -C "$WORK" init -q -b main
git -C "$WORK" config user.email "smoke@example.invalid"
git -C "$WORK" config user.name "smoke"
git -C "$WORK" config commit.gpgsign false
cd "$WORK"
printf 'base\n' > f.txt
git add f.txt
git commit -qm "base"
COMMIT=$(git rev-parse HEAD)

run_wait() {
  bash scripts/wait-for-local-ai-review.sh --commit "$COMMIT" --poll 1 "$@"
}

fail_msg() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# --- 1. matching, commit-confirmed file already present, no lock --------
# -> returns immediately, exit 0
printf -- "- commit: \`%s\`\n" "$COMMIT" > "state/ai-reviews/20260101-000000-claude-code-111.md"
OUT=$(run_wait --unit code --timeout 5) || fail_msg "expected success for pre-existing matching file"
printf '%s\n' "$OUT" | grep -q "^wait-for-local-ai-review: done " \
  || fail_msg "expected a 'done' line, got: $OUT"
printf '%s\n' "$OUT" | grep -qF "20260101-000000-claude-code-111.md" \
  || fail_msg "expected the matched file path in output, got: $OUT"
rm -f state/ai-reviews/*.md

# --- 1b. --print emits each finished result; the default does not --------
printf -- "- commit: \`%s\`\nVerdict: PASS (code)\n" "$COMMIT" > "state/ai-reviews/20260101-000000-claude-code-112.md"
printf -- "- commit: \`%s\`\nVerdict: NIT_ONLY (design)\n" "$COMMIT" > "state/ai-reviews/20260101-000000-claude-design-113.md"
OUT=$(run_wait --unit code,design --timeout 5) || fail_msg "expected success without --print"
printf '%s\n' "$OUT" | grep -q "Verdict:" \
  && fail_msg "expected no result body without --print, got: $OUT"
OUT=$(run_wait --unit code,design --timeout 5 --print) || fail_msg "expected success with --print"
printf '%s\n' "$OUT" | head -1 | grep -q "^wait-for-local-ai-review: done " \
  || fail_msg "expected the 'done' line first with --print, got: $OUT"
# Each body must sit under its own header, in --unit order.
EXPECTED_BODY=$(cat <<EOF

===== 20260101-000000-claude-code-112.md =====
- commit: \`$COMMIT\`
Verdict: PASS (code)

===== 20260101-000000-claude-design-113.md =====
- commit: \`$COMMIT\`
Verdict: NIT_ONLY (design)
EOF
)
[ "$(printf '%s\n' "$OUT" | tail -n +2)" = "$EXPECTED_BODY" ] \
  || fail_msg "expected headers and bodies in order with --print, got: $OUT"
rm -f state/ai-reviews/*.md

# --- 1c. several results for one unit and commit: --print shows the newest -
printf -- "- commit: \`%s\`\nVerdict: PASS (old)\n" "$COMMIT" > "state/ai-reviews/20260101-000000-claude-code-115.md"
printf -- "- commit: \`%s\`\nVerdict: NEEDS_CHANGES (new)\n" "$COMMIT" > "state/ai-reviews/20260102-000000-codex-code-116.md"
OUT=$(run_wait --unit code --timeout 5 --print) || fail_msg "expected success with several results"
printf '%s\n' "$OUT" | grep -qF "Verdict: NEEDS_CHANGES (new)" \
  || fail_msg "expected the newest result with --print, got: $OUT"
printf '%s\n' "$OUT" | grep -qF "PASS (old)" \
  && fail_msg "expected the older result to be skipped, got: $OUT"
printf '%s\n' "$OUT" | head -1 | grep -qF "20260102-000000-codex-code-116.md" \
  || fail_msg "expected the newest path on the 'done' line, got: $OUT"
printf '%s\n' "$OUT" | head -1 | grep -qF "20260101-000000-claude-code-115.md" \
  && fail_msg "expected the older path off the 'done' line, got: $OUT"
rm -f state/ai-reviews/*.md
# A repeated local-time hour (DST) can give the newer result an earlier name.
printf -- "- commit: \`%s\`\nVerdict: PASS (old)\n" "$COMMIT" > "state/ai-reviews/20260103-010000-claude-code-117.md"
touch -t 202601030100 "state/ai-reviews/20260103-010000-claude-code-117.md"
printf -- "- commit: \`%s\`\nVerdict: NEEDS_CHANGES (new)\n" "$COMMIT" > "state/ai-reviews/20260103-003000-claude-code-118.md"
OUT=$(run_wait --unit code --timeout 5 --print) || fail_msg "expected success with a repeated hour"
printf '%s\n' "$OUT" | grep -qF "Verdict: NEEDS_CHANGES (new)" \
  || fail_msg "expected the most recently written result, got: $OUT"
rm -f state/ai-reviews/*.md

# --- 1d. --print never prints while the review lock is held ---------------
touch "state/ai-reviews/.lock"
printf -- "- commit: \`%s\`\nVerdict: PASS\n" "$COMMIT" > "state/ai-reviews/20260101-000000-claude-code-114.md"
if run_wait --unit code --timeout 2 --print >"$TMP_DIR/locked.out" 2>&1; then
  fail_msg "expected timeout while the lock is held"
fi
grep -q "Verdict:" "$TMP_DIR/locked.out" \
  && fail_msg "expected no result body while the lock is held, got: $(cat "$TMP_DIR/locked.out")"
rm -f "$TMP_DIR/locked.out" state/ai-reviews/.lock state/ai-reviews/*.md

# --- 2. lock present, cleared by a background job along with the file ---
# -> succeeds only once both clear
touch "state/ai-reviews/.lock"
(
  sleep 2
  rm -f "state/ai-reviews/.lock"
  printf -- "- commit: \`%s\`\n" "$COMMIT" > "state/ai-reviews/20260101-000001-claude-code-222.md"
) &
BG_PID=$!
START=$(date +%s)
OUT=$(run_wait --unit code --timeout 15) || fail_msg "expected success once lock clears and file appears"
wait "$BG_PID"
ELAPSED=$(( $(date +%s) - START ))
[ "$ELAPSED" -ge 2 ] || fail_msg "returned before the lock/file were actually ready (elapsed=${ELAPSED}s)"
printf '%s\n' "$OUT" | grep -q "^wait-for-local-ai-review: done " \
  || fail_msg "expected a 'done' line after lock clears, got: $OUT"
rm -f state/ai-reviews/*.md

# --- 3. a file for the WRONG commit SHA is present -----------------------
# -> not treated as success; times out (verifies the content-match guard,
# not just the filename glob)
printf -- "- commit: \`0000000000000000000000000000000000000000\`\n" \
  > "state/ai-reviews/20260101-000002-claude-code-333.md"
if run_wait --unit code --timeout 2 >"$TMP_DIR/wrong-commit.out" 2>&1; then
  fail_msg "expected timeout for a wrong-commit file, but it succeeded"
fi
grep -q "^wait-for-local-ai-review: TIMEOUT " "$TMP_DIR/wrong-commit.out" \
  || fail_msg "expected a TIMEOUT line for the wrong-commit case, got: $(cat "$TMP_DIR/wrong-commit.out")"
rm -f "$TMP_DIR/wrong-commit.out" state/ai-reviews/*.md

# --- 4. nothing ever appears ----------------------------------------------
# -> timeout path, exit 1, correct message
if run_wait --unit code --timeout 2 >"$TMP_DIR/nothing.out" 2>&1; then
  fail_msg "expected timeout when nothing is ever written"
fi
grep -q "^wait-for-local-ai-review: TIMEOUT after 2s waiting for units=code" "$TMP_DIR/nothing.out" \
  || fail_msg "expected a specific TIMEOUT message, got: $(cat "$TMP_DIR/nothing.out")"
rm -f "$TMP_DIR/nothing.out"

# --- 5. usage error: missing --unit ---------------------------------------
set +e
bash scripts/wait-for-local-ai-review.sh --commit "$COMMIT" >"$TMP_DIR/usage.out" 2>&1
STATUS=$?
set -e
[ "$STATUS" -eq 2 ] || fail_msg "expected exit code 2 for missing --unit, got $STATUS"
rm -f "$TMP_DIR/usage.out"

# --- 6. --commit omitted defaults to `git rev-parse HEAD` ----------------
printf -- "- commit: \`%s\`\n" "$COMMIT" > "state/ai-reviews/20260101-000003-claude-code-444.md"
OUT=$(bash scripts/wait-for-local-ai-review.sh --unit code --timeout 5 --poll 1) \
  || fail_msg "expected success defaulting --commit to HEAD"
printf '%s\n' "$OUT" | grep -q "^wait-for-local-ai-review: done " \
  || fail_msg "expected a 'done' line with --commit defaulted to HEAD, got: $OUT"
rm -f state/ai-reviews/*.md

# --- 7. usage errors: non-numeric --timeout / --commit not a full SHA ----
set +e
bash scripts/wait-for-local-ai-review.sh --unit code --timeout notanumber >"$TMP_DIR/timeout.out" 2>&1
STATUS=$?
set -e
[ "$STATUS" -eq 2 ] || fail_msg "expected exit code 2 for non-numeric --timeout, got $STATUS"
rm -f "$TMP_DIR/timeout.out"

set +e
bash scripts/wait-for-local-ai-review.sh --unit code --poll notanumber >"$TMP_DIR/poll.out" 2>&1
STATUS=$?
set -e
[ "$STATUS" -eq 2 ] || fail_msg "expected exit code 2 for non-numeric --poll, got $STATUS"
rm -f "$TMP_DIR/poll.out"

set +e
bash scripts/wait-for-local-ai-review.sh --unit code --commit "${COMMIT:0:7}" >"$TMP_DIR/short-sha.out" 2>&1
STATUS=$?
set -e
[ "$STATUS" -eq 2 ] || fail_msg "expected exit code 2 for an abbreviated --commit, got $STATUS"
rm -f "$TMP_DIR/short-sha.out"

# --- 8. usage errors: --timeout 0 / --poll 0 (would busy-loop) -----------
set +e
bash scripts/wait-for-local-ai-review.sh --unit code --timeout 0 >"$TMP_DIR/timeout0.out" 2>&1
STATUS=$?
set -e
[ "$STATUS" -eq 2 ] || fail_msg "expected exit code 2 for --timeout 0, got $STATUS"
rm -f "$TMP_DIR/timeout0.out"

set +e
bash scripts/wait-for-local-ai-review.sh --unit code --poll 0 >"$TMP_DIR/poll0.out" 2>&1
STATUS=$?
set -e
[ "$STATUS" -eq 2 ] || fail_msg "expected exit code 2 for --poll 0, got $STATUS"
rm -f "$TMP_DIR/poll0.out"

printf 'wait-for-local-ai-review smoke check passed\n'
