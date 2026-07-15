import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { runFfmpeg, probeVideoDims } from "./ffmpeg.js";
import { nativeCropUnsafe } from "./config.js";
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
 * Chrome viewport. Getting that crop right is a PRIVACY property, not just a
 * correctness one — a wrong rectangle ships whatever else is on screen (the
 * desktop, notifications, permission dialogs) into the rendered video. The
 * geometry is therefore measured via CDP `Browser.getWindowBounds` plus real
 * (un-emulated) in-page metrics, re-measured until stable, and sanity-gated
 * against the storyboard viewport before any cropping happens.
 */

export type CaptureMode = "playwright" | "native" | "obs";

export interface CaptureProvider {
  readonly name: string;
  /** Resolves once frames are actually being recorded. */
  start(): Promise<void>;
  /** Stops recording and resolves to the captured file path. */
  stop(): Promise<string>;
}

/** The browser viewport's position on screen, in CSS points (DIP). */
export interface ViewportGeometry {
  /** Real screen size in points — the capture-pixels-per-point scale anchor. */
  screenW: number;
  screenH: number;
  /** Page content area (the viewport) on screen, in points. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Real devicePixelRatio of the display the window is on. */
  dpr: number;
}

interface WindowMetrics {
  screenW: number;
  screenH: number;
  winX: number;
  winY: number;
  outerW: number;
  outerH: number;
  innerW: number;
  innerH: number;
  dpr: number;
}

/**
 * Measure where the page's viewport sits on the screen, in points.
 *
 * The context MUST run without viewport emulation (`viewport: null`): under
 * Playwright's emulation, `window.innerWidth/innerHeight`, `screen.width/
 * height` and `devicePixelRatio` all report the EMULATED values (viewport-
 * sized screen, DPR 1) while `outerWidth`/`screenX` stay real — mixing them
 * produced a wildly wrong physical-per-point scale on Retina displays and
 * cropped the take to the whole screen (issue #13).
 *
 * Approach:
 *   1. CDP `Browser.getWindowBounds` — real window bounds in DIP. Force
 *      `windowState: "normal"` first (a maximized restore from the Chrome
 *      profile ignores --window-position and breaks the inset math).
 *   2. Resize the window (CDP `Browser.setWindowBounds`) until the REAL
 *      content area (innerWidth/innerHeight, un-emulated) equals the
 *      storyboard viewport — normally one iteration.
 *   3. Re-measure after a settle delay until two consecutive measurements
 *      agree (window placement/animation may still be in flight).
 *   4. Content-area origin: side border is (outerWidth-innerWidth)/2, the
 *      top bar (tab strip + toolbar + infobars) is the rest.
 *   5. Sanity-gate the result against the storyboard viewport — on mismatch,
 *      abort BEFORE any screen pixels are recorded (AIDEMO_NATIVE_CROP_UNSAFE=1
 *      downgrades to a loud warning).
 */
export async function measureViewportGeometry(
  page: Page,
  viewport: { width: number; height: number },
  opts: { settleMs?: number; timeoutMs?: number } = {}
): Promise<ViewportGeometry> {
  const settleMs = opts.settleMs ?? 400;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    const getBounds = async () =>
      (await cdp.send("Browser.getWindowBounds", { windowId })).bounds;
    const metrics = (): Promise<WindowMetrics> =>
      page.evaluate(() => ({
        screenW: screen.width,
        screenH: screen.height,
        winX: window.screenX,
        winY: window.screenY,
        outerW: window.outerWidth,
        outerH: window.outerHeight,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        dpr: window.devicePixelRatio,
      }));

    if ((await getBounds()).windowState !== "normal") {
      log("window opened maximized/fullscreen — restoring to normal for capture");
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
      await sleep(settleMs);
    }

    // Converge the real content area onto the storyboard viewport: grow or
    // shrink the outer window by the inner-size delta, keeping it on-screen.
    for (let i = 0; i < 4; i++) {
      const m = await metrics();
      const dw = viewport.width - m.innerW;
      const dh = viewport.height - m.innerH;
      if (dw === 0 && dh === 0) break;
      const b = await getBounds();
      const width = (b.width ?? m.outerW) + dw;
      const height = (b.height ?? m.outerH) + dh;
      const left = Math.max(0, Math.min(b.left ?? m.winX, m.screenW - width));
      const top = Math.max(0, Math.min(b.top ?? m.winY, m.screenH - height));
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left, top, width, height },
      });
      await sleep(settleMs);
    }

    // Measure twice until stable — accept only two identical consecutive reads.
    let prev = { bounds: await getBounds(), m: await metrics() };
    let stable = false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(settleMs);
      const cur = { bounds: await getBounds(), m: await metrics() };
      if (
        cur.bounds.left === prev.bounds.left &&
        cur.bounds.top === prev.bounds.top &&
        cur.bounds.width === prev.bounds.width &&
        cur.bounds.height === prev.bounds.height &&
        cur.bounds.windowState === prev.bounds.windowState &&
        JSON.stringify(cur.m) === JSON.stringify(prev.m)
      ) {
        prev = cur;
        stable = true;
        break;
      }
      prev = cur;
    }

    const { bounds, m } = prev;
    const side = Math.max(0, (m.outerW - m.innerW) / 2);
    const topBar = Math.max(0, m.outerH - m.innerH - side);
    const geo: ViewportGeometry = {
      screenW: m.screenW,
      screenH: m.screenH,
      x: (bounds.left ?? m.winX) + side,
      y: (bounds.top ?? m.winY) + topBar,
      w: m.innerW,
      h: m.innerH,
      dpr: m.dpr,
    };
    log(
      `window geometry: screen ${geo.screenW}x${geo.screenH}pt dpr ${geo.dpr}, ` +
        `window ${bounds.width}x${bounds.height}+${bounds.left}+${bounds.top} ` +
        `(${bounds.windowState}), viewport ${geo.w}x${geo.h}+${Math.round(geo.x)}+${Math.round(geo.y)}pt`
    );

    const problems: string[] = [];
    if (!stable) {
      problems.push(
        `window geometry did not stabilize within ${timeoutMs}ms (placement animation or another process moving the window?)`
      );
    }
    const tol = 4; // points of window-chrome rounding slack
    if (
      Math.abs(geo.w - viewport.width) > tol ||
      Math.abs(geo.h - viewport.height) > tol
    ) {
      problems.push(
        `measured content area ${geo.w}x${geo.h}pt does not match the storyboard viewport ` +
          `${viewport.width}x${viewport.height} (is the screen large enough for the window?)`
      );
    }
    if (
      geo.x < 0 ||
      geo.y < 0 ||
      geo.x + geo.w > geo.screenW + tol ||
      geo.y + geo.h > geo.screenH + tol
    ) {
      problems.push(
        `viewport rect ${geo.w}x${geo.h}+${Math.round(geo.x)}+${Math.round(geo.y)}pt extends beyond ` +
          `the ${geo.screenW}x${geo.screenH}pt screen`
      );
    }
    gateGeometryProblems(
      problems,
      "Refusing to start the screen capture: the browser-window geometry is not safe to crop."
    );
    return geo;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Enforce the crop-geometry sanity gate. A wrong crop silently ships whatever
 * else is on screen into a rendered video, so mismatches ABORT by default;
 * AIDEMO_NATIVE_CROP_UNSAFE=1 downgrades the abort to a loud warning.
 */
