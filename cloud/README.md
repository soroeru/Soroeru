# Shared Form Schema Registry

`POST /v1/schemas/resolve` accepts only `{ site, pageFingerprint, clientVersion }`.
It returns a value-free active schema or `{ schema: null, status: "none" }`.
The API queries Firestore's `formSchemas` by the structural fingerprint, then validates
records and filters by site/status. It selects the newest matching version, with
confidence and schema ID as deterministic tie breakers. No URL path, query, or field
value enters this API. Storage failures produce a body-free `503`.

Schema writes are maintainer operations, not a public HTTP endpoint. Every write
rejects unknown keys, non-positional selectors, and strings matching the same
personal-value heuristics as local candidate definitions (#80). Counts must be
non-negative integers; timestamps use UTC ISO strings. Changing an existing schema
requires a higher version; reimporting an identical version is safe. These heuristics
are defense in depth, not a semantic guarantee that arbitrary text is non-personal;
the contract only allows domains, hashes, enum keys, positional anchors and dates.

## Reviewed demo fixture

`seeds/profile.html` is a fictional page with fake values. `seeds/official.json`
contains only its structure hash and mappings, with site `schema-fixture.example`.
The browser test verifies that the seed matches the fixture, including after a value
changes. A maintainer must review each manifest before importing it:

```bash
npm ci --prefix cloud
npm run build --prefix cloud
GOOGLE_CLOUD_PROJECT=<project-id> node cloud/dist/cloud/src/import-seeds.js cloud/seeds/official.json --reviewed
```

The command uses Application Default Credentials with Firestore write access.
Validate all records before the first write; rerun the same manifest after a partial
network failure. This workflow does not automatically activate feedback candidates,
retire schemas, or change validation counters (those lifecycle rules are deferred).
Do not put real page values into a manifest or fixture.

Run API/registry tests with `npm test --prefix cloud`. Run the browser and built-extension checks
with `npm run build:extension && node --test dist/compiled/tests/e2e/tier1-*.e2e.js`.
The extension test grants access only to the fake fixture host in a disposable copy
of the manifest. Production permissions stay opt-in.
