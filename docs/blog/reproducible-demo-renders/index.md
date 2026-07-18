# Reproducible demo renders: byte-for-byte, on purpose

July 18, 2026 · Demos as Code · 7 min read · https://aidemo.top/blog/reproducible-demo-renders/

> You pinned the browser so it paints the same pixels every run. The MP4 still differs. Here is why, and the reproducible-builds discipline that closes it.

**Key takeaways**

- A deterministic browser replay feeds identical pixels to the encoder, yet the MP4 still differs: the file also carries timestamps, an encoder build string, and thread-dependent bitstream choices.
- Reproducible Builds' own finding transfers to video: timestamps are the single biggest non-determinism source, and the top three (timestamps, encoder identity, thread count) cover nearly every mismatch.
- FFmpeg ships the fix: -fflags +bitexact -flags:v +bitexact writes 'platform-, build- and time-independent data' for reproducible checksums; add -threads 1 and -map_metadata -1.
- Byte-for-byte is brittle: one libx264 point release rewrites every hash, so it only means anything with a pinned toolchain in a container. Pin it, then hash the output like a golden file.
- For a marketing demo, freeze a higher layer (behavior golden or still frames), not the bytes. Byte reproducibility earns its keep for cache-dedup, provenance, and archival.

## Same spec, same pixels, a different file every time

You did the expensive part. The demo is [a committed spec that replays into footage](/blog/demos-as-code), and the browser side is [pinned hard enough to paint identical frames on every run](/blog/deterministic-browser-automation-for-video): fixed viewport, frozen clock, fonts awaited, network stubbed. Two runs, the same picture frame for frame. Then you `sha256sum` the two MP4s and they disagree.

That is not a bug in the replay. The file holds more than the image. An MP4 is a container wrapped around an encoded bitstream, and both layers stamp in facts about the moment and the machine that produced them: when the mux ran, which encoder build did the work, how many CPU threads split the frames. Identical input, different provenance, different bytes. The received wisdom is that two encodes never match, and as a default that is fair. It stops being true the moment you decide to make it stop.

## A render is a build, so borrow the build contract

