---
name: issue-implementation-loop
description: Repeat GitHub Issue implementation work in order with a fixed loop for refreshing main, creating issue-named branches, implementing, committing, waiting for local AI review until NIT_ONLY or PASS with at most three repair cycles, pushing PRs, fixing CI until green, closing PRs, checking remaining session limit, and continuing to the next Issue without extra developer approval when under the limit. Use when the user asks Codex to implement one or more GitHub Issues or to follow the repository Issue Implementation Loop.
---

# Issue Implementation Loop

Use this skill when implementing one or more GitHub Issues in sequence.

## Workflow

For each Issue, follow this loop:

1. 最新版の`main`ブランチを取得する。
2. Issueに書かれた内容に合った名前で新しいブランチを作成する。
3. Issueの実装を開始する。
4. commitしたらレビューを待って修正する。レビューのstatusが`NIT_ONLY`や
   `PASS`になるまで修正を繰り返す。ただし、修正とレビューの繰り返しの
   最大回数は3回までとする。
5. ローカルでの開発が終わったらGitHubにpushしてPRを作成する。
6. PRで起動されたCIが失敗したらエラーログを取得して修正してまたpushする。
   CIが成功するまで修正を繰り返す。
7. CIが成功したらPRをクローズにする。
8. セッションリミットの使用率を確認して95%以上であれば作業を停止する。
9. セッションリミットの使用率が95%未満であれば、1~8までを開発者の承認を
   得ずに繰り返す。

## Boundaries

- Respect repository instructions, sandbox rules, external-network approval
  requirements, and destructive-command safety boundaries.
- Do not skip local AI review unless the repository instructions explicitly
  allow it.
- Do not count a review cycle as successful unless the saved review status is
  `NIT_ONLY` or `PASS`.
- Treat PR close as distinct from merge. This workflow intentionally closes the
  PR after CI succeeds unless the user explicitly changes the workflow.
- Because PRs are closed rather than merged, use this loop as-is only when the
  requested Issues are independent from the latest `main`. If later Issues
  depend on earlier changes, merge or otherwise integrate those changes before
  starting the dependent Issue.
- Step 6 has no fixed CI retry count. Continue while there is meaningful
  progress and session-limit usage stays below 95%; stop on external blockers
  or when the session-limit rule requires stopping.
- Stop instead of starting another Issue when session-limit usage reaches 95%
  or higher.
