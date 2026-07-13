#!/usr/bin/env bash
# Sourced by .githooks/post-commit and smoke checks.

local_ai_review_state_lock_mtime() {
  local path=$1
  if stat -f %m "$path" 2>/dev/null; then return 0; fi
  stat -c %Y "$path" 2>/dev/null
}

local_ai_review_state_lock_inode() {
  local path=$1
  if stat -f %i "$path" 2>/dev/null; then return 0; fi
  stat -c %i "$path" 2>/dev/null
}

local_ai_review_reclaim_state_lock() {
  local lock=$1 owner="$1/owner" pid timestamp now age mtime
  pid=''
  timestamp=''
  IFS=':' read -r pid timestamp _ < "$owner" 2>/dev/null || true
  case "$pid:$timestamp" in
    *[!0-9:]*|::*|*:)
      mtime=$(local_ai_review_state_lock_mtime "$lock") || return 1
      now=$(date +%s)
      age=$((now - mtime))
      [ "$age" -ge "${LOCAL_AI_REVIEW_STATE_LOCK_TIMEOUT_SEC:-600}" ] || return 1
      ;;
    *)
      now=$(date +%s)
      age=$((now - timestamp))
      if kill -0 "$pid" 2>/dev/null \
         && [ "$age" -lt "${LOCAL_AI_REVIEW_STATE_LOCK_TIMEOUT_SEC:-30}" ]; then
        return 1
      fi
      ;;
  esac
  rm -f "$owner"
  rmdir "$lock" 2>/dev/null
}

local_ai_review_acquire_state_lock() {
  local lock=$1 pid now generation
  if ! mkdir "$lock" 2>/dev/null; then
    local_ai_review_reclaim_state_lock "$lock" || return 1
    mkdir "$lock" 2>/dev/null || return 1
  fi
  pid=$$
  now=$(date +%s)
  generation=$(local_ai_review_state_lock_inode "$lock") || {
    rmdir "$lock" 2>/dev/null || true
    return 1
  }
  LOCAL_AI_REVIEW_STATE_LOCK_TOKEN="$pid:$now:$generation"
  printf '%s\n' "$LOCAL_AI_REVIEW_STATE_LOCK_TOKEN" > "$lock/owner"
}

local_ai_review_release_state_lock() {
  local lock=$1 stored
  stored=$(cat "$lock/owner" 2>/dev/null || true)
  if [ "${LOCAL_AI_REVIEW_STATE_LOCK_TOKEN:-}" = "$stored" ]; then
    rm -f "$lock/owner"
    rmdir "$lock" 2>/dev/null || true
  fi
  LOCAL_AI_REVIEW_STATE_LOCK_TOKEN=''
}

local_ai_review_select_reviewer() {
  local branch=$1
  case "$branch" in
    ${LOCAL_AI_REVIEW_AUTHOR_PREFIX_CLAUDE}*) printf '%s\n' "claude" ;;
    ${LOCAL_AI_REVIEW_AUTHOR_PREFIX_CODEX}*)  printf '%s\n' "codex" ;;
    ${LOCAL_AI_REVIEW_AUTHOR_PREFIX_GROK}*)   printf '%s\n' "grok" ;;
    ${LOCAL_AI_REVIEW_AUTHOR_PREFIX_GEMINI}*) printf '%s\n' "gemini" ;;
    *) return 1 ;;
  esac
}

# Print: reviewer<TAB>issue<TAB>epoch<TAB>used<TAB>limit
# Issue branches MUST have valid lifecycle metadata. Agent-prefixed branches
# retain their historical mapping only while fixed lanes are migrated.
local_ai_review_select_context() {
  local branch=$1 repo_root=${2:-.}
  local issue common state values reviewer epoch used limit stored_branch
  case "$branch" in
    issue-[0-9]*-*)
      issue=${branch#issue-}
      issue=${issue%%-*}
      common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
        printf 'local AI review: cannot resolve Git common directory\n' >&2
        return 1
      }
      state="$common/soroeru-issue-worktrees/$issue.json"
      [ -f "$state" ] || {
        printf 'local AI review: missing lifecycle metadata for Issue #%s\n' "$issue" >&2
        return 1
      }
      values=$(jq -r '[.branch,.review.reviewer,.review.epoch,.review.used,.review.limit] | @tsv' "$state" 2>/dev/null) || {
        printf 'local AI review: corrupt lifecycle metadata for Issue #%s\n' "$issue" >&2
        return 1
      }
      IFS=$'\t' read -r stored_branch reviewer epoch used limit <<< "$values"
      [ "$stored_branch" = "$branch" ] || {
        printf 'local AI review: metadata branch mismatch for Issue #%s\n' "$issue" >&2
        return 1
      }
      case "$reviewer" in claude|codex|grok|gemini) ;; *) return 1 ;; esac
      case "$epoch:$used:$limit" in *[!0-9:]*|::*|*:) return 1 ;; esac
      printf '%s\t%s\t%s\t%s\t%s\n' "$reviewer" "$issue" "$epoch" "$used" "$limit"
      ;;
    *)
      reviewer=$(local_ai_review_select_reviewer "$branch") || return 1
      printf '%s\tlegacy\t0\t0\t2\n' "$reviewer"
      ;;
  esac
}

