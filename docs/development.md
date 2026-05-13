# Development

This document owns local development workflow and implementation conventions.

Architecture decisions belong in [`extension.md`](extension.md). Product
requirements belong in [`requirements.md`](requirements.md).

## 1. Development Policy

Write development principles, review size expectations, and how to keep changes
small and reversible.

## 2. Environment Setup

Write required tools, install steps, and first-run setup.

```bash
# Install dependencies
```

## 3. Run Locally

Write commands for building, loading, and running the extension locally.

```bash
# Start local app or service
```

## 4. Project Structure

Write the source, test, fixture, and documentation directory layout.

```text
.
├── src/
├── tests/
└── docs/
```

## 5. Implementation Conventions

Write naming, module boundaries, storage access rules, and extension-specific
implementation rules such as avoiding scattered direct storage calls.

## 6. Formatting And Linting

Write formatting and linting commands once they exist.

```bash
# Format command

# Lint command
```

## 7. Type Checking

Write typecheck commands and expectations once they exist.

```bash
# Typecheck command
```

## 8. Quality Gates

Write the checks that should run before committing or opening a PR.

## 9. Local AI Review

Write only the short setup pointer here.

```bash
bash scripts/setup-hooks.sh
```

Detailed hook behavior belongs in [`local-ai-review.md`](local-ai-review.md).

## 10. Operational Notes

Write local state, generated files, migration notes, and troubleshooting that
does not belong in a more specific document.
