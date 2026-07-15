import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ENGINE_ROOT, engineVersion, captionsAutoOffline } from "../config.js";
import { Project, parseStoryboard } from "../project.js";
import { StoryboardSchema } from "../types.js";
import { generateVoice } from "../voice.js";
import { record, type RecordOptions } from "../recorder.js";
import {
  buildProbeGolden,
  diffGolden,
  readProbeGolden,
  writeProbeGolden,
} from "../golden.js";
import type { ProbeGoldenScene } from "../types.js";
import { generateCaptions, generateCaptionsOffline } from "../captions.js";
import { compose } from "../compose.js";
import { exportGif } from "../gif.js";
import { buildEmbed } from "../embed.js";
import { extractStills, storyboardHasStills } from "../stills.js";
import { localizeStoryboard } from "../i18n.js";
import { scaffoldDemo, doctorReport, buildFeedback, fileFeedback } from "../distribute.js";
import { readJson, log, CanceledError, type SceneProgress } from "../util.js";
import { JobManager, JobBusyError, type Job, type JobKind } from "./jobs.js";

/**
 * `aidemo mcp` — the agent interface. A stdio MCP server wrapping the same
 * stage functions the CLI uses (stdout is reserved for JSON-RPC; all engine
 * logging already goes to stderr). No network listener — stdio only.
 */

const INSTRUCTIONS = `aidemo renders narrated, captioned product-demo videos from a storyboard.json.
Start by calling get_authoring_guide and follow it. Validate storyboard edits
with validate_storyboard (cheap) before rendering. Pipeline operations (probe,
record, render, voice, captions, compose, gif) return a jobId immediately —
poll job_status for progress, per-scene counters, results, and failure
artifacts; only one job runs at a time. Always pass absolute demo directories.
Hit an engine bug, surprise, or workaround this session? Call the feedback
tool (title + body — environment/log context is auto-attached) before you
finish; skip if nothing came up. A failed job_status result also carries a
feedbackHint pointing back here.`;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function jsonResult(obj: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj,
  };
}

/** Error result: output-schema validation is skipped for isError results. */
function errorResult(obj: Record<string, unknown> & { message: string }): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

const JOB_START_SHAPE = {
  jobId: z.string(),
  kind: z.string(),
  demoDir: z.string().describe("resolved absolute demo directory"),
  status: z.string(),
  logFile: z.string(),
};

const JOB_STATUS_SHAPE = {
  jobId: z.string(),
  kind: z.string(),
  demoDir: z.string(),
  status: z.enum(["running", "succeeded", "failed", "canceled"]),
  stage: z.string(),
  scenesTotal: z.number().nullable(),
  scenesDone: z.number(),
  currentScene: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  logFile: z.string(),
  logTail: z.array(z.string()),
  result: z.record(z.unknown()).optional(),
  error: z
    .object({
      message: z.string(),
      stage: z.string(),
      failureArtifacts: z.array(z.string()),
      logFile: z.string(),
      feedbackHint: z
        .string()
        .optional()
        .describe(
          "present on a genuine failure (not a cancel) — nudges toward the " +
            "feedback tool while context is fresh"
        ),
      salvaged: z
        .object({ scenes: z.number(), timeline: z.string() })
        .optional(),
    })
    .optional(),
};

const DIR_INPUT = z
  .string()
  .describe("demo project directory — pass an absolute path");

/**
 * Template params for a parameterized storyboard: name → value. Each key must
 * be declared in the storyboard's `params` block (typo-guarded); `{{name}}`
 * placeholders resolve to these values (else the declared default) across all
 * stages of the run.
 */
const PARAMS_INPUT = z
  .record(z.string(), z.string())
  .optional()
  .describe(
    "storyboard template params (name → value); each must be declared in the " +
      "storyboard's params block. Substitutes {{name}} across all stages."
  );

const LANG_INPUT = z
  .string()
  .optional()
  .describe(
    "render a language variant from scene.narrations[<code>] over the shared " +
      "take (artifacts namespaced: audio/<code>/, captions.<code>.*, " +
      "output/final-demo.<code>.mp4). Omit for the default single-language render."
  );

/** A language-scoped Project for a variant render (same dir, per-lang artifacts). */
function langProject(project: Project, lang?: string): Project {
  return lang ? new Project(project.dir, lang) : project;
}

