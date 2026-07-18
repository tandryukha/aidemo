# Autoplay video on a website: the recipe that works everywhere

July 18, 2026 · Video Marketing for Software · 7 min read · https://aidemo.top/blog/autoplay-video-on-website/

> Most autoplay bugs are a missing word from one line of markup. Here is the four-attribute set that plays in every browser, and the code for when it still won't.

**Key takeaways**

- The cross-browser recipe is four attributes: autoplay muted loop playsinline. Muted is the price; Chrome states muted autoplay is always allowed, audible autoplay is blocked without user interaction.
- Chrome's Media Engagement Index (desktop only) grants audible autoplay after qualifying views: consumption over 7 seconds, audio unmuted, tab active, frame larger than 200x140 pixels.
- iOS needs playsinline or the video forces fullscreen, and a muted video that gains an audio track or is unmuted without a user gesture will pause (WebKit).
- autoplay overrides preload, so preload="none" is ignored on an autoplaying video; control page cost with file size and loading="lazy" instead.
- Never assume autoplay worked: play() rejects with NotAllowedError when blocked, and getAutoplayPolicy() returns allowed, allowed-muted, or disallowed so you can fall back to a play button.

## The four attributes that make a video play itself

The whole recipe is one line of markup, and most autoplay bugs are a missing word from it:

```html
<video autoplay muted loop playsinline
       poster="/demo-poster.webp" width="1280" height="720">
  <source src="/demo.webm" type="video/webm">
  <source src="/demo.mp4" type="video/mp4">
</video>
```

Four boolean attributes, each doing exactly one job. `autoplay` asks the browser to start without a click. `muted` is the price of that request: browsers "block audio (or videos with an unmuted audio track) from autoplaying" ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video)), so a clip that carries sound just sits there until you silence it. `loop` seeks back to the start on reaching the end, which is what turns a clip into a background loop. `playsinline` is the one people forget, and on iPhone its absence is the entire bug: without it, elements "will continue to require fullscreen mode for playback on iPhone" ([WebKit, 2017](https://webkit.org/blog/6784/new-video-policies-for-ios/)).

Two traps hide in those booleans. Because they are booleans, `muted="false"` does nothing ("the audio will be muted if the attribute is present at all"), and `autoplay="false"` autoplays anyway ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video)). To turn either off you delete the attribute. And `muted` has to be in the HTML the server sends, not set by a script after parse, because the browser decides whether to honor `autoplay` at the moment it reads the element.

That markup autoplays a silent loop in every current browser. The rest of this is the four ways it still breaks: sound, iOS, page weight, and the quiet case where it does not play at all and your JavaScript never notices.

## Why the browser mutes you, and when it lets sound through

Autoplay with sound is not broken, it is rationed. Chrome states the floor plainly, "Muted autoplay is always allowed," then lists the three ways a page earns the right to start *with* audio ([Chrome, 2026](https://developer.chrome.com/blog/autoplay)):

- **The visitor has interacted with the domain** already this session: a click, a tap, or a keypress anywhere on the site.
- **The Media Engagement Index** clears a per-origin threshold, on desktop only. Chrome quietly scores whether you actually watch a site: a qualifying view needs consumption "exceeding seven seconds," audio "present and unmuted," the tab active, and the frame larger than 200x140 pixels. Sites you watch a lot accrue enough MEI to start with sound; a first-time visitor's does not.
- **The site is installed** as a PWA or added to the home screen.

A fourth path exists for embeds: a top frame can hand the permission down with `allow="autoplay"` on the iframe, or an `Permissions-Policy: autoplay=(self)` header ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)). That is how a hosted player nested in your page inherits your page's autoplay right.

The consequence is blunt: a first-time visitor to a landing page will never hear your video start on its own, and there is no attribute that changes that. If the audio carries the message, autoplay muted and add a visible unmute control instead of fighting the policy, which is also Mux's advice, to "provide a clear unmute button when using muted autoplay" ([Mux, 2025](https://www.mux.com/articles/best-practices-for-video-playback-a-complete-guide-2025)). Because the first play is silent by construction, whatever the video needs to say has to read without sound, which is the whole case for [captions carrying a muted feed](/blog/demo-video-captions).

