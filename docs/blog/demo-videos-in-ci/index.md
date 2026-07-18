# Rendering demo videos in CI: a GitHub Actions walkthrough

July 18, 2026 · Demo Automation · 7 min read · https://aidemo.top/blog/demo-videos-in-ci/

> GitHub's runner ships Chrome but not ffmpeg. Here is what a video-rendering job actually needs, how to trigger it, and where the file should land.

**Key takeaways**

- GitHub's ubuntu-latest ships Google Chrome (150.x as of July 2026) and Node 22 but NOT ffmpeg — add `apt-get install -y ffmpeg` or the compose step fails.
- The runner installs one font package (Noto color emoji), so non-Latin captions render as tofu boxes until you apt-get the matching Noto family.
- Cron on GitHub Actions runs at most every 5 minutes and gets delayed at the top of the hour — trigger on the paths that changed the UI, keep cron as a backstop.
- Publish choices: auto-commit (raw-URL embed, bloats git), release asset (2 GiB/file cap, stable /releases/latest/download URL), or CI artifact (expires, review-only).
- A commit-back render needs a loop guard: ignore the output path, check the actor, and put [skip ci] in the message, or the job triggers itself forever.

## What a video job needs that a test job doesn't

A test job needs a runtime and your code. A video-rendering job needs three more things: a real browser to drive, a video encoder to trim and mux, and fonts to draw text that isn't a box. The GitHub-hosted `ubuntu-latest` runner hands you one of those for free, so the first job of any pipeline is closing the gaps the manifest quietly leaves open.

Read the runner image's own software list before you trust it. As of July 2026, `ubuntu-latest` resolves to Ubuntu 24.04 and ships Google Chrome 150.0.7871.114, Chromium 150.0.7871.0, ChromeDriver, and Node.js 22.23.1 by default ([actions/runner-images, 2026](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)). That covers the browser and the runtime. What it does not ship is ffmpeg — search the manifest and the string never appears. Every stage that cuts idle time, syncs audio to narration, or muxes a caption track runs on ffmpeg, so a pipeline that assumes it is present dies at the compose step with `ffmpeg: command not found`. One line closes that gap:

```yaml
- run: sudo apt-get update && sudo apt-get install -y ffmpeg
```

