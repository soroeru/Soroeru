#!/usr/bin/env bash
# last-reviewed.sh — read / write / compare the last-reviewed bookkeeping
# Sourced by .githooks/lib/local-ai-review.sh.
#
# Stored at $LOCAL_AI_REVIEW_STATE_DIR/last-reviewed.json with the
# minimal structure (one diff sha per review unit):
#   {
#     "branch": "...",
#     "merge_base": "...",
#     "units": { "<unit>": "<diff sha256>", ... },
#     "last_reviewed_at": "ISO8601",
#     "last_reviewer": "claude" | "codex" | "grok"
#   }
# Legacy files written before per-unit reviews stored a single
# top-level "last_diff_sha256"; it is read as the "code" unit's sha
# so existing branches are not re-reviewed after upgrading.

last_reviewed_path() {
  printf '%s/last-reviewed.json\n' "$LOCAL_AI_REVIEW_STATE_DIR"
}

# last_reviewed_matches <branch> <merge_base> <unit> <diff_sha>
# Exit 0 when the stored record matches all four; exit 1 otherwise.
last_reviewed_matches() {
  local branch=$1 merge_base=$2 unit=$3 diff_sha=$4
  local f
  f=$(last_reviewed_path)
  [ -f "$f" ] || return 1
  local stored got_branch got_base got_sha
  stored=$(jq -r --arg unit "$unit" \
    '"\(.branch // "")\t\(.merge_base // "")\t\((.units[$unit] // (if $unit == "code" then (.last_diff_sha256 // "") else "" end)))"' \
    "$f" 2>/dev/null) || return 1
  [ -n "$stored" ] || return 1
  IFS=$'\t' read -r got_branch got_base got_sha <<< "$stored"
  [ "$got_branch" = "$branch" ] || return 1
  [ "$got_base" = "$merge_base" ] || return 1
  [ "$got_sha" = "$diff_sha" ] || return 1
  return 0
}

# last_reviewed_save <branch> <merge_base> <unit> <diff_sha> <reviewer>
# Merges the unit's sha into the stored units map when branch and
# merge_base still match (otherwise starts a fresh map, so shas from
# another branch or an outdated base are never reused).
# Atomic write via tmpfile + mv (POSIX rename).
last_reviewed_save() {
  local branch=$1 merge_base=$2 unit=$3 diff_sha=$4 reviewer=$5
  local f tmp now units
  f=$(last_reviewed_path)
  units='{}'
  if [ -f "$f" ]; then
    # Carry the existing units forward; seed from the legacy
    # single-sha field so the code unit's skip survives the first
    # per-unit save after upgrading.
    units=$(jq -c --arg branch "$branch" --arg base "$merge_base" \
      'if (.branch // "") == $branch and (.merge_base // "") == $base
       then (.units // (if (.last_diff_sha256 // "") != "" then {code: .last_diff_sha256} else {} end))
       else {} end' \
      "$f" 2>/dev/null) || units='{}'
    [ -n "$units" ] || units='{}'
  fi
  tmp="${f}.tmp.$$"
  now=$(date -u +%FT%TZ)
  mkdir -p "$(dirname "$f")"
  jq -n \
    --arg branch "$branch" \
    --arg merge_base "$merge_base" \
    --arg unit "$unit" \
    --arg sha "$diff_sha" \
    --arg at "$now" \
    --arg reviewer "$reviewer" \
    --argjson units "$units" \
    '{branch:$branch, merge_base:$merge_base, units:($units + {($unit):$sha}), last_reviewed_at:$at, last_reviewer:$reviewer}' \
    > "$tmp"
  mv "$tmp" "$f"
}
