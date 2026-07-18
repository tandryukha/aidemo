# How to record your screen in high quality: the settings that matter

July 18, 2026 · Screen Recording · 10 min read · https://aidemo.top/blog/how-to-record-your-screen-in-high-quality/

> Blurry text, a laggy cursor, the wrong frame rate: high quality is a handful of capture settings, each with one number and a one-line fix.

**Key takeaways**

- Record at 2x and deliver at 1x: capture the physical HiDPI grid (a 1280x720 layout is 2560x1440 at DPR 2), then downscale, and that supersample is what makes text crisp.
- Frame rate is a content decision: 30 fps for UI and forms, 60 fps only for animation or scrolling, because the extra frames cost bitrate a static screen never earns back.
- Target a quality, not a bitrate: encode with CRF 18 to 20 (x264) or CQP 18 to 20 (OBS); ffmpeg's default is CRF 23 on a 0-51 scale where lower is better.
- Match delivery to reach, not your monitor: H.264 High Profile in an MP4 plays anywhere, and Vimeo's roughly 10 to 20 Mbps for 1080p is a sane export target, at a constant frame rate.
- Capture is irreversible, polish is not: resolution, frame rate, cursor capture, and a clean profile must be right at record time; no filter adds back pixels or deletes a toast.

## Quality is decided at capture, not in the editor

"High quality" is not a slider you drag at export. It is a short list of settings you commit to the moment you press record, and every one of them fails in a specific, nameable way: text goes soft, motion stutters, a notification slides in, the voice clips. The good news is the same as the bad news. None of it is talent, so none of it is out of reach; each setting takes a number, and each has a one-line fix. The other half of the job, the zoom and the cursor glide and the trims that make a raw take look produced, is [editing you can redo without re-recording](/blog/professional-screen-recordings), so it is not on this list. This list is the part the editor cannot rescue: the properties baked into the pixels at capture time. Which recorder you use to apply them is a separate [platform-and-price question](/blog/screen-studio-alternatives); the settings below are tool-agnostic.

| Setting | Why it decides quality | The one-line fix |
|---|---|---|
| Resolution | Grabbing scaled pixels instead of physical ones bakes in soft text | Capture the HiDPI grid at DPR 2, downscale to your 1x delivery size |
| Frame rate | Too low stutters motion; too high doubles the file for nothing | 30 fps for UI, 60 fps only for animation or scrolling |
| Bitrate / codec | A fixed bitrate over-spends on still scenes and starves busy ones | Encode to a quality target (CRF 18 to 20), H.264 in MP4 |
| Cursor | A tiny, jittery pointer is the loudest amateur tell | Enlarge it, or hide it and draw a synthetic one |
| Notifications | One toast leaks a name and dates the clip forever | Do Not Disturb, plus a clean recording profile |
| Audio | Clipping or music over voice makes it unwatchable | Capture system and mic on separate tracks, keep the voice on top |
| Aspect ratio | Cropping a 16:9 desktop later throws away most of the frame | Set the viewport to the destination aspect before recording |

Read the table top to bottom before your next take and you will avoid the failures behind almost every "why does this look cheap" complaint. The rest of this page works one row at a time, with the number that makes it right. If you are producing the whole demo and not just the raw clip, [the script-first playbook](/blog/how-to-make-a-product-demo-video) is the wider frame; this is the capture layer underneath it.

## Resolution: record the physical pixels, deliver at 1x

Most blurry recordings are not a bitrate problem or a bad tool. They are a resolution mistake made before anything was recorded: the recorder captured scaled pixels instead of physical ones.

Modern laptop and phone screens are high-density. MDN pegs a device-pixel-ratio of 1 to a classic 96-DPI screen and a ratio of 2 to a HiDPI or Retina panel ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)). On a DPR-2 display, as Thilo Maier's screencast writeup puts it, "one scaled pixel consists of four physical pixels" ([Maier](https://maier.tech/posts/recording-screencasts-on-a-hidpi-display)). So a UI laid out at 1280x720 logical is actually painted across a 2560x1440 physical grid. If your recorder grabs the 1280x720 logical layer, it captures a quarter of the pixels the screen is really showing, and any text made of fine strokes turns soft. Recorders such as QuickTime and ScreenFlow instead capture the physical grid, recording 2560x1440 when you "record 1280 by 720 scaled pixels" ([Maier](https://maier.tech/posts/recording-screencasts-on-a-hidpi-display)).

That is the anchor rule for this whole page: record at 2x, deliver at 1x. Capture the physical HiDPI grid, then downscale to your delivery target. The downscale averages every 2x2 block of four captured pixels into one delivered pixel, which is supersampling, the cheapest antialiasing there is, so the edges of text and icons come out crisp instead of aliased. Record natively at 1x and you skip that averaging pass entirely: you deliver exactly the pixels you captured, with no headroom to sharpen and none to punch into later, which is [the zoom-headroom argument](/blog/professional-screen-recordings) seen from the other side.

