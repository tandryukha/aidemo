# Docs that test themselves: executable documentation

July 18, 2026 · Demo Automation · 8 min read · https://aidemo.top/blog/docs-that-test-themselves/

> Python's docs literally call it 'executable documentation': an example that fails when the code drifts. The same trick works one layer up, on your screenshots.

**Key takeaways**

- Python's doctest docs name the pattern outright — 'literate testing' or 'executable documentation': the example runs on every build, so the docstring can't drift from behavior.
- Five languages ship it — Rust doc tests, Go Example funcs with // Output:, Python doctest, Sphinx make doctest, Elixir ExUnit.DocTest — split over 'does it run' vs 'does the output match'.
- Generalized to media: a screenshot or demo re-captured from a spec is a doctest for the interface — the picture fails when the UI moves, as a code example fails when the API moves.
- Two gates, two costs: the run gate (every selector resolves) is cheap and deterministic; the match gate (pixel or still golden) is brittle and needs a threshold — the Rust-vs-Go split.
- doctest already solved media flakiness: NORMALIZE_WHITESPACE / ELLIPSIS / SKIP for noisy output map one-to-one to masking dynamic regions and perceptual thresholds in a visual diff.

## The doctest bargain: an example that fails when the prose lies

Documentation lies by omission of maintenance. Someone writes an accurate example, the code moves underneath it, and the example keeps sitting there, wrong and confident, until a reader trips on it. The doctest is the oldest fix for this, and it is almost aggressively simple: put the example where a test runner can find it, run it, and fail the build when its output stops matching reality. Python's `doctest` module states the mechanism plainly. It "searches for pieces of text that look like interactive Python sessions, and then executes those sessions to verify that they work exactly as shown" ([Python docs, accessed July 2026](https://docs.python.org/3/library/doctest.html)).

