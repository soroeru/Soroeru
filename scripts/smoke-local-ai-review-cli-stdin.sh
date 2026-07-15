#!/usr/bin/env bash
# Verify reviewer CLI wrappers do not pass the already-consumed review payload
# to the CLI again through inherited stdin.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/soroeru-review-stdin.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin"
cat > "$TMP_DIR/bin/codex" <<'EOF'
#!/usr/bin/env bash
if [ ! -c /dev/stdin ]; then
  printf 'reviewer stdin was not redirected to a character device\n' >&2
  exit 1
fi
printf 'verdict: PASS (stdin closed)\n'
EOF
chmod +x "$TMP_DIR/bin/codex"
printf 'synthetic review payload\n' > "$TMP_DIR/payload"

# shellcheck source=/dev/null
. "$REPO_ROOT/.githooks/config"

OUTPUT=$(PATH="$TMP_DIR/bin:$PATH" local_ai_review_run_codex < "$TMP_DIR/payload")
[ "$OUTPUT" = "verdict: PASS (stdin closed)" ] || {
  printf 'unexpected reviewer output: %s\n' "$OUTPUT" >&2
  exit 1
}

printf 'local AI review CLI stdin smoke check passed\n'
