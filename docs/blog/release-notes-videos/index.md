# Release-notes videos generated per release

July 18, 2026 · Demo Automation · 7 min read · https://aidemo.top/blog/release-notes-videos/

> A monthly recap is a chore that slips; a per-tag video is a release artifact. Which releases clear the bar reads straight off the version number.

**Key takeaways**

- The monthly recap slips because a human has to make it; a per-release video is triggered by the release event itself and hand-edited by no one.
- Read 'does this earn a video' off SemVer: a PATCH bug fix gets a changelog line, a MINOR or MAJOR (new user-visible surface) gets a clip.
- Filtering to minor-and-up turns ~24 tags a quarter into ~6 videos — a cadence CI keeps forever, versus 24 that would drown the signal.
- Keep a Changelog's Added section is the script: 'lead with what the user can now do' (Appcues), rendered as one 20-40s clip of the new thing.
- Wire the render to the release event, gate with endsWith(tag,'.0') to skip patches, and attach the MP4 as a release asset so v2.4.0's video lives with v2.4.0.

## The monthly recap dies on the to-do list

The "here's everything we shipped this month" video is a good idea that keeps not happening. It is discretionary work that competes with the roadmap, so it slips to next week, and by the time someone sits down to film it the product has moved again and half the footage is already wrong. The task has no owner the way a failing test has an owner, so it quietly becomes the thing you'll do once the quarter calms down.

A per-release video is a different kind of object. It is not a chore on a calendar; it is an artifact that falls out of the release you already cut. Every release you ship already emits structured signals — a version number, a git tag, a changelog entry — and each of those can both trigger a render and feed its script, with nobody editing anything by hand. That works only when the demo is a committed spec you can [regenerate instead of re-record](/blog/automated-product-demo-videos): a filmed take freezes at record time, but a storyboard re-runs against the current build. This is a distinct job from the drift-guarding [nightly re-render](/blog/nightly-demo-builds), which rebuilds the *current* demo to catch [media going stale](/blog/why-product-demos-go-stale). A release-notes video does the opposite: it captures *one specific release's* new thing and then stays frozen as the visual record of what v2.4 introduced. This piece is about which releases deserve that video, how to read the answer off the version number, and how to hang the render on the same tag your written changelog already uses.

## Read "does this earn a video" straight off the version number

