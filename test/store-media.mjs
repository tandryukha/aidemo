// Native capture + store media: the pure parts (no device, ffmpeg or Chrome).
// The end-to-end encode is test/store-render.mjs (`npm run test:store`).
//
//   npx tsx --test test/store-media.mjs      (part of `npm test`)
import assert from "node:assert/strict";
import { test } from "node:test";
import { clampSpans, DEFAULT_PLAN_OPTIONS, fitPlans, planScene, resolveHolds, resolveRamps, stillViolations } from "../src/store/plan.ts";
import { checkStoreImage, checkStoreVideo, readImageHeader } from "../src/store/validate.ts";
import { STORE_VIDEO_PRESETS, STORE_SCREENSHOT_PRESETS, PLAY_FEATURE_GRAPHIC, posterTimeCode } from "../src/store/presets.ts";
import { parseMaestroCommands } from "../src/native/maestro.ts";
import { toClipMarks } from "../src/native/record.ts";
import { adbInputText, IosSimulator, parseAdbDevices, parseSimctlDevices, parseWmSize, pickSimulator } from "../src/native/device.ts";
import { markup, shotLayout, videoLayout } from "../src/store/render-html.ts";
import { clipRect, defaultTrim, sceneFilter, unionRect, videoScenes } from "../src/store/video.ts";
import { StoreProjectSchema } from "../src/types.ts";

/** Output-time still spans of a plan, given input still spans. */
function outStills(plan, freezes) {
  const out = [];
  let t = 0;
  for (const s of plan.segments) {
    const d = (s.toMs - s.fromMs) / s.rate;
    for (const f of freezes) {
      const a = Math.max(f.startMs, s.fromMs);
      const b = Math.min(f.endMs, s.toMs);
      if (b > a) out.push({ startMs: t + (a - s.fromMs) / s.rate, endMs: t + (b - s.fromMs) / s.rate });
    }
    t += d;
  }
  // merge touching pieces (one still across segment boundaries)
  out.sort((x, y) => x.startMs - y.startMs);
  const merged = [];
  for (const o of out) {
    const last = merged[merged.length - 1];
    if (last && o.startMs - last.endMs < 1) last.endMs = Math.max(last.endMs, o.endMs);
    else merged.push({ ...o });
  }
  return merged;
}

test("no still longer than maxStillMs survives the plan unless it is a hold", () => {
  const freezes = [
    { startMs: 1000, endMs: 4000 }, // 3 s spinner-less wait
    { startMs: 6000, endMs: 6500 }, // short pause: fine as is
    { startMs: 8000, endMs: 10000 }, // result landing: held
  ];
  const plan = planScene({
    durationMs: 12000,
    freezes,
    ramps: [{ startMs: 4500, endMs: 6000, rate: 4 }],
    holds: [{ startMs: 8000, endMs: 9200 }],
  });
  const stills = outStills(plan, freezes);
  const bad = stillViolations(stills, plan.holdsOut, DEFAULT_PLAN_OPTIONS.maxStillMs, 0);
  assert.deepEqual(bad, [], JSON.stringify({ stills, holds: plan.holdsOut, segs: plan.segments }));
  // The 3 s still now lasts stillKeepMs.
  const first = plan.segments.find((s) => s.kind === "still" && s.fromMs === 1000);
  assert.ok(first);
  assert.ok(Math.abs((first.toMs - first.fromMs) / first.rate - DEFAULT_PLAN_OPTIONS.stillKeepMs) < 1);
  // The ramp plays 4x; the hold plays 1x.
  assert.equal(plan.segments.find((s) => s.fromMs === 4500).rate, 4);
  assert.ok(plan.segments.some((s) => s.kind === "hold" && s.rate === 1));
  // After the hold, 800 ms of the landing still remain: ramped too.
  assert.ok(plan.segments.some((s) => s.kind === "still" && s.fromMs === 9200));
});

test("plan output length = sum of segments + tail hold, and trim bounds it", () => {
  const plan = planScene({ durationMs: 10000, trim: { startMs: 2000, endMs: 7000 }, freezes: [], ramps: [], holds: [], tailHoldMs: 900 });
  assert.equal(plan.segments.length, 1);
  assert.deepEqual([plan.segments[0].fromMs, plan.segments[0].toMs], [2000, 7000]);
  assert.equal(plan.outMs, 5900);
  assert.ok(plan.holdsOut.some((h) => h.endMs === 5900));
});

