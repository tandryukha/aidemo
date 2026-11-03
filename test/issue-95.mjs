// Issue #95: the log and voice.json name the voice that actually spoke. Other
// providers replace the schema default ("marin", an OpenAI voice) inside
// synthesize, so the plan's voiceId is not it.
//
//   npx tsx --test test/issue-95.mjs      (part of `npm test`; the manifest
//                                          cases are skipped without ffmpeg)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, test } from "node:test";
import { Project } from "../src/project.ts";
import { withLogSinks } from "../src/util.ts";
import { generateVoice } from "../src/voice.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const TMP = mkdtempSync(join(tmpdir(), "aidemo-voice-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const KNOBS = ["AIDEMO_TTS_PROVIDER", "AIDEMO_ELEVENLABS_VOICE", "AIDEMO_KOKORO_VOICE"];
const saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KNOBS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const clip = join(TMP, "clip.mp3");
if (hasFfmpeg) {
  spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "0.2", "-y", clip]);
}
const fake = { synthesize: async () => readFileSync(clip) };

/** One voice run in a fresh demo dir: the manifest + what the run logged. */
async function run(name, storyboard, opts = {}) {
  const dir = join(TMP, name);
  const project = new Project(dir);
  mkdirSync(dirname(project.storyboardPath), { recursive: true });
  writeFileSync(project.storyboardPath, JSON.stringify(storyboard));
  const lines = [];
  await withLogSinks([(line) => lines.push(line)], async () =>
    generateVoice(project, await project.loadStoryboard(), { provider: fake, ...opts })
  );
  return { manifest: JSON.parse(readFileSync(project.voiceManifestPath, "utf8")), log: lines.join("\n") };
}

const scene = (id, voice) => ({
  id,
  narration: `The ${id} page.`,
  actions: [{ op: "pause", ms: 100 }],
  ...(voice ? { voice } : {}),
});
const board = (scenes, voice) => ({ title: "Voices", scenes, ...(voice ? { voice } : {}) });

test("local: the default voice is Kokoro's, a scene can override it", { skip: !hasFfmpeg }, async () => {
  process.env.AIDEMO_TTS_PROVIDER = "local";
  process.env.AIDEMO_KOKORO_VOICE = "af_bella";
  const { manifest, log } = await run(
    "local",
    board([scene("red"), scene("blue", { voiceId: "am_adam" })])
  );
  assert.match(log, /scene red: .*\(af_bella\)/);
  assert.match(log, /scene blue: .*\(am_adam\)/);
  assert.doesNotMatch(log, /marin/);
  assert.deepEqual(
    manifest.scenes.map((s) => [s.id, s.provider, s.voice]),
    [
      ["red", "local", "af_bella"],
      ["blue", "local", "am_adam"],
    ]
  );
});

test("elevenlabs: the default voice is the configured one", { skip: !hasFfmpeg }, async () => {
  process.env.AIDEMO_TTS_PROVIDER = "elevenlabs";
  process.env.AIDEMO_ELEVENLABS_VOICE = "voice123";
  const { manifest, log } = await run("eleven", board([scene("red")]));
  assert.match(log, /\(voice123\)/);
  assert.equal(manifest.scenes[0].provider, "elevenlabs");
  assert.equal(manifest.scenes[0].voice, "voice123");
});

test("openai: the default stays marin, the storyboard's voice wins", { skip: !hasFfmpeg }, async () => {
  delete process.env.AIDEMO_TTS_PROVIDER;
  const a = await run("openai", board([scene("red")]));
  assert.equal(a.manifest.scenes[0].provider, "openai");
  assert.equal(a.manifest.scenes[0].voice, "marin");
  const b = await run("openai2", board([scene("red")], { voiceId: "cedar" }));
  assert.match(b.log, /\(cedar\)/);
  assert.equal(b.manifest.scenes[0].voice, "cedar");
});

test("a reused scene keeps its voice in the manifest", { skip: !hasFfmpeg }, async () => {
  process.env.AIDEMO_TTS_PROVIDER = "local";
  process.env.AIDEMO_KOKORO_VOICE = "af_bella";
  const sb = board([scene("red")]);
  await run("reuse", sb);
  const { manifest, log } = await run("reuse", sb);
  assert.match(log, /unchanged, reusing/);
  assert.equal(manifest.scenes[0].voice, "af_bella");
  assert.equal(manifest.scenes[0].provider, "local");
});

test("--scene mode: another scene's manifest entry is not re-attributed", { skip: !hasFfmpeg }, async () => {
  // Voiced with one provider, then one scene re-voiced with another: the
  // untouched scene's audio is still the first provider's.
  process.env.AIDEMO_TTS_PROVIDER = "local";
  process.env.AIDEMO_KOKORO_VOICE = "af_bella";
  const sb = board([scene("red"), scene("blue")]);
  await run("scoped", sb);
  process.env.AIDEMO_TTS_PROVIDER = "elevenlabs";
  process.env.AIDEMO_ELEVENLABS_VOICE = "voice123";
  const { manifest } = await run("scoped", sb, { only: "blue" });
  assert.deepEqual(
    manifest.scenes.map((s) => [s.id, s.provider, s.voice]),
    [
      ["red", "local", "af_bella"],
      ["blue", "elevenlabs", "voice123"],
    ]
  );
});

test("a manifest from an older engine still reuses, with no voice invented in --scene mode", { skip: !hasFfmpeg }, async () => {
  process.env.AIDEMO_TTS_PROVIDER = "local";
  process.env.AIDEMO_KOKORO_VOICE = "af_bella";
  const sb = board([scene("red"), scene("blue")]);
  await run("legacy", sb);
  const project = new Project(join(TMP, "legacy"));
  const m = JSON.parse(readFileSync(project.voiceManifestPath, "utf8"));
  for (const s of m.scenes) {
    delete s.provider;
    delete s.voice;
  }
  writeFileSync(project.voiceManifestPath, JSON.stringify(m));
  const { manifest } = await run("legacy", sb, { only: "blue" });
  assert.equal(manifest.scenes[0].voice, undefined);
  assert.equal(manifest.scenes[0].provider, undefined);
  assert.equal(manifest.scenes[1].voice, "af_bella");
});
