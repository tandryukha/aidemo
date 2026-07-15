import { promises as fs, createWriteStream, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

// Optional native log tee: when a command sets a log file, everything emitted
// through log/step/ok/fail is mirrored (ANSI-stripped) into logs/<cmd>.log as
// well as stderr. This makes `aidemo record` self-log without a fragile
// `| tee record.log` (which also masks the exit code — see the CLI docs).
let logStream: WriteStream | null = null;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Mirror all subsequent log output into `path` (truncating it). Best-effort. */
export function setLogFile(path: string): void {
  try {
    logStream = createWriteStream(path, { flags: "w" });
    logStream.on("error", () => (logStream = null));
  } catch {
    logStream = null;
  }
}

/** Flush and close the log file, if any. Await before process.exit(). */
export async function closeLogFile(): Promise<void> {
  const s = logStream;
  logStream = null;
  if (!s) return;
  await new Promise<void>((res) => s.end(res));
}

/** A per-job log sink receiving every ANSI-stripped emitted chunk. */
export type LogSink = (clean: string) => void;
const logSinks = new AsyncLocalStorage<LogSink[]>();

/**
 * Run `fn` with additional log sinks that receive everything emitted through
 * log/step/ok/fail — scoped to fn's async chain, so concurrent runs (MCP jobs
 * vs. sync tool calls) don't interleave each other's log files. The CLI's
 * setLogFile singleton is unaffected. Composes with any sinks already active
 * (additive, not a replace) so a stage nested inside a composite command
 * (e.g. the `render` job's voice/record/captions/compose sub-stages) still
 * feeds the outer command's log/ring buffer while ALSO getting its own sink.
 * Known blind spot: a line emitted from a detached event-loop callback (not
 * awaited inside fn) misses the sinks and goes to stderr only.
 */
export function withLogSinks<T>(sinks: LogSink[], fn: () => Promise<T>): Promise<T> {
  const outer = logSinks.getStore();
  return logSinks.run(outer ? [...outer, ...sinks] : sinks, fn);
}

/**
 * Tee subsequent log/step/ok/fail output into a freshly truncated file at
 * `path`, composed with whatever log sinks (or the CLI's global log file) are
 * already active. Used so a stage driven from inside a composite command —
 * CLI `render`; the MCP `render` job — still refreshes its OWN stable
 * logs/<stage>.log, not just the composite command's log. Fixes stale
 * `logs/<command>.log` lines fooling log-watchers into probing half-written
 * output (a poller sees an old `✓ final video → …` line from a previous
 * standalone `compose` run while the current `render` is still composing).
 */
export async function teeStageLog<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const stream = createWriteStream(path, { flags: "w" });
  stream.on("error", () => {});
  try {
    return await withLogSinks([(s) => void stream.write(s)], fn);
  } finally {
    await new Promise<void>((res) => stream.end(res));
  }
}

/**
 * Per-scene progress hooks, shared by every stage that loops over scenes
 * (voice, captions, compose, and record's own RecordOptions) — the MCP job
 * model wires these into job.currentScene/scenesTotal/scenesDone so pollers
 * get structured progress instead of only a log tail.
 */
export interface SceneProgress {
  onSceneStart?: (sceneId: string, index: number, total: number) => void;
  onSceneComplete?: (sceneId: string, index: number, total: number) => void;
}

/** Thrown when a run is canceled via an AbortSignal (e.g. MCP job_cancel). */
export class CanceledError extends Error {
  constructor(msg = "canceled") {
    super(msg);
    this.name = "CanceledError";
  }
}

function emit(s: string): void {
  process.stderr.write(s);
  const clean = s.replace(ANSI_RE, "");
  logStream?.write(clean);
  const extra = logSinks.getStore();
  if (extra) {
    for (const sink of extra) {
      try {
        sink(clean);
      } catch {
        // a broken sink must never break a pipeline stage
      }
    }
  }
}

export function log(msg: string): void {
  emit(`  ${msg}\n`);
}

export function step(msg: string): void {
  emit(`\n▶ ${msg}\n`);
}

export function ok(msg: string): void {
  emit(`  ✓ ${msg}\n`);
}

/** Emit a failure line (also captured in the log file). */
export function fail(msg: string): void {
  emit(`\n✗ ${msg}\n`);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** easeInOutCubic — smooth acceleration/deceleration for cursor motion. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** easeOutCubic — fast start, soft landing (the "snappy" scroll feel). */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** easeInOutSine — gentle drift for long cinematic scrolls. */
export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await fs.writeFile(path, JSON.stringify(data, null, 2) + "\n");
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await fs.readFile(path, "utf8")) as T;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/** Format milliseconds as an SRT timestamp: HH:MM:SS,mmm */
export function srtTime(ms: number): string {
  const clamped = Math.max(0, ms);
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const millis = Math.floor(clamped % 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}
