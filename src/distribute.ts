/** Distribution kit: install / update / check the record-demo skill in a
 * consumer repo, bootstrap a repo (`repo-init`), file feedback upstream, and a
 * `doctor` preflight. The engine itself stays centralized — a consumer repo
 * only ever holds a version-stamped COPY of the skill plus a SessionStart hook
 * that runs `aidemo skill check`.
 *
 * Design notes:
 * - The engine is meant to be invoked as `npx -y github:tandryukha/demo-engine#stable`.
 *   When run that way the engine's OWN version (engineVersion(), read from its
 *   bundled package.json) IS the latest stable — so `skill check` just compares
 *   that against the local installed.json, no extra network needed.
 * - Installable file bodies are kept as template strings here (like starter.ts)
 *   so the commands have no file deps when run from an npx temp dir.
 */
import { promises as fs } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform, release } from "node:os";
import { ENGINE_ROOT, engineVersion } from "./config.js";
import { Project } from "./project.js";
import { STARTER_BRIEF, STARTER_STORYBOARD } from "./starter.js";
import { ensureDir, exists, ok, step, fail, log } from "./util.js";

const execFileAsync = promisify(execFile);

export const UPSTREAM_REPO = "tandryukha/demo-engine";
export const UPSTREAM_SPEC = `github:${UPSTREAM_REPO}#stable`;
const SKILL_REL = ".claude/skills/record-demo/SKILL.md";
const MANIFEST_REL = ".claude/skills/record-demo/installed.json";
const SETTINGS_REL = ".claude/settings.json";

interface Manifest {
  name: string;
  version: string;
  source: string;
  installedAt: string;
}

const engineSkillPath = () => resolve(ENGINE_ROOT, SKILL_REL);
const targetOf = (dir?: string) => resolve(process.cwd(), dir ?? ".");

/** Compare dotted numeric versions. Returns >0 if a>b, <0 if a<b, 0 if equal. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function readManifest(target: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await fs.readFile(resolve(target, MANIFEST_REL), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/** Copy the engine's SKILL.md into the target repo and stamp installed.json. */
export async function installSkill(
  dir: string | undefined,
  opts: { force?: boolean; quiet?: boolean } = {}
): Promise<void> {
  const target = targetOf(dir);
  const skillSrc = engineSkillPath();
  if (!(await exists(skillSrc))) {
    throw new Error(`engine skill not found at ${skillSrc} (is this a full engine checkout?)`);
  }
  const skillDest = resolve(target, SKILL_REL);
  if ((await exists(skillDest)) && !opts.force) {
    const m = await readManifest(target);
    if (m) {
      if (!opts.quiet) ok(`record-demo skill already installed (v${m.version}); use --force to overwrite`);
      return;
    }
  }
  await ensureDir(dirname(skillDest));
  await fs.copyFile(skillSrc, skillDest);
  const manifest: Manifest = {
    name: "record-demo",
    version: engineVersion(),
    source: UPSTREAM_SPEC,
    installedAt: new Date().toISOString(),
  };
  await fs.writeFile(resolve(target, MANIFEST_REL), JSON.stringify(manifest, null, 2) + "\n");
  if (!opts.quiet) ok(`installed record-demo skill v${manifest.version} → ${SKILL_REL}`);
}

/**
 * Compare the installed skill version against this (stable) engine's version.
 * Prints a one-line update notice when behind; silent + exit 0 otherwise so it
 * is safe to run from a SessionStart hook. Never mutates the repo.
 */
export async function checkSkill(
  dir: string | undefined,
  opts: { verbose?: boolean } = {}
): Promise<void> {
  const target = targetOf(dir);
  const manifest = await readManifest(target);
  if (!manifest) {
    if (opts.verbose) log(`no record-demo skill installed here (nothing to check)`);
    return; // not a consumer repo / not initialized — stay silent
  }
  const latest = engineVersion();
  if (cmpVersion(latest, manifest.version) > 0) {
    step(`record-demo skill update available`);
    ok(`installed v${manifest.version} → stable v${latest}`);
    ok(`apply with: npx -y ${UPSTREAM_SPEC} skill update --dir "${target}"`);
  } else if (opts.verbose) {
    ok(`record-demo skill is up to date (v${manifest.version})`);
  }
}

const SETTINGS_TEMPLATE = (): string =>
  JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                // Non-blocking: surfaces "update available" at session start.
                // `|| true` so a network hiccup never blocks the session.
                command: `npx -y ${UPSTREAM_SPEC} skill check --dir "$CLAUDE_PROJECT_DIR" 2>/dev/null || true`,
              },
            ],
          },
        ],
      },
    },
    null,
    2
  ) + "\n";

