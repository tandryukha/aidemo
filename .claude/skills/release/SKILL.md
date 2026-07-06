---
name: release
description: >
  Cut an aidemo release: bump package.json, commit, push to main — CI
  (release.yml) then creates the vX.Y.Z tag, moves `stable`, and publishes the
  GitHub Release. Use when the user says "cut a release", "release vX.Y.Z",
  "bump and release", "ship a new version", or "move stable". Knows the
  gotchas: the version lives ONLY in package.json, this repo pushes only when
  the user asks, CI tagging is idempotent, npm caches the moving `stable` tag
  (--prefer-online to force-fresh). Do NOT use for: publishing to npm (the
  engine is npx-from-git only), or installing/updating the skill in consumer
  repos (that's `aidemo skill update`).
allowed-tools: Bash, Read, Grep
---

# release — bump + push, CI does the tagging

Your job: cut a release safely. [RELEASING.md](../../../RELEASING.md) is the
authoritative runbook — if it contradicts this skill, it wins. Be terse;
surface only failures + final status.

## Phases

1. **Preflight** — clean tree, green smoke:
   ```bash
   git status --porcelain        # must be empty
   npm run typecheck
   ```
   For engine changes since the last tag, run the `verify` skill (fixture e2e)
   before releasing.

2. **Bump** (version lives in one place — package.json):
   ```bash
   npm version patch --no-git-tag-version    # or minor / major
   git commit -asm "release: v$(node -p "require('./package.json').version")"
   ```

3. **Push — only if the user asked for this release to go out** (repo rule:
   pushes happen only when asked):
   ```bash
   git push origin main
   ```

4. **Watch CI do the rest** — `release.yml` creates `vX.Y.Z`, moves `stable`,
   publishes the Release (only when the version actually changed):
   ```bash
   gh run watch --exit-status "$(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')"
   gh release view "v$(node -p "require('./package.json').version")"
   ```

5. **Manual fallback** (CI unavailable) — from RELEASING.md:
   ```bash
   v=vX.Y.Z
   git tag -a "$v" -m "$v" && git push origin "$v"
   git tag -f stable && git push -f origin stable
   gh release create "$v" --generate-notes
   ```

## Gotchas

- CI is idempotent: an existing `vX.Y.Z` tag is skipped, but `stable` still
  moves and the Release is still created.
- Workflow permission failures → Settings → Actions → General → Workflow
  permissions → Read and write.
- Consumers on `npx ...#stable` may keep resolving the old commit from the npm
  cache right after `stable` moves — `npx --prefer-online` force-freshens; pin
  `#vX.Y.Z` for determinism.
- Commits must be signed off (`-s`) like everything else in this repo (DCO).

## Report

```
release: vX.Y.Z cut | blocked
push: done | held (not requested)
ci: tag + stable + Release verified (url) | manual fallback used | failed: <step>
```
