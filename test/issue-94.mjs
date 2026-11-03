// Issue #94: the built-in capture's lead-in must not grow with the footage past
// the last scene. Pure (no Chrome, no ffmpeg); the take itself is checked by
// `npm run test:lead-in`.
//
//   npx tsx --test test/issue-94.mjs      (part of `npm test`)
import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinLeadInMs } from "../src/recorder.ts";

const take = { videoMs: 13800, totalMs: 9300, tailMs: 250, t0: 100_030 };

test("the recorder's start stamp wins over a long tail", () => {
  assert.equal(builtinLeadInMs({ ...take, recorderStartMs: 100_000 }), 30);
});

test("no stamp falls back to video length minus content and tail", () => {
  assert.equal(builtinLeadInMs({ ...take, recorderStartMs: null }), 4250);
});

test("the smaller figure wins: both only overshoot", () => {
  assert.equal(builtinLeadInMs({ ...take, videoMs: 9600, recorderStartMs: 99_000 }), 50);
});

test("never negative", () => {
  assert.equal(builtinLeadInMs({ ...take, recorderStartMs: 100_500 }), 0);
  assert.equal(builtinLeadInMs({ ...take, videoMs: 9000, recorderStartMs: null }), 0);
});
