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
import { BrowserSetupError, chromeLaunchOptions, type ChromeLaunchTarget } from "./config.js";

type PersistentOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

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
