# Releasing

Releases use tag-driven npm publication with provenance.

## One-time setup

1. Create an npm granular access token for `@syncended/dsh-retry` with package read/write access and CI-compatible 2FA bypass.
2. Store it in the GitHub Actions repository secret `NPM_REGISTRY_TOKEN`.
3. Confirm the release workflow has npm provenance permissions.

Manage tokens at <https://www.npmjs.com/settings/syncended/tokens>.

## Every release

Start from a clean `trunk` branch and run:

```bash
pnpm check
npm pack --dry-run
```

Create and push a version commit and matching `v<version>` tag:

```bash
npm version patch   # or minor, major, or an explicit version
git push --follow-tags
```

The release workflow verifies the tag/version match, installs the frozen dependency graph, reruns tests, verifies generated `dist`, checks package contents, and publishes with npm provenance.

Package page: <https://www.npmjs.com/package/@syncended/dsh-retry>

Verify installation in a disposable profile:

```bash
dsh plugin --profile web add @syncended/dsh-retry
# Use -w if the pnpm-backed profile requires workspace-root installation.
dsh web --no-open
```

Trigger a controlled retryable failure and confirm `llm/retry` / `llm/retry-started` session events appear.