test("stillKeepMs 0 cuts long stills out entirely", () => {
  const plan = planScene({
    durationMs: 6000,
    freezes: [{ startMs: 2000, endMs: 5000 }],
    ramps: [],
    holds: [],
    options: { stillKeepMs: 0 },
  });
  assert.equal(plan.outMs, 3000);
});

test("fitPlans: too short fails loudly, too long speeds non-hold time only when asked", () => {
  const p = planScene({ durationMs: 20000, freezes: [], ramps: [], holds: [{ startMs: 0, endMs: 2000 }] });
  assert.throws(() => fitPlans([p], 0, { minMs: 25000 }, "speed"), /at least 25 s/);
  assert.throws(() => fitPlans([p], 2000, { maxMs: 15000 }, "fail"), /at most 15 s/);
  const fit = fitPlans([p], 2000, { maxMs: 15000 }, "speed");
  assert.ok(fit.totalMs <= 15000, String(fit.totalMs));
  assert.ok(fit.speedFactor > 1);
  assert.equal(fit.plans[0].segments.find((s) => s.kind === "hold").rate, 1);
});

test("ramps/holds resolve from Maestro labels and command types, and fail loudly when missing", () => {
  const marks = [
    { command: "tapOn", startMs: 500, endMs: 900 },
    { command: "inputText", label: "typing", startMs: 1000, endMs: 4000 },
    { command: "assertVisible", label: "receipt", startMs: 4200, endMs: 4400 },
  ];
  const scene = {
    id: "voice",
    flow: "f.yaml",
    ramps: [{ label: "typing", rate: 6 }, { command: "tapOnCommand" }],
    holds: [{ label: "receipt", afterMs: 1200 }],
  };
  assert.deepEqual(resolveRamps(scene, marks, 4), [
    { startMs: 1000, endMs: 4000, rate: 6 },
    { startMs: 500, endMs: 900, rate: 4 },
  ]);
  assert.deepEqual(resolveHolds(scene, marks), [{ startMs: 4400, endMs: 5600 }]);
  assert.throws(() => resolveRamps({ ...scene, ramps: [{ label: "nope" }] }, marks, 4), /matches no recorded Maestro command.*typing/);
});

test("Maestro debug output → marks on the clip clock", () => {
  const json = JSON.stringify([
    { command: { launchAppCommand: { appId: "x" } }, metadata: { status: "COMPLETED", timestamp: 1_000_500, duration: 800 } },
    { command: { runScriptCommand: { script: "…" } } }, // no metadata: skipped
    { command: { inputTextCommand: { text: "two eggs", label: "typing" } }, metadata: { status: "COMPLETED", timestamp: 1_002_000, duration: 2500 } },
  ]);
  const t = parseMaestroCommands(json);
  assert.deepEqual(t.map((x) => [x.command, x.label]), [["launchApp", undefined], ["inputText", "typing"]]);
  const marks = toClipMarks(t, 1_000_000);
  assert.deepEqual(marks[1], { command: "inputText", label: "typing", startMs: 2000, endMs: 4500, status: "COMPLETED" });
  assert.deepEqual(defaultTrim(9000, marks), { startMs: 250, endMs: 5100 });
});

test("device discovery parsers", () => {
  const sims = parseSimctlDevices(
    JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
          { udid: "A", name: "iPhone 17 Pro Max", state: "Shutdown", isAvailable: true },
          { udid: "B", name: "iPhone 16e", state: "Booted", isAvailable: true },
        ],
        "com.apple.CoreSimulator.SimRuntime.watchOS-27-0": [{ udid: "W", name: "Watch", state: "Booted", isAvailable: true }],
      },
    })
  );
  assert.equal(pickSimulator(sims).udid, "B"); // the watch is not an iOS device
  assert.equal(pickSimulator(sims, "iPhone 17 Pro Max").udid, "A");
  assert.throws(() => pickSimulator([...sims, { ...sims[1], udid: "C" }]), /2 booted iOS simulators/);
  assert.deepEqual(parseAdbDevices("List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n\n"), ["emulator-5554"]);
  assert.deepEqual(parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600\n"), { width: 720, height: 1600 });
  assert.equal(adbInputText("two eggs & a flat white"), "two%seggs%s\\&%sa%sflat%swhite");
});

