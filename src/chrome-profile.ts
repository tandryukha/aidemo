import { promises as fs, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `--chrome-profile`: record in the user's EXISTING, signed-in Chrome profile.
 *
 * Why a clone: Chrome 136+ refuses remote debugging / automation on its
 * default user-data dir, and locks that dir while Chrome runs. So the chosen
 * profile is copied (copy-on-write on APFS, caches skipped) into a temp
 * user-data dir, and the take launches real Chrome on the copy.
 *
 * Why the real keychain: Playwright launches Chrome with
 * `--use-mock-keychain --password-store=basic`, so cookies in a real profile
 * would be unreadable. We drop those two flags (`ignoreDefaultArgs`) and real
 * Chrome decrypts its own cookies through the macOS Keychain ("Chrome Safe
 * Storage" — macOS may ask once; click Allow). aidemo never reads, decrypts or
 * exports a cookie: the cookie files are copied as opaque bytes and only
 * Chrome itself opens them. The clone is deleted after the run.
 */

export interface ChromeProfileSpec {
  /** "default" (= the OS default Chrome user-data dir) or a user-data dir path. */
  source: string;
  /** Profile folder inside the user-data dir ("Default", "Profile 1", …). */
  profileDirectory?: string;
}

/** Persistent aidemo-owned profile (real keychain), outside the npx cache. */
export function ownChromeProfileDir(): string {
  return process.env.AIDEMO_OWN_CHROME_PROFILE?.trim() || join(homedir(), ".aidemo", "chrome-profile");
}

export interface ChromeProfileClone {
  /** True for the aidemo-owned persistent profile: not a copy, never deleted. */
  persistent?: boolean;
  /** Temp user-data dir to pass to launchPersistentContext. */
  dir: string;
  profileDirectory: string;
  /** Extra launch options for real-keychain Chrome on the clone. */
  launch: { ignoreDefaultArgs: string[]; args: string[] };
  /** Delete the clone (idempotent). */
  cleanup(): Promise<void>;
}

/** The flags Playwright adds that force a throwaway cookie store. */
export const MOCK_KEYCHAIN_ARGS = ["--use-mock-keychain", "--password-store=basic"];

export function defaultChromeUserDataDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Google", "Chrome");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Google", "Chrome", "User Data");
  return join(homedir(), ".config", "google-chrome");
}

/** Turn the CLI value (`true` for a bare flag, "default", or a path) into a spec. */
export function parseChromeProfile(
  value: string | boolean | undefined,
  profileDirectory?: string
): ChromeProfileSpec | undefined {
  const env = process.env.AIDEMO_CHROME_PROFILE_FROM?.trim();
  const v = value === undefined || value === false ? env || undefined : value;
  if (v === undefined) return undefined;
  const source = v === true || v === "default" || v === "" ? "default" : v === "own" ? "own" : String(v);
  return {
    source,
    profileDirectory: profileDirectory || process.env.AIDEMO_CHROME_PROFILE_NAME?.trim() || undefined,
  };
}

/** Names (at any depth) that are caches/locks and never needed to stay signed in. */
const SKIP_NAMES = new Set([
  "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "GrShaderCache", "GraphiteDawnCache", "ShaderCache", "Media Cache", "CacheStorage",
  "ScriptCache", "Crashpad", "BrowserMetrics", "Safe Browsing", "component_crx_cache",
  "extensions_crx_cache", "optimization_guide_model_store", "OptGuideOnDeviceModel",
  "SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile", "LOCK",
  "Extensions", "History", "Favicons", "Top Sites", "Visited Links", "Shortcuts",
  "Thumbnails", "Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs",
]);

function keep(src: string): boolean {
  const name = src.split("/").pop() ?? src;
  return !SKIP_NAMES.has(name) && !name.endsWith(".pma");
}

export async function cloneChromeProfile(spec: ChromeProfileSpec): Promise<ChromeProfileClone> {
  if (spec.source === "own") {
    // Sign in once with `aidemo login --own`; Chrome writes its cookies with the
    // real keychain, so the same Chrome can read them back on every take.
    const dir = ownChromeProfileDir();
    await fs.mkdir(dir, { recursive: true });
    return { dir, persistent: true, profileDirectory: "Default", launch: { ignoreDefaultArgs: MOCK_KEYCHAIN_ARGS, args: [] }, cleanup: async () => {} };
  }
  const source = spec.source === "default" ? defaultChromeUserDataDir() : resolve(spec.source);
  const profileDirectory = spec.profileDirectory || "Default";
  const profileSrc = join(source, profileDirectory);
  const stat = await fs.stat(profileSrc).catch(() => null);
  if (!stat?.isDirectory()) {
    const have = (await fs.readdir(source).catch(() => [] as string[])).filter(
      (n) => n === "Default" || /^Profile \d+$/.test(n)
    );
    throw new Error(
      `Chrome profile folder not found: ${profileSrc}` +
        (have.length ? ` — profiles in ${source}: ${have.join(", ")} (pick one with --chrome-profile-dir)` : ` — is "${source}" a Chrome user-data dir?`)
    );
  }
  const dir = await fs.mkdtemp(join(tmpdir(), "aidemo-chrome-"));
  let removed = false;
  const exitHook = () => {
    if (!removed) rmSync(dir, { recursive: true, force: true });
  };
  process.once("exit", exitHook);
  const cleanup = async () => {
    if (removed) return;
    removed = true;
    process.removeListener("exit", exitHook);
    await fs.rm(dir, { recursive: true, force: true });
  };
  try {
    // COPYFILE_FICLONE = copy-on-write on APFS (instant, no extra disk), plain
    // copy elsewhere. Cookie WAL/journal files are copied with their DB.
    const opts = { recursive: true, force: true, filter: keep, mode: (await import("node:fs")).constants.COPYFILE_FICLONE } as const;
    await fs.copyFile(join(source, "Local State"), join(dir, "Local State"));
    await fs.cp(profileSrc, join(dir, profileDirectory), opts);
  } catch (err) {
    await cleanup();
    throw new Error(`Could not clone Chrome profile ${profileSrc}: ${(err as Error).message}`);
  }
  return {
    dir,
    profileDirectory,
    launch: {
      ignoreDefaultArgs: MOCK_KEYCHAIN_ARGS,
      args: [`--profile-directory=${profileDirectory}`],
    },
    cleanup,
  };
}
