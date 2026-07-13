#!/usr/bin/env bash
# Sourced by .githooks/post-commit and smoke checks.

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