function gateGeometryProblems(problems: string[], headline: string): void {
  if (problems.length === 0) return;
  const detail = problems.map((p) => `  - ${p}`).join("\n");
  if (nativeCropUnsafe()) {
    log(`⚠⚠⚠ AIDEMO_NATIVE_CROP_UNSAFE=1 — continuing despite unsafe capture geometry:`);
    for (const p of problems) log(`⚠ ${p}`);
    log(`⚠ the resulting video may contain your desktop — frame-review it before publishing`);
    return;
  }
  throw new Error(
    `${headline}\n${detail}\n` +
      `A wrong crop ships whatever else is on screen — your desktop, notifications, ` +
      `other windows — into the rendered video (privacy risk, see issue #13). ` +
      `Make sure the screen is large enough for the storyboard viewport and the ` +
      `browser window sits fully on the captured display, then re-record. ` +
      `Set AIDEMO_NATIVE_CROP_UNSAFE=1 to downgrade this error to a warning and ` +
      `record anyway — if you do, frame-review the take before publishing.`
  );
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
 *
 * Before cropping, the computed rectangle is sanity-gated against the
 * storyboard viewport (DPR-aware): if the crop doesn't match, the whole run
 * ABORTS instead of shipping a mis-cropped — potentially desktop-leaking —
 * video (AIDEMO_NATIVE_CROP_UNSAFE=1 downgrades to a loud warning). On abort
 * the un-cropped full-screen capture is left at `src` for inspection.
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
  const ratioH = capH / geo.screenH;
  const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
  const rawCw = even(geo.w * ratio);
  const rawCh = even(geo.h * ratio);
  const rawCx = Math.round(geo.x * ratio);
  const rawCy = Math.round(geo.y * ratio);

  // Sanity gate: the crop must be exactly the storyboard viewport, scaled by
  // the physical-per-point ratio, and must fall fully inside the capture.
  const problems: string[] = [];
  const tolX = Math.max(8, Math.round(logicalW * ratio * 0.02));
  const tolY = Math.max(8, Math.round(logicalH * ratio * 0.02));
  if (Math.abs(ratio - ratioH) > ratio * 0.02) {
    problems.push(
      `capture ${capW}x${capH} is not a uniform scale of the ${geo.screenW}x${geo.screenH}pt ` +
        `screen (x${ratio.toFixed(3)} vs x${ratioH.toFixed(3)}) — is the capture device a different display?`
    );
  }
  if (Math.abs(ratio - geo.dpr) > geo.dpr * 0.05) {
    problems.push(
      `capture scale x${ratio.toFixed(3)} does not match the window's devicePixelRatio ` +
        `${geo.dpr} — the browser window may sit on a different display than the one being captured`
    );
  }
  if (
    Math.abs(rawCw - logicalW * ratio) > tolX ||
    Math.abs(rawCh - logicalH * ratio) > tolY
  ) {
    problems.push(
      `crop ${rawCw}x${rawCh} does not match the storyboard viewport ${logicalW}x${logicalH} ` +
        `at capture scale x${ratio.toFixed(3)} (expected ~${Math.round(logicalW * ratio)}x${Math.round(
          logicalH * ratio
        )})`
    );
  }
  if (
    rawCx < -tolX ||
    rawCy < -tolY ||
    rawCx + rawCw > capW + tolX ||
    rawCy + rawCh > capH + tolY
  ) {
    problems.push(
      `crop ${rawCw}x${rawCh}+${rawCx}+${rawCy} falls outside the ${capW}x${capH} capture`
    );
  }
  gateGeometryProblems(
    problems,
    `Refusing to crop the screen capture: the crop rectangle does not match the ` +
      `storyboard viewport. The un-cropped full-screen capture was kept at ${src} — ` +
      `review or delete it (it may show your whole desktop).`
  );

  const cw = Math.min(rawCw, capW);
  const ch = Math.min(rawCh, capH);
  const cx = Math.min(Math.max(0, rawCx), capW - cw);
  const cy = Math.min(Math.max(0, rawCy), capH - ch);
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
