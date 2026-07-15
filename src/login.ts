import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromeProfileDir } from "./config.js";
import { ensureDir, log, ok, step, sleep } from "./util.js";

/**
 * Manual-login helper for the recording profile (issue #22).
 *
 * Recording needs a Chrome profile that is already logged into the demo
 * subject (e.g. ChatGPT with a dev connector enabled). You can't copy a login
 * in: real Chrome encrypts cookies with the OS keychain, while Playwright
 * launches with `--use-mock-keychain --password-store=basic` — so the login
 * must happen ONCE in a Chrome using the same mock store. `aidemo login` runs
 * that exact incantation (previously hand-copied from the docs), then waits
 * for the user to quit Chrome so the profile lock is free for `record`.
 */

/**
 * Chrome's profile-singleton lock: `SingletonLock` in the user-data dir is a
 * symlink whose target is `<hostname>-<pid>`. Returns the pid, or null when
 * the profile isn't locked.
 */
export async function profileLockPid(profileDir: string): Promise<number | null> {
  try {
    const target = await fs.readlink(join(profileDir, "SingletonLock"));
    const pid = Number(target.split("-").pop());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // no lock file → not locked
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but owned by someone else; ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Preflight for `record`: a Chrome still running on the profile means
 * Playwright can't take the lock, and the raw failure (a ProcessSingleton
 * error after a long stall) doesn't say what to do. A LIVE lock aborts with
 * the actual fix; a STALE lock (Chrome crashed and left it behind, which also
 * breaks the launch) is removed.
 */
export async function ensureProfileUnlocked(profileDir: string): Promise<void> {
  const pid = await profileLockPid(profileDir);
  if (pid == null) return;
  if (pidAlive(pid)) {
    throw new Error(
      `Chrome is still running on profile ${profileDir} (pid ${pid}) — ` +
        `recording needs exclusive access to the profile. Quit that Chrome ` +
        `completely (Cmd+Q, not just the window), then re-run. ` +
        `(If no Chrome is actually running, delete ${join(profileDir, "SingletonLock")} ` +
        `and retry. To log in on this profile first: aidemo login)`
    );
  }
  await fs.rm(join(profileDir, "SingletonLock"), { force: true });
  log(`removed stale SingletonLock from ${profileDir} (previous Chrome exited uncleanly)`);
}

export interface LoginOptions {
  /** Page to open for the login. Default: https://chatgpt.com/ */
  url?: string;
  /** Launch Chrome and print next steps without waiting for it to quit. */
  noWait?: boolean;
}

/**
 * Open a NORMAL Chrome window on the recording profile with the same
 * cookie-store flags the recorder launches with, wait for the user to log in
 * and quit, then report the profile ready. A normal window (not a Playwright
 * launch) also dodges Google SSO's automation block.
 */
export async function login(profileDir?: string, opts: LoginOptions = {}): Promise<void> {
  const dir = resolve(profileDir ?? chromeProfileDir());
  const url = opts.url ?? "https://chatgpt.com/";
  await ensureDir(dir);

  const livePid = await profileLockPid(dir);
  if (livePid != null && pidAlive(livePid)) {
    log(`Chrome is already running on this profile (pid ${livePid}) — reusing that window.`);
  } else {
    await fs.rm(join(dir, "SingletonLock"), { force: true });
    step(`Opening Chrome on profile ${dir}`);
    const args = [
      `--user-data-dir=${dir}`,
      // Same cookie store the recorder uses — a login made without these
      // flags is keychain-encrypted and unreadable at record time.
      "--password-store=basic",
      "--use-mock-keychain",
      "--no-first-run",
      "--no-default-browser-check",
      url,
    ];
    if (process.platform === "darwin") {
      spawn("open", ["-na", "Google Chrome", "--args", ...args], {
        stdio: "ignore",
        detached: true,
      }).unref();
    } else {
      const bin = process.env.CHROME_BIN || "google-chrome";
      const child = spawn(bin, args, { stdio: "ignore", detached: true });
      child.on("error", () => {
        log(`could not launch "${bin}" (set CHROME_BIN) — open Chrome yourself with:`);
        log(`  ${bin} ${args.join(" ")}`);
      });
      child.unref();
    }
  }

  log(`1. Log in at ${url} in the window that opened (finish any 2FA).`);
  log(`2. Set the page up for recording (e.g. enable your app's dev connector).`);
  log(`3. Quit Chrome COMPLETELY (Cmd+Q — not just the window).`);
  const recordHint = `aidemo record <demo-dir>${profileDir ? ` --profile ${dir}` : ""}`;
  if (opts.noWait) {
    ok(`when you've quit Chrome, the profile is ready → ${recordHint}`);
    return;
  }

  // Wait for Chrome to take the lock (it starts async), then release it.
  const appearDeadline = Date.now() + 60_000;
  while ((await profileLockPid(dir)) == null && Date.now() < appearDeadline) {
    await sleep(500);
  }
  if ((await profileLockPid(dir)) == null) {
    log(`Chrome never took the profile lock (waited 60s) — did the window open?`);
    log(`finish the login manually, quit Chrome, then: ${recordHint}`);
    return;
  }
  log(`waiting for you to finish and quit Chrome… (Ctrl-C to stop waiting)`);
  for (;;) {
    const pid = await profileLockPid(dir);
    if (pid == null || !pidAlive(pid)) break;
    await sleep(1000);
  }
  ok(`profile ready → ${recordHint}`);
}
