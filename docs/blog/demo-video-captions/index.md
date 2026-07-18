# Captions on demo videos: the accessibility case and the numbers

July 18, 2026 · Product Demo Videos · 9 min read · https://aidemo.top/blog/demo-video-captions/

> Most demo views start muted, so the caption is the demo, not the soundtrack: the timing, the formats, and the WCAG rule that decide whether the words land.

**Key takeaways**

- Most first views are muted: 69% of consumers watch video with sound off in public (Verizon Media/Publicis, 5,616 US adults, 2019), so on-screen text carries the demo.
- WCAG 2.2 SC 1.2.2 makes captions Level A for all prerecorded audio in synchronized media, and captions (unlike subtitles) must carry non-speech sound and speaker ID.
- Word-level beats a full-sentence block: OpenAI Whisper has emitted per-word timestamps since v20230306, letting each word highlight as it is spoken.
- Closed captions (a VTT/SRT sidecar) only reach viewers on a player with a CC toggle; for muted autoplay, README embeds, and social reshares, burn them in.
- Portable pipelines rasterize captions to timed PNG overlays because FFmpeg subtitles needs a libass build (--enable-libass) that many distributions omit.

## The first view is muted, so the caption is the demo

A demo on a landing page, in a feed, or looping under a README plays before anyone chose to listen, and it plays with the sound off. Verizon Media and Publicis Media, in an online survey of 5,616 US consumers in 2019, found that 69% watch video with sound off in public places, that 80% are more likely to finish a video when captions are available, and that half say captions matter to them specifically because they watch muted ([Forbes, 2019](https://www.forbes.com/sites/tjmccue/2019/07/31/verizon-media-says-69-percent-of-consumers-watching-video-with-sound-off/)). For most first views the narration you wrote is decoration, and the words on screen are the pitch.

That moves captions from an accessibility checkbox to the primary text track, and it changes when you make them. Captions are not something you bolt onto a finished file; they are the same script the voice reads, timed to the picture. [How long a demo should run is decided by where it lives](/blog/how-long-should-a-demo-video-be), and so is how much the captions carry: a muted hero loop leans on them entirely, a sound-on onboarding walkthrough less so. Because the caption text is the narration text, [the script you write is the caption you ship](/blog/demo-video-script-template), and the [end-to-end playbook](/blog/how-to-make-a-product-demo-video) treats both as outputs of one source instead of two transcription passes.

## What WCAG asks for, stated precisely

"Add captions" is vaguer than the standard. WCAG 2.2 Success Criterion 1.2.2, Captions (Prerecorded), sits at Level A, the base tier every conforming page must meet, and reads in full: "Captions are provided for all prerecorded audio content in synchronized media, except when the media is a media alternative for text and is clearly labeled as such" ([W3C, 2023](https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html)). Two clauses decide whether a demo is covered. "Synchronized media" means audio tied to video, so a voiced screen recording qualifies and a silent GIF with no audio track does not. The exception is narrow: it releases only media that is itself an alternative to text already present on the page, which a marketing or product demo never is.

The standard is also specific about what a caption contains. WCAG defines captions as a synchronized alternative for "both speech and non-speech" audio, covering sound effects, music, and speaker identification, and it names the beneficiaries as people who are deaf or hard of hearing ([W3C, WCAG 2.2](https://www.w3.org/TR/WCAG22/)). That is the working difference between captions and subtitles: subtitles assume you can hear and only render the words, while captions assume you cannot and carry everything the audio track conveys. In some regions the two terms are used interchangeably, which is why the distinction has to come from what the file contains, not what it is called. One more boundary is worth knowing so you do not over-scope: live captioning is a separate and stricter criterion, SC 1.2.4 at Level AA, that a prerecorded demo does not trigger.

## Word-level timing versus a block on screen

There are two ways to put narration on screen, and a muted viewer can tell them apart. Block timing drops a full sentence at its start and holds it until the next one. Word-level timing carries a timestamp on every word, so the line can reveal or highlight in step with the voice. The second keeps a scanning viewer locked to the word being spoken instead of re-reading a static paragraph, and because eyes move faster than a voice, a caption that advances word by word stays synced to attention rather than racing ahead of it.

Word-level timing used to be the costly part of the pipeline. It is not now. OpenAI's Whisper, released under the MIT license, has produced per-word timestamps from its `transcribe()` function since version v20230306 ([openai/whisper](https://github.com/openai/whisper)), and the hosted transcription API exposes the same data through `timestamp_granularities: ["word"]` on the `whisper-1` model ([OpenAI](https://developers.openai.com/api/docs/guides/speech-to-text)). Knowing how those numbers are produced explains where they wobble: word times are not measured directly but recovered by dynamic time warping over the model's cross-attention weights, aligning each token to the audio frames it attended to ([whisper-timestamped](https://github.com/linto-ai/whisper-timestamped)), so they drift on long pauses and overlapping speakers and want a light sanity pass. Point the transcriber at your own narration audio, whether a person read it or it was [synthesized from the script](/blog/ai-voiceover-for-demo-videos), and you get back a per-word timeline you can render into whatever the target surface accepts.

## Open captions or a caption track: decide by placement

Captions ship two ways. Open captions are burned into the pixels: part of the frame, unstylable by the viewer, impossible to turn off or strip. Closed captions ride alongside the video as a sidecar file, usually WebVTT (`.vtt`) or SubRip (`.srt`), and a player renders them on demand. Closed is the more accessible default in the abstract, because the viewer controls size and can toggle it, but it reaches anyone only when the surface actually reads the sidecar. Most demo surfaces do not.

The browser will, if you own the markup. A `<video>` with a `<track kind="captions" srclang="en" src="…vtt">` child renders WebVTT natively and gives the viewer a captions control ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track)). The catch for demos is autoplay: a muted hero loop shows the track only if you mark it `default`, and any embed or reshare that re-hosts the MP4 without your `<track>` drops it silently. A GitHub README is worse: you drag in an MP4 and GitHub inlines it with no `<track>` affordance at all and a 10 MB cap on free repositories ([GitHub Docs](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)), so a [README demo that loops muted with no caption button](/blog/readme-gifs-that-update-themselves) has to carry its text in the pixels.

| Placement | Does a caption track reach the viewer? | Ship it as |
| --- | --- | --- |
| Landing hero `<video>` you host | Only if you add `default`, and any re-host drops the `<track>` | Burned in |
| GitHub README or inline docs | No `<track>` affordance, 10 MB cap on free repos | Burned in |
| Social feed, uploaded natively | The platform re-encodes, and a reshare can strip a sidecar | Burned in |
| Player with a CC toggle you control | Yes, it reads an uploaded VTT or SRT | Sidecar (closed) |
| Email or chat preview | No inline playback at all | Burned in on a still or GIF |

The pattern under the table is the whole decision: closed captions win exactly where you control a player that exposes a CC button, and nowhere else. Everywhere a demo autoplays muted, gets embedded, or is re-hosted, the only text that survives is the text you rendered into the frame. So the safe move for a demo you cannot follow across surfaces is to burn captions in and also ship a sidecar wherever a player will honor it.

## Why portable pipelines burn captions into pixels

Burning captions in sounds like the easy path and is the fiddly one, because the obvious tool is not always present. FFmpeg's `subtitles` filter, the usual way to render an SRT or ASS file onto frames, is compiled in only when FFmpeg is built with libass: the documentation states that "to enable compilation of this filter you need to configure FFmpeg with `--enable-libass`" ([FFmpeg](https://ffmpeg.org/ffmpeg-filters.html)). Its `drawtext` sibling likewise needs a libfreetype build. Plenty of distribution and CI FFmpeg binaries ship without either, so a pipeline that shells out to `subtitles` works on your laptop and dies on a runner.

The portable answer is to stop asking FFmpeg to typeset. Rasterize each caption cue to a transparent PNG with a real HTML renderer, where you control font, weight, outline, and safe-area padding, then composite the images with a time-gated `overlay`, a filter every build ships. That is why our own engine, aidemo, renders captions to timed PNGs rather than trusting `subtitles` to exist. The disclosure that owes you: aidemo is browser-only, an agent writes the storyboard instead of a person dragging clips on a timeline, and there is no visual caption editor, so you restyle by changing a value and re-rendering, not by nudging boxes on a canvas. The portability principle holds whatever renders the pixels, and it comes with the styling rules that keep burned-in text legible: set a heavy weight with an outline or a scrim so the words survive a bright UI, keep them inside a safe area so mobile chrome does not clip them, and never assume a font is installed on the render host.

## Fitting caption generation into the render

Because captions come from the narration, they slot into an automated render as one more derived step rather than a manual edit. The order is fixed: produce the narration audio, run word-level speech-to-text over that exact audio, and emit both a burned-in copy for muted and re-hosted surfaces and a `.vtt` sidecar for the players that will use it. Transcribing the real audio, not the script, is what keeps the timing honest, because it measures what was actually said, drift and all.

Run this on the same event that changes the product and the captions never fall out of step with the demo. When a build re-records the voice, the same job re-transcribes and re-renders the text, so a UI change and a script edit both flow through to the frames without anyone re-timing a line by hand. That is the payoff of treating captions as generated rather than typed: they are cheap to regenerate, which is what lets you afford to keep them correct. The mechanics of wiring that into a build, browser and fonts and all, are the same ones behind [rendering a demo in CI](/blog/demo-videos-in-ci).

## Sources

- [W3C — Understanding SC 1.2.2: Captions (Prerecorded), WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html)
- [W3C — Web Content Accessibility Guidelines (WCAG) 2.2 Recommendation](https://www.w3.org/TR/WCAG22/)
- [Forbes — Verizon Media Says 69% Of Consumers Watch Video With Sound Off](https://www.forbes.com/sites/tjmccue/2019/07/31/verizon-media-says-69-percent-of-consumers-watching-video-with-sound-off/)
- [openai/whisper — robust speech recognition, MIT-licensed, with word-level timestamps](https://github.com/openai/whisper)
- [OpenAI — Speech to text guide (timestamp_granularities)](https://developers.openai.com/api/docs/guides/speech-to-text)
- [linto-ai/whisper-timestamped — per-word timestamps via DTW on cross-attention](https://github.com/linto-ai/whisper-timestamped)
- [MDN — The Embed Text Track element (track) and WebVTT](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track)
- [FFmpeg — Filters documentation (subtitles filter, --enable-libass)](https://ffmpeg.org/ffmpeg-filters.html)
- [GitHub Docs — Attaching files (video embeds, size limits)](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)

## FAQ

### What is the difference between open and closed captions?

Open captions are burned into the video frame: always visible, not stylable by the viewer, and impossible to turn off or strip when the file is re-hosted. Closed captions ride alongside the video as a WebVTT or SRT sidecar that a player renders on demand and the viewer can toggle. Closed is friendlier when you control a player with a captions button; open is the safe choice for muted autoplay, README embeds, and social reshares, where a sidecar often never reaches the screen.

### Are subtitles and captions the same thing?

Not under the accessibility standard, though the words are used interchangeably in some regions. WCAG defines captions as a synchronized alternative for both speech and non-speech audio, so captions carry sound effects, music, and speaker identification for viewers who cannot hear. Subtitles assume you can hear and render only the dialogue, often translated. For a product demo the non-speech load is usually light, but a click cue or a success chime belongs in a caption and not in a plain subtitle.

### How do I add captions to a video in a GitHub README?

GitHub inlines an uploaded MP4 with no `<track>` element and no captions control, so a closed-caption sidecar has nowhere to attach. Burn the captions into the video before you upload it, keep the file under the 10 MB limit on free repositories, and encode with H.264 for the widest compatibility. If the demo is a looping muted clip, which most README demos are, the burned-in text is the only caption a reader will ever see.
