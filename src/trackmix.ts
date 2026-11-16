// Per-song data the web player needs to blend songs like the radio mixer does (see mixer.ts), computed once and cached:
//   start / end : where the music really starts and ends (YouTube files carry ~1 s of silence in front and 3-7 s behind;
//                 crossfading by file length starts inside that silence and the next song comes in late)
//   gainDb      : how far to turn the song DOWN to sit near a common level (<= 0; quiet songs are left alone, never boosted)
// Analysis downloads the song once with yt-dlp (~4 MB, same format the stream proxy serves), runs one ffmpeg pass
// (silencedetect + loudnorm measurement), stores the numbers and deletes the file. One analysis at a time: the server is weak.
// Personal testing only, like the rest of the YouTube path.
import { mkdirSync, rmSync } from "node:fs";
import { db } from "./db.ts";
import { bin, duration, fetchSong, parseBounds, runBoth } from "./mixer.ts";

db.run(`CREATE TABLE IF NOT EXISTS track_mix (
  track_id INTEGER PRIMARY KEY,
  music_start REAL NOT NULL,
  music_end REAL NOT NULL,
  duration REAL NOT NULL,
  gain_db REAL NOT NULL,
  analyzed_at INTEGER NOT NULL
)`);

export type MixInfo = { start: number; end: number; duration: number; gainDb: number };

const TARGET_LUFS = -18;
const dir = `${import.meta.dir}/../out/web-songs`;

export function cachedMix(trackId: number): MixInfo | null {
  const r = db.query("SELECT music_start s, music_end e, duration d, gain_db g FROM track_mix WHERE track_id = ?").get(trackId) as
    { s: number; e: number; d: number; g: number } | null;
  return r ? { start: r.s, end: r.e, duration: r.d, gainDb: r.g } : null;
}

const state = new Map<number, "queued" | "failed">();
const queue: { id: number; videoId: string }[] = [];
let running = false;

/** Make sure an analysis is queued. Returns "ready" | "pending" | "failed". Never blocks. */
export function ensureMix(trackId: number, videoId: string): "ready" | "pending" | "failed" {
  if (cachedMix(trackId)) return "ready";
  const s = state.get(trackId);
  if (s === "failed") return "failed";
  if (s !== "queued") { state.set(trackId, "queued"); queue.push({ id: trackId, videoId }); void work(); }
  return "pending";
}

async function work() {
  if (running) return;
  running = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        // YouTube sometimes answers 403 for a moment (e.g. while the stream proxy resolves the same video): retry once
        try { await analyze(job.id, job.videoId); } catch { await Bun.sleep(4000); await analyze(job.id, job.videoId); }
        state.delete(job.id);
      }
      catch (e) { state.set(job.id, "failed"); console.warn(`mix analysis ${job.id}:`, (e as Error).message); }
    }
  } finally { running = false; }
}

async function analyze(id: number, videoId: string) {
  mkdirSync(dir, { recursive: true });
  const file = await fetchSong(id, videoId, dir);
  try {
    const total = await duration(file);
    const { err } = await runBoth([bin("ffmpeg"), "-hide_banner", "-nostats", "-i", file, "-af",
      `silencedetect=noise=-42dB:d=0.3,loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"]);
    const b = parseBounds(err, total);
    const m = err.match(/"input_i"\s*:\s*"(-?[\d.]+)"/);
    const gainDb = m ? Math.max(-12, Math.min(0, TARGET_LUFS - Number(m[1]))) : 0;
    db.run("INSERT OR REPLACE INTO track_mix VALUES (?, ?, ?, ?, ?, ?)", [id, b.start, b.end, total, gainDb, Math.floor(Date.now() / 1000)]);
  } finally { rmSync(file, { force: true }); }
}
