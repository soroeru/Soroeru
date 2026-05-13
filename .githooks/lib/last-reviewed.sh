#!/usr/bin/env bash
# last-reviewed.sh — read / write / compare the last-reviewed bookkeeping
# Sourced by .githooks/lib/local-ai-review.sh.
#
# Stored at $LOCAL_AI_REVIEW_STATE_DIR/last-reviewed.json with the
# minimal structure:
#   {
#     "branch": "...",
#     "merge_base": "...",
#     "last_diff_sha256": "...",
#     "last_reviewed_at": "ISO8601",
#     "last_reviewer": "claude" | "codex"
#   }

last_reviewed_path() {
  printf '%s/last-reviewed.json\n' "$LOCAL_AI_REVIEW_STATE_DIR"
}

# last_reviewed_matches <branch> <merge_base> <diff_sha>
# Exit 0 when the stored record matches all three; exit 1 otherwise.
last_reviewed_matches() {
  local branch=$1 merge_base=$2 diff_sha=$3
  local f
  f=$(last_reviewed_path)
  [ -f "$f" ] || return 1
  local stored got_branch got_base got_sha
  stored=$(jq -r '"\(.branch // "")\t\(.merge_base // "")\t\(.last_diff_sha256 // "")"' "$f" 2>/dev/null) || return 1
  [ -n "$stored" ] || return 1
  IFS=$'\t' read -r got_branch got_base got_sha <<< "$stored"
  [ "$got_branch" = "$branch" ] || return 1
  [ "$got_base" = "$merge_base" ] || return 1
  [ "$got_sha" = "$diff_sha" ] || return 1
  return 0
}

# last_reviewed_save <branch> <merge_base> <diff_sha> <reviewer>
# Atomic write via tmpfile + mv (POSIX rename).
last_reviewed_save() {
  local branch=$1 merge_base=$2 diff_sha=$3 reviewer=$4
  local f tmp now
  f=$(last_reviewed_path)
  tmp="${f}.tmp.$$"
  now=$(date -u +%FT%TZ)
  mkdir -p "$(dirname "$f")"
  jq -n \
    --arg branch "$branch" \
    --arg merge_base "$merge_base" \
    --arg sha "$diff_sha" \
    --arg at "$now" \
    --arg reviewer "$reviewer" \
    '{branch:$branch, merge_base:$merge_base, last_diff_sha256:$sha, last_reviewed_at:$at, last_reviewer:$reviewer}' \
    > "$tmp"
  mv "$tmp" "$f"
}