The trade you are making has a name on the same page. Among doctest's stated uses is writing tutorial documentation "liberally illustrated with input-output examples," which "has the flavor of 'literate testing' or 'executable documentation'" ([Python docs, accessed July 2026](https://docs.python.org/3/library/doctest.html)). The example is not a copy of the behavior that a human promises to keep in sync. The example is the behavior, exercised on every run, so drift has nowhere to hide. The module's own soapbox captures why that earns its keep: "I'm still amazed at how often one of my `doctest` examples stops working after a 'harmless' change" ([Python docs, accessed July 2026](https://docs.python.org/3/library/doctest.html)). That surprise is the entire product. The doc caught a lie the author did not know they had told.

## Five languages already ship this, and they disagree about what to freeze

The idea is not Python's alone, and the disagreements between implementations are where it gets interesting. Rust builds doc tests into the compiler's front door: rustdoc "supports executing your documentation examples as tests," which "makes sure that examples within your documentation are up to date and working," and a plain doc test "pass[es] if they compile and run without panicking" ([Rust docs, accessed July 2026](https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html)). Go ties examples to `go test`: an `Example` function is "compiled and executed as part of the package's test suite," and a trailing `// Output:` comment "is compared with the standard output of the function when the tests are run" ([Go docs, accessed July 2026](https://pkg.go.dev/testing)). Sphinx offers a `doctest` builder for prose docs precisely because "it is important to ensure that the documentation stays up-to-date with the code" ([Sphinx docs, accessed July 2026](https://www.sphinx-doc.org/en/master/usage/extensions/doctest.html)). Elixir's ExUnit will "generate tests from code examples found in `@moduledoc` and `@doc` attributes," turning every `iex>` line in a docstring into an assertion ([ExUnit.DocTest, accessed July 2026](https://ex-unit.hexdocs.pm/ExUnit.DocTest.html)).

Read them side by side and one fault line runs through the set: some check that the example still runs, and some check that its output still matches. That distinction decides everything downstream.

| Mechanism | The "example" | It passes when | You run it with |
|---|---|---|---|
| Rust doc test | a fenced block in a `///` comment | it compiles and runs without panicking | `cargo test` |
| Go testable example | an `Example` func plus `// Output:` | stdout equals the annotated output | `go test` |
| Python doctest | a `>>>` session in a docstring | the printed output matches exactly | `python -m doctest` |
| Sphinx doctest | a directive-marked block in the prose | the builder runs it green | `make doctest` |
| Elixir ExUnit.DocTest | an `iex>` example in `@doc` | it runs as an ExUnit case | `mix test` |

## One layer up: a re-captured screenshot is a doctest for the interface

Now make the leap the executable-docs world never had to. Their examples are text that produces text, so the expected output can sit inline, human-readable, in the same file. Product media is text that produces pixels: a storyboard or a screenshot spec that yields a frame of a running UI, where the expected output cannot live in the source as a literal. But the bargain survives the change of medium. A screenshot re-captured from a spec against the live product is a doctest for the interface. It asserts that the picture in your docs still matches the software, and it fails when the software moves out from under it. That is exactly the failure a hand-shot PNG hides for months, the reason [product demos and screenshots rot on a schedule](/blog/why-product-demos-go-stale).

The mapping is close enough to be mechanical.

| Executable-docs mechanism | Its product-media analog | The analog passes when |
|---|---|---|
| Rust "compiles and runs" doc test | a demo re-rendered from a storyboard | every selector resolves and each navigation lands |
| Go `Example` with `// Output:` | a named still frame with a committed baseline | the re-captured PNG matches its golden |
| Python `>>>` output match | a screenshot re-shot from a spec and diffed | the pixels match within a threshold |
| Sphinx `make doctest` in CI | a scheduled re-render on the build server | the render passes against today's build |
| Elixir `iex>` doctest | the resolved action-spec, run as a check | the flow still resolves against the live UI |

The finished asset, the screenshot in the README or the sixty-second walkthrough on the docs page, doubles on that very render as proof the asset is not lying. That is the whole thesis of [treating a demo as code you regenerate rather than a recording you own](/blog/automated-product-demo-videos).

## Two gates hide in one word: does it run, and does it match

The Rust-versus-Go split is not a style preference. It is two different tests with two different price tags, and porting it to media saves you from the most common mistake in visual testing. A Rust doc test that only has to compile and run is cheap and almost never flaky, because it asserts behavior, not appearance. Its media twin is the behavior gate: re-render the demo and pass if every selector resolved to a real element and every navigation reached the page it was meant to. That check is deterministic text, it reads as a small clean diff in review, and it trips on the one thing that actually breaks a demo, a click that misses the button that moved, while staying quiet when only the paint changed.

A Go example that must match `// Output:` byte for byte is the other gate, and it is where flakiness lives. Its media twin is the pixel or still-frame golden: capture the frame, diff it against a blessed baseline, fail on any difference. It catches visual regressions the behavior gate cannot see, and it pays for that reach with brittleness. Which layer to freeze, the resolved action-spec, a handful of key frames, or every pixel, is a decision with real consequences, [worked through in the golden-file piece](/blog/testing-demos-like-code). The short version matches the doctest world: reach for the run gate first, and add the match gate only where appearance is the thing under test.

## doctest already solved the flakiness you are about to meet

Anyone who has written a doctest for a function that prints a dictionary or a memory address has met the output-match gate's dark side: the example is correct, the behavior is correct, and the test fails anyway because something irrelevant changed. Python's answer is a set of directives. `NORMALIZE_WHITESPACE` makes "all sequences of whitespace (blanks and newlines) ... treated as equal," `ELLIPSIS` lets a `...` marker "match any substring in the actual output," and `SKIP` drops an example from the run while keeping it in the docs ([Python docs, accessed July 2026](https://docs.python.org/3/library/doctest.html)). Go ships the same admission in miniature: an `Unordered output:` comment "matches any line order," for output whose sequence is not meaningful ([Go docs, accessed July 2026](https://pkg.go.dev/testing)).

Every one of those directives has a pixel-side twin, and if you skip them your visual gate will flap until someone quietly disables it. A live clock in the corner, a rotating avatar, an animation mid-frame, a randomized dashboard: each is the media version of a memory address in a doctest, real output with a meaningless difference. The fixes rhyme with the directives. Mask the dynamic region so the diff ignores it, the way `ELLIPSIS` ignores a substring. Set a perceptual threshold instead of demanding an exact match, the way `NORMALIZE_WHITESPACE` loosens the comparison. Freeze the clock and disable animations before the shot, so there is nothing left to normalize. Tuning that noise floor is [its own detection-versus-false-positive problem](/blog/detecting-ui-drift), and it is the reason the cheaper run gate belongs first.

## Where it runs is the point: from make doctest to the nightly render

A doctest that never runs is a comment. The reason the pattern works is that it rides a command the team already types: `cargo test`, `mix test`, `make doctest` in the docs build. The example is checked because checking it costs nothing extra, stapled to the test run that gates every merge. Media inherits the same requirement and the same solution. A screenshot or demo that regenerates from a spec has to regenerate somewhere automatic, which is a CI job and not a good intention: on the commit that touched the UI, or on a nightly cron for the drift that seeps in through data and dependencies rather than a tidy diff.

Our own engine, aidemo, freezes the run gate for browser demos this way. `aidemo probe --golden` replays a storyboard's action-spec and exits non-zero when a selector or navigation drifts, and it is honest about its edges: browser flows only, a storyboard an agent authors rather than a timeline you drag, and no GUI editor anywhere in the loop. The tool is beside the point. The point is the discipline the doctest normalized decades ago. An example nobody runs is documentation you are only hoping is true, and hope is not a test. Wire the check to the build, and [a video documentation library stays as honest as the prose around it](/blog/video-documentation).

## Sources

- [Python — doctest module (searches interactive sessions and executes them; 'executable documentation'; NORMALIZE_WHITESPACE / ELLIPSIS / SKIP)](https://docs.python.org/3/library/doctest.html)
- [Rust — Documentation tests (rustdoc runs doc examples as tests; passes if they compile and run without panicking)](https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html)
- [Go — testing package (Example functions compiled and executed; // Output: comparison; Unordered output:)](https://pkg.go.dev/testing)
- [Sphinx — sphinx.ext.doctest (test snippets so the documentation stays up-to-date with the code)](https://www.sphinx-doc.org/en/master/usage/extensions/doctest.html)
- [Elixir — ExUnit.DocTest (generate tests from code examples in @moduledoc and @doc)](https://ex-unit.hexdocs.pm/ExUnit.DocTest.html)

## FAQ

### What is executable documentation?

Executable documentation is documentation whose examples run as tests. Instead of a code sample a human promises to keep accurate, the sample is executed on every build and the build fails if its output no longer matches the code. Python's doctest docs name this outright as "literate testing" or "executable documentation." The effect is that the docs cannot silently drift from behavior, because a drift turns into a red build, and the same principle extends to product media: a screenshot or demo that re-captures the live UI is executable documentation for the interface.

### What is a doctest, and what does it check?

A doctest is an example embedded in documentation that a test runner executes to confirm it still works. Python's doctest reads `>>>` interactive sessions in docstrings, Rust's rustdoc runs fenced code blocks in `///` comments, Go compiles `Example` functions and compares their output to an `// Output:` comment, and Elixir turns `iex>` lines in `@doc` into ExUnit cases. Depending on the language it checks one of two things: that the example still compiles and runs, or that its output still matches exactly. Either way the example is the assertion, so nobody has to remember to keep the docs in sync by hand.

### Can a screenshot or demo video work like a doctest?

Yes, with one adjustment for the medium. A code doctest can store its expected output inline as text; a screenshot or demo produces pixels, so the expectation lives as a committed baseline (a golden image) or as a resolved action-spec instead. Re-capture the media from its spec against the live product, diff it against that baseline, and the asset fails when the UI moves, the same guarantee a doctest gives code. The cheap version checks only that the demo's flow still resolves; the expensive version checks that the frame still looks right.
