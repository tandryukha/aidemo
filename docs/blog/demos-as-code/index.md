# Demos as code: commit the storyboard, render the video

July 18, 2026 · Demos as Code · 10 min read · https://aidemo.top/blog/demos-as-code/

> A recording is a performance you own and maintain. A spec is text you can diff, review, regenerate, and hand to an agent. That decides everything downstream.

**Key takeaways**

- A demo descends from one of two things: a captured performance (a binary you maintain) or a committed spec (text you diff, review, and regenerate). The form decides everything downstream.
- Only a spec gives you four properties: diffable (one-line git diff), reviewable (a PR, not a black-box asset), regenerable (footage is build output), and agent-authorable.
- The infrastructure-as-code analogy holds for declarative desired state and plan/apply but snaps twice: a demo spec has no status field and does not own its target — it is closer to tests-as-code.
- vhs has shipped golden-file testing since October 2022: one .tape diffs its .txt output against a committed golden, so the demo and the regression test are the same artifact.
- A coding agent can emit a storyboard's selectors and narration but cannot perform a screen take; keeping the model out of the capture loop is what makes agent-made demos shippable.

## Two answers to "what is this demo"

A finished demo is a file: an MP4, a GIF, a blob of pixels and audio. But that file can descend from two entirely different kinds of thing, and which one you pick decides everything you can do with the demo afterward.

The first kind is a captured performance. Someone drove the product, a recorder watched, and the footage is the artifact. You can trim it, caption it, upload it, but the recording is the source of truth, and the only way to change what it shows is to perform the flow again.

The second kind is a committed spec. The artifact is not the video; it is a text file that says where to go, what to click, and what to narrate, and a deterministic player turns that text into footage on demand. The video is output, the way a compiled binary is output. The source is the spec, and it sits in the repo next to the code it depicts.

This is a different cut than the one the [automated-demo taxonomy](/blog/automated-product-demo-videos) makes. That piece sorts tools by what they automate — the edit, the clip swap, the drawn frame, the replay — and asks which mechanism survives a UI change. This one is upstream of it: it asks what the demo *is*. Answered that way, only two ontologies exist, and everything else is a detail of how well a given tool executes one of them.

Pick "captured performance" and the demo is a document you own and maintain by hand. Pick "committed spec" and four things become true that a recording can never offer.

## Four things become true when the demo is text

**Diffable.** A change to the demo is a line in a diff. Relabel a button in the flow and the storyboard shows a one-line change; `git blame` says who changed it and when. A recording has no diff. Two MP4s that differ by one relabeled button are two unrelated binaries, and the only comparison a human can run is watching both and squinting.

**Reviewable.** Because the change is a diff, it can go through review. A pull request that alters what the demo shows gets the same treatment as one that alters code: someone reads it, comments, approves. Marketing reviews the words, engineering reviews the selectors. The asset that used to skip the entire quality gate — because it was a binary nobody could read — now rides inside it. Jest's guidance for its snapshot artifacts says the quiet part aloud: a snapshot "should be committed alongside code changes, and reviewed as part of your code review process" ([Jest, accessed July 2026](https://jestjs.io/docs/snapshot-testing)). A demo spec is the same kind of object.

**Regenerable.** The footage is build output. Delete the MP4 and rebuild it from the spec, the way you delete `dist/` and rebuild it from source. That reframes three things at once: storage (commit the spec, treat the video as a cache), staleness ([regenerate against the current build](/blog/automated-product-demo-videos) instead of re-shooting), and reach (one spec fans out into [many localized renders](/blog/multi-language-product-demo-videos) without a second take). The output is separable from the source, so the source can be small and the output disposable.

**Agent-authorable.** This property has the longest reach, so it gets its own section below. A coding agent can write a spec. It cannot perform a take.

| Property | The mechanism | What a recording gives you instead |
|---|---|---|
| Diffable | the spec is text; `git diff` shows the exact change | two binaries; the only comparison is watching both |
| Reviewable | the change is a pull request, read and approved | an asset that bypasses the quality gate |
| Regenerable | footage is build output, rebuilt from the spec | a source file you must re-perform to change |
| Agent-authorable | a model emits structured text on demand | a performance no model can hold a mouse to do |

## The infrastructure-as-code analogy, and exactly where it snaps

The comparison writes itself: a demo spec is to a video what a Terraform file is to a server. It is mostly right, and the useful work is finding the seam where it stops being right.

