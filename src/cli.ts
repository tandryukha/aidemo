import { Command } from "commander";
import { resolve, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import {
  loadEnv,
  engineVersion,
  ENGINE_ROOT,
  captionsAutoOffline,
  chromeProfileDir,
} from "./config.js";
import { resetProfile } from "./profile.js";
import { Project, parseStoryboard } from "./project.js";
import { record } from "./recorder.js";
import { parseCookieFlag } from "./setup.js";
import { extractFrames } from "./frames.js";
import { inspectPage } from "./inspect.js";
import { GUIDE_TOPIC_NAMES, guideHeadings, readGuide, sliceGuide } from "./guide.js";
import { lintStoryboard, logLint } from "./lint.js";
import { readJson, writeJson } from "./util.js";
import {
  buildProbeGolden,
  diffGolden,
  driftFilesForDiff,
  readProbeGolden,
  writeProbeGolden,
} from "./golden.js";
import type { ProbeGoldenScene } from "./types.js";
import { generateVoice } from "./voice.js";
import { generateCaptions, generateCaptionsOffline } from "./captions.js";
import { compose } from "./compose.js";
import { exportGif } from "./gif.js";
import { buildEmbed, formatEmbed } from "./embed.js";
import { extractStills, storyboardHasStills } from "./stills.js";
import { exportWalkthrough } from "./walkthrough.js";
import { localizeStoryboard, missingNarrations } from "./i18n.js";
import { synthesizeMusicBed } from "./music.js";
import { loadVariants, renderVariants } from "./variants.js";
import {
  ensureDir,
  ok,
  step,
  fail,
  log,
  setLogFile,
  closeLogFile,
  teeStageLog,
  exists,
} from "./util.js";
import {
  scaffoldDemo,
  repoInit,
  installSkill,
  checkSkill,
  feedback,
  doctor,
} from "./distribute.js";

/** Ensure the project dirs exist and tee this command's output into logs/. */
async function beginCommand(project: Project, name: string): Promise<void> {
  await project.ensureDirs();
  setLogFile(project.p("logs", `${name}.log`));
}

/**
 * Tee one composite-pipeline stage's output into its OWN stable
 * logs/<stage>.log (freshly truncated), in addition to the composite
 * command's own log (`render` → logs/render.log via beginCommand/
 * setLogFile). Without this, `aidemo render` never touches logs/voice.log,
 * logs/record.log, logs/captions.log or logs/compose.log — a log-watcher
 * polling one of those between renders sees a stale line (e.g. an old
 * `✓ final video → …`) from whatever standalone command last ran that stage.
 */
function stageLog<T>(project: Project, stage: string, fn: () => Promise<T>): Promise<T> {
  return teeStageLog(project.p("logs", `${stage}.log`), fn);
}

await loadEnv();

const program = new Command();
program
  .name("aidemo")
  .description("AI Demo Engine — storyboard → narrated, captioned demo video")
  .version(engineVersion());

program
  .command("init")
  .argument("<name>", "demo name (creates ./demos/<name>/)")
  .option("--force", "overwrite an existing demos/<name>/", false)
  .option(
    "--from-url <url>",
    "draft from a live page: inspect it, headings → scenes, unique selectors → beats (no LLM)"
  )
  .option("--headed", "show the browser while inspecting (--from-url)", false)
  .option("--profile <dir>", "Chrome user-data dir for --from-url (logged-in pages)")
  .option("--viewport <WxH>", "viewport for --from-url (default 1280x720)")
  .description("scaffold a new demo project (in the current repo) with a starter storyboard")
  .action(
    async (
      name: string,
      opts: { force?: boolean; fromUrl?: string; headed?: boolean; profile?: string; viewport?: string }
    ) => {
      // Scaffold into the *current* working directory, so `init` works both in the
      // engine's own repo and in a consumer repo that invoked it via npx.
      const vp = opts.viewport ? /^(\d+)x(\d+)$/.exec(opts.viewport) : null;
      if (opts.viewport && !vp) throw new Error(`--viewport expects WxH, got ${opts.viewport}`);
      const dir = await scaffoldDemo(process.cwd(), name, {
        force: opts.force,
        fromUrl: opts.fromUrl,
        headed: opts.headed,
        profileDir: opts.profile,
        ...(vp ? { viewport: { width: Number(vp[1]), height: Number(vp[2]) } } : {}),
      });
      ok(
        opts.fromUrl
          ? `write the narration in generated/storyboard.json (input/brief.md lists what inspect saw), then: aidemo probe ${dir}`
          : `edit generated/storyboard.json, then: aidemo render ${dir}`
      );
    }
  );

program
  .command("repo-init")
  .option("--dir <dir>", "target repo (default: current directory)")
  .option("--force", "overwrite existing skill/settings/example", false)
  .description("bootstrap a repo to use record-demo (skill + update hook + example)")
  .action(async (opts: { dir?: string; force?: boolean }) => {
    await repoInit(opts.dir, { force: opts.force });
  });

const skill = program
  .command("skill")
  .description("manage the installed record-demo skill copy");
skill
  .command("install")
  .option("--dir <dir>", "target repo (default: current directory)")
  .option("--force", "overwrite an existing skill copy", false)
  .description("copy the current record-demo skill into this repo + stamp installed.json")
  .action(async (opts: { dir?: string; force?: boolean }) => {
    await installSkill(opts.dir, { force: opts.force });
  });
skill
  .command("update")
  .option("--dir <dir>", "target repo (default: current directory)")
  .description("update the installed skill copy to this engine's version")
  .action(async (opts: { dir?: string }) => {
    await installSkill(opts.dir, { force: true });
  });
skill
  .command("check")
  .option("--dir <dir>", "target repo (default: current directory)")
  .option("--verbose", "also print when up to date / not installed", false)
  .description("notify if a newer skill is available (used by the SessionStart hook)")
  .action(async (opts: { dir?: string; verbose?: boolean }) => {
    await checkSkill(opts.dir, { verbose: opts.verbose });
  });

program
  .command("mcp")
  .description("run the stdio MCP server — the agent interface (stdout = JSON-RPC)")
  .action(async () => {
    const { runMcpServer } = await import("./mcp/server.js");
    await runMcpServer();
  });

program
  .command("guide")
  .description("print the agent-neutral authoring guide (docs/AUTHORING.md)")
  .option(
    "--topic <name>",
    `print one slice: ${GUIDE_TOPIC_NAMES.join(", ")} — or an H2 heading prefix`
  )
  .option("--list", "list topics and section headings")
  .action(async (opts: { topic?: string; list?: boolean }) => {
    // Deliberate stdout (not the stderr logger): the guide is the output.
    const md = await readGuide();
    if (opts.list) {
      process.stdout.write(
        `topics: ${GUIDE_TOPIC_NAMES.join(", ")}\n\nsections:\n` +
          guideHeadings(md)
            .map((h) => `  ${h}`)
            .join("\n") +
          "\n"
      );
      return;
    }
    if (!opts.topic) {
      process.stdout.write(md);
      return;
    }
    const slice = sliceGuide(md, opts.topic);
    if (slice == null) {
      fail(
        `unknown guide topic "${opts.topic}" — topics: ${GUIDE_TOPIC_NAMES.join(", ")}; ` +
          `sections: ${guideHeadings(md).join(" · ")}`
      );
      process.exit(1);
    }
    process.stdout.write(slice);
  });

/** Read all of stdin as UTF-8 (for `--body-file -`). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

program
  .command("feedback")
  .argument("[dir]", "demo project directory (adds storyboard + log context)")
  .option("--title <text>", "issue title (default: \"Demo feedback: <dir>\")")
  .option("--body <text>", "issue body; environment + log context is appended")
  .option("--body-file <file>", "read the body from a file, or \"-\" for stdin")
  .option("--web", "open a prefilled New Issue page instead of filing directly", false)
  .option("--dry-run", "print the issue title/body without filing", false)
  .description("file demo-recording feedback as a GitHub issue on the engine repo")
  .action(
    async (
      dir: string | undefined,
      opts: {
        title?: string;
        body?: string;
        bodyFile?: string;
        web?: boolean;
        dryRun?: boolean;
      }
    ) => {
      // Non-interactive body so an agent (or a script) can file without the
      // placeholder template — the reason issue #38 was filed with `gh` by hand.
      let body = opts.body;
      if (opts.bodyFile) {
        body = await (opts.bodyFile === "-"
          ? readStdin()
          : readFile(opts.bodyFile, "utf8"));
      }
      await feedback(dir, {
        web: opts.web,
        dryRun: opts.dryRun,
        title: opts.title,
        description: body,
      });
    }
  );

program
  .command("doctor")
  .option("--dir <dir>", "repo to check for an installed skill (default: current directory)")
  .description("check prereqs (ffmpeg/chrome/openai key) + installed-vs-stable skill version")
  .action(async (opts: { dir?: string }) => {
    await doctor(opts.dir);
  });

/**
 * `--tts <provider>` — a discoverable spelling of AIDEMO_TTS_PROVIDER (the env
 * var is canonical; the flag just sets it before the pipeline reads it).
 */
function applyTtsFlag(value?: string): void {
  if (value == null) return;
  if (value !== "openai" && value !== "elevenlabs" && value !== "local") {
    throw new Error(`--tts must be openai, elevenlabs or local (got "${value}")`);
  }
  process.env.AIDEMO_TTS_PROVIDER = value;
}

const TTS_OPT_DESC =
  "TTS provider: openai (default) | elevenlabs | local (in-process Kokoro; needs `npm install kokoro-js`) — same as AIDEMO_TTS_PROVIDER";

function parsePositiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive integer (got "${value}")`);
  return n;
}

function parseCapture(value?: string): "playwright" | "native" | "obs" | undefined {
  if (value == null) return undefined;
  if (value === "playwright" || value === "native" || value === "obs") return value;
  throw new Error(`--capture must be playwright, native or obs (got "${value}")`);
}

/** Commander collector for a repeatable option, accumulating into an array. */
function collectKv(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** Parse repeated `--param key=value` pairs into a params record (or undefined). */
function parseParams(pairs?: string[]): Record<string, string> | undefined {
  if (!pairs || !pairs.length) return undefined;
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq <= 0) throw new Error(`--param must be key=value (got "${p}")`);
    out[p.slice(0, eq).trim()] = p.slice(eq + 1);
  }
  return out;
}

const FROM_SCENE_OPT_DESC =
  "resume: keep the previous take's scenes before this id (verified unchanged) and record from it";
const PARAM_OPT_DESC =
  "set a storyboard template param (key=value; repeatable; must be declared in the storyboard's params block)";

const LANG_OPT_DESC =
  "render a language variant from scene.narrations[<code>] over the shared take " +
  "(artifacts namespaced: audio/<code>/, captions.<code>.*, output/final-demo.<code>.mp4)";
const LANGS_OPT_DESC =
  "comma-separated language matrix (e.g. de,fr) — each rendered like --lang";

/**
 * Languages to run this invocation, resolved from --lang / --langs. Returns
 * `[undefined]` when neither is given — the default single-language render,
 * byte-for-byte unchanged (undefined = the base storyboard, unsuffixed paths).
 */
const STORAGE_STATE_OPT_DESC =
  "seed a Playwright storageState JSON (cookies + localStorage) into the profile before the take";
const COOKIE_OPT_DESC =
  'seed a cookie before the take: "name=value;domain=host[;path=/;secure;httpOnly;sameSite=Lax]" (repeatable)';
const PROFILE_SEEDED_OPT_DESC =
  "the profile is seeded on purpose (login / cookie gate): silence the carried-over-state warning";

/** Profile-seeding flags shared by record/probe/render → RecordOptions fields. */
function seedOpts(opts: {
  storageState?: string;
  cookie?: string[];
  profileSeeded?: boolean;
}): {
  storageState?: string;
  cookies?: ReturnType<typeof parseCookieFlag>[];
  profileSeeded?: boolean;
} {
  return {
    storageState: opts.storageState,
    cookies: opts.cookie?.length ? opts.cookie.map(parseCookieFlag) : undefined,
    profileSeeded: opts.profileSeeded,
  };
}

function langsFrom(opts: { lang?: string; langs?: string }): Array<string | undefined> {
  const list = [
    ...(opts.langs ? opts.langs.split(",") : []),
    ...(opts.lang ? [opts.lang] : []),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : [undefined];
}

/** Warn (don't fail) when a language variant is only partially translated. */
function warnPartialCoverage(storyboard: Parameters<typeof missingNarrations>[0], lang: string): void {
  const missing = missingNarrations(storyboard, lang);
  if (missing.length)
    log(
      `⚠ lang "${lang}": scene(s) ${missing.join(", ")} have no narrations[${lang}] — ` +
        `using the base narration`
    );
}

program
  .command("login")
  .argument("[profile]", "Chrome user-data dir (default: the engine's recording profile)")
  .option("--url <url>", "page to open for the login", "https://chatgpt.com/")
  .option("--no-wait", "launch Chrome and return without waiting for it to quit")
  .description(
    "open a manual-login Chrome on the recording profile (mock-keychain cookie " +
      "store, same as record) and wait until you quit it"
  )
  .action(async (profile: string | undefined, opts: { url: string; wait: boolean }) => {
    const { login } = await import("./login.js");
    await login(profile, { url: opts.url, noWait: !opts.wait });
  });

program
  .command("profile")
  .argument("[action]", "path (default) | reset", "path")
  .option("--profile <dir>", "operate on this Chrome user-data dir instead of the default")
  .description(
    "show or wipe the recording Chrome profile (a profile carrying state for " +
      "the app can silently record the wrong story)"
  )
  .action(async (action: string, opts: { profile?: string }) => {
    const dir = opts.profile ?? chromeProfileDir();
    if (action === "reset") {
      await resetProfile(dir);
      step("Profile reset");
      ok(`wiped → ${dir}`);
      ok("the next take starts from a clean browser identity (you'll need to log in again)");
      return;
    }
    if (action !== "path") {
      throw new Error(`unknown profile action "${action}" — use: path | reset`);
    }
    step("Recording profile");
    ok(dir);
    ok(`exists: ${(await exists(dir)) ? "yes" : "no"}`);
    ok("wipe it with: aidemo profile reset  (or record/probe with --fresh)");
  });

program
  .command("validate")
  .argument("[dir]", "demo project directory (validates generated/storyboard.json)")
  .option("--file <path>", "validate this storyboard file instead of <dir>/generated/storyboard.json")
  .option("--relaxed", "narration optional (probe semantics)", false)
  .option("--param <kv>", PARAM_OPT_DESC, collectKv, [])
  .option("--json", "print the structured result as JSON", false)
  .description(
    "validate a storyboard against the engine schema without running anything " +
      "(the CLI twin of the MCP validate_storyboard tool; non-zero exit on issues)"
  )
  .action(
    async (
      dir: string | undefined,
      opts: { file?: string; relaxed?: boolean; param?: string[]; json?: boolean }
    ) => {
      if (!dir && !opts.file) {
        throw new Error("pass a demo dir or --file <storyboard.json>");
      }
      const path = opts.file ? resolve(opts.file) : new Project(dir!).storyboardPath;
      let raw: unknown;
      try {
        raw = await readJson<unknown>(path);
      } catch (err) {
        const result = {
          valid: false,
          storyboardPath: path,
          issues: [{ path: "", message: (err as Error).message, code: "unreadable" }],
          warnings: [] as string[],
        };
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else fail(`${path}: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      const params = parseParams(opts.param);
      const parsed = parseStoryboard(raw, {
        relaxed: opts.relaxed,
        params,
        strict: params != null,
      });
      const result = parsed.ok
        ? {
            valid: true,
            storyboardPath: path,
            title: parsed.storyboard.title,
            sceneCount: parsed.storyboard.scenes.length,
            issues: [] as Array<{ path: string; message: string; code: string }>,
            warnings: parsed.warnings,
          }
        : { valid: false, storyboardPath: path, issues: parsed.issues, warnings: [] as string[] };
      const lint = parsed.ok ? lintStoryboard(parsed.storyboard) : null;
      if (opts.json) {
        console.log(JSON.stringify({ ...result, lint: lint?.issues ?? [] }, null, 2));
      } else if (result.valid) {
        step("Storyboard valid");
        ok(`${path} — "${result.title}", ${result.sceneCount} scene(s)`);
        for (const w of result.warnings) log(w);
        if (lint) logLint(lint, log);
      } else {
        fail(`${path}: ${result.issues.length} issue(s)`);
        for (const i of result.issues) log(`  - ${i.path || "<root>"}: ${i.message}`);
      }
      if (!result.valid) process.exitCode = 1;
    }
  );