## The same markup, five different browsers

"Works everywhere" is a claim worth checking, because the conditions differ by engine. Muted autoplay is allowed in all of them; the fine print is where deploys go sideways.

| Browser | Muted autoplay | Autoplay with sound | The gotcha to remember |
| --- | --- | --- | --- |
| Chrome / Edge, desktop | Always allowed | Interaction, MEI, or PWA install | Your dev machine's MEI has already earned autoplay your visitors have not |
| Chrome, Android | Always allowed | Interaction or add-to-home-screen | No MEI on mobile at all |
| Safari, iOS | Allowed when muted or no audio track | User gesture only | Needs `playsinline`, and must be on-screen to start |
| Safari, macOS | Allowed | Per-site, user-adjustable | A visitor can force "Never Auto-Play" for your site |
| Firefox | Allowed when muted or volume 0 | Interaction or allowlist | Blocks audible autoplay by default |

The cross-browser floor, then, is exactly the four-attribute recipe: muted, so every engine permits the start, and `playsinline`, so iOS keeps it in the box. Two WebKit rules deserve their own line, because the bugs they cause look random. First, an iOS video "will only begin playing when visible on-screen," so a muted loop inside a collapsed accordion, a `display:none` tab, or an off-screen carousel slide does not start until it is actually painted. Second, the one that eats an afternoon: "if a `<video>` element gains an audio track or becomes un-muted without a user gesture, playback will pause" ([WebKit, 2017](https://webkit.org/blog/6784/new-video-policies-for-ios/)). Unmuting a playing video from a script with no click behind it does not raise the volume, it stops the video.

## The iOS poster problem, and the #t=0.001 fix

One more iOS trap is about the frame a visitor sees before playback. On desktop a muted loop starts fast enough that the gap never shows. On iOS, if the network is slow or you set `preload="none"`, Safari can render a blank rectangle until the first frame decodes. The clean fix is a `poster` image, which the element shows in place of that blank while the video loads.

When you cannot ship a separate poster and want the video's own opening frame to stand in, the trick is a media fragment on the source URL: append `#t=0.001` and the browser reads it as a request to seek to 0.001 seconds. The `#t=` syntax is standardized, not a hack of unknown provenance: the W3C Media Fragments URI Recommendation defines Normal Play Time "as seconds, with an optional fractional part," so `#t=0.001` is a one-millisecond offset ([W3C, 2012](https://www.w3.org/TR/media-frags/)). Seeking there nudges iOS Safari into fetching and painting that first frame as a still instead of leaving the box empty.

```html
<!-- Paint a still first frame on iOS when no separate poster is set -->
<source src="/demo.mp4#t=0.001" type="video/mp4">
```

It is a stopgap, not a substitute for a chosen poster. Which frame you freeze on, a populated UI rather than a spinner or a login screen, is [a decision worth making on purpose](/blog/demo-video-thumbnail) rather than surrendering to whatever the first millisecond happens to hold.

## Preload: the dial that autoplay quietly overrides

The instinct is to reach for `preload="none"` to keep a background video off the critical path. On an autoplaying element it does nothing, and knowing why saves a wasted optimization.

| `preload` value | What it fetches on load | Reach for it when |
| --- | --- | --- |
| `none` | Nothing until playback is requested | The video is click-to-play, below the fold |
| `metadata` | Duration and dimensions only (the spec default) | The visitor is likely to press play |
| `auto` (or empty string) | As much of the file as the browser likes | The clip is tiny and almost certainly watched |

Here is the catch the recipe posts skip: "the `autoplay` attribute has precedence over `preload`" ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video)). If the video autoplays, the browser must download it to play it, so `preload="none"` is silently ignored. The lever that actually governs an autoplay loop's page cost is therefore file size, plus `loading="lazy"`, which delays both the download and the autoplay until the element nears the viewport, for any loop below the fold. The full performance argument, how a hero video becomes the element Google times and how a poster caps that number, is [worked out for the landing-page case](/blog/demo-video-on-landing-page) and holds the same whether you [self-host the file or serve it from a streaming host](/blog/embed-video-on-website).

