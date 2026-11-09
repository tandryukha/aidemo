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
import { mergeSameScreen, sceneFilter, storeVideo } from "../src/store/video.ts";
import { planScene } from "../src/store/plan.ts";
import { videoLayout } from "../src/store/render-html.ts";
import { probeDurationMs, probeFreezeSpans } from "../src/ffmpeg.ts";
import { storeScreenshots } from "../src/store/screenshots.ts";
import { readImageHeader } from "../src/store/validate.ts";
import { brandCss, screenshotHtml, shotLayout } from "../src/store/render-html.ts";
import { launchChrome } from "../src/browser.ts";

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
        // screenshot-only: recorded (imported) but never in the video — the durations below stay the same
        { id: "shot", clip: "clips/b.mp4", inVideo: false },
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
  assert.deepEqual(tl.scenes.map((s) => s.id), ["a", "b", "shot"]);
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

test("a failing scene keeps the scenes recorded before it in the timeline (then --only merges)", { timeout: 120000 }, async () => {
  const pdir = await mkdtemp(join(tmpdir(), "aidemo-native-"));
  try {
    await mkdir(join(pdir, "generated"), { recursive: true });
    await writeFile(join(pdir, "generated", "store.json"), JSON.stringify({
      title: "Partial run", device: { platform: "ios" }, video: { presets: ["app-store-preview"] },
      scenes: [
        { id: "one", steps: [{ op: "wait", ms: 1 }] },
        { id: "two", steps: [{ op: "wait", ms: 2 }] },
      ],
    }));
    let failTwo = true;
    const fake = {
      platform: "ios", id: "FAKE", name: "Fake", bootedByUs: false,
      screenSize: async () => ({ width: 660, height: 1434 }),
      startRecording: async (file) => ({ startedAtMs: Date.now(), stop: async () => { await writeFile(file, await readFile(join(dir, "clips", "b.mp4"))); return file; } }),
      screenshot: async () => {},
      runStep: async (st) => { if (st.ms === 2 && failTwo) throw new Error("flow failed"); },
      prepare: async () => async () => {},
      release: async () => {},
    };
    const project = new Project(pdir);
    await project.ensureDirs();
    await assert.rejects(nativeRecord(project, { device: fake }), /flow failed/);
    const partial = JSON.parse(await readFile(join(pdir, "generated", "native-timeline.json"), "utf8"));
    assert.deepEqual(partial.scenes.map((s) => s.id), ["one"]);
    failTwo = false;
    const tl = await nativeRecord(project, { device: fake, only: ["two"] });
    assert.deepEqual(tl.scenes.map((s) => s.id), ["one", "two"]);
  } finally {
    await rm(pdir, { recursive: true, force: true });
  }
});

test("a short screenshot headline keeps its full size (a display face overhanging its line-height is not overflow)", { timeout: 120000 }, async () => {
  // Bricolage-like metrics: tight line-height, glyphs taller than the line box.
  const brand = await brandCss({ weight: 800 }, (p) => p);
  const L = shotLayout(1320, 2868, 1320, 2868, { zoom: 1, bleed: "bottom" });
  const html = screenshotHtml(brand, L, { headline: "Say it. *It's logged.*", frameUri: "", device: "iphone", rawH: 2868 })
    .replace("line-height:1.06", "line-height:0.8");
  const browser = await launchChrome({ headless: true });
  try {
    const pg = await (await browser.newContext({ viewport: { width: 1320, height: 2868 } })).newPage();
    await pg.setContent(html, { waitUntil: "load" });
    const r = await pg.evaluate(async () => {
      await document.fonts.ready;
      const el = document.querySelector(".head");
      const before = parseFloat(getComputedStyle(el).fontSize);
      window.__fit();
      return { before, after: parseFloat(getComputedStyle(el).fontSize) };
    });
    assert.equal(r.after, r.before, `headline shrank ${r.before} → ${r.after}px though it fits its box`);
    // a headline that really is too long still shrinks
    await pg.setContent(screenshotHtml(brand, L, { headline: "word ".repeat(80), frameUri: "", device: "iphone", rawH: 2868 }), { waitUntil: "load" });
    const long = await pg.evaluate(() => {
      const el = document.querySelector(".head");
      const before = parseFloat(getComputedStyle(el).fontSize);
      window.__fit();
      return { before, after: parseFloat(getComputedStyle(el).fontSize) };
    });
    assert.ok(long.after < long.before);
  } finally {
    await browser.close();
  }
});

test("a scene with many sped-up segments renders exactly as long as its plan", { timeout: 120000 }, async () => {
  const clip = join(dir, "clips", "steps.mp4");
  // 20 s of short motion bursts between ~1 s stills: the edit squeezes each still to 500 ms.
  await runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=s=540x1200:r=30:d=20",
    "-vf", "select='lt(mod(t\\,1.1)\\,0.15)',setpts=N/30/TB,fps=30",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip,
  ]).catch(async () => runFfmpeg(["-f", "lavfi", "-i", "testsrc2=s=540x1200:r=30:d=20", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip]));
  const durationMs = await probeDurationMs(clip);
  const freezes = [];
  for (let t = 150; t + 950 < durationMs - 1000; t += 1100) freezes.push({ startMs: t, endMs: t + 950 });
  const plan = planScene({ durationMs, freezes, ramps: [], holds: [{ startMs: durationMs - 1000, endMs: durationMs }] });
  const layout = videoLayout(1080, 1920, 540, 1200);
  const overlay = join(dir, "clips", "over.png");
  await runFfmpeg(["-f", "lavfi", "-i", "color=c=black@0.0:s=1080x1920:d=1,format=rgba", "-frames:v", "1", overlay]);
  const out = join(dir, "clips", "steps-out.mp4");
  await runFfmpeg(["-i", clip, "-i", overlay, "-filter_complex", sceneFilter(plan, layout, 30), "-map", "[out]", "-an", "-r", "30", "-c:v", "libx264", "-preset", "ultrafast", out]);
  const got = await probeDurationMs(out);
  assert.ok(Math.abs(got - plan.outMs) <= 40, `rendered ${got} ms, plan ${plan.outMs} ms`);
});

test("touching stills merge only when they show the same screen (a blip), never across an instant cut", { timeout: 120000 }, async () => {
  const make = async (name, second) => {
    const clip = join(dir, "clips", name);
    await runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=s=320x640:r=30:d=1",
      "-f", "lavfi", "-i", "color=c=0x808080:s=320x640:r=30:d=0.9",
      "-f", "lavfi", "-i", "color=c=0x8c8c8c:s=320x640:r=30:d=0.0333",
      "-f", "lavfi", "-i", `color=c=${second}:s=320x640:r=30:d=0.9`,
      "-f", "lavfi", "-i", "testsrc2=s=320x640:r=30:d=1",
      "-filter_complex", "[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0,format=yuv420p[v]",
      "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", clip,
    ]);
    const raw = (await probeFreezeSpans(clip, 700)).filter((f) => f.endMs > 900 && f.startMs < 3000);
    return { raw, merged: await mergeSameScreen(clip, raw) };
  };
  const blip = await make("blip.mp4", "0x808080");
  assert.equal(blip.raw.length, 2, `freezedetect splits the still at the blip: ${JSON.stringify(blip.raw)}`);
  assert.equal(blip.merged.length, 1, JSON.stringify(blip.merged));
  const cut = await make("cut.mp4", "0x2050c0");
  assert.equal(cut.raw.length, 2, JSON.stringify(cut.raw));
  assert.equal(cut.merged.length, 2, `a new screen keeps its own still: ${JSON.stringify(cut.merged)}`);
});
