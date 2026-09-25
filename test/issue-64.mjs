import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectTargetStatus } from "../src/inspect.ts";
import { alignCaptionWords } from "../src/captions.ts";
import { compileUserRegex } from "../src/safe-regex.ts";

test("inspect reports a security verification page as blocked", () => {
  const target = inspectTargetStatus({
    title: "Just a moment...",
    headings: [{ level: 1, text: "Performing security verification" }],
    bodyText: "Checking your browser",
  });
  assert.equal(target.status, "blocked");
  assert.match(target.reason, /security verification/);
  assert.equal(inspectTargetStatus({ title: "My product", headings: [], bodyText: "Log in to view more" }).status, "available");
});

test("script alignment restores Estonian spelling and punctuation at measured times", () => {
  const result = alignCaptionWords("Ava toidupäevik. See töötab!", [
    { word: "Ava", start: 0, end: 0.2 },
    { word: "toidupäälik", start: 0.25, end: 0.9 },
    { word: "See", start: 1, end: 1.2 },
    { word: "töötab", start: 1.25, end: 1.7 },
  ], 1800);
  assert.equal(result.driftPct, 25);
  assert.deepEqual(result.words.map((w) => w.word), ["Ava", "toidupäevik.", "See", "töötab!"]);
  assert.equal(result.words[1].start, 0.25);
  assert.equal(result.words[1].end, 0.9);
});

test("storyboard regex matching is bounded even for overlapping alternatives", () => {
  const re = compileUserRegex("^(a|aa)+$", "", "assert.textMatches");
  assert.equal(re.test("a".repeat(5000) + "!"), false);
  assert.equal(re.test("aaaa"), true);
});
