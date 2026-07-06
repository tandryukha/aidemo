import { promises as fs, createWriteStream, type WriteStream } from "node:fs";
import { dirname } from "node:path";

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

function emit(s: string): void {
  process.stderr.write(s);
  logStream?.write(s.replace(ANSI_RE, ""));
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
