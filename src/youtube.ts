// Resolve a catalog track (Deezer id) to a playable YouTube audio stream, using youtubei.js (pure JS, no Python/yt-dlp).
// Prototype-only: this goes against YouTube's terms of service, so keep it to personal testing.
import { Innertube, UniversalCache, Log } from "youtubei.js";
import { db } from "./db.ts";

Log.setLevel(Log.Level.NONE); // the library logs every parser hiccup; they are harmless for what we use

db.run(`
CREATE TABLE IF NOT EXISTS yt_matches (
  track_id INTEGER PRIMARY KEY,
  video_id TEXT,                   -- NULL = searched, nothing acceptable found (negative cache)
  video_duration INTEGER,
  video_title TEXT,
  checked_at INTEGER NOT NULL
);
`);

let client: Promise<Innertube> | null = null;
const getClient = () => (client ??= Innertube.create({ cache: new UniversalCache(false), generate_session_locally: true })
  .catch((e) => { client = null; throw e; }));

// at most 3 YouTube lookups at once; the server is weak and YouTube rate-limits bursts
let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 3) await new Promise<void>((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
const mainTitle = (s: string) => norm(s.replace(/[\(\[][^\)\]]*[\)\]]/g, " ").replace(/\s+-\s+.*$/, ""));
// uploads that are not the studio recording
const WRONG = /\b(live|cover|remix|karaoke|instrumental|slowed|sped up|nightcore|8d|reverb|reaction|tutorial|piano version|acoustic version|lesson|concert|konser)\b/i;

export type Match = { videoId: string; durationS: number; title: string };
type TrackRef = { id: number; artist: string; title: string; durationMs: number };

function pick(t: TrackRef, results: any[]): Match | null {
  const want = t.durationMs / 1000;
  const wantTitle = mainTitle(t.title);
  let best: { m: Match; score: number } | null = null;
  for (const v of results) {
    const title: string = v.title?.text ?? "";
    const dur: number = v.duration?.seconds ?? 0;
    if (!v.video_id || !dur || WRONG.test(title)) continue;
    if (!norm(title).includes(wantTitle)) continue;            // must actually be this song
    const diff = Math.abs(dur - want);
    if (diff > 12) continue;                                   // different edit / live / mashup
    let score = diff;
    const author: string = v.author?.name ?? "";
    if (/official audio/i.test(title) || /- topic$/i.test(author)) score -= 4; // clean audio, no video intro
    if (/official (music )?video|video clip|\bmv\b/i.test(title)) score += 2;
    if (!best || score < best.score) best = { m: { videoId: v.video_id, durationS: dur, title }, score };
  }
  return best?.m ?? null;
}

/** Cached lookup. Throws on network/YouTube failure (nothing cached), returns null for "no acceptable video". */
export async function matchTrack(t: TrackRef): Promise<Match | null> {
  const row = db.query("SELECT video_id, video_duration, video_title FROM yt_matches WHERE track_id = ?").get(t.id) as
    { video_id: string | null; video_duration: number; video_title: string } | null;
  if (row) return row.video_id ? { videoId: row.video_id, durationS: row.video_duration, title: row.video_title } : null;

  const yt = await getClient();
  const query = `${t.artist} ${t.title.replace(/[\(\[][^\)\]]*[\)\]]/g, " ")}`.trim();
  const res: any = await limited(() => yt.search(query, { type: "video" }));
  const vids = (res.results ?? []).filter((r: any) => r.type === "Video").slice(0, 8);
  const m = pick(t, vids);
  db.run("INSERT OR REPLACE INTO yt_matches VALUES (?, ?, ?, ?, ?)",
    [t.id, m?.videoId ?? null, m?.durationS ?? null, m?.title ?? null, Math.floor(Date.now() / 1000)]);
  return m;
}

// Resolved stream URLs live in memory AND in SQLite (table yt_urls), so a server restart does not throw away work that took
// 6-10 s per song on this weak machine. A URL is valid for hours and tied to the server's IP, which does not change.
db.run(`CREATE TABLE IF NOT EXISTS yt_urls (video_id TEXT PRIMARY KEY, url TEXT NOT NULL, exp INTEGER NOT NULL)`);
const urls = new Map<string, { url: string; exp: number }>();
const resolving = new Map<string, Promise<string>>(); // one yt-dlp per video, however many requests ask for it at once
export const forgetUrl = (videoId: string) => { urls.delete(videoId); db.run("DELETE FROM yt_urls WHERE video_id = ?", [videoId]); };

// yt-dlp is heavy (seconds of CPU each): at most 2 at a time on a 2-core server (the lookups above are lighter, own limit)
let ytActive = 0;
const ytWaiting: (() => void)[] = [];
async function ytLimited<T>(fn: () => Promise<T>): Promise<T> {
  if (ytActive >= 2) await new Promise<void>((r) => ytWaiting.push(r));
  ytActive++;
  try { return await fn(); } finally { ytActive--; ytWaiting.shift()?.(); }
}

// yt-dlp does the stream resolution: youtubei.js's IOS client only yields URLs that stop working after ~1 MB (~64 s),
// while yt-dlp picks clients that give full-length audio. Location: YTDLP env, else the project venv (.venv).
const YTDLP = process.env.YTDLP ?? `${import.meta.dir}/../.venv/${process.platform === "win32" ? "Scripts/yt-dlp.exe" : "bin/yt-dlp"}`;

/** Direct audio URL for a video, valid for hours and tied to this machine's IP. */
export function streamUrl(videoId: string): Promise<string> {
  const nowS = Date.now() / 1000;
  const hit = urls.get(videoId);
  if (hit && hit.exp > nowS) return Promise.resolve(hit.url);
  const row = db.query("SELECT url, exp FROM yt_urls WHERE video_id = ?").get(videoId) as { url: string; exp: number } | null;
  if (row && row.exp > nowS) { urls.set(videoId, row); return Promise.resolve(row.url); }
  let p = resolving.get(videoId);
  if (!p) { p = resolveUrl(videoId).finally(() => resolving.delete(videoId)); resolving.set(videoId, p); }
  return p;
}

async function resolveUrl(videoId: string): Promise<string> {
  const url = await ytLimited(async () => {
    const p = Bun.spawn([YTDLP, "--no-warnings", "--no-playlist", "-f", "bestaudio[ext=m4a]/bestaudio", "-g", `https://www.youtube.com/watch?v=${videoId}`], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 30_000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    clearTimeout(timer);
    await p.exited;
    const line = out.trim().split(/\r?\n/)[0] ?? "";
    if (!line.startsWith("http")) throw new Error(`yt-dlp: ${err.trim().split(/\r?\n/).pop()?.slice(0, 160) || "no URL"}`);
    return line;
  });
  const exp = Number(new URL(url).searchParams.get("expire")) || Date.now() / 1000 + 3 * 3600;
  urls.set(videoId, { url, exp: exp - 300 });
  db.run("INSERT OR REPLACE INTO yt_urls VALUES (?, ?, ?)", [videoId, url, Math.floor(exp - 300)]);
  return url;
}
