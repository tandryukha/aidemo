// End-to-end store media from imported clips (no device): native-record's
// clip import → store-video (App Preview + Play landscape) → store-screenshots,
// all validated against the store specs. Needs ffmpeg + Chrome, so it is not
// part of `npm test`.
//
//   npm run test:store
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Project } from "../src/project.ts";
import { runFfmpeg } from "../src/ffmpeg.ts";
import { nativeRecord } from "../src/native/record.ts";
import { storeVideo } from "../src/store/video.ts";
import { storeScreenshots } from "../src/store/screenshots.ts";
import { readImageHeader } from "../src/store/validate.ts";

let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "aidemo-store-"));
  await mkdir(join(dir, "clips"), { recursive: true });
  await mkdir(join(dir, "generated"), { recursive: true });
  // Half-size iPhone 6.9" (1320x2868 → 660x1434): 8 s of motion, then 3 s
  // frozen (a wait the edit must ramp away).
  await runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=s=660x1434:r=30:d=8",
    "-vf", "tpad=stop_mode=clone:stop_duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(dir, "clips", "a.mp4"),
  ]);
  await runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=s=660x1434:r=30:d=6",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(dir, "clips", "b.mp4"),
  ]);
  await runFfmpeg(["-f", "lavfi", "-i", "testsrc2=s=660x1434:r=1:d=1", "-frames:v", "1", join(dir, "clips", "frame.png")]);
  await runFfmpeg(["-f", "lavfi", "-i", "color=c=0x22aa66:s=256x256:d=1", "-frames:v", "1", join(dir, "clips", "icon.png")]);
  await writeFile(
    join(dir, "generated", "store.json"),
    JSON.stringify({
      title: "Store fixture",
      device: { platform: "ios" },
      brand: { accent: "#7ee08a" },
      scenes: [
        { id: "a", clip: "clips/a.mp4", caption: "Say it. *It's logged.*", tailHoldMs: 600, localized: { ru: { caption: "Скажите — и готово." } } },
        { id: "b", clip: "clips/b.mp4", caption: "Every number one tap to fix.", holds: [{ fromMs: 2000, toMs: 4000 }] },
      ],
      video: { presets: ["app-store-preview", "play-promo-landscape"] },
      endCard: { appName: "Fixture", icon: "clips/icon.png", line: "Free on the App Store" },
      screenshots: {
        presets: ["ios-6.9", "play-phone"],
        shots: [{ id: "voice", frame: "clips/frame.png", headline: "Say it. *Logged.*", subhead: "Voice, photo or barcode" }],
        featureGraphic: { headline: "Log food by *voice*", frame: "clips/frame.png" },
      },
    })
  );
});

after(async () => {
  if (dir && !process.env.AIDEMO_KEEP_TMP) await rm(dir, { recursive: true, force: true });
});

test("imported clips → App Preview + Play promo that pass the store specs", { timeout: 600000 }, async () => {
  const project = new Project(dir);
  await project.ensureDirs();
  const tl = await nativeRecord(project);
  assert.deepEqual(tl.scenes.map((s) => s.id), ["a", "b"]);
  const results = await storeVideo(project);
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.deepEqual(r.report.errors, []);
    const report = JSON.parse(await readFile(r.reportFile, "utf8"));
    // 8 s motion + 3 s still → 0.25 s + 0.6 s tail hold, 6 s, 2 s end card ≈ 16.85 s
    assert.ok(r.durationMs > 16000 && r.durationMs < 17700, String(r.durationMs));
    assert.ok(report.scenes[0].segments.some((s) => s.kind === "still"));
    const poster = readImageHeader(await readFile(r.poster));
    assert.equal(poster.hasAlpha, false);
  }
  assert.equal(results[0].report.facts.size, "886x1920");
  assert.equal(results[1].report.facts.size, "1920x1080");
});

test("localized captions are a text swap", { timeout: 600000 }, async () => {
  const project = new Project(dir);
  const [r] = await storeVideo(project, { presets: ["app-store-preview"], lang: "ru" });
  assert.match(r.file, /app-store-preview\.ru\.mp4$/);
  assert.deepEqual(r.report.errors, []);
});

test("screenshot sets + feature graphic at exact store sizes, opaque", { timeout: 300000 }, async () => {
  const project = new Project(dir);
  const shots = await storeScreenshots(project);
  const sizes = shots.map((s) => [s.preset, s.report.facts.size]);
  assert.deepEqual(sizes, [
    ["ios-6.9", "1320x2868"],
    ["play-phone", "1080x1920"],
    ["play-feature-graphic", "1024x500"],
  ]);
  for (const s of shots) {
    assert.deepEqual(s.report.errors, []);
    if (s.preset !== "play-feature-graphic") assert.ok(s.screenFraction >= 0.7, `${s.preset} ${s.screenFraction}`);
  }
});
