/**
 * Redaction for diagnostics.
 *
 * A failed take writes `logs/fail-*.json` (and log lines) containing live URLs
 * and, for XHR/fetch failures, a snippet of the response body. Those come from
 * whatever app was being recorded — a magic-link callback, an OAuth redirect or
 * an error payload can easily carry a session token. The logs are meant to be
 * pasted into an issue, so anything that looks like a credential is masked
 * before it is written. This is a best-effort net, not a guarantee: it never
 * throws, and it errs toward masking.
 */

const MASK = "REDACTED";

/** Query/form parameter names whose *value* is never printed. */
const SECRET_PARAM =
  /^(?:.*[-_])?(?:token|access[-_]?token|id[-_]?token|refresh[-_]?token|secret|password|passwd|pwd|api[-_]?key|apikey|key|auth|authorization|session|sig|signature|code|credential|assertion)$/i;

/** Free-text shapes that are credentials wherever they appear. */
const SECRET_SHAPES: Array<[RegExp, string]> = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // Provider-prefixed keys (sk-…, ghp_…, xoxb-…, AKIA…).
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // JSON/pair values under a secret-looking name.
  [
    /("?)([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[-_]?key|apikey|authorization|credential)[A-Za-z0-9_-]*)\1(\s*[:=]\s*)("?)[^"\s,}&]+\4/gi,
    `$1$2$1$3$4${MASK}$4`,
  ],
];

/** Mask credential-shaped substrings in free text (response bodies, errors). */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, to] of SECRET_SHAPES) out = out.replace(re, to);
  return out;
}

/**
 * Mask secret-bearing query/fragment parameters, then truncate to `n` chars.
 * Anything that doesn't parse as a URL still goes through {@link redactSecrets}.
 */
export function redactUrl(url: string, n = 90): string {
  let safe: string;
  try {
    const u = new URL(url);
    for (const params of [u.searchParams, new URLSearchParams(u.hash.replace(/^#/, ""))]) {
      let touched = false;
      for (const name of [...params.keys()]) {
        if (SECRET_PARAM.test(name)) {
          params.set(name, MASK);
          touched = true;
        }
      }
      if (touched && params !== u.searchParams) u.hash = params.toString();
    }
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    safe = redactSecrets(u.toString());
  } catch {
    // Not an absolute URL (about:blank, a relative href, a data: blob).
    safe = redactSecrets(url);
  }
  return safe.length > n ? safe.slice(0, n) + "…" : safe;
}
