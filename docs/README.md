# Documentation guide

Soroeru's current direction is a Chrome extension with an encrypted local vault
and Google Cloud form assistance. Read the owning document for the task:

| Document | Owns |
| --- | --- |
| [Requirements](requirements.md) | UX goals, user flows, priorities and decision boundaries |
| [Architecture](architecture.md) | Components, data flows, persistence and current/target status |
| [Security](security.md) | Data handling, retention and concrete risk controls |
| [Development](development.md) | Current setup, build, test and deployment commands |
| [Testing](testing.md) | Test strategy and layer coverage |
| [Manual checks](manual-test.md) | Fake-data extension and Cloud verification |
| [User manual](user-manual.md) | Available extension behavior and limitations |
| [GitHub operations](github-operations.md) | Issue/worktree, PR, review and merge workflow |

Plans, evaluations, implementation reports and review records belong in GitHub
Issues/PRs. Keep only durable cross-Issue decisions in the owning documents;
do not create per-Issue design/spec directories or archive removed documents.
Historical details remain in Git history and the original Issue/PR.