# Atomically reserve one review run for an Issue epoch. Print the new used
# count. A queue that cannot reserve must not launch a reviewer.
local_ai_review_reserve_budget() {
  local issue=$1 epoch=$2 repo_root=${3:-.}
  local common state lock tmp used limit
  common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  state="$common/soroeru-issue-worktrees/$issue.json"
  lock="$common/soroeru-issue-worktrees/$issue.lock"
  [ -f "$state" ] || return 1
  local_ai_review_acquire_state_lock "$lock" || return 1
  tmp="$state.reserve.$$"
  if ! jq -e --argjson epoch "$epoch" '.review.epoch == $epoch and .review.used < .review.limit' "$state" >/dev/null 2>&1; then
    local_ai_review_release_state_lock "$lock"
    return 1
  fi
  if ! jq -c --argjson epoch "$epoch" \
      'if .review.epoch == $epoch and .review.used < .review.limit
       then .review.used += 1 | .review.pending = ((.review.pending // 0) + 1)
       else . end' \
      "$state" > "$tmp" || ! mv "$tmp" "$state"; then
    rm -f "$tmp"
    local_ai_review_release_state_lock "$lock"
    return 1
  fi
  used=$(jq -r .review.used "$state")
  limit=$(jq -r .review.limit "$state")
  local_ai_review_release_state_lock "$lock"
  [ "$used" -le "$limit" ] || return 1
  printf '%s\n' "$used"
}

# Mark a reserved queue slot as started after the orchestrator owns its review
# lock. Budget remains consumed, but handoff no longer needs to wait on the
# pending-launch counter because the review lock now protects the epoch.
local_ai_review_mark_started() {
  local issue=$1 epoch=$2 repo_root=${3:-.}
  local common state lock tmp
  common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  state="$common/soroeru-issue-worktrees/$issue.json"
  lock="$common/soroeru-issue-worktrees/$issue.lock"
  [ -f "$state" ] || return 1
  local_ai_review_acquire_state_lock "$lock" || return 1
  tmp="$state.started.$$"
  if ! jq -e --argjson epoch "$epoch" \
       '.review.epoch == $epoch and (.review.pending // 0) > 0' "$state" >/dev/null 2>&1 \
     || ! jq -c --argjson epoch "$epoch" \
       'if .review.epoch == $epoch and (.review.pending // 0) > 0
        then .review.pending -= 1 else . end' "$state" > "$tmp" \
     || ! mv "$tmp" "$state"; then
    rm -f "$tmp"
    local_ai_review_release_state_lock "$lock"
    return 1
  fi
  local_ai_review_release_state_lock "$lock"
}

# Refund one queue reservation when the launcher never reaches its entrypoint.
# The epoch check prevents an old failed launch from mutating a newer handoff.
local_ai_review_refund_budget() {
  local issue=$1 epoch=$2 repo_root=${3:-.}
  local common state lock tmp
  common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  state="$common/soroeru-issue-worktrees/$issue.json"
  lock="$common/soroeru-issue-worktrees/$issue.lock"
  [ -f "$state" ] || return 1
  local_ai_review_acquire_state_lock "$lock" || return 1
  tmp="$state.refund.$$"
  if ! jq -e --argjson epoch "$epoch" \
       '.review.epoch == $epoch and .review.used > 0 and (.review.pending // 0) > 0' "$state" >/dev/null 2>&1 \
     || ! jq -c --argjson epoch "$epoch" \
       'if .review.epoch == $epoch and .review.used > 0 and (.review.pending // 0) > 0
        then .review.used -= 1 | .review.pending -= 1 else . end' \
       "$state" > "$tmp" \
     || ! mv "$tmp" "$state"; then
    rm -f "$tmp"
    local_ai_review_release_state_lock "$lock"
    return 1
  fi
  local_ai_review_release_state_lock "$lock"
}
