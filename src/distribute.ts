/** Distribution kit: install / update / check the record-demo skill in a
 * consumer repo, bootstrap a repo (`repo-init`), file feedback upstream, and a
 * `doctor` preflight. The engine itself stays centralized — a consumer repo
 * only ever holds a version-stamped COPY of the skill plus a SessionStart hook
 * that runs `aidemo skill check`.
 *
 * Design notes:
 * - The engine is meant to be invoked as `npx -y github:tandryukha/aidemo#stable`.
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
import { ENGINE_ROOT, engineVersion, openAiBaseUrl } from "./config.js";
import { Project } from "./project.js";
import { STARTER_BRIEF, STARTER_STORYBOARD } from "./starter.js";
import { ensureDir, exists, ok, step, fail, log } from "./util.js";

const execFileAsync = promisify(execFile);

export const UPSTREAM_REPO = "tandryukha/aidemo";
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

This repo carries a **copy** of the \`record-demo\` skill (a thin adapter) from
[aidemo](https://github.com/${UPSTREAM_REPO}). The engine itself is
**not** vendored — it runs on demand via npx from a pinned \`stable\` tag, and
agents drive it through the **aidemo MCP server**, registered by \`repo-init\`
in \`.mcp.json\` (Claude Code) and \`.gemini/settings.json\` (Gemini CLI).
Codex CLI keeps MCP config globally — register once with:

    codex mcp add aidemo -- npx -y ${UPSTREAM_SPEC} mcp

Everywhere below, \`aidemo\` means:

    npx -y ${UPSTREAM_SPEC}

## The authoring guide (never goes stale)
The canonical guide is served by the engine itself, always version-matched:
the MCP \`get_authoring_guide\` tool, or \`aidemo guide\` on the CLI.

## Stay up to date
A \`SessionStart\` hook in \`.claude/settings.json\` runs \`aidemo skill check\` and
prints a notice when a newer skill is available. Nothing is overwritten silently —
apply an update when you're ready:

    npx -y ${UPSTREAM_SPEC} skill update --dir .

## Record a demo
Preferred: ask your agent — it uses the MCP tools (pipeline tools return job
ids; \`job_status\` reports progress and failures). By hand:

    npx -y ${UPSTREAM_SPEC} init <name>            # scaffold demos/<name>/
    npx -y ${UPSTREAM_SPEC} render demos/<name>    # voice → record → captions → compose

(Needs Chrome, ffmpeg and OPENAI_API_KEY — run \`aidemo doctor\` to check.)

## Send feedback upstream
Hit a broken selector, bad timing, or have an idea? File it on the engine:

    npx -y ${UPSTREAM_SPEC} feedback demos/<name>
`;

/** The one MCP server entry every client config gets. */
const MCP_SERVER_ENTRY = () => ({
  command: "npx",
  args: ["-y", UPSTREAM_SPEC, "mcp"],
});

const AGENTS_SNIPPET = (): string => `## Recording product demos (aidemo)

This repo is set up for [aidemo](https://github.com/${UPSTREAM_REPO}) — agents
record narrated, captioned product-demo videos from a storyboard.

- Preferred: the \`aidemo\` **MCP server** (registered in \`.mcp.json\` and
  \`.gemini/settings.json\`; Codex CLI:
  \`codex mcp add aidemo -- npx -y ${UPSTREAM_SPEC} mcp\`). Call the
  \`get_authoring_guide\` tool first and follow it. Pipeline tools return a
  jobId immediately — poll \`job_status\`. Pass absolute demo directories.
- CLI fallback: \`npx -y ${UPSTREAM_SPEC} guide\` prints the same guide;
  \`npx -y ${UPSTREAM_SPEC} render demos/<name>\` renders.
`;