test("store video spec: a correct encode passes, every violation is named", () => {
  const preset = STORE_VIDEO_PRESETS["app-store-preview"];
  const good = {
    streams: [
      { codec_type: "video", codec_name: "h264", profile: "High", level: 40, width: 886, height: 1920, pix_fmt: "yuv420p", field_order: "progressive", r_frame_rate: "30/1", avg_frame_rate: "30/1" },
      { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" },
    ],
    format: { duration: "18.000000", size: String(12 * 1048576) },
  };
  assert.deepEqual(checkStoreVideo(good, preset).errors, []);
  const bad = {
    streams: [{ ...good.streams[0], width: 1080, level: 42, r_frame_rate: "60/1", avg_frame_rate: "60/1", pix_fmt: "yuv444p" }],
    format: { duration: "31.2", size: "100" },
  };
  const errors = checkStoreVideo(bad, preset).errors.join("\n");
  for (const re of [/886x1920/, /level 4\.2/, /30 fps/, /yuv420p/, /no audio track/, /at most 30 s/]) assert.match(errors, re);
  // Play: short is only a warning (Google recommends 30 s–2 min).
  const play = STORE_VIDEO_PRESETS["play-promo-portrait"];
  const pr = checkStoreVideo({ ...good, streams: [{ ...good.streams[0], width: 1080 }, good.streams[1]] }, play);
  assert.deepEqual(pr.errors, []);
  assert.match(pr.warnings.join(), /recommended 30 s/);
});

function png(w, h, colorType = 2) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = colorType;
  return b;
}

test("store image spec: exact size, opaque RGB, Play aspect rule", () => {
  const ios = STORE_SCREENSHOT_PRESETS["ios-6.9"];
  assert.deepEqual(checkStoreImage(readImageHeader(png(1320, 2868)), 1000, ios).errors, []);
  assert.match(checkStoreImage(readImageHeader(png(1320, 2868, 6)), 1000, ios).errors.join(), /alpha/);
  assert.match(checkStoreImage(readImageHeader(png(1290, 2796)), 1000, ios).errors.join(), /1320x2868/);
  assert.deepEqual(checkStoreImage(readImageHeader(png(1024, 500)), 1000, PLAY_FEATURE_GRAPHIC).errors, []);
  assert.deepEqual(checkStoreImage(readImageHeader(png(1080, 1920)), 1000, STORE_SCREENSHOT_PRESETS["play-phone"]).errors, []);
});

test("layouts: fill for matching aspect, band/side otherwise; screenshots keep UI readable", () => {
  // iPhone 6.9" raw (1320x2868) on the 886x1920 App Preview: fill (crop a few px).
  const fill = videoLayout(886, 1920, 1320, 2868);
  assert.equal(fill.mode, "fill");
  assert.ok(fill.video.w >= 886 && fill.video.h >= 1920);
  assert.equal(videoLayout(1080, 1920, 1320, 2868).mode, "band");
  const side = videoLayout(1920, 1080, 1320, 2868);
  assert.equal(side.mode, "side");
  assert.ok(side.video.x > side.caption.x + side.caption.w - 1);
  const shot = shotLayout(1320, 2868, 1320, 2868);
  assert.ok(shot.screenFraction >= 0.8, String(shot.screenFraction));
  assert.ok(shot.device.y + shot.device.h > 2868, "default device bleeds off the bottom");
  const whole = shotLayout(1320, 2868, 1320, 2868, { bleed: "none" });
  assert.ok(whole.device.y + whole.device.h <= 2868);
  assert.equal(markup("Say it. *Logged.* <b>"), 'Say it. <span class="acc">Logged.</span> &lt;b&gt;');
});

test("scene filter goes CFR before trimming and chains every segment", () => {
  const plan = planScene({ durationMs: 5000, freezes: [{ startMs: 1000, endMs: 3000 }], ramps: [], holds: [], tailHoldMs: 500 });
  const f = sceneFilter(plan, videoLayout(886, 1920, 1320, 2868), 30);
  assert.match(f, /^\[0:v\]fps=30,setpts=PTS-STARTPTS,split=3/);
  assert.match(f, /concat=n=3:v=1:a=0,fps=30,tpad=stop_mode=clone:stop_duration=0\.500/);
  assert.match(f, /overlay=0:0/);
});

