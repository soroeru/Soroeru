# Issue #390: Unified Sorting Mode Design

**Issue:** #390  
**Date:** 2026-07-15  
**Status:** Design approved (unified mode selector confirmed)

## Overview

This document consolidates the design decision to unify Issues #387 (drag-and-drop manual reordering) and #389 (name sorting) into a single exclusive sorting mode selector, rather than allowing both features to operate simultaneously.

## Problem Statement

Two separate sorting/reordering features were proposed:
- **#387**: Drag-and-drop manual reordering (preserves user-defined order)
- **#389**: Name-based sorting (ascending/descending by site name)

If implemented independently, users would have both a manual sort order (`sortOrder`) and an active sort direction, leading to conflicting UX patterns where:
1. Name sorting could override manual order immediately upon activation
2. Dragging rows while name sort is active would be negated by the sort re-applying
3. Users could not freely choose between manual and name-based ordering

This is an **anti-pattern** that major productivity apps (Todoist, Spotify, Notion) explicitly avoid.

## Solution: Exclusive Mode Selector

Instead of enabling both simultaneously, implement a **single sorting mode selector** with mutually-exclusive options:

### Sorting Modes

1. **Manual** (Default or user-preferred):
   - Drag-and-drop reordering is enabled
   - Each site has a `sortOrder: number` field (canonical storage)
   - Rows are sorted by `sortOrder` ascending
   - Only enabled when this mode is selected

2. **Site Name Ascending**:
   - Rows are sorted by `displayName` ascending (A→Z, あ→ん)
   - Drag-and-drop is **disabled**
   - Name sort is **non-destructive** (does not modify `sortOrder`)
   - When switching back to Manual, previous manual order is restored (Spotify pattern)

3. **Site Name Descending**:
   - Rows are sorted by `displayName` descending (Z→A, ん→あ)
   - Drag-and-drop is **disabled**
   - Non-destructive to `sortOrder`
   - Restores previous manual order when switched back

### Key Design Principles

- **Canonical order**: The manual `sortOrder` is always the source of truth; name sorts are temporary, read-only views
- **Mode exclusivity**: Only one sort mode is active at a time; switching modes is explicit
- **Drag limitations**: Drag-and-drop only works in Manual mode; disabled in name sort modes (UX signal)
- **Non-destruction**: Switching from name sort back to Manual restores the exact previous manual order

## Implementation Mapping

### Issue #387 (Drag-and-drop manual reordering)

Becomes the **Manual mode** of the unified selector:
- Adds `sortOrder: number` field to `SiteAccount`
- Implements reordering API (e.g., `reorderSiteAccounts(orderedIds: string[])`)
- Changes `ledgerSites()` to sort by `sortOrder` instead of `displayName`
- Implements drag-drop UI (drag handle or row-level dragging)
- Scope: Manual mode only; name sort modes have drag disabled

### Issue #389 (Name-based sorting)

Becomes the **Site Name Ascending/Descending modes** of the unified selector:
- Implements UI selector for ascending/descending
- Uses `localeCompare("ja")` for locale-aware comparison
- Scope: Affects display order only; `sortOrder` is not modified
- When switched back to Manual mode, user's previous manual order is intact

### Issue #388 (Filter: collected/uncollected)

**Orthogonal** to sorting modes:
- Filters reduce the site set
- Sorting modes apply within the filtered set
- No interaction between filter and mode selection

## Default Sorting Mode

To be decided at implementation time:
- **Option A**: Default to Manual mode (emphasizes user agency)
- **Option B**: Default to Site Name Ascending (current behavior, familiar to users)

Recommend **Option B** initially to match current behavior; Manual mode is one click away.

## UI Location

- **Selector placement**: Suggested near the ledger table header or in a sort toolbar
- **Options**: Radio button group or dropdown ("Sort by: Manual / Name (A→Z) / Name (Z→A)")
- **Visual feedback**: Disable/gray out drag handles when in name sort modes

## Acceptance Criteria for #390 (Design Issue)

- [x] Unified sorting mode design is documented
- [x] Mode exclusivity and non-destructive principle are clear
- [x] #387 and #389 scopes are updated to reflect unified design
- [x] Default mode decision is deferred to implementation (to be decided in #387 or #389)
- [x] Relationship with filter (#388) is clarified (orthogonal)

## Related Issues

- **#387**: Drag-and-drop reordering (Manual mode implementation)
- **#389**: Name sorting (Name modes implementation)
- **#388**: Filter by collection status (orthogonal)

## References

- **Todoist**: Drag-drop only in Manual mode; name/date sorts disable dragging
  - https://www.todoist.com/help/articles/sort-or-group-tasks-in-todoist-WFWD0hrb
- **Spotify**: Custom order (drag) vs. named sorts; custom order is canonical
  - https://community.spotify.com/t5/Your-Library/Changing-song-order-easily-for-everyone/td-p/5471978
- **Notion**: Sort active ⇒ drag disabled; no sort ⇒ drag enabled
  - https://notionanswers.com/2123/dragging-and-autosorting
