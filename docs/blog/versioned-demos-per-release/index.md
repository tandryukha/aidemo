# Versioned demos: one demo per product release

July 18, 2026 · Demo Automation · 7 min read · https://aidemo.top/blog/versioned-demos-per-release/

> A nightly build keeps one demo current. Versioning does the opposite job: it lets v2.3's demo stay v2.3's forever, so nobody sees a feature they don't have.

**Key takeaways**

- A demo can be wrong in two directions: stale (behind the product) or ahead of the version a viewer runs. Nightly re-renders fix the first; versioning fixes the second.
- SemVer Item 3 says a released version's contents must not change. Apply it to demos: pin v2.3's cut to the tag and never overwrite it, so old versions keep their own demo.
- Key demos at major.minor, not per patch: a PATCH adds no visible surface, so v2.3.0's demo stays correct for all of v2.3.x. That collapses ~200 tags into ~15 demos.
- Storage is cheap: a 60s 1080p demo is ~40 MB, so 40 minor versions is ~1.6 GB as release assets (2 GiB/file limit); committing them into git bloats every clone forever.
- Serve two URL classes like versioned docs: an immutable /demo/v2.3.mp4 (cache a year) plus a moving /demo/latest.mp4 that the current docs embed.

## A demo can lie in two directions, not one

Everyone worries that a demo is *behind* the product: the button moved, the screen got redrawn, the flow gained a step. That is drift, and it is [what makes a demo rot the moment you ship past it](/blog/why-product-demos-go-stale). The cure is to keep one demo pinned to the tip of the tree — [regenerate it from a committed spec](/blog/automated-product-demo-videos) so shipping the change is the update, and let [a nightly re-render guard it](/blog/nightly-demo-builds) against the drift a code diff never shows.

There is a second way a demo can be wrong, and chasing the first one makes it worse. A demo can be *ahead* of the version the viewer is actually running. A customer on your self-hosted v2.3, an enterprise account pinned to last quarter's release, a reader following a tutorial written against v2 — each of them opens "the demo," sees a v3.0 workflow, and hunts for a button that does not exist in their build yet. Nightly re-rendering, the fix for staleness, aims the single canonical demo squarely at HEAD, which is exactly where those viewers are not. The more diligently you keep one demo current, the more wrong it is for everyone off the latest version.

Versioning answers the second failure, and it is a different discipline from keeping the current one fresh. The move is to stop treating the demo as one file that always shows the newest thing, and start treating it as a release artifact: v2.3's demo shows v2.3, v3.0's demo shows v3.0, and the two coexist instead of one silently overwriting the other. Old versions keep their old demo. That single rule is the whole idea, and the version number you already ship is what makes it mechanical.

## Borrow the rule SemVer already wrote for you

