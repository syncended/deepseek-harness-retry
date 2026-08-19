# Releasing

Releases follow the same tag-driven npm publication flow as `@syncended/dsh-pip`.

## One-time setup

1. **Register on npm** — https://www.npmjs.com/signup
2. **Create a Granular Access Token that bypasses 2FA** — https://www.npmjs.com/settings/syncended/tokens → Generate New Token → **Granular Access Token**:
   - Permissions: **Packages and scopes** → **Read and write**, for scope `@syncended` or package `@syncended/dsh-retry`.
   - **Two-factor authentication: Bypass two-factor authentication** — required for token-based CI publication when the account has 2FA enabled.
   - A classic **Automation** token also works, but granular + bypass is preferred.
3. **Add the token to GitHub Actions secrets** — repository → Settings → Secrets and variables → Actions → New repository secret:
   - Name: `NPM_REGISTRY_TOKEN`
   - Value: the npm token from step 2.

## Every release

Start from a clean `trunk` branch with all checks passing:

```bash
pnpm check
npm pack --dry-run
```

For the first `0.1.0` publication, the package is already at that version. Tag the checked release commit directly:

```bash
git tag -a v0.1.0 -m "0.1.0"
git push origin v0.1.0
```

For later releases, bump, commit, tag, and push:

```bash
npm version patch   # or minor, major, or an explicit version such as 0.2.0
git push --follow-tags
```

`npm version` creates a `v<version>` Git tag. The `.github/workflows/release.yml` workflow verifies that the tag matches `package.json`, installs the frozen dependency graph, runs checks/tests, verifies generated `dist`, checks package contents, and publishes with npm provenance.

Package page:

https://www.npmjs.com/package/@syncended/dsh-retry

After publication, users install with:

```bash
dsh plugin --profile web add -w @syncended/dsh-retry
```

Restart `dsh --profile web` after installation.
