# Releasing aidemo

The engine is **not published to a registry**. Consumer repos run it via
`npx -y github:tandryukha/aidemo#stable`, so "release" here means: cut a
semver tag and move the `stable` tag onto it.

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

## Caveat: npm caches moving tags

`npx ...#stable` resolves the `stable` ref to a commit each run, but npm caches
git installs by resolved commit. Right after moving `stable`, a consumer whose
cache still holds the old commit may not see the new version until the cache
refreshes. To force-fresh: `npx --prefer-online -y github:tandryukha/aidemo#stable ...`,
or pin the hook/commands to an explicit `#vX.Y.Z` when you need determinism.