The mistake that kills the practice is filming everything. Spawn a video for every patch tag and you drown; the signal-to-noise collapses and the archive becomes a landfill nobody scrubs. You do not need judgment for the filter, because the version number already carries it. Semantic Versioning defines the three bumps precisely: increment MAJOR "when you make incompatible API changes," MINOR "when you add functionality in a backward compatible manner," and PATCH "when you make backward compatible bug fixes" ([Semantic Versioning 2.0.0, accessed July 2026](https://semver.org/)).

Read those definitions as a video test and the answer writes itself. A PATCH is, by definition, a fix to existing behavior with no new surface for a user to see, so there is nothing to demonstrate. A MINOR adds functionality a user can now act on, which is exactly a demo's job. A MAJOR reshapes enough that it usually earns a longer cut or a small set of them.

| Release | SemVer meaning | New user-visible surface? | Earns a video? | The cut |
|---|---|---|---|---|
| PATCH (x.y.**Z**) | backward-compatible bug fixes | rarely | No — a changelog line | text only |
| MINOR (x.**Y**.0) | new functionality, backward compatible | yes, by definition | Yes | one focused 20-40s clip of the new thing |
| MAJOR (**X**.0.0) | incompatible API changes | usually large | Yes | a longer walkthrough or a short set of clips |

The filter is where sustainability lives, and the arithmetic makes the case. Take a healthy SemVer project that cuts about 24 tags a quarter: most are fixes, so say 18 patches, 5 minors, and 1 major. Gating on MINOR-and-up leaves 6 videos a quarter instead of 24. Six is a rhythm a CI job keeps forever without anyone noticing; twenty-four is the reason nobody makes the video at all.

## The changelog you already write is the script you don't

If you keep a changelog in the standard shape, each release already ships a structured entry sorted into six buckets: "`Added` for new features. `Changed` for changes in existing functionality. `Deprecated` for soon-to-be removed features. `Removed` for now removed features. `Fixed` for any bug fixes. `Security` in case of vulnerabilities" ([Keep a Changelog 1.1.0, accessed July 2026](https://keepachangelog.com/en/1.1.0/)). Those buckets are not just bookkeeping; they sort themselves cleanly into whether a line becomes a scene and how.

| Changelog section | What it is | In the video |
|---|---|---|
| Added | new features | the subject — show the new thing working |
| Changed | changes to existing behavior | a before/after, when the change is visible |
| Fixed | bug fixes | skip — text is the right medium |
| Deprecated / Removed | features going away | a caption or note, not a scene |
| Security | vulnerability fixes | text; almost never a demo |

The Added section, rewritten from "what we built" into "what you can now do," is the spine of the script. That reframing is not a stylistic flourish; it is the whole reason release notes get read. Keep a Changelog states its first principle bluntly — changelogs are "_for humans_, not machines" — and the release-notes craft literature says the same thing about video: "Lead with what the user can now do, not the technical implementation" ([Appcues, accessed July 2026](https://www.appcues.com/blog/release-notes-examples)). You are not authoring a new artifact from a blank page; you are giving the changelog's Added lines a voice and a screen.

One honest caveat separates this from the nightly drift-check. A drift render can skip the text-to-speech pass entirely when the narration text has not changed, but a release video's narration changes every release by definition — new feature, new words — so the voice step runs every time. In our own engine, aidemo, which is ours and honestly browser-only, whose storyboard a coding agent writes instead of a person nudging clips across a GUI timeline, that means a per-release render pays for the voice pass a nightly gets to skip. It is a real cost, and a small one against not filming the thing by hand.

## Wire it to the tag, not to a calendar reminder

The monthly recap slips because its trigger is a person's memory. A per-release video does not slip because its trigger is the release itself. GitHub fires a `release` event with activity types "published, unpublished, created, edited, deleted, prereleased, released," and you can just as well filter a `push` to the `tags` that match a version pattern ([GitHub Docs, accessed July 2026](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)). That is the same tag your written notes hang off — GitHub can even auto-fill the prose by clicking "Generate release notes" against it ([GitHub Docs, accessed July 2026](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)). Cut the release, and the render starts.

The SemVer filter from the first table becomes a one-line job guard, because a MINOR is `x.Y.0` and a MAJOR is `X.0.0` — both zero the patch field, so both end in `.0`, while a patch never does:

```yaml
on:
  release:
    types: [published]          # fires on the tag your changelog already uses
jobs:
  release-video:
    # x.Y.0 (minor) and X.0.0 (major) end in .0; a patch x.y.Z does not
    if: ${{ endsWith(github.event.release.tag_name, '.0') }}
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get update && sudo apt-get install -y ffmpeg
      - run: ./render-storyboard.sh        # your spec -> out/release-demo.mp4
      - run: gh release upload "$TAG" out/release-demo.mp4
        env:
          TAG: ${{ github.event.release.tag_name }}
          GH_TOKEN: ${{ github.token }}
```

The guard is a heuristic, not a proof: a hand-cut `v2.4.0` that is really an emergency patch would still trip it, and it does not tell a minor from a major if you want different-length cuts (check the middle and first fields for that). But for the common case it reads the triage decision off the tag string with no extra metadata. The runner-level details — that `ubuntu-latest` ships Chrome but not the encoder, which fonts non-Latin captions need, and where large files should land — are their own subject, covered in [rendering demo videos in CI](/blog/demo-videos-in-ci).

The last step is the one that makes this a changelog and not just a video. Uploading the MP4 as a release asset pins it to the tag, so v2.4.0's video lives with v2.4.0 permanently and a later ship never overwrites it — the same durability the written entry has, and the point of [pinning a demo to each shipped version](/blog/versioned-demos-per-release).

## A cadence you can keep without a standing meeting

Frequency, not polish, is what earns trust from release notes: "A short, consistent cadence builds more trust than irregular comprehensive releases" ([Appcues, accessed July 2026](https://www.appcues.com/blog/release-notes-examples)). The monthly recap fails exactly on that axis — it is the irregular, comprehensive, easy-to-skip option by construction. A per-qualifying-tag video is short and consistent because the release cadence, not a human's willpower, sets the beat. High-frequency written streams already prove the appetite: GitHub's own changelog posts several dated entries a day (github.blog/changelog, accessed July 2026), all text — the lesson is not "film every entry" but that a fast release stream already exists and the video should ride a filtered slice of it.

| Cadence model | Who triggers it | Videos / quarter (from the 24-tag example) | Human edit each | Skip risk |
|---|---|---|---|---|
| Monthly recap | a person, on a calendar | 3 | high — film, edit, voice | high, it's discretionary |
| Every tag | CI, on every release | ~24 | none | none, but noisy |
| Filtered (minor + major) | CI, gated on the tag | ~6 | none | none |

The filtered row is the one that survives contact with a real quarter: low enough volume that each clip is worth a watch, automatic enough that none gets dropped, and keyed to the version so the back-catalog doubles as a visual changelog. What goes *inside* each 20-to-40-second clip — the what-shipped, why-it-matters, one-click-to-try structure — is a format question owned by [the feature-announcement template](/blog/feature-announcement-video); this piece is only about the trigger and the filter that decide whether a clip gets made at all. The release already hands you a tag, a changelog entry, and a "what you can now do." The only thing worth engineering is which releases clear the bar, and the version number answers that for free.

## Sources

- [Semantic Versioning 2.0.0 — MAJOR / MINOR / PATCH definitions](https://semver.org/)
- [Keep a Changelog 1.1.0 — change categories and "for humans, not machines"](https://keepachangelog.com/en/1.1.0/)
- [Appcues — release notes examples, cadence, and using visuals](https://www.appcues.com/blog/release-notes-examples)
- [GitHub Docs — events that trigger workflows (release event, tag filters)](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [GitHub Docs — managing releases (create from a tag, generate notes, attach assets)](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [GitHub Changelog — a high-frequency written release stream](https://github.blog/changelog/)

## FAQ

### Which releases actually need a video, and which don't?

Read it off the SemVer bump. A PATCH is a backward-compatible bug fix with no new surface to show, so it belongs in a changelog line, not a video. A MINOR adds functionality a user can now act on and a MAJOR reshapes the product, so both earn a clip. Gating on minor-and-up typically turns something like 24 tags a quarter into about 6 videos — few enough to keep making, frequent enough to stay current.

### How do you generate a release-notes video automatically from a git tag?

Trigger a CI job on the `release` event (or a `push` filtered to version tags), gate it so only minor and major releases render — a one-line check like `endsWith(tag, '.0')` skips patches, since both minors and majors zero the patch field — then render your committed storyboard and upload the MP4 as a release asset. Because it hangs off the same tag your written changelog uses, cutting the release is the whole trigger.

### Are video release notes better than a written changelog?

They are complements, not substitutes. Written notes are searchable, linkable, and cheap for every release including patches; the standard changelog format exists precisely because notes are for humans scanning what changed. Video earns its cost only where the change is visual: a 15-second clip "communicates more than two paragraphs for any UI change" (Appcues), which is why the sustainable pattern is text for every release plus a short video for the minor and major ones that added something to see.
