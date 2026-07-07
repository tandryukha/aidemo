import type { Storyboard } from "./types.js";

/**
 * Placeholder substitution for parameterized storyboards.
 *
 * A storyboard may declare a top-level `params` map (name → default value). Any
 * storyboard string may then reference a declared param as `{{name}}`. At LOAD
 * time the engine resolves each param to a caller-provided override (CLI
 * `--param`, MCP `params`, or a variant's params) else its declared default,
 * and substitutes every `{{name}}` occurrence. The SAME resolved set is used
 * across all pipeline stages of one run, so a param that changes narration
 * re-voices + re-captions, and one that changes a url / typed text changes the
 * recorded take.
 *
 * Substitution runs AFTER zod validation on the already-typed storyboard, so it
 * only ever touches fields that are legitimately strings — a placeholder mistyped
 * into a numeric field (e.g. `"scale": "{{s}}"`) fails schema validation first
 * with a clear "expected number" error. Placeholders work in EVERY string leaf
 * except the `params` block itself: narration, action `url`, `type` text, card
 * title/subtitle, waitFor* `textMatches`, voice `instructions`, and even
 * selectors if you want dynamic targeting.
 *
 * Two errors, both raised at load time before any stage runs:
 *   - a `{{name}}` that isn't declared → hard error listing the missing names
 *   - an explicit override whose key isn't declared → hard error (typo guard).
 *     Non-explicit (auto/persisted) params are filtered instead of erroring, so
 *     a stale generated/params.json can never break a param-less load.
 */

/** {{ name }} — word chars, dot, dash; surrounding whitespace tolerated. */
const PLACEHOLDER_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

export type ParamResult =
  | { ok: true; storyboard: Storyboard; resolved: Record<string, string> }
  | { ok: false; message: string };

const has = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

/** Substitute {{name}} in every string leaf; record any undeclared reference. */
function substitute(
  value: unknown,
  resolved: Record<string, string>,
  missing: Set<string>
): unknown {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER_RE, (m, name: string) => {
      if (has(resolved, name)) return resolved[name];
      missing.add(name);
      return m;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitute(v, resolved, missing));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substitute(v, resolved, missing);
    }
    return out;
  }
  return value;
}

export interface ApplyParamsOptions {
  /** Caller-provided overrides (CLI --param / MCP params / variant params). */
  provided?: Record<string, string>;
  /**
   * true = explicit user input: an override key that isn't declared is a hard
   * error (typo guard). false = auto/persisted params: undeclared keys are
   * silently dropped so a stale params.json can't break a load.
   */
  strict?: boolean;
}

/**
 * Resolve params against a storyboard's declared defaults and substitute all
 * placeholders. `storyboard` must already be zod-validated.
 */
export function applyParams(
  storyboard: Storyboard,
  opts: ApplyParamsOptions = {}
): ParamResult {
  const declared = storyboard.params ?? {};
  const provided = opts.provided ?? {};

  const undeclared = Object.keys(provided).filter((k) => !has(declared, k));
  let effective = provided;
  if (undeclared.length) {
    if (opts.strict) {
      const names = Object.keys(declared);
      return {
        ok: false,
        message:
          `unknown param ${undeclared.map((n) => `"${n}"`).join(", ")}. ` +
          `Declared params: ${
            names.length
              ? names.join(", ")
              : '(none — add a top-level "params" block to the storyboard)'
          }.`,
      };
    }
    // Lenient (auto/persisted): keep only declared keys.
    effective = Object.fromEntries(
      Object.entries(provided).filter(([k]) => has(declared, k))
    );
  }

  const resolved: Record<string, string> = { ...declared, ...effective };

  // Substitute over the whole storyboard EXCEPT the declared params block.
  const { params: _declaredBlock, ...body } = storyboard as Record<string, unknown>;
  const missing = new Set<string>();
  const substituted = substitute(body, resolved, missing) as Record<string, unknown>;
  if (missing.size) {
    return {
      ok: false,
      message:
        `undeclared placeholder(s): ${[...missing]
          .map((n) => `{{${n}}}`)
          .join(", ")}. Add ${
          missing.size > 1 ? "them" : "it"
        } to the storyboard's "params" block (with a default) or pass via --param.`,
    };
  }

  // Re-attach the declared params block unchanged so downstream stages and a
  // persisted copy still see the declaration.
  const result = storyboard.params
    ? { ...substituted, params: storyboard.params }
    : substituted;
  return { ok: true, storyboard: result as unknown as Storyboard, resolved };
}
