#!/usr/bin/env bash
# Verify Issue epoch artifacts and budget accounting with a stub reviewer.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/soroeru-review-epoch.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT
WORK="$TMP_DIR/repo"

git init -q -b main "$WORK"
git -C "$WORK" config user.email smoke@example.invalid
git -C "$WORK" config user.name smoke
cp -R "$REPO_ROOT/.githooks" "$WORK/.githooks"
mkdir -p "$WORK/src"
printf 'base\n' > "$WORK/src/code.ts"
git -C "$WORK" add -A
git -C "$WORK" commit -qm base
git -C "$WORK" checkout -q -b issue-365-review-epoch
printf 'change\n' >> "$WORK/src/code.ts"
git -C "$WORK" commit -qam change

cat >> "$WORK/.githooks/config" <<'EOF'
LOCAL_AI_REVIEW_BASE_REF="main"
local_ai_review_run_codex() { printf 'verdict: PASS (stub)\n'; }
EOF

COMMON=$(git -C "$WORK" rev-parse --path-format=absolute --git-common-dir)
mkdir -p "$COMMON/soroeru-issue-worktrees"
cat > "$COMMON/soroeru-issue-worktrees/365.json" <<EOF
{"schema":1,"issue":365,"branch":"issue-365-review-epoch","worktree":"$WORK","owner":{"agent":"codex","session_hash":"abc","active":true,"generation":1,"updated_at":"2026-07-13T00:00:00Z"},"handoff_epoch":4,"review":{"epoch":4,"used":0,"limit":1,"reviewer":"codex"}}
EOF

cd "$WORK"
# post-commit reserves the run atomically before launching the worker.
# shellcheck source=/dev/null
. .githooks/config
. .githooks/lib/reviewer-selection.sh

# Review budget operations reclaim a state lock abandoned by a dead process.
mkdir "$COMMON/soroeru-issue-worktrees/365.lock"
printf '%s:0:1\n' "$$" > "$COMMON/soroeru-issue-worktrees/365.lock/owner"
[ "$(local_ai_review_reserve_budget 365 4 "$WORK")" = "1" ]
[ ! -e "$COMMON/soroeru-issue-worktrees/365.lock" ]
[ "$(jq -r '.review.pending // 0' "$COMMON/soroeru-issue-worktrees/365.json")" = "1" ]
STARTED_MARKER="$WORK/review-started"
LOCAL_AI_REVIEW_RUNNING=1 bash .githooks/lib/local-ai-review.sh codex issue-365-review-epoch HEAD 365 4 "$STARTED_MARKER"
[ -f "$STARTED_MARKER" ]
[ "$(jq -r '.review.pending // 0' "$COMMON/soroeru-issue-worktrees/365.json")" = "0" ]
[ "$(jq -r .review.used "$COMMON/soroeru-issue-worktrees/365.json")" = "1" ]
ARTIFACT=$(find state/ai-reviews -name '*-codex-code-*.md' -print -quit)
grep -Fq "handoff_epoch: \`4\`" "$ARTIFACT"
grep -Fq "issue: \`365\`" "$ARTIFACT"

# Same diff/epoch is idempotently skipped and must not consume a second run.
LOCAL_AI_REVIEW_RUNNING=1 bash .githooks/lib/local-ai-review.sh codex issue-365-review-epoch HEAD 365 4
USED=$(jq -r .review.used "$COMMON/soroeru-issue-worktrees/365.json")
[ "$USED" = "1" ] || {
  printf 'expected idempotent rerun to keep review usage at 1, got %s\n' "$USED" >&2
  exit 1
}

# The epoch's single run (0/1, Issue #581) is used: a second reservation is atomically refused.
if local_ai_review_reserve_budget 365 4 "$WORK" >/dev/null 2>&1; then
  printf 'expected exhausted 0/1 epoch budget to reject a second reservation\n' >&2
  exit 1
fi
# A refunded reservation frees the single slot again, which is then exhausted once more.
jq '.review.used=0 | .review.pending=0' \
  "$COMMON/soroeru-issue-worktrees/365.json" > "$COMMON/soroeru-issue-worktrees/365.json.tmp"
mv "$COMMON/soroeru-issue-worktrees/365.json.tmp" "$COMMON/soroeru-issue-worktrees/365.json"
[ "$(local_ai_review_reserve_budget 365 4 "$WORK")" = "1" ]
local_ai_review_refund_budget 365 4 "$WORK"
[ "$(jq -r .review.used "$COMMON/soroeru-issue-worktrees/365.json")" = "0" ]
[ "$(jq -r '.review.pending // 0' "$COMMON/soroeru-issue-worktrees/365.json")" = "0" ]
[ "$(local_ai_review_reserve_budget 365 4 "$WORK")" = "1" ]
if local_ai_review_reserve_budget 365 4 "$WORK" >/dev/null 2>&1; then
  printf 'expected exhausted 0/1 epoch budget to reject a second reservation after refund\n' >&2
  exit 1
