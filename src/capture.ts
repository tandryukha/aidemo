import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { runFfmpeg, probeVideoDims } from "./ffmpeg.js";
import { log, sleep } from "./util.js";

/**
 * Higher-fidelity capture paths. Playwright's built-in recordVideo is a CDP
 * screencast — variable frame pacing and softer rendering. These providers
 * record the REAL screen instead (retina pixels, GPU-composited animation):
 *
 *   native  — ffmpeg's avfoundation screen grab (macOS, zero extra software)
 *   obs     — OBS Studio via obs-websocket v5 (any OS OBS supports)
 *
 * Both record the full screen; the recorder then crops the capture to the
 * Chrome viewport using window geometry measured from the page itself.
 */

export type CaptureMode = "playwright" | "native" | "obs";

export interface CaptureProvider {
  readonly name: string;
  /** Resolves once frames are actually being recorded. */
  start(): Promise<void>;
  /** Stops recording and resolves to the captured file path. */
  stop(): Promise<string>;
}

/** The browser viewport's position on screen, in CSS points. */
export interface ViewportGeometry {
  screenW: number;
  screenH: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Measure where the page's viewport sits on the screen. Standard trick: the
 * window chrome's side border is (outerWidth-innerWidth)/2 and the top bar is
 * what remains of (outerHeight-innerHeight).
 */
export async function viewportGeometry(page: Page): Promise<ViewportGeometry> {
  const g = await page.evaluate(() => ({
    screenW: screen.width,
    screenH: screen.height,
    winX: window.screenX,
    winY: window.screenY,
    outerW: window.outerWidth,
    outerH: window.outerHeight,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
  }));
  const border = Math.max(0, (g.outerW - g.innerW) / 2);
  return {
    screenW: g.screenW,
    screenH: g.screenH,
    x: g.winX + border,
    y: g.winY + (g.outerH - g.innerH) - border,
    w: g.innerW,
    h: g.innerH,
  };
}

// ---------------------------------------------------------------------------
// native: ffmpeg avfoundation (macOS)
// ---------------------------------------------------------------------------

export class AvfoundationCapture implements CaptureProvider {
  readonly name: string;
  private proc: ChildProcess | null = null;
  private stderr = "";
  private exited: number | null = null;

  constructor(
    private outFile: string,
    private device: string,
    private fps = 30
  ) {
    if (process.platform !== "darwin") {
      throw new Error(
        `--capture native uses ffmpeg's avfoundation input, which only exists on ` +
          `macOS (this is ${process.platform}). Use --capture obs (OBS Studio + ` +
          `obs-websocket, any OS) for high-fidelity capture, or the default ` +
          `Playwright capture.`
      );
    }
    this.name = `native screen capture (avfoundation "${device}")`;
  }

  async start(): Promise<void> {
    await fs.rm(this.outFile, { force: true });
    // Matroska container: stays playable even if the process dies uncleanly.
    // capture_cursor=0 — the demo cursor is the injected in-page one; the real
    // (motionless) macOS cursor would just sit in the frame.
    this.proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "info",
        "-y",
        "-f",
        "avfoundation",
        "-framerate",
        String(this.fps),
        "-capture_cursor",
        "0",
        "-i",
        `${this.device}:none`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        this.outFile,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    this.proc.stderr!.on("data", (d) => (this.stderr += d.toString()));
    this.proc.on("close", (code) => (this.exited = code ?? -1));

    // Consider capture "rolling" once the output file grows between polls.
    const deadline = Date.now() + 15000;
    let lastSize = -1;
    for (;;) {
      if (this.exited !== null) {
        throw new Error(
          `Screen capture failed to start (ffmpeg exited ${this.exited}).\n` +
            `On macOS, grant your terminal Screen Recording permission ` +
            `(System Settings → Privacy & Security), and check the device name ` +
            `(AIDEMO_CAPTURE_DEVICE; list with: ffmpeg -f avfoundation -list_devices true -i "").\n` +
            this.stderr.split("\n").slice(-8).join("\n")
        );
      }
      const size = await fs.stat(this.outFile).then((s) => s.size).catch(() => -1);
      if (size > 0 && lastSize > 0 && size > lastSize) break;
      lastSize = size;
      if (Date.now() > deadline) {
        this.proc.kill("SIGKILL");
        throw new Error("Screen capture did not start within 15s.");
      }
      await sleep(200);
    }
    log(`screen capture rolling → ${this.outFile}`);
  }