## Detecting a blocked autoplay instead of hoping

The failure mode nobody codes for is the silent one: autoplay is refused, the page assumes it succeeded, and the visitor stares at a frozen frame with no obvious way to start it. `HTMLMediaElement.play()` returns a Promise for exactly this reason. When autoplay is denied, it rejects with a `NotAllowedError`, and the browser "may require the user to explicitly start media playback by clicking a 'play' button" ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)). Chrome's guidance is the same idea in one sentence: "Don't assume a video will play, and don't show a pause button when the video is not actually playing" ([Chrome, 2026](https://developer.chrome.com/blog/autoplay)).

```js
const attempt = video.play();
if (attempt !== undefined) {
  attempt.catch((error) => {
    if (error.name === "NotAllowedError") {
      video.controls = true;            // give the visitor a real play button
      video.poster = "/demo-poster.webp";
    }
  });
}
```

Newer browsers let you skip the guesswork and ask up front. `navigator.getAutoplayPolicy("mediaelement")` returns `"allowed"`, `"allowed-muted"`, or `"disallowed"`, so you can mute for the middle case and drop in a poster for the last one before you ever call `play()` ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getAutoplayPolicy)). It is still experimental, so feature-detect it and fall back to the promise above. Together they turn "it works on my machine," where your own Media Engagement Index has quietly earned an autoplay your visitors have not, into a page that degrades on purpose.

One production note, since the recipe assumes a file small enough to autoplay and one that loops without a jump where it repeats. A background loop wants to be short, muted, and cut so the last frame meets the first, which is a different export from the full narrated cut you put behind a click. Rendering the demo from a spec rather than a single hand-exported file lets one flow produce both; aidemo, the open-source engine we build, works this way, with the honest limits that it captures browser UIs only, expects an agent to author the storyboard, and ships no GUI timeline for hand-trimming the result. Which cut autoplays where is one square on the larger [map of one recording across every placement](/blog/video-marketing-for-software).

## Sources

- [MDN — The Video Embed element (`<video>`)](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video)
- [Chrome — Autoplay policy in Chrome](https://developer.chrome.com/blog/autoplay)
- [WebKit — New `<video>` Policies for iOS](https://webkit.org/blog/6784/new-video-policies-for-ios/)
- [MDN — Autoplay guide for media and Web Audio APIs](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
- [MDN — HTMLMediaElement.play()](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)
- [MDN — Navigator.getAutoplayPolicy()](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getAutoplayPolicy)
- [W3C — Media Fragments URI 1.0 (temporal dimension)](https://www.w3.org/TR/media-frags/)
- [Mux — Best Practices for Video Playback: A Complete Guide (2025)](https://www.mux.com/articles/best-practices-for-video-playback-a-complete-guide-2025)

## FAQ

### Why won't my video autoplay on iPhone?

Almost always one of two missing pieces. iOS requires the `playsinline` attribute or it forces the clip into fullscreen instead of playing it in place, and it requires `muted` (or a source with no audio track) to start without a tap ([WebKit, 2017](https://webkit.org/blog/6784/new-video-policies-for-ios/)). A third, subtler cause: iOS only starts a video that is visible on-screen, so a loop hidden in a `display:none` tab or an off-screen carousel slide will not begin until it is actually painted.

### How do I autoplay a video with sound?

On a first visit, you mostly cannot. Chrome allows unmuted autoplay only after the visitor has interacted with your site, has a high enough Media Engagement Index on desktop, or has installed the site ([Chrome, 2026](https://developer.chrome.com/blog/autoplay)), and other engines are just as strict. The shippable pattern is to autoplay muted, then offer a visible unmute button, so the visitor opts into sound with the click the policy was waiting for.

### Why is my HTML video not autoplaying in Chrome or Firefox?

Check for the `muted` attribute first: both browsers block audible autoplay by default and allow it only when the audio is muted or the volume is zero ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)). If `muted` is present and it still fails, stop assuming success and read the `play()` promise, which rejects with a `NotAllowedError` when the browser refuses, so you can fall back to showing controls and a poster instead of a frozen frame.
