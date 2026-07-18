# OBS Studio for product demos: what it does and doesn't do

July 18, 2026 · Demo Tools & Alternatives · 9 min read · https://aidemo.top/blog/obs-for-product-demos/

> OBS is free and captures anything, but it finishes nothing: no auto-zoom, no cursor smoothing, no trim. Here is what the hand-labor actually costs.

**Key takeaways**

- OBS is free, open source (GPLv2), and records any app at source resolution with no watermark or time cap, but adds no auto-zoom, cursor smoothing, dead-time trim, or captions.
- Those four effects are manual in OBS: budget roughly 90-150 minutes of hand-labor to finish a 2-minute demo that a produced recorder polishes in about 30-45.
- OBS has no compose layer: timing, framing, and cursor are welded into one flat file, so a bad zoom is a reshoot, not a parameter change.
- Crossover math: for a one-off you'll never touch, $0 OBS wins; past ~2-3 revisions the hand-labor overtakes a $9/mo produced tool or a spec you re-render.
- Use OBS for native apps, games, or live multi-source composites; skip it for a web UI you'll polish, retarget, or keep current as the product ships.

## OBS captures anything and finishes nothing

OBS Studio bills itself as "free and open source software for video recording and live streaming" ([OBS, July 2026](https://obsproject.com/)) and is released under the GNU General Public License v2 ([OBS Studio, July 2026](https://github.com/obsproject/obs-studio)). It runs on Windows, macOS, and Linux, records at your source resolution with no time cap and no watermark, and captures nearly any surface on the machine. For raw capture at a price of zero, nothing beats it.

It is also, by its own description, a broadcast tool. The README says OBS is engineered for "capturing, compositing, encoding, recording, and streaming video content" ([OBS Studio, July 2026](https://github.com/obsproject/obs-studio)) — the live loop a streamer runs in real time. Read that list again and notice the word that is absent: editing. OBS mixes sources into a scene and writes the result to a file. It does not punch in on a click, calm a cursor, cut dead air, or caption a transcript. Those four are what a product demo lives or dies on, and OBS does none of them.

This is a build-vs-buy accounting: what OBS hands you for nothing, what you rebuild by hand once the recording stops, and the point where the labor costs more than a produced recorder or a spec you re-render. It sits inside a wider market [sorted by mechanism rather than price](/blog/ai-demo-video-generators), and the caps and watermarks that other "free" tools hide are [charted in their own piece](/blog/free-demo-video-software). Here the question is narrower. Free is only half of a price. The other half is your afternoon.

## What OBS hands you for free

The capture engine is genuinely good, and worth naming before the criticism. OBS is built around scenes and sources: you "create scenes made up of multiple sources including window captures, images, text, browser windows, webcams, capture cards and more," and switch between an unlimited number of them ([OBS, July 2026](https://obsproject.com/)). Display Capture grabs a whole monitor, Window Capture isolates one window, and a Browser source drops a web page into the frame — though the docs note that source is "primarily used for stream alert overlays and chat boxes," not clean product capture ([OBS, July 2026](https://obsproject.com/kb/sources-guide)).

For a demo, three of those strengths matter. It captures native desktop apps and games, not just a browser tab, which is exactly where a browser-only pipeline cannot follow. It composites a webcam bubble, a logo, and a screen into one live frame without a separate editor. And it costs nothing, forever, with no export ceiling — the real deal among the [genuinely open tools](/blog/open-source-demo-video-tools). If your demo is a live-narrated walkthrough you will record once and post as-is, OBS is a complete answer.

The trouble starts the moment you want it to look produced.

## The four jobs OBS leaves on your desk

Set OBS beside a produced recorder and the gap is four specific effects, each automatic there and manual here.

Screen Studio, the reference for the produced look, "automatically zooms in on actions you perform on your screen" and turns the "shaky and rapid movement of your cursor" into "a smooth and beautiful glide" ([Screen Studio, July 2026](https://screen.studio/)). OBS does neither. There is no click-triggered zoom in the core app, and there is no filter that de-jitters a cursor after the fact, because by the time OBS writes the file, the cursor path is already fused into the pixels. The mechanics of what those transforms actually are — the ease curve, the focus point, the idle threshold — are [decomposed in the professional-recording piece](/blog/professional-screen-recordings); the point here is only that OBS ships none of them.

So the four jobs land on you:

- **Zoom on interaction.** No auto-zoom. You either build zoom scenes and cut to them live with a hotkey (which turns every take into a performance you can fumble), or you add the zoom in post. In an editor that means hand-keyframing a scale and position on every moment worth emphasizing. In ffmpeg it means the `zoompan` filter, which sets "zoom expression, x and y offset expressions which will be evaluated for each frame" ([FFmpeg, July 2026](https://ffmpeg.org/ffmpeg-filters.html)) — one expression triple per segment, written by hand.
- **Cursor smoothing.** Not fixable in post at all. The recorded pointer is already pixels; there is no path left to resample. Your only levers are to move the mouse deliberately during the take, or to hide the cursor and ship a demo with no pointer.
- **Dead-time trimming.** OBS writes every load spinner and every pause where you hunted for the next control. Removing them is manual timeline work in whatever editor you pair it with.
- **Captions.** OBS has no transcript feature. You caption in a separate tool or by hand, which is not optional busywork: most demo views start muted.

A community Lua script, obs-zoom-to-mouse, closes part of the first gap. It animates a crop-and-pan to "zoom a display-capture source to focus on the mouse" on a hotkey, with an optional follow-the-cursor mode ([BlankSourceCode, July 2026](https://github.com/BlankSourceCode/obs-zoom-to-mouse)). It is a real help, but it is a live pan-follow you configure and trigger yourself, not the eased punch-in-and-hold a produced tool applies on its own, and it adds one more thing to operate while you record.

## The hand-labor bill, per finished minute

Here is the accounting nobody prints on the OBS pricing page, because OBS has no pricing page. Take a routine target: a two-minute product walkthrough with narration, roughly ten moments worth a zoom, captions, and light music. The figures below are order-of-magnitude estimates with the assumptions stated, not stopwatch readings — but the shape is the point.

| Task (~2-min demo) | OBS + manual post | Produced GUI recorder | Spec-driven re-render |
|---|---|---|---|
| Clean environment (profile, notifications, viewport) | ~10 min, every take | ~10 min, every take | pinned in the spec, once |
| Land a clean take | 3-5 tries, ~15-25 min | 1-2 tries, ~5-10 min | 0 (deterministic replay) |
| Zoom on ~10 interactions | hand-keyframe each, ~20-40 min | automatic | one parameter, re-runs free |
| Cursor smoothing | impossible in post; re-record | automatic | synthetic cursor built in |
| Trim dead time | manual cuts, ~10-15 min | semi-automatic | idle threshold, re-runs free |
| Captions | transcribe and time, ~30 min | auto transcript | word-timed transcript |
| Music, export | ~10 min | ~5 min | in the render step |
| **First demo, human time** | **~90-150 min** | **~30-45 min** | **~45-75 min to author** |
| **Each later revision** | repeat most of the above | re-edit the take | **~0 — CI re-renders** |

Two readings of that table. First, OBS is not free; it trades dollars for something like ninety minutes to two and a half hours of skilled human time per two-minute demo, most of it spent rebuilding the four effects a produced tool applies in seconds. Second, the columns have different shapes. OBS charges that labor every single time — every new demo, and every revision of an old one. A produced recorder charges a subscription (Screen Studio is $9 a month billed yearly, macOS only) to cut the per-take labor. A spec-driven pipeline front-loads the authoring and then drops the marginal cost of a re-render toward zero.

That difference is the crossover. For exactly one demo you will never touch again, OBS at $0 wins outright. The moment you will revise a demo more than two or three times, or maintain more than a handful of them, the accumulated hand-labor overtakes both the price of a produced recorder and the authoring cost of a spec you keep in the repo.

## No compose layer means every fix is a re-performance

There is a deeper reason the OBS bill never stops. A produced pipeline keeps two things apart: the capture, and the parameters applied to it. Zoom scale, cursor path, and trim points live in a layer you can change and re-run over the same footage, which is why a bad zoom in that world is a re-render rather than a reshoot. OBS has no such layer. It emits one flat file with the timing, the framing, and the cursor already welded into the pixels.

The consequence is that in OBS-land, everything a produced tool treats as a cheap parameter change is either baked into a live performance or reconstructed by hand in a separate editor, with nothing reusable carried between takes. Punch in a beat too late and the zoom is in the pixels: fix it in the editor or shoot the take again. And when the product ships a UI change — which it will — the recording is simply wrong, and there is no spec to re-run. You re-perform the take and redo the whole post pass. That staleness tax gets [its own piece](/blog/why-product-demos-go-stale); OBS is the tool that pays it in full, every time, because it keeps no record of how the demo was made.

This is the honest place for our own tool. aidemo, which we build and disclose as ours, makes the reverse bet: an agent authors a storyboard, a deterministic player drives your live web app through it, and zoom, a synthetic cursor, and word-timed captions are compose-time parameters you re-run for nothing. The trade is real and worth stating plainly. It captures a browser tab and only a browser tab, so the native apps and games OBS handles are out of scope; the storyboard is authored in code rather than nudged on a canvas, and no drag-and-drop editor exists at all. Where OBS is all manual capture and no spec, it is all spec and no manual capture. Opposite bets, opposite failure modes.

## When OBS is still the right tool

None of this makes OBS the wrong choice; it makes it a specific one. Reach for OBS when:

- **The demo is a native app or a game.** A browser-only pipeline cannot record it, and OBS's window and game capture can. This is its genuine home turf.
- **You need a live multi-source composite.** Webcam plus screen plus overlays, mixed in real time — OBS was built for exactly this, and it is the free tool that does it well.
- **It is a one-off you will never revise.** If the recording ships once and dies, the per-take labor is paid once, and $0 beats every subscription.
- **Free and cross-platform are hard constraints and you will do the post yourself.** OBS plus an editor is the zero-dollar route across all three operating systems.

Skip it when the demo is a web UI you will polish, retarget, or keep current as the product ships. There the produced-recorder route ([mapped by platform here](/blog/screen-studio-alternatives)) or a spec-driven re-render buys back the afternoon OBS quietly charges. OBS is a superb broadcast switcher pressed into service as a demo tool. It captures everything and finishes nothing, and the finishing is the part your viewer actually sees.

## Sources

- [OBS Studio — homepage (free and open source, scenes and sources)](https://obsproject.com/)
- [OBS Studio — GitHub repository (GPL v2, capturing/compositing/recording/streaming)](https://github.com/obsproject/obs-studio)
- [OBS Studio — sources knowledge base (Display, Window, Browser capture)](https://obsproject.com/kb/sources-guide)
- [FFmpeg — filters documentation (zoompan, crop)](https://ffmpeg.org/ffmpeg-filters.html)
- [Screen Studio — automatic zoom, cursor smoothing, and pricing](https://screen.studio/)
- [obs-zoom-to-mouse — OBS Lua script for hotkey zoom to the cursor](https://github.com/BlankSourceCode/obs-zoom-to-mouse)

## FAQ

### Can OBS automatically zoom in on clicks like Screen Studio?

No. The core OBS app has no click-triggered auto-zoom; Screen Studio and similar produced recorders apply that on their own, OBS does not. A community Lua script, obs-zoom-to-mouse, adds a hotkey zoom that can follow the cursor, but you configure and trigger it yourself, and it is a live pan-follow rather than the eased punch-in-and-hold a produced tool applies automatically. The other route is to add the zoom in post with an editor's keyframes or ffmpeg's zoompan filter, which is manual work on every moment you want to emphasize.

### Is OBS Studio good for recording product demos?

For the capture step, yes: it is free, records any window or app at full resolution with no watermark or time cap, and composites multiple sources live. For the finished look, no: it has no auto-zoom, no cursor smoothing, no dead-time trimming, and no captions, so a produced demo means an hour or more of manual post per two-minute video. Use OBS when the demo is a native app, a live multi-source composite, or a one-off you will never revise; look elsewhere when it is a web UI you will polish or keep current.

### How do you add zoom and cursor smoothing to an OBS recording?

Zoom is added after the fact, in a separate editor by keyframing a scale and position on each emphasis point, or in ffmpeg with the zoompan filter's per-frame expressions. Cursor smoothing cannot be added in post at all: OBS records the real pointer path straight into the pixels, so there is no path left to resample. Your only options for a calmer cursor are to move the mouse deliberately during the take, hide the cursor entirely, or use a tool that draws a synthetic pointer instead of capturing the real one.