  async stop(): Promise<string> {
    const proc = this.proc;
    if (!proc) throw new Error("Capture was never started.");
    if (this.exited === null) {
      proc.kill("SIGINT"); // graceful: ffmpeg flushes and finalizes
      const deadline = Date.now() + 10000;
      while (this.exited === null && Date.now() < deadline) await sleep(100);
      if (this.exited === null) proc.kill("SIGKILL");
    }
    return this.outFile;
  }
}

// ---------------------------------------------------------------------------
// obs: OBS Studio via obs-websocket v5
// ---------------------------------------------------------------------------

interface ObsPending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Minimal obs-websocket v5 client on Node's global WebSocket (Node 22+).
 * Assumes the current OBS scene captures the FULL primary display (Display
 * Capture) — the recorder crops to the viewport afterwards, same as native.
 */
export class ObsCapture implements CaptureProvider {
  readonly name: string;
  private ws: WebSocket | null = null;
  private pending = new Map<string, ObsPending>();
  private nextId = 1;

  constructor(
    private url: string,
    private password?: string
  ) {
    this.name = `OBS (obs-websocket at ${url})`;
  }

  async start(): Promise<void> {
    if (typeof WebSocket === "undefined") {
      throw new Error(
        "OBS capture needs Node 22+ (built-in WebSocket). Use --capture native instead."
      );
    }
    await this.connect();
    await this.request("StartRecord", {});
    await sleep(500); // let OBS write its first frames
    log("OBS recording started");
  }

  async stop(): Promise<string> {
    const data = (await this.request("StopRecord", {})) as {
      outputPath?: string;
    };
    this.ws?.close();
    const path = data?.outputPath;
    if (!path) throw new Error("OBS StopRecord returned no outputPath.");
    // Wait for OBS to finish writing the file (size stable across polls).
    let lastSize = -1;
    for (let i = 0; i < 50; i++) {
      const size = await fs.stat(path).then((s) => s.size).catch(() => -1);
      if (size > 0 && size === lastSize) break;
      lastSize = size;
      await sleep(200);
    }
    return path;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onerror = () =>
        reject(
          new Error(
            `Could not reach obs-websocket at ${this.url}. Is OBS running with ` +
              `the WebSocket server enabled (Tools → WebSocket Server Settings)?`
          )
        );
      ws.onmessage = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.op === 0) {
          // Hello → Identify (with auth when a challenge is present)
          const auth = msg.d.authentication
            ? obsAuth(this.password ?? "", msg.d.authentication)
            : undefined;
          ws.send(
            JSON.stringify({
              op: 1,
              d: { rpcVersion: 1, ...(auth ? { authentication: auth } : {}) },
            })
          );
        } else if (msg.op === 2) {
          resolve(); // Identified
        } else if (msg.op === 7) {
          const p = this.pending.get(msg.d.requestId);
          if (!p) return;
          this.pending.delete(msg.d.requestId);
          if (msg.d.requestStatus?.result) p.resolve(msg.d.responseData ?? {});
          else
            p.reject(
              new Error(
                `OBS ${msg.d.requestType} failed: ${msg.d.requestStatus?.comment ?? "unknown"}`
              )
            );
        }
      };
      ws.onclose = () => {
        const err = new Error(
          "obs-websocket connection closed (wrong AIDEMO_OBS_PASSWORD?)"
        );
        reject(err);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      };
    });
  }

  private request(requestType: string, requestData: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("OBS not connected"));
    const requestId = `r${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }
}

/** obs-websocket v5 auth: b64(sha256(b64(sha256(pw+salt)) + challenge)). */
function obsAuth(
  password: string,
  { challenge, salt }: { challenge: string; salt: string }
): string {
  const secret = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(secret + challenge).digest("base64");
}

// ---------------------------------------------------------------------------
// shared post-processing
// ---------------------------------------------------------------------------

/**
 * Crop a full-screen capture down to the browser viewport and normalize it
 * for compose. Retina screens yield ~2x the storyboard's logical size — that
 * density is kept (output at 2x) so the extra fidelity survives; compose is
 * resolution-aware and scales captions/cards/zoom to match.
 */
export async function cropCaptureToViewport(
  src: string,
  dst: string,
  geo: ViewportGeometry,
  logicalW: number,
  logicalH: number,
  fps: number
): Promise<void> {
  const { width: capW, height: capH } = await probeVideoDims(src);
  const ratio = capW / geo.screenW; // physical px per CSS point
  const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
  const cw = Math.min(even(geo.w * ratio), capW);
  const ch = Math.min(even(geo.h * ratio), capH);
  const cx = Math.min(Math.max(0, Math.round(geo.x * ratio)), capW - cw);
  const cy = Math.min(Math.max(0, Math.round(geo.y * ratio)), capH - ch);
  const outScale = cw >= logicalW * 1.9 ? 2 : 1;
  log(
    `capture ${capW}x${capH} → crop ${cw}x${ch}+${cx}+${cy} → ` +
      `${logicalW * outScale}x${logicalH * outScale}`
  );
  await runFfmpeg([
    "-i",
    src,
    "-vf",
    `crop=${cw}:${ch}:${cx}:${cy},` +
      `scale=${logicalW * outScale}:${logicalH * outScale}:flags=lanczos,setsar=1`,
    "-an",
    "-r",
    String(fps),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    dst,
  ]);
}
