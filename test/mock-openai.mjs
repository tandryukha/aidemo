#!/usr/bin/env node
/**
 * Offline mock of the two OpenAI endpoints aidemo calls, so the full pipeline
 * (voice → record → captions → compose) can be e2e-verified with zero network
 * access and zero API spend. Dependency-free: node:http + the ffmpeg/ffprobe
 * binaries the engine already requires on PATH.
 *
 *   POST /v1/audio/speech          → synthetic mp3, ~0.35 s per input word
 *   POST /v1/audio/transcriptions  → verbose_json with deterministic word
 *                                    timestamps evenly spanning the real
 *                                    (ffprobe'd) duration of the uploaded audio
 *   GET  /health                   → 200 ok
 *
 * Usage:
 *   node test/mock-openai.mjs                # listens on PORT (default 8790)
 *   OPENAI_BASE_URL=http://127.0.0.1:8790/v1 OPENAI_API_KEY=mock \
 *     node bin/aidemo.mjs render examples/local-demo --headless
 *
 * The key is a dummy — the engine checks it's set (src/config.ts) but this
 * server never reads it. Every request is logged to stdout (method, path,
 * model), which doubles as proof of which endpoints a run actually hit.
 */
import http from "node:http";
import { execFile } from "node:child_process";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 8790);
const TMP = mkdtempSync(join(tmpdir(), "aidemo-mock-openai-"));
let seq = 0;

const logLine = (method, path, model) =>
  console.log(`[mock-openai] ${method} ${path}${model ? ` model=${model}` : ""}`);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/* ------------------------------- speech -------------------------------- */

/** Deterministic per-text tone so adjacent scenes are audibly distinct. */
function toneFor(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 997;
  return 280 + (h % 240); // Hz
}

/** Synthesize a quiet sine-tone mp3 whose length scales with the text. */
async function handleSpeech(body, res) {
  const { model, input = "" } = JSON.parse(body.toString("utf8"));
  logLine("POST", "/v1/audio/speech", model);
  const words = input.trim().split(/\s+/).filter(Boolean).length;
  const duration = Math.max(1.2, words * 0.35).toFixed(2);
  const out = join(TMP, `speech-${seq++}.mp3`);
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", `sine=frequency=${toneFor(input)}:sample_rate=24000:duration=${duration}`,
    "-af", "volume=0.08",
    "-c:a", "libmp3lame",
    "-q:a", "7",
    out,
  ]);
  const mp3 = await fs.readFile(out);
  await fs.unlink(out).catch(() => {});
  res.writeHead(200, { "content-type": "audio/mpeg", "content-length": mp3.length });
  res.end(mp3);
}

/* ---------------------------- transcriptions ---------------------------- */

/** Minimal multipart/form-data parser: [{ name, filename?, data }]. */
function parseMultipart(body, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    const next = body.indexOf(delim, pos + delim.length);
    if (next === -1) break; // pos was the closing --boundary--
    const chunk = body.subarray(pos + delim.length + 2, next - 2); // strip CRLFs
    const headerEnd = chunk.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headers = chunk.subarray(0, headerEnd).toString("utf8");
      parts.push({
        name: /name="([^"]*)"/.exec(headers)?.[1] ?? "",
        filename: /filename="([^"]*)"/.exec(headers)?.[1],
        data: chunk.subarray(headerEnd + 4),
      });
    }
    pos = next;
  }
  return parts;
}

/**
 * ffprobe the uploaded audio and answer the Whisper verbose_json shape
 * src/captions.ts consumes: { task, text, words: [{ word, start, end }] }.
 * Placeholder words tile the real duration at the same ~0.35 s/word cadence
 * the speech endpoint generates, with a numbered period every 6th word so
 * cue grouping exercises its sentence-break path.
 */
async function handleTranscription(req, body, res) {
  const boundary = /boundary=([^;]+)/.exec(req.headers["content-type"] ?? "")?.[1];
  if (!boundary) throw new Error("multipart boundary missing");
  const parts = parseMultipart(body, boundary.replace(/^"|"$/g, "").trim());
  const model = parts.find((p) => p.name === "model")?.data.toString("utf8").trim();
  logLine("POST", "/v1/audio/transcriptions", model);

  const file = parts.find((p) => p.name === "file") ?? parts.find((p) => p.filename);
  if (!file) throw new Error("no file part in multipart body");
  const path = join(TMP, `upload-${seq++}`);
  await fs.writeFile(path, file.data);
  const probed = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  await fs.unlink(path).catch(() => {});
  const duration = Number.parseFloat(probed) || 1.2;

  const TOKENS = ["aidemo", "offline", "mock", "narration", "word"];
  const n = Math.max(1, Math.round(duration / 0.35));
  const words = Array.from({ length: n }, (_, i) => ({
    word: i % 6 === 5 ? `${Math.floor(i / 6) + 1}.` : TOKENS[i % 6],
    start: Number(((i * duration) / n).toFixed(3)),
    end: Number((((i + 1) * duration) / n).toFixed(3)),
  }));
  const json = JSON.stringify({
    task: "transcribe",
    language: "english",
    duration,
    text: words.map((w) => w.word).join(" "),
    words,
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(json);
}

/* -------------------------------- server -------------------------------- */

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
  try {
    if (req.method === "GET" && path === "/health") {
      logLine("GET", "/health");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    } else if (req.method === "POST" && path === "/v1/audio/speech") {
      await handleSpeech(await readBody(req), res);
    } else if (req.method === "POST" && path === "/v1/audio/transcriptions") {
      await handleTranscription(req, await readBody(req), res);
    } else {
      logLine(req.method ?? "?", path);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no mock for ${req.method} ${path}` } }));
    }
  } catch (err) {
    console.error(`[mock-openai] error on ${req.method} ${path}:`, err.message ?? err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(err.message ?? err) } }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-openai] listening on http://127.0.0.1:${PORT} (base URL: /v1)`);
});