/**
 * Merge the aidemo entry into a JSON config holding an mcpServers map
 * (.mcp.json for Claude Code, .gemini/settings.json for Gemini CLI). Never
 * clobbers: absent → created; parseable → only the aidemo key is added
 * (replaced with --force); unparseable → snippet printed for manual merge.
 */
async function registerMcpServer(
  target: string,
  rel: string,
  force: boolean
): Promise<void> {
  const path = resolve(target, rel);
  const entry = MCP_SERVER_ENTRY();
  let config: Record<string, unknown> = {};
  if (await exists(path)) {
    try {
      config = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
    } catch {
      log(`${rel} exists but isn't valid JSON — merge this in manually:`);
      log(JSON.stringify({ mcpServers: { aidemo: entry } }, null, 2));
      return;
    }
  }
  if (typeof config.mcpServers !== "object" || config.mcpServers == null) {
    config.mcpServers = {};
  }
  const servers = config.mcpServers as Record<string, unknown>;
  if (servers.aidemo && !force) {
    ok(`${rel} already registers aidemo — leaving it`);
    return;
  }
  servers.aidemo = entry;
  await ensureDir(dirname(path));
  await fs.writeFile(path, JSON.stringify(config, null, 2) + "\n");
  ok(`registered aidemo MCP server → ${rel}`);
}

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

  // MCP registration — the agent interface. Claude Code reads .mcp.json at
  // the project root; Gemini CLI reads .gemini/settings.json. Codex CLI keeps
  // MCP config globally, so that one is an instruction, not a file.
  await registerMcpServer(target, ".mcp.json", opts.force ?? false);
  await registerMcpServer(target, ".gemini/settings.json", opts.force ?? false);
  log(`Codex CLI (global config): codex mcp add aidemo -- npx -y ${UPSTREAM_SPEC} mcp`);

  // AGENTS.md so Codex/other AGENTS.md-reading agents discover the setup.
  const agentsPath = resolve(target, "AGENTS.md");
  if (!(await exists(agentsPath))) {
    await fs.writeFile(agentsPath, `# Agent guide\n\n${AGENTS_SNIPPET()}`);
    ok(`wrote AGENTS.md (demo-recording section)`);
  } else if (!(await fs.readFile(agentsPath, "utf8")).includes("aidemo")) {
    log(`AGENTS.md exists — add this section so agents discover aidemo:`);
    log(AGENTS_SNIPPET().trim());
  }

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

  step(`Done — commit .claude/, .mcp.json, .gemini/, AGENTS.md and demos/example/`);
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

/**
 * Ollama answers GET /api/version on its origin — nothing else in this niche
 * does. Catching it at doctor time turns a cryptic voice-time 404 into an
 * upfront hint. Only ever contacts the user-configured endpoint's origin.
 */
