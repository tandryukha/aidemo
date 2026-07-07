import { Command } from "commander";
import { resolve, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { loadEnv, engineVersion, ENGINE_ROOT, captionsAutoOffline } from "./config.js";
import { Project } from "./project.js";
import { record } from "./recorder.js";
import { generateVoice } from "./voice.js";
import { generateCaptions, generateCaptionsOffline } from "./captions.js";
import { compose } from "./compose.js";
import { exportGif } from "./gif.js";
import { synthesizeMusicBed } from "./music.js";
import { ensureDir, ok, step, fail, log, setLogFile, closeLogFile } from "./util.js";
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
  .description("scaffold a new demo project (in the current repo) with a starter storyboard")
  .action(async (name: string, opts: { force?: boolean }) => {
    // Scaffold into the *current* working directory, so `init` works both in the
    // engine's own repo and in a consumer repo that invoked it via npx.
    const dir = await scaffoldDemo(process.cwd(), name, { force: opts.force });
    ok(`edit generated/storyboard.json, then: aidemo render ${dir}`);
  });

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
  .action(async () => {
    // Deliberate stdout (not the stderr logger): the guide is the output.
    process.stdout.write(
      await readFile(resolve(ENGINE_ROOT, "docs/AUTHORING.md"), "utf8")
    );
  });

program
  .command("feedback")
  .argument("[dir]", "demo project directory (adds storyboard + log context)")
  .option("--web", "open a prefilled New Issue page instead of filing directly", false)
  .option("--dry-run", "print the issue title/body without filing", false)
  .description("file demo-recording feedback as a GitHub issue on the engine repo")
  .action(async (dir: string | undefined, opts: { web?: boolean; dryRun?: boolean }) => {
    await feedback(dir, { web: opts.web, dryRun: opts.dryRun });
  });

program
  .command("doctor")
  .option("--dir <dir>", "repo to check for an installed skill (default: current directory)")
  .description("check prereqs (ffmpeg/chrome/openai key) + installed-vs-stable skill version")
  .action(async (opts: { dir?: string }) => {
    await doctor(opts.dir);
  });

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

program
  .command("record")
  .argument("<dir>", "demo project directory")
  .option("--profile <dir>", "Chrome user-data dir (logged-in profile)")
  .option("--headless", "run headless (not recommended for real Chrome)", false)
  .option(
    "--capture <mode>",
    "capture path: playwright (default) | native (ffmpeg screen grab) | obs"
  )
  .description("drive the storyboard in Chrome and record raw video + timeline.json")
  .action(
    async (
      dir: string,
      opts: { profile?: string; headless?: boolean; capture?: string }
    ) => {
      const project = new Project(dir);
      await beginCommand(project, "record");
      const storyboard = await project.loadStoryboard();
      await record(project, storyboard, {
        profileDir: opts.profile,
        headed: !opts.headless,
        capture: parseCapture(opts.capture),
      });
    }
  );

program
  .command("probe")
  .argument("<dir>", "demo project directory")
  .option("--profile <dir>", "Chrome user-data dir (logged-in profile)")
  .option("--headless", "run headless (not recommended for real Chrome)", false)
  .option(
    "--capture <mode>",
    "capture path: playwright (default) | native (ffmpeg screen grab) | obs"
  )
  .description(
    "record-only dry run to verify selectors/timing (narration optional)"
  )
  .action(
    async (
      dir: string,
      opts: { profile?: string; headless?: boolean; capture?: string }
    ) => {
      const project = new Project(dir);
      await beginCommand(project, "probe");
      // Relaxed: narration is optional — a probe just exercises the flow.
      const storyboard = await project.loadStoryboard({ relaxed: true });
      await record(project, storyboard, {
        profileDir: opts.profile,
        headed: !opts.headless,
        capture: parseCapture(opts.capture),
      });
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
  .description("generate per-scene TTS and assemble narration.mp3 + voice.json")
  .action(async (dir: string, opts: { scene?: string; force?: boolean }) => {
    const project = new Project(dir);
    await beginCommand(project, "voice");
    const storyboard = await project.loadStoryboard();
    await generateVoice(project, storyboard, { only: opts.scene, force: opts.force });
  });

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
  .description("transcribe narration.mp3 to captions.srt/vtt with word timing")
  .action(async (dir: string, opts: { offline?: boolean }) => {
    const project = new Project(dir);
    await beginCommand(project, "captions");
    if (opts.offline) {
      const storyboard = await project.loadStoryboard();
      await generateCaptionsOffline(project, storyboard);
    } else {
      await generateCaptions(project);
    }
  });

program
  .command("compose")
  .argument("<dir>", "demo project directory")
  .option("--gif", "also export output/final-demo.gif after the mux", false)
  .description("trim, sync, mux and caption into output/final-demo.mp4")
  .action(async (dir: string, opts: { gif?: boolean }) => {
    const project = new Project(dir);
    await beginCommand(project, "compose");
    const storyboard = await project.loadStoryboard();
    await compose(project, storyboard);
    if (opts.gif) await exportGif(project);
  });

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
  .command("render")
  .argument("<dir>", "demo project directory")
  .option("--profile <dir>", "Chrome user-data dir (logged-in profile)")
  .option("--headless", "run headless", false)
  .option(
    "--capture <mode>",
    "capture path: playwright (default) | native (ffmpeg screen grab) | obs"
  )
  .option("--force-voice", "re-synthesize narration even if unchanged", false)
  .option("--gif", "also export output/final-demo.gif after the mux", false)
  .description("run the full pipeline: voice → record → captions → compose")
  .action(
    async (
      dir: string,
      opts: {
        profile?: string;
        headless?: boolean;
        capture?: string;
        forceVoice?: boolean;
        gif?: boolean;
      }
    ) => {
      const project = new Project(dir);
      await beginCommand(project, "render");
      const storyboard = await project.loadStoryboard();
      await generateVoice(project, storyboard, { force: opts.forceVoice });
      await record(project, storyboard, {
        profileDir: opts.profile,
        headed: !opts.headless,
        capture: parseCapture(opts.capture),
      });
      if (captionsAutoOffline()) {
        log("local TTS and no STT endpoint/key — deriving captions offline from the script");
        await generateCaptionsOffline(project, storyboard);
      } else {
        await generateCaptions(project);
      }
      await compose(project, storyboard);
      if (opts.gif) await exportGif(project);
      step("Done");
      ok(`▶ open ${project.outputPath}`);
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