const POINTER_DOC = (): string => `# record-demo skill — how this got here & how to keep it fresh

This repo carries a **copy** of the \`record-demo\` skill from the
[demo-engine](https://github.com/${UPSTREAM_REPO}) (aidemo). The engine itself is
**not** vendored — it is run on demand via npx from a pinned \`stable\` tag.

Everywhere below, \`aidemo\` means:

    npx -y ${UPSTREAM_SPEC}

## Stay up to date
A \`SessionStart\` hook in \`.claude/settings.json\` runs \`aidemo skill check\` and
prints a notice when a newer skill is available. Nothing is overwritten silently —
apply an update when you're ready:

    npx -y ${UPSTREAM_SPEC} skill update --dir .

## Record a demo
    npx -y ${UPSTREAM_SPEC} init <name>            # scaffold demos/<name>/
    npx -y ${UPSTREAM_SPEC} render demos/<name>    # voice → record → captions → compose

(Needs Chrome, ffmpeg and OPENAI_API_KEY — run \`aidemo doctor\` to check.)

## Send feedback upstream
Hit a broken selector, bad timing, or have an idea? File it on the engine:

    npx -y ${UPSTREAM_SPEC} feedback demos/<name>
`;

/** Scaffold demos/<name>/ under baseDir from the built-in starter templates. */
export async function scaffoldDemo(
  baseDir: string,
  name: string,
  opts: { force?: boolean } = {}
): Promise<string> {
  const dir = resolve(baseDir, "demos", name);
  if ((await exists(dir)) && !opts.force) {
    ok(`demos/${name} already exists — skipping scaffold`);
    return dir;
  }
  const project = new Project(dir);
  await project.ensureDirs();
  await fs.writeFile(project.p("input", "brief.md"), STARTER_BRIEF(name));
  await fs.writeFile(project.storyboardPath, STARTER_STORYBOARD(name));
  ok(`scaffolded demos/${name}/`);
  return dir;
}

/**
 * One-time bootstrap of a consumer repo: install the skill, add the update-check
 * hook, drop a pointer doc, and scaffold an example demo. Idempotent — existing
 * files are left in place unless --force.
 */
export async function repoInit(
  dir: string | undefined,
  opts: { force?: boolean } = {}
): Promise<void> {
  const target = targetOf(dir);
  step(`Bootstrapping ${basename(target)} for record-demo`);

  await installSkill(dir, { force: opts.force });

  // SessionStart update hook — never clobber an existing settings.json.
  const settingsPath = resolve(target, SETTINGS_REL);
  if ((await exists(settingsPath)) && !opts.force) {
    log(`.claude/settings.json exists — leaving it. Merge this hook in manually:`);
    log(SETTINGS_TEMPLATE().trim());
  } else {
    await ensureDir(dirname(settingsPath));
    await fs.writeFile(settingsPath, SETTINGS_TEMPLATE());
    ok(`wrote ${SETTINGS_REL} (SessionStart update-check hook)`);
  }

  // Pointer doc so a human (or Claude) in this repo knows how to invoke/update.
  const pointerPath = resolve(target, ".claude/skills/record-demo/README.md");
  if (!(await exists(pointerPath)) || opts.force) {
    await fs.writeFile(pointerPath, POINTER_DOC());
    ok(`wrote .claude/skills/record-demo/README.md`);
  }

  await scaffoldDemo(target, "example", { force: false });

  step(`Done — commit .claude/ and demos/example/`);
  ok(`next: npx -y ${UPSTREAM_SPEC} render demos/example  (needs Chrome + ffmpeg + OPENAI_API_KEY)`);
  ok(`feedback anytime: npx -y ${UPSTREAM_SPEC} feedback demos/example`);
}

/** Best-effort `cmd --version`-style probe; returns first output line or null. */
async function probeCmd(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 5000 });
    return (stdout || stderr).split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** Locate Chrome across platforms; returns a version string or install path. */