async function detectOllama(base: string): Promise<string | null> {
  try {
    const origin = new URL(base).origin;
    const res = await fetch(`${origin}/api/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string } | null;
    return body?.version ? `Ollama v${body.version}` : null;
  } catch {
    return null; // unreachable or not Ollama — no verdict either way
  }
}

export interface DoctorReport {
  engineVersion: string;
  node: string;
  ffmpeg: string | null;
  chrome: string | null;
  gh: string | null;
  endpoint: { url: string; custom: boolean; warning?: string };
  apiKey: "set" | "not-required" | "missing";
  /** TTS backend (AIDEMO_TTS_PROVIDER); key status only reported when non-default. */
  tts: { provider: string; elevenLabsKey?: "set" | "missing" };
  playwright: boolean;
  skill: {
    target: string;
    installed: { version: string; stableAvailable: string | null } | null;
  };
  /** Everything the pipeline needs (gh is feedback-only, doesn't gate). */
  ok: boolean;
}

/** Build the structured preflight report (used by CLI doctor + MCP doctor). */
export async function doctorReport(dir: string | undefined): Promise<DoctorReport> {
  const base = openAiBaseUrl();
  let endpointWarning: string | undefined;
  if (base) {
    const ollama = await detectOllama(base);
    if (ollama) {
      endpointWarning =
        `endpoint is ${ollama} — Ollama serves chat/embeddings only, no /v1/audio ` +
        `(TTS/STT), so voice and captions will fail. Pair it with a speech server ` +
        `such as speaches — see README "Local models & offline".`;
    }
  }
  let playwrightOk = false;
  // Ensure playwright's chromium/driver resolves (best-effort require probe).
  try {
    await import("playwright");
    playwrightOk = true;
  } catch {
    playwrightOk = false;
  }
  const target = targetOf(dir);
  const manifest = await readManifest(target);
  const latest = engineVersion();
  const report: DoctorReport = {
    engineVersion: latest,
    node: process.version,
    ffmpeg: await probeCmd("ffmpeg", ["-version"]),
    chrome: await probeChrome(),
    gh: await probeCmd("gh", ["--version"]),
    endpoint: {
      url: base ?? "https://api.openai.com/v1",
      custom: Boolean(base),
      ...(endpointWarning ? { warning: endpointWarning } : {}),
    },
    apiKey: process.env.OPENAI_API_KEY ? "set" : base ? "not-required" : "missing",
    tts: {
      provider: process.env.AIDEMO_TTS_PROVIDER || "openai",
      ...(process.env.AIDEMO_TTS_PROVIDER === "elevenlabs"
        ? { elevenLabsKey: process.env.ELEVENLABS_API_KEY ? "set" : "missing" }
        : {}),
    },
    playwright: playwrightOk,
    skill: {
      target,
      installed: manifest
        ? {
            version: manifest.version,
            stableAvailable:
              cmpVersion(latest, manifest.version) > 0 ? latest : null,
          }
        : null,
    },
    ok: false,
  };
  report.ok = Boolean(
    report.ffmpeg &&
      report.chrome &&
      report.playwright &&
      report.apiKey !== "missing" &&
      report.tts.elevenLabsKey !== "missing" &&
      !endpointWarning
  );
  return report;
}

/** Preflight: check prereqs + report installed-vs-stable skill version. */
export async function doctor(dir: string | undefined): Promise<void> {
  const r = await doctorReport(dir);
  step(`aidemo doctor — engine v${r.engineVersion}`);
  const line = (label: string, val: string | null) =>
    val ? ok(`${label}: ${val}`) : fail(`${label}: NOT FOUND`);

  line("node", r.node);
  line("ffmpeg", r.ffmpeg);
  line("chrome", r.chrome);
  line("gh (feedback)", r.gh);
  ok(
    `voice/captions endpoint: ${r.endpoint.custom ? `${r.endpoint.url} (custom)` : "api.openai.com (default)"}`
  );
  if (r.endpoint.warning) fail(r.endpoint.warning);
  if (r.tts.provider !== "openai") {
    const line =
      `TTS provider: ${r.tts.provider} (captions still use the endpoint above)` +
      (r.tts.elevenLabsKey ? ` — ELEVENLABS_API_KEY ${r.tts.elevenLabsKey}` : "");
    if (r.tts.elevenLabsKey === "missing") fail(line);
    else ok(line);
  }
  ok(
    `OPENAI_API_KEY: ${
      r.apiKey === "set"
        ? "set"
        : r.apiKey === "not-required"
          ? "not required (custom endpoint set)"
          : "MISSING (needed for voice/captions)"
    }`
  );
  if (r.playwright) ok(`playwright: resolvable`);
  else fail(`playwright: not installed`);

  if (r.skill.installed) {
    ok(
      `installed skill: v${r.skill.installed.version}${
        r.skill.installed.stableAvailable
          ? ` (stable v${r.skill.installed.stableAvailable} available — aidemo skill update)`
          : " (up to date)"
      }`
    );
  } else {
    log(`no record-demo skill installed in ${r.skill.target} (run: aidemo repo-init)`);
  }
}
