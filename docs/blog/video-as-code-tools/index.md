# Video-as-code tools: Remotion, Revideo, editly, vhs — and real-UI capture

July 18, 2026 · Demos as Code · 6 min read · https://aidemo.top/blog/video-as-code-tools/

> Remotion and Revideo draw every frame, editly stitches clips, vhs replays a terminal, real-UI capture films your product. Five models, one map.

**Key takeaways**

- "Video as code" hides five programming models: React components (Remotion), generator scenes (Revideo), JSON clips (editly), a terminal tape (vhs), and a browser action-spec (real-UI capture).
- The real split is drawn vs captured pixels: Remotion and Revideo render frames in a headless Chrome from code you wrote; capture replays the actual product UI.
- Synthetic compositions never notice a product change — they are a second implementation; a real-UI capture breaks when a selector moves, and that break is the signal.
- Iteration differs: Remotion and Revideo hot-reload in a dev studio; editly, vhs, and capture re-render from the spec.
- Fit by job: motion graphics and data-driven renders to Remotion/Revideo, CLI tools to vhs, product demos to real-UI capture, batch clip edits to editly.

## "Video as code" is five programming models, not one label

Type "programmatic video" or "video as code" into a search box and you get five tools that share exactly two things: a text file goes in, an MP4 comes out. Everything between those two facts is different. The register is different, the runtime is different, and — the thing that determines whether a tool can depict your live product at all — where the pixels come from is different. Comparing them on feature checklists misses this, because a checklist flattens the one distinction that matters: the programming model.

Four questions pull the models apart. What is the source of truth, the file you actually edit? What are the pixels — frames your code draws, media it composes, or a real session it replays? How tight is the iteration loop between an edit and seeing it? And what happens the day your product's UI changes underneath the demo? These five tools also sit inside a broader [four-mechanism map of demo generators](/blog/ai-demo-video-generators); this piece is the engineering cross-section of the code-driven ones.

| Tool | Programming model | Source of truth | What the pixels are |
|---|---|---|---|
| Remotion | React components + `useCurrentFrame` | a component tree you wrote | frames your code draws, screenshotted in headless Chrome |
| Revideo | TypeScript generator scenes | a scene function you wrote | frames your code draws on a canvas in a browser |
| editly | declarative JSON edit spec | a clips/layers array plus your media | existing clips, images, and titles composed by ffmpeg |
| vhs | imperative `.tape` DSL | a tape script | a real terminal session, replayed |
| Real-UI capture (aidemo, ours) | declarative browser action-spec | a storyboard of steps | the actual product UI, replayed in real Chrome |

## Remotion and Revideo: code that draws every frame

