# Releasing aidemo

The engine's primary channel is the **git ref** — consumer repos run it via
`npx -y github:tandryukha/aidemo#stable`, so "release" means: cut a semver tag
and move the `stable` tag onto it. It's **additionally published to npm** as
`@tandryukha/aidemo` (see [npm channel](#npm-channel) below); the git ref does
not depend on npm, so everything below still works even if npm is skipped.

- `stable` — the moving pointer consumer repos and the SessionStart hook resolve.
- `vX.Y.Z` — an immutable semver tag (pin here for reproducibility).

Version lives in **one place**: `package.json`. The CLI reads it
(`src/cli.ts` → `engineVersion()`), and `aidemo skill install/update` stamps it
into each consumer's `.claude/skills/record-demo/installed.json`. That stamp is
what `aidemo skill check` compares against to decide "update available."

## Cut a release — just bump + push

CI does the tagging. `.github/workflows/release.yml` runs on every push to `main`
and, **only when `package.json` version changed**, creates the `vX.Y.Z` tag, moves
`stable` onto it, and publishes a GitHub Release.

```bash
npm version patch --no-git-tag-version   # or minor / major — bumps package.json only
git commit -am "release: vX.Y.Z"
git push origin main
# → the `release` workflow cuts the tag + moves stable + creates the Release.
```

(`npm version patch` without `--no-git-tag-version` also works — it commits and
tags locally; `git push origin main --follow-tags` then pushes both, and CI is
idempotent: it skips the existing tag but still moves `stable` and makes the
Release.)

This repo is **main-only** (no PRs/branches) for the maintainer; contributions
come in as PRs per CONTRIBUTING.md. Note the release trigger: any push to main
that changes `package.json` version cuts a release — bump the version only when
you mean to ship.

### Manual fallback (if CI is unavailable)

```bash
v=vX.Y.Z
git tag -a "$v" -m "$v" && git push origin "$v"
git tag -f stable && git push -f origin stable
gh release create "$v" --generate-notes
```

If the workflow fails on permissions, enable
**Settings → Actions → General → Workflow permissions → Read and write**.

## Consumers pick it up

- The `SessionStart` hook in each consumer repo runs
  `npx -y github:tandryukha/aidemo#stable skill check` and prints a notice
  when their installed skill is behind the new `stable`.
- They apply it when ready: `npx -y github:tandryukha/aidemo#stable skill update --dir .`

## npm channel

Additive to the git ref. Package: **`@tandryukha/aidemo`** (public, scoped).
`package.json` `files` ships only `bin/`, `src/`, `docs/AUTHORING.md`, and
`.claude/skills/record-demo/SKILL.md` (see the `files`-allowlist invariant in
AGENTS.md). Verify the tarball anytime with `npm pack --dry-run`.

**One-time setup (maintainer, once):**

1. Own the npm scope: the npm username `tandryukha` must exist (or change the
   `name` in `package.json` to your actual scope).
2. **First publish, manually** from a clean checkout:
   `npm login` → `npm publish --access public`. Verify:
   `npx -y @tandryukha/aidemo@latest --version` → `0.8.0`, and
   `npx -y @tandryukha/aidemo@latest guide | head`.
3. **Configure OIDC trusted publishing** on npmjs for the package
   (npmjs.com → the package → Settings → Trusted Publishers → GitHub Actions →
   repo `tandryukha/aidemo`, workflow `release.yml`). No token secret needed.
4. **Turn on CI publishing**: repo → Settings → Secrets and variables → Actions
   → Variables → add `NPM_PUBLISH` = `true`.

**Ongoing:** after step 4, a version bump pushed to `main` publishes to npm
(with provenance) alongside the tag/release — idempotent (skips a version already
on npm). The `release.yml` npm step is a no-op while `NPM_PUBLISH` is unset.

**MCP registry** (once npm is live): publish `server.json`
(`io.github.tandryukha/aidemo`) with the `mcp-publisher` CLI:
`mcp-publisher login github` → `mcp-publisher publish`. Bump `version` in
`server.json` on each release you want listed.

## Caveat: npm caches moving tags

`npx ...#stable` resolves the `stable` ref to a commit each run, but npm caches
git installs by resolved commit. Right after moving `stable`, a consumer whose
cache still holds the old commit may not see the new version until the cache
refreshes. To force-fresh: `npx --prefer-online -y github:tandryukha/aidemo#stable ...`,
or pin the hook/commands to an explicit `#vX.Y.Z` when you need determinism.
