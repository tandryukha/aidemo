/**
 * Script-aware text helpers (issue #96). Chinese and Japanese prose has no
 * spaces between words, so a whitespace split counts a whole clause as one
 * "word" (pacing forecasts read ≈1-2 s for ≈8 s of speech) and gives caption
 * segmentation nothing to break on. Everything here is a no-op for text
 * without Han/kana characters, so space-delimited scripts behave exactly as
 * before. Hangul is space-delimited and deliberately not treated as CJK.
 */

/** Han ideographs, kana, CJK punctuation and fullwidth forms. */
const CJK_CHAR =
  /[　-〿぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿＀-￯]/u;
const CJK_GLOBAL = new RegExp(CJK_CHAR.source, "gu");
/** Han ideographs and kana only — the characters that are actually spoken. */
const CJK_SPOKEN =
  /[぀-ゟ゠-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿]/gu;

/** One Han/kana character ≈ half a word: Mandarin TTS reads ≈4-5 characters
 *  a second, which the zh rate (≈2.4 w/s) then prices correctly. */
const CJK_CHARS_PER_WORD = 2;

export function hasCjk(text: string): boolean {
  return CJK_CHAR.test(text);
}

/**
 * Word count for pacing. Space-delimited text: the whitespace split, unchanged.
 * Text with Han/kana: the space-delimited words that remain once those
 * characters are removed (English UI labels inside Chinese prose), plus one
 * word per two Han/kana characters.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (!hasCjk(trimmed)) return trimmed.split(/\s+/).length;
  const spoken = (trimmed.match(CJK_SPOKEN) ?? []).length;
  const rest = trimmed.replace(CJK_GLOBAL, " ").trim();
  const latin = rest ? rest.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length : 0;
  return latin + Math.ceil(spoken / CJK_CHARS_PER_WORD);
}

/** Fractional word units of one caption piece: Han/kana at two characters a
 *  word, any Latin word in it at one. Never 0 for a non-empty piece. */
export function cjkWordUnits(piece: string): number {
  const spoken = (piece.match(CJK_SPOKEN) ?? []).length;
  const rest = piece.replace(CJK_GLOBAL, " ").trim();
  const latin = rest ? rest.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length : 0;
  return Math.max(0.5, latin + spoken / CJK_CHARS_PER_WORD);
}

/** Display width in Latin-character columns: fullwidth CJK counts double. */
export function displayWidth(text: string): number {
  return text.length + (text.match(CJK_GLOBAL) ?? []).length;
}

let segmenter: Intl.Segmenter | null | undefined;
function wordSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    try {
      segmenter = new Intl.Segmenter("zh", { granularity: "word" });
    } catch {
      segmenter = null; // small-icu Node: fall back to per-character pieces
    }
  }
  return segmenter;
}

/**
 * Split one whitespace token that contains CJK text into caption-sized pieces:
 * dictionary words (Intl.Segmenter), with punctuation kept on the piece before
 * it so clause/sentence detection still sees it. A token with no CJK comes
 * back as-is.
 */
export function splitCjkToken(token: string): string[] {
  if (!hasCjk(token)) return [token];
  const seg = wordSegmenter();
  const raw = seg
    ? Array.from(seg.segment(token), (s) => ({ text: s.segment, word: s.isWordLike === true }))
    : Array.from(token, (ch) => ({ text: ch, word: /[\p{L}\p{N}]/u.test(ch) }));
  const out: string[] = [];
  for (const piece of raw) {
    if (!piece.text.trim()) continue;
    if (!piece.word && out.length) out[out.length - 1] += piece.text;
    else out.push(piece.text);
  }
  return out.length ? out : [token];
}

/** Join caption pieces: a space between them unless both sides are CJK. */
export function joinPieces(pieces: string[]): string {
  let out = "";
  for (const p of pieces) {
    if (!p) continue;
    if (out && !(CJK_CHAR.test(out[out.length - 1]) && CJK_CHAR.test(p[0]))) out += " ";
    out += p;
  }
  return out;
}