const RECORD_INPUT_SHAPE = {
  dir: DIR_INPUT,
  headless: z
    .boolean()
    .optional()
    .describe("run Chrome headless (default false — headed, like the CLI)"),
  profile: z
    .string()
    .optional()
    .describe("Chrome user-data dir (logged-in profile)"),
  capture: z.enum(["playwright", "native", "obs"]).optional(),
  params: PARAMS_INPUT,
};

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CanceledError("canceled between stages");
}

export function buildMcpServer(): { server: McpServer; jobs: JobManager } {
  const jobs = new JobManager();
  const server = new McpServer(
    { name: "aidemo", version: engineVersion() },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } }
  );

  // Best-effort log forwarding (throttled); job_status polling is the source
  // of truth — many clients don't surface logging notifications.
  const lastSent = new Map<string, number>();
  jobs.onLine = (job, chunk) => {
    const now = Date.now();
    if (now - (lastSent.get(job.jobId) ?? 0) < 1000) return;
    lastSent.set(job.jobId, now);
    void server
      .sendLoggingMessage({
        level: "info",
        logger: "aidemo",
        data: { jobId: job.jobId, stage: job.stage, line: chunk.trim() },
      })
      .catch(() => {});
  };

  const guidePath = resolve(ENGINE_ROOT, "docs", "AUTHORING.md");

  server.registerTool(
    "get_authoring_guide",
    {
      title: "Get the aidemo authoring guide",
      description:
        "The canonical guide to authoring demos: storyboard schema, action " +
        "vocabulary, demo-director principles, ChatGPT-app recording facts. " +
        "Call this FIRST before authoring or editing a storyboard.",
      inputSchema: {},
      outputSchema: { guide: z.string(), engineVersion: z.string() },
      annotations: { readOnlyHint: true },
    },
    async () =>
      jsonResult({
        guide: await readFile(guidePath, "utf8"),
        engineVersion: engineVersion(),
      })
  );

  server.registerTool(
    "get_storyboard_schema",
    {
      title: "Get the storyboard JSON Schema",
      description:
        "JSON Schema for storyboard.json, generated from the engine's own " +
        "zod schema — the exact contract the engine validates against.",
      inputSchema: {},
      outputSchema: { schema: z.record(z.unknown()) },
      annotations: { readOnlyHint: true },
    },
    async () =>
      jsonResult({
        schema: zodToJsonSchema(StoryboardSchema, { $refStrategy: "none" }),
      })
  );

  server.registerTool(
    "validate_storyboard",
    {
      title: "Validate a storyboard",
      description:
        "Validate a storyboard against the engine schema without running " +
        "anything. Pass exactly one of: dir (uses generated/storyboard.json), " +
        "path (a storyboard file), or json (storyboard JSON as a string). " +
        "relaxed makes narration optional (probe semantics).",
      inputSchema: {
        dir: z.string().optional().describe("demo dir → generated/storyboard.json"),
        path: z.string().optional().describe("path to a storyboard .json file"),
        json: z.string().optional().describe("storyboard JSON as a string"),
        relaxed: z.boolean().optional(),
        params: PARAMS_INPUT,
      },
      outputSchema: {
        valid: z.boolean(),
        storyboardPath: z.string().optional(),
        title: z.string().optional(),
        sceneCount: z.number().optional(),
        issues: z.array(
          z.object({ path: z.string(), message: z.string(), code: z.string() })
        ),
        warnings: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const sources = [args.dir, args.path, args.json].filter(
        (s) => s != null
      ).length;
      if (sources !== 1) {
        return errorResult({
          message: "pass exactly one of: dir, path, json",
        });
      }
      let raw: unknown;
      let storyboardPath: string | undefined;
      try {
        if (args.json != null) {
          raw = JSON.parse(args.json);
        } else {
          storyboardPath =
            args.path != null
              ? resolve(args.path)
              : new Project(args.dir as string).storyboardPath;
          raw = await readJson<unknown>(storyboardPath);
        }
      } catch (err) {
        return jsonResult({
          valid: false,
          ...(storyboardPath ? { storyboardPath } : {}),
          issues: [
            {
              path: "",
              message: (err as Error).message,
              code: "unreadable",
            },
          ],
          warnings: [],
        });
      }
      const parsed = parseStoryboard(raw, {
        relaxed: args.relaxed,
        params: args.params,
        strict: args.params != null,
      });
      if (!parsed.ok) {
        return jsonResult({
          valid: false,
          ...(storyboardPath ? { storyboardPath } : {}),
          issues: parsed.issues,
          warnings: [],
        });
      }
      return jsonResult({
        valid: true,
        ...(storyboardPath ? { storyboardPath } : {}),
        title: parsed.storyboard.title,
        sceneCount: parsed.storyboard.scenes.length,
        issues: [],
        warnings: parsed.warnings,
      });
    }
  );

  server.registerTool(
    "init_demo",
    {
      title: "Scaffold a new demo",
      description:
        "Create demos/<name>/ with a starter brief + storyboard. dir is the " +
        "repo to scaffold into (absolute path recommended; default: server cwd).",
      inputSchema: {
        name: z.string().describe("demo name (creates demos/<name>/)"),
        dir: z.string().optional(),
        force: z.boolean().optional(),
      },
      outputSchema: {
        demoDir: z.string(),
        storyboardPath: z.string(),
        briefPath: z.string(),
      },
    },
    async (args) => {
      const demoDir = await scaffoldDemo(
        args.dir ? resolve(args.dir) : process.cwd(),
        args.name,
        { force: args.force }
      );
      const project = new Project(demoDir);
      return jsonResult({
        demoDir,
        storyboardPath: project.storyboardPath,
        briefPath: project.p("input", "brief.md"),
      });
    }
  );

  server.registerTool(
    "doctor",
    {
      title: "Environment preflight",
      description:
        "Check prereqs: node, ffmpeg, Chrome, TTS/STT endpoint (flags " +
        "LLM-only servers like Ollama), API key, playwright, installed skill.",
      inputSchema: {
        dir: z.string().optional().describe("repo to check for an installed skill"),
      },
      outputSchema: {
        engineVersion: z.string(),
        node: z.string(),
        ffmpeg: z.string().nullable(),
        chrome: z.string().nullable(),
        gh: z.string().nullable(),
        endpoint: z.object({
          url: z.string(),
          custom: z.boolean(),
          warning: z.string().optional(),
        }),
        apiKey: z.enum(["set", "not-required", "missing"]),
        tts: z.object({
          provider: z.string(),
          elevenLabsKey: z.enum(["set", "missing"]).optional(),
        }),
        playwright: z.boolean(),
        skill: z.object({
          target: z.string(),
          installed: z
            .object({
              version: z.string(),
              stableAvailable: z.string().nullable(),
            })
            .nullable(),
        }),
        ok: z.boolean(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      jsonResult(
        (await doctorReport(args.dir)) as unknown as Record<string, unknown>
      )
  );

  server.registerTool(
    "embed",
    {
      title: "Always-fresh embed snippets",
      description:
        "Ready-to-paste embed snippets (markdown GIF, markdown still, HTML " +
        "<video>) for a demo, using stable raw.githubusercontent URLs on the " +
        "'demo-media' branch. Pure string generation — no network, no render. " +
        "Owner/repo come from the repo's origin remote; the demo name from the " +
        "directory basename. Pair with the demo-publish workflow so CI keeps " +
        "the URLs fresh. See docs/EMBEDS.md.",
      inputSchema: {
        dir: DIR_INPUT,
        repo: z
          .string()
          .optional()
          .describe("consuming repo to detect owner/repo from (default: server cwd)"),
        still: z
          .string()
          .optional()
          .describe("still-frame basename under stills/ (default: poster)"),
      },
      outputSchema: {
        owner: z.string(),
        repo: z.string(),
        demo: z.string(),
        branch: z.string(),
        still: z.string(),
        urls: z.object({
          gif: z.string(),
          mp4: z.string(),
          still: z.string(),
          pagesMp4: z.string(),
          pagesBase: z.string(),
        }),
        snippets: z.object({
          markdownGif: z.string(),
          markdownStill: z.string(),
          htmlVideo: z.string(),
        }),
        workflow: z.object({
          path: z.string(),
          present: z.boolean(),
          template: z.string(),
        }),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const result = await buildEmbed(args.dir, {
          repoDir: args.repo,
          still: args.still,
        });
        return jsonResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        return errorResult({ message: (err as Error).message });
      }
    }
  );

  server.registerTool(
    "feedback",
    {
      title: "File engine feedback",
      description:
        "File a bug, surprise, or workaround you hit this session as a GitHub " +
        "issue on the aidemo engine repo (github.com/tandryukha/aidemo) — the " +
        "in-band equivalent of `aidemo feedback` on the CLI. Environment " +
        "(engine version, OS, node, ffmpeg) and a recent-log tail from `dir` " +
        "are auto-attached, same as the CLI. Uses `gh issue create` when " +
        "available; falls back to a local docs/feedback-*.md plus a prefilled " +
        "github.com New Issue URL when gh is missing or offline — no other " +
        "network call. Call this whenever something felt broken, surprising, " +
        "or needed a workaround; skip it if the session was clean. Set dryRun " +
        "to preview the assembled title/body without filing anything.",
      inputSchema: {
        title: z.string().describe("short issue title"),
        body: z
          .string()
          .describe(
            "what happened / suggestion — the actual finding (broken selector, " +
              "bad timing, confusing behavior, an idea). Environment/log context " +
              "is appended automatically; don't duplicate it here."
          ),
        dir: z
          .string()
          .optional()
          .describe("demo dir to pull storyboard/log context from (recommended)"),
        web: z
          .boolean()
          .optional()
          .describe("prefer a prefilled browser New Issue URL over filing via gh"),
        dryRun: z
          .boolean()
          .optional()
          .describe("assemble the title/body but don't file anything — preview only"),
      },
      outputSchema: {
        filed: z.boolean(),
        title: z.string(),
        body: z.string(),
        url: z.string().optional(),
        localPath: z.string().optional(),
        message: z.string(),
      },
    },
    async (args) => {
      const demoDir = args.dir ? resolve(args.dir) : null;
      const ctx = await buildFeedback(demoDir, { title: args.title, description: args.body });
      const result = await fileFeedback(ctx, {
        web: args.web,
        dryRun: args.dryRun,
        cwd: demoDir ?? undefined,
      });
      return jsonResult({ ...result, title: ctx.title, body: ctx.body });
    }
  );

  server.registerTool(
    "job_status",
    {
      title: "Poll a job",
      description:
        "Status, stage, per-scene progress (scenesTotal/scenesDone/" +
        "currentScene — populated for probe/record/render/voice/captions/" +
        "compose), log tail, and final result or error (with failure-artifact " +
        "paths and, on a genuine failure, a feedbackHint pointing at the " +
        "feedback tool) of a pipeline job.",
      inputSchema: {
        jobId: z.string(),
        tailLines: z.number().optional().describe("log lines to return (default 40)"),
      },
      outputSchema: JOB_STATUS_SHAPE,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const job = jobs.get(args.jobId);
      if (!job) {
        return errorResult({
          message:
            `unknown job ${args.jobId} — job history lives in server memory ` +
            `(a restart forgets ids). Artifacts persist under <demoDir>/logs/.`,
        });
      }
      return jsonResult(jobs.statusOf(job, args.tailLines ?? 40));
    }
  );

  server.registerTool(
    "job_list",
    {
      title: "List jobs",
      description: "All jobs this server session, newest last.",
      inputSchema: {},
      outputSchema: {
        jobs: z.array(
          z.object({
            jobId: z.string(),
            kind: z.string(),
            demoDir: z.string(),
            status: z.string(),
            stage: z.string(),
            startedAt: z.string(),
            endedAt: z.string().nullable(),
          })
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async () =>
      jsonResult({
        jobs: jobs.list().map((j) => ({
          jobId: j.jobId,
          kind: j.kind,
          demoDir: j.demoDir,
          status: j.status,
          stage: j.stage,
          startedAt: j.startedAt.toISOString(),
          endedAt: j.endedAt ? j.endedAt.toISOString() : null,
        })),
      })
  );

  server.registerTool(
    "job_cancel",
    {
      title: "Cancel a job",
      description:
        "Best-effort cancel (checked between actions/scenes/stages). A " +
        "mid-record cancel salvages the partial timeline + footage. The job " +
        "settles asynchronously — poll job_status for the final state.",
      inputSchema: { jobId: z.string() },
      outputSchema: JOB_STATUS_SHAPE,
    },
    async (args) => {
      const job = jobs.cancel(args.jobId);
      if (!job) return errorResult({ message: `unknown job ${args.jobId}` });
      return jsonResult(jobs.statusOf(job));
    }
  );

  /** Register a pipeline tool that starts a job and returns immediately. */
  function registerJob<Shape extends z.ZodRawShape>(
    kind: JobKind,
    description: string,
    inputShape: Shape,
    makeRunner: (
      project: Project,
      args: z.infer<z.ZodObject<Shape>>
    ) => (job: Job) => Promise<unknown>
  ): void {
    server.registerTool(
      kind,
      {
        description:
          `${description} Returns a jobId immediately — poll job_status. ` +
          `Rejects if another job is running.`,
        inputSchema: inputShape,
        outputSchema: JOB_START_SHAPE,
      },
      (async (args: z.infer<z.ZodObject<Shape>>) => {
        const project = new Project((args as { dir: string }).dir);
        await project.ensureDirs();
        try {
          const job = jobs.startJob(kind, project, makeRunner(project, args));
          return jsonResult({
            jobId: job.jobId,
            kind: job.kind,
            demoDir: job.demoDir,
            status: job.status,
            logFile: job.logFile,
          });
        } catch (err) {
          if (err instanceof JobBusyError) {
            return errorResult({
              message: err.message,
              runningJobId: err.runningJobId,
            });
          }
          throw err;
        }
      }) as never
    );
  }

  /** Record options wired to a job's progress fields + abort signal. */
  function recordOpts(
    args: { headless?: boolean; profile?: string; capture?: "playwright" | "native" | "obs" },
    job: Job
  ): RecordOptions {
    return {
      profileDir: args.profile,
      headed: !args.headless,
      capture: args.capture,
      signal: job.controller.signal,
      onSceneStart: (sceneId, index, total) => {
        job.currentScene = sceneId;
        job.scenesTotal = total;
      },
      onSceneComplete: (_scene, index, total) => {
        job.scenesDone = index + 1;
        job.scenesTotal = total;
      },
    };
  }

  /**
   * Per-scene progress hooks wired to a job's currentScene/scenesTotal/
   * scenesDone fields — the voice/captions/compose equivalent of recordOpts
   * above. voice.ts, captions.ts and compose.ts each loop per scene; this is
   * what makes that loop visible to job_status pollers instead of only the
   * log tail (aidemo#17).
   */
  function sceneProgress(job: Job): Required<SceneProgress> {
    return {
      onSceneStart: (sceneId, _index, total) => {
        job.currentScene = sceneId;
        job.scenesTotal = total;
      },
      onSceneComplete: (_sceneId, index, total) => {
        job.scenesDone = index + 1;
        job.scenesTotal = total;
      },
    };
  }

  registerJob(
    "probe",
    "Record-only dry run to verify selectors/timing (narration optional). " +
      "With updateGolden, writes golden/probe.json (the regression baseline); " +
      "with golden, deep-compares against it and returns match + field-level diffs.",
    {
      ...RECORD_INPUT_SHAPE,
      updateGolden: z
        .boolean()
        .optional()
        .describe("write golden/probe.json from this probe (commit it as the baseline)"),
      golden: z
        .boolean()
        .optional()
        .describe("compare against golden/probe.json; returns match + diffs (CI guard)"),
    },
    (project, args) => async (job) =>
      jobs.runStage(job, "probe", async () => {
        const storyboard = await project.loadStoryboard({
          relaxed: true,
          params: args.params,
        });
        const goldenMode = !!(args.golden || args.updateGolden);
        const probeScenes: ProbeGoldenScene[] = [];
        const timeline = await record(project, storyboard, {
          ...recordOpts(args, job),
          ...(goldenMode ? { probe: probeScenes } : {}),
        });
        const base = {
          rawVideo: await project.resolveRawVideo(),
          timeline: project.timelinePath,
          totalMs: timeline.totalMs,
          scenes: timeline.scenes.length,
        };
        if (args.updateGolden) {
          const golden = buildProbeGolden(storyboard, probeScenes);
          await writeProbeGolden(project, golden);
          return {
            ...base,
            golden: {
              path: project.goldenProbePath,
              updated: true,
              scenes: golden.scenes.length,
            },
          };
        }
        if (args.golden) {
          const expected = await readProbeGolden(project);
          if (!expected) {
            return {
              ...base,
              golden: {
                path: project.goldenProbePath,
                match: false,
                error:
                  "no golden baseline — run probe with updateGolden:true first",
              },
            };
          }
          const diffs = diffGolden(expected, buildProbeGolden(storyboard, probeScenes));
          return {
            ...base,
            golden: {
              path: project.goldenProbePath,
              match: diffs.length === 0,
              diffs,
            },
          };
        }
        return base;
      })
  );

  registerJob(
    "record",
    "Drive the storyboard in Chrome and record raw video + timeline.json.",
    RECORD_INPUT_SHAPE,
    (project, args) => async (job) =>
      jobs.runStage(job, "record", async () => {
        const storyboard = await project.loadStoryboard({ params: args.params });
        const timeline = await record(project, storyboard, recordOpts(args, job));
        return {
          rawVideo: await project.resolveRawVideo(),
          timeline: project.timelinePath,
          totalMs: timeline.totalMs,
          scenes: timeline.scenes.length,
        };
      })
  );

  registerJob(
    "render",
    "Full pipeline: voice → record → captions → compose (the CLI `render`).",
    {
      ...RECORD_INPUT_SHAPE,
      forceVoice: z.boolean().optional(),
      gif: z.boolean().optional().describe("also export output/final-demo.gif"),
      lang: LANG_INPUT,
    },
    (project, args) => async (job) =>
      jobs.runStage(job, "render", async () => {
        const signal = job.controller.signal;
        const storyboard = await project.loadStoryboard({ params: args.params });
        // Language variant (if any): voice/captions/compose run on a lang-scoped
        // project + localized storyboard; the take is recorded ONCE on the base.
        const lp = langProject(project, args.lang);
        const sb = args.lang ? localizeStoryboard(storyboard, args.lang) : storyboard;
        // Each sub-stage below is wrapped in runSubStage: it refreshes its OWN
        // stable logs/<stage>.log (not just logs/render.log) and updates
        // job.stage/currentScene/scenesTotal/scenesDone — same fields a
        // standalone voice/captions/compose job would set — so a poller sees
        // real progress for whichever stage is currently running, and a
        // log-watcher never sees a stale logs/compose.log from an earlier run.
        await jobs.runSubStage(job, "voice", () =>
          generateVoice(lp, sb, { force: args.forceVoice, signal, ...sceneProgress(job) })
        );
        throwIfAborted(signal);
        await jobs.runSubStage(job, "record", () =>
          record(project, storyboard, recordOpts(args, job))
        );
        throwIfAborted(signal);
        await jobs.runSubStage(job, "captions", async () => {
          if (captionsAutoOffline()) {
            log("local TTS and no STT endpoint/key — deriving captions offline from the script");
            await generateCaptionsOffline(lp, sb, sceneProgress(job));
          } else {
            await generateCaptions(lp, sb, sceneProgress(job));
          }
        });
        throwIfAborted(signal);
        await jobs.runSubStage(job, "compose", () => compose(lp, sb, sceneProgress(job)));
        let gifPath: string | undefined;
        if (args.gif) {
          gifPath = await jobs.runSubStage(job, "gif", () => exportGif(lp));
        }
        // Screenshot mode: emit named stills from the clean take when the
        // storyboard declares any `still` markers (a re-extract, not a re-take).
        let stills: string[] | undefined;
        if (storyboardHasStills(storyboard)) {
          stills = await jobs.runSubStage(job, "stills", () => extractStills(project));
        }
        return {
          output: lp.outputPath,
          ...(gifPath ? { gif: gifPath } : {}),
          ...(stills && stills.length ? { stills } : {}),
          timeline: lp.timelinePath,
          captionsSrt: lp.captionsSrtPath,
        };
      })
  );

  registerJob(
    "voice",
    "Generate per-scene TTS narration (skips unchanged scenes).",
    {
      dir: DIR_INPUT,
      scene: z.string().optional().describe("regenerate only this scene id"),
      force: z.boolean().optional(),
      params: PARAMS_INPUT,
      lang: LANG_INPUT,
    },
    (project, args) => async (job) =>
      jobs.runStage(job, "voice", async () => {
        const lp = langProject(project, args.lang);
        const storyboard = await project.loadStoryboard({ params: args.params });
        const sb = args.lang ? localizeStoryboard(storyboard, args.lang) : storyboard;
        const manifest = await generateVoice(lp, sb, {
          only: args.scene,
          force: args.force,
          signal: job.controller.signal,
          ...sceneProgress(job),
        });
        return {
          narration: lp.narrationPath,
          voiceManifest: lp.voiceManifestPath,
          scenes: manifest.scenes.map((s) => ({
            id: s.id,
            durationMs: s.durationMs,
          })),
        };
      })
  );

  registerJob(
    "captions",
    "Transcribe narration.mp3 to captions with word timing.",
    {
      dir: DIR_INPUT,
      offline: z
        .boolean()
        .optional()
        .describe("approximate captions from the script — no network/STT"),
      params: PARAMS_INPUT,
      lang: LANG_INPUT,
    },
    (project, args) => async (job) =>
      jobs.runStage(job, "captions", async () => {
        const lp = langProject(project, args.lang);
        const storyboard = await project.loadStoryboard({ params: args.params });
        const sb = args.lang ? localizeStoryboard(storyboard, args.lang) : storyboard;
        if (args.offline) {
          await generateCaptionsOffline(lp, sb, sceneProgress(job));
        } else {
          await generateCaptions(lp, sb, sceneProgress(job));
        }
        return {
          srt: lp.captionsSrtPath,
          vtt: lp.captionsVttPath,
          cues: lp.captionsCuesPath,
        };
      })
  );

  registerJob(
    "compose",
    "Trim, sync, mux and caption into output/final-demo.mp4.",
    {
      dir: DIR_INPUT,
      gif: z.boolean().optional().describe("also export output/final-demo.gif"),
      params: PARAMS_INPUT,
      lang: LANG_INPUT,
    },
    (project, args) => async (job) =>
      jobs.runStage(job, "compose", async () => {
        const lp = langProject(project, args.lang);
        const storyboard = await project.loadStoryboard({ params: args.params });
        const sb = args.lang ? localizeStoryboard(storyboard, args.lang) : storyboard;
        await compose(lp, sb, sceneProgress(job));
        let gifPath: string | undefined;
        if (args.gif) gifPath = await exportGif(lp);
        return {
          output: lp.outputPath,
          ...(gifPath ? { gif: gifPath } : {}),
        };
      })
  );

  registerJob(
    "gif",
    "Convert output/final-demo.mp4 to a README-ready GIF.",
    {
      dir: DIR_INPUT,
      width: z.number().int().positive().optional(),
      fps: z.number().int().positive().optional(),
      out: z.string().optional(),
    },
    (project, args) => async (job) =>
      jobs.runStage(job, "gif", async () => ({
        gif: await exportGif(project, {
          width: args.width,
          fps: args.fps,
          out: args.out,
        }),
      }))
  );

  registerJob(
    "stills",
    "Extract named stills (screenshot mode) from the recorded take into " +
      "output/stills/ — one PNG per `still` marker, pulled from the CLEAN take " +
      "(no captions/zoom). Needs only a recorded timeline (no key).",
    {
      dir: DIR_INPUT,
      out: z
        .string()
        .optional()
        .describe("output directory (default <dir>/output/stills)"),
    },
    (project, args) => async (job) =>
      jobs.runStage(job, "stills", async () => ({
        stills: await extractStills(project, { outDir: args.out }),
      }))
  );

  server.registerResource(
    "authoring-guide",
    "aidemo://authoring-guide",
    {
      title: "aidemo authoring guide",
      description: "Canonical agent-neutral demo-authoring guide",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: await readFile(guidePath, "utf8"),
        },
      ],
    })
  );

  server.registerResource(
    "storyboard-schema",
    "aidemo://storyboard-schema",
    {
      title: "storyboard.json JSON Schema",
      description: "JSON Schema generated from the engine's zod schema",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            zodToJsonSchema(StoryboardSchema, { $refStrategy: "none" }),
            null,
            2
          ),
        },
      ],
    })
  );

  return { server, jobs };
}

/** Run the stdio server until the client disconnects. Never resolves. */
export async function runMcpServer(): Promise<void> {
  const { server, jobs } = buildMcpServer();
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // The launcher (bin/aidemo.mjs) spawnSyncs us with inherited stdio: when
    // a client kills only the launcher, stdin EOF is the reliable death
    // signal. Abort the active job (a mid-record abort rides the salvage
    // path) and give it a grace window so Chrome closes and the partial
    // timeline lands — an orphaned headed Chrome would hold the profile lock
    // and break the next record.
    void (async () => {
      if (jobs.abortActive()) await jobs.waitForIdle(10_000);
      process.exit(0);
    })();
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  server.server.onclose = shutdown;
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise(() => {}); // lives until shutdown() exits the process
}
