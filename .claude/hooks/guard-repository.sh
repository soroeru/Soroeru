#!/bin/sh

set -eu

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // ""')
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""')

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

is_issue_worktree() {
  candidate=$1
  case "$candidate" in
    /*) ;;
    *) candidate=$cwd/$candidate ;;
  esac

  resolved=$(cd "$candidate" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || return 1
  common_dir=$(git -C "$resolved" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1

  case "$resolved:$common_dir" in
    */.worktrees/*:*/.git) return 0 ;;
    *) return 1 ;;
  esac
}

command_references_password_csv() {
  printf '%s' "$1" | grep -Eq '(^|[[:space:]"'"'"'=:/])tests/e2e/Google_Passwords\.csv([[:space:]"'"'"';|&]|$)'
}

command_references_review_artifacts() {
  printf '%s' "$1" | grep -Eq '(^|[[:space:]"'"'"'=:/])state/ai-reviews/([^[:space:]"'"'"';|&]*)([[:space:]"'"'"';|&]|$)'
}

# The wait script is the only supported reader of finished review results, so
# the deny reason must point at its --print flag rather than leave no path.
REVIEW_ARTIFACT_REASON="Do not inspect local AI review artifacts directly. Read a finished review with scripts/wait-for-local-ai-review.sh --unit <unit> [--commit <sha>] --print."

case "$tool" in
  Read|Grep)
    target=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.path // ""')
    case "$target" in
      *tests/e2e/Google_Passwords.csv)
        deny "The real-password CSV is restricted. Use the collection-diagnostics skill, which never exposes its contents."
        ;;
      *state/ai-reviews/*)
        deny "$REVIEW_ARTIFACT_REASON"
        ;;
    esac
    ;;
  Bash)
    command=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')
    if command_references_password_csv "$command"; then
      deny "Restricted local data cannot be read through Bash. Use the designated repository workflow instead."
    fi
    if command_references_review_artifacts "$command"; then
      deny "$REVIEW_ARTIFACT_REASON"
    fi
    if printf '%s' "$command" | grep -Eq '(^|[;&|[:space:]])git([[:space:]]+-[^[:space:]]+)*[[:space:]]+commit([[:space:]]|$)'; then
      effective_cwd=$cwd
      leading_cd=$(printf '%s' "$command" | sed -nE 's/^[[:space:]]*cd[[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|[^;&|[:space:]]+)[[:space:]]*&&.*/\1/p')
      if [ -n "$leading_cd" ]; then
        effective_cwd=$(printf '%s' "$leading_cd" | sed -E 's/^("(.*)"|'"'"'(.*)'"'"')$/\2\3/')
      fi
      if ! is_issue_worktree "$effective_cwd"; then
        deny "Git commits are blocked outside an Issue worktree. Create or resume one with scripts/issue-worktree.sh."
      fi
    fi
    ;;
esac

exit 0