The corollary is to match the source to the delivery, not to your monitor. Capturing a full 4K desktop for a 1080p embed spends four times the pixels and then discards three-quarters of them in a downscale nobody tuned, while a plain 1080p external panel plugged into a Retina laptop records at a flat 1920x1080 with none of the supersampling that made the built-in screen look sharp. [Pick the resolution from where the video will actually play](/blog/best-resolution-for-screen-recording), then find the 2x capture that feeds it.

## Frame rate: 30 by default, 60 only when motion pays for it

Twenty-four frames a second is the cinema floor, "the minimum speed needed to capture video while still maintaining realistic motion"; 30 and 60 are the rates "used for television and online content" ([TechSmith](https://www.techsmith.com/blog/frame-rate-beginners-guide/)). A product UI, all forms and dashboards and discrete clicks, has very little continuous motion, and 30 fps carries it cleanly. Sixty frames earns its keep only where motion is continuous: animation, fast scrolling, video playing inside the UI, a game. As TechSmith puts it, "anything higher than 30fps is usually reserved for recording busy scenes with lots of motion" ([TechSmith](https://www.techsmith.com/blog/frame-rate-beginners-guide/)).

The cost of the extra frames is bits. Doubling the frame rate does not quite double the file, since consecutive frames are similar enough to compress against one another, but on footage that barely moves it still spends noticeably more to show the same thing. Paying that to render a cursor crossing a static form is a bad trade. Capturing high and producing lower can bank motion detail when a scene truly needs it, but for a walkthrough that ends up in an embed, 30 fps captured and delivered is the honest default. One capture-time rule reinforces it: Vimeo's compression guide says to "always choose a constant frame rate rather than a variable frame rate" ([Vimeo](https://help.vimeo.com/hc/en-us/articles/12426043233169-Video-and-audio-compression-guidelines)), because the variable rate some tools default to drifts out of sync with narration and confuses every editor downstream. [The 30-versus-60 decision by content type](/blog/best-frame-rate-for-screen-recording) is worth its own table.

## Bitrate and codec: target a quality, not a number

There are two ways to control size, and for screen content only one is right. A fixed bitrate spends the same bits on a motionless login screen and a scrolling table: the still scene wastes them, the busy scene starves. Constant-quality encoding inverts that. You pick a quality and let the bitrate float to hold it, which OBS documents as CQP or CRF, where a "lower CRF will result in higher quality and larger file sizes" ([OBS Project, 2026](https://obsproject.com/kb/advanced-recording-settings-guide)). Screen recordings, long still stretches punctuated by bursts, are exactly the case constant quality was built for.

The number to set is small and well documented. In x264 the constant rate factor runs 0 to 51 with a default of 23, "where lower values indicate better quality" ([FFmpeg](https://ffmpeg.org/ffmpeg-codecs.html)); OBS recommends a CQP or CRF of 16 to 23 for recording, with a keyframe interval of 2 seconds ([OBS Project, 2026](https://obsproject.com/kb/advanced-recording-settings-guide)). For crisp UI text, sit at the high-quality end, a CRF around 18 to 20, and choose a slower encoder preset, which spends more CPU to reach the same quality in a smaller file.

Codec is a separate axis from container. H.264 inside an MP4 is the send-anywhere default; Vimeo, for one, recommends H.264 in its High Profile setting as the balance of "high visual quality with efficient file size," at roughly 10 to 20 Mbps for 1080p ([Vimeo](https://help.vimeo.com/hc/en-us/articles/12426043233169-Video-and-audio-compression-guidelines)). VP9 or AV1 buy a meaningfully smaller web embed at the cost of compatibility, and [that container-versus-codec decision has its own table](/blog/best-video-format-for-screen-recording). The one universal rule: for a raw take you will edit later, record at near-lossless quality and compress once on export, never twice.

## The three tells that date a recording: cursor, notifications, clutter

These three change no bitrate. They change whether the clip reads as a product or as a desktop someone forgot to tidy, and each is set at record time.

The cursor is the first tell. The system pointer is small, and its real path between clicks is high-frequency jitter that, rendered faithfully, screams that a human recorded this live. Two fixes exist: enlarge or hide the pointer in the recorder, or hide the operating-system cursor and draw a smooth synthetic one over the footage. [Cursor smoothing itself is a compose-time transform](/blog/professional-screen-recordings), but whether the OS cursor is captured at all is a switch you flip before recording.

Notifications are the tell you cannot fix later. One Slack or Mail toast slides in with a real name attached, and no filter removes it from the pixels afterward. Turn on Do Not Disturb or Focus on whatever OS you are on, and, better still, record in a clean profile or a fresh window where nothing personal can fire at all. [The cross-OS Do-Not-Disturb setup](/blog/hide-notifications-while-recording) is the belt; a clean profile is the suspenders.

Clutter is the slow tell: personal bookmarks, a half-dismissed cookie banner, a stray scrollbar, forty browser tabs. A recording profile with no extensions and hidden chrome keeps the frame about the product. It is also the reason capturing [a single browser tab rather than the whole screen](/blog/record-a-browser-tab) yields a cleaner result with far less to police.

## Audio: capture two tracks, keep the voice on top

If the recording carries sound, the quality bar is intelligibility, not loudness, and two failures dominate. The first is clipping: push the mic or system level past 0 dBFS and you bake in permanent distortion that no amount of later gain repairs. The second is burial: music or interface sound sitting on top of the narration so the words stop landing.

Both have the same structural fix, which is to capture system audio and the microphone as two separate tracks rather than one pre-mixed one. Two tracks let you balance them after the fact; a single mixed track cannot be unmixed. Set the mic with headroom so its peaks stay well below clipping, and keep any background bed low enough under narration that a listener never strains for a word. The exact loudness targets belong to the mixing stage, but the capture rule is short: two tracks, a mic with headroom, and never a single already-clipped mix.

## Aspect ratio: compose for the destination before you record

A recording is 16:9 because monitors are. If it is bound for a vertical feed at 9:16 or a square post at 1:1, the honest move is to record for that shape, not to crop into it afterward, because cropping a landscape desktop to vertical [keeps only about a third of the width](/blog/professional-screen-recordings) and discards the rest. Set the capture viewport to the destination aspect up front: a narrow browser window for a 9:16 story, the full width for a 16:9 hero. Then the action already lives inside the frame you will ship, and there is no lossy reframe to regret.

## The one rule under the checklist: capture is irreversible

Every row above sorts into one of two columns. Resolution, frame rate, whether the cursor was captured, whether the profile was clean, the aspect the viewport was set to: these are properties written into the pixels, and no filter reverses them. Zoom, trims, captions, color, the synthetic cursor: these are re-derivable, applied to footage as many times as you like. The whole discipline is knowing which column a decision lives in, getting the left one right exactly once, and treating the right one as free to redo.

The reliable way to "get it right once" is to stop performing the capture and start pinning it, so the viewport, device pixel ratio, frame rate, and profile are fixed values and [the same run produces the same footage every time](/blog/deterministic-browser-automation-for-video). In our own engine, aidemo, those capture settings live in a storyboard authored by a coding agent in code rather than dragged on a GUI timeline, so a demo re-renders at the identical resolution and frame rate on every run. The honest limits: aidemo captures a browser only, so it will not record a native desktop app, and for a single throwaway clip a GUI recorder is simply less setup.

The last quality failure is the one that arrives months later. The recording stays perfectly sharp while the product moves, until it [quietly starts lying about a UI that shipped past it](/blog/why-product-demos-go-stale), and the cheap fix at that point is to [regenerate it from the spec rather than re-record the whole take](/blog/automated-product-demo-videos). High quality you cannot reproduce next quarter is a one-time result, not a setting.

## Sources

- [MDN — Window.devicePixelRatio](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)
- [Thilo Maier — Recording screencasts on a HiDPI display](https://maier.tech/posts/recording-screencasts-on-a-hidpi-display)
- [TechSmith — Frame Rate: A Beginner's Guide](https://www.techsmith.com/blog/frame-rate-beginners-guide/)
- [Vimeo — Video and audio compression guidelines](https://help.vimeo.com/hc/en-us/articles/12426043233169-Video-and-audio-compression-guidelines)
- [OBS Studio — Advanced Recording Settings Guide](https://obsproject.com/kb/advanced-recording-settings-guide)
- [FFmpeg — Codecs documentation (libx264 crf, preset)](https://ffmpeg.org/ffmpeg-codecs.html)

## FAQ

### Why does my screen recording look blurry?

Almost always because you captured scaled logical pixels on a HiDPI or Retina display instead of the physical ones. A layout shown as 1280x720 is actually painted across a 2560x1440 physical grid on a DPR-2 screen, so a recorder that grabs the logical layer keeps a quarter of the detail and fine text softens. The fix is to record the physical grid and downscale to your 1x delivery size; that downscale supersamples four pixels into one and sharpens the result. A 1080p external monitor on a Retina laptop is the other common culprit, since it records at a flat 1920x1080 with no density to spare.

### What settings should I use to record my screen in high quality?

Capture the physical HiDPI resolution at DPR 2 and downscale to your delivery size, run 30 fps for a normal UI (60 only for animation or scrolling), and encode to a quality target rather than a fixed bitrate, around CRF 18 to 20 for H.264 in an MP4. Then handle the three tells that no filter fixes later: enlarge or hide the cursor, switch on Do Not Disturb and record in a clean profile, and capture audio as separate system and mic tracks. Set the aspect ratio to the destination before you record, not after.

### Should I record my screen in 1080p or 4K?

Record whatever physical resolution is 2x your delivery target, not the biggest number your monitor offers. If the video ships at 1080p, capturing the HiDPI grid behind a 1080p layout already gives you the supersampling that makes text crisp, and a full 4K capture just spends four times the bits to throw most of them away. Reach for a true 4K capture only when you are delivering in 4K or you know you will punch deep into the frame during editing and need the extra pixels to survive the zoom.