program
  .command("lint")
  .argument("[dir]", "demo project directory (lints generated/storyboard.json)")
  .option("--file <path>", "lint this storyboard file instead of <dir>/generated/storyboard.json")
  .option("--param <kv>", PARAM_OPT_DESC, collectKv, [])
  .option("--lang <code>", "lint the narrations[code] translation + that language's pace")
  .option("--json", "print the structured result as JSON", false)
  .option("--strict", "non-zero exit on warnings too (default: errors only)", false)
  .description(
    "preflight a storyboard without a browser: pacing forecast (which scenes " +
      "compose will freeze or cut), selector/wait pitfalls, no-op keys"
  )
  .action(
    async (
      dir: string | undefined,
      opts: { file?: string; param?: string[]; lang?: string; json?: boolean; strict?: boolean }
    ) => {
      if (!dir && !opts.file) {
        throw new Error("pass a demo dir or --file <storyboard.json>");
      }
      const path = opts.file ? resolve(opts.file) : new Project(dir!).storyboardPath;
      const params = parseParams(opts.param);
      const parsed = parseStoryboard(await readJson<unknown>(path), {
        relaxed: true,
        params,
        strict: params != null,
      });
      if (!parsed.ok) {
        fail(`${path}: ${parsed.issues.length} schema issue(s) — run validate first`);
        for (const i of parsed.issues) log(`  - ${i.path || "<root>"}: ${i.message}`);
        process.exitCode = 1;
        return;
      }
      const result = lintStoryboard(parsed.storyboard, { lang: opts.lang });
      if (opts.json) {
        console.log(JSON.stringify({ storyboardPath: path, ...result }, null, 2));
      } else {
        step(`Lint "${parsed.storyboard.title}"`);
        log(
          `  ${"scene".padEnd(12)}${"words".padStart(6)}${"narr".padStart(7)}${"action".padStart(8)}${"hold%".padStart(7)}`
        );
        for (const e of result.estimate) {
          log(
            `  ${e.id.padEnd(12)}${String(e.words).padStart(6)}` +
              `${(e.narrationMs / 1000).toFixed(1).padStart(6)}s` +
              `${(e.actionMs / 1000).toFixed(1).padStart(7)}s` +
              `${e.holdPct > 0 ? `${Math.round(e.holdPct * 100)}%`.padStart(7) : "".padStart(7)}` +
              (e.overrunMs > 0 ? `  cut ≈${(e.overrunMs / 1000).toFixed(1)}s` : "")
          );
        }
        if (result.issues.length === 0) {
          ok(`no issues — predicted narration ≈${(result.narrationTotalMs / 1000).toFixed(0)}s`);
        } else {
          logLint(result, log);
        }
      }
      const errors = result.issues.filter((i) => i.severity === "error").length;
      const warns = result.issues.filter((i) => i.severity === "warn").length;
      if (errors > 0 || (opts.strict && warns > 0)) process.exitCode = 1;
    }
  );

