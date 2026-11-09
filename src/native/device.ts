import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec, execBuffer } from "./exec.js";
import { readImageHeader } from "../store/validate.js";
import { log, sleep } from "../util.js";
import type { NativeStep } from "../types.js";

/**
 * Device adapters for native capture: the iOS Simulator (`xcrun simctl`, taps
 * through `idb` when installed) and the Android emulator (`adb`, `emulator`).
 * The engine never boots a device unless asked (`--boot`), and shuts down only
 * what it booted. Parsers are exported for the unit tests.
 */

export type Platform = "ios" | "android";

export interface Recording {
  /** Epoch ms of the recorder's first frame (best estimate). */
  readonly startedAtMs: number;
  /** Stop and resolve to the local file. */
  stop(): Promise<string>;
}

export interface Device {
  platform: Platform;
  id: string;
  name: string;
  /** Booted by this run — `release()` shuts it down. */
  bootedByUs: boolean;
  screenSize(): Promise<{ width: number; height: number }>;
  startRecording(file: string): Promise<Recording>;
  screenshot(file: string): Promise<void>;
  runStep(step: NativeStep): Promise<void>;
  /** Clean status bar + appearance; returns an undo. */
  prepare(opts: { cleanStatusBar: boolean; appearance?: "light" | "dark" }): Promise<() => Promise<void>>;
  release(): Promise<void>;
}

// ---------------------------------------------------------------------------
// iOS Simulator
// ---------------------------------------------------------------------------

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  isAvailable?: boolean;
}

/** Parse `xcrun simctl list devices -j`. */
export function parseSimctlDevices(json: string): SimDevice[] {
  const data = JSON.parse(json) as { devices?: Record<string, Array<Omit<SimDevice, "runtime">>> };
  const out: SimDevice[] = [];
  for (const [runtime, list] of Object.entries(data.devices ?? {})) {
    for (const d of list) out.push({ ...d, runtime });
  }
  return out;
}

/** Pick the simulator: by UDID or exact name, else the only booted iOS device. */
export function pickSimulator(devices: SimDevice[], id?: string): SimDevice {
  const ios = devices.filter((d) => /iOS/i.test(d.runtime) && d.isAvailable !== false);
  if (id) {
    const hit = ios.find((d) => d.udid === id) ?? ios.filter((d) => d.name === id).sort(bootedFirst)[0];
    if (!hit) throw new Error(`no iOS simulator with UDID or name "${id}" (xcrun simctl list devices)`);
    return hit;
  }
  const booted = ios.filter((d) => d.state === "Booted");
  if (booted.length === 1) return booted[0];
  if (!booted.length)
    throw new Error("no booted iOS simulator — boot one, or set device.id and pass --boot");
  throw new Error(
    `${booted.length} booted iOS simulators — set device.id (or --device) to one of: ` +
      booted.map((d) => `${d.name} (${d.udid})`).join(", ")
  );
}

function bootedFirst(a: SimDevice, b: SimDevice): number {
  return Number(b.state === "Booted") - Number(a.state === "Booted");
}

async function haveIdb(): Promise<boolean> {
  try {
    await exec("idb", ["--help"], { timeoutMs: 10000 });
    return true;
  } catch {
    return false;
  }
}

class IosSimulator implements Device {
  readonly platform = "ios" as const;
  constructor(
    readonly id: string,
    readonly name: string,
    readonly bootedByUs: boolean
  ) {}

  async screenSize() {
    const buf = await execBuffer("xcrun", ["simctl", "io", this.id, "screenshot", "--type=png", "-"], { timeoutMs: 30000 });
    const h = readImageHeader(buf);
    return { width: h.width, height: h.height };
  }

