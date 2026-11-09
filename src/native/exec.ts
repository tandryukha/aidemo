import { spawn, type SpawnOptions } from "node:child_process";

/** Run a command to completion; resolves stdout, rejects with the stderr tail. */
export function exec(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; input?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; encoding?: "utf8" | "buffer" } = {}
): Promise<string> {
  return execBuffer(bin, args, opts).then((b) => b.toString("utf8"));
}

export function execBuffer(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; input?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = { stdio: ["pipe", "pipe", "pipe"], env: opts.env ?? process.env };
    const proc = spawn(bin, args, spawnOpts);
    const chunks: Buffer[] = [];
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => proc.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        proc.kill("SIGTERM");
        stderr += `\n(timed out after ${opts.timeoutMs} ms)`;
      }, opts.timeoutMs);
    }
    proc.stdout!.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(
        (e as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${bin} not found on PATH`) : e
      );
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(Buffer.concat(chunks));
      else
        reject(
          new Error(
            `${bin} ${args.slice(0, 4).join(" ")}… exited ${code}\n${(stderr + Buffer.concat(chunks).toString())
              .trim()
              .split("\n")
              .slice(-20)
              .join("\n")}`
          )
        );
    });
    if (opts.input != null) proc.stdin!.end(opts.input);
    else proc.stdin!.end();
  });
}

/** True when `bin` can be spawned (`bin --version`-style probe). */
export async function hasBinary(bin: string, args: string[] = ["--version"]): Promise<boolean> {
  try {
    await exec(bin, args, { timeoutMs: 15000 });
    return true;
  } catch {
    return false;
  }
}
