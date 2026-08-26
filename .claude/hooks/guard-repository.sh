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

case "$tool" in
  Read|Grep)
    target=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.path // ""')
    case "$target" in
      *tests/e2e/Google_Passwords.csv)
        deny "The real-password CSV is restricted. Use the collection-diagnostics skill, which never exposes its contents."
        ;;
      *state/ai-reviews/*)
        deny "Do not inspect local AI review artifacts directly. Use scripts/wait-for-local-ai-review.sh."
        ;;
    esac
    ;;
  Bash)
    command=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')
    if printf '%s' "$command" | grep -Eq '(^|[;&|[:space:]])git([[:space:]]+-[^[:space:]]+)*[[:space:]]+commit([[:space:]]|$)'; then
      case "$cwd" in
        */.worktrees/*) ;;
        *) deny "Git commits are blocked outside an Issue worktree. Create or resume one with scripts/issue-worktree.sh." ;;
      esac
    fi
    ;;
esac

exit 0