async function probeChrome(): Promise<string | null> {
  const version =
    (await probeCmd("google-chrome", ["--version"])) ??
    (await probeCmd("google-chrome-stable", ["--version"])) ??
    (await probeCmd(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ["--version"]
    ));
  if (version) return version;
  if (process.platform !== "win32") return null;
  // chrome.exe --version prints nothing on Windows; check the usual install paths.
  const winPaths = [
    `${process.env["ProgramFiles"] ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
      : "",
  ];
  for (const p of winPaths) if (p && (await exists(p))) return p;
  return null;
}

/** Tail the most recent logs/*.log under a demo dir (best-effort). */
async function recentLogTail(demoDir: string, lines = 40): Promise<string | null> {
  const logsDir = resolve(demoDir, "logs");
  let entries: string[];
  try {
    entries = (await fs.readdir(logsDir)).filter((f) => f.endsWith(".log"));
  } catch {
    return null;
  }
  if (!entries.length) return null;
  let newest: { path: string; mtime: number } | null = null;
  for (const f of entries) {
    const p = resolve(logsDir, f);
    const st = await fs.stat(p);
    if (!newest || st.mtimeMs > newest.mtime) newest = { path: p, mtime: st.mtimeMs };
  }
  if (!newest) return null;
  const raw = await fs.readFile(newest.path, "utf8");
  const tail = raw.split("\n").slice(-lines).join("\n").trim();
  return `${basename(newest.path)} (last ${lines} lines):\n${tail}`;
}

async function assembleFeedbackBody(demoDir: string | null): Promise<string> {
  const ffmpeg = (await probeCmd("ffmpeg", ["-version"])) ?? "not found";
  let originUrl: string | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], {
      cwd: process.cwd(),
      timeout: 5000,
    });
    originUrl = stdout.trim() || null;
  } catch {
    /* not a git repo */
  }
  const storyboard = demoDir ? resolve(demoDir, "generated", "storyboard.json") : null;
  const logTail = demoDir ? await recentLogTail(demoDir) : null;

  return [
    `**What happened / suggestion**`,
    ``,
    `<!-- describe the broken selector / bad timing / idea here -->`,
    ``,
    `---`,
    `**Environment**`,
    `- aidemo engine: v${engineVersion()} (${UPSTREAM_SPEC})`,
    `- consuming repo: ${originUrl ?? basename(process.cwd())}`,
    `- demo dir: ${demoDir ?? "(none given)"}`,
    `- storyboard: ${storyboard && (await exists(storyboard)) ? storyboard : "n/a"}`,
    `- OS: ${platform()} ${release()}`,
    `- node: ${process.version}`,
    `- ffmpeg: ${ffmpeg}`,
    ``,
    logTail ? `**Recent log**\n\n\`\`\`\n${logTail}\n\`\`\`` : `**Recent log:** none found`,
  ].join("\n");
}

/**
 * File demo-recording feedback as a GitHub issue on the engine repo. Uses `gh`
 * when available; `--web` opens a prefilled New Issue page; `--dry-run` prints
 * what would be sent. Falls back to a local docs/feedback-*.md when gh is
 * missing or offline.
 */
export async function feedback(
  dir: string | undefined,
  opts: { web?: boolean; dryRun?: boolean } = {}
): Promise<void> {
  const demoDir = dir ? targetOf(dir) : null;
  const body = await assembleFeedbackBody(demoDir);
  const title = `Demo feedback: ${demoDir ? basename(demoDir) : basename(process.cwd())}`;

  if (opts.dryRun) {
    step(`feedback (dry run) → ${UPSTREAM_REPO}`);
    log(`title: ${title}`);
    log(`body:\n${body}`);
    return;
  }

  const ghPath = await probeCmd("gh", ["--version"]);
  if (ghPath) {
    const args = ["issue", "create", "--repo", UPSTREAM_REPO, "--title", title, "--body", body];
    if (opts.web) args.push("--web");
    try {
      const { stdout } = await execFileAsync("gh", args, { timeout: 30000 });
      step(`filed feedback on ${UPSTREAM_REPO}`);
      if (stdout.trim()) ok(stdout.trim());
      return;
    } catch (err) {
      fail(`gh issue create failed: ${(err as Error).message}`);
      // fall through to local fallback
    }
  } else {
    log(`gh CLI not found — saving feedback locally instead`);
  }

  // Local fallback: write docs/feedback-<date>.md and print the prefilled URL.
  const base = demoDir ?? process.cwd();
  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = resolve(base, "docs");
  await ensureDir(outDir);
  const outPath = resolve(outDir, `feedback-${stamp}.md`);
  await fs.writeFile(outPath, `# ${title}\n\n${body}\n`);
  const url = `https://github.com/${UPSTREAM_REPO}/issues/new?title=${encodeURIComponent(
    title
  )}&body=${encodeURIComponent(body)}`;
  step(`saved feedback → ${outPath}`);
  ok(`file it upstream: ${url}`);
}

/** Preflight: check prereqs + report installed-vs-stable skill version. */
export async function doctor(dir: string | undefined): Promise<void> {
  step(`aidemo doctor — engine v${engineVersion()}`);
  const line = (label: string, val: string | null) =>
    val ? ok(`${label}: ${val}`) : fail(`${label}: NOT FOUND`);

  line("node", process.version);
  line("ffmpeg", await probeCmd("ffmpeg", ["-version"]));
  line("chrome", await probeChrome());
  line("gh (feedback)", await probeCmd("gh", ["--version"]));
  ok(`OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "set" : "MISSING (needed for voice/captions)"}`);
  // Ensure playwright's chromium/driver resolves (best-effort require probe).
  try {
    await import("playwright");
    ok(`playwright: resolvable`);
  } catch {
    fail(`playwright: not installed`);
  }

  const target = targetOf(dir);
  const manifest = await readManifest(target);
  if (manifest) {
    const latest = engineVersion();
    const behind = cmpVersion(latest, manifest.version) > 0;
    ok(
      `installed skill: v${manifest.version}${behind ? ` (stable v${latest} available — aidemo skill update)` : " (up to date)"}`
    );
  } else {
    log(`no record-demo skill installed in ${target} (run: aidemo repo-init)`);
  }
}