fi

# A worker that launches but cannot acquire the review lock refunds both the
# pending counter and the consumed budget slot.
jq '.review.used=1 | .review.pending=1' \
  "$COMMON/soroeru-issue-worktrees/365.json" > "$COMMON/soroeru-issue-worktrees/365.json.tmp"
mv "$COMMON/soroeru-issue-worktrees/365.json.tmp" "$COMMON/soroeru-issue-worktrees/365.json"
printf '%s:%s\n' "$$" "$(date +%s)" > "$WORK/state/ai-reviews/.lock"
bash .githooks/lib/local-ai-review-launch.sh \
  "$WORK" "$WORK/.githooks" "$WORK/state/ai-reviews" codex issue-365-review-epoch HEAD \
  "" "" 365 4 "$WORK/launch-started" "$WORK/review-started-failure"
[ -f "$WORK/launch-started" ]
[ ! -f "$WORK/review-started-failure" ]
[ "$(jq -r .review.used "$COMMON/soroeru-issue-worktrees/365.json")" = "0" ]
[ "$(jq -r '.review.pending // 0' "$COMMON/soroeru-issue-worktrees/365.json")" = "0" ]
rm -f "$WORK/state/ai-reviews/.lock" "$WORK/launch-started"

# A start marker that cannot be created must abort before reviewer execution
# and refund the pending reservation.
rm -f "$WORK/state/ai-reviews/last-reviewed.json"
jq '.review.used=1 | .review.pending=1' \
  "$COMMON/soroeru-issue-worktrees/365.json" > "$COMMON/soroeru-issue-worktrees/365.json.tmp"
mv "$COMMON/soroeru-issue-worktrees/365.json.tmp" "$COMMON/soroeru-issue-worktrees/365.json"
BEFORE_ARTIFACTS=$(find "$WORK/state/ai-reviews" -name '*-codex-code-*.md' | wc -l | tr -d ' ')
if bash .githooks/lib/local-ai-review-launch.sh \
  "$WORK" "$WORK/.githooks" "$WORK/state/ai-reviews" codex issue-365-review-epoch HEAD \
  "" "" 365 4 "$WORK/launch-started-marker-failure" "$WORK/missing/review-started"; then
  printf 'expected an unwritable review-started marker to fail the launcher\n' >&2
  exit 1
fi
AFTER_ARTIFACTS=$(find "$WORK/state/ai-reviews" -name '*-codex-code-*.md' | wc -l | tr -d ' ')
[ "$AFTER_ARTIFACTS" = "$BEFORE_ARTIFACTS" ]
[ "$(jq -r .review.used "$COMMON/soroeru-issue-worktrees/365.json")" = "0" ]
[ "$(jq -r '.review.pending // 0' "$COMMON/soroeru-issue-worktrees/365.json")" = "0" ]

# A launcher that misses the handshake deadline is terminated before its
# reservation is refunded. Two seconds is intentional: the fake launcher
# would create the marker after one second if it survived cancellation.
jq '.review.used=0 | .review.pending=0' \
  "$COMMON/soroeru-issue-worktrees/365.json" > "$COMMON/soroeru-issue-worktrees/365.json.tmp"
mv "$COMMON/soroeru-issue-worktrees/365.json.tmp" "$COMMON/soroeru-issue-worktrees/365.json"
mkdir "$WORK/fake-bin"
cat > "$WORK/fake-bin/uname" <<'EOF'
#!/usr/bin/env bash
printf 'Linux\n'
EOF
chmod +x "$WORK/fake-bin/uname"
cat > "$WORK/.githooks/lib/local-ai-review-launch.sh" <<'EOF'
#!/usr/bin/env bash
sleep 1
: > "${11}"
: > "$1/late-launch-survived"
EOF
chmod +x "$WORK/.githooks/lib/local-ai-review-launch.sh"
PATH="$WORK/fake-bin:$PATH" LOCAL_AI_REVIEW_LAUNCH_HANDSHAKE_ATTEMPTS=1 \
  bash "$WORK/.githooks/post-commit"
sleep 2
[ ! -e "$WORK/late-launch-survived" ]
[ "$(jq -r .review.used "$COMMON/soroeru-issue-worktrees/365.json")" = "0" ]
[ "$(jq -r '.review.pending // 0' "$COMMON/soroeru-issue-worktrees/365.json")" = "0" ]

printf 'local AI review Issue epoch smoke check passed\n'
