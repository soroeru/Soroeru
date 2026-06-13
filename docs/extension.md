# Application Architecture

This document owns **`autofill` application architecture and design decisions**: the
layer boundaries, the Playwright automation runtime, the encrypted store, the AI agent
boundary, and the registration / hand-off control flow.

Canonical product direction is
[`rfc-001-chrome-autofill-pivot.md`](rfc/rfc-001-chrome-autofill-pivot.md) (RFC-001 v3,
see §7). Out of scope here: product requirements (see [`requirements.md`](requirements.md)),
setup and repository layout (see [`development.md`](development.md)), and security
rationale (see [`security.md`](security.md)).

> **Direction change (2026-06-12).** `autofill` is no longer a Chrome Extension
> (Manifest V3). It is a **local Playwright-based application**. The previous MV3 design
> (content script / background service worker / options page) is historical and lives in
> git. Detailed component and file layout are finalized during the PoC (#33); this
> document describes the intended boundaries.

## 1. Architecture Overview

`autofill` is a local application with four layers:

```text
autofill (local app)
├── store layer
│   ├── personal data (name, address, phone, email, card incl. CVV, per-site credentials)
│   ├── per-site records (references + hashes, not duplicated raw values)
│   ├── authorization records (mandates)
│   └── all encrypted at rest (AES-256-GCM, master-passphrase-derived key)
│
├── agent layer (the user's AI; provider-abstracted)
│   ├── finds the registration page
│   ├── maps form fields to stored field types (AI variant)
│   ├── detects high-risk terms clauses
│   └── receives form structure / terms text — never raw personal values
│
├── automation layer (Playwright)
│   ├── drives a headed browser (Chromium / Firefox / WebKit)
│   ├── navigates, fills values locally, submits after approval
│   ├── detects walls (CAPTCHA / MFA / verification) — never bypasses
│   └── pauses for hand-off and resumes in the same session
│
└── UI layer
    ├── personal-data management (incl. card data, credentials)
    ├── per-site inventory and bulk-update selection
    ├── the review-and-confirm gate
    └── settings (master passphrase, AI provider API key)
```

Keep shared logic — field classification, wall detection, the store/crypto boundary, and
the provider abstraction — isolated so it can be tested outside a live browser.

### 1.1 Layer seams and shared contracts (MAINT-001)

The PoC (`poc/autofill-agent/`) is the reference implementation of these boundaries; this
issue locks the seams there rather than rewriting them into `src/`. Promotion of the PoC
into a product `src/` tree is tracked separately (see APP-001 / #43).

The four layers communicate only through **typed contracts** declared in
`poc/autofill-agent/src/types.ts`: `ProfileKey`, `Transform`, `PageSnapshot` /
`FormField`, `MappingPlan`, `TermsAnalysis`, `WallDetection`, `GateRequest` /
`GateDecision`, `SiteRecord` / `FilledFieldRecord`, and `RegistrationMandate`. No layer
reaches across these types into another layer's internals.

Two seams keep the deterministic and AI variants interchangeable and testable:

- **`Mapper` seam** (`src/agent/mapper.ts`): `DeterministicMapper` and `AiMapper`
  implement the same interface (`discoverRegistrationLink`, `mapFields`, `analyzeTerms`).
  The orchestrator depends on the interface, so either variant can be swapped in and
  measured against the same scenarios.
- **Normalization seam** (`src/agent/normalization.ts`): every mapper output passes
  through `normalizeMappingPlan` / `normalizeTermsAnalysis` before the agent acts on it.
  This is the single place that drops invented keys, invalid transforms/roles, and
  field ids that are not on the page, and that folds `prohibitsAutoCreation` /
  `trial-subscription` into the high-risk flags. Both variants share it, so guard stop
  conditions are identical regardless of which mapper produced the plan.

**Cross-layer invariant (agent layer never sees raw values).** The agent layer receives
only `PageSnapshot` structure (labels / `name` / `id` / type / options / nearby text) and
terms text. Raw profile values are resolved from the decrypted store and injected by the
automation layer at fill time — they never enter a mapper input or an AI prompt. This
invariant is asserted in `tests/unit/autofill-poc-contracts.test.ts`.

## 2. Automation Layer (Playwright)

- Playwright is the automation runtime **and** the test framework, chosen for
  browser-engine independence (Chromium / Firefox / WebKit). See `development.md` for
  commands once they exist.
- Run **headed** so the user can take over at a wall in the same session (shared cookies /
  session state), then the agent resumes.
- The automation layer is where raw personal **values** are injected into form fields.
  Values come from the decrypted store, not from the AI model.
- Registration runs new browser sessions; updates log in with stored per-site credentials.

## 3. Agent Layer (AI)

- Uses the user's configured provider only (Anthropic Opus / Sonnet / Haiku, or OpenAI
  GPT-5.4 / 5.4-mini / 5.3-Codex) behind a provider-abstraction interface.
- Receives **form structure** (labels, `name`, `id`, type, nearby text) and **terms text**,
  and returns a mapping plan and high-risk findings. It does not receive raw personal
  values and is not given direct browser control (the automation layer executes the plan).
- Stateless requests only; no prompt caching of personal data, stored threads, or memory.
- A **deterministic** field-mapping variant (reusing the existing scanner and rule-based
  classifier) is built alongside the AI variant and compared for accuracy (RFC §8).

## 4. Store Layer (encrypted)

- All personal data, card data (incl. CVV), per-site credentials, the API key, per-site
  records, and mandates are encrypted at rest. Encryption is canonical in
  [`security.md`](security.md) §4 (Argon2id / PBKDF2-SHA-512 + AES-256-GCM, key in memory
  only).
- Per-site records hold **references + hashes**, not duplicated raw values, so bulk-update
  diffing works without multiplying sensitive data.
- Access goes through a small abstraction; never log decrypted values.

## 5. Registration Control Flow

1. The user gives a URL; the automation layer opens it.
2. The agent finds the registration page and analyzes the form.
3. Missing fields are requested from the user and saved for reuse.
4. The **review-and-confirm gate** shows the submission summary, terms links, and detected
   high-risk clauses.
5. On the user's single approval, the automation layer fills, accepts ordinary terms, and
   submits, applying the **three guards** (high-risk escalation; payment stop with the
   free-trial→subscription exception; no auto-attestation).
6. On auto-creation-prohibited sites, the agent fills only and the user submits.
7. A per-site record and a mandate are written.

## 6. Wall Hand-off and Resume

When CAPTCHA / MFA / identity / email / SMS verification is detected, the agent pauses,
surfaces an instruction overlay, and the user resolves the step in the same headed
session. The agent resumes from the paused step because progress state is held by the
agent, not the page. During a bulk update, the current site pauses, the user resolves,
that site resumes, then the run continues. Detection is conservative and never attempts to
solve or bypass; see [`security.md`](security.md) §7.

## 7. Bulk Update

The user selects sites and runs an update. For each, the agent diffs the per-site record
hashes against the latest stored values, opens the sites with changes, logs in with stored
credentials, updates the changed fields, and handles walls via §6.

## 8. Status

This is design intent. Concrete component structure, file layout, and the reusable scanner
/ classifier integration are finalized during the PoC (#33). Reusable assets from the
earlier work (the form scanner and rule-based classifier) feed the deterministic mapping
variant.