Remotion hands you "a frame number and a blank canvas, to which you can render anything you want using React" ([Remotion, July 2026](https://www.remotion.dev/docs/the-fundamentals)). The frame is a hook; a video is one component evaluated once per frame, with animation expressed as a function of the frame number:

```tsx
import { useCurrentFrame, interpolate } from "remotion";

export const FadeIn = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 60], [0, 1], {
    extrapolateRight: "clamp",
  });
  return <div style={{ opacity }}>Ship it</div>;
};
```

To turn that into a file, Remotion drives a browser: it "is automatically installing Chrome Headless Shell into your `node_modules` in order to render videos" ([Remotion, July 2026](https://www.remotion.dev/docs/chrome-headless-shell)), screenshots each frame, and hands the sequence to ffmpeg. Revideo takes the same premise with a different grammar. A scene is a generator function you step through with `yield*`, an imperative style the Motion Canvas project popularized:

```tsx
export default makeScene2D('scramble', function* (view) {
  view.fill('#0d0d12');
  const cube = createRef<RubiksCube>();
  view.add(<RubiksCube ref={cube} size={620} />);
  yield* waitFor(0.5);
  yield* cube().scramble(18);
});
```

Revideo describes itself as a code-first rendering engine that "borrows concepts from Remotion and Rive" and runs "anywhere Node and a headless browser run" ([Revideo, July 2026](https://github.com/midrender/revideo)). React components versus TypeScript generators is a real ergonomic choice, but it is a small one next to the property both tools share: every pixel is something your code drew. None of it came from your product unless you first rebuilt the product in React or on a canvas — a second implementation to write and then keep in sync.

## editly and vhs: compose clips, or replay a terminal

editly drops a level of abstraction. It is "a tool and framework for declarative NLE (non-linear video editing) using Node.js and ffmpeg" ([editly, July 2026](https://github.com/mifi/editly/blob/master/README.md)); the source of truth is a JSON or JSON5 edit spec — an array of clips, each a stack of layers:

```json5
{
  clips: [
    { layers: [ { type: 'title', text: 'Hello' } ] }
  ]
}
```

Past `title`, the layer types include `video` and `image`, so the pixels editly emits are the media you feed it: clips cut, resized, captioned, and concatenated with transitions. It arranges footage and captures none. If you do not already have a recording of your product, editly has nothing of your product to show — it is a compositor, not a camera.

vhs is the terminal's version of the instinct, and the only model here that is both imperative and captures something real. A `.tape` file is a script of keystrokes and pauses ([Charm, July 2026](https://github.com/charmbracelet/vhs/blob/main/README.md)):

```
Output demo.gif

Set FontSize 46
Set Width 1200
Set Height 600

Type "echo 'Welcome to VHS!'"

Sleep 500ms

Enter
```

vhs runs that tape against an actual shell — it needs `ttyd` and `ffmpeg` on your PATH — and records the true output. The pixels are your CLI's real behavior, not an illustration of it, which is why the same tape doubles as an integration test: the README ships a golden-file workflow that diffs a tape's text output between runs so a changed CLI fails the check.

## Real-UI capture: an action-spec the browser replays

The browser version of that bet is a storyboard: a declarative list of steps a deterministic player replays against the running product in real Chrome. aidemo, our engine, uses this model — browser-only, MIT-licensed, and with the storyboard authored by a coding agent rather than dragged together in a timeline editor:

```json
{
  "scenes": [
    {
      "id": "s1",
      "narration": "Just tell the app what you need.",
      "actions": [
        { "op": "goto", "url": "https://app.example.com/" },
        { "op": "type", "target": { "selector": "#search" }, "text": "whey isolate under 30 euros" },
        { "op": "click", "target": { "selector": "#search-btn" } },
        { "op": "waitForWidget", "target": { "selector": "[data-testid=product-card]" } }
      ]
    }
  ]
}
```

The source of truth is the action-spec; the pixels are whatever the live app paints. That is the entire gap between this and Remotion or Revideo: capture does not draw a picture of the product, it films the product. The cost is determinism — replaying one flow into identical frames twice, while animations, web fonts, and network timing all pull the other way, is its own [engineering problem](/blog/deterministic-browser-automation-for-video). The upside is authorship: because a language model emits structured steps well but cannot perform a screen recording, an action-spec is precisely the artifact a [coding agent can write](/blog/coding-agents-that-make-demo-videos), where a captured performance is not.

## Iteration loop and the moment your UI changes

Two axes separate these models in daily use: how fast an edit shows up, and what happens when the thing on screen moves.

| Model | Iteration loop | When the product UI changes |
|---|---|---|
| Remotion | hot-reload Studio; edit the component, the preview updates | nothing — a re-implementation of your UI cannot know the real one moved; the video drifts, quietly |
| Revideo | live `<Player/>` preview and dev server | nothing; a synthetic scene has no wire to the product |
| editly | re-run the render; no live preview of the whole edit | nothing; it knows only the media you handed it |
| vhs | re-render the tape, seconds for a short one | the real CLI runs again; changed output appears, and a golden diff can fail CI on it |
| Real-UI capture | re-render: probe the flow, then record | a moved selector misses or a frame differs — it breaks, out loud |

The decisive column is the last one. Remotion, Revideo, and editly cannot notice a product change, because the product was never in their loop — their frames are drawn or composed from inputs you control, so they keep rendering a confident, wrong picture until a person catches the drift. A capture is coupled to the live UI, so when a selector moves, the run fails. That failure looks like fragility and is closer to a smoke alarm: a demo that breaks when the product changes has just told you it went out of date, where a demo that never breaks is one you have to remember to re-check by hand. Treating that break as a golden-file signal rather than a nuisance is the core of the [demos-as-code](/blog/demos-as-code) argument, and it is what buys back the determinism tax capture charges.

## Which model fits which video

None of these wins in the abstract; each owns a job. Name the video and the table collapses to a row.

| Your video | Reach for | Why |
|---|---|---|
| Motion graphics, animated explainer, title sequence | Remotion or Revideo | full control over synthetic frames; no real UI has to appear |
| A command-line tool | vhs | a tape replays the real shell and doubles as a regression test |
| A product or web-UI walkthrough | real-UI capture (aidemo, ours) | it films the running product and breaks loudly when the UI moves |
| Data-driven video at scale (many renders off a dataset) | Remotion or Revideo | frames are a function of props, so one composition renders N deterministic variants |
| Batch edits or stitching clips you already have | editly | a declarative edit over existing media, no capture involved |

One axis this comparison sets aside on purpose is licensing and install friction, which cut across every model and can settle the choice by themselves — Remotion's source-available terms, editly's native build step. Those are scored tool by tool in [the open-source demo tooling breakdown](/blog/open-source-demo-video-tools). The order that works: pick the programming model that matches what your pixels have to be — drawn, composed, or captured — then confirm its license and toolchain fit before you build a pipeline on it.

## Sources

- [Remotion — The fundamentals (frame number and a blank canvas, React)](https://www.remotion.dev/docs/the-fundamentals)
- [Remotion — useCurrentFrame() (frame-driven animation)](https://www.remotion.dev/docs/use-current-frame)
- [Remotion — Chrome Headless Shell (renders via a headless browser)](https://www.remotion.dev/docs/chrome-headless-shell)
- [Revideo — GitHub repository (rendering engine, generator scenes)](https://github.com/midrender/revideo)
- [editly — GitHub README (declarative NLE over Node.js and ffmpeg)](https://github.com/mifi/editly/blob/master/README.md)
- [Charm vhs — GitHub README (terminal GIFs as code, ttyd + ffmpeg)](https://github.com/charmbracelet/vhs/blob/main/README.md)
- [aidemo — GitHub repository (our engine, disclosed as ours)](https://github.com/tandryukha/aidemo)

## FAQ

### Is Remotion or Revideo better for a product demo?

For a product demo, the honest answer is neither, and the reason is the same for both. Remotion draws frames from React and Revideo draws them from TypeScript generator scenes, so each renders a picture of a UI you rebuild in code, not your live product. They are excellent for motion graphics, explainers, and data-driven renders where the frames are meant to be synthetic. When the video needs to prove that the actual product works, a model that captures the running UI fits the job better; Remotion versus Revideo is then a question about which motion-graphics ergonomics you prefer.

### Can you make a video from JSON without writing code?

Partly. editly renders from a declarative JSON or JSON5 edit spec — an array of clips and layers — so you can produce a composed video by writing configuration rather than a program. The catch is that it composes media you supply; the JSON arranges clips, images, and titles but captures nothing on its own, so you still need the underlying footage. A browser action-spec is also close to configuration-only, but it drives a real browser, so it captures a live UI instead of arranging clips you already have.

### What is the difference between drawing frames and capturing them?

Drawing means your code produces every pixel: Remotion and Revideo evaluate a component or scene per frame and screenshot the result, so the output is exactly what you programmed and nothing else. Capturing means a tool records a real session: vhs replays a shell and films its true output, and real-UI capture replays a flow in a browser and films the running app. The practical consequence is coupling. Drawn frames never react to a product change because the product is not present; captured frames break when the product changes, which is the signal that the demo needs a fresh render.
