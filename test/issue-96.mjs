// Issue #96: Chinese/Japanese narration has no spaces between words. Pacing
// counted a whole clause as one word, and caption cues could only break at
// the English labels between clauses ("Messaging | API").
//
//   npx tsx --test test/issue-96.mjs      (part of `npm test`)
import assert from "node:assert/strict";
import { test } from "node:test";
import { countWords, displayWidth, splitCjkToken } from "../src/text.ts";
import { groupWords } from "../src/captions.ts";
import { lintStoryboard } from "../src/lint.ts";
import { StoryboardSchema } from "../src/types.ts";

const ZH =
  "在後台開啟 Messaging API 設定，複製 Channel secret 並貼到設定頁面，然後按下儲存按鈕完成連線。";

test("space-delimited text counts exactly as before", () => {
  for (const t of ["", "  ", "Open the settings page.", "Öffnen Sie die Einstellungen  jetzt", "설정 페이지를 엽니다"]) {
    const trimmed = t.trim();
    assert.equal(countWords(t), trimmed ? trimmed.split(/\s+/).length : 0, t);
  }
});

test("Chinese prose is priced per character, English labels per word", () => {
  // 28 Han characters → 14, plus Messaging, API, Channel, secret.
  assert.equal(countWords(ZH), 18);
  assert.equal(countWords("日本語のテキストです。"), 5);
});

test("lint forecasts zh narration at its spoken length, not ≈1-2 s", () => {
  const sb = StoryboardSchema.parse({
    title: "zh",
    language: "zh-TW",
    scenes: [{ id: "a", narration: ZH, actions: [{ op: "pause", ms: 8000 }] }],
  });
  const est = lintStoryboard(sb).estimate[0];
  assert.ok(est.narrationMs > 6000 && est.narrationMs < 10000, `narrationMs ${est.narrationMs}`);
  assert.ok(!lintStoryboard(sb).issues.some((i) => i.code === "scene-overrun"));
});

test("CJK tokens split into pieces that keep their punctuation", () => {
  const pieces = splitCjkToken("設定，複製");
  assert.equal(pieces.join(""), "設定，複製");
  assert.ok(pieces.length >= 2);
  assert.ok(pieces.some((p) => p.endsWith("，")));
  assert.deepEqual(splitCjkToken("Messaging"), ["Messaging"]);
  assert.equal(displayWidth("設定ab"), 6);
});

function timed(text, durSec) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const total = tokens.reduce((a, t) => a + t.length + 1, 0);
  let at = 0;
  return tokens.map((t) => {
    const d = ((t.length + 1) / total) * durSec;
    const w = { word: t, start: at, end: at + d };
    at += d;
    return w;
  });
}

test("Chinese cues break at clause punctuation, without spaces between Han", () => {
  const cues = groupWords(timed(ZH, 9), [9000]);
  assert.ok(cues.length >= 2, JSON.stringify(cues));
  for (const c of cues) {
    assert.doesNotMatch(c.text, /[一-鿿] [一-鿿]/, c.text);
    assert.ok(displayWidth(c.text) <= 76, c.text);
  }
  assert.equal(cues.map((c) => c.text).join("").replace(/\s/g, ""), ZH.replace(/\s/g, ""));
  // every break but the last lands on 。，、
  for (const c of cues.slice(0, -1)) assert.match(c.text, /[，。、]$/, c.text);
});

test("knownTerms are never split across cues", () => {
  // Eleven short words, then the term straddling the 12-word cap.
  const text = "one two three four five six seven eight nine ten eleven Messaging API key here";
  const words = timed(text, 5);
  // Without the glossary, the 12-word cap cuts between "Messaging" and "API".
  const plain = groupWords(words, [5000]);
  assert.ok(plain.some((c) => / Messaging$/.test(c.text)), JSON.stringify(plain));
  const glued = groupWords(words, [5000], undefined, ["Messaging API"]);
  assert.ok(glued.every((c) => !/Messaging$/.test(c.text)), JSON.stringify(glued));
  assert.ok(glued.some((c) => c.text.includes("Messaging API")));
});

test("space-delimited cues are unchanged without knownTerms", () => {
  const text = "Sign in, open the billing page, and download the latest invoice. Then close the tab.";
  const a = groupWords(timed(text, 6), [6000]);
  const b = groupWords(timed(text, 6), [6000], undefined, []);
  assert.deepEqual(a, b);
  assert.equal(a.map((c) => c.text).join(" "), text);
});
