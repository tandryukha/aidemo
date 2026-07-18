# README GIFs that update themselves

July 18, 2026 · Demo Automation · 8 min read · https://aidemo.top/blog/readme-gifs-that-update-themselves/

> A 20-second demo GIF can weigh 18 MB, past GitHub's 10 MB ceiling. The format rules, the real size math, and a recapture loop that keeps it honest.

**Key takeaways**

- A committed GIF is the only motion GitHub is documented to autoplay inline in a README; a <video> pointing at a repo file won't play, and the drag-drop attachment URL can't be scripted.
- GitHub caps README images and GIFs at 10 MB. The same 20s scroll demo at 800px/15fps is 17.8 MB as a GIF, 2.7 MB as WebP, 0.45 MB as MP4 — GIF has no inter-frame compression.
- To fit a GIF under 10 MB, cut width, then framerate, then length: 480px at 10 fps takes the 17.8 MB baseline to 6.7 MB. Encode with ffmpeg two-pass palettegen/paletteuse.
- README images are proxied and cached by GitHub's Camo; commit the GIF at a fixed path so a re-render overwrites in place, and rely on short cache headers or a manual purge.
- Keep the GIF honest by recapturing from a script on every change: a vhs .tape for terminal tools, browser replay for web UIs, driven from CI.

## The only inline motion GitHub autoplays is a committed GIF

A README is the one page every visitor to a repository loads, and an animated demo is the fastest way to answer "what does this actually do" before anyone reads a line of code. The trouble is that GitHub's rules for what plays inside that page are narrow, scattered across three docs pages, and mostly learned by breaking them. Get them wrong and the demo either doesn't render, doesn't move, or quietly blows a size limit and fails to upload.

