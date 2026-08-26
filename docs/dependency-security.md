# Dependency Security: Continuous Detection and Triage

This document describes a reusable, **project-agnostic** way to continuously detect
and triage dependency (supply-chain) vulnerabilities using **Dependabot** plus a
**CI `npm audit` gate**. It is written so it can be copied into other repositories with
only a few placeholder choices changed.

> Placeholders to set per project: `<ECOSYSTEMS>` (e.g. `npm`, `github-actions`,
> `pip`, `cargo`), `<AUDIT_LEVEL>` (`high` or `critical`), `<SCOPE>` (production-only
> vs. all dependencies), and the location of your accepted-vulnerability record.

## 1. Why two layers

| Layer | Tool | Blocks merges? | Scope | Catches |
| --- | --- | --- | --- | --- |
| Detection / updates | Dependabot | No (opens PRs) | All dependencies | Outdated + vulnerable deps, including build-time-only ones |
| Enforcement gate | CI audit | Yes | Production deps (`<SCOPE>`) | New high/critical advisories in the **shipped** attack surface |

The split matters: a gate that fails on **every** advisory anywhere in the tree goes
permanently red the moment a build-time-only tool (linters, packagers, test runners)
has an unfixable transitive advisory — and a permanently-red gate gets ignored. So the
**gate enforces the narrow, shipped surface**, while **Dependabot surfaces everything
else as reviewable PRs** without blocking.

## 2. CI audit gate

Add one CI step that runs an audit scoped to what you actually ship.

For npm:

```yaml
# .github/workflows/ci.yml
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: <NODE_VERSION>
          cache: npm
      - run: npm ci
      - name: dependency audit gate
        run: npm audit --omit=dev --audit-level=<AUDIT_LEVEL>
```

Design choices, and why:

- **Scope = production (`--omit=dev`).** `--omit=dev` audits `dependencies` **and**
  `optionalDependencies` (i.e. everything that can end up in the shipped/installed
  artifact) but excludes `devDependencies`. This is the surface an end user is exposed
  to. Build/test/packaging tools live in `devDependencies` and are handled by layer 1
  (Dependabot) + a written acceptance record, not by this gate.
  - **Caveat — `optionalDependencies` and platform-specific build tools.** `--omit=dev`
    still audits `optionalDependencies`, and it does so from the resolved dependency
    tree in `package-lock.json`, **not** from what the current OS actually installs — an
    `os`-restricted optional package (e.g. a native packager that only builds on one OS)
    is audited on every CI runner regardless of platform, even where `npm ci` itself
    silently skips installing it. Do not assume an OS-restricted optional advisory is
    scoped out on other runners; it is not. Prefer `devDependencies` for genuinely
    build-only tools; where that is impractical and no clean fix exists upstream, record
    the acceptance explicitly (below) rather than relying on the (false) assumption that
    other-OS runners are unaffected. (In this repo, `appdmg` is an `os: darwin` optional
    DMG packager, build-time-only and never shipped at runtime, but its `image-size`
    advisory is audited — and was accepted — on the Linux CI runner too; see
    `docs/security.md` §12.0 and `scripts/accepted-advisories.json`.)
- **Threshold = `--audit-level=high`.** Fail on `high` and `critical`; let `moderate`
  and below through to Dependabot. Raise to `critical` if even high is too noisy for
  your project, or lower if you want stricter enforcement.
- **Wrap it in a script** so CI and any local gate call the *same* command (single
  source of truth):

  ```json
  // package.json
  "scripts": { "audit:check": "npm audit --omit=dev --audit-level=<AUDIT_LEVEL>" }
  ```

  Then both CI and a local pre-push hook run `npm run audit:check`. Once any advisory
  needs the allowlist described below, this script becomes the thin JSON-parsing wrapper
  itself rather than a raw `npm audit` call — see `scripts/audit-check.mjs` in this repo
  for a concrete implementation (reads accepted advisory ids from a JSON file, fails only
  on advisories not in that list).

### When the gate legitimately must ignore a production advisory

Prefer narrowing scope over a broad gate. If a specific production advisory is
reviewed and accepted (no fix available, not exploitable in your usage), record it in
your acceptance log (below) and, only if necessary, exclude it. npm has no native audit
allowlist; options are: a thin wrapper that parses `npm audit --json` and exits non-zero
only for non-accepted advisory IDs, or `better-npm-audit` / `audit-ci` with an
allowlist file. Keep the allowlist in **one** file shared by CI and local gates.

## 3. Dependabot

Enable automated update PRs across every ecosystem the repo uses.

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "<ECOSYSTEM>"   # e.g. npm
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
    groups:                            # batch routine updates to cut PR noise
      dev-dependencies:
        dependency-type: "development"
      production-dependencies:
        dependency-type: "production"
  - package-ecosystem: "github-actions"  # keep pinned action versions patched
    directory: "/"
    schedule:
      interval: "weekly"
```

Grouping batches routine version bumps into fewer PRs; **security updates are still
opened individually** regardless of grouping, so they stay visible.

### Repository settings (one-time, requires admin)

The config file only takes effect once the GitHub-side features are on. In
**Settings → Code security and analysis**, enable:

- **Dependency graph** (prerequisite),
- **Dependabot alerts** (surfaces known advisories for your deps),
- **Dependabot security updates** (auto-opens fix PRs for alerts).

Or via the GitHub CLI / API (owner/admin token required):

```bash
gh api -X PUT "repos/<OWNER>/<REPO>/vulnerability-alerts"        # alerts
gh api -X PUT "repos/<OWNER>/<REPO>/automated-security-fixes"    # security update PRs
```

## 4. Accepted-vulnerability record

Some advisories cannot be cleanly fixed (no patched version, or only via a breaking
major bump in a transitive build-time tool). Record each acceptance in **one place**
(e.g. a "Dependency and supply chain" section of your security doc) with:

1. the package + advisory IDs and severity,
2. the dependency path (who pulls it in),
3. why it is bounded (build-time only / not shipped / not exploitable in your usage),
4. why there is no clean fix today (upstream status, `fixAvailable`),
5. any override evaluated and its outcome,
6. upstream tracking links and a re-evaluation trigger,
7. the residual count, dated.

This record is the single source of truth the CI gate's scope decision points at, and
the input for release judgment.

## 5. Triage when a NEW high/critical appears

1. **Is it in the shipped (production) surface?** If the CI audit gate failed, yes.
   Treat it as a release blocker until fixed or explicitly accepted.
2. **Is a fix available?** `npm audit fix` (non-breaking) or a targeted bump. Prefer the
   smallest change; verify the build/tests still pass.
3. **No clean fix?** Decide: (a) override to a patched version if it resolves and
   nothing breaks (verify the real build, e.g. packaging), or (b) add to the
   accepted-vulnerability record with justification and a tracking link.
4. **Build-time-only (devDependency)?** It will not fail the gate; let Dependabot's PR
   carry the update, or record acceptance if unfixable.
5. **Re-check the residual count** in the acceptance record and update its date.
