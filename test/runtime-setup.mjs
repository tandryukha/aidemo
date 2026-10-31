// Runtime setup: the Node gate, Playwright's ffmpeg-helper lookup and its
// launch-error diagnosis, the auto-install switch, the doctor Node check and
// the embed's captions track. Pure: no browser launch, no network.
//
//   npx tsx --test test/runtime-setup.mjs      (part of `npm test`)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { explainLaunchError, recorderAutoInstall, recorderFfmpeg } from "../src/browser.ts";
import { nodeSupported } from "../src/distribute.ts";
import { buildEmbed } from "../src/embed.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "aidemo.mjs");
const TMP = mkdtempSync(join(tmpdir(), "aidemo-setup-"));

/** Run bin/aidemo.mjs on a Node that reports `version` (process.versions faked by a preload). */
function binOn(version) {
  const preload = join(TMP, `node-${version}.mjs`);
  writeFileSync(
    preload,
    `Object.defineProperty(process.versions, "node", { value: "${version}" });\n` +
      `Object.defineProperty(process, "version", { value: "v${version}" });\n`
  );
  return spawnSync(process.execPath, ["--import", preload, BIN, "--version"], { encoding: "utf8" });
}

test("bin refuses Node older than 22.12 with the fix, runs on 22.12+", () => {
  for (const v of ["20.19.0", "22.11.0"]) {
    const r = binOn(v);
    assert.equal(r.status, 1, v);
    assert.match(r.stderr, /Node\.js 22\.12\+ is required \(found v/, v);
  }
  for (const v of ["22.12.0", "24.1.0"]) {
    const r = binOn(v);
    assert.equal(r.status, 0, `${v}: ${r.stderr}`);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/, v);
  }
});

test("doctor's Node check agrees with the bin gate", () => {
  for (const v of ["v22.12.0", "22.12.1", "v24.0.0", "v23.0.0"]) assert.equal(nodeSupported(v), true, v);
  for (const v of ["v22.11.9", "v20.19.0", "v18.20.0"]) assert.equal(nodeSupported(v), false, v);
});

test("recorderFfmpeg resolves exactly where Playwright looks, in every PLAYWRIGHT_BROWSERS_PATH mode", () => {
  // Playwright fixes its registry dir at import time, so each mode gets its own
  // process; the child compares our lookup with Playwright's own registry.
  const child = join(TMP, "helper-path.mjs");
  writeFileSync(
    child,
    `import { createRequire } from "node:module";\n` +
      `const { recorderFfmpeg } = await import(${JSON.stringify(join(ROOT, "src", "browser.ts"))});\n` +
      `const core = createRequire(${JSON.stringify(join(ROOT, "package.json"))})("playwright-core/lib/coreBundle");\n` +
      `console.log(JSON.stringify({ ours: recorderFfmpeg()?.path, playwright: core.registry.registry.findExecutable("ffmpeg").executablePath() }));\n`
  );
  const base = { ...process.env };
  delete base.PLAYWRIGHT_BROWSERS_PATH;
  const modes = {
    "unset + XDG_CACHE_HOME": { ...base, XDG_CACHE_HOME: join(TMP, "xdg") },
    '"0" (package-local)': { ...base, PLAYWRIGHT_BROWSERS_PATH: "0" },
    absolute: { ...base, PLAYWRIGHT_BROWSERS_PATH: join(TMP, "abs") },
    relative: { ...base, PLAYWRIGHT_BROWSERS_PATH: "rel/browsers" },
  };
  for (const [mode, env] of Object.entries(modes)) {
    const r = spawnSync(process.execPath, ["--import", "tsx", child], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
    const { ours, playwright } = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(ours, playwright, `${mode}: our lookup drifted from Playwright's registry`);
  }
});

test("recorderFfmpeg names this engine's revision and Playwright CLI", () => {
  const h = recorderFfmpeg();
  assert.ok(h, "helper location resolves");
  assert.match(h.path, new RegExp(`ffmpeg-${h.revision}[\\\\/]ffmpeg-`));
  assert.match(h.install, /^node ".+cli\.js" install ffmpeg$/);
});

test("a missing ffmpeg helper is not reported as a missing browser", () => {
  const chrome = { channel: "chrome" };
  const helper = explainLaunchError(
    new Error(
      "browserType.launchPersistentContext: Executable doesn't exist at /x/ffmpeg-1013/ffmpeg-linux\n" +
        "║ Please run the following command: npx playwright install ffmpeg ║"
    ),
    chrome
  );
  assert.match(helper.message, /^Playwright's ffmpeg helper .*is missing/);
  assert.doesNotMatch(helper.message, /Google Chrome was not found/);

  const noChrome = explainLaunchError(
    new Error("Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome\nRun \"npx playwright install chrome\""),
    chrome
  );
  assert.match(noChrome.message, /^Google Chrome was not found/);

  const noChromium = explainLaunchError(
    new Error("Executable doesn't exist at /x/chromium-1243/chrome-linux/chrome\nnpx playwright install"),
    { channel: "chromium" }
  );
  assert.match(noChromium.message, /^Playwright's Chromium \(AIDEMO_CHROME_CHANNEL=chromium\) is not installed/);

  const badExe = explainLaunchError(new Error("spawn /nope/chrome ENOENT"), { executablePath: "/nope/chrome" });
  assert.match(badExe.message, /^AIDEMO_CHROME_EXECUTABLE=\/nope\/chrome could not be launched/);

  const other = new Error("Target page, context or browser has been closed");
  assert.equal(explainLaunchError(other, chrome), other, "unrelated errors pass through untouched");
});

test("AIDEMO_NO_AUTO_INSTALL turns the helper download off", () => {
  const prev = process.env.AIDEMO_NO_AUTO_INSTALL;
  try {
    delete process.env.AIDEMO_NO_AUTO_INSTALL;
    assert.equal(recorderAutoInstall(), true);
    for (const v of ["1", "true", "YES", " 1 "]) {
      process.env.AIDEMO_NO_AUTO_INSTALL = v;
      assert.equal(recorderAutoInstall(), false, JSON.stringify(v));
    }
    process.env.AIDEMO_NO_AUTO_INSTALL = "0";
    assert.equal(recorderAutoInstall(), true);
  } finally {
    if (prev === undefined) delete process.env.AIDEMO_NO_AUTO_INSTALL;
    else process.env.AIDEMO_NO_AUTO_INSTALL = prev;
  }
});

test("the HTML embed offers the captions as a CORS-enabled track in the storyboard's language", async () => {
  const demo = join(TMP, "demos", "shop-tour");
  mkdirSync(join(demo, "generated"), { recursive: true });
  writeFileSync(join(demo, "generated", "storyboard.json"), JSON.stringify({ title: "t", language: "de", scenes: [] }));
  const r = await buildEmbed(demo, { repoDir: ROOT });
  assert.match(r.urls.pagesVtt, /\/media\/shop-tour\/latest\.vtt$/);
  assert.match(r.snippets.htmlVideo, / crossorigin="anonymous"/);
  assert.ok(
    r.snippets.htmlVideo.includes(`<track kind="captions" src="${r.urls.pagesVtt}" srclang="de" label="German" />`),
    r.snippets.htmlVideo
  );
});