  async startRecording(file: string): Promise<Recording> {
    await fs.rm(file, { force: true });
    const proc = spawn("xcrun", ["simctl", "io", this.id, "recordVideo", "--codec=h264", "--force", file], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const startedAtMs = await waitForLine(proc, /Recording started/i, 20000, "simctl recordVideo");
    return {
      startedAtMs,
      stop: async () => {
        await stopProcess(proc, "SIGINT", 30000);
        if (!existsSync(file)) throw new Error(`simctl recordVideo wrote no file at ${file}`);
        return file;
      },
    };
  }

  async screenshot(file: string) {
    await exec("xcrun", ["simctl", "io", this.id, "screenshot", "--type=png", file], { timeoutMs: 30000 });
  }

  async runStep(step: NativeStep) {
    switch (step.op) {
      case "wait":
        return sleep(step.ms);
      case "openUrl":
        await exec("xcrun", ["simctl", "openurl", this.id, step.url], { timeoutMs: 30000 });
        return;
      case "launch":
        await exec(
          "xcrun",
          ["simctl", "launch", ...(step.relaunch ? ["--terminate-running-process"] : []), this.id, step.appId, ...(step.args ?? [])],
          { timeoutMs: 60000 }
        );
        return;
      case "terminate":
        await exec("xcrun", ["simctl", "terminate", this.id, step.appId], { timeoutMs: 30000 }).catch(() => {});
        return;
      default: {
        // simctl has no input injection; idb (fb-idb) does.
        if (!(await haveIdb()))
          throw new Error(
            `iOS step "${step.op}" needs idb (brew install facebook/fb/idb-companion && pipx install fb-idb) — or drive the scene with a Maestro \`flow\``
          );
        if (step.op === "tap") await exec("idb", ["ui", "tap", "--udid", this.id, String(step.x), String(step.y)]);
        else if (step.op === "swipe")
          await exec("idb", [
            "ui", "swipe", "--udid", this.id,
            String(step.x1), String(step.y1), String(step.x2), String(step.y2),
            "--duration", String((step.ms ?? 300) / 1000),
          ]);
        else if (step.op === "text") await exec("idb", ["ui", "text", "--udid", this.id, step.text]);
      }
    }
  }

  async prepare(opts: { cleanStatusBar: boolean; appearance?: "light" | "dark" }) {
    const undo: Array<() => Promise<unknown>> = [];
    if (opts.cleanStatusBar) {
      await exec("xcrun", [
        "simctl", "status_bar", this.id, "override",
        "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3",
        "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "charged", "--batteryLevel", "100",
      ]);
      undo.push(() => exec("xcrun", ["simctl", "status_bar", this.id, "clear"]));
    }
    if (opts.appearance) {
      const before = (await exec("xcrun", ["simctl", "ui", this.id, "appearance"]).catch(() => "")).trim();
      await exec("xcrun", ["simctl", "ui", this.id, "appearance", opts.appearance]);
      if (/^(light|dark)$/.test(before)) undo.push(() => exec("xcrun", ["simctl", "ui", this.id, "appearance", before]));
    }
    return async () => {
      for (const u of undo.reverse()) await u().catch((e) => log(`restore failed: ${(e as Error).message}`));
    };
  }

  async release() {
    if (!this.bootedByUs) return;
    log(`shutting down simulator ${this.name} (booted by this run)`);
    await exec("xcrun", ["simctl", "shutdown", this.id], { timeoutMs: 60000 }).catch((e) =>
      log(`simctl shutdown failed: ${(e as Error).message}`)
    );
  }
}

async function openIos(id: string | undefined, boot: boolean): Promise<Device> {
  const devices = parseSimctlDevices(await exec("xcrun", ["simctl", "list", "devices", "-j"], { timeoutMs: 30000 }));
  const sim = pickSimulator(devices, id);
  let bootedByUs = false;
  if (sim.state !== "Booted") {
    if (!boot) throw new Error(`simulator ${sim.name} (${sim.udid}) is ${sim.state} — boot it, or pass --boot`);
    log(`booting simulator ${sim.name} (${sim.udid})`);
    await exec("xcrun", ["simctl", "boot", sim.udid], { timeoutMs: 120000 });
    await exec("xcrun", ["simctl", "bootstatus", sim.udid, "-b"], { timeoutMs: 300000 });
    bootedByUs = true;
  }
  return new IosSimulator(sim.udid, sim.name, bootedByUs);
}

// ---------------------------------------------------------------------------
// Android emulator
// ---------------------------------------------------------------------------

/** adb / emulator from PATH, else $ANDROID_HOME / $ANDROID_SDK_ROOT / the default SDK dirs. */
export function androidTool(tool: "adb" | "emulator"): string {
  const sub = tool === "adb" ? "platform-tools" : "emulator";
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library", "Android", "sdk"),
    join(homedir(), "Android", "Sdk"),
  ].filter((x): x is string => !!x);
  for (const r of roots) {
    const p = join(r, sub, tool);
    if (existsSync(p)) return p;
  }
  return tool;
}