Fonts are the second trap, and a quieter one. The image installs exactly one font package, `fonts-noto-color-emoji` ([actions/runner-images, 2026](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)). Latin captions render from the base system fonts, but the moment your narration text, a title card, or a caption line carries CJK, Arabic, Cyrillic, or Devanagari, headless Chrome has no glyph and paints the tofu box (□). The fix is the same shape as the ffmpeg one: `apt-get install -y fonts-noto-cjk fonts-noto` for the families you need. This gap is common enough that the vhs GitHub Action ships an `install-fonts` input specifically to paper over it ([charmbracelet/vhs-action, 2026](https://github.com/charmbracelet/vhs-action)).

The third category is headless quirks. There is no display, no GPU by default, and no window manager, so anything that waits on a real paint or a hardware compositor stalls. This is where a video job is genuinely harder than a screenshot job: a still tolerates a frame captured a few milliseconds early, but a video that records the same flow twice and produces two different timelines is unusable footage. Deterministic replay — pinned viewport and device-pixel-ratio, explicit waits instead of sleeps, controlled animation clocks — is the cost of a stable render, and it is a discipline of its own worth reading up on before you ship ([deterministic browser replay](/blog/deterministic-browser-automation-for-video)). It is also why polished desktop recorders don't transfer to CI: a macOS-only GUI app cannot run on a Linux runner at all, which is the practical push toward [headless, scriptable alternatives](/blog/screen-studio-alternatives) once a demo has to rebuild itself.

Here is the whole inventory in one table.

| The job needs | ubuntu-latest gives you | You add |
|---|---|---|
| A browser | Chrome 150.x, Chromium, ChromeDriver | nothing — drive `channel: chrome` |
| A JS runtime | Node.js 22.23.1 | nothing (engines want Node 20+) |
| A video encoder | nothing | `apt-get install -y ffmpeg` |
| Fonts for captions | Noto color emoji only | `fonts-noto-cjk` / `fonts-noto` for non-Latin |
| Determinism | nothing | your own record layer |

## Triggering on change, on a schedule, or on release

The reason to render in CI at all is that [product media rots](/blog/why-product-demos-go-stale): the UI ships, the video lies, and nobody notices for a quarter. CI's job is to rebuild the video from a spec whenever the thing it depicts changes. There are three honest triggers, and they are not interchangeable.

| Trigger | Fires when | Best for |
|---|---|---|
| Product change (`on: push`, `paths`) | a file matching the pattern is pushed | catching UI drift the moment it lands |
| Schedule (`on: schedule`, cron) | a wall-clock time arrives | drift a path filter can't see (data, deps, embeds) |
| Release (`on: release`) | you cut a version | pinning a demo to a shipped version |

The path filter is the sharp instrument. A `paths` filter runs the workflow only when a push touches files that match the pattern ([GitHub Docs, 2026](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)), so scoping it to your `src/**` or `components/**` means the demo re-renders exactly when the code that could change it does, and not on every README typo. Cron is the backstop for drift a path filter cannot see: a third-party embed that restyled itself, a data fixture, a dependency bump that moved a button. Two facts keep cron a backstop rather than a primary trigger. GitHub caps the frequency at one run every five minutes, and scheduled workflows are documented as "delayed during periods of high loads," with the start of every hour named as the worst offender ([GitHub Docs, 2026](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)). Schedule for something like `17 6 * * 1`, never `0 * * * *`, and do not expect punctuality.

## Prior art: vhs proved the pattern in the terminal

Before wiring your own, look at the tool that made demos-as-code ordinary. vhs bills itself as a way to "write terminal GIFs as code" ([charmbracelet/vhs, 2026](https://github.com/charmbracelet/vhs)); a `.tape` file is the script, checked into the repo, and vhs replays it in a headless terminal to a GIF, MP4, WebM, or PNG frame sequence. It requires `ttyd` and `ffmpeg` on the PATH — the same encoder dependency you just installed by hand. The companion vhs-action collapses the CI loop to a few lines: point it at the tape, let it render, commit the result back.

```yaml
- uses: charmbracelet/vhs-action@v1
  with:
    path: demo.tape
- uses: stefanzweifel/git-auto-commit-action@v4
  with:
    file_pattern: "*.gif"
```

That is the entire pattern: a committed spec, a headless renderer, an auto-commit of the output. The browser version is the same shape with a heavier renderer — a real Chrome instead of a pseudo-terminal — and the same two questions to answer afterward: what triggers it, and where the file goes. It is the mechanism behind [regenerating a demo instead of re-recording it](/blog/automated-product-demo-videos) rather than babysitting a file that quietly goes wrong.

## A worked browser pipeline

For a concrete browser example, here is the composite Action from aidemo, which is our engine, disclosed as ours and honest about the limits: it is browser-only, its storyboards come from a coding agent rather than clips nudged across a visual timeline, and there is no click-to-trim editor. What it does have is a one-line CI entry point. The workflow below renders every demo under `demos/` on the pushes that could change them, on a weekly backstop, and on demand, then commits the result back.

```yaml
name: demo
on:
  push:
    branches: [main]
    paths: ["demos/**", "!demos/**/output/**"]
  workflow_dispatch:
  schedule:
    - cron: "17 6 * * 1"        # Mondays, off the top of the hour
permissions:
  contents: write
jobs:
  render:
    if: github.actor != 'github-actions[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # ubuntu-latest ships Chrome, not ffmpeg
      - run: sudo apt-get update && sudo apt-get install -y ffmpeg
      - uses: tandryukha/aidemo@stable
        with:
          demos: demos/*
          gif: "true"
      - name: Commit the re-render
        run: |
          git config user.name  'github-actions[bot]'
          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
          git add -A demos
          git diff --cached --quiet || \
            (git commit -m 'chore(demo): re-render [skip ci]' && git push)
```

Three details earn their place. The `paths` list excludes `demos/**/output/**`, so the commit of a freshly rendered file cannot match the trigger that produced it. The `if: github.actor != 'github-actions[bot]'` guard is a second layer, and `[skip ci]` in the commit message is a third: a commit-back job with none of these triggers itself, forever, on your dime. Driving the runner's pre-installed Chrome through `channel: chrome` means the Action skips downloading a browser on every run, using the one dependency the image already got right. Pin `actions/checkout` to a commit SHA rather than a floating `@v4` tag when you harden this for production.

## Publishing: commit, release asset, or artifact

Rendering is half the job. The file then has to land somewhere an `<img>` or `<video>` tag can reach without breaking next quarter. Three targets, three tradeoffs.

| Publish target | Stable URL | Size ceiling | The catch |
|---|---|---|---|
| Commit into the repo | `raw.githubusercontent.com/owner/repo/main/path` | git's, effectively | binaries bloat history; needs the loop guard |
| Release asset | `github.com/owner/repo/releases/latest/download/NAME` | 2 GiB per file | you must cut a release; up to 1000 assets |
| CI artifact | none (auth + expiry) | small | expires (90 days default), not publicly embeddable |

Committing the file back is the simplest path and what both vhs-action and the pipeline above do. The `raw.githubusercontent.com` URL is stable, and GitHub proxies and caches it when it is embedded in markdown, so a README GIF loads fast. The cost is that git was never built for megabyte binaries: every re-render appends a full copy to history. That is fine for a small GIF and painful for a 40 MB MP4 rebuilt every week.

Release assets fix the bloat by living outside the git tree. GitHub documents a clean stable link: the `/releases/latest/download/asset-name` suffix always resolves to the newest release's copy of that file ([GitHub Docs, 2026](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)). The limits are generous — each file must be under 2 GiB, up to 1000 assets per release, with no cap on total size or bandwidth ([GitHub Docs, 2026](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)). The price is a release step: your workflow has to `gh release upload` the MP4, which pins the public demo to a tagged version rather than always-latest-main.

The CI artifact (`actions/upload-artifact`) is the third target and mostly a review tool. It expires — 90 days by default — and needs authentication to download, so it cannot back a public embed. Use it to eyeball a render on a pull request before it is published, not as the home of record.

The decision reduces to size and audience. A sub-megabyte README GIF: commit it. A multi-megabyte narrated MP4 on a marketing page: release asset with the stable `latest/download` URL. A render only a reviewer needs to see: artifact. Whichever you choose, the property that matters is the one CI actually buys you: the demo is correct because a machine rebuilt it against the current UI, not because a human remembered to.

## Sources

- [actions/runner-images — Ubuntu 24.04 (ubuntu-latest) installed software](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)
- [GitHub Docs — Events that trigger workflows (schedule cron, paths filter)](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [GitHub Docs — About releases (2 GiB per file, 1000 assets)](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [GitHub Docs — Linking to releases (latest/download URL)](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)
- [charmbracelet/vhs — terminal GIFs as code](https://github.com/charmbracelet/vhs)
- [charmbracelet/vhs-action — VHS in CI](https://github.com/charmbracelet/vhs-action)
- [aidemo CI recipe (our composite Action, disclosed as ours)](https://github.com/tandryukha/aidemo/blob/main/docs/CI.md)

## FAQ

### Does the ubuntu-latest GitHub Actions runner include ffmpeg and a browser?

It includes a browser but not the encoder. As of July 2026 the image ships Google Chrome 150.x, Chromium, and Node.js 22, but ffmpeg does not appear anywhere in its software manifest. Add `sudo apt-get update && sudo apt-get install -y ffmpeg` before any step that trims, syncs, or muxes video, or the compose stage fails with `command not found`.

### How often can a scheduled render actually run on GitHub Actions?

GitHub caps cron at one run every five minutes, and even then scheduled workflows are documented as delayed during high load, with the top of every hour being the worst window. Treat cron as a backstop, schedule it for an odd minute like `17 6 * * 1` rather than `0 * * * *`, and drive time-critical re-renders from a `paths` filter on the code that changed instead.

### Where should the rendered video live so an embed never breaks?

Match the target to the file. Commit sub-megabyte GIFs into the repo and embed the stable `raw.githubusercontent.com` URL. Push multi-megabyte MP4s as release assets and link the `/releases/latest/download/name` URL, which survives up to 2 GiB per file. Keep CI artifacts for pull-request review only — they expire after 90 days and need authentication, so they cannot back a public page.
