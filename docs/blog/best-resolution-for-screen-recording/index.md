# Best resolution for screen recording: match delivery, not your monitor

July 18, 2026 · Screen Recording · 7 min read · https://aidemo.top/blog/best-resolution-for-screen-recording/

> Your monitor is not the resolution to record at. A source-to-delivery table, the bitrate math, and why a 4K capture can make 1080p text worse.

**Key takeaways**

- Pick delivery resolution from where the video plays; capture 2x that on a DPR-2 display so the downscale supersamples four pixels into one and text stays crisp.
- A 4K master for a 1080p embed runs ~3x the bytes (Vimeo recommends 30-60 Mbps at 4K vs 10-20 Mbps at 1080p) and a hosting platform re-encodes to its own bitrate anyway.
- Capturing the full 4K desktop then downscaling to 1080p halves each glyph's pixels and softens small text; capture a DPR-2 window sized to the delivery target instead.
- Downscale with lanczos, not ffmpeg's default bicubic or a fast-bilinear fallback, or the sharpness you paid for at capture leaks back out.
- Capture true 4K only when you deliver 4K or need zoom headroom to punch into the frame in the edit; otherwise it is pure waste.

## Delivery size is the number; the monitor is a distraction

Open a screen recorder and the resolution it offers is whatever your display can do: 1920x1080 on a plain panel, 2560x1440 on a nicer one, 3840x2160 on a 4K monitor, more still on a 5K iMac. Every one of those is the wrong place to start. The resolution that matters is the one the finished video plays at, and that is set by where the video lives, not by the glass in front of you. A README clip renders in a column a few hundred pixels wide. A landing-page hero sits at 1080p inside a card. A YouTube walkthrough is capped by the viewer's window, not by how big your upload was. Pick that number first and work backward to a capture that feeds it, because recording at your monitor's native resolution and hoping the export sorts it out is how you end up with a 300 MB file of soft text.

This is the resolution layer of [the full capture-settings checklist](/blog/how-to-record-your-screen-in-high-quality), and it shares one rule with [the frame-rate layer](/blog/best-frame-rate-for-screen-recording): capture is a decision you make once and cannot take back, so spend pixels where they land and nowhere else.

## Capture at twice the delivery size, then let the shrink sharpen

There is one honest reason to record larger than you deliver, and it is why "just record at 1080p" produces mush on a modern laptop. Screens are high-density. MDN puts a device-pixel-ratio of 1 at a classic 96-DPI display and a ratio of 2 at a HiDPI or Retina panel, defining it as "the ratio of the resolution in physical pixels to the resolution in CSS pixels" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)). On a DPR-2 display, a browser window sized to 960x540 CSS pixels is actually painted across 1920x1080 physical pixels. A recorder that grabs those physical pixels hands you a native, crisp 1080p frame with text drawn at double density. The deeper mechanics of why grabbing the logical layer instead softens everything belong to the checklist above; here it just sets up the pairing.

When the capture is larger than the delivery target, the shrink does extra work for free. Downscaling averages each block of captured pixels into one delivered pixel, a supersample that smooths the edges that would otherwise alias, so text arrives sharper than the panel showed it. Capture at exactly your delivery size and you skip that pass; capture at twice it and you bank it.

## A source-to-delivery table you can record straight from

Once the delivery target is fixed, the pairing is mechanical. Capture the physical pixels of a window sized so the content you want to show fills a frame at your delivery resolution, or twice it when you want the free supersample.

| Where it plays | Deliver at | Capture (the source) | Downscale? |
|---|---|---|---|
| README clip, docs microvideo, email GIF | 720p | 1280x720 physical (DPR-2 render of a 640x360 layout) | no |
| Landing hero, embedded demo, sales send | 1080p | 1920x1080 physical (DPR-2 render of a 960x540 layout) | no |
| YouTube or Vimeo, plus room to zoom in the edit | 1080p | 3840x2160 full HiDPI grid, scaled down to 1080p | yes, 4 into 1 |
| You genuinely ship 4K | 2160p | 3840x2160 physical (native 4K panel at DPR 2) | no |

The row most guides get wrong is the third. Capturing 4K for a 1080p deliverable is worth it in exactly one case: you know you will punch into the frame while editing and need the extra pixels to survive [a zoom that would otherwise soften](/blog/professional-screen-recordings). Absent that, rows one and two already give crisp text at the delivery size with no downscale to tune and no bits to waste. And notice what the capture column controls that the delivery column does not: how much of the UI sits in the frame. Fit less content into a smaller CSS window and every glyph is drawn with more pixels, which is why a slightly zoomed demo reads better than a full desktop shrunk to fit.

## The bits you pay to record bigger than you ship

