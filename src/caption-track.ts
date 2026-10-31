import { promises as fs } from "node:fs";
import type { Project } from "./project.js";
import { toSrt, toVtt, type Cue } from "./captions.js";
import { exists, readJson } from "./util.js";

/**
 * Captions timed to the FINAL video (issue #89).
 *
 * generated/captions.* are narration-relative: t=0 is the start of the
 * narration track. The final MP4 opens on the intro card, and compose delays
 * the narration (adelay) and the burned cues by the card's length — so those
 * files run early by exactly that much against final-demo.mp4. Compose writes
 * re-timed copies beside the video (what players and hosts pick up by file
 * name) and, with `captions.track`, muxes them as an off-by-default subtitle
 * track. The walkthrough bundle ships the same re-timed cues.
 */

/** Cues re-timed onto the final video: the intro card delays every cue by `introMs`. */
export function shiftCues(cues: Cue[], introMs: number): Cue[] {
  if (!introMs) return cues;
  return cues.map((c) => ({ ...c, startMs: c.startMs + introMs, endMs: c.endMs + introMs }));
}

/**
 * This project's caption cues (language-scoped), re-timed onto the final
 * video. null when the captions stage has produced none.
 */
export async function finalVideoCues(project: Project, introMs: number): Promise<Cue[] | null> {
  if (!(await exists(project.captionsCuesPath))) return null;
  const cues = (await readJson<Cue[]>(project.captionsCuesPath)) ?? [];
  return cues.length ? shiftCues(cues, introMs) : null;
}

/**
 * Write output/final-demo[.<lang>].srt/.vtt for these cues, or — when there
 * are none — remove sidecars an earlier compose left, so a stale file never
 * sits beside a video it doesn't match.
 */
export async function writeCaptionSidecars(
  project: Project,
  cues: Cue[] | null
): Promise<{ srt: string; vtt: string } | null> {
  if (!cues?.length) {
    await Promise.all(
      [project.outputSrtPath, project.outputVttPath].map((p) => fs.rm(p, { force: true }))
    );
    return null;
  }
  await fs.writeFile(project.outputSrtPath, toSrt(cues));
  await fs.writeFile(project.outputVttPath, toVtt(cues));
  return { srt: project.outputSrtPath, vtt: project.outputVttPath };
}

/** ISO 639-1 → ISO 639-2/T, the three-letter code an MP4 track's language carries. */
const ISO639_2T: Record<string, string> = {
  af: "afr", ar: "ara", bg: "bul", bn: "ben", ca: "cat", cs: "ces", cy: "cym",
  da: "dan", de: "deu", el: "ell", en: "eng", es: "spa", et: "est", eu: "eus",
  fa: "fas", fi: "fin", fr: "fra", ga: "gle", gl: "glg", he: "heb", hi: "hin",
  hr: "hrv", hu: "hun", hy: "hye", id: "ind", is: "isl", it: "ita", ja: "jpn",
  ka: "kat", kk: "kaz", ko: "kor", lt: "lit", lv: "lav", mk: "mkd", ms: "msa",
  mt: "mlt", nb: "nob", nl: "nld", nn: "nno", no: "nor", pl: "pol", pt: "por",
  ro: "ron", ru: "rus", sk: "slk", sl: "slv", sq: "sqi", sr: "srp", sv: "swe",
  sw: "swa", ta: "tam", te: "tel", th: "tha", tl: "tgl", tr: "tur", uk: "ukr",
  ur: "urd", vi: "vie", zh: "zho",
};

/**
 * MP4 language code for a BCP-47 tag ("en", "en-GB", "pt-BR"): its ISO
 * 639-2/T code. A tag that already leads with a three-letter code ("fil",
 * "yue") passes through; anything unknown is "und" (undetermined).
 */
export function mp4Language(tag: string | undefined): string {
  const primary = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0];
  if (/^[a-z]{3}$/.test(primary)) return primary;
  return ISO639_2T[primary] ?? "und";
}