The people who fought this exact war are the Reproducible Builds project, whose whole job is making a compiler emit the same binary twice. Their definition is the one to steal: a build is reproducible when, given the same source, environment, and instructions, any party can recreate "bit-by-bit identical copies of all specified artifacts," verified by a plain hash comparison ([Reproducible Builds, accessed July 2026](https://reproducible-builds.org/docs/definition/)).

Every noun maps onto a render. The *source* is the storyboard plus the captured frames and the narration. The *instructions* are the compose command: the filter graph, the codec, the flags. The *environment* is the part nobody writes down, the exact ffmpeg, the exact libx264, the fonts installed on the box, the number of cores. Pin all three and the render is a build like any other. Leave any one floating and you do not have a build, you have a coincidence that saved to disk.

## Where the bytes diverge, ranked by how often they bite

The Reproducible Builds project names the worst offender before you ever reach video: "Timestamps make the biggest source of reproducibility issues. Many build tools record the current date and time" ([Reproducible Builds, accessed July 2026](https://reproducible-builds.org/docs/timestamps/)). That ranking holds for an MP4, and the rest of the list is short enough to memorize.

| Rank | Source of drift | What it stamps into the file | Bites when | The pin |
|---|---|---|---|---|
| 1 | Wall-clock timestamps | creation and modification time in the movie header | every single render | `+bitexact` writes time-independent data |
| 2 | Encoder identity | x264's build-and-settings string in the bitstream, plus an `encoder` tag in the container | any toolchain version change | `-flags:v +bitexact` strips it |
| 3 | Thread count | frame-split decisions under some rate-control modes | across machines with different core counts | `-threads 1`, or a fixed N |
| 4 | Font rasterization | the exact pixels of baked-in captions and cards | across OS or image versions | ship the font files; pin the rasterizer |
| 5 | Container muxing | atom order, padding, faststart placement | across ffmpeg versions | fixed flags plus `+bitexact` |
| 6 | Audio encoder | AAC psychoacoustic choices, encoder version | on any audio-codec change | pin the toolchain, or master in FLAC/PCM |

Read it top down and a pattern falls out. The first three rows account for nearly every mismatch you will actually see, and all three are metadata or machine facts, not one pixel of the demo. Rows four through six fire only when the environment itself moves, which is precisely why the environment is the thing you freeze rather than chase.

## The recipe most renders never apply

None of this needs a new tool. FFmpeg already ships the lever, and it is embarrassingly close to a one-liner. The `bitexact` flag exists specifically to "only write platform-, build- and time-independent data," so that "file and data checksums are reproducible and match between platforms" ([FFmpeg, accessed July 2026](https://ffmpeg.org/ffmpeg-formats.html)). Set it on the container and on each codec, pin the thread count away from its machine-dependent default of `auto` ([FFmpeg, accessed July 2026](https://ffmpeg.org/ffmpeg-codecs.html)), and drop any stray global metadata:

```sh
ffmpeg -i frames.mp4 -i narration.wav \
  -map 0:v -map 1:a \
  -c:v libx264 -preset veryfast -crf 20 -threads 1 \
  -flags:v +bitexact -flags:a +bitexact -fflags +bitexact \
  -map_metadata -1 -movflags +faststart \
  out.mp4
sha256sum out.mp4
```

`SOURCE_DATE_EPOCH` is the cross-tool convention that names the one timestamp a build may use, expressed as seconds since the Unix epoch of January 1st 1970 UTC, so every tool that honors it agrees on "now" ([Reproducible Builds, accessed July 2026](https://reproducible-builds.org/docs/source-date-epoch/)). FFmpeg does not read it, but the wrapper that archives the finished MP4 should, and for the leaks a tool bakes in anyway there is `strip-nondeterminism`, the post-processing normalizer the same project maintains ([Reproducible Builds, accessed July 2026](https://reproducible-builds.org/docs/timestamps/)). The last mile is pinning the toolchain itself: the `bitexact` output matches across platforms only up to the encoder version, so the recipe belongs inside a pinned container image, [built once and reused by the CI job that renders the demo](/blog/demo-videos-in-ci).

## Hashing the output, and what a green hash means

Once the bytes are stable, the render gets the same superpower a compiler does: its output has a hash, and the hash is an assertion. Commit it, and CI re-renders and compares; a matching digest is a fast, total proof that nothing observable changed. This is the golden-file pattern the terminal world already runs. vhs emits a `.txt` or `.ascii` transcript precisely so teams can "generate golden files" and commit them, catching any unintended change when the tape is replayed in CI ([Charmbracelet, accessed July 2026](https://github.com/charmbracelet/vhs)), and a bit-exact MP4 pushes that same idea down to the byte layer of a real video.

The catch is the one that makes a byte hash [the noisiest layer you can freeze](/blog/testing-demos-like-code): it tells you the bytes differ, never why. A red digest is a real product change, a bumped ffmpeg, or a runner with a different core count, and the digest cannot tell the three apart. So the hash is load-bearing only when the environment underneath it is nailed down. A reproducible render without a pinned toolchain is not reproducible; it is lucky.

## When byte-for-byte earns its keep

Byte reproducibility is brittle on purpose. One libx264 point release rewrites every hash in the repository at once, which is the whole point when you are verifying a supply chain and exactly the wrong tax to pay to regression-test a marketing clip. For most demos the better move is to freeze a higher, calmer layer, the resolved behavior or a handful of still frames, and let the pixels re-encode however they like. That is the call the [golden-layer decision](/blog/testing-demos-like-code) already covers.

The cases where hashing the actual bytes pays for itself are specific and real. Cache-dedup: if the inputs hash the same, skip the re-encode entirely and reuse yesterday's artifact, turning a nightly render into a no-op on the days nothing changed. Provenance: an archival or compliance copy that a third party can rebuild and verify to the bit. And genuine bisection, where you need to prove a byte moved between two commits, not merely that a perceptual diff wobbled past a threshold.

Our own engine, aidemo, sits deliberately on one side of this line, and it is worth being exact about which. It makes the capture reproducible, driving a real Chrome through a fixed action-spec and shipping a timing-free behavior golden you diff in a pull request, but it does not currently emit a byte-for-byte identical MP4: its libx264 compose writes the encoder's build string and takes the machine's default thread count, so the finished file is not something you would hash. It is browser-only, an agent writes its storyboards instead of a human dragging clips on a timeline, and byte-level determinism is a compose-time flag it has not yet flipped. The honest version of "reproducible demo renders" is a ladder: pin the capture first, freeze the behavior next, and reach for the bit-exact bytes last, once you know [which artifact you are actually versioning](/blog/versioning-media-assets-in-git).

## Sources
- [Reproducible Builds — Definition (bit-by-bit identical artifacts from the same source, environment, and instructions)](https://reproducible-builds.org/docs/definition/)
- [Reproducible Builds — Timestamps (the biggest single source of non-reproducibility; strip-nondeterminism, libfaketime)](https://reproducible-builds.org/docs/timestamps/)
- [Reproducible Builds — SOURCE_DATE_EPOCH (seconds since the Unix epoch; the one timestamp a build may use)](https://reproducible-builds.org/docs/source-date-epoch/)
- [FFmpeg — Formats documentation (fflags bitexact: only platform-, build- and time-independent data, reproducible checksums)](https://ffmpeg.org/ffmpeg-formats.html)
- [FFmpeg — Codecs documentation (codec flags bitexact; -threads default 'auto')](https://ffmpeg.org/ffmpeg-codecs.html)
- [Charmbracelet vhs — .txt/.ascii output for golden files, diffed between tape runs in CI](https://github.com/charmbracelet/vhs)

## FAQ
### Why do two encodes of the same video produce different checksums?
Because the file records more than the picture. The container stamps in wall-clock creation and modification times, the encoder writes its own build-and-settings string into the bitstream, and multi-threaded encoding can split frames differently depending on how many cores the machine has. None of those are pixels, but all of them are bytes, so identical footage still hashes differently unless you strip the metadata and pin the encode.
### How do you make an ffmpeg render byte-for-byte reproducible?
Add `-fflags +bitexact -flags:v +bitexact -flags:a +bitexact`, which FFmpeg documents as writing only "platform-, build- and time-independent data" so "checksums are reproducible and match between platforms." Then pin the thread count with `-threads 1` (its default is the machine-dependent `auto`), drop container metadata with `-map_metadata -1`, and run the whole thing inside a pinned toolchain, since the output only matches other machines up to the encoder version.
### Does SOURCE_DATE_EPOCH work for video files?
Not directly. FFmpeg does not read `SOURCE_DATE_EPOCH`; its own mechanism for "no wall clock in the file" is the `bitexact` flag, which writes time-independent data instead of the current time. Use `SOURCE_DATE_EPOCH` in the surrounding build tooling that archives or packages the render, and reach for a post-processor like `strip-nondeterminism` for any timestamp a tool embeds regardless.
