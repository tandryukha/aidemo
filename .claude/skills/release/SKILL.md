---
name: release
description: >
  Cut an aidemo release: bump package.json, commit, push to main — CI
  (release.yml) then creates the vX.Y.Z tag, moves `stable`, and publishes the
  GitHub Release, publishes to npm and lists the version on the MCP Registry.
  Use when the user says "cut a release", "release vX.Y.Z",
  "bump and release", "ship a new version", or "move stable". Knows the
  gotchas: the version lives ONLY in package.json, pushing a version bump to
  main IS the ship trigger, CI tagging is idempotent, npm caches the moving `stable` tag
  (--prefer-online to force-fresh), `npx @tandryukha/aidemo@X.Y.Z` inside this
  checkout doesn't run that version. Do NOT use for: installing/updating the
  skill in consumer repos (that's `aidemo skill update`).
allowed-tools: Bash, Read, Grep
metadata:
  internal: true
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

2. **Bump** (the version lives in package.json; plugin.json and server.json
   mirror it) and write the **release commit body = the release notes**:
   ```bash
   npm version patch --no-git-tag-version    # or minor / major
   v=$(node -p "require('./package.json').version")
   sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$v\"/" plugins/record-demo/.claude-plugin/plugin.json server.json
   git commit -asF - <<MSG
   release: v$v

   - feat: what users get, one bullet per change (#issue)
   - fix: …
   MSG
   ```
   release.yml prepends that body (trailers stripped) to GitHub's generated PR
   list — a direct push has no PRs, so without it the notes are empty.

3. **Push** — this is the ship step: once CI sees the version bump on main,
   the release goes out. Make sure the user actually wants a release cut (a
   routine end-of-session push must NOT include a version bump):
   ```bash
   git push origin main
   ```

4. **Watch CI do the rest** — `release.yml` creates `vX.Y.Z`, moves `stable`,
   publishes the Release, npm and the MCP Registry (only when the version
   actually changed). Verify from outside the checkout:
   ```bash
   gh run watch --exit-status "$(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')"
   gh release view "v$(node -p "require('./package.json').version")"
   (cd /tmp && npx -y "@tandryukha/aidemo@$(node -p "require('$PWD/package.json').version")" --version)
   ```

5. **Manual fallback** (CI unavailable) — from RELEASING.md:
   ```bash
   v=vX.Y.Z
   git tag -a "$v" -m "$v" && git push origin "$v"
   git tag -f stable && git push -f origin stable
   gh release create "$v" --notes "$(git log -1 --format=%b "$v")" --generate-notes
   ```

6. **Fix notes after the fact** — Actions → release → Run workflow with
   `notes_tag: vX.Y.Z` re-renders that release's notes from its commit.

## Gotchas

- CI is idempotent: an existing `vX.Y.Z` tag is skipped, but `stable` still
  moves and the Release is still created.
- Inside this checkout `npx @tandryukha/aidemo@<this version>` installs nothing
  and runs the `aidemo` on `PATH`, so a stale Homebrew install prints its own
  version. That's not a bad release: check from another directory.
- The release job can sit for minutes after npm publishes: the MCP Registry step
  waits up to 20 min for npm to serve the version. A timeout there is safe to fix
  with `gh run rerun <id> --failed`.
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