/**
 * `srclang` + human label for an HTML `<track>` of captions in `tag` (a BCP-47
 * code: "en", "en-GB", "de"), e.g. { srclang: "en-GB", label: "British English" }.
 */
export function htmlTrackLanguage(tag: string | undefined): { srclang: string; label: string } {
  const srclang = tag?.trim() || "en";
  let label = srclang;
  try {
    label = new Intl.DisplayNames(["en"], { type: "language" }).of(srclang) ?? srclang;
  } catch {
    // not a valid BCP-47 tag — keep the raw code as the label
  }
  return { srclang, label };
}

/** Track handler types that carry subtitles/captions in ISO-BMFF / QuickTime. */
const SUBTITLE_HANDLERS = new Set(["sbtl", "text", "subt"]);

interface Box {
  type: string;
  start: number;
  size: number;
  header: number;
}

/** The boxes laid end to end in buf[from, to); stops at the first malformed one. */
function* boxes(buf: Buffer, from: number, to: number): Generator<Box> {
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > to) return;
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < header || p + size > to) return;
    yield { type, start: p, size, header };
    p += size;
  }
}

const child = (buf: Buffer, parent: Box, type: string): Box | undefined => {
  for (const b of boxes(buf, parent.start + parent.header, parent.start + parent.size)) {
    if (b.type === type) return b;
  }
  return undefined;
};

/**
 * Clear `track_enabled` in every subtitle track's `tkhd`, in place — one byte
 * per track, nothing moves, so the faststart layout survives. ffmpeg's mov
 * muxer enables the first track of each media type whatever `-disposition`
 * says, and players show an enabled subtitle track from the start; with the
 * flag cleared the track is listed but off until the viewer picks it.
 * `tracks` = subtitle tracks found, `changed` = flags actually cleared.
 */
export async function disableSubtitleTracks(
  file: string
): Promise<{ tracks: number; changed: number }> {
  const fh = await fs.open(file, "r+");
  try {
    const { size: fileSize } = await fh.stat();
    // Top-level boxes by header only (mdat is most of the file): find moov.
    const head = Buffer.alloc(16);
    let pos = 0;
    let moov: { start: number; size: number } | null = null;
    while (pos + 8 <= fileSize) {
      const { bytesRead } = await fh.read(head, 0, 16, pos);
      if (bytesRead < 8) break;
      let size = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (size === 1) size = bytesRead >= 16 ? Number(head.readBigUInt64BE(8)) : 0;
      else if (size === 0) size = fileSize - pos;
      if (size < 8) break;
      if (type === "moov") {
        moov = { start: pos, size };
        break;
      }
      pos += size;
    }
    if (!moov) return { tracks: 0, changed: 0 };
    const buf = Buffer.alloc(moov.size);
    await fh.read(buf, 0, moov.size, moov.start);
    const moovBox = boxes(buf, 0, buf.length).next().value;
    if (!moovBox) return { tracks: 0, changed: 0 };
    let tracks = 0;
    let changed = 0;
    for (const trak of boxes(buf, moovBox.header, moovBox.size)) {
      if (trak.type !== "trak") continue;
      const tkhd = child(buf, trak, "tkhd");
      const mdia = child(buf, trak, "mdia");
      const hdlr = mdia && child(buf, mdia, "hdlr");
      if (!tkhd || !hdlr) continue;
      // hdlr payload: version(1) flags(3) pre_defined(4) handler_type(4)
      const at = hdlr.start + hdlr.header + 8;
      if (!SUBTITLE_HANDLERS.has(buf.toString("latin1", at, at + 4))) continue;
      tracks++;
      // tkhd payload: version(1) flags(3); track_enabled = bit 0 of the low byte.
      const flags = tkhd.start + tkhd.header + 3;
      if (buf[flags] & 0x01) {
        buf[flags] &= ~0x01;
        await fh.write(buf, flags, 1, moov.start + flags);
        changed++;
      }
    }
    return { tracks, changed };
  } finally {
    await fh.close();
  }
}
