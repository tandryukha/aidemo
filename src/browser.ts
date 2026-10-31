/**
 * Single choke point for every Playwright browser launch (issue #80).
 *
 * Every launch site — recorder, inspect, caption/card/frame/attention/cursor
 * rasterizers — goes through launchChrome()/launchChromePersistent(), which
 * merge chromeLaunchOptions() (AIDEMO_CHROME_EXECUTABLE > AIDEMO_CHROME_CHANNEL
 * > `channel: "chrome"`) into the caller's options. With neither env var set
 * the options are exactly the engine's historical `{ channel: "chrome", ... }`.
 */
import { chromium, type Browser, type BrowserContext, type LaunchOptions } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BrowserSetupError, chromeLaunchOptions, type ChromeLaunchTarget } from "./config.js";
import { log, ok } from "./util.js";

type PersistentOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

/** Executable name of Playwright's ffmpeg helper, per platform. */
const FFMPEG_HELPER_EXE: Partial<Record<NodeJS.Platform, string>> = {
  linux: "ffmpeg-linux",
  darwin: "ffmpeg-mac",
  win32: "ffmpeg-win64.exe",
};

/**
 * Playwright's own ffmpeg helper: the encoder recordVideo writes every take
 * with. It is neither the system ffmpeg (compose) nor a browser — a ~2 MB
 * download per Playwright ffmpeg *revision*, and no npm install fetches it
 * (playwright has no install script). So a fresh npx install, or a Playwright
 * minor that bumps the revision (1.64: 1011 → 1013, with VP9 encoding), leaves
 * it missing and the take fails at launch. Mirrors playwright-core's
 * documented lookup (PLAYWRIGHT_BROWSERS_PATH, else the per-OS
 * ms-playwright cache dir). `install` is the exact command for THIS engine's
 * Playwright. null when the location can't be determined.
 */
export function recorderFfmpeg(): {
  path: string;
  revision: string;
  /** This engine's playwright/cli.js — runs Playwright's own installer. */
  cli: string;
  install: string;
} | null {
  try {
    const exe = FFMPEG_HELPER_EXE[process.platform];
    if (!exe) return null;
    const req = createRequire(import.meta.url);
    const playwrightPkg = req.resolve("playwright/package.json");
    // playwright-core is playwright's dependency: resolve it from there.
    const corePkg = createRequire(playwrightPkg).resolve("playwright-core/package.json");
    const coreDir = dirname(corePkg);
    const browsers = JSON.parse(readFileSync(join(coreDir, "browsers.json"), "utf8")) as {
      browsers: Array<{ name: string; revision: string }>;
    };
    const revision = browsers.browsers.find((b) => b.name === "ffmpeg")?.revision;
    if (!revision) return null;
    const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
    let registry =
      env === "0"
        ? join(coreDir, ".local-browsers")
        : env || join(defaultPlaywrightCacheDir(), "ms-playwright");
    if (!isAbsolute(registry)) registry = resolve(process.env.INIT_CWD || process.cwd(), registry);
    const cli = join(dirname(playwrightPkg), "cli.js");
    return {
      path: join(registry, `ffmpeg-${revision}`, exe),
      revision,
      cli,
      install: `node "${cli}" install ffmpeg`,
    };
  } catch {
    return null;
  }
}

function defaultPlaywrightCacheDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches");
  if (process.platform === "win32") return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

/** AIDEMO_NO_AUTO_INSTALL=1: never download the helper (air-gapped / managed caches). */
export const recorderAutoInstall = (): boolean =>
  !/^(1|true|yes)$/i.test(process.env.AIDEMO_NO_AUTO_INSTALL?.trim() ?? "");

/**
 * Before a built-in capture launches, make sure Playwright's ffmpeg helper is
 * there, installing it with Playwright's own installer when it is not, so a
 * fresh install records out of the box (the GitHub Action runs the same step).
 * ~2 MB from Playwright's CDN, once per helper revision.
 * PLAYWRIGHT_SKIP_BROWSER_GC=1 keeps the installer from pruning browsers other
 * Playwright projects on the machine installed. With AIDEMO_NO_AUTO_INSTALL=1,
 * an unknown layout or an already-installed helper this is a no-op (a missing
 * helper then fails the launch with explainLaunchError's install command).
 */
export async function ensureRecorderFfmpeg(): Promise<void> {
  const helper = recorderFfmpeg();
  if (!helper || existsSync(helper.path) || !recorderAutoInstall()) return;
  log(
    `installing Playwright's ffmpeg helper (revision ${helper.revision}, ~2 MB, once per ` +
      `Playwright version; it encodes the take — AIDEMO_NO_AUTO_INSTALL=1 skips this)`
  );
  let output = "";
  const keep = (d: Buffer | string): void => {
    output = (output + d.toString()).slice(-4000);
  };
  const code = await new Promise<number | null>((done) => {
    const child = spawn(process.execPath, [helper.cli, "install", "ffmpeg"], {
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: "1" },
      // Off stdout: under `aidemo mcp`, stdout is the JSON-RPC channel.
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.on("error", (err) => {
      keep(String(err));
      clearTimeout(timer);
      done(null);
    });
    child.on("close", (c) => {
      clearTimeout(timer);
      done(c);
    });
  });
  if (code !== 0 || !existsSync(helper.path)) {
    // The installer prints the cause as "Error: …" between stack frames and an
    // error-object dump; surface that line, not the frames.
    const lines = output
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("at ") && !/^[{}]$/.test(l));
    // Root cause first ("connect ECONNREFUSED …", "server returned code 403"),
    // then the installer's own summary line.
    const errors = [...new Set(lines.filter((l) => /error/i.test(l)))];
    const why = (errors.length ? errors.slice(0, 2) : lines.slice(-1))
      .map((l) => l.slice(0, 200))
      .join(" — ");
    throw new BrowserSetupError(
      `could not install Playwright's ffmpeg helper (revision ${helper.revision}), which the ` +
        `take is recorded with${why ? `: ${why}` : ""}. Install it yourself: ${helper.install}`
    );
  }
  ok(`Playwright ffmpeg helper installed (revision ${helper.revision})`);
}