Three things carry over cleanly. Terraform configs "are declarative, meaning that they describe the end state of your infrastructure," defined in "human-readable configuration files that you can version, reuse, and share" ([HashiCorp, accessed July 2026](https://developer.hashicorp.com/terraform/intro)); a storyboard is declarative about the demo's end state and lives in the same kind of versioned file. Terraform's workflow is write, then plan, then apply; a demo pipeline has the same shape, where a dry run walks the flow without rendering and the render is the apply. And both are reproducible: same spec, same build, same result, which is the property that makes rebuilding in CI possible at all.

Then the analogy snaps, in two places.

The first seam is that infrastructure-as-code closes a loop the demo does not. A Kubernetes object carries a `spec` for the desired state and a `status` for the actual one, and "the Kubernetes control plane continually and actively manages every object's actual state to match the desired state you supplied" ([Kubernetes, accessed July 2026](https://kubernetes.io/docs/concepts/overview/working-with-objects/)). Terraform keeps a state file as its source of truth and computes the drift between config and reality. A demo spec has neither. It encodes intent — go here, click this, say that — and "a record of intent" is exactly what Kubernetes calls its objects, but no daemon watches the product to report that the intent has gone wrong. Run the spec against a build whose button moved and you get a video of the flow breaking or, worse, a clean render of the wrong thing. The spec regenerates. It does not, on its own, know it should have complained.

The second seam is that the target is not yours to declare. Terraform owns the infrastructure it describes; applying the config makes reality conform. A demo spec owns nothing. It observes a product it did not create and navigates state the app already holds. That makes the demo spec downstream of the real source of truth, which is the product's own code — so "demos as code" is less like infrastructure-as-code and closer to tests-as-code: an assertion that runs against a system it does not control.

| Infrastructure-as-code property | Holds for a demo spec? | The seam |
|---|---|---|
| Declarative, version-controlled desired state | Yes | the storyboard describes the demo's end state in a committed file |
| Plan, then apply | Yes | dry-run the flow, then render |
| Reproducible from the spec alone | Yes | same spec plus same build gives the same footage |
| A status field and reconciler that detect drift | No | nothing watches the product; the spec cannot tell it went stale |
| The spec owns the target it describes | No | it observes the product, it does not declare it — downstream, not source |

The fix for the first seam is hiding inside the second reframe. If the demo is a test, give it what tests have: a recorded expectation to fail against.

## The demo that is also a test — vhs made the terminal case ordinary

That fix has shipped in the terminal world since October 2022, when Charmbracelet released vhs. It reads a `.tape` file and renders a terminal recording, and the same tape has a second output built for this exact gap. The docs point past demos to tests: "VHS can also be used for integration testing," turning a tape's `.txt` or `.ascii` output into "golden files" you "store in a git repository to ensure there are no diffs between runs of the tape file" ([Charmbracelet, accessed July 2026](https://github.com/charmbracelet/vhs)).

That golden file is the missing status field. It is the recorded actual output; a diff against it on the next run is the reconciler the demo spec otherwise lacked. When the CLI's output changes, the golden changes, and CI fails loudly instead of quietly shipping a wrong GIF. The demo and the regression test are one artifact. It is the snapshot pattern — a reference "stored alongside the test" that fails "if the two snapshots do not match" ([Jest, accessed July 2026](https://jestjs.io/docs/snapshot-testing)) — aimed at a demo rather than a component tree.

The browser is the harder version of this idea and the more valuable one. Harder because a terminal is deterministic and a browser is not: animations, web fonts, network timing, and device-pixel ratio all conspire to make two runs of one flow produce two different frames, which is why [replaying a browser flow into identical footage](/blog/deterministic-browser-automation-for-video) is a real engineering problem and not a config flag. More valuable because the terminal is a niche and the browser is where the products people pay for actually live. A browser demo that golden-files a reference frame is, in the same run, a visual-regression test of the real UI and the marketing footage of it. aidemo, our engine, does exactly this: its probe step can write a golden of the action-spec and fail CI on drift, so the run that records the demo also asserts the product still matches. It is browser-only and its storyboard is agent-authored rather than dragged together in a timeline — real limits — but that double duty is the whole reason to treat the demo as code, and it slots straight into a job that already [re-renders on the commit that changed the UI](/blog/demo-videos-in-ci).

## A coding agent can write the spec, not perform the take

Of the four properties, agent-authorability is the one that moves the economics, because it changes *who* can make a demo at all. A language model is a text engine. Hand it the app and a schema and it can emit a storyboard: the selectors to click, the order to click them, the line to narrate over each step. That is structured text, the thing models do best.

What a model cannot do is the other ontology's core act. It cannot hold a mouse, feel the pacing, pause a beat before the reveal, and perform a screen recording that looks composed. A take is a performance; a spec is a document, and only one of those is in a language model's job description. So the design that makes agent-made demos shippable keeps the model out of the capture loop entirely: the agent explores the product and writes the spec, and a deterministic player — not the model — executes it. The recording is a replay of a fixed action-spec, repeatable and reviewable, and the judgment lives in the authoring, where a mistake is a diff you fix rather than a flubbed take you re-shoot.

The industry is converging on the same insight from the synthetic side. Remotion, which renders video from React, now leads with "Make videos programmatically" and "Use coding agents" ([Remotion, accessed July 2026](https://www.remotion.dev/)), because code is the interface an agent can drive. The difference for a product demo is what that code renders. Remotion draws frames, so an agent authors a rendition of your app; a real-UI replay captures frames, so the agent authors a walkthrough of the actual app. Both are legitimate; they answer different questions, and [the programmatic-video landscape](/blog/video-as-code-tools) splits exactly along that line. The [coding-agent demo workflow](/blog/coding-agents-that-make-demo-videos) is a spoke of its own. The point here is narrower: agent-authorability is not a feature bolted onto a video tool. It is a consequence of the demo being code.

## When "as code" is the wrong frame

Treating a demo as code earns its keep when the demo has a maintenance horizon — when it will outlive the UI it shows and someone would otherwise re-record it on every ship. It is the wrong frame for a demo with no future, and the honest pitch says so.

- **A launch film with a person on camera, art-directed shot by shot.** Its value is charisma and editing taste, and a spec cannot author taste. That is a performance. Record it, cut it, ship it once.
- **A sizzle reel you need this week and never again.** The up-front cost of writing a spec buys nothing if you will never regenerate. A screen recorder is faster and fine.
- **A demo you want to assemble by hand in a visual timeline.** Code-first tools trade the drag-and-drop editor for the diff. If you want the timeline, that is a different tool: [the Screen Studio alternatives map](/blog/screen-studio-alternatives) covers the recorder lane, and [how to make a product demo video](/blog/how-to-make-a-product-demo-video) covers the craft that applies to either ontology.

The rule reduces to one question about the demo's lifespan. If it is a thing you make once, a recording is often the faster answer. If it is a thing you keep — bound to a product that ships every week, rebuilt in CI, reviewed like code, and increasingly authored by an agent — then the demo wants to be a spec and the video wants to be what the spec builds. The terminal proved the pattern. The browser is where it pays.

## Sources

- [HashiCorp — What is Terraform (infrastructure as code, declarative, plan/apply)](https://developer.hashicorp.com/terraform/intro)
- [Kubernetes — Objects, spec/status, and the desired-state control loop](https://kubernetes.io/docs/concepts/overview/working-with-objects/)
- [Charmbracelet vhs — terminal GIFs as code, golden-file integration testing](https://github.com/charmbracelet/vhs)
- [Jest — Snapshot testing (commit the snapshot, review it, fail on mismatch)](https://jestjs.io/docs/snapshot-testing)
- [Remotion — make videos programmatically with React and coding agents](https://www.remotion.dev/)

## FAQ

### Is "demos as code" the same thing as infrastructure as code?

It borrows the shape but not the whole model. Like Terraform, a demo spec is a declarative, version-controlled description of a desired end state that you plan and then apply. Unlike Terraform or Kubernetes, it has no status field and no reconciler watching the target, and it does not own what it describes — it observes a product it did not create. That makes it closer to tests-as-code than to infrastructure-as-code: an assertion that runs against a system it cannot control, which is why golden-file diffing matters so much.

### Can a coding agent make a product demo video by itself?

An agent can author the spec, not perform the take. Language models are strong at emitting structured text, so writing a storyboard of selectors, click order, and narration is squarely in scope. Driving a mouse with good pacing and composing a screen recording is not. The workable pattern keeps the model out of the capture loop: it writes the spec, a deterministic player renders it, and the output stays repeatable and reviewable rather than a one-off performance you cannot reproduce.

### If the demo is a spec, do I still commit the video file?

Usually not the video, always the spec. Once the footage is build output, the spec is the source of truth and the MP4 or GIF is a cache you can rebuild any time from the current product, so many teams commit only the spec and regenerate the video in CI. The exception is distribution: an embed needs a stable URL, so the rendered file lands somewhere durable — a committed asset, a release attachment, or a hosted path — even though its authority still comes from the spec that produced it.
