import { promises as fs } from "node:fs";
import { join } from "node:path";
import { exec } from "./exec.js";
import { log } from "../util.js";

/**
 * Maestro runs the caller's flows; its debug output (`commands-*.json`) gives
 * every command's start time and duration, which become the scene's marks —
 * the native counterpart of the browser timeline. A flow step's `label:`
 * names a mark so the store edit can ramp or hold it.
 */

export interface MaestroCommandTiming {
  command: string;
  label?: string;
  /** Epoch ms. */
  startMs: number;
  endMs: number;
  status?: string;
}

interface RawEntry {
  command?: Record<string, { label?: string } & Record<string, unknown>>;
  metadata?: { status?: string; timestamp?: number; duration?: number };
}

/** Parse one `commands-(flow).json` file. Commands without timing are skipped. */
export function parseMaestroCommands(json: string): MaestroCommandTiming[] {
  const entries = JSON.parse(json) as RawEntry[];
  const out: MaestroCommandTiming[] = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const key = e.command ? Object.keys(e.command)[0] : undefined;
    const ts = e.metadata?.timestamp;
    if (!key || typeof ts !== "number") continue;
    const body = e.command![key] ?? {};
    const dur = typeof e.metadata?.duration === "number" ? e.metadata.duration : 0;
    out.push({
      command: key.replace(/Command$/, ""),
      label: typeof body.label === "string" ? body.label : undefined,
      startMs: ts,
      endMs: ts + dur,
      status: e.metadata?.status,
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

export function maestroBin(): string {
  return process.env.AIDEMO_MAESTRO ?? "maestro";
}

/**
 * Run one flow on `deviceId`. Resolves the command timings (epoch ms).
 * Rejects with Maestro's output tail when the flow fails — a failed step is a
 * failed take, never a silently different video.
 */
export async function runMaestroFlow(opts: {
  flow: string;
  deviceId: string;
  env: Record<string, string>;
  debugDir: string;
  signal?: AbortSignal;
}): Promise<MaestroCommandTiming[]> {
  await fs.rm(opts.debugDir, { recursive: true, force: true });
  await fs.mkdir(opts.debugDir, { recursive: true });
  const args = [
    "test",
    "--device", opts.deviceId,
    "--no-ansi",
    "--debug-output", opts.debugDir,
    "--flatten-debug-output",
    ...Object.entries(opts.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    opts.flow,
  ];
  log(`maestro test ${opts.flow}`);
  await exec(maestroBin(), args, { timeoutMs: 15 * 60 * 1000, signal: opts.signal, env: { ...process.env, MAESTRO_CLI_NO_ANALYTICS: "1" } });
  const files = (await listFiles(opts.debugDir)).filter((f) => /commands-.*\.json$/.test(f));
  const timings: MaestroCommandTiming[] = [];
  for (const f of files) timings.push(...parseMaestroCommands(await fs.readFile(f, "utf8")));
  if (!timings.length) log(`warning: no Maestro command timings in ${opts.debugDir} — labels/commands can't be resolved`);
  return timings.sort((a, b) => a.startMs - b.startMs);
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else out.push(p);
  }
  return out;
}
