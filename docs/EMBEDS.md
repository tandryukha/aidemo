# Always-fresh embeds at zero cost

Your README demo video updates itself. Competitors that market "updates your
demo everywhere it's used" (Trainn) still need a human to re-record the clip;
aidemo re-renders from `storyboard.json` in CI, and the embed URL never changes.
The hosting story is **GitHub itself** — no paid CDN, no video host.

## The convention

CI publishes rendered media to a dedicated **orphan branch `demo-media`** in the
consuming repo, at stable paths:

```
media/<demo>/latest.mp4
media/<demo>/latest.gif
media/<demo>/stills/<name>.png   # e.g. stills/poster.png
```

The branch is **force-reset to a single commit on each publish**, so history
never accumulates and the repo stays small. Media for other demos already on the
branch is preserved (the publish step merges the tree, then re-commits it as one
fresh orphan commit).

## Stable URLs

`raw.githubusercontent.com` serves any file on any branch at a fixed URL:

| Asset | URL |
|---|---|
| GIF   | `https://raw.githubusercontent.com/<owner>/<repo>/demo-media/media/<demo>/latest.gif` |
| Still | `https://raw.githubusercontent.com/<owner>/<repo>/demo-media/media/<demo>/stills/poster.png` |
| MP4   | `https://raw.githubusercontent.com/<owner>/<repo>/demo-media/media/<demo>/latest.mp4` |

Generate the exact snippets for your repo (no network, no render):

```bash
npx -y github:tandryukha/aidemo#stable embed demos/<demo>
# or, for agents:
npx -y github:tandryukha/aidemo#stable embed demos/<demo> --json
```

`embed` reads owner/repo from your repo's `origin` remote and the demo name from
the directory basename. `--repo <dir>` overrides which repo to detect from;
`--still <name>` picks a different still basename.

## Where each form works

### README / issues / PR comments → GIF

GitHub renders GIFs inline and autoplays them. Use the Markdown GIF embed:

```markdown
![<demo> demo](https://raw.githubusercontent.com/<owner>/<repo>/demo-media/media/<demo>/latest.gif)
```

A raw `.gif` is served as `Content-Type: image/gif` (verified), so it renders
everywhere Markdown images do. A still image works the same way with `image/png`.

> GitHub's Markdown sanitizer does **not** render `<video>` tags with an
> arbitrary `src` in READMEs — only the GIF/still image forms embed there. Use
> the `<video>` form on docs sites and blogs (below).

### Docs sites / blogs → HTML `<video>`

```html
<video controls muted loop playsinline width="960"
       poster="https://raw.githubusercontent.com/<owner>/<repo>/demo-media/media/<demo>/stills/poster.png">
  <source src="https://<owner>.github.io/<repo>/media/<demo>/latest.mp4" type="video/mp4" />
  <a href="https://raw.githubusercontent.com/<owner>/<repo>/demo-media/media/<demo>/latest.gif">▶ Watch the demo</a>
</video>
```

**Why the Pages URL for the `<source>`, not raw?** `raw.githubusercontent.com`
serves `.mp4` as **`Content-Type: application/octet-stream`** with
`X-Content-Type-Options: nosniff` (verified with `curl -I`). Browsers won't
reliably play an octet-stream in a `<video>`; many just download it. GitHub
**Pages** serves `.mp4` with the correct `video/mp4` MIME, so inline playback
works. Enable Pages on the `demo-media` branch (Settings → Pages → Branch:
`demo-media`, folder `/`) and the video plays; the `poster` still and the GIF
fallback link keep working from raw meanwhile.

The poster attribute uses a raw PNG (`image/png`) — that's fine; only the video
stream needs the Pages MIME.

## Cache caveat — how fresh is "fresh"?

Two caches sit in front of these URLs. Know both before you promise instant
updates:

- **`raw.githubusercontent.com` (Fastly):** responds with
  `Cache-Control: max-age=300` (verified) — a **~5-minute** edge cache. A direct
  hit to the raw URL reflects a new render within minutes.
- **Camo (`camo.githubusercontent.com`) for rendered Markdown:** GitHub proxies
  every image embedded in a README / issue / comment through its **Camo** image
  proxy for privacy. Camo caches aggressively and only re-fetches the origin
  periodically, so a **README GIF can lag the latest render by much longer**
  (minutes to hours, not guaranteed). This is inherent to GitHub image proxying,
  not something the repo controls.

**Cache-busting knob.** Append a version query to force a fresh fetch:

```markdown
![demo](https://raw.githubusercontent.com/<owner>/<repo>/demo-media/media/<demo>/latest.gif?v=8)
```

Camo keys its cache on the full URL including the query string, so bumping `?v=`
(or using a short git SHA / date) makes GitHub treat it as a new image and
re-proxy immediately. **Tradeoff:** the URL is then no longer truly stable — you
have to edit the README to bump it, which defeats "updates itself." Pick one:

- **Omit `?v=`** (recommended) for a genuinely self-updating embed that lags by
  the proxy cache. Best for a README hero you never want to touch again.
- **Bump `?v=`** only when you need the new render visible *now* and are willing
  to commit a one-character README change.

For docs-site `<video>` served from Pages, the Pages CDN has its own short cache;
a `?v=` on the `<source>` src works the same way there.

## The publish workflow

Copy [`examples/workflows/demo-publish.yml`](https://github.com/tandryukha/aidemo/blob/stable/examples/workflows/demo-publish.yml)
into your repo at `.github/workflows/demo-publish.yml`. It:

1. renders the demo with the aidemo composite action (`uses: tandryukha/aidemo@stable`),
   using the **local TTS provider + offline captions** — zero key, zero spend;
2. copies `output/final-demo.{mp4,gif}` to the stable layout and extracts a
   `stills/poster.png` with ffmpeg (preinstalled on the runner);
3. force-pushes a **single-commit** `demo-media` branch via git plumbing
   (`write-tree` / `commit-tree` / `push --force`) — no third-party actions
   beyond a SHA-pinned `actions/checkout`, and only `permissions: contents: write`.

It triggers on pushes that touch `demos/**` (and on manual dispatch), so **every
storyboard change re-renders the video and refreshes the embed** — the whole
loop is zero-touch. When your product UI changes, edit the storyboard; CI does
the rest.

> To serve MP4 `<video>` embeds, additionally enable GitHub Pages on the
> `demo-media` branch (one-time, in repo Settings). GIF/still embeds need
> nothing beyond the branch.
