#!/bin/sh
# Claude Code PreToolUse guard: keep the real-password CSV out of agent
# context. Repository-owned; the template-managed guard-repository.sh only
# covers the Issue worktree commit gate.

set -eu

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // ""')

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

command_references_password_csv() {
  printf '%s' "$1" | grep -Eq '(^|[[:space:]"'"'"'=:/])tests/e2e/Google_Passwords\.csv([[:space:]"'"'"';|&]|$)'
}

case "$tool" in
  Read|Grep)
    target=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.path // ""')
    case "$target" in
      *tests/e2e/Google_Passwords.csv)
        deny "The real-password CSV is restricted. Use the collection-diagnostics skill, which never exposes its contents."
        ;;
    esac
    ;;
  Bash)
    command=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')
    if command_references_password_csv "$command"; then
      deny "Restricted local data cannot be read through Bash. Use the designated repository workflow instead."
    fi
    ;;
esac

exit 0