program
  .command("walkthrough")
  .argument("<dir>", "demo project directory")
  .option("--lang <code>", "language variant (final-demo.<lang>.mp4)")
  .option("--width <px>", "frame width in px (default 960)", "960")
  .option("--out <dir>", "output directory (default <dir>/output/walkthrough)")
  .description(
    "export output/walkthrough/: index.html + guide.md + per-scene frames + captions from the final video"
  )
  .action(async (dir: string, opts: { lang?: string; width: string; out?: string }) => {
    const base = new Project(dir);
    const project = opts.lang ? new Project(dir, opts.lang) : base;
    await beginCommand(project, "walkthrough");
    const storyboard = await base.loadStoryboard({ relaxed: true });
    const sb = opts.lang ? localizeStoryboard(storyboard, opts.lang) : storyboard;
    const res = await exportWalkthrough(project, sb, {
      width: Number(opts.width) || 960,
      outDir: opts.out,
    });
    ok(`walkthrough → ${res.index} (${res.scenes.length} scene(s); guide.md alongside)`);
  });

program
  .command("inspect")
  .argument("<url>", "page to inspect (absolute URL)")
  .option("--dir <dir>", "demo directory to write logs/inspect-*.json + screenshot into")
  .option("--profile <dir>", "Chrome user-data dir (default: the recording profile)")
  .option("--headed", "show the browser (default headless)", false)
  .option("--limit <n>", "max elements (default 80)", "80")
  .option("--viewport <WxH>", "viewport (default 1280x720)")
  .option("--frame <name=selector>", "also scan this iframe (repeatable)", collectKv, [])
  .option("--json", "print the full JSON result", false)
  .description(
    "list the page's visible interactive elements with unique selectors (no selector guessing)"
  )
  .action(
    async (
      url: string,
      opts: {
        dir?: string;
        profile?: string;
        headed?: boolean;
        limit: string;
        viewport?: string;
        frame: string[];
        json?: boolean;
      }
    ) => {
      const vp = opts.viewport?.match(/^(\d+)x(\d+)$/);
      const frames: Record<string, string> = {};
      for (const kv of opts.frame) {
        const i = kv.indexOf("=");
        if (i > 0) frames[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const project = opts.dir ? new Project(opts.dir) : null;
      if (project) await ensureDir(project.p("logs"));
      const res = await inspectPage({
        url,
        headless: !opts.headed,
        profileDir: opts.profile,
        limit: Number(opts.limit) || 80,
        ...(vp ? { viewport: { width: Number(vp[1]), height: Number(vp[2]) } } : {}),
        frames,
        ...(project ? { screenshotPath: project.p("logs", `inspect-${stamp}.png`) } : {}),
      });
      if (project) {
        const file = project.p("logs", `inspect-${stamp}.json`);
        await writeJson(file, res);
        log(`inspect → ${file}`);
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        return;
      }
      process.stdout.write(`${res.title || "(untitled)"} — ${res.finalUrl}\n`);
      if (res.headings.length) {
        process.stdout.write(
          res.headings.map((h) => `  ${"#".repeat(h.level)} ${h.text}`).join("\n") + "\n"
        );
      }
      if (res.iframes.length) {
        process.stdout.write(
          `iframes: ${res.iframes.map((f) => `${f.name} (${f.selector})`).join(", ")}\n`
        );
      }
      process.stdout.write(`${res.elements.length} interactive element(s)${res.truncated ? " (truncated — raise --limit)" : ""}:\n`);
      const pad = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t.padEnd(n));
      for (const el of res.elements) {
        process.stdout.write(
          `  ${pad(el.role, 9)} ${pad(el.name || "(no name)", 34)} ${el.inViewport ? " " : "↓"} ${el.frame ? `[${el.frame}] ` : ""}${el.selector || "(no unique selector)"}\n`
        );
      }
    }
  );

program
  .command("frames")
  .argument("<dir>", "demo project directory")
  .option("--every <sec>", "seconds between frames (default 3)", "3")
  .option("--source <which>", "final (output/final-demo.mp4, default) | raw (latest take)", "final")
  .option("--width <px>", "frame width in px, aspect kept (default 640)", "640")
  .option("--out <dir>", "output directory (default <dir>/output/frames)")
  .description(
    "dump evenly spaced PNG frames from the final video (or the raw take) for review"
  )
  .action(
    async (
      dir: string,
      opts: { every: string; source: string; width: string; out?: string }
    ) => {
      const everySec = Number(opts.every);
      if (!(everySec > 0)) throw new Error(`--every must be a positive number of seconds`);
      if (opts.source !== "final" && opts.source !== "raw") {
        throw new Error(`--source must be "final" or "raw"`);
      }
      const project = new Project(dir);
      const res = await extractFrames(project, {
        everySec,
        source: opts.source,
        width: parsePositiveInt("--width", opts.width),
        outDir: opts.out ? resolve(opts.out) : undefined,
      });
      step("Frames");
      ok(
        `${res.files.length} frame(s) every ${res.everySec}s from ${res.source} ` +
          `(${(res.durationMs / 1000).toFixed(1)}s)`
      );
      for (const f of res.files) log(`  ${f}`);
    }
  );

program
  .command("record")
  .argument("<dir>", "demo project directory")
  .option("--profile <dir>", "Chrome user-data dir (logged-in profile)")
  .option(
    "--fresh",
    "wipe and use a throwaway profile for this take (no carried-over cookies/localStorage)",
    false
  )
  .option("--storage-state <file>", STORAGE_STATE_OPT_DESC)
  .option("--cookie <spec>", COOKIE_OPT_DESC, collectKv, [])
  .option("--profile-seeded", PROFILE_SEEDED_OPT_DESC, false)
  .option("--headless", "run headless (not recommended for real Chrome)", false)
  .option(
    "--capture <mode>",
    "capture path: playwright (default) | native (ffmpeg screen grab) | obs"
  )
  .option("--param <kv>", PARAM_OPT_DESC, collectKv, [])
  .option("--from-scene <id>", FROM_SCENE_OPT_DESC)
  .description("drive the storyboard in Chrome and record raw video + timeline.json")
  .action(
    async (
      dir: string,
      opts: {
        profile?: string;
        fresh?: boolean;
        storageState?: string;
        cookie?: string[];
        profileSeeded?: boolean;
        headless?: boolean;
        capture?: string;
        param?: string[];
        fromScene?: string;
      }
    ) => {
      const project = new Project(dir);
      await beginCommand(project, "record");
      const load = () => project.loadStoryboard({ params: parseParams(opts.param) });
      const storyboard = await load();
      logLint(lintStoryboard(storyboard), log);
      await record(project, storyboard, {
        profileDir: opts.profile,
        fresh: opts.fresh,
        ...seedOpts(opts),
        reloadStoryboard: load,
        headed: !opts.headless,
        capture: parseCapture(opts.capture),
        fromScene: opts.fromScene,
      });
    }
  );

program
  .command("probe")
  .argument("<dir>", "demo project directory")
  .option("--profile <dir>", "Chrome user-data dir (logged-in profile)")
  .option(
    "--fresh",
    "wipe and use a throwaway profile for this take (no carried-over cookies/localStorage)",
    false
  )
  .option("--storage-state <file>", STORAGE_STATE_OPT_DESC)
  .option("--cookie <spec>", COOKIE_OPT_DESC, collectKv, [])
  .option("--profile-seeded", PROFILE_SEEDED_OPT_DESC, false)
  .option("--headless", "run headless (not recommended for real Chrome)", false)
  .option(
    "--capture <mode>",
    "capture path: playwright (default) | native (ffmpeg screen grab) | obs"
  )
  .option("--param <kv>", PARAM_OPT_DESC, collectKv, [])
  .option(
    "--update-golden",
    "write golden/probe.json from this probe (commit it as the regression baseline)",
    false
  )
  .option(
    "--golden",
    "compare this probe against golden/probe.json; readable diff + non-zero exit on drift (CI)",
    false
  )
  .description(
    "record-only dry run to verify selectors/timing (narration optional)"
  )
  .action(
    async (
      dir: string,
      opts: {
        profile?: string;
        fresh?: boolean;
        storageState?: string;
        cookie?: string[];
        profileSeeded?: boolean;
        headless?: boolean;
        capture?: string;
        param?: string[];
        golden?: boolean;
        updateGolden?: boolean;
      }
    ) => {
      const project = new Project(dir);
      await beginCommand(project, "probe");
      // Relaxed: narration is optional — a probe just exercises the flow.
      const load = () =>
        project.loadStoryboard({
          relaxed: true,
          params: parseParams(opts.param),
        });
      const storyboard = await load();
      logLint(lintStoryboard(storyboard), log);
      const goldenMode = !!(opts.golden || opts.updateGolden);
      const probeScenes: ProbeGoldenScene[] = [];
      await record(project, storyboard, {
        profileDir: opts.profile,
        fresh: opts.fresh,
        ...seedOpts(opts),
        reloadStoryboard: load,
        headed: !opts.headless,
        capture: parseCapture(opts.capture),
        ...(goldenMode ? { probe: probeScenes } : {}),
      });

      if (opts.updateGolden) {
        const golden = buildProbeGolden(storyboard, probeScenes);
        await writeProbeGolden(project, golden);
        const actions = golden.scenes.reduce((a, s) => a + s.actions.length, 0);
        step("Probe golden updated");
        ok(
          `golden → ${project.goldenProbePath} (${golden.scenes.length} scenes, ${actions} actions)`
        );
        ok(`commit it, then 'aidemo probe ${dir} --golden' guards the flow in CI`);
        return;
      }

      if (opts.golden) {
        const expected = await readProbeGolden(project);
        if (!expected) {
          throw new Error(
            `no golden baseline at ${project.goldenProbePath} — create it first: ` +
              `aidemo probe ${dir} --update-golden`
          );
        }
        const actual = buildProbeGolden(storyboard, probeScenes);
        const diffs = diffGolden(expected, actual);
        if (diffs.length > 0) {
          fail(`golden probe mismatch — ${diffs.length} field difference(s):`);
          for (const d of diffs) log(d);
          const drift = await driftFilesForDiff(project, actual, diffs);
          for (const f of drift) {
            log(`  selector drift → ${f.file} (scene ${f.scene}, action #${f.action}: nearest candidates)`);
          }
          throw new Error(
            `probe --golden failed: the recorded flow drifted from ` +
              `${project.goldenProbePath} (${diffs.length} difference(s)). ` +
              `Re-run with --update-golden if this change is intended.`
          );
        }
        step("Probe golden matches");
        ok(`flow unchanged vs ${project.goldenProbePath}`);
        return;
      }

      step("Probe done");
      ok(`inspect ${project.rawVideoPath} + ${project.timelinePath}`);
      ok(`any failure left a screenshot + frame dump in ${project.p("logs")}`);
    }
  );

program
  .command("voice")
  .argument("<dir>", "demo project directory")
  .option("--scene <id>", "regenerate only this scene's narration")
  .option("--force", "re-synthesize every scene even if unchanged", false)
  .option("--tts <provider>", TTS_OPT_DESC)
  .option("--param <kv>", PARAM_OPT_DESC, collectKv, [])
  .option("--lang <code>", LANG_OPT_DESC)
  .option("--langs <codes>", LANGS_OPT_DESC)
  .description("generate per-scene TTS and assemble narration.mp3 + voice.json")
  .action(
    async (
      dir: string,
      opts: {
        scene?: string;
        force?: boolean;
        tts?: string;
        param?: string[];
        lang?: string;
        langs?: string;
      }
    ) => {
      applyTtsFlag(opts.tts);
      const storyboard = await new Project(dir).loadStoryboard({
        params: parseParams(opts.param),
      });
      for (const lang of langsFrom(opts)) {
        const project = new Project(dir, lang);
        await beginCommand(project, "voice");
        const sb = lang ? localizeStoryboard(storyboard, lang) : storyboard;
        if (lang) warnPartialCoverage(storyboard, lang);
        await generateVoice(project, sb, { only: opts.scene, force: opts.force });
      }
    }
  );

program
  .command("music")
  .argument("[out]", "output .wav path", "assets/music.wav")
  .description("synthesize a license-free background-music bed (no samples)")
  .action(async (out: string) => {
    const outPath = resolve(process.cwd(), out);
    await ensureDir(dirname(outPath));
    step("Synthesizing music bed");
    const { durationSec } = await synthesizeMusicBed(outPath);
    ok(`music → ${outPath} (${durationSec.toFixed(1)}s, license-free)`);
    ok(`use it via storyboard "music": { "track": "${out}" }`);
  });

program
  .command("captions")
  .argument("<dir>", "demo project directory")
  .option(
    "--offline",
    "generate approximate captions from the storyboard script + voice.json timings — no network/STT",
    false
  )
  .option("--param <kv>", PARAM_OPT_DESC, collectKv, [])
  .option("--lang <code>", LANG_OPT_DESC)
  .option("--langs <codes>", LANGS_OPT_DESC)
  .option(
    "--stt-lang <code>",
    "override the Whisper STT language hint (ISO-639-1, e.g. et) — defaults to " +
      "--lang or the storyboard's own \"language\" field; ignored with --offline"
  )
  .description("transcribe narration.mp3 to captions.srt/vtt with word timing")
  .action(
    async (
      dir: string,
      opts: {
        offline?: boolean;
        param?: string[];
        lang?: string;
        langs?: string;
        sttLang?: string;
      }
    ) => {
      const langs = langsFrom(opts);
      // The storyboard is always needed now: --offline derives cues from it,
      // and the default STT path biases the Whisper request with its
      // narration text + language (see src/captions.ts).
      const base = await new Project(dir).loadStoryboard({
        params: parseParams(opts.param),
      });
      for (const lang of langs) {
        const project = new Project(dir, lang);
        await beginCommand(project, "captions");
        const sb = lang ? localizeStoryboard(base, lang) : base;
        if (opts.offline) {
          await generateCaptionsOffline(project, sb);
        } else {
          await generateCaptions(project, sb, { language: opts.sttLang });
        }
      }
    }
  );

program
  .command("compose")
  .argument("<dir>", "demo project directory")
  .option("--gif", "also export output/final-demo.gif after the mux", false)
  .option("--param <kv>", PARAM_OPT_DESC, collectKv, [])
  .option("--lang <code>", LANG_OPT_DESC)
  .option("--langs <codes>", LANGS_OPT_DESC)
  .description("trim, sync, mux and caption into output/final-demo.mp4")
  .action(
    async (
      dir: string,
      opts: { gif?: boolean; param?: string[]; lang?: string; langs?: string }
    ) => {
      const storyboard = await new Project(dir).loadStoryboard({
        params: parseParams(opts.param),
      });
      for (const lang of langsFrom(opts)) {
        const project = new Project(dir, lang);
        await beginCommand(project, "compose");
        const sb = lang ? localizeStoryboard(storyboard, lang) : storyboard;
        await compose(project, sb);
        if (opts.gif) await exportGif(project);
      }
    }
  );

program
  .command("gif")
  .argument("<dir>", "demo project directory")
  .option("--width <px>", "output width in pixels", "960")
  .option("--fps <n>", "GIF frame rate", "12")
  .option("--out <path>", "output path (default: <dir>/output/final-demo.gif)")
  .description("convert output/final-demo.mp4 to a README-ready GIF")
  .action(
    async (dir: string, opts: { width: string; fps: string; out?: string }) => {
      const project = new Project(dir);
      await beginCommand(project, "gif");
      await exportGif(project, {
        width: parsePositiveInt("--width", opts.width),
        fps: parsePositiveInt("--fps", opts.fps),
        out: opts.out,
      });
    }
  );

program
  .command("embed")
  .argument("<dir>", "demo project directory (its basename is the demo name)")
  .option(
    "--repo <dir>",
    "consuming repo to detect owner/repo from (default: current directory)"
  )
  .option("--still <name>", "still-frame basename under stills/", "poster")
  .option("--json", "print machine-readable JSON instead of snippets", false)
  .description(
    "print ready-to-paste always-fresh embed snippets (stable raw GitHub URLs)"
  )
  .action(
    async (
      dir: string,
      opts: { repo?: string; still?: string; json?: boolean }
    ) => {
      // Pure string generation — no logs/, no storyboard load, stdout only.
      const result = await buildEmbed(dir, {
        repoDir: opts.repo,
        still: opts.still,
      });
      process.stdout.write(
        opts.json
          ? JSON.stringify(result, null, 2) + "\n"
          : formatEmbed(result)
      );
    }
  );

program
  .command("stills")
  .argument("<dir>", "demo project directory")
  .option("--out <dir>", "output directory (default: <dir>/output/stills)")
  .description("extract named stills (screenshot mode) from the recorded take")
  .action(async (dir: string, opts: { out?: string }) => {
    const project = new Project(dir);
    await beginCommand(project, "stills");
    // Stills come straight from timeline.json + the raw take — no key, no
    // storyboard reload, so this works against any existing recording.
    await extractStills(project, { outDir: opts.out });
  });

program
  .command("render")
  .argument("<dir>", "demo project directory")
  .option("--profile <dir>", "Chrome user-data dir (logged-in profile)")
  .option(
    "--fresh",
    "wipe and use a throwaway profile for this take (no carried-over cookies/localStorage)",
    false
  )
  .option("--storage-state <file>", STORAGE_STATE_OPT_DESC)
  .option("--cookie <spec>", COOKIE_OPT_DESC, collectKv, [])
  .option("--profile-seeded", PROFILE_SEEDED_OPT_DESC, false)
  .option("--headless", "run headless", false)
  .option(
    "--capture <mode>",
    "capture path: playwright (default) | native (ffmpeg screen grab) | obs"
  )
  .option("--force-voice", "re-synthesize narration even if unchanged", false)
  .option("--tts <provider>", TTS_OPT_DESC)
  .option("--gif", "also export output/final-demo.gif after the mux", false)
  .option("--param <kv>", PARAM_OPT_DESC, collectKv, [])
  .option(
    "--variants <file>",
    "render one full pipeline per entry of a variants JSON file → output/variants/<name>/"
  )
  .option("--lang <code>", LANG_OPT_DESC)
  .option("--langs <codes>", `${LANGS_OPT_DESC} — records ONCE, then renders each`)
  .option("--from-scene <id>", FROM_SCENE_OPT_DESC)
  .description("run the full pipeline: voice → record → captions → compose")
  .action(
    async (
      dir: string,
      opts: {
        profile?: string;
        fresh?: boolean;
        storageState?: string;
        cookie?: string[];
        profileSeeded?: boolean;
        headless?: boolean;
        capture?: string;
        forceVoice?: boolean;
        tts?: string;
        gif?: boolean;
        param?: string[];
        variants?: string;
        lang?: string;
        langs?: string;
        fromScene?: string;
      }
    ) => {
      applyTtsFlag(opts.tts);
      const base = new Project(dir);
      await beginCommand(base, "render");

      // Variants matrix: one isolated full render per entry (params differ).
      if (opts.variants) {
        const variants = await loadVariants(opts.variants);
        const results = await renderVariants(dir, variants, {
          record: {
            profileDir: opts.profile,
            fresh: opts.fresh,
            ...seedOpts(opts),
            headed: !opts.headless,
            capture: parseCapture(opts.capture),
          },
          forceVoice: opts.forceVoice,
        });
        step("Done");
        ok(`▶ ${results.length} variant(s) under ${base.p("output", "variants")}`);
        return;
      }

      const captionsFor = async (
        project: Project,
        sb: Awaited<ReturnType<Project["loadStoryboard"]>>
      ) => {
        if (captionsAutoOffline()) {
          log("local TTS and no STT endpoint/key — deriving captions offline from the script");
          await generateCaptionsOffline(project, sb);
        } else {
          await generateCaptions(project, sb);
        }
      };

      const load = () => base.loadStoryboard({ params: parseParams(opts.param) });
      const storyboard = await load();
      const langs = langsFrom(opts);
      const multi = !(langs.length === 1 && langs[0] === undefined);
      // Browser-free preflight: pacing forecast + pitfalls, before TTS is paid for.
      for (const lang of langs) logLint(lintStoryboard(storyboard, { lang }), log);

      if (!multi) {
        // Default single-language pipeline — voice → record → captions → compose.
        // Each stage also gets its own stable logs/<stage>.log (in addition to
        // this run's logs/render.log) — see stageLog's doc comment.
        await stageLog(base, "voice", () =>
          generateVoice(base, storyboard, { force: opts.forceVoice })
        );
        await stageLog(base, "record", () =>
          record(base, storyboard, {
            profileDir: opts.profile,
            fresh: opts.fresh,
            ...seedOpts(opts),
            reloadStoryboard: load,
            headed: !opts.headless,
            capture: parseCapture(opts.capture),
            fromScene: opts.fromScene,
          })
        );
        await stageLog(base, "captions", () => captionsFor(base, storyboard));
        await stageLog(base, "compose", () => compose(base, storyboard));
        if (opts.gif) await stageLog(base, "gif", () => exportGif(base));
        // Screenshot mode: emit any `still` PNGs from the clean take (a
        // re-extract, not a re-record).
        if (storyboardHasStills(storyboard)) {
          await stageLog(base, "stills", () => extractStills(base));
        }
        if (storyboard.output?.walkthrough) {
          await stageLog(base, "walkthrough", () => exportWalkthrough(base, storyboard));
        }
        step("Done");
        ok(`▶ open ${base.outputPath}`);
        return;
      }

      // Multi-language: record the SHARED take ONCE (language-independent), then
      // voice + captions + compose per language over the same footage. Stills
      // come from the shared clean take, so extract them once from the base.
      await stageLog(base, "record", () =>
        record(base, storyboard, {
          profileDir: opts.profile,
          fresh: opts.fresh,
          ...seedOpts(opts),
          reloadStoryboard: load,
          headed: !opts.headless,
          capture: parseCapture(opts.capture),
          fromScene: opts.fromScene,
        })
      );
      if (storyboardHasStills(storyboard)) {
        await stageLog(base, "stills", () => extractStills(base));
      }
      for (const lang of langs) {
        const project = new Project(dir, lang!);
        await beginCommand(project, "render");
        const sb = localizeStoryboard(storyboard, lang!);
        warnPartialCoverage(storyboard, lang!);
        await stageLog(project, "voice", () =>
          generateVoice(project, sb, { force: opts.forceVoice })
        );
        await stageLog(project, "captions", () => captionsFor(project, sb));
        await stageLog(project, "compose", () => compose(project, sb));
        if (opts.gif) await stageLog(project, "gif", () => exportGif(project));
        ok(`▶ open ${project.outputPath}`);
      }
      step("Done");
    }
  );

try {
  await program.parseAsync(process.argv);
  await closeLogFile();
} catch (err) {
  fail((err as Error).message);
  await closeLogFile();
  process.exit(1);
}