test("schema: a scene needs exactly one source; presets and poster timecode", () => {
  const base = { title: "t", device: { platform: "ios" }, scenes: [{ id: "a", flow: "a.yaml", caption: "Hi" }] };
  assert.ok(StoreProjectSchema.safeParse(base).success);
  assert.ok(!StoreProjectSchema.safeParse({ ...base, scenes: [{ id: "a", flow: "a.yaml", clip: "a.mp4" }] }).success);
  assert.ok(!StoreProjectSchema.safeParse({ ...base, scenes: [{ id: "a b", flow: "a.yaml" }] }).success);
  assert.ok(!StoreProjectSchema.safeParse({ ...base, scenes: [{ id: "a", flow: "a.yaml", ramps: [{ rate: 3 }] }] }).success);
  assert.ok(StoreProjectSchema.safeParse({ ...base, video: { presets: ["app-store-preview", "play-promo-landscape"] } }).success);
  assert.equal(posterTimeCode(0), "00:00:00:00");
  assert.equal(posterTimeCode(5500), "00:00:05:15");
});

test("a still frozen through EOF (the end card) is covered once clamped to the file length", () => {
  const fileMs = 16820;
  const endCard = { startMs: 14820 - 200, endMs: 16820 + 1000 };
  const eof = [{ startMs: 14800, endMs: Number.MAX_SAFE_INTEGER }];
  assert.equal(stillViolations(eof, [endCard], 700).length, 1, "unbounded span is the bug");
  assert.deepEqual(stillViolations(clampSpans(eof, fileMs), [endCard], 700), []);
  // a real dead stretch before the end card still fails
  const dead = clampSpans([{ startMs: 12000, endMs: Number.MAX_SAFE_INTEGER }], fileMs);
  assert.equal(stillViolations(dead, [endCard], 700).length, 1);
});

test("inVideo: false keeps a screenshot-only scene out of the edit", () => {
  const store = StoreProjectSchema.parse({
    title: "t",
    device: { platform: "ios" },
    scenes: [
      { id: "voice", clip: "a.mp4", caption: "Say it." },
      { id: "plan", clip: "b.mp4", inVideo: false, still: "04-plan" },
      { id: "fix", clip: "c.mp4" },
    ],
  });
  assert.deepEqual(videoScenes(store).map((s) => s.id), ["voice", "fix"]);
  const none = StoreProjectSchema.parse({ title: "t", device: { platform: "ios" }, scenes: [{ id: "x", clip: "a.mp4", inVideo: false }] });
  assert.throws(() => videoScenes(none), /at least one scene/);
});

test("the final still check measures only the device region on the canvas", () => {
  // fill: the device overflows the canvas → clipped to the canvas, even sizes
  assert.deepEqual(clipRect({ x: -3, y: -40, w: 893, h: 2000 }, 886, 1920), { x: 0, y: 0, w: 886, h: 1920 });
  // side layout: a small device on a big landscape canvas stays its own rect
  assert.deepEqual(clipRect({ x: 1100, y: 40, w: 461, h: 1001 }, 1920, 1080), { x: 1100, y: 40, w: 460, h: 1000 });
  assert.deepEqual(unionRect(undefined, { x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 0, y: 0, w: 15, h: 15 });
});

test("iOS screenSize reads a screenshot FILE (simctl writes a file named '-', never stdout)", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const bin = mkdtempSync(join(tmpdir(), "aidemo-fake-xcrun-"));
  // 1320x2868 PNG header (signature + IHDR); the fake xcrun writes it to its last argument.
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(png, 0);
  png.writeUInt32BE(1320, 16);
  png.writeUInt32BE(2868, 20);
  writeFileSync(join(bin, "frame.png"), png);
  writeFileSync(join(bin, "xcrun"), `#!/bin/sh\nfor a; do last="$a"; done\n[ "$last" = "-" ] && exit 3\ncp "${join(bin, "frame.png")}" "$last"\n`);
  chmodSync(join(bin, "xcrun"), 0o755);
  const path = process.env.PATH;
  const cwd = process.cwd();
  process.env.PATH = `${bin}:${path}`;
  try {
    process.chdir(bin);
    const size = await new IosSimulator("SIM", "iPhone", false).screenSize();
    assert.deepEqual(size, { width: 1320, height: 2868 });
    assert.equal(existsSync(join(bin, "-")), false);
  } finally {
    process.chdir(cwd);
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});
