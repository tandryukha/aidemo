import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ENGINE_ROOT, engineVersion, captionsAutoOffline } from "../config.js";
import { Project, parseStoryboard } from "../project.js";
import { StoryboardSchema, SeedCookieSchema, type SeedCookie, type Storyboard } from "../types.js";
import { generateVoice } from "../voice.js";
import { record, type RecordOptions } from "../recorder.js";
import {
  buildProbeGolden,
  diffGolden,
  driftFilesForDiff,
  readProbeGolden,
  writeProbeGolden,
} from "../golden.js";
import type { ProbeGoldenScene } from "../types.js";
import { generateCaptions, generateCaptionsOffline } from "../captions.js";
import { compose } from "../compose.js";
import { exportGif } from "../gif.js";
import { buildEmbed } from "../embed.js";
import { extractStills, storyboardHasStills } from "../stills.js";
import { extractFrames } from "../frames.js";
import { inspectPage } from "../inspect.js";
import { exportWalkthrough } from "../walkthrough.js";
import { GUIDE_TOPIC_NAMES, guideHeadings, guidePath as guideFilePath, sliceGuide } from "../guide.js";
import { lintStoryboard, logLint } from "../lint.js";
import { localizeStoryboard } from "../i18n.js";
import { scaffoldDemo, doctorReport, buildFeedback, fileFeedback } from "../distribute.js";
import { readJson, writeJson, log, CanceledError, type SceneProgress } from "../util.js";
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
/** Output shape of one lint finding (src/lint.ts LintIssue). */
const LINT_ISSUE_SHAPE = z.object({
  severity: z.enum(["error", "warn", "info"]),
  code: z.string(),
  scene: z.string().optional(),
  action: z.number().optional(),
  message: z.string(),
  fix: z.string().optional(),
});

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
  fresh: z
    .boolean()
    .optional()
    .describe(
      "run against a WIPED throwaway profile — use for any demo whose story " +
        "starts at a first-run gate, onboarding, an empty state or a one-shot " +
        "flow, since carried-over cookies/localStorage silently record the " +
        "wrong story. Not for logged-in demos (a fresh profile has no login)."
    ),
  capture: z.enum(["playwright", "native", "obs"]).optional(),
  fromScene: z
    .string()
    .optional()
    .describe(
      "resume: keep the previous take's scenes before this scene id (footage + " +
        "timeline, verified unchanged by hash) and record from it — after a " +
        "late-scene failure or a change to the tail of the storyboard"
    ),
  storageState: z
    .string()
    .optional()
    .describe(
      "absolute path to a Playwright storageState JSON (cookies + per-origin " +
        "localStorage) to seed into the profile before the first action — for " +
        "cookie-gated sites. Also available as storyboard setup.storageState."
    ),
  cookies: z
    .array(SeedCookieSchema)
    .optional()
    .describe(
      "cookies to seed before the first action (name, value, domain[, path, " +
        "secure, httpOnly, sameSite, expires]). Also storyboard setup.cookies."
    ),
  profileSeeded: z
    .boolean()
    .optional()
    .describe(
      "the profile is seeded on purpose (login / cookie gate): silence the " +
        "carried-over-state warning. Implied by storageState/cookies."
    ),
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

  const guidePath = guideFilePath();

  server.registerTool(
    "get_authoring_guide",
    {
      title: "Get the aidemo authoring guide",
      description:
        "The canonical guide to authoring demos: storyboard schema, action " +
        "vocabulary, demo-director principles, ChatGPT-app recording facts. " +
        "Call this FIRST before authoring or editing a storyboard. Pass " +
        `\`topic\` (${GUIDE_TOPIC_NAMES.join(" | ")}, or any H2 heading prefix) ` +
        "for one slice instead of the whole ~1000-line guide; start with " +
        "`core`, then fetch `attention`/`polish`/`chatgpt-apps` as needed.",
      inputSchema: {
        topic: z
          .string()
          .optional()
          .describe(
            `Slice: ${GUIDE_TOPIC_NAMES.join(", ")} — or an H2 heading prefix. Omit for the full guide.`
          ),
      },
      outputSchema: {
        guide: z.string(),
        engineVersion: z.string(),
        topic: z.string().optional(),
        topics: z.array(z.string()),
        sections: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ topic }) => {
      const md = await readFile(guidePath, "utf8");
      const sections = guideHeadings(md);
      if (!topic) {
        return jsonResult({ guide: md, engineVersion: engineVersion(), topics: GUIDE_TOPIC_NAMES, sections });
      }
      const slice = sliceGuide(md, topic);
      if (slice == null) {
        return errorResult({
          message:
            `Unknown guide topic "${topic}". Topics: ${GUIDE_TOPIC_NAMES.join(", ")}; ` +
            `or an H2 heading prefix: ${sections.join(" · ")}`,
          topics: GUIDE_TOPIC_NAMES,
          sections,
        });
      }
      return jsonResult({
        guide: slice,
        engineVersion: engineVersion(),
        topic,
        topics: GUIDE_TOPIC_NAMES,
        sections,
      });
    }
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
        lint: z.array(LINT_ISSUE_SHAPE).optional(),
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
        lint: lintStoryboard(parsed.storyboard).issues,
      });
    }
  );

  server.registerTool(
    "lint_storyboard",
    {
      title: "Lint a storyboard (preflight, no browser)",
      description:
        "Browser-free preflight over a storyboard: a per-scene pacing forecast " +
        "(which scenes compose will mostly freeze-hold or cut because the " +
        "narration and the recorded action don't match), selector/wait " +
        "pitfalls (type+Enter with no wait, :text-is on nested labels, focus " +
        "without a zoom block, anchored waitForChange regexes), and no-op keys. " +
        "Run it after every storyboard edit, before probe/render. Pass exactly " +
        "one of dir / path / json. lang lints a narrations[lang] translation at " +
        "that language's speaking rate.",
      inputSchema: {
        dir: z.string().optional().describe("demo dir → generated/storyboard.json"),
        path: z.string().optional().describe("path to a storyboard .json file"),
        json: z.string().optional().describe("storyboard JSON as a string"),
        lang: z.string().optional(),
        params: PARAMS_INPUT,
      },
      outputSchema: {
        issues: z.array(LINT_ISSUE_SHAPE),
        estimate: z.array(
          z.object({
            id: z.string(),
            words: z.number(),
            narrationMs: z.number(),
            actionMs: z.number(),
            holdPct: z.number(),
            overrunMs: z.number(),
          })
        ),
        narrationTotalMs: z.number(),
        wordsPerSec: z.number(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const sources = [args.dir, args.path, args.json].filter((s) => s != null).length;
      if (sources !== 1) {
        return errorResult({ message: "pass exactly one of: dir, path, json" });
      }
      let raw: unknown;
      try {
        raw =
          args.json != null
            ? JSON.parse(args.json)
            : await readJson<unknown>(
                args.path != null
                  ? resolve(args.path)
                  : new Project(args.dir as string).storyboardPath
              );
      } catch (err) {
        return errorResult({ message: (err as Error).message });
      }
      const parsed = parseStoryboard(raw, {
        relaxed: true,
        params: args.params,
        strict: args.params != null,
      });
      if (!parsed.ok) {
        return errorResult({
          message: "storyboard fails schema validation — run validate_storyboard",
          issues: parsed.issues,
        });
      }
      return jsonResult({ ...lintStoryboard(parsed.storyboard, { lang: args.lang }) });
    }
  );

  server.registerTool(
    "init_demo",
    {
      title: "Scaffold a new demo",
      description:
        "Create demos/<name>/ with a starter brief + storyboard. dir is the " +
        "repo to scaffold into (absolute path recommended; default: server cwd). " +
        "With fromUrl the page is inspected first (no LLM): its headings become " +
        "scenes and its unique selectors become the beats + a `_candidates` list — " +
        "you then write the narration and turn the candidate hover into the real click.",
      inputSchema: {
        name: z.string().describe("demo name (creates demos/<name>/)"),
        dir: z.string().optional(),
        force: z.boolean().optional(),
        fromUrl: z.string().optional().describe("draft the storyboard from this live page"),
        headless: z.boolean().optional().describe("fromUrl: run Chrome headless (default true)"),
        profile: z.string().optional().describe("fromUrl: Chrome user-data dir (logged-in pages)"),
        viewport: z
          .object({ width: z.number(), height: z.number() })
          .optional()
          .describe("fromUrl: viewport (default 1280x720)"),
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
        {
          force: args.force,
          fromUrl: args.fromUrl,
          headed: args.headless === false,
          profileDir: args.profile,
          viewport: args.viewport,
        }
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
    args: {
      headless?: boolean;
      profile?: string;
      fresh?: boolean;
      capture?: "playwright" | "native" | "obs";
      storageState?: string;
      cookies?: SeedCookie[];
      profileSeeded?: boolean;
      fromScene?: string;
    },
    job: Job,
    reloadStoryboard?: () => Promise<Storyboard>
  ): RecordOptions {
    return {
      profileDir: args.profile,
      fresh: args.fresh,
      storageState: args.storageState,
      cookies: args.cookies,
      profileSeeded: args.profileSeeded,
      reloadStoryboard,
      headed: !args.headless,
      capture: args.capture,
      fromScene: args.fromScene,
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
        const load = () =>
          project.loadStoryboard({
            relaxed: true,
            params: args.params,
          });
        const storyboard = await load();
        logLint(lintStoryboard(storyboard), log);
        const goldenMode = !!(args.golden || args.updateGolden);
        const probeScenes: ProbeGoldenScene[] = [];
        const timeline = await record(project, storyboard, {
          ...recordOpts(args, job, load),
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
          const actual = buildProbeGolden(storyboard, probeScenes);
          const diffs = diffGolden(expected, actual);
          const drift = diffs.length ? await driftFilesForDiff(project, actual, diffs) : [];
          return {
            ...base,
            golden: {
              path: project.goldenProbePath,
              match: diffs.length === 0,
              diffs,
              // Nearest-selector suggestions for the actions that flipped
              // (logs/drift-<scene>-<n>.json — read them, fix, re-probe).
              ...(drift.length ? { drift } : {}),
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
        const load = () => project.loadStoryboard({ params: args.params });
        const storyboard = await load();
        logLint(lintStoryboard(storyboard), log);
        const timeline = await record(project, storyboard, recordOpts(args, job, load));
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
        const load = () => project.loadStoryboard({ params: args.params });
        const storyboard = await load();
        // Language variant (if any): voice/captions/compose run on a lang-scoped
        // project + localized storyboard; the take is recorded ONCE on the base.
        const lp = langProject(project, args.lang);
        const sb = args.lang ? localizeStoryboard(storyboard, args.lang) : storyboard;
        logLint(lintStoryboard(storyboard, { lang: args.lang }), log);
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
          record(project, storyboard, recordOpts(args, job, load))
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
        const report = await jobs.runSubStage(job, "compose", () =>
          compose(lp, sb, sceneProgress(job))
        );
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
        let walkthrough: string | undefined;
        if (storyboard.output?.walkthrough) {
          walkthrough = (
            await jobs.runSubStage(job, "walkthrough", () => exportWalkthrough(lp, sb))
          ).index;
        }
        return {
          output: lp.outputPath,
          ...(gifPath ? { gif: gifPath } : {}),
          ...(stills && stills.length ? { stills } : {}),
          ...(walkthrough ? { walkthrough } : {}),
          timeline: lp.timelinePath,
          captionsSrt: lp.captionsSrtPath,
          report: lp.reportPath,
          durationMs: report.durationMs,
          warnings: report.warnings,
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
        const report = await compose(lp, sb, sceneProgress(job));
        let gifPath: string | undefined;
        if (args.gif) gifPath = await exportGif(lp);
        return {
          output: lp.outputPath,
          ...(gifPath ? { gif: gifPath } : {}),
          report: lp.reportPath,
          durationMs: report.durationMs,
          warnings: report.warnings,
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

  registerJob(
    "frames",
    "Dump evenly spaced PNG frames from the final video (or the raw take) into " +
      "output/frames/ for review — look at them instead of hand-running " +
      "`ffmpeg -ss`. Needs only the video (no key).",
    {
      dir: DIR_INPUT,
      everySec: z.number().optional().describe("seconds between frames (default 3)"),
      source: z
        .enum(["final", "raw"])
        .optional()
        .describe("final = output/final-demo.mp4 (default); raw = the latest take"),
      width: z.number().optional().describe("frame width in px, aspect kept (default 640)"),
      out: z.string().optional().describe("output directory (default <dir>/output/frames)"),
    },
    (project, args) => async (job) =>
      jobs.runStage(job, "frames", async () => {
        const res = await extractFrames(project, {
          everySec: args.everySec,
          source: args.source,
          width: args.width,
          outDir: args.out,
        });
        return {
          source: res.source,
          durationMs: res.durationMs,
          everySec: res.everySec,
          frames: res.files,
        };
      })
  );

  registerJob(
    "walkthrough",
    "Export output/walkthrough/ from the final video: index.html (one card per " +
      "scene — payoff frame, title, narration, jump-to-time; ← → keyboard nav), " +
      "guide.md (README/SOP-ready), per-scene PNGs, SRT/VTT and a JSON manifest. " +
      "Needs only the rendered video + report.json (no key, no browser).",
    {
      dir: DIR_INPUT,
      lang: z.string().optional().describe("language variant (final-demo.<lang>.mp4)"),
      width: z.number().optional().describe("frame width in px (default 960)"),
      out: z.string().optional().describe("output directory (default <dir>/output/walkthrough)"),
    },
    (project, args) => async (job) =>
      jobs.runStage(job, "walkthrough", async () => {
        const lp = args.lang ? new Project(project.dir, args.lang) : project;
        const storyboard = await project.loadStoryboard({ relaxed: true });
        const sb = args.lang ? localizeStoryboard(storyboard, args.lang) : storyboard;
        const res = await exportWalkthrough(lp, sb, { width: args.width, outDir: args.out });
        return {
          dir: res.dir,
          index: res.index,
          guide: res.guide,
          manifest: res.manifest,
          scenes: res.scenes.length,
        };
      })
  );

  registerJob(
    "inspect",
    "Open a URL in the recording profile (logged-in state included) and list " +
      "every visible interactive element with UNIQUE selectors ranked " +
      "data-testid → id → aria-label → role/text → name/placeholder → class → " +
      "path, plus headings and iframes. Use it BEFORE writing targets — no " +
      "selector guessing, no wasted probe. Writes logs/inspect-<n>.json and a " +
      "screenshot in the demo dir.",
    {
      dir: DIR_INPUT,
      url: z.string().describe("page to inspect (absolute URL)"),
      headless: z.boolean().optional().describe("default true"),
      profile: z.string().optional().describe("Chrome user-data dir (default: the recording profile)"),
      limit: z.number().int().min(5).max(400).optional().describe("max elements (default 80)"),
      viewport: z
        .object({ width: z.number().int(), height: z.number().int() })
        .optional()
        .describe("default 1280x720 (use the storyboard's video size)"),
      frames: z
        .record(z.string(), z.string())
        .optional()
        .describe("iframe selectors to scan too, as in the storyboard `frames` block"),
    },
    (project, args) => async (job) =>
      jobs.runStage(job, "inspect", async () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const png = project.p("logs", `inspect-${stamp}.png`);
        const res = await inspectPage({
          url: args.url,
          headless: args.headless !== false,
          profileDir: args.profile,
          limit: args.limit,
          viewport: args.viewport,
          frames: args.frames,
          screenshotPath: png,
        });
        const file = project.p("logs", `inspect-${stamp}.json`);
        await writeJson(file, res);
        log(`inspect: ${res.elements.length} element(s), ${res.headings.length} heading(s) → ${file}`);
        return { ...res, file };
      })
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
      // Grace for native addons: after a local-TTS job, onnxruntime's worker
      // threads wind down asynchronously, and process.exit mid-teardown
      // aborts with a shutdown-time "libc++abi: mutex lock failed" on macOS
      // (issue #19). Half a second is invisible here — the client is gone.
      await new Promise((r) => setTimeout(r, 500));
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
