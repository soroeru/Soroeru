# Service Display Name Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover a recognizable service name during Visibility collection while preserving user-edited site names.

**Architecture:** Extend the structure-only page snapshot with Open Graph site metadata, select a bounded candidate in a pure automation helper, and persist it at the authenticated collection boundary only while the stored name equals the imported domain. Existing `DomainService` persistence remains the sole write path.

**Tech Stack:** TypeScript, Node test runner, Playwright scanner integration, encrypted Vault v2.

## Global Constraints

- Never expose page values or personal data through `PageSnapshot`.
- Prefer `og:site_name`; use only the approved title delimiters as fallback.
- Never overwrite a `displayName` that differs from `domain`.
- Do not add schema provenance, logo parsing, or registrable-domain fallback.

---

### Task 1: Capture site metadata

**Files:**
- Modify: `src/types.ts`
- Modify: `src/agent/scan.ts`
- Test: `tests/unit/soroeru-chrome-extension.test.ts`

**Interfaces:**
- Produces: optional `PageSnapshot.siteName?: string` populated by `scanInPage()` from `meta[property="og:site_name"]`.

- [ ] Add a scanner integration assertion for a trimmed Open Graph site name.
- [ ] Run `npm test -- tests/unit/soroeru-chrome-extension.test.ts` and verify the missing property fails.
- [ ] Add the optional type and metadata scan.
- [ ] Re-run the focused test and verify it passes.

### Task 2: Select a safe candidate

**Files:**
- Create: `src/automation/site-display-name.ts`
- Create: `tests/unit/soroeru-site-display-name.test.ts`

**Interfaces:**
- Consumes: `PageSnapshot`, site domain.
- Produces: `siteDisplayNameCandidate(snapshot: PageSnapshot, domain: string): string | undefined`.

- [ ] Add failing tests for metadata priority, whitespace trimming, each approved title delimiter family, empty/domain candidates, and titles without a delimiter.
- [ ] Run `npm test -- tests/unit/soroeru-site-display-name.test.ts` and verify the missing module fails.
- [ ] Implement the minimal pure selector using the approved delimiters.
- [ ] Re-run the focused test and verify it passes.

### Task 3: Persist during authenticated collection

**Files:**
- Modify: `src/automation/visibility-runner.ts`
- Test: `tests/unit/soroeru-visibility-service.test.ts`

**Interfaces:**
- Consumes: `siteDisplayNameCandidate` and the authenticated/collection-ready snapshot.
- Produces: an updated `SiteAccount` through `DomainService.upsertSiteAccount` only when `displayName === domain`.

- [ ] Add failing integration tests proving domain-name replacement and manual-name preservation.
- [ ] Run `npm test -- tests/unit/soroeru-visibility-service.test.ts` and verify persistence fails.
- [ ] Add the guarded update immediately before exploration begins.
- [ ] Re-run the focused test and verify both paths pass.
- [ ] Run the repository format, lint, typecheck, and test gates documented in `docs/development.md`.
- [ ] Commit the complete Issue change and process the bounded local AI review workflow.
