#!/usr/bin/env bash
# Verify local AI review doc-unit dispatch without launching real
# reviewer CLIs.
#
# Runs the orchestrator (.githooks/lib/local-ai-review.sh) inside a
# throwaway git repository with a stubbed reviewer function and
# asserts which review units run for which changed files:
#   - docs/requirements.md  -> requirements unit (requirements-review skill)
#   - docs/architecture.md  -> architecture unit (architecture-review skill)
#   - docs/design/*.md      -> design unit (design-doc-review skill)
#   - src/ etc.             -> code unit (generic reviewer prompt)
#   - other docs            -> no review
#   - several units in one commit -> one reviewer run per unit

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

if ! command -v jq >/dev/null 2>&1; then
  printf 'jq is required for this smoke check\n' >&2
  exit 1
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/soroeru-doc-units.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT

WORK="$TMP_DIR/repo"
mkdir -p "$WORK"
git -C "$WORK" init -q -b main
git -C "$WORK" config user.email "smoke@example.invalid"
git -C "$WORK" config user.name "smoke"
git -C "$WORK" config commit.gpgsign false

cp -R "$REPO_ROOT/.githooks" "$WORK/.githooks"
mkdir -p "$WORK/skills"
cp -R "$REPO_ROOT/skills/requirements-review" "$WORK/skills/"
cp -R "$REPO_ROOT/skills/architecture-review" "$WORK/skills/"
cp -R "$REPO_ROOT/skills/design-doc-review" "$WORK/skills/"

# Stub the reviewer: echo a verdict plus the head of the prompt it
# received, so assertions can tell which prompt file was used. Also
# review against the local main instead of origin/main.
cat >> "$WORK/.githooks/config" <<'EOF'

# --- smoke-test overrides (appended by smoke-local-ai-review-doc-units.sh)
LOCAL_AI_REVIEW_BASE_REF="main"
local_ai_review_run_claude() {
  printf 'verdict: PASS (stub)\n\n## Prompt head\n\n'
  sed -n '1,6p'
}
local_ai_review_run_codex() {
  local_ai_review_run_claude
}
EOF

cd "$WORK"
mkdir -p docs/design src
printf 'requirements base\n' > docs/requirements.md
printf 'architecture base\n' > docs/architecture.md
printf 'security base\n' > docs/security.md
printf 'readme base\n' > README.md
printf 'code base\n' > src/code.ts
git add -A
git commit -qm "base"
git checkout -q -b claude/smoke-doc-units

BRANCH="claude/smoke-doc-units"
STATE_GLOB="state/ai-reviews"

run_review() {
  LOCAL_AI_REVIEW_RUNNING=1 bash .githooks/lib/local-ai-review.sh claude "$BRANCH" HEAD
}

fail_msg() {
  printf 'FAIL: %s\n' "$*" >&2
  printf -- '--- last-run.log ---\n' >&2
  cat "$STATE_GLOB/last-run.log" >&2 2>/dev/null || true
  printf -- '--- last-error.log ---\n' >&2
  cat "$STATE_GLOB/last-error.log" >&2 2>/dev/null || true
  exit 1
}

count_outputs() {
  find "$STATE_GLOB" -maxdepth 1 -name '*-claude-*.md' 2>/dev/null | wc -l | tr -d ' '
}

output_for_unit() {
  # Newest review output for a unit; empty when none exists.
  # shellcheck disable=SC2012
  ls -t "$STATE_GLOB"/*-claude-"$1".md 2>/dev/null | head -n 1
}

assert_output_count() {
  local expected=$1 actual
  actual=$(count_outputs)
  [ "$actual" = "$expected" ] || fail_msg "expected $expected review outputs, got $actual"
}

assert_unit_prompt() {
  local unit=$1 needle=$2 file
  file=$(output_for_unit "$unit")
  [ -n "$file" ] || fail_msg "no review output for unit=$unit"
  grep -qF "$needle" "$file" || fail_msg "output for unit=$unit missing prompt marker: $needle"
}

# --- 1. untargeted docs only: no review --------------------------
printf 'readme change\n' >> README.md
git commit -qam "docs: readme only"
run_review
assert_output_count 0
grep -q "skip: empty diff for target paths" "$STATE_GLOB/last-run.log" \
  || fail_msg "expected empty-diff skip for untargeted docs"

# --- 2. docs/requirements.md -> requirements unit ----------------
printf 'requirements change\n' >> docs/requirements.md
git commit -qam "docs: requirements"
run_review
assert_output_count 1
assert_unit_prompt requirements "name: requirements-review"

# --- 3. excluded doc: no new review, unchanged units skipped -----
printf 'security change\n' >> docs/security.md
git commit -qam "docs: security (excluded)"
run_review
assert_output_count 1
grep -q "skip unit=requirements: same as last-reviewed" "$STATE_GLOB/last-run.log" \
  || fail_msg "expected requirements unit idempotency skip"

# --- 4. docs/architecture.md -> architecture unit ----------------
printf 'architecture change\n' >> docs/architecture.md
git commit -qam "docs: architecture"
run_review
assert_output_count 2
assert_unit_prompt architecture "name: architecture-review"

# --- 5. docs/design/*.md -> design unit --------------------------
printf 'design doc\n' > docs/design/smoke.md
git add docs/design/smoke.md
git commit -qm "docs: design doc"
run_review
assert_output_count 3
assert_unit_prompt design "name: design-doc-review"

# --- 6. code -> code unit with the generic prompt ----------------
printf 'code change\n' >> src/code.ts
git commit -qam "feat: code"
run_review
assert_output_count 4
assert_unit_prompt code "Local Code Review"

# --- 7. code + requirements in one commit -> two reviewer runs ---
printf 'requirements change 2\n' >> docs/requirements.md
printf 'code change 2\n' >> src/code.ts
git commit -qam "feat: code + requirements"
run_review
assert_output_count 6
grep -q "skip unit=architecture: same as last-reviewed" "$STATE_GLOB/last-run.log" \
  || fail_msg "expected architecture unit idempotency skip in mixed commit"

# --- 8. per-unit shas recorded in last-reviewed.json --------------
UNITS_RECORDED=$(jq -r '.units | keys | sort | join(",")' "$STATE_GLOB/last-reviewed.json")
[ "$UNITS_RECORDED" = "architecture,code,design,requirements" ] \
  || fail_msg "expected per-unit shas in last-reviewed.json, got: $UNITS_RECORDED"

printf 'local AI review doc-unit dispatch smoke check passed\n'
