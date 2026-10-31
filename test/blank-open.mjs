// Regression test for the blank-opening / blank-tail probes (issues #47, #36, #78).
//
//   npm run test:blank-open        (needs system Chrome + ffmpeg on PATH)
//
// Renders page stills in headless Chrome, encodes them like a take segment
// (x264 crf 20, 30 fps, yuv420p), and checks what `probeFlatLeadMs` /
// `probeFlatTailMs` call blank. #78: a static dark terminal with a prompt was
// "blank" because the old test only asked whether one colour covered >= 80%
// of the frame — sparse text never reaches the luma percentiles.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { launchChrome } from "../src/browser.ts";
import { probeFlatLeadMs, probeFlatTailMs } from "../src/ffmpeg.ts";
import { CURSOR_ARROW_PATH } from "../src/cursor.ts";

// The baked cursor as the recorder injects it (src/cursor.ts), parked mid-frame.
const cursor = (x, y) =>
  `<svg viewBox="0 0 24 24" style="position:fixed;left:${x}px;top:${y}px;width:24px;height:24px;` +
  `filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))"><path d="${CURSOR_ARROW_PATH}" fill="#ffffff" ` +
  `stroke="#111111" stroke-width="1.3" stroke-linejoin="round"/></svg>`;

const PAGES = {
  // The browser's white pre-paint, cursor already on screen (the #47 case).
  white: (w, h) => `<body style="margin:0;background:#fff">${cursor(w / 2, h / 2)}</body>`,
  // A solid black splash: no content at all — blank, like the white one.
  black: () => `<body style="margin:0;background:#000"></body>`,
  // #78: ttyd-style dark terminal, one prompt line, nothing else.
  terminal: () =>
    `<body style="margin:0;background:#1e1e1e;color:#ccc;font:16px/1.2 monospace;padding:4px">` +
    `root@ttyd:~# <span style="background:#ccc">&nbsp;</span></body>`,
  // Same, dimmer and smaller (a plain bash prompt on black).
  terminalDim: (w, h) =>
    `<body style="margin:0;background:#000;color:#aaa;font:14px/1.2 monospace;padding:2px">` +
    `user@box:~$ <span style="background:#aaa">&nbsp;</span>${cursor(w / 2, h / 2)}</body>`,
  // A light page that is mostly empty but plainly loaded.
  light: () =>
    `<body style="margin:0;background:#fff;font:16px sans-serif;padding:40px">` +
    `<h1>Welcome</h1><p>Sign in to continue.</p></body>`,
};

const VIEWPORTS = [
  { w: 1920, h: 1080, dsf: 1 }, // the #78 reporter's take
  { w: 1280, h: 720, dsf: 2 }, // a retina-density take
];

let dir;
let chromeError = null;

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

/** Encode a sequence of [still, seconds] into one CFR clip, like a take segment. */
function clip(name, parts, vp) {
  const out = join(dir, `${name}-${vp.w}@${vp.dsf}.mp4`);
  const inputs = parts.flatMap(([page, sec]) => [
    "-framerate", "30", "-loop", "1", "-t", String(sec), "-i", join(dir, `${page}-${vp.w}@${vp.dsf}.png`),
  ]);
  const labels = parts.map((_, k) => `[${k}:v]`).join("");
  ffmpeg([
    ...inputs,
    "-filter_complex", `${labels}concat=n=${parts.length}:v=1,format=yuv420p[v]`,
    "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", out,
  ]);
  return out;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "aidemo-blank-open-"));
  let browser;
  try {
    browser = await launchChrome({ headless: true });
  } catch (e) {
    chromeError = e;
    return;
  }
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dsf });
    for (const [name, html] of Object.entries(PAGES)) {
      await page.setContent(html(vp.w, vp.h));
      await page.screenshot({ path: join(dir, `${name}-${vp.w}@${vp.dsf}.png`) });
    }
    await page.close();
  }
  await browser.close();
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

for (const vp of VIEWPORTS) {
  const label = `${vp.w}x${vp.h}@${vp.dsf}x`;
  const skip = () => (chromeError ? `system Chrome unavailable: ${chromeError.message}` : false);

  test(`${label}: white pre-paint then content → blank lead detected`, async (t) => {
    if (skip()) return t.skip(skip());
    const f = clip("white-then-light", [["white", 1], ["light", 1]], vp);
    const ms = await probeFlatLeadMs(f, 4000, 0, vp.dsf);
    assert.ok(ms >= 900 && ms <= 1050, `expected ~1000ms blank lead, got ${ms}`);
  });

  test(`${label}: static dark terminal with a prompt → not blank (#78)`, async (t) => {
    if (skip()) return t.skip(skip());
    for (const page of ["terminal", "terminalDim"]) {
      const f = clip(`static-${page}`, [[page, 2]], vp);
      assert.equal(await probeFlatLeadMs(f, 4000, 0, vp.dsf), 0, `${page}: lead`);
      assert.equal(await probeFlatTailMs(f, 2000, 4000, vp.dsf), 0, `${page}: tail`);
    }
  });

  test(`${label}: solid black splash then terminal → the black lead is blank`, async (t) => {
    if (skip()) return t.skip(skip());
    const f = clip("black-then-terminal", [["black", 1], ["terminal", 1]], vp);
    const ms = await probeFlatLeadMs(f, 4000, 0, vp.dsf);
    assert.ok(ms >= 900 && ms <= 1050, `expected ~1000ms blank lead, got ${ms}`);
  });

  test(`${label}: static light page with content → not blank`, async (t) => {
    if (skip()) return t.skip(skip());
    const f = clip("static-light", [["light", 2]], vp);
    assert.equal(await probeFlatLeadMs(f, 4000, 0, vp.dsf), 0);
    assert.equal(await probeFlatTailMs(f, 2000, 4000, vp.dsf), 0);
  });

  test(`${label}: content then white pre-paint → blank tail detected (#36)`, async (t) => {
    if (skip()) return t.skip(skip());
    const f = clip("light-then-white", [["light", 1], ["white", 1]], vp);
    const ms = await probeFlatTailMs(f, 2000, 4000, vp.dsf);
    assert.ok(ms >= 950 && ms <= 1100, `expected ~1000ms blank tail, got ${ms}`);
  });
}
