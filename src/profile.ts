/**
 * Recording-profile hygiene.
 *
 * Takes replay against a persistent Chrome profile, which is what makes a
 * logged-in demo possible at all — and also the single most dangerous piece of
 * hidden state in the pipeline. A profile that already holds cookies or
 * localStorage for the app skips first-run gates, onboarding, empty states and
 * one-shot flows, and the take then *silently demonstrates the opposite of what
 * the narration says* (issue #39). The reviewer cannot tell; nothing failed.
 *
 * Two remedies live here: `--fresh`, which runs the take against a throwaway
 * profile, and a warning that names the trap when the shared profile already
 * has state for the storyboard's origin.
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { chromeProfileDir } from "./config.js";
import type { Storyboard } from "./types.js";
import { exists } from "./util.js";

/** Where a `--fresh` run's throwaway profile lives (wiped before each take). */
export function freshProfileDir(demoDir: string): string {
  return resolve(demoDir, ".chrome-profile-fresh");
}

/** Wipe and re-create the throwaway profile for a `--fresh` run. */
export async function resetProfile(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

/** The origin of the storyboard's first `goto`, or null if it has none. */
export function firstGotoOrigin(storyboard: Storyboard): string | null {
  for (const scene of storyboard.scenes) {
    for (const action of scene.actions) {
      if (action.op === "goto") {
        try {
          return new URL(action.url).origin;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Does the profile already hold state for `origin`? Checks Chrome's cookie and
 * Local Storage stores as opaque bytes — both record the origin as a plain
 * string, so a substring scan answers the question without launching a browser
 * or navigating anywhere. Best-effort: any read error means "don't warn".
 */
export async function profileHasStateFor(
  profileDir: string,
  origin: string
): Promise<boolean> {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  const needles = [host, `_${origin}`, origin];
  const roots = [
    join(profileDir, "Default", "Local Storage", "leveldb"),
    join(profileDir, "Default", "Session Storage"),
  ];
  const files: string[] = [join(profileDir, "Default", "Cookies")];
  for (const root of roots) {
    for (const f of await fs.readdir(root).catch(() => [] as string[])) {
      files.push(join(root, f));
    }
  }
  for (const file of files) {
    if (!(await exists(file))) continue;
    let buf: Buffer;
    try {
      buf = await fs.readFile(file);
    } catch {
      continue;
    }
    // Chrome writes leveldb keys as UTF-16 for values and ASCII for keys;
    // "latin1" catches the ASCII origin either way.
    const text = buf.toString("latin1");
    if (needles.some((n) => text.includes(n))) return true;
  }
  return false;
}

export interface ResolveProfileOptions {
  /** Explicit --profile dir, if any. */
  profileDir?: string;
  /** --fresh: run against a wiped throwaway profile in the demo dir. */
  fresh?: boolean;
}

/**
 * Pick the profile a take should run against, preparing it if needed, and
 * return any warning the caller should log. `--fresh` wins; otherwise the
 * shared profile is used and checked for carried-over state.
 */
export async function resolveProfile(
  demoDir: string,
  storyboard: Storyboard,
  opts: ResolveProfileOptions
): Promise<{ dir: string; warning?: string }> {
  if (opts.fresh) {
    const dir = opts.profileDir ?? freshProfileDir(demoDir);
    await resetProfile(dir);
    return { dir };
  }
  const dir = opts.profileDir ?? chromeProfileDir();
  const origin = firstGotoOrigin(storyboard);
  if (origin && (await profileHasStateFor(dir, origin))) {
    return {
      dir,
      warning:
        `profile already holds cookies/localStorage for ${origin} — a first-run ` +
        `gate, onboarding step or one-shot flow may be skipped, and the take ` +
        `would look fine while showing the wrong story. Re-run with --fresh ` +
        `for a clean identity.`,
    };
  }
  return { dir };
}
