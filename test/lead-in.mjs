// Built-in capture: timeline.json must place each scene on the frame where it
// starts (issue #94). Closing the browser context keeps the recording running,
// so that footage is tail, not lead-in; counted as lead-in it shifts every scene
// late by the length of the close, and compose shows footage ahead of narration.
//
//   npm run test:lead-in        (needs system Chrome + ffmpeg on PATH)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { Project } from "../src/project.ts";
import { record } from "../src/recorder.ts";

const TMP = mkdtempSync(join(tmpdir(), "aidemo-leadin-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const FPS = 50;
/**
 * A scene's start and its first frame differ by the navigation + first paint.
 * Typically under 150 ms, up to ~650 ms on a cold Chrome whose first frame is
 * late. The bug this guards against is off by seconds on these takes.
 */
const TOLERANCE_MS = 800;

const page = (hex) => `data:text/html,<body style='margin:0;background:%23${hex}'></body>`;

/** ms of the first frame of each colour in the video, measured from its pixels. */
function firstFrames(video) {
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", video, "-vf", `fps=${FPS},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 1 << 28 }
  );
  const first = {};
  for (let i = 0; i * 3 < raw.length; i++) {
    const [r, g, b] = raw.subarray(i * 3, i * 3 + 3);
    const name = r > 200 && g < 70 && b < 70 ? "red" : b > 200 && r < 70 && g < 70 ? "blue" : null;
    if (name && first[name] === undefined) first[name] = Math.round((i * 1000) / FPS);
  }
  return first;
}

async function take(name, pauseMs) {
  const dir = join(TMP, name);
  const project = new Project(dir);
  mkdirSync(dirname(project.storyboardPath), { recursive: true });
  writeFileSync(
    project.storyboardPath,
    JSON.stringify({
      title: "Lead-in",
      video: { width: 640, height: 360 },
      scenes: [
        { id: "red", narration: "Red.", actions: [{ op: "goto", url: page("f00") }, { op: "pause", ms: pauseMs }] },
        { id: "blue", narration: "Blue.", actions: [{ op: "goto", url: page("00f") }, { op: "pause", ms: pauseMs }] },
      ],
    })
  );
  await record(project, await project.loadStoryboard(), { headed: false, fresh: true });
  const timeline = JSON.parse(readFileSync(project.timelinePath, "utf8"));
  return { timeline, first: firstFrames(project.rawVideoPath) };
}

for (const [name, pauseMs] of [["short", 1500], ["long", 4000]]) {
  test(`timeline places each scene on its first frame (${name} take)`, async () => {
    const { timeline, first } = await take(name, pauseMs);
    for (const scene of timeline.scenes) {
      const placed = timeline.leadInMs + scene.startMs;
      const diff = placed - first[scene.id];
      console.log(`${name} ${scene.id}: placed ${placed}ms, first frame ${first[scene.id]}ms, diff ${diff}ms (lead-in ${timeline.leadInMs}ms)`);
      assert.ok(Math.abs(diff) <= TOLERANCE_MS, `${scene.id} is ${diff}ms off its first frame`);
    }
  });
}