/** Parse `adb devices` → serials in state "device". */
export function parseAdbDevices(out: string): string[] {
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === "device")
    .map((p) => p[0]);
}

/** Parse `adb shell wm size` (an override wins over the physical size). */
export function parseWmSize(out: string): { width: number; height: number } {
  const o = /Override size:\s*(\d+)x(\d+)/.exec(out) ?? /Physical size:\s*(\d+)x(\d+)/.exec(out);
  if (!o) throw new Error(`cannot parse wm size: ${out.trim()}`);
  return { width: Number(o[1]), height: Number(o[2]) };
}

/** `input text` treats spaces as separators and some characters as shell syntax. */
export function adbInputText(text: string): string {
  return text.replace(/([\\"'`$&|;<>()*~!?#[\]{}])/g, "\\$1").replace(/ /g, "%s");
}

class AndroidEmulator implements Device {
  readonly platform = "android" as const;
  constructor(
    readonly id: string,
    readonly name: string,
    readonly bootedByUs: boolean
  ) {}
  private adb(args: string[], timeoutMs = 60000) {
    return exec(androidTool("adb"), ["-s", this.id, ...args], { timeoutMs });
  }

  async screenSize() {
    return parseWmSize(await this.adb(["shell", "wm", "size"]));
  }

  async startRecording(file: string): Promise<Recording> {
    const remote = `/sdcard/aidemo-${Date.now()}.mp4`;
    // screenrecord has no "started" signal; it begins encoding within a few
    // hundred ms of launch. Store scenes are short (< 180 s, its own cap).
    const proc = spawn(
      androidTool("adb"),
      ["-s", this.id, "shell", "screenrecord", "--bit-rate", "16000000", "--time-limit", "180", remote],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let early = "";
    proc.stderr!.on("data", (d) => (early += d.toString()));
    await sleep(700);
    if (proc.exitCode != null) throw new Error(`adb screenrecord exited early: ${early.trim()}`);
    const startedAtMs = Date.now() - 300;
    return {
      startedAtMs,
      stop: async () => {
        await this.adb(["shell", "pkill", "-INT", "screenrecord"]).catch(() => {});
        await stopProcess(proc, null, 20000);
        await sleep(500); // the moov atom is written after SIGINT
        await this.adb(["pull", remote, file], 120000);
        await this.adb(["shell", "rm", "-f", remote]).catch(() => {});
        return file;
      },
    };
  }

  async screenshot(file: string) {
    const png = await execBuffer(androidTool("adb"), ["-s", this.id, "exec-out", "screencap", "-p"], { timeoutMs: 30000 });
    await fs.writeFile(file, png);
  }

  async runStep(step: NativeStep) {
    switch (step.op) {
      case "wait":
        return sleep(step.ms);
      case "tap":
        await this.adb(["shell", "input", "tap", String(Math.round(step.x)), String(Math.round(step.y))]);
        return;
      case "swipe":
        await this.adb([
          "shell", "input", "swipe",
          ...[step.x1, step.y1, step.x2, step.y2].map((n) => String(Math.round(n))),
          String(step.ms ?? 300),
        ]);
        return;
      case "text":
        await this.adb(["shell", "input", "text", adbInputText(step.text)]);
        return;
      case "openUrl":
        await this.adb(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", step.url]);
        return;
      case "launch":
        if (step.relaunch) await this.adb(["shell", "am", "force-stop", step.appId]).catch(() => {});
        await this.adb(["shell", "monkey", "-p", step.appId, "-c", "android.intent.category.LAUNCHER", "1"]);
        return;
      case "terminate":
        await this.adb(["shell", "am", "force-stop", step.appId]).catch(() => {});
        return;
    }
  }

  async prepare(opts: { cleanStatusBar: boolean; appearance?: "light" | "dark" }) {
    const undo: Array<() => Promise<unknown>> = [];
    if (opts.cleanStatusBar) {
      const demo = (cmd: string, extra: string[] = []) =>
        this.adb(["shell", "am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command", cmd, ...extra]);
      await this.adb(["shell", "settings", "put", "global", "sysui_demo_allowed", "1"]);
      await demo("enter");
      await demo("clock", ["-e", "hhmm", "0941"]);
      await demo("battery", ["-e", "level", "100", "-e", "plugged", "false"]);
      await demo("network", ["-e", "wifi", "show", "-e", "level", "4"]);
      await demo("network", ["-e", "mobile", "show", "-e", "datatype", "none", "-e", "level", "4"]);
      await demo("notifications", ["-e", "visible", "false"]);
      undo.push(() => demo("exit"));
    }
    if (opts.appearance) {
      const before = await this.adb(["shell", "cmd", "uimode", "night"]).catch(() => "");
      await this.adb(["shell", "cmd", "uimode", "night", opts.appearance === "dark" ? "yes" : "no"]);
      const m = /Night mode:\s*(yes|no|auto)/i.exec(before);
      if (m) undo.push(() => this.adb(["shell", "cmd", "uimode", "night", m[1].toLowerCase()]));
    }
    return async () => {
      for (const u of undo.reverse()) await u().catch((e) => log(`restore failed: ${(e as Error).message}`));
    };
  }

  async release() {
    if (!this.bootedByUs) return;
    log(`shutting down emulator ${this.name} (booted by this run)`);
    await this.adb(["emu", "kill"]).catch((e) => log(`adb emu kill failed: ${(e as Error).message}`));
  }
}

async function avdName(serial: string): Promise<string> {
  const out = await exec(androidTool("adb"), ["-s", serial, "emu", "avd", "name"], { timeoutMs: 15000 }).catch(() => "");
  return out.split("\n")[0].trim() || serial;
}

async function openAndroid(id: string | undefined, boot: boolean): Promise<Device> {
  const adb = androidTool("adb");
  const serials = parseAdbDevices(await exec(adb, ["devices"], { timeoutMs: 30000 }));
  const named = await Promise.all(serials.map(async (s) => ({ serial: s, avd: await avdName(s) })));
  if (id) {
    const hit = named.find((d) => d.serial === id || d.avd === id);
    if (hit) return new AndroidEmulator(hit.serial, hit.avd, false);
    if (!boot) throw new Error(`Android device "${id}" is not running — start it, or pass --boot (AVD name)`);
    return bootAvd(id);
  }
  if (named.length === 1) return new AndroidEmulator(named[0].serial, named[0].avd, false);
  if (!named.length) throw new Error("no running Android emulator/device — start one, or set device.id to an AVD and pass --boot");
  throw new Error(
    `${named.length} Android devices — set device.id to one of: ${named.map((d) => `${d.avd} (${d.serial})`).join(", ")}`
  );
}

async function bootAvd(avd: string): Promise<Device> {
  const adb = androidTool("adb");
  const before = new Set(parseAdbDevices(await exec(adb, ["devices"])));
  log(`booting Android emulator ${avd} (headless)`);
  const proc = spawn(
    androidTool("emulator"),
    ["-avd", avd, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save", "-gpu", "swiftshader_indirect"],
    { stdio: "ignore", detached: true }
  );
  proc.unref();
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const now = parseAdbDevices(await exec(adb, ["devices"]).catch(() => ""));
    const fresh = now.find((s) => !before.has(s));
    if (!fresh) continue;
    const done = await exec(adb, ["-s", fresh, "shell", "getprop", "sys.boot_completed"]).catch(() => "");
    if (done.trim() === "1") {
      await sleep(3000); // launcher settle
      return new AndroidEmulator(fresh, avd, true);
    }
  }
  throw new Error(`emulator ${avd} did not finish booting in 5 min`);
}

// ---------------------------------------------------------------------------

export async function openDevice(platform: Platform, id: string | undefined, opts: { boot?: boolean } = {}): Promise<Device> {
  return platform === "ios" ? openIos(id, !!opts.boot) : openAndroid(id, !!opts.boot);
}

/** Resolves the epoch ms at which a stderr/stdout line matched `re`. */
function waitForLine(proc: ChildProcess, re: RegExp, timeoutMs: number, what: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      proc.kill("SIGINT");
      reject(new Error(`${what}: no "${re.source}" within ${timeoutMs} ms\n${buf.trim()}`));
    }, timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (re.test(buf)) {
        clearTimeout(timer);
        resolve(Date.now());
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${what} exited ${code} before starting\n${buf.trim()}`));
    });
  });
}

function stopProcess(proc: ChildProcess, signal: NodeJS.Signals | null, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode != null || proc.signalCode != null) return resolve();
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    if (signal) proc.kill(signal);
  });
}
