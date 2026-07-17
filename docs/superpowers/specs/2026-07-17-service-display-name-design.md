# Service Display Name Discovery Design

Issue: #386

## Goal

Replace a CSV-imported domain display name with a recognizable service name observed during Visibility collection, without overwriting a user-selected name.

## Design

`PageSnapshot` gains an optional, structure-only `siteName` populated from the trimmed `og:site_name` meta value by both browser scanners. A pure name-selection helper prefers that value and otherwise derives a candidate from the trimmed page title by taking the first non-empty segment before `｜`, `|`, `—`, `–`, ` - `, `:`, or `·`. Empty candidates and candidates equal to the account domain are ignored.

`VisibilityRunner` evaluates the snapshot after authentication has been established (or the initial snapshot when an authenticated session is reused/no credential exists). It persists the candidate through `DomainService.upsertSiteAccount` only when the stored `displayName` exactly equals `domain`. This comparison protects existing manual names and makes later collection runs no-ops after the first successful discovery. Missing metadata/title leaves the account unchanged.

Logo `alt`, registrable-domain generation, provenance flags, and brand-change tracking are outside this Issue.

## Verification

- Scanner integration test proves `og:site_name` enters the structure-only snapshot in both scanner paths.
- Pure helper tests fix metadata priority, title delimiter extraction, trimming, and unusable candidates.
- Visibility integration tests prove persistence for an imported domain name and protection of a manual display name.
- Repository format, lint, typecheck, and test gates remain green.
