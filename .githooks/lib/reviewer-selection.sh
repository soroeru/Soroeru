#!/usr/bin/env bash
# Sourced by .githooks/post-commit and smoke checks.

local_ai_review_select_reviewer() {
  local branch=$1
  case "$branch" in
    ${LOCAL_AI_REVIEW_AUTHOR_PREFIX_CLAUDE}*) printf '%s\n' "claude" ;;
    ${LOCAL_AI_REVIEW_AUTHOR_PREFIX_CODEX}*)  printf '%s\n' "codex" ;;
    *) return 1 ;;
  esac
}
