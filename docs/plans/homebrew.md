# Plan: Homebrew distribution (custom tap)

**Status: deferred (2026-07-15), ready to implement.** aidemo already ships via
npm (`@tandryukha/aidemo`), the GitHub Marketplace, the MCP Registry, and the
git ref — Homebrew is *additive* and low-priority. The one real upside is that a
formula can `depends_on "ffmpeg"`, so `brew install aidemo` auto-installs the
one prereq users most often miss. Do this only when there's demand for a
`brew install aidemo` one-liner; nothing else depends on it.

## Why a custom tap (not homebrew-core)

homebrew-core **rejects formulae that just wrap an npm package** (policy), so
core is out. A **personal tap** — a repo named `tandryukha/homebrew-aidemo` —
lets users run:

```bash
brew install tandryukha/aidemo/aidemo      # or: brew tap tandryukha/aidemo && brew install aidemo
```

The formula wraps the published npm package and pulls in `node` + `ffmpeg`
automatically. Chrome stays a runtime requirement surfaced via `caveats` (it's a
cask, `google-chrome`, not a formula — don't `depends_on` it).

## Design

- **New repo:** `github.com/tandryukha/homebrew-aidemo` (the `homebrew-` prefix
  is what makes `brew tap tandryukha/aidemo` resolve).
- **One formula:** `Formula/aidemo.rb`, wrapping the npm tarball.
- **Deps:** `depends_on "node"` (runtime — aidemo runs its TS via the bundled
  `tsx`), `depends_on "ffmpeg"` (the auto-install win). Chrome via `caveats`.
- **Install:** `Language::Node.std_npm_install_args`, skipping the Playwright
  browser download (aidemo drives system Chrome, `channel: "chrome"`).

### Example formula (`Formula/aidemo.rb`)

```ruby
require "language/node"

class Aidemo < Formula
  desc "Your coding agent makes the demo video — narrated, captioned demo MP4 from a storyboard.json"
  homepage "https://github.com/tandryukha/aidemo"
  # Scoped-package tarball URL: .../@scope/name/-/<name>-<version>.tgz
  url "https://registry.npmjs.org/@tandryukha/aidemo/-/aidemo-0.8.0.tgz"
  sha256 "80597a32b5ef4bfda3adc913d84c2b6638a1899f3cec7ddeba046bf4fe9c7e38" # 0.8.0
  license "MIT"

  depends_on "node"
  depends_on "ffmpeg"

  def install
    # aidemo drives system Chrome — no Playwright browser download needed.
    ENV["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] = "1"
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      aidemo drives your real Google Chrome (channel: "chrome").
      Install it separately if you don't have it:
        brew install --cask google-chrome
      Voice/captions need an OpenAI-compatible endpoint OR the local provider
      (AIDEMO_TTS_PROVIDER=local). See: aidemo doctor
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/aidemo --version")
  end
end
```

Get the `sha256` for a new version with:
```bash
curl -sL "https://registry.npmjs.org/@tandryukha/aidemo/-/aidemo-<version>.tgz" | shasum -a 256
```

## Implementation steps

1. Create the public repo `tandryukha/homebrew-aidemo` with `Formula/aidemo.rb`
   (above), a short README (the two install commands), and MIT license.
2. Local validation:
   ```bash
   brew install --build-from-source ./Formula/aidemo.rb
   brew audit --strict --new-formula ./Formula/aidemo.rb
   brew test aidemo
   aidemo --version && aidemo doctor
   ```
   Confirm `ffmpeg` got pulled in and `aidemo guide` works (it reads
   `docs/AUTHORING.md` from the installed package — the npm `files` allowlist
   already ships it).
3. Push the tap. Users then: `brew install tandryukha/aidemo/aidemo`.
4. Add the badge/《brew》line to README once live:
   `brew install tandryukha/aidemo/aidemo`.

## Version maintenance

The formula's `url` + `sha256` must bump on every npm release. Two options:
- **Manual** (fine at current cadence): after `npm publish`, update the two
  lines in `Formula/aidemo.rb` (sha via the `curl | shasum` above), commit.
- **Automated** (do this if releases get frequent): a workflow in the tap repo
  using `brew bump-formula-pr` (or `dawidd6/action-homebrew-bump-formula`)
  triggered on a new npm version, opening a PR that bumps url+sha. Keep any
  new GitHub Action **pinned to a full commit SHA** (repo convention).

## Gotchas / notes

- **Heavy install:** `npm install` of the tarball pulls Playwright (+ its ~2 MB
  ffmpeg recording helper) and other deps into `libexec`. `ffmpeg` is the brew
  dep; the Playwright *browser* download is skipped via the env var above.
- **Node CLI via tsx:** aidemo ships TS source and runs through `tsx` (a runtime
  dep in the npm package), so no compile step is needed in the formula — the
  `libexec/bin/aidemo` shim works as-is.
- **Chrome is not a dep** — it's a cask; surface it in `caveats`, don't
  `depends_on`.
- Keep this in sync with the npm package's `bin` (`aidemo`) — the symlink line
  links whatever `libexec/bin/*` the package declares.

## When NOT to bother

If npm/`npx -y @tandryukha/aidemo` adoption is fine and nobody's asking for
`brew install`, leave this deferred — it's pure maintenance surface (a second
channel to version-bump) for an audience that already has Node.
