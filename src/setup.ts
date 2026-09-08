/**
 * Pre-take preparation (issue #44): seed cookies / a Playwright storageState
 * into the recording profile, and run an optional preflight hook — the two
 * things a cookie-gated or fixture-rotating site otherwise forces you to
 * script by hand around the engine.
 *
 * Seeding happens INSIDE the launched context (after Chrome is up, before the
 * first storyboard action), so it composes with `--fresh` (the wipe comes
 * first) and with a logged-in shared profile alike. The preflight hook runs
 * before Chrome launches, with the resolved profile dir in its env, so a
 * script that wants to seed the profile its own way still can.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { SeedCookie, Storyboard } from "./types.js";
import { log } from "./util.js";

/** Playwright's storageState file shape (the subset we consume). */
interface StorageStateFile {
  cookies?: SeedCookie[];
  origins?: Array<{
    origin: string;
    localStorage?: Array<{ name: string; value: string }>;
  }>;
}

/** Everything to inject into the context before the first action. */
export interface Seeds {
  cookies: SeedCookie[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  /** Where each seed came from, for the log line. */
  sources: string[];
}

/**
 * Parse one `--cookie` flag: `name=value;domain=host;path=/;secure;httpOnly;
 * sameSite=Lax;url=https://host/` — the first `k=v` is the cookie, the rest
 * are attributes (cookie-header style, so it can be pasted from DevTools).
 */
export function parseCookieFlag(spec: string): SeedCookie {
  const parts = spec
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error(`--cookie: empty spec`);
  const eq = parts[0].indexOf("=");
  if (eq <= 0) {
    throw new Error(`--cookie: expected name=value first, got "${parts[0]}"`);
  }
  const cookie: SeedCookie = {
    name: parts[0].slice(0, eq).trim(),
    value: parts[0].slice(eq + 1).trim(),
  };
  for (const attr of parts.slice(1)) {
    const i = attr.indexOf("=");
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? "" : attr.slice(i + 1).trim();
    switch (key) {
      case "domain":
        cookie.domain = val;
        break;
      case "path":
        cookie.path = val;
        break;
      case "url":
        cookie.url = val;
        break;
      case "expires":
        cookie.expires = Number(val);
        break;
      case "secure":
        cookie.secure = val === "" || val === "true";
        break;
      case "httponly":
        cookie.httpOnly = val === "" || val === "true";
        break;
      case "samesite": {
        const v = val.toLowerCase();
        cookie.sameSite = v === "strict" ? "Strict" : v === "none" ? "None" : "Lax";
        break;
      }
      default:
        throw new Error(`--cookie: unknown attribute "${key}" in "${spec}"`);
    }
  }
  if (!cookie.domain && !cookie.url) {
    throw new Error(
      `--cookie "${cookie.name}": add domain=<host> (or url=<origin>) so the ` +
        `browser knows which site it belongs to`
    );
  }
  return cookie;
}

/** Normalize a seed cookie into the shape `context.addCookies` accepts. */
function toPlaywrightCookie(c: SeedCookie) {
  if (c.url) {
    return {
      name: c.name,
      value: c.value,
      url: c.url,
      ...(c.expires != null ? { expires: c.expires } : {}),
      ...(c.httpOnly != null ? { httpOnly: c.httpOnly } : {}),
      ...(c.secure != null ? { secure: c.secure } : {}),
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    };
  }
  return {
    name: c.name,
    value: c.value,
    domain: c.domain!,
    path: c.path ?? "/",
    ...(c.expires != null ? { expires: c.expires } : {}),
    ...(c.httpOnly != null ? { httpOnly: c.httpOnly } : {}),
    ...(c.secure != null ? { secure: c.secure } : {}),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  };
}

export interface SeedInputs {
  /** CLI/MCP `--storage-state <file>` (in addition to the storyboard's). */
  storageState?: string;
  /** CLI/MCP `--cookie` specs, already parsed. */
  cookies?: SeedCookie[];
}

/**
 * Collect every seed the take should inject: the storyboard `setup` block
 * first, then CLI/MCP overrides on top. Relative storageState paths resolve
 * against the demo dir. Returns null when nothing is to be seeded.
 */
export async function collectSeeds(
  demoDir: string,
  storyboard: Storyboard,
  inputs: SeedInputs = {}
): Promise<Seeds | null> {
  const seeds: Seeds = { cookies: [], origins: [], sources: [] };
  const files = [storyboard.setup?.storageState, inputs.storageState].filter(
    (f): f is string => !!f
  );
  for (const f of files) {
    const path = isAbsolute(f) ? f : resolve(demoDir, f);
    let parsed: StorageStateFile;
    try {
      parsed = JSON.parse(await fs.readFile(path, "utf8")) as StorageStateFile;
    } catch (err) {
      throw new Error(`storageState ${path}: ${(err as Error).message}`);
    }
    const cookies = parsed.cookies ?? [];
    const origins = (parsed.origins ?? []).map((o) => ({
      origin: o.origin,
      localStorage: o.localStorage ?? [],
    }));
    seeds.cookies.push(...cookies);
    seeds.origins.push(...origins.filter((o) => o.localStorage.length > 0));
    seeds.sources.push(
      `${path} (${cookies.length} cookie(s), ${origins.length} origin(s))`
    );
  }
  const inline = [...(storyboard.setup?.cookies ?? []), ...(inputs.cookies ?? [])];
  if (inline.length) {
    seeds.cookies.push(...inline);
    seeds.sources.push(`${inline.length} inline cookie(s)`);
  }
  return seeds.cookies.length || seeds.origins.length ? seeds : null;
}

/**
 * Inject the seeds into a live context. Cookies go straight into the profile's
 * cookie jar; localStorage is per-origin and can only be written from a page
 * ON that origin, so each origin is visited once (about:blank is restored
 * afterwards — the visits land in the recording's trimmed lead-in).
 */
export async function applySeeds(
  context: BrowserContext,
  page: Page,
  seeds: Seeds
): Promise<void> {
  if (seeds.cookies.length) {
    await context.addCookies(seeds.cookies.map(toPlaywrightCookie));
  }
  for (const o of seeds.origins) {
    await page.goto(o.origin, { waitUntil: "domcontentloaded" });
    await page.evaluate((entries) => {
      for (const { name, value } of entries) localStorage.setItem(name, value);
    }, o.localStorage);
  }
  if (seeds.origins.length) await page.goto("about:blank");
  log(
    `seeded profile: ${seeds.cookies.length} cookie(s), ` +
      `${seeds.origins.length} origin(s) of localStorage ← ${seeds.sources.join("; ")}`
  );
}

export interface PreflightEnv {
  demoDir: string;
  storyboardPath: string;
  profileDir: string;
}

/**
 * Run the storyboard's `setup.preflight` shell command from the demo dir.
 * Output is streamed into the engine log (prefixed), a non-zero exit aborts
 * the take with the command's stderr tail.
 */
export async function runPreflight(command: string, env: PreflightEnv): Promise<void> {
  log(`preflight: ${command}`);
  const started = Date.now();
  await new Promise<void>((resolvePromise, reject) => {
    const proc = spawn(command, {
      cwd: env.demoDir,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AIDEMO_DEMO_DIR: env.demoDir,
        AIDEMO_STORYBOARD: env.storyboardPath,
        AIDEMO_PROFILE: env.profileDir,
      },
    });
    const tail: string[] = [];
    const relay = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        log(`  │ ${line}`);
        tail.push(line);
        if (tail.length > 20) tail.shift();
      }
    };
    proc.stdout.on("data", relay);
    proc.stderr.on("data", relay);
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      if (code === 0) return resolvePromise();
      reject(
        new Error(
          `preflight exited ${code ?? signal} — the take was not started.\n` +
            `  command: ${command}\n` +
            (tail.length ? `  last output:\n    ${tail.join("\n    ")}` : "")
        )
      );
    });
  });
  log(`preflight ok (${Date.now() - started}ms)`);
}
