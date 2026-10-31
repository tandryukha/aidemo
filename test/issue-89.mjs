// Issue #89 — captions timed to the final video: cue shifting, sidecar files,
// language tags and the subtitle-track `tkhd` patch. Pure (no Chrome, no
// ffmpeg): the MP4s are synthetic box trees.
//
//   npx tsx --test test/issue-89.mjs      (part of `npm test`)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  disableSubtitleTracks,
  finalVideoCues,
  htmlTrackLanguage,
  mp4Language,
  shiftCues,
  writeCaptionSidecars,
} from "../src/caption-track.ts";
import { Project } from "../src/project.ts";

const CUES = [
  { index: 1, startMs: 0, endMs: 2112, text: "Hello there." },
  { index: 2, startMs: 2112, endMs: 4224, text: "Second cue." },
];

test("shiftCues moves every cue by the intro and leaves 0 alone", () => {
  assert.deepEqual(
    shiftCues(CUES, 2600).map((c) => [c.startMs, c.endMs]),
    [[2600, 4712], [4712, 6824]]
  );
  assert.equal(shiftCues(CUES, 0), CUES);
});

test("sidecars are written beside the video, shifted, and removed when there are no cues", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aidemo-89-"));
  const project = new Project(dir);
  mkdirSync(join(dir, "generated"), { recursive: true });
  mkdirSync(join(dir, "output"), { recursive: true });
  writeFileSync(project.captionsCuesPath, JSON.stringify(CUES));

  const cues = await finalVideoCues(project, 2600);
  const files = await writeCaptionSidecars(project, cues);
  assert.equal(files.srt, join(dir, "output", "final-demo.srt"));
  assert.match(readFileSync(files.srt, "utf8"), /^1\n00:00:02,600 --> 00:00:04,712\nHello there\.\n/);
  assert.match(readFileSync(files.vtt, "utf8"), /^WEBVTT\n\n00:00:02\.600 --> 00:00:04\.712\n/);

  // A --lang render names them after its own video.
  assert.equal(new Project(dir, "de").outputSrtPath, join(dir, "output", "final-demo.de.srt"));

  // No cues: stale sidecars must not survive next to a video they don't match.
  assert.equal(await writeCaptionSidecars(project, null), null);
  assert.equal(existsSync(files.srt) || existsSync(files.vtt), false);
});

test("mp4Language maps BCP-47 to ISO 639-2/T", () => {
  assert.equal(mp4Language("en"), "eng");
  assert.equal(mp4Language("en-GB"), "eng");
  assert.equal(mp4Language("pt_BR"), "por");
  assert.equal(mp4Language("de"), "deu");
  assert.equal(mp4Language("zh-Hans"), "zho");
  assert.equal(mp4Language("fil"), "fil"); // already three letters
  assert.equal(mp4Language("xx"), "und");
  assert.equal(mp4Language(undefined), "und");
});

test("htmlTrackLanguage gives srclang + a readable label", () => {
  assert.deepEqual(htmlTrackLanguage("de"), { srclang: "de", label: "German" });
  assert.deepEqual(htmlTrackLanguage("en-GB"), { srclang: "en-GB", label: "British English" });
  assert.deepEqual(htmlTrackLanguage(undefined), { srclang: "en", label: "English" });
  assert.deepEqual(htmlTrackLanguage("!!"), { srclang: "!!", label: "!!" });
});

/* --------------------------- synthetic MP4 boxes -------------------------- */

const box = (type, ...payloads) => {
  const body = Buffer.concat(payloads);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
const fullBox = (type, flags, rest) =>
  box(type, Buffer.from([0, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), rest);
const trak = (flags, handler) =>
  box(
    "trak",
    fullBox("tkhd", flags, Buffer.alloc(80)),
    box("mdia", fullBox("hdlr", 0, Buffer.concat([Buffer.alloc(4), Buffer.from(handler, "latin1"), Buffer.alloc(13)])))
  );
/** A 64-bit ("largesize") box, to exercise the size == 1 header path. */
const largeFree = () => {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(1, 0);
  b.write("free", 4, "latin1");
  b.writeBigUInt64BE(24n, 8);
  return b;
};
/** tkhd flags per track handler, read back from a file. */
function trackFlags(file) {
  const buf = readFileSync(file);
  const flags = {};
  for (let p = 0; p < buf.length; ) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    if (type === "moov") {
      for (let t = p + 8; t < p + size; ) {
        const tSize = buf.readUInt32BE(t);
        // trak(8) | tkhd: header(8) version(1) flags(3) body(80) = 92 | mdia(8) |
        // hdlr: header(8) version+flags(4) pre_defined(4) handler_type(4)
        const tkhd = t + 8;
        const hdlr = tkhd + 92 + 8;
        flags[buf.toString("latin1", hdlr + 16, hdlr + 20)] = buf.readUIntBE(tkhd + 9, 3);
        t += tSize;
      }
    }
    p += size === 1 ? Number(buf.readBigUInt64BE(p + 8)) : size;
  }
  return flags;
}

test("disableSubtitleTracks clears only the subtitle tracks' enabled bit, in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aidemo-89-mp4-"));
  const moov = box("moov", trak(3, "vide"), trak(3, "soun"), trak(3, "sbtl"));
  const mdat = box("mdat", Buffer.alloc(64, 7));
  for (const [name, parts] of [
    ["faststart.mp4", [box("ftyp", Buffer.from("isom")), largeFree(), moov, mdat]],
    ["moov-last.mp4", [box("ftyp", Buffer.from("isom")), mdat, largeFree(), moov]],
  ]) {
    const file = join(dir, name);
    const original = Buffer.concat(parts);
    writeFileSync(file, original);
    assert.deepEqual(trackFlags(file), { vide: 3, soun: 3, sbtl: 3 }, name);

    assert.deepEqual(await disableSubtitleTracks(file), { tracks: 1, changed: 1 }, name);
    assert.deepEqual(trackFlags(file), { vide: 3, soun: 3, sbtl: 2 }, name);
    const after = readFileSync(file);
    assert.equal(after.length, original.length, `${name}: nothing moved`);
    assert.equal(
      [...after].filter((b, i) => b !== original[i]).length,
      1,
      `${name}: exactly one byte changed`
    );
    assert.deepEqual(await disableSubtitleTracks(file), { tracks: 1, changed: 0 }, `${name}: idempotent`);
  }

  const noMoov = join(dir, "no-moov.mp4");
  writeFileSync(noMoov, Buffer.concat([box("ftyp", Buffer.from("isom")), box("mdat", Buffer.alloc(8))]));
  assert.deepEqual(await disableSubtitleTracks(noMoov), { tracks: 0, changed: 0 });
});
