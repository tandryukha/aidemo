import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import { join } from "node:path";
import type { Project } from "../project.js";
import { withLogSinks, CanceledError, type LogSink } from "../util.js";

/**
 * In-memory job manager for the MCP server. Pipeline operations (probe,
 * record, render, voice, captions, compose, gif) run for seconds to minutes —
 * far past typical MCP client tool timeouts — so each runs as a background
 * job whose id is returned immediately; agents poll job_status.
 *
 * One long job runs at a time (reject-when-busy, no queue): record-class jobs
 * are physically exclusive anyway (one Chrome profile lock, recordings-dir
 * cleanup at start), and a single slot also serializes same-demo stage
 * collisions predictably. Job history lives in server memory only — after a
 * server restart, artifacts remain under <demoDir>/logs/.
 */

export type JobKind =
  | "probe"
  | "record"
  | "render"
  | "voice"
  | "captions"
  | "compose"
  | "gif"
  | "stills";

export type JobStatus = "running" | "succeeded" | "failed" | "canceled";

export interface JobError {
  message: string;
  stage: string;
  failureArtifacts: string[];
  logFile: string;
  salvaged?: { scenes: number; timeline: string };
}

export interface Job {
  jobId: string;
  kind: JobKind;
  demoDir: string;
  status: JobStatus;
  /** Current pipeline stage (render advances voice→record→captions→compose). */
  stage: string;
  scenesTotal: number | null;
  scenesDone: number;
  currentScene: string | null;
  startedAt: Date;
  endedAt: Date | null;
  logFile: string;
  /** Last RING_MAX ANSI-stripped log lines. */
  ring: string[];
  result: unknown;
  error: JobError | null;
  controller: AbortController;
}

export class JobBusyError extends Error {
  constructor(
    public readonly runningJobId: string,
    message: string
  ) {
    super(message);
    this.name = "JobBusyError";
  }
}

const RING_MAX = 200;

export class JobManager {
  private jobs = new Map<string, Job>();
  private activeId: string | null = null;

  /** Best-effort per-line forwarding (e.g. MCP logging notifications). */
  onLine?: (job: Job, cleanChunk: string) => void;

  /** Start a job or throw JobBusyError if one is already running. */
  startJob(
    kind: JobKind,
    project: Project,
    runner: (job: Job) => Promise<unknown>
  ): Job {
    const running = this.running();
    if (running) {
      throw new JobBusyError(
        running.jobId,
        `job ${running.jobId} (${running.kind} ${running.demoDir}) is still ` +
          `running — poll job_status or job_cancel it`
      );
    }
    const job: Job = {
      jobId: randomUUID(),
      kind,
      demoDir: project.dir,
      status: "running",
      stage: kind,
      scenesTotal: null,
      scenesDone: 0,
      currentScene: null,
      startedAt: new Date(),
      endedAt: null,
      logFile: join(project.dir, "logs", `${kind}.log`),
      ring: [],
      result: null,
      error: null,
      controller: new AbortController(),
    };
    this.jobs.set(job.jobId, job);
    this.activeId = job.jobId;
    void this.execute(job, runner);
    return job;
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  running(): Job | null {
    const active = this.activeId ? this.jobs.get(this.activeId) : undefined;
    return active && active.status === "running" ? active : null;
  }

  /** Request cancellation; the job settles asynchronously (best-effort). */
  cancel(jobId: string): Job | undefined {
    const job = this.jobs.get(jobId);
    if (job && job.status === "running") job.controller.abort();
    return job;
  }

  /** Abort the active job (server shutdown). Returns true if one was running. */
  abortActive(): boolean {
    const running = this.running();
    if (!running) return false;
    running.controller.abort();
    return true;
  }

  /** Wait until no job is running, up to timeoutMs (shutdown grace). */
  async waitForIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.running() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /**
   * Run one pipeline stage of a job: names the stage, tees its log output to
   * <demoDir>/logs/<stage>.log (same names the CLI uses, so `aidemo feedback`
   * log-tailing and humans keep working) and into the job's ring buffer.
   */
  async runStage<T>(job: Job, stage: string, fn: () => Promise<T>): Promise<T> {
    job.stage = stage;
    job.logFile = join(job.demoDir, "logs", `${stage}.log`);
    const stream = createWriteStream(job.logFile, { flags: "w" });
    stream.on("error", () => {});
    const sinks: LogSink[] = [
      (s) => void stream.write(s),
      (s) => this.pushRing(job, s),
    ];
    try {
      return await withLogSinks(sinks, fn);
    } finally {
      await new Promise<void>((res) => stream.end(res));
    }
  }

  /** Public status shape returned by the job_status/job_list tools. */
  statusOf(job: Job, tailLines = 40): Record<string, unknown> {
    return {
      jobId: job.jobId,
      kind: job.kind,
      demoDir: job.demoDir,
      status: job.status,
      stage: job.stage,
      scenesTotal: job.scenesTotal,
      scenesDone: job.scenesDone,
      currentScene: job.currentScene,
      startedAt: job.startedAt.toISOString(),
      endedAt: job.endedAt ? job.endedAt.toISOString() : null,
      logFile: job.logFile,
      logTail: job.ring.slice(-Math.max(0, tailLines)),
      ...(job.result != null ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  private async execute(job: Job, runner: (job: Job) => Promise<unknown>) {
    try {
      job.result = await runner(job);
      job.status = "succeeded";
    } catch (err) {
      job.status =
        err instanceof CanceledError || job.controller.signal.aborted
          ? "canceled"
          : "failed";
      job.error = await this.describeFailure(job, err as Error);
    } finally {
      job.endedAt = new Date();
      if (this.activeId === job.jobId) this.activeId = null;
    }
  }

  private async describeFailure(job: Job, err: Error): Promise<JobError> {
    // Failure artifacts this run produced (player writes fail-<scene>-<n>.*);
    // the mtime filter excludes stale artifacts from earlier runs.
    const logsDir = join(job.demoDir, "logs");
    const failureArtifacts: string[] = [];
    try {
      for (const f of await fs.readdir(logsDir)) {
        if (!/^fail-.*\.(png|json)$/.test(f)) continue;
        const p = join(logsDir, f);
        const st = await fs.stat(p).catch(() => null);
        if (st && st.mtimeMs >= job.startedAt.getTime()) failureArtifacts.push(p);
      }
    } catch {
      // no logs dir — nothing to collect
    }
    let salvaged: JobError["salvaged"];
    if (job.kind === "probe" || job.kind === "record" || job.kind === "render") {
      const timeline = join(job.demoDir, "generated", "timeline.json");
      const st = await fs.stat(timeline).catch(() => null);
      if (st && st.mtimeMs >= job.startedAt.getTime() && job.scenesDone > 0) {
        salvaged = { scenes: job.scenesDone, timeline };
      }
    }
    return {
      message: err.message,
      stage: job.stage,
      failureArtifacts,
      logFile: job.logFile,
      ...(salvaged ? { salvaged } : {}),
    };
  }

  private pushRing(job: Job, chunk: string) {
    for (const raw of chunk.split("\n")) {
      const line = raw.trimEnd();
      if (line.trim()) job.ring.push(line);
    }
    if (job.ring.length > RING_MAX) {
      job.ring.splice(0, job.ring.length - RING_MAX);
    }
    this.onLine?.(job, chunk);
  }
}