The waste in over-capturing is not abstract; it has a bitrate and a byte count. Vimeo publishes the bitrate it recommends at each resolution, and the ladder climbs fast: 5 to 10 Mbps for 720p, 10 to 20 Mbps for 1080p, 20 to 30 Mbps for 2K, and 30 to 60 Mbps for 4K ([Vimeo](https://help.vimeo.com/hc/en-us/articles/12426043233169-Video-and-audio-compression-guidelines)). Turn those into file sizes for a 60-second demo with the only formula you need, size in megabytes equals bitrate in megabits times seconds divided by eight:

| Delivery resolution | Recommended bitrate | ~Size, 60-second clip | vs 1080p |
|---|---|---|---|
| 720p (1280x720) | 5-10 Mbps | ~55 MB | ~0.5x |
| 1080p (1920x1080) | 10-20 Mbps | ~110 MB | 1x |
| 1440p / 2K (2560x1440) | 20-30 Mbps | ~190 MB | ~1.7x |
| 2160p / 4K (3840x2160) | 30-60 Mbps | ~340 MB | ~3x |

A 4K master of a video that will play at 1080p runs roughly three times the bytes of the 1080p version, and if the destination is a hosting platform, it transcodes your upload down to its own per-resolution bitrate on the way in, so the surplus never reaches a viewer. You paid the upload, the storage, and the longer encode for pixels the delivery discards. Where the file is self-hosted, a mostly-static UI compresses well below these figures, but the ratio between resolutions holds. The codec and container that carry the bits are [a separate decision](/blog/best-video-format-for-screen-recording), and no codec makes 4K cheaper than 1080p for the same footage.

## How a 4K capture can make 1080p text worse, not better

Wasting bits is the forgivable half. The surprising half is that a 4K capture can deliver softer 1080p than a 1080p capture does, and the cause is content density, not the shrink itself. Record the whole 4K desktop and you are fitting four times the screen area into the frame. Downscale that to 1080p and every element, text included, lands at roughly half its original linear pixel count. A 14-pixel label that was legible on the 4K grid is drawn with about seven vertical pixels after the shrink, under the floor where fine strokes stay distinct, so it goes fuzzy. Capture a DPR-2 window sized to the delivery target instead and that same label keeps its full pixel budget. TechSmith names the same trap from the recorder's side, warning that footage "becomes blurry when you zoom in or scale footage larger than what you originally recorded at" ([TechSmith](https://www.techsmith.com/blog/video-blurry-techsmith-tips/)); the mirror image is shrinking so much content into so few pixels that the text can no longer resolve.

## The downscale filter decides whether the sharpness survives

Supersampling only pays off if the shrink uses a filter built for it, and the default often is not. FFmpeg's scaler offers a menu of algorithms, from fast_bilinear and bilinear through bicubic to lanczos and spline, with a documented default of bicubic ([FFmpeg](https://ffmpeg.org/ffmpeg-scaler.html)). Bicubic is acceptable; the fast bilinear that some pipelines fall back to for speed is not, and it is where the crispness you captured leaks back out as a soft, faintly smeared downscale. For shrinking UI text, name lanczos explicitly: its sharper kernel preserves the high-frequency edges that make small type readable, for a little more CPU and nothing else.

```sh
ffmpeg -i take.mov -vf "scale=1920:1080:flags=lanczos" -crf 18 out.mp4
```

Set the target dimensions, name the filter, and encode to a quality target rather than a fixed bitrate so the still stretches of the demo do not overspend. That one flag is the difference between a downscale that antialiases and one that just blurs.

## Recording for a target you cannot see yet

The delivery resolution is easy to pin when you can eyeball the export. It gets harder when the demo is regenerated on a schedule, on a server with no monitor at all, where "whatever my display can do" is not even a value. That is the case that forces the discipline this whole page argues for: the capture resolution, the device pixel ratio, and the downscale target become fixed inputs rather than a menu someone picks under deadline, and [the same run produces the same frame every time](/blog/deterministic-browser-automation-for-video).

Our own engine, aidemo, works this way: the viewport size and DPR live in a storyboard, so a demo re-renders at the identical resolution whether it runs on a laptop or a headless CI box, and the downscale to the delivery target is part of the spec, not a hand-tuned export. The honest limits are worth stating. It reaches into a browser and nowhere else, so a native desktop app is out of scope; the take is written as a storyboard by a coding agent, not laid out by hand on a GUI timeline; and for a one-off clip you will never regenerate, a point-and-click recorder is faster to reach for. What it buys is the thing a hand-recorded 4K file cannot promise: the resolution you chose on purpose, reproduced next quarter without a reshoot.

## Sources

- [Vimeo — Video and audio compression guidelines (bitrate by resolution)](https://help.vimeo.com/hc/en-us/articles/12426043233169-Video-and-audio-compression-guidelines)
- [MDN — Window.devicePixelRatio](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)
- [TechSmith — How to fix a blurry video](https://www.techsmith.com/blog/video-blurry-techsmith-tips/)
- [FFmpeg — Scaler options (sws_flags algorithms, default bicubic)](https://ffmpeg.org/ffmpeg-scaler.html)

## FAQ

### What resolution should I record my screen at?

Record at whatever resolution feeds your delivery target, not the maximum your monitor offers. If the video will play at 1080p, capture the physical pixels of a DPR-2 window sized to a 960x540 layout, which lands as a crisp native 1920x1080 with text drawn at double density. Go higher only when you actually deliver higher, or when you need extra pixels to survive a zoom in the edit.

### Is recording in 4K worth it for a demo video?

Rarely. Unless you will deliver in 4K or plan to punch deep into the frame while editing, a 4K capture of a video that plays at 1080p costs about three times the bytes (recommended bitrates run 30 to 60 Mbps at 4K versus 10 to 20 Mbps at 1080p) for pixels the delivery discards. Worse, shrinking a full 4K desktop down to 1080p can soften small text, because each glyph loses roughly half its linear pixels.

### Why is my screen recording still blurry after downscaling to 1080p?

Two causes dominate. Either the downscale used a fast, soft filter (ffmpeg defaults to bicubic, and some pipelines fall back to fast bilinear) when lanczos would have held the edges, or you shrank too much content into the frame so the text dropped below the pixels it needs to resolve. Fix the first with an explicit lanczos flag; fix the second by capturing a window sized to the delivery target rather than the whole high-resolution desktop.