Semantic Versioning codified the principle in a clause most people skim past. Item 3: "Once a versioned package has been released, the contents of that version MUST NOT be modified. Any modifications MUST be released as a new version" ([Semantic Versioning 2.0.0, accessed July 2026](https://semver.org/)). A published version is frozen. You do not edit v2.3.1 in place; you ship v2.3.2.

A demo pinned to a release inherits that rule for free. Once v2.3 ships with its demo, that demo is v2.3's forever — you never re-render over it, the same way you never rewrite a tag. When v2.4 ships it gets *its own* demo, a new artifact at a new address, and v2.3's cut stays exactly where it was recorded. This is the opposite instinct from a nightly build, which overwrites yesterday's render on purpose, and it complements [rendering a fresh cut for each release](/blog/release-notes-videos): that piece decides which tags earn a brand-new video, this one insists the old videos never get clobbered when they do.

The freeze is only credible if you can prove the old demo still matches the old release. Because the storyboard is committed next to the code, checking out the v2.3 tag and rendering reproduces v2.3's demo from v2.3's spec — the same input, the same output, [byte-stable on purpose](/blog/reproducible-demo-renders). In our own engine, aidemo — ours, and honestly browser-only, with the storyboard written by a coding agent rather than dragged across a GUI timeline — the spec lives in the repo, so the demo for any past tag is regenerable from that tag alone, not from a video file someone hopefully archived to a drive.

## How coarse can the version key be?

Not every tag needs its own demo, and getting the granularity right is what keeps the practice from drowning you. A PATCH, by SemVer's own definition, is a backward-compatible fix with no new user-visible surface — which is precisely the surface a demo shows. So the demo you recorded for v2.3.0 is still honest for v2.3.7: nothing a viewer can see has changed. Key demos at `major.minor`, and let every patch in a line reuse its line's cut.

That collapses the numbers hard. A three-year-old project can carry two hundred–plus tags; the overwhelming majority are patches. Say it cut roughly 40 minor lines and 3 majors, and that only about half of those minors actually touched a screen a demo features. You are not keeping two hundred demos. You are keeping about 15 — one per visible-change line — and every patch tag simply points at its line's demo.

| Version change | New visible surface? | Its own demo? | A viewer on it watches |
|---|---|---|---|
| MAJOR (**X**.0.0) | usually, and large | Yes | its own cut |
| MINOR (x.**Y**.0), UI changed | yes | Yes | its own cut |
| MINOR, nothing visible moved | no | No | the previous line's cut |
| PATCH (x.y.**Z**) | no, by definition | No | its minor line's cut |

The granularity decision is the one that makes versioned demos sustainable rather than a second full-time job. Tie a demo to every tag and you are back to the release-a-week treadmill; tie it to every visible-change line and the count grows at the pace of redesigns, which is slow.

## The storage math for keeping every version around

The reflexive objection is that keeping every version means unbounded storage. Do the arithmetic and the objection evaporates. A 60-second 1080p screen-capture demo encodes small, because UI footage is low-motion and low-entropy: figure roughly 25–50 MB in H.264 at a 4–6 Mbps rate. Take 40 MB as a round working number.

| Retention policy | Versions kept | At ~40 MB each | Verdict |
|---|---|---|---|
| Every demoed line (~15) | 15 | ~600 MB | trivial |
| Every minor tag, visible or not (~40) | 40 | ~1.6 GB | fine as release assets |
| Rolling window, last 6 | 6 | ~240 MB | trivial |
| Majors only (~3) | 3 | ~120 MB | trivial |

Where the files live decides whether that number even matters. Attach each demo to its release and GitHub pins it to the tag — "Releases are based on Git tags," and each attached file must be "under 2 GiB" ([GitHub Docs, accessed July 2026](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)) — and it never enters your git history, so the clone stays small no matter how many versions you archive. Commit the same MP4s into the repository and every version you keep rides in every clone forever; that is the [commit-versus-LFS-versus-external decision](/blog/versioning-media-assets-in-git) in its own right.

Because disk is this cheap, the real ceiling is human, not storage. Docusaurus, whose docs-versioning is the closest neighbor to this whole idea, warns that "most of the time, you don't need versioning as it will just increase your build time," and that you "will very likely to have a lot of obsolete versioned documentation that nobody even reads anymore" ([Docusaurus, accessed July 2026](https://docusaurus.io/docs/versioning)). The same restraint applies to demos. Keep the majors and a rolling window of recent minors, let the deep back-catalog expire, and never spend a render on a version nobody still runs.

## Give each version a URL that never moves (and one that does)

Keeping the files is half the job. Getting the right one in front of the right viewer is the other half, and documentation tooling already solved it. Read the Docs "supports publishing multiple versions of your documentation," so "your users can read the exact documentation for the specific version of the project they are using," redirecting the bare URL to a default that is usually `latest` or `stable`, where stable tracks "your greatest stable semantic version number release" ([Read the Docs, accessed July 2026](https://docs.readthedocs.com/platform/en/stable/versions.html)). Docusaurus does the same with per-version routes: v1.0.0's pages sit under `/docs/1.0.0/` while the working copy lives under `/docs/next/` ([Docusaurus, accessed July 2026](https://docusaurus.io/docs/versioning)).

A versioned demo wants exactly that shape — two classes of URL that behave differently on purpose.

- An **immutable per-version address**, `/demo/v2.3.mp4`, that never changes once published. Because its content is frozen, you serve it with a year-long cache and never revalidate. MDN's rule for content that never changes is a "long `max-age` by using cache busting... including a version number, hash value, etc., in the request URL," served as `Cache-Control: max-age=31536000, immutable` ([MDN, accessed July 2026](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching)). The v2.3 docs page embeds this, and it can sit in every CDN edge until the heat death of the project.
- A **moving alias**, `/demo/latest.mp4` (or `stable`), that resolves to whichever version is current. The latest-docs page embeds the alias; because it moves, it gets a short `max-age` and revalidates. This is the one URL a nightly build is allowed to overwrite.

Wire the docs so a page built for version N embeds the immutable `/demo/vN.mp4` and the "latest" build embeds the alias. A reader on the v2.3 docs watches v2.3's demo; a reader on the current docs watches today's. Nobody is shown a feature they do not have, nobody has to remember which video went with which release, and the version identifier that already threads through the git tag, the changelog, and the release assets threads through the demo URL too. The demo stops being one file that always shows the newest thing and becomes what the release already is: a numbered, frozen, addressable artifact — one per version, each telling the truth about the version whose name it carries.

## Sources

- [Semantic Versioning 2.0.0 — released versions must not be modified (Item 3)](https://semver.org/)
- [Read the Docs — hosting multiple documentation versions, default/latest/stable](https://docs.readthedocs.com/platform/en/stable/versions.html)
- [Docusaurus — documentation versioning and its maintenance cost](https://docusaurus.io/docs/versioning)
- [GitHub Docs — about releases (based on Git tags, 2 GiB asset limit)](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [MDN — HTTP caching, immutable content and versioned URLs](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching)

## FAQ

### Do I need a separate demo for every patch release?

No. By Semantic Versioning's definition a PATCH is a backward-compatible bug fix with no new user-visible surface, so the demo you recorded for v2.3.0 is still accurate for v2.3.7 — nothing a viewer can see has changed. Key your demos at `major.minor` and let every patch in a line reuse that line's cut. That turns a project with two hundred tags into roughly a dozen demos, one per line that actually changed a screen.

### How many old demo versions should I keep?

Keep the majors and a rolling window of the most recent minors; let the deep back-catalog expire. Storage is not the constraint — a 60-second 1080p demo is about 40 MB, so even 40 versions is under 1.6 GB, and attached as release assets they never touch your git history. The real limit is the one Docusaurus names for versioned docs: obsolete versions nobody reads still cost attention, so do not archive a demo for a release no customer still runs.

### How does a viewer end up watching the demo for their version?

Borrow the versioned-docs pattern. Publish each demo at an immutable per-version URL like `/demo/v2.3.mp4`, cached for a year because its content is frozen, and have the docs page built for v2.3 embed that exact URL. Add one moving alias, `/demo/latest.mp4`, that points at the current release and gets a short cache, which the latest-docs build embeds. A reader on old docs sees the old demo; a reader on current docs sees today's — routed by the same version number the tag already carries.