Start with the formats. A GIF committed into the repository and referenced with `![](path)` or an `<img>` tag renders inline, autoplays, and loops with no controls, no pause button, and no audio. The looping is baked into the file at encode time, not driven by markup ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types)). That autoplay-and-loop behavior is exactly what a short feature loop wants, and exactly what you cannot get from a `<video>`. GitHub does not play a `<video>` element that points at a file committed to the repo. A `raw.githubusercontent.com/...mp4` link renders as a broken player, not a video ([GitHub Community, 2026](https://github.com/orgs/community/discussions/19403)).

There is a video path, and it is a trap for automation. Drag an MP4 into an issue, a pull request, or the web README editor and GitHub uploads it to a `github.com/user-attachments/assets/<uuid>` address, then renders a real player with controls and sound. The catch is that the UUID is minted only by that manual drag-and-drop; no API generates it, so a README that rebuilds itself in CI can never produce one ([GitHub Community, 2026](https://github.com/orgs/community/discussions/19403)). WebP is the newest wrinkle: GitHub added inline WebP rendering on August 28, 2025, promising that uploaded WebP images "will now display inline, just like PNGs and JPEGs" ([GitHub Changelog, 2025](https://github.blog/changelog/2025-08-28-added-support-for-webp-images/)). Notice the comparison is to two static formats, and the note says nothing about animation. Until GitHub documents animated-WebP playback on a repo page, the only format it is on record as animating inline is the GIF.

## GIF, MP4, and WebP for the same twenty seconds

GitHub caps an attached image or GIF at 10 MB, and a video at 10 MB on a free plan or 100 MB on a paid one; the supported video types are `.mp4`, `.mov`, and `.webm` ([GitHub Docs, 2026](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)). That 10 MB GIF ceiling decides your whole encode, because GIF is spectacularly wasteful.

Here is the same twenty-second demo, a dashboard scrolling a long list, encoded from one 800x450 H.264 master to each delivery format. The scroll is the worst case for GIF, because the entire frame changes on every frame.

| Format | Settings | Size |
|---|---|---|
| MP4 (H.264) | 800px, 30 fps | 0.45 MB |
| Animated WebP (lossy) | 800px, 15 fps | 2.7 MB |
| GIF | 800px, 15 fps | 17.8 MB |
| GIF | 600px, 15 fps | 14.3 MB |
| GIF | 480px, 15 fps | 10.1 MB |
| GIF | 800px, 10 fps | 12.2 MB |
| GIF | 480px, 10 fps | 6.7 MB |

The MP4 is roughly forty times smaller than the GIF, and the WebP about six times smaller, from identical pixels. The reason is structural, not tuning. A GIF frame is an 8-bit indexed image, at most 256 colors at one byte per pixel, and the format has no motion compensation between frames, only a crude same-pixel transparency trick. At 800x450 that is 360 KB per raw frame; a 15 fps, 20-second clip is 300 frames, about 108 MB uncompressed. GIF's LZW plus frame optimization squeezed that to 17.8 MB, a factor of roughly six. H.264 and WebP predict each frame from the previous one, so the same motion costs a fraction. The 800px, 15 fps GIF is 1.8x over GitHub's ceiling before you add a single extra second.

That table is a scroll-heavy worst case; a click-through demo that holds still between actions compresses far better, because GIF's frame disposal can skip the unchanged pixels. But the ranking never inverts: for a given clip, MP4 beats WebP beats GIF, every time. WebP is the smart pick for a docs site or landing page you control, where you can serve it with the headers you want; for the GitHub README itself, the GIF is still the format with guaranteed inline motion.

## Encoding a GIF that doesn't look like 2009

The default GIF path in ffmpeg maps every frame onto one generic 256-color palette, which bands gradients and muddies text. The fix, from the ffmpeg filter's own author, is a two-pass build: analyze the clip and generate a palette tuned to its actual colors with `palettegen`, then apply that palette with `paletteuse` ([Boesch, 2024](https://blog.pkh.me/p/21-high-quality-gif-with-ffmpeg.html)). `palettegen` builds a histogram across all frames and picks colors with a variant of Heckbert's 1982 quantization; `paletteuse` maps each pixel to the nearest palette entry, with optional dithering ([FFmpeg, 2026](https://ffmpeg.org/ffmpeg-filters.html)).

```sh
  # 1) build a palette tuned to this specific clip
ffmpeg -i master.mp4 \
  -vf "fps=15,scale=800:-1:flags=lanczos,palettegen=stats_mode=diff" palette.png

  # 2) apply it (bayer = smaller/compressible; floyd_steinberg = prettier gradients)
ffmpeg -i master.mp4 -i palette.png \
  -lavfi "fps=15,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:diff_mode=rectangle" \
  demo.gif
```

Two knobs earn their place. Scale with `flags=lanczos`, not the default bilinear, or the edges blur. And choose the dither on purpose: error-diffusion modes like `floyd_steinberg` and `sierra2` look best on gradients but, as the filter author puts it, "completely kill the compression of GIF," while ordered `bayer` dithering is uglier on smooth ramps yet far more compressible, because its pattern is static and LZW rewards repetition ([Boesch, 2024](https://blog.pkh.me/p/21-high-quality-gif-with-ffmpeg.html)). For UI footage that is mostly flat color, bayer is usually the right trade.

When the GIF still won't fit, the levers are width, framerate, length, and colors, roughly in that order of impact against the 17.8 MB baseline above.

| Lever | Change | Result |
|---|---|---|
| Width | 800 to 480px | 10.1 MB |
| Framerate | 15 to 10 fps | 12.2 MB |
| Length | 20s to 10s | 9.0 MB |
| Width + framerate | 480px, 10 fps | 6.7 MB |

Combining two levers, say 480px at 10 fps, or 15 fps for 10 seconds, clears 10 MB with room to spare. Dropping `max_colors` below 256 in `palettegen` is the last resort: it shrinks the file but posterizes anything with a gradient.

## Camo, caching, and the GIF that shows yesterday's UI

Every image in a README is served through GitHub's Camo proxy, which rewrites the source into an anonymized `*.githubusercontent.com` URL that "hides your browser details and related information from other users" ([GitHub Docs, 2026](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls)). For a self-updating GIF this is mostly a gift. Commit `demo.gif` at a fixed path and the raw URL never changes, so a re-render overwrites the file in place and every embed picks it up with no README edit at all. The proxy also caches, which is the catch: push a new GIF and viewers can keep seeing the old one until the cache turns over. GitHub's own guidance is to have the origin return a `Cache-Control` of `no-cache` for images that change, and it exposes a manual cache reset for the stubborn cases ([GitHub Docs, 2026](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls)). Files committed to the repo already send short-lived cache headers, so overwriting the tracked GIF is usually enough and the purge is a break-glass tool.

## Keep the GIF honest: recapture on every change

A GIF is a photograph of the product at one instant, and the product moves. The only way it stays true is to regenerate it from a script whenever the thing it depicts changes, the same discipline behind [regenerating a demo from a committed spec instead of re-recording it](/blog/automated-product-demo-videos), applied to the asset with the most eyes on it. Because [product media rots the moment the UI ships past it](/blog/why-product-demos-go-stale), the recapture has to be automatic, not a line on someone's to-do list.

For terminal tools the pattern is settled. vhs turns a committed `.tape` script into a GIF by replaying it in a headless terminal, needing only `ttyd` and `ffmpeg` on the PATH ([Charmbracelet, 2026](https://github.com/charmbracelet/vhs)). The tape is the source of truth; edit the CLI, replay the same tape, and the GIF regenerates.

```
  # demo.tape, committed next to the CLI
Output demo.gif
Set Width 1200
Set Height 600
Set FontSize 22
Type "mytool build ./app" Enter
Sleep 3s
```

For web UIs the equivalent is a browser-replay engine that drives real Chrome through a scripted flow and emits a GIF. Our engine, aidemo, does this with a `gif` command that renders the README GIF from the same storyboard it uses for the full video. It is browser-only, the storyboard comes from a coding agent instead of a drag-and-drop timeline, and there is no click-to-edit UI, so it fits a demo you intend to keep current rather than a one-off sizzle reel.

```sh
  # browser replay: same storyboard, README-sized GIF
aidemo gif ./demos/dashboard --width 800 --fps 12
```

Either way the loop is the same shape, and the plumbing, which trigger fires the render, what the runner needs installed, and the guard that stops a commit-back job from triggering itself, is a solved problem covered in [the walkthrough for rendering demos in a GitHub Actions job](/blog/demo-videos-in-ci). The craft of the underlying demo, what to show, how long, how to pace it, is [its own discipline](/blog/how-to-make-a-product-demo-video). What the README owns is the last mile: a committed GIF, encoded under 10 MB, at a stable path a machine overwrites on every change, so the loop on the front page never lies about the product behind it.

## Sources

- [MDN Web Docs — Image file type and format guide (WebP animation, GIF)](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types)
- [GitHub Community — README.md videos not working (video vs GIF in READMEs)](https://github.com/orgs/community/discussions/19403)
- [GitHub Changelog — Added support for WebP images (Aug 28, 2025)](https://github.blog/changelog/2025-08-28-added-support-for-webp-images/)
- [GitHub Docs — Attaching files (10 MB image/GIF and video limits, formats)](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)
- [GitHub Docs — About anonymized URLs (the Camo image proxy and caching)](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls)
- [Clement Boesch — High quality GIF with FFmpeg (palettegen/paletteuse)](https://blog.pkh.me/p/21-high-quality-gif-with-ffmpeg.html)
- [FFmpeg — filters documentation (palettegen, paletteuse, dither modes)](https://ffmpeg.org/ffmpeg-filters.html)
- [charmbracelet/vhs — write terminal GIFs from a .tape file](https://github.com/charmbracelet/vhs)

## FAQ

### Why is my README GIF too big to upload to GitHub?

GitHub caps an attached image or GIF at 10 MB, and GIF is a poor fit for motion: it stores 8-bit frames with no compression between them, so a 20-second scrolling demo at 800px and 15 fps encodes to roughly 18 MB, nearly twice the limit. Cut the width first, then the framerate, then the length: 480px at 10 fps takes that same clip to about 6.7 MB. Encode with ffmpeg's two-pass palettegen/paletteuse so shrinking it does not wreck the color.

### Can I embed a real video in a GitHub README instead of a GIF?

Not from a file you commit. A `<video>` tag pointing at a `raw.githubusercontent.com` MP4 renders as a broken player. GitHub only plays video that you upload by dragging it into an issue, pull request, or the web editor, which mints a one-off `user-attachments` URL that no API can generate, so it cannot be produced by a CI job. For a README that regenerates itself, an animated GIF is the only inline motion GitHub is documented to autoplay; keep the MP4 for pages you host yourself.

### Why does my updated README GIF still show the old version?

GitHub serves README images through its Camo proxy, which caches them, so a freshly pushed GIF can lag behind the file in the repo. If you commit the GIF at a fixed path the raw URL is stable and normally updates within minutes because committed files carry short cache lifetimes. When it sticks, the fix GitHub documents is to have the image origin send `Cache-Control: no-cache` and, as a last resort, to purge the Camo cache for that URL manually.