/** A launch that failed on Playwright's missing ffmpeg helper, not on the browser. */
const FFMPEG_HELPER_RE = /playwright install ffmpeg|[\\/]ffmpeg-\d+[\\/]ffmpeg/i;

/** Human-readable description of the configured browser, for logs/doctor. */
export function describeChromeTarget(target: ChromeLaunchTarget = chromeLaunchOptions()): string {
  if ("executablePath" in target) return `executable ${target.executablePath} (AIDEMO_CHROME_EXECUTABLE)`;
  return target.channel === "chrome" && !process.env.AIDEMO_CHROME_CHANNEL?.trim()
    ? `channel chrome (default — system Google Chrome)`
    : `channel ${target.channel} (AIDEMO_CHROME_CHANNEL)`;
}

const MISSING_RE =
  /Executable doesn't exist|is not found at|distribution '[^']*' is not found|npx playwright install|ENOENT/i;

/**
 * Turn a "browser binary not found" launch failure into an actionable error.
 * Any other failure is returned untouched so callers' own wrapping (e.g. the
 * recorder's profile-lock hint) still sees the original message.
 */
export function explainLaunchError(err: unknown, target: ChromeLaunchTarget): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  if (!MISSING_RE.test(e.message)) return e;
  if (FFMPEG_HELPER_RE.test(e.message)) {
    // The browser is fine — Playwright's recording helper is what's missing.
    // Blaming Chrome here sent users to reinstall a browser that works.
    const helper = recorderFfmpeg();
    const out = new BrowserSetupError(
      `Playwright's ffmpeg helper${helper ? ` (revision ${helper.revision})` : ""} is missing — ` +
        `the ~2 MB encoder Playwright records the take with (not the system ffmpeg, not a ` +
        `browser; no npm install fetches it). Install it once per Playwright version: ` +
        `${helper?.install ?? "npx playwright install ffmpeg"}` +
        `\nOriginal error: ${e.message}`
    );
    (out as Error & { cause?: unknown }).cause = e;
    return out;
  }
  let hint: string;
  if ("executablePath" in target) {
    hint =
      `AIDEMO_CHROME_EXECUTABLE=${target.executablePath} could not be launched — ` +
      `point it at an existing Chromium-based browser binary, or unset it.`;
  } else if (target.channel === "chromium") {
    hint =
      `Playwright's Chromium (AIDEMO_CHROME_CHANNEL=chromium) is not installed — ` +
      `run: npx playwright install chromium   (or unset AIDEMO_CHROME_CHANNEL to use system Chrome).`;
  } else if (target.channel === "chrome") {
    hint =
      `Google Chrome was not found. Install Chrome, or use Playwright's Chromium: ` +
      `npx playwright install chromium && set AIDEMO_CHROME_CHANNEL=chromium ` +
      `(or AIDEMO_CHROME_EXECUTABLE=/path/to/chrome).`;
  } else {
    hint =
      `Browser channel "${target.channel}" (AIDEMO_CHROME_CHANNEL) is not installed — ` +
      `install it (npx playwright install ${target.channel}) or unset AIDEMO_CHROME_CHANNEL.`;
  }
  const out = new BrowserSetupError(`${hint}\nOriginal error: ${e.message}`);
  (out as Error & { cause?: unknown }).cause = e;
  return out;
}

/** chromium.launch() with the configured browser. */
export async function launchChrome(options: Omit<LaunchOptions, "channel" | "executablePath"> = {}): Promise<Browser> {
  const target = chromeLaunchOptions();
  try {
    return await chromium.launch({ ...target, ...options });
  } catch (err) {
    throw explainLaunchError(err, target);
  }
}

/** chromium.launchPersistentContext() with the configured browser. */
export async function launchChromePersistent(
  userDataDir: string,
  options: Omit<PersistentOptions, "channel" | "executablePath"> = {}
): Promise<BrowserContext> {
  const target = chromeLaunchOptions();
  try {
    return await chromium.launchPersistentContext(userDataDir, { ...target, ...options });
  } catch (err) {
    throw explainLaunchError(err, target);
  }
}

/**
 * Doctor probe for a NON-default browser target: launch it headless once and
 * read its version. Returns `{ version }` or `{ error }` (actionable message).
 */
export async function probeConfiguredBrowser(): Promise<{ version: string } | { error: string }> {
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: true, timeout: 20000 });
    return { version: browser.version() };
  } catch (err) {
    return { error: (err as Error).message.split("\n")[0] };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * Binary for a NON-Playwright launch (`aidemo login` opens a normal window on
 * the profile) when the configured browser isn't system Chrome: the
 * AIDEMO_CHROME_EXECUTABLE path, or Playwright's Chromium for
 * AIDEMO_CHROME_CHANNEL=chromium. null = keep login's system-Chrome launch.
 */
export function manualLaunchBinary(): string | null {
  const target = chromeLaunchOptions();
  if ("executablePath" in target) return target.executablePath;
  if (target.channel === "chromium") return chromium.executablePath();
  return null;
}
