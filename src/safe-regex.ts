import { RE2JS } from "re2js";

/**
 * Storyboard-supplied regex patterns (`assert.textMatches`, `assert.url`, and
 * the `textMatches` option the player threads through) are compiled at replay
 * time. A storyboard is data — it can arrive from an import, a template, or a
 * generated variant — so a pattern must not be able to hang the take. Compile
 * every one of them through here: the length cap and the nested-quantifier
 * check turn a catastrophic-backtracking pattern into an authoring error
 * raised before the browser ever touches it.
 */

/** Longest pattern we accept; real storyboard matchers are a few dozen chars. */
const MAX_PATTERN_LEN = 1000;

/**
 * A quantified group whose body is itself quantified — `(a+)+`, `(a*)*`,
 * `(\w+\s?)+` — is the shape that backtracks exponentially.
 */
const NESTED_QUANTIFIER = /\((?:\?[:=!<][a-zA-Z]*)?[^()]*[+*}][^()]*\)\s*[+*]|\((?:\?[:=!<][a-zA-Z]*)?[^()]*[+*][^()]*\)\s*\{\d+,\d*\}/;

export function isUnsafeRegexSource(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LEN)
    return `pattern is ${pattern.length} characters (limit ${MAX_PATTERN_LEN})`;
  if (NESTED_QUANTIFIER.test(pattern))
    return "pattern nests a quantifier inside a quantified group, which can backtrack exponentially";
  return null;
}

/**
 * Compile a storyboard-supplied pattern, or throw with `where` naming the
 * field so the author can see which matcher to fix.
 */
export function compileUserRegex(pattern: string, flags: string, where: string): RE2JS {
  if (typeof pattern !== "string" || pattern === "")
    throw new Error(`${where}: regex must be a non-empty string`);
  const unsafe = isUnsafeRegexSource(pattern);
  if (unsafe) throw new Error(`${where}: unsafe regex — ${unsafe}`);
  try {
    // RE2JS guarantees linear-time matching for storyboard supplied patterns.
    // The replay path only uses `test`, so its API is interchangeable here.
    if (flags && flags !== "i") throw new Error(`unsupported regex flags ${flags}`);
    return RE2JS.compile(pattern, flags === "i" ? RE2JS.CASE_INSENSITIVE : 0);
  } catch (e) {
    // A raw SyntaxError names neither the field nor the storyboard, which is
    // the only thing the author can act on.
    throw new Error(`${where}: invalid regex ${JSON.stringify(pattern)} — ${(e as Error).message}`);
  }
}
